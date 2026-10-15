import { applyParquetColumnHints, pandasIndexColumnsFromHints } from "./parquet-features";
import { type ByteSource, openParquetFile, type ParquetFileLimits } from "./parquet-file";
import { ensureModule } from "./predicate";
import type { TableData } from "./table";
import { updateWasmSummaries } from "./wasm-summaries";
import { createWasmTableData } from "./wasm-table-data";

export type TableFileOptions = {
  /**
   * Auto-detected from magic bytes when omitted. Arrow support is
   * uncompressed IPC streams. A `ByteSource` defaults to Parquet.
   */
  format?: "parquet" | "arrow-ipc";
  /**
   * Input byte limit for in-memory buffers, checked before WASM
   * initialization. Default: 16 MiB. Not applied to a `ByteSource`: ranged
   * reads never buffer the file, so `maxDecodedBytes` is the cap there.
   */
  maxBytes?: number;
  /** Maximum complete-file row count. Default: 100,000. */
  maxRows?: number;
  /** Maximum top-level columns (and Parquet leaf columns). Default: 256. */
  maxColumns?: number;
  /**
   * Retained Arrow memory limit, checked after each decoded batch. Default:
   * 128 MiB. Parquet files whose fixed-width values alone exceed it are
   * rejected from footer metadata before decoding. This is a loading
   * guardrail, not a sandbox: the decoder can allocate one batch past the limit
   * before the check runs, and summaries and copies add memory on top.
   */
  maxDecodedBytes?: number;
};

function limit(value: number | undefined, fallback: number, name: string): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result <= 0 || result > 0xffff_ffff) {
    throw new Error(`${name} must be a positive integer no greater than 4294967295`);
  }
  return result;
}

/** Validate the limits shared by both load paths. */
export function resolveTableFileLimits(options: TableFileOptions): ParquetFileLimits {
  return {
    maxRows: limit(options.maxRows, 100_000, "maxRows"),
    maxColumns: limit(options.maxColumns, 256, "maxColumns"),
    maxDecodedBytes: limit(options.maxDecodedBytes, 128 * 1024 * 1024, "maxDecodedBytes"),
  };
}

function isByteSource(input: Uint8Array | ByteSource): input is ByteSource {
  return !(input instanceof Uint8Array) && typeof (input as ByteSource).read === "function";
}

/**
 * Load a complete local table without host, notebook, or kernel APIs. No file
 * content is fetched or uploaded. WASM assets load via the usual Sift module
 * configuration. Parquet and uncompressed Arrow IPC streams are supported.
 *
 * Pass a `Uint8Array` for a file already in memory, or a `ByteSource` to let
 * Sift read only the Parquet footer and column chunks it needs. Both resolve
 * only once every row is decoded, so the result is complete or an error.
 *
 * Files exceeding the limits fail; this API never samples or truncates rows.
 * Sorting, filtering, and summaries therefore operate on the entire loaded file.
 * Numeric raw values, summaries, and range filters use f64/JavaScript numbers;
 * integers beyond the safe-integer range are approximate in those operations.
 *
 * The returned TableData owns its WASM store. In React, use a stable SiftTable
 * source `{ kind: "loader", load: () => loadTableFile(bytes) }` so each effect
 * gets fresh data, including StrictMode remounts. Imperative hosts may pass it
 * to createTable, whose engine disposes it on teardown. Call data.dispose() if
 * the result is never mounted; do not reuse disposed data for another mount.
 */
export async function loadTableFile(
  input: Uint8Array | ByteSource,
  options: TableFileOptions = {},
): Promise<TableData> {
  const maxBytes = limit(options.maxBytes, 16 * 1024 * 1024, "maxBytes");
  const limits = resolveTableFileLimits(options);
  const { maxRows, maxColumns, maxDecodedBytes } = limits;
  if (isByteSource(input)) {
    const format = options.format ?? "parquet";
    if (format === "parquet") return loadParquetFromByteSource(input, limits);
    if (format !== "arrow-ipc") throw new Error(`Unsupported table file format: ${format}`);
    // Arrow IPC streams have no footer to seek into; read them whole.
    if (input.byteLength > maxBytes) {
      throw new Error(`Table file exceeds input bytes limit (${input.byteLength} > ${maxBytes})`);
    }
    const bytes = await input.read(0, input.byteLength);
    return loadTableFile(bytes, { ...options, format });
  }
  const bytes = input;
  if (bytes.byteLength > maxBytes) {
    throw new Error(`Table file exceeds input bytes limit (${bytes.byteLength} > ${maxBytes})`);
  }
  if (bytes.byteLength === 0) throw new Error("Table file is empty");
  const format =
    options.format ??
    (bytes[0] === 0x50 && bytes[1] === 0x41 && bytes[2] === 0x52 && bytes[3] === 0x31
      ? "parquet"
      : "arrow-ipc");
  if (format !== "parquet" && format !== "arrow-ipc") {
    throw new Error(`Unsupported table file format: ${format}`);
  }
  // Own a snapshot before the first await, so caller mutation during WASM
  // initialization cannot change the validated file or its format.
  const snapshot = new Uint8Array(bytes);
  const mod = await ensureModule();
  let dispose: (() => void) | undefined;
  try {
    const handle =
      format === "parquet"
        ? mod.load_parquet_bounded(snapshot, maxRows, maxColumns, maxDecodedBytes)
        : mod.load_ipc_bounded(snapshot, maxRows, maxColumns, maxDecodedBytes);
    dispose = () => mod.free(handle);
    const hints =
      format === "parquet"
        ? mod.parquet_column_hints(snapshot)
        : mod.arrow_ipc_column_hints_with_row_count(snapshot, mod.num_rows(handle));
    const { tableData, columns, prefetchViewport } = createWasmTableData(handle);
    dispose = tableData.dispose;
    applyParquetColumnHints(columns, hints);
    const pandasIndexCols = pandasIndexColumnsFromHints(hints);
    tableData.prefetchViewport = prefetchViewport;
    tableData.recomputeSummaries = () =>
      updateWasmSummaries(mod, handle, tableData, columns, pandasIndexCols);
    tableData.recomputeSummaries();
    return tableData;
  } catch (error) {
    dispose?.();
    // wasm-bindgen may throw a string; host error states should receive Error.
    throw error instanceof Error ? error : new Error(String(error));
  }
}

async function loadParquetFromByteSource(
  source: ByteSource,
  limits: ParquetFileLimits,
): Promise<TableData> {
  const file = await openParquetFile(source, { limits });
  try {
    for (let group = 0; group < file.rowGroupCount; group++) {
      await file.appendRowGroup(group);
    }
    file.finish();
    return file.tableData;
  } catch (error) {
    file.dispose();
    throw error instanceof Error ? error : new Error(String(error));
  }
}
