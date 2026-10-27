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

// Rows and retained Arrow bytes an open Parquet file has committed so far.
export function parquet_file_usage(_file) {
  return { rows: 0, decoded_bytes: 0 };
}

// Allocation accounting (`alloc_cap.rs`). The stub never allocates.
let allocationCap = 0;
export function set_allocation_cap(bytes) {
  allocationCap = bytes;
}
export function allocated_bytes() {
  return 0;
}
export function peak_allocated_bytes() {
  return 0;
}
export function _allocation_cap_for_tests() {
  return allocationCap;
}
