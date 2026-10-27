// Stub for when sift-wasm hasn't been built.
// Tests using the `data` prop work fine without WASM.
// The `url` prop's parquet path will fail gracefully (ensureModule rejects).
export default function init() {
  throw new Error("sift-wasm not built — run: cargo xtask wasm sift");
}

// Footer statistics for an open Parquet file. Shape mirrors the Rust
// `ParquetFileStats`; a stub file has no columns and no rows.
export function parquet_file_column_stats(_file) {
  return { num_rows: 0, num_row_groups: 0, columns: [] };
}

// Null count per top-level column over resident rows.
export function store_null_counts(_handle) {
  return new Uint32Array(0);
}
