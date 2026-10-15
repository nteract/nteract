/**
 * Byte-range Parquet loading.
 *
 * The host owns the file and answers `read(offset, length)`; Sift reads the
 * footer, then fetches and decodes one row group at a time. The whole file is
 * never buffered in JS or WASM memory. Decoded row groups append to one WASM
 * store, so the table can mount after the first group and grow as the rest
 * arrive.
 */
import {
  applyColumnOverrides,
  applyParquetColumnHints,
  pandasIndexColumnsFromHints,
  typeOverridesFromHints,
} from "./parquet-features";
import { ensureModule } from "./predicate";
import type { Column, TableData } from "./table";
import { updateWasmSummaries } from "./wasm-summaries";
import { createWasmTableData } from "./wasm-table-data";

/**
 * Random-access bytes. `read` resolves with exactly `length` bytes starting at
 * `offset`; both are within `[0, byteLength]`. Hosts back this with a file
 * handle, an IPC call, or an HTTP `Range` request. The optional signal is
 * aborted when Sift no longer needs the bytes (unmount, source change).
 */
export interface ByteSource {
  readonly byteLength: number;
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
}

/** Wrap an in-memory buffer as a ByteSource. */
export function byteSourceFromBytes(bytes: Uint8Array): ByteSource {
  return {
    byteLength: bytes.byteLength,
    read(offset, length) {
      return Promise.resolve(bytes.subarray(offset, offset + length));
    },
  };
}

/** Limits already validated by the caller (see `loadTableFile`). */
export type ParquetFileLimits = {
  maxRows: number;
  maxColumns: number;
  maxDecodedBytes: number;
};

export type OpenParquetFileOptions = {
  limits: ParquetFileLimits;
  columnOverrides?: Record<string, Partial<Column>>;
  signal?: AbortSignal;
};

/** Result of appending one row group. */
export type ParquetAppendResult = {
  rowsAppended: number;
  /**
   * Set when data-driven type refinement (for example image detection)
   * changed a column type. Hand it to the engine with `replaceData`. The
   * previous lease has already been released; the engine may keep rendering
   * from it until the swap because the store lives on through this one.
   */
  replaced: TableData | null;
};

export type OpenParquetFile = {
  /** Row count from the footer. */
  readonly rowCount: number;
  readonly rowGroupCount: number;
  /** Rows per row group, in file order. */
  readonly rowGroupRows: readonly number[];
  /** Current table lease. Replaced when an append refines column types. */
  readonly tableData: TableData;
  readonly columns: Column[];
  /** Rows resident in the store so far. */
  readonly loadedRows: number;
  /**
   * Fetch the row group's column chunks and decode them into the store.
   * Append row groups in file order, one at a time. Updates `tableData`'s
   * row count and summaries before resolving.
   */
  appendRowGroup(index: number): Promise<ParquetAppendResult>;
  /** Mark the store complete and release footer metadata. Call after the last append. */
  finish(): ParquetAppendResult;
  /** Release footer metadata only. The store and its leases stay valid. */
  close(): void;
  /**
   * Release the file and the current table lease, freeing the store. Use when
   * the table was never mounted or the load was cancelled before mount. Once
   * the engine owns `tableData`, call `close()` instead; the engine frees the
   * store when it tears down. Superseded leases are released as they are
   * replaced, so the current lease is the only one outstanding.
   */
  dispose(): void;
};

/** Bytes read from the end of the file on open; covers most footers in one read. */
const INITIAL_TAIL_BYTES = 64 * 1024;
/** Column chunks closer than this are fetched as one range. */
const COALESCE_GAP_BYTES = 64 * 1024;
const FOOTER_BYTES = 8;
/** Leading magic plus footer length plus trailing magic. */
const MIN_PARQUET_BYTES = 4 + FOOTER_BYTES;

function isUint8Array(value: unknown): value is Uint8Array {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

function isParquetMagic(bytes: Uint8Array, at: number): boolean {
  return (
    bytes[at] === 0x50 && bytes[at + 1] === 0x41 && bytes[at + 2] === 0x52 && bytes[at + 3] === 0x31
  );
}

/** `source.read` with bounds and result validation. */
export async function readExact(
  source: ByteSource,
  offset: number,
  length: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  if (
    !Number.isInteger(offset) ||
    !Number.isInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > source.byteLength
  ) {
    throw new Error(`Byte range ${offset}+${length} lies outside the file (${source.byteLength})`);
  }
  const bytes = await source.read(offset, length, signal);
  signal?.throwIfAborted();
  // Not `instanceof`: bytes may come from another realm (worker, iframe, Node).
  if (!isUint8Array(bytes) || bytes.byteLength !== length) {
    throw new Error(
      `ByteSource.read(${offset}, ${length}) returned ${bytes?.byteLength ?? "no"} bytes`,
    );
  }
  return bytes;
}

type Range = { offset: number; length: number };

/** Merge column chunk ranges that touch or sit within `COALESCE_GAP_BYTES`. */
export function coalesceRanges(flat: ArrayLike<number>, gap = COALESCE_GAP_BYTES): Range[] {
  const ranges: Range[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) {
    ranges.push({ offset: flat[i], length: flat[i + 1] });
  }
  ranges.sort((a, b) => a.offset - b.offset);
  const merged: Range[] = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.offset <= last.offset + last.length + gap) {
      const end = Math.max(last.offset + last.length, range.offset + range.length);
      last.length = end - last.offset;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
}

/**
 * Read the footer, validate it, and prepare an empty store with the file's
 * schema. Rejects on bad magic before any other read. Admission limits are
 * checked from the footer here and again as each row group is appended.
 */
export async function openParquetFile(
  source: ByteSource,
  options: OpenParquetFileOptions,
): Promise<OpenParquetFile> {
  const { limits, columnOverrides, signal } = options;
  const byteLength = source.byteLength;
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new Error("ByteSource.byteLength must be a non-negative integer");
  }
  if (byteLength < MIN_PARQUET_BYTES) {
    throw new Error("Table file is too small to be a Parquet file");
  }

  let tailLength = Math.min(byteLength, INITIAL_TAIL_BYTES);
  let tail = await readExact(source, byteLength - tailLength, tailLength, signal);
  if (!isParquetMagic(tail, tail.byteLength - 4)) {
    throw new Error("Not a Parquet file: missing PAR1 footer magic");
  }

  const mod = await ensureModule();
  signal?.throwIfAborted();
  const footerLength = mod.parquet_footer_length(tail.subarray(tail.byteLength - FOOTER_BYTES));
  const needed = footerLength + FOOTER_BYTES;
  if (needed + 4 > byteLength) {
    throw new Error("Parquet footer length exceeds the file length");
  }
  // The decoded footer lives in memory for the life of the file; a footer
  // claiming more than the whole decoded budget is rejected before it is read.
  if (footerLength > limits.maxDecodedBytes) {
    throw new Error(
      `Parquet footer exceeds decoded bytes limit (${footerLength} > ${limits.maxDecodedBytes})`,
    );
  }
  if (needed > tailLength) {
    tailLength = needed;
    tail = await readExact(source, byteLength - tailLength, tailLength, signal);
  }

  const file = mod.parquet_open(
    tail,
    byteLength,
    limits.maxRows,
    limits.maxColumns,
    limits.maxDecodedBytes,
  );
  let fileOpen = true;
  const closeFile = () => {
    if (!fileOpen) return;
    fileOpen = false;
    mod.parquet_close(file);
  };

  let store: number | undefined;
  try {
    const info = mod.parquet_file_info(file);
    const hints = mod.parquet_file_column_hints(file);
    const pandasIndexCols = pandasIndexColumnsFromHints(hints);
    store = mod.parquet_create_store(file);
    const storeHandle = store;
    const wasm = createWasmTableData(storeHandle);
    let tableData = wasm.tableData;
    let columns = wasm.columns;
    applyParquetColumnHints(columns, hints);
    applyColumnOverrides(columns, columnOverrides);
    // Type pins carried into every refresh so footer semantics survive appends.
    const refreshOverrides = typeOverridesFromHints(hints, columnOverrides);
    tableData.prefetchViewport = wasm.prefetchViewport;
    const installSummaries = (data: TableData, cols: Column[]) => {
      data.recomputeSummaries = () =>
        updateWasmSummaries(mod, storeHandle, data, cols, pandasIndexCols);
      data.recomputeSummaries();
    };
    installSummaries(tableData, columns);

    let loadedRows = 0;
    let finished = false;
    let appending = false;

    /**
     * Re-read column types after an append. A changed type mints a new lease;
     * the superseded lease is released here at once. The store stays alive
     * through the new lease, so an engine still rendering the old `TableData`
     * keeps working until it swaps in the replacement (`replaceData` then
     * releases the old lease again, a no-op). Without this, a lease that was
     * never handed to anyone, such as the empty pre-mount table or any lease
     * replaced during `loadTableFile`, would pin the store forever.
     */
    const refresh = (): TableData | null => {
      const refined = wasm.refreshColumnTypes(refreshOverrides);
      if (refined) {
        const superseded = tableData;
        tableData = refined;
        columns = refined.columns;
        tableData.prefetchViewport = wasm.prefetchViewport;
        installSummaries(tableData, columns);
        superseded.dispose?.();
      } else {
        tableData.recomputeSummaries?.();
      }
      return refined;
    };

    const rowGroupRows = info.row_group_rows.slice();

    return {
      rowCount: info.num_rows,
      rowGroupCount: info.num_row_groups,
      rowGroupRows,
      get tableData() {
        return tableData;
      },
      get columns() {
        return columns;
      },
      get loadedRows() {
        return loadedRows;
      },
      async appendRowGroup(index) {
        if (!fileOpen || finished) throw new Error("Parquet file is closed");
        if (appending) throw new Error("Append one Parquet row group at a time");
        appending = true;
        try {
          const ranges = coalesceRanges(mod.parquet_row_group_ranges(file, index));
          const parts = await Promise.all(
            ranges.map((range) => readExact(source, range.offset, range.length, signal)),
          );
          if (!fileOpen) throw new Error("Parquet file is closed");
          const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
          const data = new Uint8Array(total);
          const flat = new Float64Array(ranges.length * 2);
          let cursor = 0;
          ranges.forEach((range, i) => {
            data.set(parts[i], cursor);
            cursor += parts[i].byteLength;
            flat[i * 2] = range.offset;
            flat[i * 2 + 1] = range.length;
          });
          const rowsAppended = mod.parquet_append_row_group(file, storeHandle, index, flat, data);
          loadedRows += rowsAppended;
          const replaced = refresh();
          return { rowsAppended, replaced };
        } finally {
          appending = false;
        }
      },
      finish() {
        if (finished) return { rowsAppended: 0, replaced: null };
        finished = true;
        mod.finish_arrow_stream_store(storeHandle);
        const replaced = refresh();
        closeFile();
        return { rowsAppended: 0, replaced };
      },
      close: closeFile,
      dispose() {
        closeFile();
        tableData.dispose?.();
      },
    };
  } catch (error) {
    if (store !== undefined) mod.free(store);
    closeFile();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
