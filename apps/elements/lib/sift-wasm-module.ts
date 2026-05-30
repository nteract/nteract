type SiftWasmModule = Record<string, (...args: unknown[]) => unknown> & {
  default: (options?: unknown) => Promise<void> | void;
};

let modulePromise: Promise<SiftWasmModule> | null = null;
let loadedModule: SiftWasmModule | null = null;
const siftWasmPublicModule: string = "/wasm/sift_wasm.js";

async function loadModule(): Promise<SiftWasmModule> {
  modulePromise ??= import(/* webpackIgnore: true */ siftWasmPublicModule) as Promise<SiftWasmModule>;
  return modulePromise;
}

function getLoadedModule(): SiftWasmModule {
  if (!loadedModule) {
    throw new Error("sift-wasm is not initialized. Call default() before using exports.");
  }
  return loadedModule;
}

function delegate(name: string) {
  return (...args: unknown[]) => {
    const target = getLoadedModule()[name];
    if (typeof target !== "function") {
      throw new Error(`sift-wasm export ${name} is unavailable.`);
    }
    return target(...args);
  };
}

export default async function initialize(options?: unknown) {
  const mod = await loadModule();
  await mod.default(options);
  loadedModule = mod;
}

export const append_arrow_stream_chunk = delegate("append_arrow_stream_chunk");
export const arrow_ipc_column_hints = delegate("arrow_ipc_column_hints");
export const arrow_ipc_column_hints_with_row_count = delegate(
  "arrow_ipc_column_hints_with_row_count",
);
export const cast_column = delegate("cast_column");
export const col_names = delegate("col_names");
export const col_timezone = delegate("col_timezone");
export const col_type = delegate("col_type");
export const create_arrow_stream_store = delegate("create_arrow_stream_store");
export const filter_rows = delegate("filter_rows");
export const finish_arrow_stream_store = delegate("finish_arrow_stream_store");
export const free = delegate("free");
export const get_cell_bytes = delegate("get_cell_bytes");
export const get_cell_f64 = delegate("get_cell_f64");
export const get_cell_image_bytes_at = delegate("get_cell_image_bytes_at");
export const get_cell_image_count = delegate("get_cell_image_count");
export const get_cell_string = delegate("get_cell_string");
export const get_viewport = delegate("get_viewport");
export const get_viewport_by_indices = delegate("get_viewport_by_indices");
export const has_original_column = delegate("has_original_column");
export const histogram = delegate("histogram");
export const is_null = delegate("is_null");
export const load_ipc = delegate("load_ipc");
export const load_parquet = delegate("load_parquet");
export const load_parquet_row_group = delegate("load_parquet_row_group");
export const num_cols = delegate("num_cols");
export const num_rows = delegate("num_rows");
export const parquet_column_hints = delegate("parquet_column_hints");
export const parquet_metadata = delegate("parquet_metadata");
export const store_bool_counts = delegate("store_bool_counts");
export const store_filter_rows = delegate("store_filter_rows");
export const store_filtered_bool_counts = delegate("store_filtered_bool_counts");
export const store_filtered_histogram = delegate("store_filtered_histogram");
export const store_filtered_value_counts = delegate("store_filtered_value_counts");
export const store_histogram = delegate("store_histogram");
export const store_sort_indices = delegate("store_sort_indices");
export const store_temporal_histogram = delegate("store_temporal_histogram");
export const store_value_counts = delegate("store_value_counts");
export const store_viewport_cells = delegate("store_viewport_cells");
export const string_contains = delegate("string_contains");
export const undo_cast_column = delegate("undo_cast_column");
export const value_counts = delegate("value_counts");
