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

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  applyColumnOverrides,
  applyParquetColumnHints,
  looksLikeIndexColumnName,
  pandasIndexColumnsFromHints,
} from "./parquet-features";
import { ensureModule, getModuleSync, loadIpc } from "./predicate";
import {
  type Column,
  type ColumnFilter,
  type ColumnType,
  createTable,
  type TableData,
  type TableEngine,
  type TableEngineState,
} from "./table";
import { createWasmTableData } from "./wasm-table-data";

// --- Props ---

export type ArrowStreamManifestChunk = {
  url: string;
  row_count?: number;
};

export type ArrowStreamManifest = {
  chunks: ArrowStreamManifestChunk[];
  complete?: boolean;
};

export type SiftSource =
  | { kind: "table-data"; data: TableData }
  | { kind: "url"; url: string }
  | { kind: "arrow-stream-manifest"; manifest: ArrowStreamManifest };

export type SiftTableProps = {
  /** Normalized table source. Prefer this for new source types. */
  source?: SiftSource;
  /** Pre-built TableData object. Mutually exclusive with `url`. */
  data?: TableData;
  /** URL to load data from (Arrow IPC or Parquet, auto-detected). Mutually exclusive with `data`. */
  url?: string;
  /** Column type overrides keyed by column name. */
  typeOverrides?: Record<string, ColumnType>;
  /** Column display overrides (label, width, sortable). */
  columnOverrides?: Record<string, Partial<Column>>;
  /** Called whenever sort or filter state changes from UI interaction. */
  onChange?: (state: TableEngineState) => void;
  /** Optional control rendered in Sift's footer before built-in buttons. */
  footerControl?: ReactNode;
  /** CSS class name for the container div. */
  className?: string;
  /** Inline styles for the container div. */
  style?: React.CSSProperties;
};

function arrowStreamManifestKey(manifest: ArrowStreamManifest | undefined): string | null {
  if (!manifest) return null;
  const complete = manifest.complete === false ? "open" : "complete";
  const chunks = manifest.chunks
    .map((chunk) => `${chunk.url}\u0001${chunk.row_count ?? ""}`)
    .join("\u0000");
  return `${complete}\u0002${chunks}`;
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

// --- WASM summary computation ---

function updateWasmSummaries(
  mod: ReturnType<typeof getModuleSync>,
  handle: number,
  tableData: TableData,
  columns: Column[],
  pandasIndexCols?: Set<string>,
) {
  const numRows = mod.num_rows(handle);
  const BIN_COUNT = 25;

  tableData.rowCount = numRows;
  tableData.columnSummaries = columns.map((col, c) => {
    switch (col.columnType) {
      // No header chart for image columns yet.
      case "image":
        return null;
      case "categorical": {
        const counts = mod.store_value_counts(handle, c) as {
          label: string;
          count: number;
        }[];
        const allCategories = counts.map(({ label, count }) => ({
          label,
          count,
          pct: Math.round((count / numRows) * 1000) / 10,
        }));
        const topCategories = allCategories.slice(0, 3);
        const othersCount = counts.slice(3).reduce((s, e) => s + e.count, 0);
        const othersPct = Math.round((othersCount / numRows) * 1000) / 10;
        const lengths = counts.map(({ label }) => label.length).sort((a, b) => a - b);
        const medianTextLength = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 0;
        return {
          kind: "categorical" as const,
          uniqueCount: counts.length,
          topCategories,
          othersCount,
          othersPct,
          allCategories,
          medianTextLength,
        };
      }
      case "boolean": {
        const [trueCount, falseCount, nullCount] = mod.store_bool_counts(handle, c);
        return {
          kind: "boolean" as const,
          trueCount,
          falseCount,
          nullCount,
          total: numRows,
        };
      }
      case "timestamp": {
        const bins = mod.store_temporal_histogram(handle, c) as {
          x0: number;
          x1: number;
          count: number;
        }[];
        if (bins.length === 0) return null;
        return {
          kind: "timestamp" as const,
          min: bins[0].x0,
          max: bins[bins.length - 1].x1,
          bins,
        };
      }
      case "numeric": {
        const bins = mod.store_histogram(handle, c, BIN_COUNT) as {
          x0: number;
          x1: number;
          count: number;
        }[];
        if (bins.length === 0) return null;
        // Parquet loads carry `pandasIndexCols` from the Rust hints; Arrow IPC
        // and other sources without footer metadata fall back to a name match.
        const isIndex = pandasIndexCols?.has(col.key) ?? looksLikeIndexColumnName(col.key);
        return {
          kind: "numeric" as const,
          min: bins[0].x0,
          max: bins[bins.length - 1].x1,
          bins,
          isIndex: isIndex ? true : undefined,
        };
      }
    }
  });
}

// --- Component ---

export function SiftTable({
  source,
  data,
  url,
  typeOverrides,
  columnOverrides,
  onChange,
  footerControl,
  className,
  style,
}: SiftTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TableEngine | null>(null);
  const footerControlRef = useRef<HTMLDivElement | null>(null);
  const footerControlRootRef = useRef<Root | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const hasFooterControl = footerControl != null;

  // Stable callback ref to avoid re-mounting engine when onChange identity changes
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const stableOnChange = useCallback((state: TableEngineState) => {
    onChangeRef.current?.(state);
  }, []);

  const getFooterControlElement = useCallback(() => {
    if (!hasFooterControl) return undefined;
    if (!footerControlRef.current) {
      footerControlRef.current = document.createElement("div");
      footerControlRootRef.current = createRoot(footerControlRef.current);
    }
    return footerControlRef.current;
  }, [hasFooterControl]);

  useEffect(() => {
    if (hasFooterControl) {
      getFooterControlElement();
    }
    footerControlRootRef.current?.render(footerControl);
  }, [footerControl, getFooterControlElement, hasFooterControl]);

  useEffect(() => {
    return () => {
      footerControlRootRef.current?.unmount();
      footerControlRootRef.current = null;
      footerControlRef.current = null;
    };
  }, []);

  const dataSource = source?.kind === "table-data" ? source.data : data;
  const urlSource = source?.kind === "url" ? source.url : url;
  const manifestSource = source?.kind === "arrow-stream-manifest" ? source.manifest : undefined;
  const manifestKey = arrowStreamManifestKey(manifestSource);

  // Mount engine when `data` prop is provided directly
  useEffect(() => {
    if (!dataSource || !containerRef.current) return;

    // Clean up previous engine
    if (engineRef.current) {
      engineRef.current.destroy();
      engineRef.current = null;
    }

    // Create a dedicated div for the engine so it doesn't conflict with React's DOM
    const engineDiv = document.createElement("div");
    engineDiv.style.height = "100%";
    containerRef.current.appendChild(engineDiv);

    engineRef.current = createTable(engineDiv, dataSource, {
      onChange: stableOnChange,
      footerControl: getFooterControlElement(),
    });
    setStatus("ready");

    return () => {
      engineRef.current?.destroy();
      engineRef.current = null;
      engineDiv.remove();
    };
  }, [dataSource, stableOnChange, getFooterControlElement]);

  // Load Arrow stream manifest chunks through the appendable WASM store.
  useEffect(() => {
    if (!manifestSource || !containerRef.current) return;

    const manifest = manifestSource;
    let cancelled = false;
    const container = containerRef.current;
    let engineDiv: HTMLDivElement | null = null;
    let disposePendingStore: (() => void) | null = null;

    function mountEngine(tableData: TableData) {
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
      engineDiv?.remove();
      engineDiv = document.createElement("div");
      engineDiv.style.height = "100%";
      container.appendChild(engineDiv);
      disposePendingStore = null;
      engineRef.current = createTable(engineDiv, tableData, {
        onChange: stableOnChange,
        footerControl: getFooterControlElement(),
      });
    }

    async function fetchChunkBytes(chunk: ArrowStreamManifestChunk, index: number) {
      if (!chunk.url) {
        throw new Error(`Arrow stream manifest chunk ${index} is missing a URL`);
      }
      const response = await fetch(chunk.url);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch Arrow stream chunk ${index}: ${response.status} ${response.statusText}`,
        );
      }
      return new Uint8Array(await response.arrayBuffer());
    }

    async function loadFromManifest() {
      setStatus("loading");
      setError(null);

      const chunks = manifest.chunks;
      if (chunks.length === 0) {
        throw new Error("Arrow stream manifest has no chunks");
      }

      await ensureModule();
      if (cancelled) return;

      const mod = getModuleSync();
      const handle = mod.create_arrow_stream_store();
      disposePendingStore = () => mod.free(handle);

      const firstBytes = await fetchChunkBytes(chunks[0], 0);
      if (cancelled) return;
      mod.append_arrow_stream_chunk(handle, firstBytes);

      const columnHints = mod.arrow_ipc_column_hints_with_row_count(
        firstBytes,
        mod.num_rows(handle),
      );
      const pandasIndexCols = pandasIndexColumnsFromHints(columnHints);
      const { tableData, columns, prefetchViewport } = createWasmTableData(handle);
      disposePendingStore = () => tableData.dispose?.();
      tableData.prefetchViewport = prefetchViewport;
      tableData.recomputeSummaries = () =>
        updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);

      applyParquetColumnHints(columns, columnHints);
      applyColumnOverrides(columns, columnOverrides);

      updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);

      if (cancelled) return;
      mountEngine(tableData);
      setStatus("ready");

      for (let i = 1; i < chunks.length; i++) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled) return;
        const bytes = await fetchChunkBytes(chunks[i], i);
        if (cancelled) return;
        mod.append_arrow_stream_chunk(handle, bytes);
        tableData.rowCount = mod.num_rows(handle);
        updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
        engineRef.current?.onBatchAppended();
      }

      if (manifest.complete !== false) {
        mod.finish_arrow_stream_store(handle);
        engineRef.current?.setStreamingDone();
      }
    }

    loadFromManifest().catch((err) => {
      if (!cancelled) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      }
    });

    return () => {
      cancelled = true;
      disposePendingStore?.();
      disposePendingStore = null;
      engineRef.current?.destroy();
      engineRef.current = null;
      engineDiv?.remove();
    };
  }, [manifestKey, columnOverrides, stableOnChange, getFooterControlElement]);

  // Load from URL when `url` prop is provided.
  // Detects format via Content-Type header + magic byte fallback:
  // - Parquet: buffer fully, load via WASM with progressive row groups
  // - Arrow IPC: stream batches (existing behavior)
  useEffect(() => {
    if (!urlSource || !containerRef.current) return;

    const sourceUrl = urlSource;
    let cancelled = false;
    const container = containerRef.current;
    let engineDiv: HTMLDivElement | null = null;
    let disposePendingStore: (() => void) | null = null;

    function mountEngine(tableData: TableData) {
      if (engineRef.current) {
        engineRef.current.destroy();
        engineRef.current = null;
      }
      engineDiv?.remove();
      engineDiv = document.createElement("div");
      engineDiv.style.height = "100%";
      container.appendChild(engineDiv);
      disposePendingStore = null;
      engineRef.current = createTable(engineDiv, tableData, {
        onChange: stableOnChange,
        footerControl: getFooterControlElement(),
      });
    }

    async function loadParquet(parquetBytes: Uint8Array) {
      await ensureModule();
      const mod = getModuleSync();
      if (cancelled) return;

      const meta = mod.parquet_metadata(parquetBytes);
      const numRowGroups = meta[0];

      if (numRowGroups === 0) {
        setError("Parquet file has no row groups.");
        setStatus("error");
        return;
      }

      const columnHints = mod.parquet_column_hints(parquetBytes);
      const pandasIndexCols = pandasIndexColumnsFromHints(columnHints);

      // Load first row group → mount table immediately
      const handle = mod.load_parquet_row_group(parquetBytes, 0, 0);
      disposePendingStore = () => mod.free(handle);

      const { tableData, columns, prefetchViewport } = createWasmTableData(handle);
      disposePendingStore = () => tableData.dispose?.();
      tableData.prefetchViewport = prefetchViewport;
      tableData.recomputeSummaries = () =>
        updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);

      applyParquetColumnHints(columns, columnHints);
      applyColumnOverrides(columns, columnOverrides);

      updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);

      if (cancelled) return;
      mountEngine(tableData);
      setStatus("ready");

      // Stream remaining row groups progressively
      for (let g = 1; g < numRowGroups; g++) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, 0));
        if (cancelled) return;
        mod.load_parquet_row_group(parquetBytes, g, handle);
        tableData.rowCount = mod.num_rows(handle);
        updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
        engineRef.current?.onBatchAppended();
      }

      engineRef.current?.setStreamingDone();
    }

    async function loadArrowIpc(source: Response | ReadableStream<Uint8Array>) {
      await ensureModule();
      if (cancelled) return;

      const bytes =
        source instanceof Response
          ? new Uint8Array(await source.arrayBuffer())
          : await streamToBytes(source);
      if (cancelled) return;

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

      applyParquetColumnHints(columns, columnHints);
      applyColumnOverrides(columns, columnOverrides);

      updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);

      if (cancelled) return;
      mountEngine(tableData);
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

      const response = await fetch(sourceUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch: ${response.status} ${response.statusText}`);
      }

      const detected = await detectFormat(response);
      if (cancelled) return;

      if (detected.format === "parquet") {
        await loadParquet(detected.bytes);
      } else {
        await loadArrowIpc(detected.stream);
      }
    }

    loadFromUrl().catch((err) => {
      if (!cancelled) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setStatus("error");
      }
    });

    return () => {
      cancelled = true;
      disposePendingStore?.();
      disposePendingStore = null;
      engineRef.current?.destroy();
      engineRef.current = null;
      engineDiv?.remove();
    };
  }, [urlSource, typeOverrides, columnOverrides, stableOnChange, getFooterControlElement]);

  return (
    <div ref={containerRef} className={className} style={{ height: "100%", ...style }}>
      {status === "error" && error && <div className="sift-loading">Error: {error}</div>}
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
export type { Column, ColumnFilter, ColumnType, TableData, TableEngine, TableEngineState };
