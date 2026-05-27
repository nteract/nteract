import { layout, type PreparedText, prepare } from "@chenglou/pretext";
import {
  animationFrameScheduler,
  distinctUntilChanged,
  interval,
  map,
  scan,
  throttleTime,
} from "rxjs";
import { fitColumnWidths } from "./auto-width";
import { type ColumnAction, mountColumnMenu, unmountColumnMenu } from "./column-menu";
import { renderColumnSummary, unmountColumnSummary } from "./sparkline";
// --- Types ---

export type ColumnType = "numeric" | "categorical" | "timestamp" | "boolean" | "image";

export type Column = {
  key: string;
  label: string;
  width: number;
  sortable: boolean;
  numeric: boolean;
  columnType: ColumnType;
  timezone?: string | null;
};

export type NumericColumnSummary = {
  kind: "numeric";
  min: number;
  max: number;
  bins: { x0: number; x1: number; count: number }[];
  /** Number of distinct finite values seen (capped at tracking limit). */
  uniqueCount?: number;
  /** True if this column looks like an index/ID (suppress histogram). */
  isIndex?: boolean;
  /** Number of null/undefined/NaN values. */
  nullCount?: number;
};

export type CategoryEntry = { label: string; count: number; pct: number };

export type CategoricalColumnSummary = {
  kind: "categorical";
  uniqueCount: number;
  topCategories: CategoryEntry[];
  othersCount: number;
  othersPct: number;
  /** All categories sorted by frequency (descending). Used by the filter popover. */
  allCategories: CategoryEntry[];
  /** Median string length across all unique values. Used for display heuristics. */
  medianTextLength: number;
};

export type BooleanColumnSummary = {
  kind: "boolean";
  trueCount: number;
  falseCount: number;
  nullCount: number;
  total: number;
};

export type TimestampColumnSummary = {
  kind: "timestamp";
  min: number;
  max: number;
  bins: { x0: number; x1: number; count: number }[];
  /** Number of null/undefined values. */
  nullCount?: number;
  timezone?: string | null;
};

export type ColumnSummary =
  | NumericColumnSummary
  | CategoricalColumnSummary
  | BooleanColumnSummary
  | TimestampColumnSummary
  | null;

export type TableData = {
  columns: Column[];
  rowCount: number;
  getCell: (row: number, col: number) => string;
  getCellRaw: (row: number, col: number) => unknown;
  columnSummaries: ColumnSummary[];
  /** Optional: prefetch visible rows in batch (WASM viewport optimization). */
  prefetchViewport?: (dataRowIndices: number[]) => void;
  /** Optional: cast a column to a different type (WASM type override). */
  castColumn?: (colIndex: number, targetType: ColumnType) => void;
  /** Optional: undo a column cast, restoring original type. Returns the original type. */
  undoCastColumn?: (colIndex: number) => ColumnType;
  /** Optional: check if a column has been cast (can be undone). */
  isColumnCast?: (colIndex: number) => boolean;
  /** Optional: recompute all column summaries (e.g. after a cast changes the data). */
  recomputeSummaries?: () => void;
  /** Optional: return sorted row indices for a column (WASM sort optimization). */
  sortColumn?: (colIndex: number, ascending: boolean) => Uint32Array;
  /** Optional: recompute filtered summaries in WASM (crossfilter fast path). */
  recomputeFilteredSummaries?: (mask: Uint8Array, filteredCount: number) => void;
  /** Optional: apply filters in WASM and return matching row indices. */
  filterRows?: (filters: (ColumnFilter | null)[]) => Uint32Array;
  /** Optional: release backing resources when the table engine is destroyed. */
  dispose?: () => void;
};

// --- Filter types ---

export type RangeFilter = { kind: "range"; min: number; max: number };
export type SetFilter = { kind: "set"; values: Set<string> };
export type NotInFilter = { kind: "not-in"; values: Set<string> };
export type BooleanFilter = { kind: "boolean"; value: boolean };
export type ColumnFilter = RangeFilter | SetFilter | NotInFilter | BooleanFilter | null;

export type TableEngineState = {
  sort: { column: string; direction: "asc" | "desc" } | null;
  filters: { column: string; filter: ColumnFilter }[];
  filteredCount: number;
  totalCount: number;
};

export type TableEngineOptions = {
  /** Called whenever sort or filter state changes from UI interaction. */
  onChange?: (state: TableEngineState) => void;
  /** Optional control rendered in the stats/footer bar before built-in buttons. */
  footerControl?: HTMLElement;
};

export type ReplaceDataOptions = {
  /** Drop sort state even when the sorted column survives in the new data. */
  resetSort?: boolean;
  /** Drop filters even when filtered columns survive in the new data. */
  resetFilters?: boolean;
};

export type TableEngine = {
  onBatchAppended(): void;
  /** Signal that all batches have been loaded and streaming is complete. */
  setStreamingDone(): void;
  replaceData(newData: TableData, options?: ReplaceDataOptions): void;
  destroy(): void;
  setFilter(colIndex: number, filter: ColumnFilter): void;
  clearFilter(colIndex: number): void;
  clearAllFilters(): void;
  /** Get current sort state. */
  getSort(): { column: string; direction: "asc" | "desc" } | null;
  /** Programmatically sort by column name and direction. Pass null to clear. */
  setSort(column: string, direction: "asc" | "desc"): void;
  /** Get current filter state for all columns. */
  getFilters(): { column: string; filter: ColumnFilter }[];
  /** Get the full explorer state (sort + filters + counts) in a serializable format. */
  getState(): TableEngineState;
  /**
   * Currently focused (expanded) data row, or `null` when every row uses the
   * collapsed text-line cap. Tracked by data row, so focus survives sort
   * changes; reset on filter changes since the focused row may filter out.
   */
  getFocusedDataRow(): number | null;
  /**
   * Programmatically focus a data row (expanding its text cells past the
   * collapsed cap). Pass `null` to collapse everything.
   */
  setFocusedDataRow(dataRow: number | null): void;
};

type SortState = { col: number; dir: "asc" | "desc" } | null;

// --- Constants ---

const FONT = '14px Inter, "Helvetica Neue", Helvetica, Arial, sans-serif';
const LINE_HEIGHT = 20;
const CELL_PAD_H = 24; // 12px each side
const CELL_PAD_V = 16; // 8px top + 8px bottom
const IMAGE_THUMB_MAX_HEIGHT = 64; // matches .sift-cell-image-thumb max-height in style.css
const IMAGE_THUMB_CAP = 6; // max thumbnails rendered per List<Image> cell; rest collapse to "+N"
// Text cells render at most this many lines unless their row is focused.
// Modeled after HuggingFace's dataset viewer: long markdown columns clamp by
// default and the user clicks a row to expand it inline.
const MAX_COLLAPSED_LINES = 3;
// Pixel slop for distinguishing "click on a row" (toggle focus) from
// "drag to select text" (no focus change). Matches the existing tap-vs-scroll
// thresholds for the mobile detail sheet.
const FOCUS_TOGGLE_MAX_DRAG_PX = 4;
const MIN_COL_WIDTH = 60;
const OVERSCAN = 40; // buffer rows above and below viewport
// Conservative fallback when the engine's max element height can't be
// measured (jsdom, SSR, pre-body). Below Chrome's known 16,777,214 (2^24 - 2)
// cap with headroom. The real cap is discovered per-engine at mount time.
const SCROLL_SPACER_CAP_FALLBACK_PX = 16_000_000;
// Safety margin subtracted from the measured cap so we never set
// scrollContent.style.height exactly at the boundary.
const SCROLL_SPACER_SAFETY_PX = 1024;
// Above this, assume we're in a no-layout environment (jsdom, headless test)
// where offsetHeight doesn't enforce a cap. Fall back to the conservative value.
const NO_LAYOUT_HEIGHT_THRESHOLD_PX = 64_000_000;

let cachedHeightCap: number | null = null;

/**
 * Binary-search the engine's max element height. Chrome (V8) caps near
 * 16,777,214 px (2^24 - 2); WKWebView near 33,181,580. The measured value
 * is cached for the lifetime of the page since the engine's cap doesn't
 * change at runtime.
 */
function measureMaxElementHeight(): number {
  if (cachedHeightCap !== null) return cachedHeightCap;
  if (typeof document === "undefined" || !document.body) {
    cachedHeightCap = SCROLL_SPACER_CAP_FALLBACK_PX;
    return cachedHeightCap;
  }
  const probe = document.createElement("div");
  probe.style.cssText = "width:1px; position:absolute; visibility:hidden; left:0; top:0;";
  document.body.appendChild(probe);
  let lo = 1;
  let hi = 200_000_000;
  for (let i = 0; i < 32 && hi - lo > 1; i++) {
    const mid = Math.floor((lo + hi) / 2);
    probe.style.height = mid + "px";
    if (probe.offsetHeight >= mid) lo = mid;
    else hi = mid;
  }
  document.body.removeChild(probe);
  if (lo > NO_LAYOUT_HEIGHT_THRESHOLD_PX) {
    cachedHeightCap = SCROLL_SPACER_CAP_FALLBACK_PX;
  } else {
    cachedHeightCap = Math.max(1_000_000, lo - SCROLL_SPACER_SAFETY_PX);
  }
  return cachedHeightCap;
}

// --- Table Engine ---

export function createTable(
  container: HTMLElement,
  initialData: TableData,
  options?: TableEngineOptions,
): TableEngine {
  let data = initialData;
  let columns = data.columns;

  // Mutable row count — grows as batches arrive
  let rowCount = data.rowCount;

  // Filter state — one per column, null = no filter
  let filters: ColumnFilter[] = columns.map(() => null);
  let filteredCount = rowCount;

  // Unfiltered summaries (saved so we can restore when filters are cleared)
  let unfilteredSummaries: ColumnSummary[] = [...data.columnSummaries];

  // Sort state
  let sortState: SortState = null;

  // Pinned columns + visual ordering
  const pinnedColumns = new Set<number>([0]); // first column pinned by default
  // Visual column order: pinned columns first, then the rest
  let visualOrder: number[] = computeVisualOrder();

  function computeVisualOrder(): number[] {
    const pinned = [...pinnedColumns].sort((a, b) => a - b);
    const unpinned = columns.map((_, i) => i).filter((i) => !pinnedColumns.has(i));
    return [...pinned, ...unpinned];
  }

  // viewIndices: sorted position → data row (filtered + sorted)
  let viewIndices: Int32Array;

  // Growable typed arrays with capacity doubling
  let capacity = Math.max(8192, rowCount);
  let rowHeights = new Float64Array(capacity);
  let rowPositions = new Float64Array(capacity + 1);
  viewIndices = new Int32Array(capacity);
  for (let i = 0; i < rowCount; i++) viewIndices[i] = i;

  let totalHeight = 0;
  let heightsDirty = true;

  // Scroll geometry. When totalHeight + headerH fits under SCROLL_SPACER_CAP_PX,
  // scrollScale stays 1 and behavior is identical to a plain virtual scroller.
  // When the virtual height exceeds the cap, the spacer is capped, scrollScale
  // > 1, and viewport.scrollTop must be multiplied by scrollScale to recover
  // the virtual offset that rowAtOffset() / rowPositions[] live in. Row
  // transforms subtract virtualOffset so visible rows sit at the right
  // viewport-relative Y as the user scrolls.
  let spacerHeight = 0;
  let scrollScale = 1;
  let virtualOffset = 0;

  function growBuffers(needed: number) {
    if (needed <= capacity) return;
    while (capacity < needed) capacity *= 2;
    const newHeights = new Float64Array(capacity);
    newHeights.set(rowHeights.subarray(0, rowCount));
    rowHeights = newHeights;
    const newPositions = new Float64Array(capacity + 1);
    newPositions.set(rowPositions.subarray(0, rowCount + 1));
    rowPositions = newPositions;
    const newSorted = new Int32Array(capacity);
    newSorted.set(viewIndices.subarray(0, rowCount));
    viewIndices = newSorted;
  }

  // Per-cell cache: prepared text + last laid-out width/height. `lastTruncated`
  // tracks whether the cell's natural height exceeded the collapsed cap so
  // renderCell can apply the soft fade affordance without re-running layout.
  type CellCache = {
    prepared: PreparedText;
    lastWidth: number;
    lastHeight: number;
    lastTruncated: boolean;
  };
  const cellCaches: (CellCache[] | null)[] = [];

  // Data row that the user clicked to expand. Tracked by data row (not view
  // row) so focus survives sort changes; reset explicitly on filter changes.
  // `null` means every row uses the collapsed cap.
  let focusedDataRow: number | null = null;

  function prepareCellRow(r: number): CellCache[] {
    const row = Array.from<CellCache>({ length: columns.length });
    for (let c = 0; c < columns.length; c++) {
      row[c] = {
        prepared: prepare(data.getCell(r, c), FONT),
        lastWidth: -1,
        lastHeight: 0,
        lastTruncated: false,
      };
    }
    return row;
  }

  // Cells are prepared lazily when they enter the viewport.
  // computeRowHeight() handles null caches with an estimated height.

  // Column widths — header-based floor, refined by sampled cell data
  const colWidths = columns.map((c) => c.width);
  fitColumnWidths(data, colWidths);

  // --- Compute heights ---

  function computeRowHeight(sortedRow: number): number {
    const dataRow = viewIndices[sortedRow];
    const cache = cellCaches[dataRow];
    if (!cache) return LINE_HEIGHT + CELL_PAD_V; // estimate for unprepared rows
    const isFocused = focusedDataRow === dataRow;
    const cap = MAX_COLLAPSED_LINES * LINE_HEIGHT;

    let maxH = LINE_HEIGHT;
    for (let c = 0; c < columns.length; c++) {
      const cell = cache[c];
      const cellW = Math.max(1, colWidths[c] - CELL_PAD_H);
      if (cell.lastWidth !== cellW) {
        const colType = columns[c].columnType;
        if (colType === "numeric" || colType === "timestamp" || colType === "boolean") {
          cell.lastHeight = LINE_HEIGHT;
          cell.lastTruncated = false;
        } else if (colType === "image") {
          // Mirrors the thumbnail max-height in style.css (.sift-cell-image-thumb).
          // Keep this in sync with that CSS value. Image rows don't expand
          // when focused — they're already terse and the row's text columns
          // are what the user wants to read.
          cell.lastHeight = IMAGE_THUMB_MAX_HEIGHT;
          cell.lastTruncated = false;
        } else {
          // Pretext returns lineCount alongside height in 0.0.6, so the
          // collapsed/expanded decision is free.
          const { height, lineCount } = layout(cell.prepared, cellW, LINE_HEIGHT);
          const overflows = lineCount > MAX_COLLAPSED_LINES;
          if (overflows && !isFocused) {
            cell.lastHeight = cap;
            cell.lastTruncated = true;
          } else {
            cell.lastHeight = height;
            cell.lastTruncated = false;
          }
        }
        cell.lastWidth = cellW;
      }
      if (cell.lastHeight > maxH) maxH = cell.lastHeight;
    }
    return maxH + CELL_PAD_V;
  }

  /// Force `computeRowHeight` to re-layout the given data row's text cells —
  /// width didn't change but the focus-state input did, so the cached height
  /// would otherwise lie. Numeric/boolean/image cells aren't affected, so
  /// invalidating only when text exists keeps the recompute cheap.
  function invalidateRowLayout(dataRow: number) {
    const cache = cellCaches[dataRow];
    if (!cache) return;
    for (let c = 0; c < columns.length; c++) {
      const colType = columns[c].columnType;
      if (
        colType !== "numeric" &&
        colType !== "timestamp" &&
        colType !== "boolean" &&
        colType !== "image"
      ) {
        cache[c].lastWidth = -1;
      }
    }
  }

  function recomputeAllHeights() {
    for (let i = 0; i < filteredCount; i++) {
      rowHeights[i] = computeRowHeight(i);
    }
    rebuildPositions();
    heightsDirty = false;
  }

  /// Toggle focus on a data row. Recomputes only the two affected rows'
  /// heights (the previously focused one collapsing, the new one expanding)
  /// then `rebuildPositions()` shifts everything below by the delta.
  /// Pass `null` to clear focus.
  function setFocusedDataRow(next: number | null) {
    if (next === focusedDataRow) return;
    const prev = focusedDataRow;
    focusedDataRow = next;
    if (prev !== null) invalidateRowLayout(prev);
    if (next !== null) invalidateRowLayout(next);
    // Recompute only the visible-or-affected rows. `rowHeights` is indexed by
    // sortedRow (view index), so we have to translate from dataRow → viewRow
    // via viewIndices. Cheap linear scan since viewIndices is filtered/sorted.
    for (let i = 0; i < filteredCount; i++) {
      const dr = viewIndices[i];
      if (dr === prev || dr === next) {
        rowHeights[i] = computeRowHeight(i);
      }
    }
    rebuildPositions();
    // Update DOM directly for any pooled row tied to the changed dataRows:
    // toggle the focused class and re-render cells so the truncation class
    // tracks the new state. The standard render loop's `if (existing)
    // continue` short-circuits class updates for rows that didn't get
    // reassigned, so we have to do it here.
    for (const pr of pool) {
      if (pr.assignedRow === -1) continue;
      const dataRow = viewIndices[pr.assignedRow];
      if (dataRow !== prev && dataRow !== next) continue;
      if (focusedDataRow !== null && dataRow === focusedDataRow) {
        pr.el.classList.add("sift-row-focused");
      } else {
        pr.el.classList.remove("sift-row-focused");
      }
      for (let c = 0; c < columns.length; c++) {
        // Image cells don't have a focus-dependent state — they're capped at
        // IMAGE_THUMB_MAX_HEIGHT and the row-height change is handled by CSS.
        // Calling renderCell here would revoke the existing blob URLs and
        // allocate fresh ones for the same bytes, forcing the browser to
        // re-decode every <img>. That's the visible flicker on row click.
        if (columns[c].columnType === "image") continue;
        renderCell(pr.cells[c], dataRow, c);
      }
    }
    scheduleRender();
  }

  function rebuildPositions() {
    rowPositions[0] = 0;
    for (let i = 0; i < filteredCount; i++) {
      rowPositions[i + 1] = rowPositions[i] + rowHeights[i];
    }
    totalHeight = rowPositions[filteredCount];
    recomputeScrollGeometry();
  }

  function recomputeScrollGeometry() {
    const headerH = headerEl.offsetHeight;
    const viewportH = viewport.clientHeight;
    const virtualTotal = totalHeight + headerH;
    const cap = measureMaxElementHeight();
    if (virtualTotal <= cap) {
      spacerHeight = virtualTotal;
      scrollScale = 1;
    } else {
      spacerHeight = cap;
      // Affine map: scrollTop ∈ [0, spacerHeight - viewportH] → virtual ∈ [0, virtualTotal - viewportH]
      const renderedRange = Math.max(1, spacerHeight - viewportH);
      const virtualRange = Math.max(1, virtualTotal - viewportH);
      scrollScale = virtualRange / renderedRange;
    }
    // Sole writer of scrollContent.style.height. Anyone who recomputes
    // geometry (rebuildPositions on filter / sort / row focus, the viewport
    // ResizeObserver, the window resize handler) gets a synced spacer for
    // free instead of each caller having to remember the DOM update.
    scrollContent.style.height = spacerHeight + "px";
    updateVirtualOffset();
  }

  function updateVirtualOffset() {
    virtualOffset = scrollScale === 1 ? 0 : viewport.scrollTop * (scrollScale - 1);
  }

  function rowAtOffset(offset: number): number {
    let lo = 0,
      hi = filteredCount;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (rowPositions[mid + 1] <= offset) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  type ScrollAnchor = {
    row: number;
    offset: number;
  };

  let pendingScrollAnchor: ScrollAnchor | null = null;

  function captureScrollAnchor(): ScrollAnchor | null {
    if (filteredCount === 0) return null;
    const headerH = headerEl.offsetHeight;
    const viewportRect = viewport.getBoundingClientRect();
    const anchorY = viewportRect.top + headerH;
    if (viewportRect.height > 0) {
      for (const pr of pool) {
        if (pr.assignedRow === -1) continue;
        const rowRect = pr.el.getBoundingClientRect();
        if (rowRect.height <= 0) continue;
        if (rowRect.top <= anchorY && rowRect.bottom > anchorY) {
          return {
            row: pr.assignedRow,
            offset: Math.max(0, anchorY - rowRect.top),
          };
        }
      }
    }

    const scrollTop = Math.max(0, viewport.scrollTop * scrollScale - headerH);
    const row = Math.min(rowAtOffset(scrollTop), filteredCount - 1);
    return {
      row,
      offset: Math.max(0, scrollTop - rowPositions[row]),
    };
  }

  function markHeightsDirty(preserveViewport = false) {
    if (preserveViewport && !pendingScrollAnchor) {
      pendingScrollAnchor = captureScrollAnchor();
    }
    heightsDirty = true;
  }

  function restoreScrollAnchor(headerH: number) {
    if (!pendingScrollAnchor) return;
    const anchor = pendingScrollAnchor;
    pendingScrollAnchor = null;
    if (filteredCount === 0) return;
    const row = Math.min(anchor.row, filteredCount - 1);
    const targetVirtual = headerH + rowPositions[row] + anchor.offset;
    const targetScroll = scrollScale === 1 ? targetVirtual : targetVirtual / scrollScale;
    const maxScrollTop = Math.max(0, spacerHeight - viewport.clientHeight);
    viewport.scrollTop = Math.min(maxScrollTop, targetScroll);
    updateVirtualOffset();
  }

  // --- Filter + Sort ---

  function rowPassesFilters(dataRow: number): boolean {
    for (let c = 0; c < columns.length; c++) {
      const f = filters[c];
      if (!f) continue;
      const raw = data.getCellRaw(dataRow, c);
      switch (f.kind) {
        case "range": {
          if (raw == null) return false;
          const v = Number(raw);
          if (!Number.isFinite(v)) return false;
          if (v < f.min || v > f.max) return false;
          break;
        }
        case "set": {
          const s = data.getCell(dataRow, c);
          if (!f.values.has(s)) return false;
          break;
        }
        case "not-in": {
          const s = data.getCell(dataRow, c);
          // Inverted: exclude row if value IS in the exclusion set
          if (f.values.has(s)) return false;
          break;
        }
        case "boolean": {
          if (Boolean(raw) !== f.value) return false;
          break;
        }
      }
    }
    return true;
  }

  function hasActiveFilters(): boolean {
    return filters.some((f) => f !== null);
  }

  function applyFilterAndSort() {
    // Step 1: filter
    const filtered: number[] = [];
    if (hasActiveFilters()) {
      if (data.filterRows) {
        // WASM fast path: apply all filters in Rust, no per-cell FFI
        const wasmResult = data.filterRows(filters);
        for (let i = 0; i < wasmResult.length; i++) filtered.push(wasmResult[i]);
      } else {
        for (let i = 0; i < rowCount; i++) {
          if (rowPassesFilters(i)) filtered.push(i);
        }
      }
    } else {
      for (let i = 0; i < rowCount; i++) filtered.push(i);
    }
    filteredCount = filtered.length;

    // Step 2: sort the filtered set
    if (sortState) {
      const { col, dir } = sortState;
      if (data.sortColumn) {
        // WASM fast path: get sorted indices for all rows, then intersect with filter
        const sortedAll = data.sortColumn(col, dir === "asc");
        if (hasActiveFilters()) {
          const filterSet = new Set(filtered);
          filtered.length = 0;
          for (let i = 0; i < sortedAll.length; i++) {
            if (filterSet.has(sortedAll[i])) filtered.push(sortedAll[i]);
          }
        } else {
          filtered.length = 0;
          for (let i = 0; i < sortedAll.length; i++) {
            filtered.push(sortedAll[i]);
          }
        }
      } else {
        // JS fallback: sort the filtered set with comparators
        const colType = columns[col].columnType;
        const isNumeric = colType === "numeric" || colType === "timestamp";
        filtered.sort((a, b) => {
          let cmp: number;
          if (isNumeric) {
            const rawA = data.getCellRaw(a, col);
            const rawB = data.getCellRaw(b, col);
            const va = rawA == null ? NaN : Number(rawA);
            const vb = rawB == null ? NaN : Number(rawB);
            const aOk = Number.isFinite(va) || va === Infinity || va === -Infinity;
            const bOk = Number.isFinite(vb) || vb === Infinity || vb === -Infinity;
            if (!aOk && !bOk) cmp = 0;
            else if (!aOk) return 1;
            else if (!bOk) return -1;
            else cmp = va - vb;
          } else if (colType === "boolean") {
            const rawA = data.getCellRaw(a, col);
            const rawB = data.getCellRaw(b, col);
            if (rawA == null && rawB == null) cmp = 0;
            else if (rawA == null) return 1;
            else if (rawB == null) return -1;
            else cmp = (rawA ? 1 : 0) - (rawB ? 1 : 0);
          } else {
            const rawA = data.getCellRaw(a, col);
            const rawB = data.getCellRaw(b, col);
            if (rawA == null && rawB == null) cmp = 0;
            else if (rawA == null) return 1;
            else if (rawB == null) return -1;
            else {
              const sa = data.getCell(a, col);
              const sb = data.getCell(b, col);
              cmp = sa < sb ? -1 : sa > sb ? 1 : 0;
            }
          }
          return dir === "asc" ? cmp : -cmp;
        });
      }
    }

    // Step 3: write to viewIndices
    if (filtered.length > capacity) growBuffers(filtered.length);
    for (let i = 0; i < filtered.length; i++) {
      viewIndices[i] = filtered[i];
    }

    heightsDirty = true;
  }

  // --- DOM ---

  container.innerHTML = "";
  container.classList.add("sift-table-container");
  container.setAttribute("role", "grid");
  container.setAttribute("aria-label", "Data table");
  container.setAttribute("aria-rowcount", String(rowCount));
  container.setAttribute("aria-colcount", String(columns.length));

  // Streaming state — progress bar is appended after stats bar below
  let streaming = true;
  const progressBar = document.createElement("div");
  progressBar.className = "sift-progress-bar";
  progressBar.innerHTML = '<div class="sift-progress-bar-fill"></div>';

  // Header — lives inside the scroll content so it scrolls
  // horizontally with the data. position: sticky keeps it at top.
  const headerEl = document.createElement("div");
  headerEl.className = "sift-header";

  const headerRowEl = document.createElement("div");
  headerRowEl.className = "sift-header-row";
  headerRowEl.setAttribute("role", "row");

  const summaryContainers: HTMLDivElement[] = [];
  const headerCells: HTMLDivElement[] = [];

  for (let c = 0; c < columns.length; c++) {
    const th = document.createElement("div");
    th.className = "sift-th";
    th.setAttribute("role", "columnheader");
    th.setAttribute("aria-colindex", String(c + 1));
    th.style.width = colWidths[c] + "px";
    th.dataset.col = String(c);

    const topRow = document.createElement("div");
    topRow.className = "sift-th-top";

    const label = document.createElement("span");
    label.className = "sift-th-label";
    label.textContent = columns[c].label;
    topRow.appendChild(label);

    if (columns[c].sortable) {
      const arrow = document.createElement("span");
      arrow.className = "sift-sort-arrow";
      arrow.textContent = "";
      topRow.appendChild(arrow);
      topRow.style.cursor = "pointer";
      topRow.addEventListener("click", () => onSortClick(c));
    }

    th.appendChild(topRow);

    // Type icon — hide for index columns (empty label = hidden index)
    if (columns[c].label) {
      const typeIcon = document.createElement("span");
      typeIcon.className = "sift-type-icon";
      typeIcon.textContent =
        columns[c].columnType === "numeric"
          ? "#"
          : columns[c].columnType === "boolean"
            ? "◉"
            : columns[c].columnType === "timestamp"
              ? "◷"
              : "Aa";
      typeIcon.title = columns[c].columnType;
      th.appendChild(typeIcon);
    }

    const summaryEl = document.createElement("div");
    summaryEl.className = "sift-th-summary";
    // Prevent clicks on summary charts (filter interactions) from triggering sort
    summaryEl.addEventListener("click", (e) => e.stopPropagation());
    th.appendChild(summaryEl);
    summaryContainers.push(summaryEl);

    // Keyboard shortcuts on column headers
    th.setAttribute("tabindex", "0");
    th.addEventListener("keydown", (e) => {
      if (e.key === "p" || e.key === "P") {
        e.preventDefault();
        const action: ColumnAction = pinnedColumns.has(c) ? { kind: "unpin" } : { kind: "pin" };
        handleColumnAction(c, action);
      } else if (e.key === "Enter" && columns[c].sortable) {
        e.preventDefault();
        onSortClick(c);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        const ths = Array.from(headerRowEl.children) as HTMLDivElement[];
        const curVi = ths.indexOf(th);
        if (curVi < ths.length - 1) (ths[curVi + 1] as HTMLElement).focus();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        const ths = Array.from(headerRowEl.children) as HTMLDivElement[];
        const curVi = ths.indexOf(th);
        if (curVi > 0) (ths[curVi - 1] as HTMLElement).focus();
      }
    });

    // Context menu: right-click (desktop) + long-press (mobile)
    function openColumnMenu(x: number, y: number) {
      mountColumnMenu(
        {
          colIndex: c,
          colName: columns[c].label,
          colType: columns[c].columnType,
          isPinned: pinnedColumns.has(c),
          isCast: data.isColumnCast ? data.isColumnCast(c) : false,
          isStreaming: streaming,
          sortDirection: sortState?.col === c ? sortState.dir : null,
          x,
          y,
        },
        handleColumnAction,
      );
    }

    th.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openColumnMenu(e.clientX, e.clientY);
    });

    // Long-press for touch devices (500ms threshold)
    let longPressTimer: ReturnType<typeof setTimeout> | null = null;
    th.addEventListener(
      "touchstart",
      (e) => {
        const touch = e.touches[0];
        const startX = touch.clientX;
        const startY = touch.clientY;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          openColumnMenu(startX, startY);
        }, 500);
      },
      { passive: true },
    );
    th.addEventListener(
      "touchmove",
      () => {
        if (longPressTimer) {
          clearTimeout(longPressTimer);
          longPressTimer = null;
        }
      },
      { passive: true },
    );
    th.addEventListener("touchend", () => {
      if (longPressTimer) {
        clearTimeout(longPressTimer);
        longPressTimer = null;
      }
    });

    const handle = document.createElement("div");
    handle.className = "sift-resize-handle";
    handle.addEventListener("pointerdown", (e) => onResizeStart(e, c));
    th.appendChild(handle);

    headerCells.push(th);
    headerRowEl.appendChild(th);
  }

  headerEl.appendChild(headerRowEl);
  // Header is appended to scroll content (not container) so it scrolls
  // horizontally with data. position: sticky; top: 0 keeps it visible.

  // Create stable filter callbacks per column
  const filterCallbacks: ((filter: ColumnFilter) => void)[] = columns.map(
    (_, c) => (filter: ColumnFilter) => setFilter(c, filter),
  );

  function renderSummary(c: number, visibleBins?: number[]) {
    const summary = data.columnSummaries[c];
    if (summary) {
      const unfiltered = hasActiveFilters() ? (unfilteredSummaries[c] ?? undefined) : undefined;
      renderColumnSummary(
        summaryContainers[c],
        summary,
        colWidths[c] - CELL_PAD_H,
        visibleBins,
        filters[c],
        filterCallbacks[c],
        unfiltered,
        data.columns[c].timezone,
      );
    }
  }

  function renderAllSummaries() {
    for (let c = 0; c < columns.length; c++) renderSummary(c);
  }
  renderAllSummaries();

  // Scroll viewport
  const viewport = document.createElement("div");
  viewport.className = "sift-viewport";

  const scrollContent = document.createElement("div");
  scrollContent.className = "sift-scroll-content";
  // Set min-width so horizontal scroll position is preserved when pool rows are hidden
  function updateScrollContentWidth() {
    const totalW = colWidths.reduce((s, w) => s + w, 0);
    scrollContent.style.minWidth = totalW + "px";
  }
  updateScrollContentWidth();

  const rowPool = document.createElement("div");
  rowPool.className = "sift-row-pool";

  scrollContent.appendChild(headerEl); // Header inside scroll content for natural H scroll
  scrollContent.appendChild(rowPool);

  // Empty state (shown when filters exclude all rows)
  const emptyEl = document.createElement("div");
  emptyEl.className = "sift-empty-state";
  emptyEl.style.display = "none";

  const emptyText = document.createElement("div");
  emptyText.className = "sift-empty-text";
  emptyText.textContent = "No matching rows";

  const emptyClearBtn = document.createElement("button");
  emptyClearBtn.className = "sift-empty-clear";
  emptyClearBtn.textContent = "Clear all filters";
  emptyClearBtn.addEventListener("click", () => clearAllFilters());

  emptyEl.appendChild(emptyText);
  emptyEl.appendChild(emptyClearBtn);

  // Empty state goes inside scroll content (after header, before row pool)
  scrollContent.appendChild(emptyEl);

  viewport.appendChild(scrollContent);
  container.appendChild(viewport);

  // Stats bar
  const statsEl = document.createElement("div");
  statsEl.className = "sift-stats";

  // ARIA live region for screen reader announcements (filter changes, streaming)
  const ariaLive = document.createElement("div");
  ariaLive.setAttribute("aria-live", "polite");
  ariaLive.setAttribute("role", "status");
  ariaLive.className = "sr-only";
  ariaLive.style.cssText =
    "position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)";
  container.appendChild(ariaLive);

  function makeStatSpan(className: string): HTMLSpanElement {
    const el = document.createElement("span");
    el.className = `sift-stat-value ${className}`;
    return el;
  }

  // Status indicator (streaming dot → checkmark)
  const statusIndicator = document.createElement("span");
  statusIndicator.className = "sift-status-indicator sift-status-streaming";
  statusIndicator.textContent = "●";
  statusIndicator.title = "Loading data…";

  const statRows = makeStatSpan("sift-stat-rows");
  // Debug stats (DOM rows, FPS) — hidden by default
  const debugGroup = document.createElement("span");
  debugGroup.className = "sift-debug-group";
  debugGroup.style.display = "none";
  const statDom = makeStatSpan("sift-stat-dom");
  const statFrame = makeStatSpan("sift-stat-frame");

  // Reusable odometer — rolling digit strips for any numeric display
  type OdometerSlot = {
    el: HTMLSpanElement;
    strip: HTMLSpanElement | null;
    current: string;
    pos: number;
  };

  function createOdometer(host: HTMLElement): {
    update: (text: string) => void;
  } {
    host.classList.add("sift-odometer");
    const slots: OdometerSlot[] = [];
    // Track the previous numeric value to determine roll direction
    let prevNumericValue = 0;

    // Strip layout: 9-0-1-2-3-4-5-6-7-8-9-0 (12 positions)
    // Canonical positions 1-10 map to digits 0-9
    // Position 0 = extra 9 (for wrapping down past 0)
    // Position 11 = extra 0 (for wrapping up past 9)
    const STRIP_DIGITS = [9, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0];

    function createDigitStrip(): HTMLSpanElement {
      const strip = document.createElement("span");
      strip.className = "sift-odo-strip";
      for (const d of STRIP_DIGITS) {
        const digit = document.createElement("span");
        digit.className = "sift-odo-num";
        digit.textContent = String(d);
        strip.appendChild(digit);
      }
      return strip;
    }

    // Canonical position for a digit (1-10)
    function canonicalPos(d: number): number {
      return d + 1;
    }

    function update(text: string) {
      // Extract numeric value from text to determine direction
      const numStr = text.replace(/[^0-9]/g, "");
      const numericValue = numStr ? parseInt(numStr) : 0;
      const increasing = numericValue >= prevNumericValue;
      prevNumericValue = numericValue;

      while (slots.length < text.length) {
        const el = document.createElement("span");
        el.className = "sift-odo-slot";
        host.appendChild(el);
        slots.push({ el, strip: null, current: "", pos: -1 });
      }
      while (slots.length > text.length) {
        const removed = slots.pop()!;
        host.removeChild(removed.el);
      }

      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const slot = slots[i];

        if (ch === slot.current) continue;

        const isDigit = ch >= "0" && ch <= "9";

        if (isDigit) {
          if (!slot.strip) {
            slot.el.textContent = "";
            slot.strip = createDigitStrip();
            slot.el.appendChild(slot.strip);
            slot.pos = -1;
          }
          const target = parseInt(ch);
          const prev = slot.current >= "0" && slot.current <= "9" ? parseInt(slot.current) : -1;

          let targetPos: number;
          if (prev === -1 || slot.pos === -1) {
            // First time — go directly to canonical position
            targetPos = canonicalPos(target);
          } else if (increasing && prev === 9 && target === 0) {
            // Wrapping up: 9→0, roll to position 11 (extra 0 at bottom)
            targetPos = 11;
          } else if (!increasing && prev === 0 && target === 9) {
            // Wrapping down: 0→9, roll to position 0 (extra 9 at top)
            targetPos = 0;
          } else {
            targetPos = canonicalPos(target);
          }

          slot.strip.style.transform = `translateY(${-targetPos * 1.2}em)`;
          slot.pos = targetPos;

          // After wrap transitions, snap back to canonical position
          if (targetPos === 0 || targetPos === 11) {
            const canonical = canonicalPos(target);
            const strip = slot.strip;
            const onEnd = () => {
              strip.removeEventListener("transitionend", onEnd);
              // Disable transition, snap, re-enable
              strip.style.transition = "none";
              strip.style.transform = `translateY(${-canonical * 1.2}em)`;
              slot.pos = canonical;
              // Force reflow then restore transition
              void strip.offsetHeight;
              strip.style.transition = "";
            };
            slot.strip.addEventListener("transitionend", onEnd);
          }
        } else {
          if (slot.strip) {
            slot.el.removeChild(slot.strip);
            slot.strip = null;
            slot.pos = -1;
          }
          slot.el.textContent = ch;
        }
        slot.current = ch;
      }
      // Expose visible text for testing (textContent includes hidden strip digits)
      host.dataset.value = text;
    }

    return { update };
  }

  const rowsOdometer = createOdometer(statRows);

  function updateRowCountDisplay() {
    if (hasActiveFilters()) {
      rowsOdometer.update(`${filteredCount.toLocaleString()} of ${rowCount.toLocaleString()} rows`);
    } else {
      rowsOdometer.update(`${rowCount.toLocaleString()} rows`);
    }
    // Keep ARIA row count in sync
    container.setAttribute("aria-rowcount", String(filteredCount + 1)); // +1 for header row
  }
  updateRowCountDisplay();

  // Fullscreen toggle — only shown if the Fullscreen API is available AND
  // permitted in the current context (not the case in some embeddings like
  // MCP App iframes without the right Permissions Policy).
  const fullscreenSupported =
    (document.fullscreenEnabled ?? (document as any).webkitFullscreenEnabled ?? false) &&
    !!(container.requestFullscreen ?? (container as any).webkitRequestFullscreen);
  const fullscreenBtn = document.createElement("button");
  fullscreenBtn.className = "sift-fullscreen-btn";
  fullscreenBtn.title = "Toggle fullscreen";
  fullscreenBtn.textContent = "⛶";
  if (!fullscreenSupported) {
    fullscreenBtn.style.display = "none";
  }
  fullscreenBtn.addEventListener("click", () => {
    const fsElement =
      document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
    if (fsElement === container) {
      (document.exitFullscreen ?? (document as any).webkitExitFullscreen)?.call(document);
    } else {
      (container.requestFullscreen ?? (container as any).webkitRequestFullscreen)?.call(container);
    }
  });

  // Update button label on fullscreen change
  function onFullscreenChange() {
    const fsElement =
      document.fullscreenElement ?? (document as any).webkitFullscreenElement ?? null;
    const isFS = fsElement === container;
    fullscreenBtn.textContent = isFS ? "⛶" : "⛶";
    fullscreenBtn.title = isFS ? "Exit fullscreen" : "Toggle fullscreen";
    // Trigger re-render since dimensions changed
    heightsDirty = true;
    scheduleRender();
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  const filterPillsEl = document.createElement("div");
  filterPillsEl.className = "sift-filter-pills";

  const statsSpacer = document.createElement("div");
  statsSpacer.style.flex = "1";

  // Debug toggle button
  const debugBtn = document.createElement("button");
  debugBtn.className = "sift-debug-btn";
  debugBtn.title = "Toggle debug stats";
  debugBtn.textContent = "⚙";
  debugBtn.addEventListener("click", () => {
    const visible = debugGroup.style.display !== "none";
    debugGroup.style.display = visible ? "none" : "";
    debugBtn.classList.toggle("sift-debug-active", !visible);
  });

  debugGroup.append(sep(), statDom, sep(), statFrame);
  statsEl.append(
    statusIndicator,
    statRows,
    debugGroup,
    filterPillsEl,
    statsSpacer,
    ...(options?.footerControl ? [options.footerControl] : []),
    debugBtn,
    fullscreenBtn,
  );
  container.appendChild(statsEl);

  // Streaming progress bar — at the bottom of the table, below the stats bar
  container.appendChild(progressBar);

  // Expand columns to fill container width when there are few columns
  {
    const containerW = viewport.clientWidth;
    const totalW = colWidths.reduce((s, w) => s + w, 0);
    if (containerW > 0 && totalW < containerW) {
      const scale = containerW / totalW;
      for (let c = 0; c < columns.length; c++) {
        colWidths[c] = Math.round(colWidths[c] * scale);
        headerCells[c].style.width = colWidths[c] + "px";
      }
      updateScrollContentWidth();
      heightsDirty = true;
    }
  }

  // Grow the last column to fill leftover viewport space. Active until the
  // user resizes the last column explicitly. Re-runs on viewport resize and
  // after non-last column resizes, so maximize/restore just works.
  let lastColumnAutoFill = true;
  const lastColumnAutoFillMinWidth = colWidths[columns.length - 1] ?? MIN_COL_WIDTH;

  function fitLastColumnToViewport(
    preserveViewport = false,
    updateHeights = true,
    schedule = true,
    updateSummary = true,
  ) {
    if (!lastColumnAutoFill) return;
    const last = columns.length - 1;
    if (last < 0) return;
    const viewportW = viewport.clientWidth;
    if (viewportW <= 0) return;
    let fixedW = 0;
    for (let c = 0; c < last; c++) fixedW += colWidths[c];
    const target = Math.max(lastColumnAutoFillMinWidth, viewportW - fixedW);
    if (target === colWidths[last]) return;
    colWidths[last] = target;
    headerCells[last].style.width = target + "px";
    if (updateSummary) renderSummary(last);
    updateScrollContentWidth();
    if (updateHeights) markHeightsDirty(preserveViewport);
    if (schedule) scheduleRender();
  }

  function rebuildFilterPills() {
    filterPillsEl.innerHTML = "";
    for (let c = 0; c < columns.length; c++) {
      const f = filters[c];
      if (!f) continue;
      const pill = document.createElement("span");
      pill.className = "sift-filter-pill";

      let text = columns[c].label + ": ";
      switch (f.kind) {
        case "range": {
          const colType = columns[c].columnType;
          const tz = columns[c].timezone ?? "UTC";
          if (f.min === f.max) {
            if (colType === "timestamp") {
              text += new Date(f.min).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "2-digit",
                timeZone: tz,
              });
            } else {
              text += f.min.toLocaleString(undefined, {
                maximumFractionDigits: 1,
              });
            }
          } else if (colType === "timestamp") {
            const fmt = (v: number) =>
              new Date(v).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
                year: "2-digit",
                timeZone: tz,
              });
            text += `${fmt(f.min)} – ${fmt(f.max)}`;
          } else {
            const minStr = f.min.toLocaleString(undefined, {
              maximumFractionDigits: 1,
            });
            const maxStr = f.max.toLocaleString(undefined, {
              maximumFractionDigits: 1,
            });
            text += minStr === maxStr ? minStr : `${minStr} – ${maxStr}`;
          }
          break;
        }
        case "set":
          text += [...f.values].map((v) => (v.length > 12 ? v.slice(0, 11) + "…" : v)).join(", ");
          break;
        case "boolean":
          text += f.value ? "Yes" : "No";
          break;
      }

      const label = document.createElement("span");
      label.textContent = text;

      const closeBtn = document.createElement("button");
      closeBtn.className = "sift-filter-pill-x";
      closeBtn.textContent = "×";
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        clearFilter(c);
      });

      pill.append(label, closeBtn);
      filterPillsEl.appendChild(pill);
    }
  }

  function sep(): HTMLSpanElement {
    const s = document.createElement("span");
    s.className = "sift-stat-sep";
    s.textContent = " · ";
    return s;
  }

  let prevDom = "";

  // RxJS FPS: frame counter on animationFrameScheduler
  const fpsOdometer = createOdometer(statFrame);

  const fps$ = interval(0, animationFrameScheduler).pipe(
    scan<number, { prevTime: number; deltas: number[] }>(
      (state, _) => {
        const now = performance.now();
        if (state.prevTime > 0) {
          const delta = now - state.prevTime;
          const deltas = [...state.deltas, delta].slice(-30);
          return { prevTime: now, deltas };
        }
        return { prevTime: now, deltas: [] };
      },
      { prevTime: 0, deltas: [] },
    ),
    map(({ deltas }) => {
      if (deltas.length === 0) return "–";
      const avg = deltas.reduce((a, b) => a + b, 0) / deltas.length;
      const raw = 1000 / avg;
      // Stabilize: round to nearest 5 above 60fps to avoid jitter
      const fps = raw >= 60 ? Math.round(raw / 5) * 5 : Math.round(raw);
      return String(fps);
    }),
  );
  const fpsSub = fps$
    .pipe(
      map((fpsStr) => `${fpsStr} fps`),
      distinctUntilChanged(),
      throttleTime(400, animationFrameScheduler, { trailing: true }),
    )
    .subscribe((text) => {
      fpsOdometer.update(text);
    });

  function updateStat(el: HTMLSpanElement, value: string, prev: string): string {
    if (value !== prev) {
      el.textContent = value;
      el.classList.remove("sift-stat-flash");
      void el.offsetWidth;
      el.classList.add("sift-stat-flash");
    }
    return value;
  }

  // --- Visible range overlay for header sparklines ---

  let lastVisFirst = -1;
  let lastVisLast = -1;

  function updateVisibleOverlays(visFirst: number, visLast: number) {
    for (let c = 0; c < columns.length; c++) {
      const summary = data.columnSummaries[c];
      if (!summary || (summary.kind !== "numeric" && summary.kind !== "timestamp")) continue;

      const bins = summary.bins;
      const visibleBins = Array.from<number>({ length: bins.length }).fill(0);
      const binWidth = (summary.max - summary.min) / bins.length || 1;

      for (let r = visFirst; r <= visLast; r++) {
        const dataRow = viewIndices[r];
        const raw = data.getCellRaw(dataRow, c);
        if (raw == null) continue;
        const v = Number(raw);
        if (!Number.isFinite(v)) continue;
        let idx = Math.floor((v - summary.min) / binWidth);
        if (idx >= bins.length) idx = bins.length - 1;
        if (idx < 0) idx = 0;
        visibleBins[idx]++;
      }

      renderSummary(c, visibleBins);
    }
  }

  // --- Row pool ---

  type PooledRow = {
    el: HTMLDivElement;
    cells: HTMLDivElement[];
    assignedRow: number;
    assignedDataRow: number;
  };

  const pool: PooledRow[] = [];

  function releasePooledRow(pr: PooledRow) {
    pr.assignedRow = -1;
    pr.assignedDataRow = -1;
    pr.el.style.display = "none";
  }

  function getPooledRow(): PooledRow {
    for (const pr of pool) {
      if (pr.assignedRow === -1) return pr;
    }
    const el = document.createElement("div");
    el.className = "sift-row";
    el.setAttribute("role", "row");
    const cells: HTMLDivElement[] = [];
    // Create cells in data order (cells[c] = column c)
    for (let c = 0; c < columns.length; c++) {
      const cell = document.createElement("div");
      cell.className = "sift-cell";
      cell.setAttribute("role", "gridcell");
      cell.setAttribute("aria-colindex", String(c + 1));
      cell.style.width = colWidths[c] + "px";
      cells.push(cell);
    }
    // Append in visual order
    for (const c of visualOrder) {
      el.appendChild(cells[c]);
    }
    rowPool.appendChild(el);
    const pr: PooledRow = { el, cells, assignedRow: -1, assignedDataRow: -1 };
    pool.push(pr);
    return pr;
  }

  // --- Cell rendering (type-aware) ---

  /**
   * Sniff a known image MIME type from the first few bytes. We only render
   * formats a browser can decode natively in <img>; unknown shapes degrade
   * to a byte-count placeholder so we don't ship garbage to the decoder.
   */
  function sniffImageMime(bytes: Uint8Array): string | null {
    if (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47
    ) {
      return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes.length >= 6 &&
      bytes[0] === 0x47 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x38
    ) {
      return "image/gif";
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return "image/webp";
    }
    return null;
  }

  function getImageChunks(raw: unknown): Uint8Array[] {
    return Array.isArray(raw) ? (raw as Uint8Array[]) : raw instanceof Uint8Array ? [raw] : [];
  }

  function createImageObjectUrl(bytes: Uint8Array, mime: string): string {
    // `bytes.buffer` is typed `ArrayBufferLike` (could be SharedArrayBuffer)
    // in lib.dom.d.ts; `slice()` returns a fresh ArrayBuffer-backed view.
    return URL.createObjectURL(
      new Blob([bytes.slice() as Uint8Array<ArrayBuffer>], { type: mime }),
    );
  }

  /**
   * Revoke any blob URLs attached to <img> children of `cellEl`. Called
   * before clearing the cell on rerender so the virtual scroll recycler
   * doesn't leak object URLs as it shuffles rows.
   */
  function revokeCellBlobUrls(cellEl: HTMLElement) {
    const imgs = cellEl.querySelectorAll<HTMLImageElement>("img[data-sift-blob-url]");
    for (const img of imgs) {
      const url = img.dataset.siftBlobUrl;
      if (url) URL.revokeObjectURL(url);
    }
  }

  function renderCell(cellEl: HTMLDivElement, dataRow: number, colIndex: number) {
    const col = columns[colIndex];
    const raw = data.getCellRaw(dataRow, colIndex);
    const str = data.getCell(dataRow, colIndex);

    // Revoke any blob URL previously rendered into this cell before we
    // wipe the children — virtual scroll recycles cells, so leftover URLs
    // would leak unless we revoke at the same moment we drop the <img>.
    revokeCellBlobUrls(cellEl);
    // Clear previous content
    cellEl.textContent = "";
    cellEl.className = "sift-cell";
    // Apply the soft-fade affordance when this text cell's natural height
    // exceeded the collapsed cap. `computeRowHeight` writes `lastTruncated`
    // alongside `lastHeight` so we don't have to re-run pretext here.
    const cellCache = cellCaches[dataRow]?.[colIndex];
    if (cellCache?.lastTruncated) {
      cellEl.classList.add("sift-cell-truncated");
    }

    // Null values get a distinct badge regardless of column type
    if (raw == null) {
      const badge = document.createElement("span");
      badge.className = "sift-badge sift-badge-null";
      badge.textContent = "null";
      cellEl.appendChild(badge);
      return;
    }

    switch (col.columnType) {
      case "boolean": {
        const badge = document.createElement("span");
        badge.className = raw ? "sift-badge sift-badge-true" : "sift-badge sift-badge-false";
        badge.textContent = raw ? "Yes" : "No";
        cellEl.appendChild(badge);
        break;
      }
      case "timestamp": {
        cellEl.textContent = str;
        cellEl.classList.add("sift-cell-timestamp");
        break;
      }
      case "image": {
        // wasm-table-data normalizes both HF `Image` and `List<Image>` to
        // an array of byte chunks; HF `Image` is just an array of length 1.
        const chunks = getImageChunks(raw);
        if (chunks.length === 0) {
          cellEl.textContent = str;
          break;
        }
        cellEl.classList.add("sift-cell-image");
        const visible = chunks.slice(0, IMAGE_THUMB_CAP);
        for (let imageIndex = 0; imageIndex < visible.length; imageIndex++) {
          const bytes = visible[imageIndex];
          const mime = sniffImageMime(bytes);
          if (!mime) {
            // Unknown payload — keep the strip dense; show a small marker
            // so a malformed item doesn't push the rest off the row.
            const span = document.createElement("span");
            span.className = "sift-cell-image-fallback";
            span.textContent = `${bytes.length}b`;
            cellEl.appendChild(span);
            continue;
          }
          const button = document.createElement("button");
          button.type = "button";
          button.className = "sift-cell-image-thumb-button";
          button.dataset.siftImageIndex = String(imageIndex);
          button.setAttribute("aria-label", "Open image");
          const img = document.createElement("img");
          img.className = "sift-cell-image-thumb";
          img.alt = "";
          img.decoding = "async";
          img.loading = "lazy";
          const url = createImageObjectUrl(bytes, mime);
          img.src = url;
          img.dataset.siftBlobUrl = url;
          button.appendChild(img);
          cellEl.appendChild(button);
        }
        if (chunks.length > IMAGE_THUMB_CAP) {
          const more = document.createElement("span");
          more.className = "sift-cell-image-more";
          more.textContent = `+${chunks.length - IMAGE_THUMB_CAP}`;
          cellEl.appendChild(more);
        }
        break;
      }
      default:
        if (col.columnType === "numeric") {
          cellEl.classList.add("sift-cell-numeric");
        }
        if (
          Array.isArray(raw) &&
          raw.length > 0 &&
          raw.every((item) => !Array.isArray(item) && (typeof item !== "object" || item === null))
        ) {
          cellEl.classList.add("sift-cell-list");
          for (const item of raw) {
            const badge = document.createElement("span");
            badge.className = "sift-badge sift-badge-list-item";
            badge.textContent = item == null ? "null" : String(item);
            cellEl.appendChild(badge);
          }
        } else {
          cellEl.textContent = str;
        }
    }
  }

  type ActiveImageViewer = {
    backdrop: HTMLDivElement;
    dialog: HTMLDivElement;
    objectUrl: string;
  };

  let activeImageViewer: ActiveImageViewer | null = null;

  function dismissImageViewer() {
    if (!activeImageViewer) return;
    URL.revokeObjectURL(activeImageViewer.objectUrl);
    activeImageViewer.backdrop.remove();
    activeImageViewer.dialog.remove();
    activeImageViewer = null;
    window.removeEventListener("keydown", onImageViewerKeyDown);
  }

  function onImageViewerKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      dismissImageViewer();
    }
  }

  function showImageViewer(dataRow: number, colIndex: number, imageIndex: number) {
    const chunks = getImageChunks(data.getCellRaw(dataRow, colIndex));
    const bytes = chunks[imageIndex];
    if (!bytes) return;
    const mime = sniffImageMime(bytes);
    if (!mime) return;

    dismissImageViewer();

    const objectUrl = createImageObjectUrl(bytes, mime);
    const backdrop = document.createElement("div");
    backdrop.className = "sift-image-viewer-backdrop";
    backdrop.addEventListener("click", dismissImageViewer);

    const dialog = document.createElement("div");
    dialog.className = "sift-image-viewer";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", `${columns[colIndex]?.label ?? "Image"} viewer`);
    dialog.tabIndex = -1;

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "sift-image-viewer-close";
    closeBtn.setAttribute("aria-label", "Close image viewer");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", dismissImageViewer);

    const img = document.createElement("img");
    img.className = "sift-image-viewer-img";
    img.alt = "";
    img.decoding = "async";
    img.src = objectUrl;

    dialog.appendChild(closeBtn);
    dialog.appendChild(img);
    document.body.appendChild(backdrop);
    document.body.appendChild(dialog);
    activeImageViewer = { backdrop, dialog, objectUrl };
    window.addEventListener("keydown", onImageViewerKeyDown);
    dialog.focus({ preventScroll: true });
  }

  // --- Render loop ---

  let lastScrollTop = -1;
  let lastViewportHeight = -1;
  let scheduledRaf: number | null = null;

  function scheduleRender() {
    if (scheduledRaf !== null) return;
    scheduledRaf = requestAnimationFrame(() => {
      scheduledRaf = null;
      render();
    });
  }

  function renderImmediately() {
    if (scheduledRaf !== null) {
      cancelAnimationFrame(scheduledRaf);
      scheduledRaf = null;
    }
    render();
  }

  function updateMountedColumnWidth(colIndex: number) {
    for (const pr of pool) {
      if (pr.assignedRow === -1) continue;
      pr.cells[colIndex].style.width = colWidths[colIndex] + "px";
      applyCellPinStyle(pr.cells[colIndex], colIndex);
    }
  }

  function render() {
    if (heightsDirty) {
      recomputeAllHeights();
      // Account for header height — row pool is absolute inside scroll-content
      const headerH = headerEl.offsetHeight;
      rowPool.style.top = headerH + "px";
      restoreScrollAnchor(headerH);
    }

    if (filteredCount === 0) {
      emptyEl.style.display = "";
      rowPool.style.display = "none";
      return;
    }
    emptyEl.style.display = "none";
    rowPool.style.display = "";

    const headerH = headerEl.offsetHeight;
    // Always keep the row pool below the sticky header
    rowPool.style.top = headerH + "px";
    const scrollTop = Math.max(0, viewport.scrollTop * scrollScale - headerH);
    const viewportH = viewport.clientHeight;

    // True visible range (no overscan) — used for header overlays
    const visFirst = rowAtOffset(scrollTop);
    const visLast = Math.min(rowAtOffset(scrollTop + viewportH), filteredCount - 1);

    const first = Math.max(0, visFirst - OVERSCAN);
    const last = Math.min(visLast + OVERSCAN, filteredCount - 1);

    // Prefetch visible rows in batch (WASM viewport optimization)
    if (data.prefetchViewport) {
      const visibleDataRows: number[] = [];
      for (let r = first; r <= last; r++) {
        visibleDataRows.push(viewIndices[r]);
      }
      data.prefetchViewport(visibleDataRows);
    }

    for (const pr of pool) {
      if (pr.assignedRow !== -1 && (pr.assignedRow < first || pr.assignedRow > last)) {
        releasePooledRow(pr);
      }
    }

    for (const pr of pool) {
      if (pr.assignedRow === -1) continue;
      if (viewIndices[pr.assignedRow] !== pr.assignedDataRow) {
        releasePooledRow(pr);
      }
    }

    let lazyPrepared = false;
    for (let r = first; r <= last; r++) {
      const dataRow = viewIndices[r];

      // Lazy-prepare cells on first visibility
      if (!cellCaches[dataRow]) {
        cellCaches[dataRow] = prepareCellRow(dataRow);
        // Recompute this row's height now that we have real measurements
        rowHeights[r] = computeRowHeight(r);
        lazyPrepared = true;
      }
    }

    // Newly measured rows can shift every downstream row position. Rebuild
    // before assigning transforms so Safari never paints a mixed frame where
    // some rows use measured heights and others still use estimated offsets.
    if (lazyPrepared) {
      rebuildPositions();
    }

    for (let r = first; r <= last; r++) {
      const dataRow = viewIndices[r];
      let existing = false;
      for (const pr of pool) {
        if (pr.assignedRow === r && pr.assignedDataRow === dataRow) {
          existing = true;
          break;
        }
      }
      if (existing) continue;

      const pr = getPooledRow();
      pr.assignedRow = r;
      pr.assignedDataRow = dataRow;
      pr.el.style.display = "";
      pr.el.style.transform = `translateY(${rowPositions[r] - virtualOffset}px)`;
      pr.el.style.height = rowHeights[r] + "px";
      pr.el.setAttribute("aria-rowindex", String(r + 2)); // 1-based, header is row 1

      if (r % 2 === 1) pr.el.classList.add("sift-row-alt");
      else pr.el.classList.remove("sift-row-alt");
      if (focusedDataRow !== null && dataRow === focusedDataRow) {
        pr.el.classList.add("sift-row-focused");
      } else {
        pr.el.classList.remove("sift-row-focused");
      }

      for (let c = 0; c < columns.length; c++) {
        renderCell(pr.cells[c], dataRow, c);
        pr.cells[c].style.width = colWidths[c] + "px";
        applyCellPinStyle(pr.cells[c], c);
      }
    }

    // Transforms depend on virtualOffset, which changes with scrollTop whenever
    // scrollScale > 1. Re-apply to every visible row on every render so scaled
    // tables track the scrollbar correctly. The ~50 style writes are trivial
    // next to the scroll event rate.
    if (scrollScale !== 1) {
      for (const pr of pool) {
        if (pr.assignedRow === -1) continue;
        pr.el.style.transform = `translateY(${rowPositions[pr.assignedRow] - virtualOffset}px)`;
      }
    }

    if (lazyPrepared || (lastScrollTop === scrollTop && lastViewportHeight === viewportH)) {
      for (const pr of pool) {
        if (pr.assignedRow === -1) continue;
        for (let c = 0; c < columns.length; c++) {
          pr.cells[c].style.width = colWidths[c] + "px";
        }
        pr.el.style.height = rowHeights[pr.assignedRow] + "px";
        pr.el.style.transform = `translateY(${rowPositions[pr.assignedRow] - virtualOffset}px)`;
      }
    }

    if (visFirst !== lastVisFirst || visLast !== lastVisLast) {
      lastVisFirst = visFirst;
      lastVisLast = visLast;
      updateVisibleOverlays(visFirst, visLast);
    }

    lastScrollTop = scrollTop;
    lastViewportHeight = viewportH;

    const domStr = `${first}–${Math.min(last, filteredCount - 1)} loaded · ${pool.filter((p) => p.assignedRow !== -1).length} DOM rows`;
    prevDom = updateStat(statDom, domStr, prevDom);
  }

  // --- Scroll handler ---

  function onScroll() {
    // Header scrolls naturally with content (it's inside scroll-content)
    updateVirtualOffset();
    scheduleRender();
  }

  viewport.addEventListener("scroll", onScroll, { passive: true });

  const onWindowResize = () => {
    fitLastColumnToViewport();
    recomputeScrollGeometry();
    scheduleRender();
  };
  window.addEventListener("resize", onWindowResize);

  // --- Mobile tap-row detail sheet ---

  let activeDetailSheet: HTMLDivElement | null = null;

  function typeIconChar(ct: ColumnType): string {
    return ct === "numeric" ? "#" : ct === "boolean" ? "◉" : ct === "timestamp" ? "◷" : "Aa";
  }

  function dismissDetailSheet() {
    if (!activeDetailSheet) return;
    const sheet = activeDetailSheet;
    const backdrop = sheet.previousElementSibling as HTMLElement | null;
    sheet.classList.remove("sift-detail-sheet-open");
    sheet.addEventListener(
      "transitionend",
      () => {
        sheet.remove();
        backdrop?.remove();
      },
      { once: true },
    );
    activeDetailSheet = null;
  }

  function showDetailSheet(viewRow: number) {
    // Dismiss any existing sheet first
    dismissDetailSheet();

    const dataRow = viewIndices[viewRow];

    // Backdrop
    const backdrop = document.createElement("div");
    backdrop.className = "sift-detail-backdrop";
    backdrop.addEventListener("click", dismissDetailSheet);

    // Sheet
    const sheet = document.createElement("div");
    sheet.className = "sift-detail-sheet";

    // Header with row number and close button
    const header = document.createElement("div");
    header.className = "sift-detail-header";

    const title = document.createElement("span");
    title.className = "sift-detail-title";
    title.textContent = `Row ${dataRow + 1}`;

    const closeBtn = document.createElement("button");
    closeBtn.className = "sift-detail-close";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", dismissDetailSheet);

    header.appendChild(title);
    header.appendChild(closeBtn);
    sheet.appendChild(header);

    // Column-value list
    const list = document.createElement("div");
    list.className = "sift-detail-list";

    for (let c = 0; c < columns.length; c++) {
      const row = document.createElement("div");
      row.className = "sift-detail-row";

      const nameEl = document.createElement("div");
      nameEl.className = "sift-detail-col-name";

      const icon = document.createElement("span");
      icon.className = "sift-detail-type-icon";
      icon.textContent = typeIconChar(columns[c].columnType);

      const label = document.createElement("span");
      label.textContent = columns[c].label;

      nameEl.appendChild(icon);
      nameEl.appendChild(label);

      const valueEl = document.createElement("div");
      valueEl.className = "sift-detail-col-value";

      const raw = data.getCellRaw(dataRow, c);
      if (raw == null) {
        const badge = document.createElement("span");
        badge.className = "sift-badge sift-badge-null";
        badge.textContent = "null";
        valueEl.appendChild(badge);
      } else if (columns[c].columnType === "boolean") {
        const badge = document.createElement("span");
        badge.className = raw ? "sift-badge sift-badge-true" : "sift-badge sift-badge-false";
        badge.textContent = raw ? "Yes" : "No";
        valueEl.appendChild(badge);
      } else if (
        Array.isArray(raw) &&
        raw.length > 0 &&
        raw.every((item) => !Array.isArray(item) && (typeof item !== "object" || item === null))
      ) {
        valueEl.classList.add("sift-cell-list");
        for (const item of raw) {
          const badge = document.createElement("span");
          badge.className = "sift-badge sift-badge-list-item";
          badge.textContent = item == null ? "null" : String(item);
          valueEl.appendChild(badge);
        }
      } else {
        valueEl.textContent = data.getCell(dataRow, c);
      }

      row.appendChild(nameEl);
      row.appendChild(valueEl);
      list.appendChild(row);
    }

    sheet.appendChild(list);

    document.body.appendChild(backdrop);
    document.body.appendChild(sheet);
    activeDetailSheet = sheet;

    // Trigger slide-up animation on next frame
    requestAnimationFrame(() => {
      sheet.classList.add("sift-detail-sheet-open");
    });
  }

  // Click detection on rows: toggle inline focus (HF-style row expand) on
  // desktop / mouse, fall through to the mobile detail-sheet path below for
  // touch under 768 px. Track pointerdown/up coordinates so dragging to
  // select text doesn't trip the toggle.
  viewport.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const button = target.closest(".sift-cell-image-thumb-button") as HTMLButtonElement | null;
    if (!button) return;
    e.preventDefault();
    e.stopPropagation();

    const rowEl = button.closest(".sift-row") as HTMLDivElement | null;
    const cellEl = button.closest(".sift-cell") as HTMLDivElement | null;
    if (!rowEl || !cellEl) return;

    const colIndex = Number.parseInt(cellEl.getAttribute("aria-colindex") ?? "", 10) - 1;
    const imageIndex = Number.parseInt(button.dataset.siftImageIndex ?? "", 10);
    if (
      !Number.isInteger(colIndex) ||
      !Number.isInteger(imageIndex) ||
      colIndex < 0 ||
      colIndex >= columns.length ||
      imageIndex < 0
    ) {
      return;
    }

    for (const pr of pool) {
      if (pr.el === rowEl && pr.assignedRow !== -1) {
        showImageViewer(viewIndices[pr.assignedRow], colIndex, imageIndex);
        break;
      }
    }
  });

  let focusDownX = 0;
  let focusDownY = 0;
  let focusDownActive = false;

  viewport.addEventListener("pointerdown", (e) => {
    // Skip the cases owned by the mobile detail-sheet handler below.
    if (window.innerWidth < 768 && e.pointerType === "touch") return;
    focusDownX = e.clientX;
    focusDownY = e.clientY;
    focusDownActive = true;
  });

  viewport.addEventListener("pointerup", (e) => {
    if (!focusDownActive) return;
    focusDownActive = false;
    if (window.innerWidth < 768 && e.pointerType === "touch") return;
    if (e.button !== 0 && e.pointerType === "mouse") return; // left-click only
    const dx = Math.abs(e.clientX - focusDownX);
    const dy = Math.abs(e.clientY - focusDownY);
    if (dx > FOCUS_TOGGLE_MAX_DRAG_PX || dy > FOCUS_TOGGLE_MAX_DRAG_PX) return; // dragged → text selection

    const target = e.target as HTMLElement;
    // Skip if the click landed on something interactive — the column resize
    // handle, an image thumb, an inline button, the detail sheet, etc.
    if (target.closest("button, a, .sift-resize-handle, .sift-cell-image-thumb")) {
      return;
    }
    const rowEl = target.closest(".sift-row") as HTMLDivElement | null;
    if (!rowEl) return;
    for (const pr of pool) {
      if (pr.el === rowEl && pr.assignedRow !== -1) {
        const dataRow = viewIndices[pr.assignedRow];
        setFocusedDataRow(focusedDataRow === dataRow ? null : dataRow);
        break;
      }
    }
  });

  // Tap detection on rows: click on narrow viewports opens detail sheet.
  // We use pointerdown/pointerup to distinguish taps from scrolls/long-presses.
  let tapStartTime = 0;
  let tapStartX = 0;
  let tapStartY = 0;
  const TAP_MAX_DURATION = 300;
  const TAP_MAX_DISTANCE = 10;

  viewport.addEventListener("pointerdown", (e) => {
    if (window.innerWidth >= 768) return;
    if (e.pointerType !== "touch") return;
    tapStartTime = e.timeStamp;
    tapStartX = e.clientX;
    tapStartY = e.clientY;
  });

  viewport.addEventListener("pointerup", (e) => {
    if (window.innerWidth >= 768) return;
    if (e.pointerType !== "touch") return;

    const duration = e.timeStamp - tapStartTime;
    const dx = Math.abs(e.clientX - tapStartX);
    const dy = Math.abs(e.clientY - tapStartY);
    if (duration > TAP_MAX_DURATION || dx > TAP_MAX_DISTANCE || dy > TAP_MAX_DISTANCE) return;

    // Find which pool row was tapped
    const target = e.target as HTMLElement;
    if (target.closest("button, a, .sift-resize-handle, .sift-cell-image-thumb")) {
      return;
    }
    const rowEl = target.closest(".sift-row") as HTMLDivElement | null;
    if (!rowEl) return;

    for (const pr of pool) {
      if (pr.el === rowEl && pr.assignedRow !== -1) {
        showDetailSheet(pr.assignedRow);
        break;
      }
    }
  });

  // --- Column resize ---

  function onResizeStart(e: PointerEvent, colIndex: number) {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLDivElement;
    handle.classList.add("dragging");
    handle.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startWidth = colWidths[colIndex];
    const isLast = colIndex === columns.length - 1;
    if (isLast) lastColumnAutoFill = false;

    const onMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX;
      colWidths[colIndex] = Math.max(MIN_COL_WIDTH, startWidth + delta);
      headerCells[colIndex].style.width = colWidths[colIndex] + "px";
      updateScrollContentWidth();
      updatePinnedStyles();
      updateMountedColumnWidth(colIndex);
      if (!isLast) {
        fitLastColumnToViewport(false, false, false, false);
        updatePinnedStyles();
        updateMountedColumnWidth(columns.length - 1);
      }
    };

    const onUp = () => {
      handle.classList.remove("dragging");
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      renderSummary(colIndex);
      if (!isLast) renderSummary(columns.length - 1);
      markHeightsDirty(true);
      renderImmediately();
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
  }

  // --- Sort ---

  function onSortClick(col: number) {
    if (sortState && sortState.col === col) {
      if (sortState.dir === "asc") sortState = { col, dir: "desc" };
      else sortState = null;
    } else {
      sortState = { col, dir: "asc" };
    }

    updateSortUI();
    applyFilterAndSort();
    // Reset vertical scroll but preserve horizontal position
    viewport.scrollTop = 0;
    for (const pr of pool) {
      releasePooledRow(pr);
    }
    scheduleRender();
    notifyChange();
  }

  function updateSortUI() {
    for (let c = 0; c < columns.length; c++) {
      const arrow = headerCells[c].querySelector(".sift-sort-arrow");
      if (!arrow) continue;
      if (sortState && sortState.col === c) {
        arrow.textContent = sortState.dir === "asc" ? " ↑" : " ↓";
        headerCells[c].setAttribute(
          "aria-sort",
          sortState.dir === "asc" ? "ascending" : "descending",
        );
      } else {
        arrow.textContent = "";
        headerCells[c].removeAttribute("aria-sort");
      }
    }
  }

  // --- Batch append handler ---

  function onBatchAppended() {
    const newRowCount = data.rowCount;
    growBuffers(newRowCount);

    // Cells will be lazy-prepared when they enter the viewport

    rowCount = newRowCount;
    // Re-filter and re-sort with new data
    applyFilterAndSort();

    // Save the latest unfiltered summaries
    unfilteredSummaries = [...data.columnSummaries];

    // If filters are active, recompute from filtered rows
    if (hasActiveFilters() && data.recomputeFilteredSummaries) {
      recomputeFilteredSummaries();
    }

    // Update row count display
    updateRowCountDisplay();

    // Re-render non-histogram summaries (categorical, boolean) immediately —
    // they don't have a visible-window overlay so there's no flicker concern.
    // Numeric/timestamp histograms are NOT rendered here; instead we reset
    // the overlay tracking so the scheduled render paints them with the
    // correct visible bins, avoiding the all→windowed flicker.
    for (let c = 0; c < columns.length; c++) {
      const summary = data.columnSummaries[c];
      if (summary && summary.kind !== "numeric" && summary.kind !== "timestamp") {
        renderSummary(c);
      }
    }

    heightsDirty = true;
    lastVisFirst = -1;
    lastVisLast = -1;
    scheduleRender();
  }

  function setStreamingDone() {
    if (!streaming) return;
    streaming = false;
    progressBar.classList.add("sift-progress-bar-done");
    updateRowCountDisplay();
    // Switch status indicator from streaming dot to checkmark
    statusIndicator.classList.remove("sift-status-streaming");
    statusIndicator.classList.add("sift-status-ready");
    statusIndicator.textContent = "✓";
    statusIndicator.title = "All data loaded";
    // Remove the progress bar from DOM after fade-out transition
    progressBar.addEventListener("transitionend", () => progressBar.remove(), {
      once: true,
    });
    // Notify consumers — totalCount may have grown across row groups, and
    // host UIs that size their container based on row count want to settle
    // on the final value rather than the first batch.
    notifyChange();
  }

  function findSurvivingColumnIndices(newColumns: Column[]): Map<number, number> {
    const unusedNewIndices = new Set(newColumns.map((_, index) => index));
    const survivors = new Map<number, number>();
    for (let oldIndex = 0; oldIndex < columns.length; oldIndex++) {
      const oldColumn = columns[oldIndex];
      for (const newIndex of unusedNewIndices) {
        const newColumn = newColumns[newIndex];
        if (oldColumn.key === newColumn.key && oldColumn.columnType === newColumn.columnType) {
          survivors.set(oldIndex, newIndex);
          unusedNewIndices.delete(newIndex);
          break;
        }
      }
    }
    return survivors;
  }

  function preserveStateFor(
    newColumns: Column[],
    replaceOptions: ReplaceDataOptions | undefined,
  ): {
    sort: TableEngineState["sort"];
    filters: TableEngineState["filters"];
  } {
    const survivors = findSurvivingColumnIndices(newColumns);
    const preservedFilters: TableEngineState["filters"] = [];
    if (!replaceOptions?.resetFilters) {
      for (let oldIndex = 0; oldIndex < filters.length; oldIndex++) {
        const newIndex = survivors.get(oldIndex);
        if (newIndex === undefined || !filters[oldIndex]) continue;
        preservedFilters.push({
          column: newColumns[newIndex].key,
          filter: filters[oldIndex],
        });
      }
    }

    let preservedSort: TableEngineState["sort"] = null;
    if (!replaceOptions?.resetSort && sortState) {
      const newSortIndex = survivors.get(sortState.col);
      if (newSortIndex !== undefined) {
        preservedSort = {
          column: newColumns[newSortIndex].key,
          direction: sortState.dir,
        };
      }
    }

    return { sort: preservedSort, filters: preservedFilters };
  }

  function sameColumnShape(newColumns: Column[]): boolean {
    return (
      columns.length === newColumns.length &&
      columns.every(
        (column, index) =>
          column.key === newColumns[index].key &&
          column.columnType === newColumns[index].columnType,
      )
    );
  }

  function hidePooledRows() {
    for (const pr of pool) {
      releasePooledRow(pr);
    }
  }

  function replaceData(newData: TableData, replaceOptions?: ReplaceDataOptions) {
    const preserved = preserveStateFor(newData.columns, replaceOptions);

    if (!sameColumnShape(newData.columns)) {
      destroy();
      const replacement = createTable(container, newData, options);
      Object.assign(api, replacement);
      if (preserved.sort) {
        replacement.setSort(preserved.sort.column, preserved.sort.direction);
      }
      for (const preservedFilter of preserved.filters) {
        const newIndex = newData.columns.findIndex(
          (column) => column.key === preservedFilter.column,
        );
        if (newIndex !== -1) replacement.setFilter(newIndex, preservedFilter.filter);
      }
      return;
    }

    const oldData = data;
    data = newData;
    columns = newData.columns;
    rowCount = newData.rowCount;
    growBuffers(rowCount);
    filteredCount = rowCount;
    unfilteredSummaries = [...newData.columnSummaries];

    if (replaceOptions?.resetSort) {
      sortState = null;
    }
    if (replaceOptions?.resetFilters) {
      filters = columns.map(() => null);
    }

    cellCaches.length = 0;
    focusedDataRow = null;
    lastVisFirst = -1;
    lastVisLast = -1;
    pendingScrollAnchor = null;

    for (let c = 0; c < columns.length; c++) {
      const label = headerCells[c].querySelector(".sift-th-label");
      if (label) label.textContent = columns[c].label;
      const typeIcon = headerCells[c].querySelector(".sift-type-icon");
      if (typeIcon) {
        typeIcon.textContent = typeIconChar(columns[c].columnType);
        typeIcon.setAttribute("title", columns[c].columnType);
      }
    }

    applyFilterAndSort();
    if (hasActiveFilters() && data.recomputeFilteredSummaries) {
      recomputeFilteredSummaries();
    }
    updateSortUI();
    updateRowCountDisplay();
    rebuildFilterPills();
    renderAllSummaries();
    updateFilteredLabels();
    hidePooledRows();
    viewport.scrollTop = 0;
    heightsDirty = true;
    scheduleRender();
    if (oldData !== newData) oldData.dispose?.();
    notifyChange();
  }

  // --- Boot ---

  document.fonts.ready.then(() => {
    for (let r = 0; r < rowCount; r++) {
      const cache = cellCaches[r];
      if (!cache) continue;
      for (let c = 0; c < columns.length; c++) {
        cache[c].prepared = prepare(data.getCell(r, c), FONT);
        cache[c].lastWidth = -1;
      }
    }
    heightsDirty = true;
    scheduleRender();
  });

  scheduleRender();

  // Watch for header height changes (e.g. when React summary charts mount async)
  // so rowPool.style.top stays in sync
  let headerResizeObserver: ResizeObserver | null = null;
  let viewportResizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== "undefined") {
    headerResizeObserver = new ResizeObserver(() => {
      heightsDirty = true;
      scheduleRender();
    });
    headerResizeObserver.observe(headerEl);

    // Keep the last column sized to fill the viewport as the container resizes
    // (e.g. the user maximizes the notebook window or resizes a split pane).
    // Also recompute scroll geometry: scrollScale = virtualRange / renderedRange,
    // and renderedRange depends on viewport.clientHeight, so a viewport resize
    // shifts the affine map under our feet when virtualTotal > cap.
    viewportResizeObserver = new ResizeObserver(() => {
      fitLastColumnToViewport();
      recomputeScrollGeometry();
      scheduleRender();
    });
    viewportResizeObserver.observe(viewport);
  }

  // Initial fit in case the proportional scale above left sub-pixel slack.
  fitLastColumnToViewport();

  // --- Keyboard navigation ---

  container.tabIndex = 0;
  container.style.outline = "none";

  function onKeyDown(e: KeyboardEvent) {
    // When the table exceeds the browser's max element height the spacer is
    // clamped and `scrollScale > 1`, so each DOM pixel of scroll covers
    // `scrollScale` virtual pixels of visible content. Divide by scrollScale
    // here so one ArrowDown still advances the visible content by one row
    // instead of `scrollScale` rows.
    const oneRow = (LINE_HEIGHT + CELL_PAD_V) / scrollScale;
    const pageH = viewport.clientHeight / scrollScale;

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        viewport.scrollTop += oneRow;
        break;
      case "ArrowUp":
        e.preventDefault();
        viewport.scrollTop -= oneRow;
        break;
      case "PageDown":
        e.preventDefault();
        viewport.scrollTop += pageH;
        break;
      case "PageUp":
        e.preventDefault();
        viewport.scrollTop -= pageH;
        break;
      case "Home":
        e.preventDefault();
        viewport.scrollTop = 0;
        break;
      case "End":
        e.preventDefault();
        viewport.scrollTop = viewport.scrollHeight;
        break;
      case "Escape":
        if (hasActiveFilters()) {
          e.preventDefault();
          clearAllFilters();
        }
        break;
    }
  }

  container.addEventListener("keydown", onKeyDown);

  // --- Destroy ---

  let destroyed = false;

  function destroy() {
    if (destroyed) return;
    destroyed = true;

    // Cancel pending render + FPS observable
    if (scheduledRaf !== null) {
      cancelAnimationFrame(scheduledRaf);
      scheduledRaf = null;
    }
    fpsSub.unsubscribe();
    if (summaryDebounceTimer !== null) clearTimeout(summaryDebounceTimer);

    // Remove event listeners and observers
    headerResizeObserver?.disconnect();
    viewport.removeEventListener("scroll", onScroll);

    container.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onWindowResize);
    viewportResizeObserver?.disconnect();
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", onFullscreenChange);

    // Unmount React roots
    for (const el of summaryContainers) {
      unmountColumnSummary(el);
    }
    unmountColumnMenu();

    // Dismiss detail sheet if open
    dismissDetailSheet();
    dismissImageViewer();

    // Revoke every outstanding image Blob URL before we drop the DOM.
    // Cell recycling already revokes per-cell on rerender; destroy() is
    // the only path that wipes the container without first cycling
    // through renderCell, so without this sweep the URLs hold memory
    // until the document goes away.
    revokeCellBlobUrls(container);
    // Clear DOM
    container.innerHTML = "";
    container.classList.remove("sift-table-container");
    data.dispose?.();
  }

  // --- Filter API ---

  function recomputeFilteredSummaries() {
    if (!hasActiveFilters()) {
      // Restore unfiltered summaries
      data.columnSummaries = [...unfilteredSummaries];
      return;
    }

    // Build byte mask and delegate to WASM
    const mask = new Uint8Array(rowCount);
    for (let i = 0; i < filteredCount; i++) {
      mask[viewIndices[i]] = 1;
    }
    data.recomputeFilteredSummaries!(mask, filteredCount);

    // Carry forward isIndex from unfiltered summaries — WASM doesn't track it
    for (let c = 0; c < columns.length; c++) {
      const unfiltered = unfilteredSummaries[c];
      const filtered = data.columnSummaries[c];
      if (unfiltered && filtered && (unfiltered as any).isIndex) {
        (filtered as any).isIndex = true;
      }
    }
  }

  function filterLabel(f: ColumnFilter, colIndex?: number): string {
    if (!f) return "";
    switch (f.kind) {
      case "range": {
        if (colIndex !== undefined && columns[colIndex].columnType === "timestamp") {
          const tz = columns[colIndex].timezone ?? "UTC";
          const fmt = (v: number) =>
            new Date(v).toLocaleDateString(undefined, {
              month: "short",
              day: "numeric",
              year: "2-digit",
              timeZone: tz,
            });
          return `${fmt(f.min)} – ${fmt(f.max)}`;
        }
        const minStr = f.min.toLocaleString(undefined, {
          maximumFractionDigits: 1,
        });
        const maxStr = f.max.toLocaleString(undefined, {
          maximumFractionDigits: 1,
        });
        return minStr === maxStr ? minStr : `${minStr} – ${maxStr}`;
      }
      case "set": {
        const vals = [...f.values];
        if (vals.length === 1) return vals[0];
        return `${vals.length} values`;
      }
      case "not-in": {
        const vals = [...f.values];
        if (vals.length === 1) return `not ${vals[0]}`;
        return `not ${vals.length} values`;
      }
      case "boolean":
        return f.value ? "Yes" : "No";
    }
  }

  function hiddenLabel(c: number): string | null {
    const full = unfilteredSummaries[c];
    const filtered = data.columnSummaries[c];
    if (!full || !filtered) return null;

    if (full.kind === "categorical" && filtered.kind === "categorical") {
      const hidden = full.uniqueCount - filtered.uniqueCount;
      if (hidden > 0) return `${hidden} values hidden`;
      return null;
    }
    if (full.kind === "boolean" && filtered.kind === "boolean") {
      const anyHidden =
        (full.trueCount > 0 && filtered.trueCount === 0) ||
        (full.falseCount > 0 && filtered.falseCount === 0) ||
        (full.nullCount > 0 && filtered.nullCount === 0);
      return anyHidden ? "Some values hidden" : null;
    }
    // Numeric/timestamp — check if range narrowed
    if (
      (full.kind === "numeric" && filtered.kind === "numeric") ||
      (full.kind === "timestamp" && filtered.kind === "timestamp")
    ) {
      // Binary numeric columns show selection via the ratio bar — no need for "values hidden"
      if (full.kind === "numeric" && (full as any).uniqueCount === 2) return null;
      if (full.min !== filtered.min || full.max !== filtered.max) {
        return "values hidden";
      }
    }
    return null;
  }

  function updateFilteredLabels() {
    const active = hasActiveFilters();
    for (let c = 0; c < columns.length; c++) {
      const th = headerCells[c];
      const label = th.querySelector(".sift-th-label") as HTMLElement;

      // Remove existing filter line
      const existing = th.querySelector(".sift-filter-line");
      if (existing) existing.remove();

      const f = filters[c];

      if (label) {
        label.style.color = f ? "var(--sift-accent)" : "";
        label.textContent = columns[c].label;
      }

      if (active) {
        const parts: string[] = [];
        if (f) parts.push(filterLabel(f, c));
        const hidden = hiddenLabel(c);
        if (hidden) parts.push(hidden);

        if (parts.length > 0) {
          const line = document.createElement("div");
          line.className = "sift-filter-line";
          line.textContent = parts.join(" · ");
          th.appendChild(line);
        }

        // Detailed hover tooltip showing which filters affect this column
        if (!f) {
          const activeFilters: string[] = [];
          for (let i = 0; i < columns.length; i++) {
            if (filters[i]) {
              activeFilters.push(`${columns[i].label}: ${filterLabel(filters[i], i)}`);
            }
          }
          th.title = `Values filtered by ${activeFilters.join(", ")}`;
        } else {
          th.title = "";
        }
      } else {
        th.title = "";
      }
    }
  }

  // Debounced summary recomputation — expensive, deferred during brush drag
  let summaryDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const SUMMARY_DEBOUNCE_MS = 120;

  function scheduleSummaryRecompute() {
    if (summaryDebounceTimer !== null) clearTimeout(summaryDebounceTimer);
    summaryDebounceTimer = setTimeout(() => {
      summaryDebounceTimer = null;
      recomputeFilteredSummaries();
      renderAllSummaries();
      updateFilteredLabels();
    }, SUMMARY_DEBOUNCE_MS);
  }

  function onFilterChanged() {
    // Filtering can hide the focused row entirely, leaving the user with no
    // visual cue for what's still expanded. Reset and let them re-pick.
    focusedDataRow = null;
    applyFilterAndSort();
    // Fast path: update rows immediately, defer expensive summary recomputation
    updateRowCountDisplay();
    rebuildFilterPills();
    // Announce to screen readers
    ariaLive.textContent = hasActiveFilters()
      ? `Filtered to ${filteredCount.toLocaleString()} of ${rowCount.toLocaleString()} rows`
      : `${rowCount.toLocaleString()} rows`;
    // WASM path is fast enough to compute summaries synchronously — no flicker.
    // JS fallback still debounces since it's O(rows × cols) with per-cell access.
    if (data.recomputeFilteredSummaries) {
      if (summaryDebounceTimer !== null) {
        clearTimeout(summaryDebounceTimer);
        summaryDebounceTimer = null;
      }
      recomputeFilteredSummaries();
      renderAllSummaries();
      updateFilteredLabels();
    } else {
      scheduleSummaryRecompute();
    }
    viewport.scrollTop = 0;
    for (const pr of pool) {
      releasePooledRow(pr);
    }
    lastVisFirst = -1;
    lastVisLast = -1;
    scheduleRender();
    notifyChange();
  }

  function setFilter(colIndex: number, filter: ColumnFilter) {
    filters[colIndex] = filter;
    onFilterChanged();
  }

  function clearFilter(colIndex: number) {
    filters[colIndex] = null;
    onFilterChanged();
  }

  function clearAllFilters() {
    for (let i = 0; i < filters.length; i++) filters[i] = null;
    onFilterChanged();
  }

  // --- State getters ---

  function getSort(): TableEngineState["sort"] {
    if (!sortState) return null;
    return { column: columns[sortState.col].key, direction: sortState.dir };
  }

  function setSortByName(column: string, direction: "asc" | "desc") {
    const colIndex = columns.findIndex((c) => c.key === column);
    if (colIndex === -1) return;
    sortState = { col: colIndex, dir: direction };

    updateSortUI();
    applyFilterAndSort();
    viewport.scrollTop = 0;
    for (const pr of pool) {
      releasePooledRow(pr);
    }
    scheduleRender();
  }

  function getFilters(): TableEngineState["filters"] {
    const result: TableEngineState["filters"] = [];
    for (let i = 0; i < columns.length; i++) {
      if (filters[i]) {
        result.push({ column: columns[i].key, filter: filters[i] });
      }
    }
    return result;
  }

  function getState(): TableEngineState {
    return {
      sort: getSort(),
      filters: getFilters(),
      filteredCount,
      totalCount: rowCount,
    };
  }

  function notifyChange() {
    options?.onChange?.(getState());
  }

  // --- Column context menu action handler ---

  function handleColumnAction(colIndex: number, action: ColumnAction) {
    switch (action.kind) {
      case "sort":
        if (sortState?.col === colIndex && sortState.dir === action.direction) {
          sortState = null; // toggle off
        } else {
          sortState = { col: colIndex, dir: action.direction };
        }
        updateSortUI();
        applyFilterAndSort();
        viewport.scrollTop = 0;
        for (const pr of pool) {
          releasePooledRow(pr);
        }
        scheduleRender();
        notifyChange();
        break;

      case "pin":
        pinnedColumns.add(colIndex);
        visualOrder = computeVisualOrder();
        reorderColumns();
        updatePinnedStyles();
        break;

      case "unpin":
        pinnedColumns.delete(colIndex);
        visualOrder = computeVisualOrder();
        reorderColumns();
        updatePinnedStyles();
        break;

      case "cast":
        if (streaming) break; // Cast blocked during streaming — schema mismatch would crash WASM
        if (data.castColumn) {
          try {
            data.castColumn(colIndex, action.targetType);
          } catch (e) {
            console.warn("Cast failed:", e);
            break;
          }
          // Update the column metadata
          columns[colIndex].columnType = action.targetType;
          columns[colIndex].numeric = action.targetType === "numeric";
          // Update type icon
          const icon = headerCells[colIndex].querySelector(".sift-type-icon");
          if (icon) {
            icon.textContent =
              action.targetType === "numeric"
                ? "#"
                : action.targetType === "boolean"
                  ? "◉"
                  : action.targetType === "timestamp"
                    ? "◷"
                    : "Aa";
            icon.setAttribute("title", action.targetType);
          }
          // Recompute summaries from source (WASM or accumulators)
          if (data.recomputeSummaries) data.recomputeSummaries();
          unfilteredSummaries = [...data.columnSummaries];
          if (hasActiveFilters()) recomputeFilteredSummaries();
          renderAllSummaries();
          heightsDirty = true;
          for (const pr of pool) {
            releasePooledRow(pr);
          }
          scheduleRender();
        }
        break;

      case "undo-cast":
        if (streaming) break;
        if (data.undoCastColumn) {
          const restoredType = data.undoCastColumn(colIndex);
          // Update the column metadata
          columns[colIndex].columnType = restoredType;
          columns[colIndex].numeric = restoredType === "numeric";
          // Update type icon
          const iconUndo = headerCells[colIndex].querySelector(".sift-type-icon");
          if (iconUndo) {
            iconUndo.textContent =
              restoredType === "numeric"
                ? "#"
                : restoredType === "boolean"
                  ? "◉"
                  : restoredType === "timestamp"
                    ? "◷"
                    : "Aa";
            iconUndo.setAttribute("title", restoredType);
          }
          // Recompute summaries from source (WASM or accumulators)
          if (data.recomputeSummaries) data.recomputeSummaries();
          unfilteredSummaries = [...data.columnSummaries];
          if (hasActiveFilters()) recomputeFilteredSummaries();
          renderAllSummaries();
          heightsDirty = true;
          for (const pr of pool) {
            releasePooledRow(pr);
          }
          scheduleRender();
        }
        break;
    }
  }

  // Precompute cumulative left offsets for pinned columns
  let pinnedLeftOffsets: number[] = [];
  function recomputePinnedOffsets() {
    pinnedLeftOffsets = Array.from<number>({ length: columns.length }).fill(-1);
    let cumLeft = 0;
    for (let c = 0; c < columns.length; c++) {
      if (pinnedColumns.has(c)) {
        pinnedLeftOffsets[c] = cumLeft;
        cumLeft += colWidths[c];
      }
    }
  }
  recomputePinnedOffsets();
  // Apply initial pinned styles to header THs (not just cells)
  updatePinnedStyles();

  function applyCellPinStyle(cell: HTMLElement, colIndex: number) {
    if (pinnedColumns.has(colIndex)) {
      cell.style.position = "sticky";
      cell.style.left = pinnedLeftOffsets[colIndex] + "px";
      cell.style.zIndex = "1";
      cell.style.background = "var(--sift-panel)";
      cell.style.boxShadow = "2px 0 4px var(--sift-pin-shadow)";
    } else {
      cell.style.position = "";
      cell.style.left = "";
      cell.style.zIndex = "";
      cell.style.background = "";
      cell.style.boxShadow = "";
    }
  }

  function reorderColumns() {
    // Reorder header TH elements to match visualOrder
    for (const colIdx of visualOrder) {
      headerRowEl.appendChild(headerCells[colIdx]);
    }

    // Reorder cells in each pooled row
    for (const pr of pool) {
      for (const colIdx of visualOrder) {
        pr.el.appendChild(pr.cells[colIdx]);
      }
    }

    // Force re-render to update positions
    heightsDirty = true;
    for (const pr of pool) {
      releasePooledRow(pr);
    }
    scheduleRender();
  }

  function updatePinnedStyles() {
    recomputePinnedOffsets();
    // Find the last pinned visual index
    let lastPinnedVi = -1;
    for (let vi = 0; vi < visualOrder.length; vi++) {
      if (pinnedColumns.has(visualOrder[vi])) lastPinnedVi = vi;
    }
    // Iterate in visual order since DOM has been reordered
    const ths = Array.from(headerRowEl.children) as HTMLDivElement[];
    for (let vi = 0; vi < visualOrder.length; vi++) {
      const dataCol = visualOrder[vi];
      const th = ths[vi];
      const handle = th.querySelector(".sift-resize-handle") as HTMLElement | null;
      if (pinnedColumns.has(dataCol)) {
        th.style.position = "sticky";
        th.style.left = pinnedLeftOffsets[dataCol] + "px";
        th.style.zIndex = "6";
        th.style.background = "color-mix(in srgb, var(--sift-panel) 90%, var(--sift-bg) 10%)";
        th.style.boxShadow = vi === lastPinnedVi ? "2px 0 4px var(--sift-pin-shadow)" : "";
        // Hide resize bar on last pinned column (shadow provides the edge)
        if (handle) handle.style.opacity = vi === lastPinnedVi ? "0" : "";
      } else {
        th.style.position = "";
        th.style.left = "";
        th.style.zIndex = "";
        th.style.background = "";
        th.style.boxShadow = "";
        if (handle) handle.style.opacity = "";
      }
    }
  }

  // Surface the initial state once the engine is wired so consumers can
  // size their container based on `totalCount` without waiting for the
  // user to interact. Subsequent state changes still fire through
  // notifyChange on sort / filter / append.
  options?.onChange?.(getState());

  const api: TableEngine = {
    onBatchAppended,
    setStreamingDone,
    replaceData,
    destroy,
    setFilter,
    clearFilter,
    clearAllFilters,
    getSort,
    setSort: setSortByName,
    getFilters,
    getState,
    getFocusedDataRow: () => focusedDataRow,
    setFocusedDataRow,
  };
  return api;
}
