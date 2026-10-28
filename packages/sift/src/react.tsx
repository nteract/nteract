/**
 * React wrapper for the Sift table engine.
 *
 * Usage:
 *   <SiftTable data={tableData} onChange={handleState} />
 *
 * Or with a URL (auto-detects Arrow IPC vs Parquet):
 *   <SiftTable url="/data.arrow" onChange={handleState} />
 *   <SiftTable url="/data.parquet" onChange={handleState} />
 *
 * Or with a normalized source:
 *   <SiftTable source={{ kind: "arrow-stream-manifest", manifest }} onChange={handleState} />
 *
 * The component manages the imperative TableEngine lifecycle —
 * mounting on first render, updating on data changes, and
 * cleaning up on unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  applyColumnOverrides,
  applyParquetColumnHints,
  pandasIndexColumnsFromHints,
} from "./parquet-features";
import {
  loadTableFile,
  resolveTableFileLimits,
  type TableFileLimits,
  type TableLimitOverflow,
} from "./file-data";
import { columnFiltersToPredicates, type FilterPredicate } from "./filter-schema";
import {
  type ByteSource,
  byteSourceFromBytes,
  type OpenParquetFile,
  openParquetFile,
  type ParquetFileLimits,
} from "./parquet-file";
import { ensureModule, getModuleSync, loadIpc } from "./predicate";
import {
  type Count,
  type QuerySupport,
  supportsQuery,
  type TableQuery,
  type TableQuerySession,
} from "./query";
import {
  type Column,
  type ColumnFilter,
  type ColumnType,
  createTable,
  type InternalTableEngineOptions,
  type ReplaceDataOptions,
  type TableData,
  type TableEngine,
  type TableEngineState,
} from "./table";
import { createWasmTableData } from "./wasm-table-data";
import { tableResponse } from "./table-response";
import { updateWasmSummaries } from "./wasm-summaries";
import type { WindowedTableData } from "./windowed";
import { createResidentWindowedData, type ResidentWindowedData } from "./windowed-resident";
import { createWorkerWindowedData, type WorkerWindowedData } from "./worker/client";
import { getWorkerFactory } from "./worker/factory";

// --- Props ---

export type ArrowStreamManifestChunk = {
  url: string;
  row_count?: number;
};

export type ArrowStreamSummary = {
  total_rows?: number;
  included_rows?: number;
  sampled?: boolean;
  sample_strategy?: string;
};

export type ArrowStreamManifest = {
  chunks: ArrowStreamManifestChunk[];
  complete?: boolean;
  summary?: ArrowStreamSummary;
};

export type SiftSource =
  | { kind: "table-data"; data: TableData }
  /** Memoize the loader; each call must return a fresh, independently disposable table. */
  | { kind: "loader"; load: () => Promise<TableData> }
  /**
   * A hosted Arrow IPC or Parquet file; the format is detected from the
   * response. Parquet streams row groups like `byte-source`, with `limits` and
   * `overflow` defaulting to `URL_PARQUET_LIMITS` and `"truncate"`: a large file
   * shows its leading rows and notes the preview in the footer. Arrow IPC is
   * read whole and ignores both.
   */
  | {
      kind: "url";
      url: string;
      limits?: TableFileLimits;
      overflow?: TableLimitOverflow;
      autoLoad?: SiftAutoLoad;
      /** Experimental: see the `byte-source` option. Parquet only. */
      windowed?: boolean;
    }
  | { kind: "arrow-stream-manifest"; manifest: ArrowStreamManifest }
  /**
   * A Parquet file read by byte range. Sift reads the footer, mounts after
   * the first row group, and streams the rest. Memoize `source`; a new object
   * identity reloads. `limits` bounds rows, columns and decoded memory; the
   * file length itself is not capped.
   */
  | {
      kind: "byte-source";
      source: ByteSource;
      limits?: TableFileLimits;
      /**
       * What to do when the rows or decoded-bytes budget runs out. Default
       * `"error"`. With `"truncate"`, Sift shows the leading rows that fit
       * and notes the preview in its footer.
       */
      overflow?: TableLimitOverflow;
      /** Pause below the hard budget and let the user load more. Needs `overflow: "truncate"`. */
      autoLoad?: SiftAutoLoad;
      /**
       * Experimental: run the engine over a `WindowedTableData` adapter so cells
       * and the permutation arrive asynchronously. Off by default; a seam for
       * the worker-backed data side.
       */
      windowed?: boolean;
      /**
       * Experimental: decode and hold the file in the Sift data worker. Needs
       * `setWorkerFactory`; without one the source fails at validation, it
       * never falls back to the main thread. Implies `windowed`. `autoLoad`
       * pauses and resumes the worker's load like the main-thread loader.
       */
      worker?: boolean;
      /** Live WASM heap bytes allowed in the worker; default `2.5 × maxDecodedBytes`. */
      allocationCap?: number;
    }
  /**
   * A host-owned query provider. Sift asks it for the head of the result,
   * shows those rows, and keeps brushes local until the user applies them to
   * the whole dataset, which runs one new query. Memoize `session`; a new
   * identity re-queries from `initialQuery`. The session is closed on unmount
   * or source change.
   */
  | {
      kind: "query-session";
      session: TableQuerySession;
      /** Starting query; missing parts default to no casts, filters, or sort. */
      initialQuery?: Partial<TableQuery>;
      /** Decoded-memory and column limits for each result; `maxRows` is `headRows`. */
      limits?: Partial<TableFileLimits>;
      /** Rows requested per query. Default 10,000. */
      headRows?: number;
    };

/** What a `query-session` source has committed and whether a query is in flight. */
export type SiftQueryState = {
  /** Increments per query; a response from an older generation is dropped. */
  generation: number;
  pending: boolean;
  committedQuery: TableQuery;
  resultCount: Count;
};

/**
 * Pause a Parquet load at a soft budget below the hard `limits`; the user
 * loads more on demand. Each resume extends the budget by the same amounts.
 */
export type SiftAutoLoad = {
  /** Rows to load before pausing. Default: no pause. */
  rows?: number;
  /** Decoded Arrow bytes to load before pausing. Default: no pause. */
  decodedBytes?: number;
  /**
   * What resumes loading. `"manual"`: the footer "Load more" button only.
   * `"scroll"`: also when the viewport scrolls within the overscan of the last
   * loaded row. Default `"manual"`.
   */
  trigger?: "manual" | "scroll";
};

export type SiftLoadMilestone = {
  source: SiftSource["kind"];
  phase: string;
  elapsedMs: number;
  chunkIndex?: number;
  chunkCount?: number;
  /** Rows loaded so far (resident rows, not the file total). */
  rowCount?: number;
  /** Footer row count of a Parquet file. Set on Parquet `streaming-complete`. */
  totalRowCount?: number;
  /** Whether the budget stopped loading early. Set on Parquet `streaming-complete`. */
  truncated?: boolean;
  /**
   * Set on Parquet `streaming-complete`: true when the load paused at an
   * `autoLoad` budget and more rows can be requested, false when it finished.
   */
  resumable?: boolean;
  byteLength?: number;
  format?: "arrow-ipc" | "parquet";
};

export type SiftTableProps = {
  /** Normalized table source. Prefer this for new source types. */
  source?: SiftSource;
  /** Pre-built static TableData. For disposable file data, use a loader source for React effect replay. */
  data?: TableData;
  /** URL to load data from (Arrow IPC or Parquet, auto-detected). Mutually exclusive with `data`. */
  url?: string;
  /** Column type overrides keyed by column name. */
  typeOverrides?: Record<string, ColumnType>;
  /** Column display overrides (label, width, sortable). */
  columnOverrides?: Record<string, Partial<Column>>;
  /** Called whenever sort or filter state changes from UI interaction. */
  onChange?: (state: TableEngineState) => void;
  /** Called as URL/manifest data loads, decodes, and mounts. Intended for host diagnostics. */
  onLoadMilestone?: (milestone: SiftLoadMilestone) => void;
  /**
   * Called when a `loader`, `url`, `byte-source` or manifest source fails to
   * load; this lets the host log or surface the failure without wrapping the
   * loader. Sift shows its own error state too.
   *
   * A streaming Parquet source (`byte-source`, or a Parquet `url`) can fail
   * after rows have mounted. Sift then keeps those rows, notes the failure in
   * its footer instead of the blocking error box, and still calls this. A host
   * can tell the two cases apart by whether it saw the `engine-mounted`
   * milestone for this load.
   */
  onLoadError?: (error: Error) => void;
  /** Called as a `query-session` source starts and finishes each query. */
  onQueryStateChange?: (state: SiftQueryState) => void;
  /** Optional control rendered in Sift's footer before built-in buttons. */
  footerControl?: ReactNode;
  /** CSS class name for the container div. */
  className?: string;
  /** Inline styles for the container div. */
  style?: React.CSSProperties;
};

/** Live WASM store for one logical table, retained across manifest updates. */
type ManifestStore = {
  identity: string;
  handle: number;
  chunkKeys: string[];
  tableData: TableData;
  columns: Column[];
  refreshColumnTypes: (columnOverrides?: Record<string, Partial<Column>>) => TableData | null;
  pandasIndexCols: Set<string>;
  /** Overrides this store was built with. A change forces a rebuild. */
  columnOverrides: Record<string, Partial<Column>> | undefined;
  finished: boolean;
};

function arrowStreamChunkKeys(manifest: ArrowStreamManifest): string[] {
  return manifest.chunks.map((chunk) => `${chunk.url}\u0001${chunk.row_count ?? ""}`);
}

function arrowStreamManifestKey(manifest: ArrowStreamManifest | undefined): string | null {
  if (!manifest) return null;
  const complete = manifest.complete === false ? "open" : "complete";
  return `${complete}\u0002${arrowStreamChunkKeys(manifest).join("\u0000")}`;
}

/** Identifies the logical table. Stable while a progressive manifest grows. */
function arrowStreamIdentityKey(manifest: ArrowStreamManifest): string | null {
  const first = manifest.chunks[0];
  return first ? `${first.url}\u0001${first.row_count ?? ""}` : null;
}

type ArrowStreamPreviewNotice = {
  label: string;
  title: string;
};

function parquetPreviewNotice(preview: ParquetPreview | null): ArrowStreamPreviewNotice | null {
  if (!preview) return null;
  return {
    label: `Showing first ${preview.loadedRows.toLocaleString()} of ${preview.totalRows.toLocaleString()} rows`,
    title: "Sorting, filtering, and column summaries use only the rows shown in this preview.",
  };
}

function arrowStreamPreviewNotice(
  manifest: ArrowStreamManifest | undefined,
): ArrowStreamPreviewNotice | null {
  if (manifest?.complete === false || manifest?.summary?.sampled !== true) return null;
  const included = manifest.summary.included_rows;
  const total = manifest.summary.total_rows;
  const isHead = manifest.summary.sample_strategy === "head";
  let label = "Showing a bounded preview";
  if (typeof included === "number" && Number.isFinite(included)) {
    const shown = included.toLocaleString();
    if (typeof total === "number" && Number.isFinite(total) && total > included) {
      label = isHead
        ? `Showing first ${shown} of ${total.toLocaleString()} rows`
        : `Showing ${shown} of ${total.toLocaleString()} rows`;
    } else {
      label = isHead
        ? `Showing first ${shown} rows · total unknown`
        : `Showing ${shown} rows · total unknown`;
    }
  }

  return {
    label,
    title: "Sorting, filtering, and column summaries use only the rows shown in this preview.",
  };
}

/**
 * A manifest extends `store` when it names the same logical table and its
 * leading chunks are the ones already appended. Anything else (a changed head,
 * reordered chunks, a store already finished) rebuilds instead.
 */
function extendsStore(store: ManifestStore, manifest: ArrowStreamManifest): boolean {
  if (store.finished) return false;
  if (store.identity !== arrowStreamIdentityKey(manifest)) return false;
  const keys = arrowStreamChunkKeys(manifest);
  if (keys.length < store.chunkKeys.length) return false;
  return store.chunkKeys.every((key, i) => key === keys[i]);
}

// --- Format detection ---

/** Parquet magic bytes: PAR1 */
const PARQUET_MAGIC = new Uint8Array([0x50, 0x41, 0x52, 0x31]);

/**
 * Detect whether a fetch response contains Parquet or Arrow IPC data.
 * Checks Content-Type header first, then falls back to magic byte inspection.
 * Returns the format and the response bytes (buffered for parquet, or a
 * reconstructed ReadableStream for Arrow IPC to preserve streaming).
 */
async function detectFormat(
  response: Response,
): Promise<
  | { format: "parquet"; bytes: Uint8Array }
  | { format: "arrow-ipc"; stream: ReadableStream<Uint8Array> }
> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("parquet")) {
    return { format: "parquet", bytes: new Uint8Array(await response.arrayBuffer()) };
  }
  if (contentType.includes("arrow") || contentType.includes("ipc")) {
    if (!response.body) throw new Error("Response has no body");
    return { format: "arrow-ipc", stream: response.body };
  }

  // Ambiguous content type — peek magic bytes
  if (!response.body) throw new Error("Response has no body");
  const reader = response.body.getReader();
  const { value: firstChunk, done } = await reader.read();

  if (done || !firstChunk || firstChunk.length < 4) {
    // Too small to detect — try Arrow IPC as default
    const empty = firstChunk ?? new Uint8Array(0);
    return {
      format: "arrow-ipc",
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue(empty);
          controller.close();
        },
      }),
    };
  }

  const isParquet =
    firstChunk[0] === PARQUET_MAGIC[0] &&
    firstChunk[1] === PARQUET_MAGIC[1] &&
    firstChunk[2] === PARQUET_MAGIC[2] &&
    firstChunk[3] === PARQUET_MAGIC[3];

  if (isParquet) {
    // Buffer the rest for parquet (needs random access)
    const chunks: Uint8Array[] = [firstChunk];
    while (true) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      chunks.push(value);
    }
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return { format: "parquet", bytes };
  }

  // Reconstruct stream with peeked chunk for Arrow IPC streaming
  return {
    format: "arrow-ipc",
    stream: new ReadableStream({
      start(controller) {
        controller.enqueue(firstChunk);
      },
      async pull(controller) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          controller.close();
        } else {
          controller.enqueue(value);
        }
      },
      cancel() {
        reader.cancel();
      },
    }),
  };
}

// --- Progressive Parquet ---

/**
 * Default budget for Parquet behind a `url` source. The response is already
 * buffered, so these bound decoded memory, not the download. Hosts raise them
 * through `limits`; `maxColumns` keeps the `loadTableFile` default.
 */
export const URL_PARQUET_LIMITS: Readonly<TableFileLimits> = Object.freeze({
  maxRows: 1_000_000,
  maxDecodedBytes: 512 * 1024 * 1024,
});

type ProgressiveParquetArgs = {
  source: ByteSource;
  limits: ParquetFileLimits;
  overflow?: TableLimitOverflow;
  /** Soft budget to pause at; absent means load to the hard budget. */
  autoLoad?: Pick<SiftAutoLoad, "rows" | "decodedBytes">;
  columnOverrides?: Record<string, Partial<Column>>;
  /** Mount a `WindowedTableData` adapter over the store instead of the store itself. */
  windowed?: boolean;
  signal: AbortSignal;
  emit: (milestone: Omit<SiftLoadMilestone, "elapsedMs" | "source">) => void;
  /** Called once the file is open so cleanup can close or dispose it. */
  onOpen: (file: OpenParquetFile) => void;
  /**
   * Mount the first lease; later leases go through `engine().replaceData`.
   * `streaming` is true when more row groups follow.
   */
  mount: (tableData: TableData | WindowedTableData, streaming: boolean) => void;
  engine: () => TableEngine | null;
  /** Called when the load pauses at the soft budget, with the rows shown so far. */
  onPause?: (preview: ParquetPreview) => void;
};

/** Rows a Parquet stream holds against the file's footer total. */
type ParquetPreview = { loadedRows: number; totalRows: number };

/** Handle on a running Parquet load. */
type ParquetStream = {
  /**
   * Settles when the store is complete: the file ended, the hard budget cut it
   * short, or the load failed. Resolves with the loaded and total rows when
   * the hard budget cut the file short, null otherwise. Rejects with the loader
   * error; an aborted signal rejects with its reason.
   */
  done: Promise<ParquetPreview | null>;
  /** Continue a load paused at the soft budget. No-op unless paused. */
  resume(): void;
  /** True while the load waits at the soft budget for `resume()`. */
  readonly paused: boolean;
};

/**
 * Open a Parquet file by byte range, mount the table after the first row
 * group, then append the remaining groups one at a time, yielding to the
 * event loop between them. A truncating load stops at the row group that
 * spends the hard budget. With `autoLoad`, the load pauses once the rows or
 * decoded bytes committed reach the soft budget while row groups remain; the
 * table is at rest (`setStreamingDone`) until `resume()` extends the soft
 * budget by the same amounts and loading goes on.
 */
function streamParquetIntoEngine(args: ProgressiveParquetArgs): ParquetStream {
  const {
    source,
    limits,
    overflow,
    autoLoad,
    columnOverrides,
    windowed,
    signal,
    emit,
    onOpen,
    mount,
    engine,
    onPause,
  } = args;
  const format = "parquet";
  let resumeWaiting: (() => void) | null = null;
  /** The adapter the engine is mounted on, in windowed mode. */
  let adapter: ResidentWindowedData | null = null;
  const dataFor = (tableData: TableData): TableData | WindowedTableData => {
    if (!windowed) return tableData;
    adapter = createResidentWindowedData(tableData);
    return adapter;
  };
  const notifyAppended = () => (adapter ? adapter.notifyAppended() : engine()?.onBatchAppended());
  const done = () => (adapter ? adapter.notifyStreamingDone() : engine()?.setStreamingDone());

  const stream: ParquetStream = {
    done: run(),
    resume() {
      const wake = resumeWaiting;
      resumeWaiting = null;
      wake?.();
    },
    get paused() {
      return resumeWaiting !== null;
    },
  };
  return stream;

  async function run(): Promise<ParquetPreview | null> {
    const file = await openParquetFile(source, { limits, overflow, columnOverrides, signal });
    onOpen(file);
    emit({ phase: "wasm-ready", format, byteLength: source.byteLength });
    emit({
      phase: "table-data-created",
      format,
      rowCount: file.rowCount,
      chunkCount: file.rowGroupCount,
    });

    // Soft budget, extended by the same amounts on every resume.
    let softRows = autoLoad?.rows ?? Number.POSITIVE_INFINITY;
    let softBytes = autoLoad?.decodedBytes ?? Number.POSITIVE_INFINITY;
    const preview = (): ParquetPreview => ({
      loadedRows: file.loadedRows,
      totalRows: file.rowCount,
    });

    /**
     * After an append: when row groups remain and the soft budget is spent,
     * settle the table and wait for `resume()`. Returns once loading may go on.
     */
    async function pauseIfOverSoftBudget(nextGroup: number, exhausted: boolean) {
      if (exhausted || nextGroup >= file.rowGroupCount) return;
      const { usage } = file;
      if (usage.rows < softRows && usage.decodedBytes < softBytes) return;

      file.setPaused(true);
      done();
      emit({
        phase: "streaming-complete",
        format,
        rowCount: file.tableData.rowCount,
        totalRowCount: file.rowCount,
        truncated: true,
        resumable: true,
      });
      onPause?.(preview());

      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          resumeWaiting = null;
          reject(signal.reason);
        };
        if (signal.aborted) return abort();
        signal.addEventListener("abort", abort, { once: true });
        resumeWaiting = () => {
          signal.removeEventListener("abort", abort);
          resolve();
        };
      });

      softRows = usage.rows + (autoLoad?.rows ?? Number.POSITIVE_INFINITY);
      softBytes = usage.decodedBytes + (autoLoad?.decodedBytes ?? Number.POSITIVE_INFINITY);
      file.setPaused(false);
      engine()?.resumeStreaming();
      emit({ phase: "streaming-resumed", format, rowCount: file.tableData.rowCount });
    }

    let exhausted = false;
    if (file.rowGroupCount > 0) {
      ({ exhausted } = await file.appendRowGroup(0));
      emit({
        phase: "first-chunk-fetched",
        format,
        chunkIndex: 0,
        chunkCount: file.rowGroupCount,
      });
    }
    emit({ phase: "summaries-ready", format, rowCount: file.tableData.rowCount });
    signal.throwIfAborted();
    mount(dataFor(file.tableData), file.rowGroupCount > 1 && !exhausted);
    emit({ phase: "engine-mounted", format, rowCount: file.tableData.rowCount });
    await pauseIfOverSoftBudget(1, exhausted);

    for (let group = 1; group < file.rowGroupCount && !exhausted; group++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      const appended = await file.appendRowGroup(group);
      const { replaced } = appended;
      exhausted = appended.exhausted;
      signal.throwIfAborted();
      if (replaced) {
        engine()?.replaceData(dataFor(replaced), { streaming: true });
      } else {
        notifyAppended();
      }
      emit({
        phase: "chunk-appended",
        format,
        chunkIndex: group,
        chunkCount: file.rowGroupCount,
        rowCount: file.tableData.rowCount,
      });
      await pauseIfOverSoftBudget(group + 1, exhausted);
    }

    signal.throwIfAborted();
    const { replaced } = file.finish();
    if (replaced) {
      engine()?.replaceData(dataFor(replaced), { streaming: false });
    } else {
      done();
    }
    emit({
      phase: "streaming-complete",
      format,
      rowCount: file.tableData.rowCount,
      totalRowCount: file.rowCount,
      truncated: file.truncated,
      resumable: false,
    });
    return file.truncated ? preview() : null;
  }
}

// --- Query sessions ---

/** Default IPC byte budget per query result. */
const QUERY_MAX_IPC_BYTES = 64 * 1024 * 1024;
const QUERY_DEFAULT_HEAD_ROWS = 10_000;

function completeQuery(partial: Partial<TableQuery> | undefined): TableQuery {
  return {
    casts: partial?.casts ?? [],
    filters: partial?.filters ?? [],
    sort: partial?.sort ?? [],
  };
}

/** The committed query plus the engine's local filters, as one query. */
function mergeLocalFilters(committed: TableQuery, local: FilterPredicate[]): TableQuery {
  return { ...committed, filters: [...committed.filters, ...local] };
}

/** Portable predicates for the engine's current local filters. */
function localPredicates(state: TableEngineState): FilterPredicate[] {
  return columnFiltersToPredicates(
    state.filters.map((entry) => ({ key: entry.column })),
    state.filters.map((entry) => entry.filter),
  );
}

/** Reject `autoLoad` settings the loader cannot honor. */
function validateAutoLoad(
  autoLoad: SiftAutoLoad | undefined,
  overflow: TableLimitOverflow,
): Pick<SiftAutoLoad, "rows" | "decodedBytes"> | undefined {
  if (!autoLoad) return undefined;
  if (overflow !== "truncate") {
    throw new Error('autoLoad requires overflow: "truncate"; an erroring load cannot pause');
  }
  for (const key of ["rows", "decodedBytes"] as const) {
    const value = autoLoad[key];
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`autoLoad.${key} must be a positive number`);
    }
  }
  if (
    autoLoad.trigger !== undefined &&
    autoLoad.trigger !== "manual" &&
    autoLoad.trigger !== "scroll"
  ) {
    throw new Error(
      `autoLoad.trigger must be "manual" or "scroll", got ${String(autoLoad.trigger)}`,
    );
  }
  if (autoLoad.rows === undefined && autoLoad.decodedBytes === undefined) return undefined;
  return { rows: autoLoad.rows, decodedBytes: autoLoad.decodedBytes };
}

// --- Component ---

export function SiftTable({
  source,
  data,
  url,
  typeOverrides,
  columnOverrides,
  onChange,
  onLoadMilestone,
  onLoadError,
  onQueryStateChange,
  footerControl,
  className,
  style,
}: SiftTableProps) {
  const dataSource = source?.kind === "table-data" ? source.data : data;
  const querySession = source?.kind === "query-session" ? source.session : undefined;
  // Read once per session: a new initial query means a new session.
  const queryInitialRef = useRef<Partial<TableQuery> | undefined>(undefined);
  if (source?.kind === "query-session") queryInitialRef.current = source.initialQuery;
  const queryHeadRows =
    (source?.kind === "query-session" ? source.headRows : undefined) ?? QUERY_DEFAULT_HEAD_ROWS;
  const queryLimits = source?.kind === "query-session" ? source.limits : undefined;
  const queryMaxColumns = queryLimits?.maxColumns;
  const queryMaxDecodedBytes = queryLimits?.maxDecodedBytes;
  const urlSource = source?.kind === "url" ? source.url : url;
  const manifestSource = source?.kind === "arrow-stream-manifest" ? source.manifest : undefined;
  const loadSource = source?.kind === "loader" ? source.load : undefined;
  const byteSource = source?.kind === "byte-source" ? source.source : undefined;
  // Primitive deps so an inline `limits` object does not reload on every render.
  const byteSourceLimits = source?.kind === "byte-source" ? source.limits : undefined;
  const byteSourceMaxRows = byteSourceLimits?.maxRows;
  const byteSourceMaxColumns = byteSourceLimits?.maxColumns;
  const byteSourceMaxDecodedBytes = byteSourceLimits?.maxDecodedBytes;
  const byteSourceOverflow = source?.kind === "byte-source" ? source.overflow : undefined;
  const autoLoad =
    source?.kind === "byte-source" || source?.kind === "url" ? source.autoLoad : undefined;
  const hasAutoLoad = autoLoad !== undefined;
  const windowedSource =
    (source?.kind === "byte-source" || source?.kind === "url") && source.windowed === true;
  const workerSource = source?.kind === "byte-source" && source.worker === true;
  const workerAllocationCap = source?.kind === "byte-source" ? source.allocationCap : undefined;
  const autoLoadRows = autoLoad?.rows;
  const autoLoadDecodedBytes = autoLoad?.decodedBytes;
  const autoLoadTrigger = autoLoad?.trigger;
  const urlLimits = source?.kind === "url" ? source.limits : undefined;
  const urlMaxRows = urlLimits?.maxRows;
  const urlMaxColumns = urlLimits?.maxColumns;
  const urlMaxDecodedBytes = urlLimits?.maxDecodedBytes;
  const urlOverflow: TableLimitOverflow =
    (source?.kind === "url" ? source.overflow : undefined) ?? "truncate";
  // Keyed by source so a preview never outlives the byte source or URL that
  // produced it.
  const [parquetPreview, setParquetPreview] = useState<{
    source: ByteSource | string;
    preview: ParquetPreview;
  } | null>(null);
  const parquetPreviewSource = byteSource ?? urlSource;
  const currentParquetPreview =
    parquetPreviewSource && parquetPreview?.source === parquetPreviewSource
      ? parquetPreview.preview
      : null;
  /**
   * A Parquet load waiting at its `autoLoad` budget. `loading` is true from
   * the user's request until the loader pauses again or finishes. Keyed by
   * source like the preview.
   */
  const [pausedLoad, setPausedLoad] = useState<{
    source: ByteSource | string;
    resume: () => void;
    loading: boolean;
  } | null>(null);
  const currentPausedLoad =
    parquetPreviewSource && pausedLoad?.source === parquetPreviewSource ? pausedLoad : null;
  const currentPausedLoadRef = useRef(currentPausedLoad);
  currentPausedLoadRef.current = currentPausedLoad;
  const loadMore = useCallback(() => {
    const current = currentPausedLoadRef.current;
    if (!current || current.loading) return;
    current.resume();
    setPausedLoad({ ...current, loading: true });
  }, []);
  // The engine gets one stable callback; the active Parquet effect decides
  // whether a near-end scroll should load more.
  const onScrollNearEndRef = useRef<(() => void) | null>(null);
  const stableOnScrollNearEnd = useCallback(() => {
    onScrollNearEndRef.current?.();
  }, []);
  /**
   * The query-session source's committed state, keyed by session so a stale
   * run never describes a new session. `runQuery` is set by the active effect.
   */
  const [queryRun, setQueryRun] = useState<
    (SiftQueryState & { session: TableQuerySession }) | null
  >(null);
  const currentQueryRun = querySession && queryRun?.session === querySession ? queryRun : null;
  const runQueryRef = useRef<((q: TableQuery) => void) | null>(null);
  /** A session whose close is deferred past a possible StrictMode replay. */
  const pendingSessionCloseRef = useRef<{
    session: TableQuerySession;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  /** Local filters the engine reported, as portable predicates. Query sessions only. */
  const [queryLocalFilters, setQueryLocalFilters] = useState<FilterPredicate[]>([]);
  const querySessionRef = useRef(querySession);
  querySessionRef.current = querySession;
  const applyQuery: { merged: TableQuery; support: QuerySupport } | null = useMemo(() => {
    if (!currentQueryRun || !querySession || queryLocalFilters.length === 0) return null;
    const merged = mergeLocalFilters(currentQueryRun.committedQuery, queryLocalFilters);
    return { merged, support: supportsQuery(querySession.capabilities, merged) };
  }, [currentQueryRun, querySession, queryLocalFilters]);
  const applyToWholeDataset = useCallback(() => {
    if (!applyQuery?.support.ok) return;
    runQueryRef.current?.(applyQuery.merged);
  }, [applyQuery]);
  const onQueryStateChangeRef = useRef(onQueryStateChange);
  onQueryStateChangeRef.current = onQueryStateChange;
  useEffect(() => {
    if (!currentQueryRun) return;
    const { session: _session, ...state } = currentQueryRun;
    onQueryStateChangeRef.current?.(state);
  }, [currentQueryRun]);
  const previewNotice = useMemo(
    () => arrowStreamPreviewNotice(manifestSource) ?? parquetPreviewNotice(currentParquetPreview),
    [manifestSource, currentParquetPreview],
  );
  const isBoundedPreview = previewNotice !== null;
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TableEngine | null>(null);
  const engineDivRef = useRef<HTMLDivElement | null>(null);
  // Survives manifest updates so a growing manifest appends instead of rebuilding.
  const storeRef = useRef<ManifestStore | null>(null);
  const footerControlRef = useRef<HTMLDivElement | null>(null);
  const footerControlRootRef = useRef<Root | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  /** Message of a streaming failure after rows mounted. Shown in the footer. */
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  // The footer slot is created with the engine, so a source that may report a
  // preview later needs it from the start.
  const hasFooterControl =
    footerControl != null ||
    manifestSource != null ||
    querySession != null ||
    (byteSource != null && byteSourceOverflow === "truncate") ||
    (urlSource != null && urlOverflow === "truncate");

  // Stable callback ref to avoid re-mounting engine when onChange identity changes
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLoadMilestoneRef = useRef(onLoadMilestone);
  onLoadMilestoneRef.current = onLoadMilestone;
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;

  const stableOnChange = useCallback((state: TableEngineState) => {
    // Only a query session needs the local filters in React state, for Apply.
    // Brushing reports every step, so unchanged predicates keep their identity.
    if (querySessionRef.current) {
      const next = localPredicates(state);
      setQueryLocalFilters((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    }
    onChangeRef.current?.(state);
  }, []);
  // The engine gets one stable callback; the active query effect answers it.
  const stableOnCommittedQueryChange = useCallback((next: TableQuery) => {
    runQueryRef.current?.(next);
  }, []);

  /**
   * The footer slot element, created on first use. Stable, so code that needs
   * the slot for a one-off notice does not re-run the source effects, which
   * list `getFooterControlElement` as a dependency.
   */
  const ensureFooterSlot = useCallback(() => {
    if (!footerControlRef.current) {
      footerControlRef.current = document.createElement("div");
      footerControlRef.current.className = "sift-footer-slot";
      footerControlRootRef.current = createRoot(footerControlRef.current);
    }
    return footerControlRef.current;
  }, []);

  /**
   * Tell the host about a load failure. Before mount, switch to the blocking
   * error state. After mount the loaded rows stay usable, so the failure is a
   * footer notice instead; the slot is attached for it even when this source
   * has no footer otherwise.
   */
  const reportLoadError = useCallback(
    (cause: unknown, afterMount = false) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (afterMount && engineRef.current) {
        engineRef.current.setFooterControl(ensureFooterSlot());
        setLoadFailure(error.message);
      } else {
        setError(error.message);
        setStatus("error");
      }
      onLoadErrorRef.current?.(error);
    },
    [ensureFooterSlot],
  );

  const emitLoadMilestone = useCallback(
    (startedAt: number, milestone: Omit<SiftLoadMilestone, "elapsedMs">) => {
      onLoadMilestoneRef.current?.({
        ...milestone,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    },
    [],
  );

  const getFooterControlElement = useCallback(
    () => (hasFooterControl ? ensureFooterSlot() : undefined),
    [ensureFooterSlot, hasFooterControl],
  );

  const getEngineElement = useCallback(() => {
    const container = containerRef.current;
    if (!container) return null;
    if (!engineDivRef.current) {
      const engineDiv = document.createElement("div");
      engineDiv.style.height = "100%";
      container.appendChild(engineDiv);
      engineDivRef.current = engineDiv;
    }
    return engineDivRef.current;
  }, []);

  const isBoundedPreviewRef = useRef(isBoundedPreview);
  isBoundedPreviewRef.current = isBoundedPreview;
  const loadFailureRef = useRef(loadFailure);
  loadFailureRef.current = loadFailure;

  /**
   * Bring the engine's status indicator in line with what SiftTable knows and
   * the engine does not: a bounded preview, or a failure after mount. Acts
   * only once the engine has settled (`sift-status-ready`), except that a
   * cleared failure must lose its stopped styling even during a replacement
   * stream. While streaming, the engine owns the glyph and tooltip.
   */
  const syncStatusIndicator = useCallback(() => {
    const indicator = engineDivRef.current?.querySelector<HTMLElement>(".sift-status-indicator");
    if (!indicator) return;
    const failure = loadFailureRef.current;
    if (!failure) indicator.classList.remove("sift-status-stopped");
    if (!indicator.classList.contains("sift-status-ready")) return;
    if (failure) {
      indicator.classList.add("sift-status-stopped");
      indicator.textContent = "!";
      indicator.title = `Stopped loading: ${failure}`;
      return;
    }
    indicator.textContent = "✓";
    indicator.title = isBoundedPreviewRef.current ? "Preview loaded" : "All data loaded";
  }, []);

  useEffect(() => {
    syncStatusIndicator();
  }, [isBoundedPreview, loadFailure, status, syncStatusIndicator]);

  useEffect(() => {
    if (hasFooterControl) {
      getFooterControlElement();
    }
    footerControlRootRef.current?.render(
      <>
        {loadFailure && (
          <span className="sift-preview-hint sift-load-failure" role="status" title={loadFailure}>
            {`Stopped loading: ${loadFailure} · Showing loaded rows`}
          </span>
        )}
        {previewNotice && (
          <span
            className="sift-preview-hint"
            role="note"
            title={previewNotice.title}
            aria-label={`${previewNotice.label}. ${previewNotice.title}`}
          >
            <span>{previewNotice.label}</span>
            {currentPausedLoad && (
              <button
                type="button"
                className="sift-load-more"
                disabled={currentPausedLoad.loading}
                aria-busy={currentPausedLoad.loading}
                onClick={loadMore}
              >
                {currentPausedLoad.loading ? "Loading…" : "Load more"}
              </button>
            )}
            {/* The stylesheet shows one of these by viewport width: the full
                sentence on wide footers, the short badge on narrow ones. */}
            <span className="sift-preview-scope sift-preview-scope-full" aria-hidden="true">
              {" · Table tools use shown rows"}
            </span>
            <span className="sift-preview-scope sift-preview-scope-short" aria-hidden="true">
              {" · Shown rows"}
            </span>
          </span>
        )}
        {applyQuery && currentQueryRun && (
          <button
            type="button"
            className="sift-apply-query"
            disabled={currentQueryRun.pending || !applyQuery.support.ok}
            aria-busy={currentQueryRun.pending}
            title={applyQuery.support.ok ? undefined : applyQuery.support.reason}
            onClick={applyToWholeDataset}
          >
            {currentQueryRun.pending ? "Querying…" : "Apply filters to whole dataset"}
          </button>
        )}
        {footerControl}
      </>,
    );
  }, [
    applyQuery,
    applyToWholeDataset,
    currentPausedLoad,
    currentQueryRun,
    footerControl,
    getFooterControlElement,
    hasFooterControl,
    loadFailure,
    loadMore,
    previewNotice,
  ]);

  useEffect(() => {
    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
      engineDivRef.current?.remove();
      engineDivRef.current = null;
      // Manifest-effect cleanup deliberately leaves a mounted store alone, so
      // unmount is the only place a committed store gets freed.
      storeRef.current?.tableData.dispose?.();
      storeRef.current = null;
      footerControlRootRef.current?.unmount();
      footerControlRootRef.current = null;
      footerControlRef.current = null;
    };
  }, []);

  const manifestKey = arrowStreamManifestKey(manifestSource);

  useEffect(() => {
    if (!loadSource || !containerRef.current) return;
    const startedAt = performance.now();
    let cancelled = false;
    let pendingData: TableData | undefined;
    engineRef.current?.destroy();
    engineRef.current = null;
    storeRef.current = null;
    setStatus("loading");
    setError(null);
    setLoadFailure(null);
    emitLoadMilestone(startedAt, { source: "loader", phase: "load-start" });

    Promise.resolve()
      .then(() => (cancelled ? undefined : loadSource()))
      .then((loaded) => {
        if (!loaded) return;
        if (cancelled) {
          loaded.dispose?.();
          return;
        }
        pendingData = loaded;
        const engineDiv = getEngineElement();
        if (!engineDiv) {
          loaded.dispose?.();
          pendingData = undefined;
          return;
        }
        applyColumnOverrides(loaded.columns, columnOverrides);
        engineRef.current = createTable(engineDiv, loaded, {
          onChange: stableOnChange,
          onScrollNearEnd: stableOnScrollNearEnd,
          onCommittedQueryChange: stableOnCommittedQueryChange,
          footerControl: getFooterControlElement(),
        });
        pendingData = undefined;
        engineRef.current.setStreamingDone();
        setStatus("ready");
        emitLoadMilestone(startedAt, {
          source: "loader",
          phase: "complete",
          rowCount: loaded.rowCount,
        });
      })
      .catch((cause: unknown) => {
        pendingData?.dispose?.();
        pendingData = undefined;
        if (cancelled) return;
        reportLoadError(cause);
      });

    return () => {
      cancelled = true;
      pendingData?.dispose?.();
      pendingData = undefined;
    };
  }, [
    loadSource,
    columnOverrides,
    stableOnChange,
    getEngineElement,
    getFooterControlElement,
    emitLoadMilestone,
    reportLoadError,
  ]);

  // Query session: ask the provider for the head of the result, mount it as a
  // committed query, and re-query on Apply or when a committed pill is cleared.
  useEffect(() => {
    if (!querySession || !containerRef.current) return;
    const session = querySession;
    const caps = session.capabilities;
    const pendingClose = pendingSessionCloseRef.current;
    if (pendingClose) {
      clearTimeout(pendingClose.timer);
      pendingSessionCloseRef.current = null;
      if (pendingClose.session !== session) pendingClose.session.close().catch(() => {});
    }
    // See the `data` effect: this source takes over the engine.
    storeRef.current = null;
    setLoadFailure(null);
    setQueryLocalFilters([]);

    let generation = 0;
    let controller: AbortController | null = null;
    let cancelled = false;
    let limits: ParquetFileLimits;
    try {
      limits = resolveTableFileLimits({
        maxRows: queryHeadRows,
        maxColumns: queryMaxColumns,
        maxDecodedBytes: queryMaxDecodedBytes,
      });
    } catch (cause) {
      reportLoadError(cause);
      return;
    }
    const stale = (myGeneration: number) => cancelled || myGeneration !== generation;

    function runQuery(q: TableQuery) {
      controller?.abort();
      const myController = new AbortController();
      controller = myController;
      const myGeneration = ++generation;
      const startedAt = performance.now();
      const emit = (milestone: Omit<SiftLoadMilestone, "elapsedMs" | "source">) =>
        emitLoadMilestone(startedAt, { ...milestone, source: "query-session" });
      const ctx = {
        requestId: `sift-query-${myGeneration}`,
        signal: myController.signal,
        budget: { maxIpcBytes: QUERY_MAX_IPC_BYTES, maxDecodedBytes: limits.maxDecodedBytes },
      };
      setQueryRun({
        session,
        generation: myGeneration,
        pending: true,
        committedQuery: q,
        resultCount: { kind: "unknown" },
      });
      setStatus((current) => (current === "ready" ? current : "loading"));
      setError(null);
      emit({ phase: "load-start" });

      (async () => {
        const page = await session.query(
          { ...q, window: { mode: "head", limit: limits.maxRows } },
          ctx,
        );
        if (stale(myGeneration)) return;
        await ensureModule();
        if (stale(myGeneration)) return;
        emit({ phase: "wasm-ready", format: "arrow-ipc", byteLength: page.ipc.byteLength });
        const tableData = await loadTableFile(page.ipc, {
          format: "arrow-ipc",
          maxRows: limits.maxRows,
          maxColumns: limits.maxColumns,
          maxDecodedBytes: limits.maxDecodedBytes,
          maxBytes: QUERY_MAX_IPC_BYTES,
        });
        if (stale(myGeneration)) {
          tableData.dispose?.();
          return;
        }
        // The result is a window over the query's matches, so coverage speaks
        // of them: the total is the matched count when the provider knows it.
        tableData.coverage = {
          loadedRows: page.returnedRows,
          totalRows:
            page.matchedCount.kind === "exact"
              ? {
                  value: page.matchedCount.value,
                  scope: "dataset",
                  precision: "exact",
                  source: "query",
                }
              : undefined,
          truncated: page.continuation.kind !== "end",
        };
        tableData.recomputeSummaries?.();
        applyColumnOverrides(tableData.columns, columnOverrides);
        emit({ phase: "table-data-created", format: "arrow-ipc", rowCount: tableData.rowCount });

        let engine = engineRef.current;
        if (engine) {
          engine.replaceData(tableData, {
            committedQuery: q,
            streaming: false,
            footerControl: getFooterControlElement() ?? null,
          });
        } else {
          const engineDiv = getEngineElement();
          if (!engineDiv) {
            tableData.dispose?.();
            return;
          }
          const engineOptions: InternalTableEngineOptions = {
            onChange: stableOnChange,
            onScrollNearEnd: stableOnScrollNearEnd,
            onCommittedQueryChange: stableOnCommittedQueryChange,
            footerControl: getFooterControlElement(),
            committedQuery: q,
          };
          engine = createTable(engineDiv, tableData, engineOptions);
          engineRef.current = engine;
          engine.setStreamingDone();
        }
        engine.setResultCount(page.matchedCount);
        setStatus("ready");
        emit({ phase: "engine-mounted", format: "arrow-ipc", rowCount: tableData.rowCount });

        let count = page.matchedCount;
        if (count.kind === "unknown" && caps.counts.length > 0) {
          setQueryRun((current) =>
            current?.generation === myGeneration ? { ...current, pending: false } : current,
          );
          count = await session.count(q, "cheap", ctx);
          if (stale(myGeneration)) return;
          engine.setResultCount(count);
        }
        setQueryRun((current) =>
          current?.generation === myGeneration
            ? { ...current, pending: false, resultCount: count }
            : current,
        );
        emit({ phase: "complete", format: "arrow-ipc", rowCount: tableData.rowCount });
      })().catch((cause: unknown) => {
        if (stale(myGeneration)) return;
        setQueryRun((current) =>
          current?.generation === myGeneration ? { ...current, pending: false } : current,
        );
        reportLoadError(cause, engineRef.current !== null);
      });
    }

    runQueryRef.current = runQuery;
    runQuery(completeQuery(queryInitialRef.current));

    return () => {
      cancelled = true;
      controller?.abort();
      if (runQueryRef.current === runQuery) runQueryRef.current = null;
      // Deferred one tick: StrictMode replays the effect with the same session,
      // and a closed session could not answer the replay.
      pendingSessionCloseRef.current = {
        session,
        timer: setTimeout(() => {
          pendingSessionCloseRef.current = null;
          session.close().catch(() => {});
        }, 0),
      };
    };
  }, [
    querySession,
    queryHeadRows,
    queryMaxColumns,
    queryMaxDecodedBytes,
    columnOverrides,
    stableOnChange,
    stableOnScrollNearEnd,
    stableOnCommittedQueryChange,
    getEngineElement,
    getFooterControlElement,
    emitLoadMilestone,
    reportLoadError,
  ]);

  // Stream a byte-range Parquet source: footer, first row group, mount, rest.
  useEffect(() => {
    if (!byteSource || !containerRef.current) return;

    // See the `data` effect: this source takes over the engine, so the
    // manifest store it supersedes must not stay reachable through the ref.
    storeRef.current = null;

    const startedAt = performance.now();
    const controller = new AbortController();
    let cancelled = false;
    let openFile: OpenParquetFile | null = null;
    let mounted = false;

    setStatus("loading");
    setError(null);
    setLoadFailure(null);
    setParquetPreview(null);
    setPausedLoad(null);
    emitLoadMilestone(startedAt, { source: "byte-source", phase: "load-start" });

    let limits: ParquetFileLimits;
    let softBudget: Pick<SiftAutoLoad, "rows" | "decodedBytes"> | undefined;
    try {
      limits = resolveTableFileLimits({
        maxRows: byteSourceMaxRows,
        maxColumns: byteSourceMaxColumns,
        maxDecodedBytes: byteSourceMaxDecodedBytes,
      });
      softBudget = validateAutoLoad(
        hasAutoLoad
          ? { rows: autoLoadRows, decodedBytes: autoLoadDecodedBytes, trigger: autoLoadTrigger }
          : undefined,
        byteSourceOverflow ?? "error",
      );
    } catch (cause) {
      reportLoadError(cause);
      return;
    }

    if (workerSource) {
      if (!getWorkerFactory()) {
        reportLoadError(
          new Error(
            "worker: true needs a worker factory. Call setWorkerFactory(() => new Worker(...)) first; Sift does not fall back to the main thread.",
          ),
        );
        return;
      }
      let data: WorkerWindowedData | null = null;
      let unsubscribe: (() => void) | null = null;
      /** The worker waits at the `autoLoad` budget and has not been asked to resume. */
      let paused = false;
      const resume = () => {
        if (cancelled || !paused || !data) return;
        paused = false;
        data.resume();
      };
      if (autoLoadTrigger === "scroll") {
        onScrollNearEndRef.current = () => {
          if (cancelled || !paused) return;
          resume();
          setPausedLoad((current) => (current ? { ...current, loading: true } : current));
        };
      }
      createWorkerWindowedData({
        source: byteSource,
        limits,
        overflow: byteSourceOverflow,
        columnOverrides,
        allocationCap: workerAllocationCap,
        autoLoad: softBudget,
        signal: controller.signal,
        emit: (milestone) => emitLoadMilestone(startedAt, { ...milestone, source: "byte-source" }),
      }).then(
        (opened) => {
          if (cancelled) {
            opened.dispose();
            return;
          }
          data = opened;
          unsubscribe = opened.subscribe((event) => {
            if (cancelled) return;
            if (event.type === "streaming-done") {
              // A budget that stopped early, or a pause at the soft budget,
              // gets the same notice as the main-thread loader.
              const { loadedRows, totalRows, truncated, resumable } = event;
              setParquetPreview(
                (truncated || resumable) && loadedRows !== undefined && totalRows !== undefined
                  ? { source: byteSource, preview: { loadedRows, totalRows } }
                  : null,
              );
              paused = resumable === true;
              setPausedLoad(paused ? { source: byteSource, resume, loading: false } : null);
              return;
            }
            if (event.type === "streaming-resumed") {
              // The engine settled on the pause; appends follow.
              engineRef.current?.resumeStreaming();
              return;
            }
            if (event.type !== "error") return;
            // An error after mount keeps the loaded rows; the footer says why.
            // Fatal: the worker is gone. Non-fatal: it stopped appending and
            // still answers for the rows it has; no `streaming-done` follows.
            paused = false;
            setPausedLoad(null);
            engineRef.current?.setStreamingDone();
            reportLoadError(new Error(event.message), mounted);
          });
          const streaming = opened.rowGroupCount > 1;
          if (engineRef.current) {
            engineRef.current.replaceData(opened, {
              streaming,
              footerControl: getFooterControlElement() ?? null,
            });
          } else {
            const engineDiv = getEngineElement();
            if (!engineDiv) {
              opened.dispose();
              return;
            }
            engineRef.current = createTable(engineDiv, opened, {
              onChange: stableOnChange,
              onScrollNearEnd: stableOnScrollNearEnd,
              onCommittedQueryChange: stableOnCommittedQueryChange,
              footerControl: getFooterControlElement(),
            });
            if (!streaming) engineRef.current.setStreamingDone();
          }
          mounted = true;
          setStatus("ready");
          emitLoadMilestone(startedAt, {
            source: "byte-source",
            phase: "engine-mounted",
            format: "parquet",
            rowCount: opened.rowCount,
          });
        },
        (cause: unknown) => {
          if (cancelled) return;
          reportLoadError(cause, mounted);
        },
      );
      return () => {
        cancelled = true;
        controller.abort();
        onScrollNearEndRef.current = null;
        unsubscribe?.();
        // Once mounted the engine owns the data and closes the worker on destroy.
        if (data && !mounted) data.dispose();
      };
    }

    const stream = streamParquetIntoEngine({
      source: byteSource,
      limits,
      overflow: byteSourceOverflow,
      autoLoad: softBudget,
      columnOverrides,
      windowed: windowedSource,
      signal: controller.signal,
      emit: (milestone) => emitLoadMilestone(startedAt, { ...milestone, source: "byte-source" }),
      onOpen: (file) => {
        openFile = file;
      },
      mount: (tableData, streaming) => {
        if (engineRef.current) {
          engineRef.current.replaceData(tableData, {
            streaming,
            footerControl: getFooterControlElement() ?? null,
          });
        } else {
          const engineDiv = getEngineElement();
          if (!engineDiv) return;
          engineRef.current = createTable(engineDiv, tableData, {
            onChange: stableOnChange,
            onScrollNearEnd: stableOnScrollNearEnd,
            onCommittedQueryChange: stableOnCommittedQueryChange,
            footerControl: getFooterControlElement(),
          });
        }
        mounted = true;
        setStatus("ready");
      },
      engine: () => engineRef.current,
      onPause: (preview) => {
        if (cancelled) return;
        setParquetPreview({ source: byteSource, preview });
        setPausedLoad({ source: byteSource, resume: stream.resume, loading: false });
      },
    });
    if (autoLoadTrigger === "scroll") {
      onScrollNearEndRef.current = () => {
        if (cancelled || !stream.paused) return;
        stream.resume();
        setPausedLoad((current) => (current ? { ...current, loading: true } : current));
      };
    }
    stream.done.then(
      (preview) => {
        if (cancelled) return;
        setParquetPreview(preview ? { source: byteSource, preview } : null);
        setPausedLoad(null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        if (openFile && !mounted) openFile.dispose();
        else openFile?.close();
        openFile = null;
        setPausedLoad(null);
        // A failure after mount leaves the rows already loaded in place. End the
        // streaming state so the status dot and cast guard do not wait forever.
        if (mounted) engineRef.current?.setStreamingDone();
        reportLoadError(cause, mounted);
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
      onScrollNearEndRef.current = null;
      // Once mounted the engine owns the store; only the footer metadata is ours.
      if (openFile && !mounted) openFile.dispose();
      else openFile?.close();
      openFile = null;
    };
  }, [
    byteSource,
    byteSourceMaxRows,
    byteSourceMaxColumns,
    byteSourceMaxDecodedBytes,
    byteSourceOverflow,
    hasAutoLoad,
    autoLoadRows,
    autoLoadDecodedBytes,
    autoLoadTrigger,
    windowedSource,
    workerSource,
    workerAllocationCap,
    stableOnScrollNearEnd,
    columnOverrides,
    stableOnChange,
    stableOnCommittedQueryChange,
    getEngineElement,
    getFooterControlElement,
    emitLoadMilestone,
    reportLoadError,
  ]);

  // Mount engine when `data` prop is provided directly
  useEffect(() => {
    if (!dataSource || !containerRef.current) return;
    const startedAt = performance.now();

    // This source now owns the engine. `replaceData` frees the manifest store
    // it supersedes, so the ref must not outlive it: a later manifest that
    // looked like an extension would otherwise append to a freed handle.
    storeRef.current = null;
    setLoadFailure(null);

    if (engineRef.current) {
      engineRef.current.replaceData(dataSource, {
        streaming: false,
        footerControl: getFooterControlElement() ?? null,
      });
      emitLoadMilestone(startedAt, {
        source: "table-data",
        phase: "engine-data-replaced",
        rowCount: dataSource.rowCount,
      });
      setStatus("ready");
      return;
    }

    const engineDiv = getEngineElement();
    if (!engineDiv) return;

    engineRef.current = createTable(engineDiv, dataSource, {
      onChange: stableOnChange,
      onScrollNearEnd: stableOnScrollNearEnd,
      onCommittedQueryChange: stableOnCommittedQueryChange,
      footerControl: getFooterControlElement(),
    });
    engineRef.current.setStreamingDone();
    emitLoadMilestone(startedAt, {
      source: "table-data",
      phase: "engine-mounted",
      rowCount: dataSource.rowCount,
    });
    setStatus("ready");
  }, [dataSource, stableOnChange, getFooterControlElement, getEngineElement, emitLoadMilestone]);

  // Load Arrow stream manifest chunks through the appendable WASM store.
  useEffect(() => {
    if (!manifestSource || !containerRef.current) return;

    const manifest = manifestSource;
    const identity = arrowStreamIdentityKey(manifest);
    const startedAt = performance.now();
    let cancelled = false;
    let disposePendingStore: (() => void) | null = null;

    function mountEngine(tableData: TableData) {
      if (engineRef.current) {
        // A reused engine keeps whatever streaming state the previous
        // manifest settled on, so an open stream re-arms the guard here.
        engineRef.current.replaceData(tableData, {
          streaming: manifest.complete === false,
          footerControl: getFooterControlElement() ?? null,
        });
        disposePendingStore = null;
        return;
      }
      const engineDiv = getEngineElement();
      if (!engineDiv) return;
      engineRef.current = createTable(engineDiv, tableData, {
        onChange: stableOnChange,
        onScrollNearEnd: stableOnScrollNearEnd,
        onCommittedQueryChange: stableOnCommittedQueryChange,
        footerControl: getFooterControlElement(),
      });
      disposePendingStore = null;
    }

    async function fetchChunkBytes(chunk: ArrowStreamManifestChunk, index: number) {
      if (!chunk.url) {
        throw new Error(`Arrow stream manifest chunk ${index} is missing a URL`);
      }
      const response = await tableResponse(chunk.url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch Arrow stream chunk ${index}: ${response.status} ${response.statusText}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    }

    type ChunkFetchResult = { ok: true; bytes: Uint8Array } | { ok: false; error: unknown };

    const fetchChunkResult = (chunk: ArrowStreamManifestChunk, index: number) =>
      fetchChunkBytes(chunk, index).then(
        (bytes) => ({ ok: true as const, bytes }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    const readChunkBytes = async (fetchResult: Promise<ChunkFetchResult>) => {
      const result = await fetchResult;
      if (!result.ok) throw result.error;
      return result.bytes;
    };

    /**
     * Append manifest chunks from `store.chunkKeys.length` onward.
     *
     * `store.chunkKeys` grows only after a successful append, so it doubles as
     * the resume point. A run cancelled mid-flight leaves it pointing at the
     * last chunk actually in the store, and the next run picks up there.
     */
    async function appendRemainingChunks(store: ManifestStore) {
      const mod = getModuleSync();
      const chunks = manifest.chunks;
      const chunkKeys = arrowStreamChunkKeys(manifest);

      for (let i = store.chunkKeys.length; i < chunks.length; i++) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled) return;
        const bytes = await readChunkBytes(fetchChunkResult(chunks[i], i));
        if (cancelled) return;
        emitLoadMilestone(startedAt, {
          source: "arrow-stream-manifest",
          phase: "chunk-fetched",
          chunkIndex: i,
          chunkCount: chunks.length,
          byteLength: bytes.byteLength,
        });
        mod.append_arrow_stream_chunk(store.handle, bytes);
        store.chunkKeys.push(chunkKeys[i]);
        const refinedTableData = store.refreshColumnTypes(store.columnOverrides);
        if (refinedTableData) {
          store.tableData = refinedTableData;
          store.columns = refinedTableData.columns;
        }
        store.tableData.rowCount = mod.num_rows(store.handle);
        updateWasmSummaries(
          mod,
          store.handle,
          store.tableData,
          store.columns,
          store.pandasIndexCols,
        );
        if (refinedTableData) {
          engineRef.current?.replaceData(store.tableData, { streaming: true });
        } else {
          engineRef.current?.onBatchAppended();
        }
        emitLoadMilestone(startedAt, {
          source: "arrow-stream-manifest",
          phase: "chunk-appended",
          chunkIndex: i,
          chunkCount: chunks.length,
          rowCount: store.tableData.rowCount,
        });
      }

      if (cancelled || store.finished) return;
      if (manifest.complete !== false) {
        mod.finish_arrow_stream_store(store.handle);
        store.finished = true;
        const refinedTableData = store.refreshColumnTypes(store.columnOverrides);
        if (refinedTableData) {
          store.tableData = refinedTableData;
          store.columns = refinedTableData.columns;
          store.tableData.rowCount = mod.num_rows(store.handle);
          updateWasmSummaries(
            mod,
            store.handle,
            store.tableData,
            store.columns,
            store.pandasIndexCols,
          );
          engineRef.current?.replaceData(store.tableData, { streaming: false });
        } else {
          engineRef.current?.setStreamingDone();
        }
        syncStatusIndicator();
        emitLoadMilestone(startedAt, {
          source: "arrow-stream-manifest",
          phase: "streaming-complete",
          chunkCount: chunks.length,
          rowCount: store.tableData.rowCount,
        });
      }
    }

    async function loadFromManifest() {
      setStatus("loading");
      setError(null);
      setLoadFailure(null);

      const chunks = manifest.chunks;
      if (chunks.length === 0) {
        throw new Error("Arrow stream manifest has no chunks");
      }
      emitLoadMilestone(startedAt, {
        source: "arrow-stream-manifest",
        phase: "load-start",
        chunkCount: chunks.length,
      });

      await ensureModule();
      if (cancelled) return;
      emitLoadMilestone(startedAt, {
        source: "arrow-stream-manifest",
        phase: "wasm-ready",
        chunkCount: chunks.length,
      });

      const mod = getModuleSync();
      const handle = mod.create_arrow_stream_store();
      disposePendingStore = () => mod.free(handle);

      const firstBytes = await readChunkBytes(fetchChunkResult(chunks[0], 0));
      if (cancelled) return;
      emitLoadMilestone(startedAt, {
        source: "arrow-stream-manifest",
        phase: "first-chunk-fetched",
        chunkIndex: 0,
        chunkCount: chunks.length,
        byteLength: firstBytes.byteLength,
      });
      mod.append_arrow_stream_chunk(handle, firstBytes);
      emitLoadMilestone(startedAt, {
        source: "arrow-stream-manifest",
        phase: "first-chunk-appended",
        chunkIndex: 0,
        chunkCount: chunks.length,
        rowCount: mod.num_rows(handle),
      });

      const columnHints = mod.arrow_ipc_column_hints_with_row_count(
        firstBytes,
        mod.num_rows(handle),
      );
      const pandasIndexCols = pandasIndexColumnsFromHints(columnHints);
      const { tableData, columns, prefetchViewport, refreshColumnTypes } =
        createWasmTableData(handle);
      disposePendingStore = () => tableData.dispose?.();
      tableData.prefetchViewport = prefetchViewport;
      tableData.recomputeSummaries = () =>
        updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
      emitLoadMilestone(startedAt, {
        source: "arrow-stream-manifest",
        phase: "table-data-created",
        chunkCount: chunks.length,
        rowCount: tableData.rowCount,
      });

      applyParquetColumnHints(columns, columnHints);
      applyColumnOverrides(columns, columnOverrides);

      updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
      emitLoadMilestone(startedAt, {
        source: "arrow-stream-manifest",
        phase: "summaries-ready",
        chunkCount: chunks.length,
        rowCount: tableData.rowCount,
      });

      if (cancelled) return;
      mountEngine(tableData);
      emitLoadMilestone(startedAt, {
        source: "arrow-stream-manifest",
        phase: "engine-mounted",
        chunkCount: chunks.length,
        rowCount: tableData.rowCount,
      });
      setStatus("ready");

      // The store is mounted and owns its handle from here. Effect cleanup must
      // not free it, or a manifest update would tear down a live table.
      disposePendingStore = null;
      const store: ManifestStore = {
        identity: identity ?? "",
        handle,
        chunkKeys: arrowStreamChunkKeys(manifest).slice(0, 1),
        tableData,
        columns,
        refreshColumnTypes,
        pandasIndexCols,
        columnOverrides,
        finished: false,
      };
      storeRef.current = store;

      await appendRemainingChunks(store);
    }

    const existing = storeRef.current;
    // Column overrides are applied once, while the store is built. The append
    // path cannot re-apply them to a mounted engine, so a change to them has to
    // rebuild even when the manifest itself only grew.
    const canExtend =
      existing && existing.columnOverrides === columnOverrides && extendsStore(existing, manifest);
    const run = canExtend
      ? (() => {
          // A previous run may have failed a chunk fetch and left the error
          // showing. This attempt supersedes it; a fresh failure re-sets it.
          setError(null);
          setLoadFailure(null);
          setStatus("ready");
          return appendRemainingChunks(existing);
        })()
      : (() => {
          // Not disposed here. The engine keeps rendering from the superseded
          // store until the replacement mounts, and `replaceData` frees it at
          // the swap. Disposing now would free the handle mid-render.
          storeRef.current = null;
          return loadFromManifest();
        })();

    run.catch((err) => {
      // A store that failed before mounting has no owner: the engine never
      // took it and `replaceData` will never free it. Release it here instead
      // of holding the handle until the next effect run or unmount. Mounted
      // stores have already cleared this, so the append path is unaffected.
      disposePendingStore?.();
      disposePendingStore = null;
      if (!cancelled) reportLoadError(err);
    });

    return () => {
      cancelled = true;
      disposePendingStore?.();
      disposePendingStore = null;
    };
  }, [
    manifestKey,
    columnOverrides,
    stableOnChange,
    getFooterControlElement,
    getEngineElement,
    emitLoadMilestone,
    syncStatusIndicator,
    reportLoadError,
  ]);

  // Load from URL when `url` prop is provided.
  // Detects format via Content-Type header + magic byte fallback:
  // - Parquet: buffer the response, then stream row groups through the
  //   byte-range loader so the table mounts after the first group
  // - Arrow IPC: buffer and load whole
  useEffect(() => {
    if (!urlSource || !containerRef.current) return;

    // See the `data` effect: this source takes over the engine, so the
    // manifest store it supersedes must not stay reachable through the ref.
    storeRef.current = null;

    const sourceUrl = urlSource;
    const startedAt = performance.now();
    const controller = new AbortController();
    let cancelled = false;
    let disposePendingStore: (() => void) | null = null;
    /** Open Parquet footer; closed on cleanup once the engine owns the store. */
    let openFile: OpenParquetFile | null = null;
    let parquetMounted = false;

    function mountEngine(tableData: TableData | WindowedTableData, streaming?: boolean) {
      if (engineRef.current) {
        engineRef.current.replaceData(tableData, {
          streaming,
          footerControl: getFooterControlElement() ?? null,
        });
        disposePendingStore = null;
        return;
      }
      const engineDiv = getEngineElement();
      if (!engineDiv) return;
      engineRef.current = createTable(engineDiv, tableData, {
        onChange: stableOnChange,
        onScrollNearEnd: stableOnScrollNearEnd,
        onCommittedQueryChange: stableOnCommittedQueryChange,
        footerControl: getFooterControlElement(),
      });
      disposePendingStore = null;
    }

    async function loadParquet(parquetBytes: Uint8Array) {
      // The response is already buffered; the ranged loader still removes the
      // per-row-group file copy and shares its progressive mount, budget, and
      // preview footer with the byte-source path.
      const limits = resolveTableFileLimits({
        maxRows: urlMaxRows ?? URL_PARQUET_LIMITS.maxRows,
        maxColumns: urlMaxColumns,
        maxDecodedBytes: urlMaxDecodedBytes ?? URL_PARQUET_LIMITS.maxDecodedBytes,
      });
      const softBudget = validateAutoLoad(
        hasAutoLoad
          ? { rows: autoLoadRows, decodedBytes: autoLoadDecodedBytes, trigger: autoLoadTrigger }
          : undefined,
        urlOverflow,
      );
      const stream = streamParquetIntoEngine({
        source: byteSourceFromBytes(parquetBytes),
        limits,
        overflow: urlOverflow,
        autoLoad: softBudget,
        columnOverrides,
        windowed: windowedSource,
        signal: controller.signal,
        emit: (milestone) => emitLoadMilestone(startedAt, { ...milestone, source: "url" }),
        onOpen: (file) => {
          openFile = file;
          disposePendingStore = () => file.dispose();
        },
        mount: (tableData, streaming) => {
          mountEngine(tableData, streaming);
          parquetMounted = true;
          setStatus("ready");
        },
        engine: () => engineRef.current,
        onPause: (preview) => {
          if (cancelled) return;
          setParquetPreview({ source: sourceUrl, preview });
          setPausedLoad({ source: sourceUrl, resume: stream.resume, loading: false });
        },
      });
      if (autoLoadTrigger === "scroll") {
        onScrollNearEndRef.current = () => {
          if (cancelled || !stream.paused) return;
          stream.resume();
          setPausedLoad((current) => (current ? { ...current, loading: true } : current));
        };
      }
      try {
        const preview = await stream.done;
        if (!cancelled) setParquetPreview(preview ? { source: sourceUrl, preview } : null);
      } finally {
        if (!cancelled) setPausedLoad(null);
      }
    }

    async function loadArrowIpc(source: Response | ReadableStream<Uint8Array>) {
      await ensureModule();
      if (cancelled) return;
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "wasm-ready",
        format: "arrow-ipc",
      });

      const bytes =
        source instanceof Response
          ? new Uint8Array(await source.arrayBuffer())
          : await streamToBytes(source);
      if (cancelled) return;
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "arrow-bytes-ready",
        format: "arrow-ipc",
        byteLength: bytes.byteLength,
      });

      const handle = await loadIpc(bytes);
      if (cancelled) {
        getModuleSync().free(handle);
        return;
      }

      const mod = getModuleSync();
      const columnHints = mod.arrow_ipc_column_hints_with_row_count(bytes, mod.num_rows(handle));
      const pandasIndexCols = pandasIndexColumnsFromHints(columnHints);
      const { tableData, columns, prefetchViewport } = createWasmTableData(handle);
      disposePendingStore = () => tableData.dispose?.();
      tableData.prefetchViewport = prefetchViewport;
      tableData.recomputeSummaries = () =>
        updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "table-data-created",
        format: "arrow-ipc",
        rowCount: tableData.rowCount,
      });

      applyParquetColumnHints(columns, columnHints);
      applyColumnOverrides(columns, columnOverrides);

      updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "summaries-ready",
        format: "arrow-ipc",
        rowCount: tableData.rowCount,
      });

      if (cancelled) return;
      mountEngine(tableData);
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "engine-mounted",
        format: "arrow-ipc",
        rowCount: tableData.rowCount,
      });
      setStatus("ready");
      engineRef.current?.setStreamingDone();
    }

    async function streamToBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
      const reader = stream.getReader();
      const chunks: Uint8Array[] = [];
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
      const result = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      return result;
    }

    async function loadFromUrl() {
      setStatus("loading");
      setError(null);
      setLoadFailure(null);
      setParquetPreview(null);
      setPausedLoad(null);
      emitLoadMilestone(startedAt, { source: "url", phase: "load-start" });

      const response = await tableResponse(sourceUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }
      emitLoadMilestone(startedAt, { source: "url", phase: "fetch-complete" });

      const detected = await detectFormat(response);
      if (cancelled) return;
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "format-detected",
        format: detected.format,
        byteLength: detected.format === "parquet" ? detected.bytes.byteLength : undefined,
      });

      if (detected.format === "parquet") {
        await loadParquet(detected.bytes);
      } else {
        await loadArrowIpc(detected.stream);
      }
    }

    loadFromUrl()
      .catch((err) => {
        if (!cancelled) {
          disposePendingStore?.();
          disposePendingStore = null;
          // Rows already mounted stay; end the streaming state so the status
          // dot and cast guard do not wait for groups that will never come.
          if (parquetMounted) engineRef.current?.setStreamingDone();
          reportLoadError(err, parquetMounted);
        }
      })
      .finally(() => {
        // Footer metadata is not needed once the stream settled either way.
        openFile?.close();
        openFile = null;
      });

    return () => {
      cancelled = true;
      controller.abort();
      onScrollNearEndRef.current = null;
      disposePendingStore?.();
      disposePendingStore = null;
      openFile?.close();
      openFile = null;
    };
  }, [
    urlSource,
    urlMaxRows,
    urlMaxColumns,
    urlMaxDecodedBytes,
    urlOverflow,
    hasAutoLoad,
    autoLoadRows,
    autoLoadDecodedBytes,
    autoLoadTrigger,
    windowedSource,
    stableOnScrollNearEnd,
    typeOverrides,
    columnOverrides,
    stableOnChange,
    getFooterControlElement,
    getEngineElement,
    emitLoadMilestone,
    reportLoadError,
  ]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height: "100%", ...style }}
      aria-busy={status === "loading"}
    >
      {loadSource && status === "loading" && (
        <div className="sift-root sift-loading" role="status">
          Loading table…
        </div>
      )}
      {status === "error" && error && (
        <div className="sift-root sift-loading" role="alert">
          Error: {error}
        </div>
      )}
    </div>
  );
}

// --- Imperative handle for advanced use ---

export type SiftTableHandle = {
  engine: TableEngine | null;
  setFilter: (colIndex: number, filter: ColumnFilter) => void;
  clearAllFilters: () => void;
  getState: () => TableEngineState | null;
};

/**
 * Hook to get an imperative handle to the table engine.
 * Use with a ref: const handleRef = useSiftHandle()
 * Then pass handleRef to SiftTable (not yet wired — future forwardRef).
 */
export function useSiftEngine(engine: TableEngine | null): SiftTableHandle {
  return {
    engine,
    setFilter: (colIndex, filter) => engine?.setFilter(colIndex, filter),
    clearAllFilters: () => engine?.clearAllFilters(),
    getState: () => engine?.getState() ?? null,
  };
}

export type { ExplorerState, FilterPredicate, SortEntry } from "./filter-schema";
export {
  engineStateToExplorerState,
  explorerStateToJSON,
  predicateToEnglish,
  predicateToPandas,
  predicateToSQL,
} from "./filter-schema";
// Re-export key types and utilities for consumer convenience
export type {
  Column,
  ColumnFilter,
  ColumnType,
  ReplaceDataOptions,
  TableData,
  TableEngine,
  TableEngineState,
};
