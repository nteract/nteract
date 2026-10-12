import { applyParquetColumnHints, pandasIndexColumnsFromHints } from "./parquet-features";
import { ensureModule } from "./predicate";
import type { TableData } from "./table";
import { updateWasmSummaries } from "./wasm-summaries";
import { createWasmTableData } from "./wasm-table-data";

export type TableFileOptions = {
  /** Auto-detected when omitted. Arrow support is uncompressed IPC streams. */
  format?: "parquet" | "arrow-ipc";
  /** Input byte limit, checked before WASM initialization. Default: 16 MiB. */
  maxBytes?: number;
  /** Maximum complete-file row count. Default: 100,000. */
  maxRows?: number;
  /** Maximum top-level columns (and Parquet leaf columns). Default: 256. */
  maxColumns?: number;
  /**
   * Parquet metadata estimate and retained Arrow memory limit. Default: 128 MiB.
   * The conservative estimate (2× uncompressed bytes + 16 bytes/leaf value)
   * can reject files below the other limits even when their Arrow data is small.
   * This is a loading guardrail, not a process memory sandbox: decoder batches,
   * dictionaries, summaries, copies, and other temporary allocations add memory.
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

/**
 * Load a complete local table from bytes without host, notebook, or kernel APIs.
 * No file content is fetched or uploaded. WASM assets load via the usual Sift
 * module configuration. Parquet and uncompressed Arrow IPC streams are supported.
 *
 * Files exceeding the limits fail; this API never samples or truncates rows.
 * Sorting, filtering, and summaries therefore operate on the entire loaded file.
 * Parquet admission checks rows, columns, and a decoded-size estimate before
 * decoding; retained Arrow memory is also checked after each decoded batch.
 * Numeric raw values, summaries, and range filters use f64/JavaScript numbers;
 * integers beyond the safe-integer range are approximate in those operations.
 * Float16 and Decimal numeric analysis remains unsupported by the Sift engine.
 *
 * The returned TableData owns its WASM store. In React, use a stable SiftTable
 * source `{ kind: "loader", load: () => loadTableFile(bytes) }` so each effect
 * gets fresh data, including StrictMode remounts. Imperative hosts may pass it
 * to createTable, whose engine disposes it on teardown. Call data.dispose() if
 * the result is never mounted; do not reuse disposed data for another mount.
 */
export async function loadTableFile(
  bytes: Uint8Array,
  options: TableFileOptions = {},
): Promise<TableData> {
  const maxBytes = limit(options.maxBytes, 16 * 1024 * 1024, "maxBytes");
  const maxRows = limit(options.maxRows, 100_000, "maxRows");
  const maxColumns = limit(options.maxColumns, 256, "maxColumns");
  const maxDecodedBytes = limit(options.maxDecodedBytes, 128 * 1024 * 1024, "maxDecodedBytes");
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
  const input = new Uint8Array(bytes);
  const mod = await ensureModule();
  let dispose: (() => void) | undefined;
  try {
    const handle =
      format === "parquet"
        ? mod.load_parquet_bounded(input, maxRows, maxColumns, maxDecodedBytes)
        : mod.load_ipc_bounded(input, maxRows, maxColumns, maxDecodedBytes);
    dispose = () => mod.free(handle);
    const hints =
      format === "parquet"
        ? mod.parquet_column_hints(input)
        : mod.arrow_ipc_column_hints_with_row_count(input, mod.num_rows(handle));
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
