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
  resolveTableFileLimits,
  type TableFileOptions,
  type TableLimitOverflow,
} from "./file-data";
import {
  type ByteSource,
  byteSourceFromBytes,
  type OpenParquetFile,
  openParquetFile,
  type ParquetFileLimits,
} from "./parquet-file";
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
import { tableResponse } from "./table-response";
import { updateWasmSummaries } from "./wasm-summaries";

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
  | { kind: "url"; url: string }
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
      limits?: Pick<TableFileOptions, "maxRows" | "maxColumns" | "maxDecodedBytes">;
      /**
       * What to do when the rows or decoded-bytes budget runs out. Default
       * `"error"`. With `"truncate"`, Sift shows the leading rows that fit
       * and notes the preview in its footer.
       */
      overflow?: TableLimitOverflow;
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

/** Largest limits the WASM API accepts (u32). Used where no cap is wanted. */
const UNBOUNDED_LIMITS: ParquetFileLimits = {
  maxRows: 0xffff_ffff,
  maxColumns: 0xffff_ffff,
  maxDecodedBytes: 0xffff_ffff,
};

type ProgressiveParquetArgs = {
  source: ByteSource;
  limits: ParquetFileLimits;
  overflow?: TableLimitOverflow;
  columnOverrides?: Record<string, Partial<Column>>;
  signal: AbortSignal;
  emit: (milestone: Omit<SiftLoadMilestone, "elapsedMs" | "source">) => void;
  /** Called once the file is open so cleanup can close or dispose it. */
  onOpen: (file: OpenParquetFile) => void;
  /**
   * Mount the first lease; later leases go through `engine().replaceData`.
   * `streaming` is true when more row groups follow.
   */
  mount: (tableData: TableData, streaming: boolean) => void;
  engine: () => TableEngine | null;
};

/** Rows a finished Parquet stream holds against the file's footer total. */
type ParquetPreview = { loadedRows: number; totalRows: number };

/**
 * Open a Parquet file by byte range, mount the table after the first row
 * group, then append the remaining groups one at a time, yielding to the
 * event loop between them. A truncating load stops at the row group that
 * spends the budget. Resolves when the store is complete, with the loaded
 * and total rows when the budget cut the file short and null otherwise.
 * Rejects with the loader error; an aborted signal rejects with its reason.
 */
async function streamParquetIntoEngine(
  args: ProgressiveParquetArgs,
): Promise<ParquetPreview | null> {
  const { source, limits, overflow, columnOverrides, signal, emit, onOpen, mount, engine } = args;
  const format = "parquet";
  const file = await openParquetFile(source, { limits, overflow, columnOverrides, signal });
  onOpen(file);
  emit({ phase: "wasm-ready", format, byteLength: source.byteLength });
  emit({
    phase: "table-data-created",
    format,
    rowCount: file.rowCount,
    chunkCount: file.rowGroupCount,
  });

  let exhausted = false;
  if (file.rowGroupCount > 0) {
    ({ exhausted } = await file.appendRowGroup(0));
    emit({ phase: "first-chunk-fetched", format, chunkIndex: 0, chunkCount: file.rowGroupCount });
  }
  emit({ phase: "summaries-ready", format, rowCount: file.tableData.rowCount });
  signal.throwIfAborted();
  mount(file.tableData, file.rowGroupCount > 1 && !exhausted);
  emit({ phase: "engine-mounted", format, rowCount: file.tableData.rowCount });

  for (let group = 1; group < file.rowGroupCount && !exhausted; group++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal.throwIfAborted();
    const appended = await file.appendRowGroup(group);
    const { replaced } = appended;
    exhausted = appended.exhausted;
    signal.throwIfAborted();
    if (replaced) {
      engine()?.replaceData(replaced, { streaming: true });
    } else {
      engine()?.onBatchAppended();
    }
    emit({
      phase: "chunk-appended",
      format,
      chunkIndex: group,
      chunkCount: file.rowGroupCount,
      rowCount: file.tableData.rowCount,
    });
  }

  signal.throwIfAborted();
  const { replaced } = file.finish();
  if (replaced) {
    engine()?.replaceData(replaced, { streaming: false });
  } else {
    engine()?.setStreamingDone();
  }
  emit({
    phase: "streaming-complete",
    format,
    rowCount: file.tableData.rowCount,
    totalRowCount: file.rowCount,
    truncated: file.truncated,
  });
  return file.truncated ? { loadedRows: file.loadedRows, totalRows: file.rowCount } : null;
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
  footerControl,
  className,
  style,
}: SiftTableProps) {
  const dataSource = source?.kind === "table-data" ? source.data : data;
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
  // Keyed by source so a preview never outlives the byte source that produced it.
  const [parquetPreview, setParquetPreview] = useState<{
    source: ByteSource;
    preview: ParquetPreview;
  } | null>(null);
  const currentParquetPreview =
    byteSource && parquetPreview?.source === byteSource ? parquetPreview.preview : null;
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
    (byteSource != null && byteSourceOverflow === "truncate");

  // Stable callback ref to avoid re-mounting engine when onChange identity changes
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onLoadMilestoneRef = useRef(onLoadMilestone);
  onLoadMilestoneRef.current = onLoadMilestone;
  const onLoadErrorRef = useRef(onLoadError);
  onLoadErrorRef.current = onLoadError;

  const stableOnChange = useCallback((state: TableEngineState) => {
    onChangeRef.current?.(state);
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
   * only once the engine has settled (`sift-status-ready`); while streaming,
   * the engine's own state is the truth.
   */
  const syncStatusIndicator = useCallback(() => {
    const indicator = engineDivRef.current?.querySelector<HTMLElement>(".sift-status-indicator");
    if (!indicator || !indicator.classList.contains("sift-status-ready")) return;
    const failure = loadFailureRef.current;
    if (failure) {
      indicator.classList.add("sift-status-stopped");
      indicator.textContent = "!";
      indicator.title = `Stopped loading: ${failure}`;
      return;
    }
    if (indicator.classList.contains("sift-status-stopped")) {
      indicator.classList.remove("sift-status-stopped");
      indicator.textContent = "✓";
    }
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
        {footerControl}
      </>,
    );
  }, [footerControl, getFooterControlElement, hasFooterControl, loadFailure, previewNotice]);

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
    emitLoadMilestone(startedAt, { source: "byte-source", phase: "load-start" });

    let limits: ParquetFileLimits;
    try {
      limits = resolveTableFileLimits({
        maxRows: byteSourceMaxRows,
        maxColumns: byteSourceMaxColumns,
        maxDecodedBytes: byteSourceMaxDecodedBytes,
      });
    } catch (cause) {
      reportLoadError(cause);
      return;
    }

    streamParquetIntoEngine({
      source: byteSource,
      limits,
      overflow: byteSourceOverflow,
      columnOverrides,
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
            footerControl: getFooterControlElement(),
          });
        }
        mounted = true;
        setStatus("ready");
      },
      engine: () => engineRef.current,
    }).then(
      (preview) => {
        if (!cancelled) setParquetPreview(preview ? { source: byteSource, preview } : null);
      },
      (cause: unknown) => {
        if (cancelled) return;
        if (openFile && !mounted) openFile.dispose();
        else openFile?.close();
        openFile = null;
        // A failure after mount leaves the rows already loaded in place. End the
        // streaming state so the status dot and cast guard do not wait forever.
        if (mounted) engineRef.current?.setStreamingDone();
        reportLoadError(cause, mounted);
      },
    );

    return () => {
      cancelled = true;
      controller.abort();
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
    columnOverrides,
    stableOnChange,
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

    function mountEngine(tableData: TableData, streaming?: boolean) {
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
        footerControl: getFooterControlElement(),
      });
      disposePendingStore = null;
    }

    async function loadParquet(parquetBytes: Uint8Array) {
      // The response is already buffered; the ranged loader still removes the
      // per-row-group file copy and shares its progressive mount with the
      // byte-source path. Hosted URLs carry no admission limits (the notebook
      // renderer has no way to raise them), so the loader gets the maxima.
      await streamParquetIntoEngine({
        source: byteSourceFromBytes(parquetBytes),
        limits: UNBOUNDED_LIMITS,
        columnOverrides,
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
      });
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
      disposePendingStore?.();
      disposePendingStore = null;
      openFile?.close();
      openFile = null;
    };
  }, [
    urlSource,
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
