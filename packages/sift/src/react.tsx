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
  type ReplaceDataOptions,
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

export type SiftLoadMilestone = {
  source: SiftSource["kind"];
  phase: string;
  elapsedMs: number;
  chunkIndex?: number;
  chunkCount?: number;
  rowCount?: number;
  byteLength?: number;
  format?: "arrow-ipc" | "parquet";
};

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
  /** Called as URL/manifest data loads, decodes, and mounts. Intended for host diagnostics. */
  onLoadMilestone?: (milestone: SiftLoadMilestone) => void;
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
  onLoadMilestone,
  footerControl,
  className,
  style,
}: SiftTableProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<TableEngine | null>(null);
  const engineDivRef = useRef<HTMLDivElement | null>(null);
  // Survives manifest updates so a growing manifest appends instead of rebuilding.
  const storeRef = useRef<ManifestStore | null>(null);
  const footerControlRef = useRef<HTMLDivElement | null>(null);
  const footerControlRootRef = useRef<Root | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const hasFooterControl = footerControl != null;

  // Stable callback ref to avoid re-mounting engine when onChange identity changes
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLoadMilestoneRef = useRef(onLoadMilestone);
  onLoadMilestoneRef.current = onLoadMilestone;

  const stableOnChange = useCallback((state: TableEngineState) => {
    onChangeRef.current?.(state);
  }, []);

  const emitLoadMilestone = useCallback(
    (startedAt: number, milestone: Omit<SiftLoadMilestone, "elapsedMs">) => {
      onLoadMilestoneRef.current?.({
        ...milestone,
        elapsedMs: Math.round(performance.now() - startedAt),
      });
    },
    [],
  );

  const getFooterControlElement = useCallback(() => {
    if (!hasFooterControl) return undefined;
    if (!footerControlRef.current) {
      footerControlRef.current = document.createElement("div");
      footerControlRootRef.current = createRoot(footerControlRef.current);
    }
    return footerControlRef.current;
  }, [hasFooterControl]);

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

  useEffect(() => {
    if (hasFooterControl) {
      getFooterControlElement();
    }
    footerControlRootRef.current?.render(footerControl);
  }, [footerControl, getFooterControlElement, hasFooterControl]);

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

  const dataSource = source?.kind === "table-data" ? source.data : data;
  const urlSource = source?.kind === "url" ? source.url : url;
  const manifestSource = source?.kind === "arrow-stream-manifest" ? source.manifest : undefined;
  const manifestKey = arrowStreamManifestKey(manifestSource);

  // Mount engine when `data` prop is provided directly
  useEffect(() => {
    if (!dataSource || !containerRef.current) return;
    const startedAt = performance.now();

    // This source now owns the engine. `replaceData` frees the manifest store
    // it supersedes, so the ref must not outlive it: a later manifest that
    // looked like an extension would otherwise append to a freed handle.
    storeRef.current = null;

    if (engineRef.current) {
      engineRef.current.replaceData(dataSource, { streaming: false });
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
        });
        disposePendingStore = null;
        return;
      }
      const engineDiv = getEngineElement();
      if (!engineDiv) return;
      engineRef.current = createTable(engineDiv, tableData, {
        onChange: stableOnChange,
        footerControl: getFooterControlElement(),
      });
      disposePendingStore = null;
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
    };
  }, [
    manifestKey,
    columnOverrides,
    stableOnChange,
    getFooterControlElement,
    getEngineElement,
    emitLoadMilestone,
  ]);

  // Load from URL when `url` prop is provided.
  // Detects format via Content-Type header + magic byte fallback:
  // - Parquet: buffer fully, load via WASM with progressive row groups
  // - Arrow IPC: stream batches (existing behavior)
  useEffect(() => {
    if (!urlSource || !containerRef.current) return;

    // See the `data` effect: this source takes over the engine, so the
    // manifest store it supersedes must not stay reachable through the ref.
    storeRef.current = null;

    const sourceUrl = urlSource;
    const startedAt = performance.now();
    let cancelled = false;
    let disposePendingStore: (() => void) | null = null;

    function mountEngine(tableData: TableData) {
      if (engineRef.current) {
        engineRef.current.replaceData(tableData);
        disposePendingStore = null;
        return;
      }
      const engineDiv = getEngineElement();
      if (!engineDiv) return;
      engineRef.current = createTable(engineDiv, tableData, {
        onChange: stableOnChange,
        footerControl: getFooterControlElement(),
      });
      disposePendingStore = null;
    }

    async function loadParquet(parquetBytes: Uint8Array) {
      await ensureModule();
      const mod = getModuleSync();
      if (cancelled) return;
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "wasm-ready",
        format: "parquet",
        byteLength: parquetBytes.byteLength,
      });

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
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "table-data-created",
        format: "parquet",
        rowCount: tableData.rowCount,
      });

      applyParquetColumnHints(columns, columnHints);
      applyColumnOverrides(columns, columnOverrides);

      updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "summaries-ready",
        format: "parquet",
        rowCount: tableData.rowCount,
      });

      if (cancelled) return;
      mountEngine(tableData);
      emitLoadMilestone(startedAt, {
        source: "url",
        phase: "engine-mounted",
        format: "parquet",
        rowCount: tableData.rowCount,
      });
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
      emitLoadMilestone(startedAt, { source: "url", phase: "load-start" });

      const response = await fetch(sourceUrl);
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
    };
  }, [
    urlSource,
    typeOverrides,
    columnOverrides,
    stableOnChange,
    getFooterControlElement,
    getEngineElement,
    emitLoadMilestone,
  ]);

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
export type {
  Column,
  ColumnFilter,
  ColumnType,
  ReplaceDataOptions,
  TableData,
  TableEngine,
  TableEngineState,
};
