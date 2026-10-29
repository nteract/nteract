/**
 * Wire protocol between the view (main thread) and the data side running in a
 * worker. Internal: both halves ship in this package and are versioned
 * together. Typed arrays and image bytes cross with transfer lists; strings,
 * filters (including `Set`s), and summaries are structured-cloned.
 *
 * The worker is `createResidentWindowedData` behind a `MessagePort`: it owns the
 * WASM module, the Parquet file, the permutation, and the summaries. The main
 * thread holds a `WindowedTableData` whose methods post these messages. The
 * host's `ByteSource` cannot cross (functions do not clone), so reads are
 * relayed: the worker asks, the main thread answers with transferred bytes.
 */

import type { ParquetFileLimits } from "../parquet-file";
import type { Column, ColumnFileStats, ColumnType, DatasetCoverage } from "../table";
import type { TableLimitOverflow } from "../file-data";
import type { DataEvent, QueryResult, ViewQuery, WindowCells } from "../windowed";

export const PROTOCOL_VERSION = 2;

/**
 * Default worker allocation cap, as a multiple of `limits.maxDecodedBytes`.
 * Decoding a row group transiently needs about twice the retained heap, so a
 * cap at 2× can trap on the last row group a truncating budget admits; 2.5×
 * leaves the budget, not the cap, as what ends a large preview.
 */
export const DEFAULT_ALLOCATION_CAP_FACTOR = 2.5;

export type OpenRequest = {
  t: "open";
  id: number;
  protocol: typeof PROTOCOL_VERSION;
  source: { kind: "byte-source-relay"; byteLength: number };
  limits: ParquetFileLimits;
  overflow?: TableLimitOverflow;
  columnOverrides?: Record<string, Partial<Column>>;
  headRows: number;
  wasmUrl?: string;
  wasmFallbackUrl?: string;
  /**
   * Live WASM heap bytes allowed; defaults to `limits.maxDecodedBytes *
   * DEFAULT_ALLOCATION_CAP_FACTOR`.
   */
  allocationCap?: number;
  /**
   * Soft budget: pause once the committed rows or decoded bytes reach it while
   * row groups remain, and wait for `resume`. Each resume extends it by the
   * same amounts. What triggers a resume is the main thread's concern.
   */
  autoLoad?: { rows?: number; decodedBytes?: number };
};

export type ToWorker =
  | OpenRequest
  | { t: "window"; id: number; gen: number; viewStart: number; viewEnd: number }
  | { t: "query"; id: number; gen: number; query: ViewQuery }
  | { t: "image"; id: number; dataRow: number; col: number }
  | { t: "cast"; id: number; gen: number; col: number; to: ColumnType }
  | { t: "undo-cast"; id: number; gen: number; col: number }
  /** Answer to a `read` relay; `bytes.buffer` is transferred. */
  | { t: "read-result"; id: number; bytes: Uint8Array }
  | { t: "read-error"; id: number; message: string }
  /** Continue a load paused at the `autoLoad` budget. No-op unless paused. */
  | { t: "resume" }
  | { t: "close" };

export type OpenedReply = {
  t: "opened";
  id: number;
  columns: Column[];
  rowCount: number;
  coverage?: DatasetCoverage;
  datasetStats?: (ColumnFileStats | null)[];
  head: WindowCells;
  rowGroupCount: number;
};

/** Load progress after a row group; `complete` is the last one. */
export type ProgressReply = {
  t: "progress";
  phase: "chunk" | "complete";
  rowGroup: number;
  rowGroupCount: number;
  loadedRows: number;
  totalRows: number;
  truncated: boolean;
  /** Live heap bytes when the allocator reports them, else linear memory size. */
  memoryBytes: number;
};

export type FromWorker =
  | OpenedReply
  /** Typed arrays transferred. */
  | { t: "window"; id: number; cells: WindowCells }
  | { t: "query"; id: number; result: QueryResult }
  /** Chunk buffers transferred. */
  | { t: "image"; id: number; chunks: Uint8Array[] | null }
  /**
   * Cast or undo answer. `head` is recomputed under the new types for the same
   * `headRows` span. Cloned, not transferred: the host keeps its copy.
   */
  | { t: "cast"; id: number; result: QueryResult & { columns: Column[] }; head: WindowCells }
  /** Relay request: read `length` bytes at `offset` from the host's `ByteSource`. */
  | { t: "read"; id: number; offset: number; length: number }
  /**
   * Push from the data side. A `schema-changed` event carries the refreshed
   * head. A load failure after `opened` is an `error` event with `fatal:
   * false`: the rows so far stay queryable and no `streaming-done` follows.
   */
  | { t: "event"; event: DataEvent; head?: WindowCells }
  | ProgressReply
  /** `fatal` means the WASM instance is unusable; the worker stops answering. */
  | { t: "error"; id: number | null; message: string; fatal: boolean }
  /** Ack for `close`; the main thread terminates on it or after a timeout. */
  | { t: "closed" };

/** Buffers to transfer for `cells`. Shared buffers are copied first by the sender. */
export function windowCellsTransfer(cells: WindowCells): ArrayBuffer[] {
  return dedupe([cells.dataRows.buffer, cells.nulls.buffer, cells.numeric.buffer]);
}

/**
 * A `Uint8Array` that owns its whole buffer, so transferring the buffer sends
 * exactly these bytes. Copies when the view is a slice or the buffer is shared.
 */
export function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buffer = bytes.buffer;
  if (
    buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === buffer.byteLength
  ) {
    return bytes as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(bytes);
}

function dedupe(buffers: ArrayBufferLike[]): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const buffer of buffers) {
    if (buffer instanceof ArrayBuffer && !out.includes(buffer)) out.push(buffer);
  }
  return out;
}

/**
 * Whether `error` means the WASM instance trapped or refused an allocation.
 * Over-cap allocations requested from JS (wasm-bindgen's malloc for strings and
 * byte arrays) trap as `WebAssembly.RuntimeError` in release builds but throw a
 * plain `Error("invalid malloc request")` in debug builds; over-cap inside Rust
 * always aborts. Both leave the instance unusable.
 */
export function isFatalWasmError(error: unknown): boolean {
  if (typeof WebAssembly !== "undefined" && error instanceof WebAssembly.RuntimeError) return true;
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /malloc|unreachable|memory access out of bounds/i.test(message);
}
