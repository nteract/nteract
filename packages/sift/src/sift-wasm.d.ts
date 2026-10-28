declare module "sift-wasm/sift_wasm.js" {
  const init: (options?: unknown) => Promise<void> | void;
  export default init;
  /** Per-column footer statistics for an open Parquet file (see `ParquetFileStatsJson`). */
  export function parquet_file_column_stats(file: number): unknown;
  /** Null count per top-level column over resident rows. */
  export function store_null_counts(handle: number): Uint32Array;
  /** Rows and retained Arrow bytes an open Parquet file has committed so far. */
  export function parquet_file_usage(file: number): { rows: number; decoded_bytes: number };
}
