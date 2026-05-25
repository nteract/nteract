use arrow::array::{
    Array, BinaryArray, BinaryViewArray, BooleanArray, Float64Array, Int32Array, Int64Array,
    LargeBinaryArray, LargeListArray, LargeStringArray, ListArray, StringArray, StructArray,
    UInt32Array, UInt64Array,
};
use arrow::datatypes::{DataType, TimeUnit};
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;
use arrow_cast::display::ArrayFormatter;
use arrow_ord::sort::{sort_to_indices, SortOptions};
use arrow_select::concat::concat;
use chrono::DateTime;
use nteract_predicate::summary::{CategoryCount, HistogramBin};
use nteract_predicate::{
    arrow_ipc_column_hints as predicate_arrow_ipc_column_hints,
    arrow_ipc_column_hints_with_row_count as predicate_arrow_ipc_column_hints_with_row_count,
    parquet_column_hints as predicate_parquet_column_hints,
};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

const MAX_INLINE_BINARY_BYTES: usize = 512;

/// A loaded dataset stored in WASM memory.
struct DataStore {
    schema: Option<Arc<arrow::datatypes::Schema>>,
    batches: Vec<RecordBatch>,
    /// Prefix sum of batch row counts for O(log n) row→batch lookup
    batch_offsets: Vec<usize>,
    total_rows: usize,
    num_cols: usize,
    col_names: Vec<String>,
    col_types: Vec<String>, // "numeric", "categorical", "boolean", "timestamp", "image"
    col_timezones: Vec<Option<String>>,
    /// Original column arrays saved before casting, keyed by column index.
    /// Used to restore original data when casting back to the original type.
    original_columns: HashMap<usize, (Vec<arrow::array::ArrayRef>, String)>,
    streaming_complete: bool,
}

#[derive(Serialize)]
struct ViewportCells {
    rows: Vec<u32>,
    strings: Vec<String>,
    numeric_values: Vec<Option<f64>>,
    nulls: Vec<bool>,
}

impl DataStore {
    fn resolve_row(&self, row: usize) -> Option<(usize, usize)> {
        if row >= self.total_rows {
            return None;
        }
        // Binary search for the batch containing this row
        let batch_idx = match self.batch_offsets.binary_search(&row) {
            Ok(i) => i,
            Err(i) => i - 1,
        };
        let local_row = row - self.batch_offsets[batch_idx];
        Some((batch_idx, local_row))
    }

    fn extract_timezone(dt: &DataType) -> Option<String> {
        match dt {
            DataType::Timestamp(_, Some(tz)) if !tz.is_empty() => Some(tz.to_string()),
            _ => None,
        }
    }

    fn detect_col_type(dt: &DataType) -> &'static str {
        if is_image_like_data_type(dt) {
            return "image";
        }

        match dt {
            DataType::Boolean => "boolean",
            DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Float16
            | DataType::Float32
            | DataType::Float64
            | DataType::Decimal128(_, _)
            | DataType::Decimal256(_, _) => "numeric",
            DataType::Timestamp(_, _) | DataType::Date32 | DataType::Date64 => "timestamp",
            _ => "categorical",
        }
    }
}

fn is_binary_data_type(dt: &DataType) -> bool {
    matches!(
        dt,
        DataType::Binary | DataType::LargeBinary | DataType::BinaryView
    )
}

fn is_image_struct_data_type(dt: &DataType) -> bool {
    let DataType::Struct(fields) = dt else {
        return false;
    };

    let has_bytes = fields
        .iter()
        .any(|field| field.name() == "bytes" && is_binary_data_type(field.data_type()));
    let has_path = fields.iter().any(|field| field.name() == "path");

    has_bytes && has_path
}

fn is_image_like_data_type(dt: &DataType) -> bool {
    if is_image_struct_data_type(dt) {
        return true;
    }

    match dt {
        DataType::List(field) | DataType::LargeList(field) => {
            is_image_struct_data_type(field.data_type())
        }
        _ => false,
    }
}

fn format_byte_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KiB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1} MiB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn binary_value_len(column: &dyn Array, row: usize) -> Option<usize> {
    match column.data_type() {
        DataType::Binary => column
            .as_any()
            .downcast_ref::<BinaryArray>()
            .map(|a| a.value(row).len()),
        DataType::LargeBinary => column
            .as_any()
            .downcast_ref::<LargeBinaryArray>()
            .map(|a| a.value(row).len()),
        DataType::BinaryView => column
            .as_any()
            .downcast_ref::<BinaryViewArray>()
            .map(|a| a.value(row).len()),
        _ => None,
    }
}

fn list_value_len(column: &dyn Array, row: usize) -> Option<usize> {
    match column.data_type() {
        DataType::List(_) => column
            .as_any()
            .downcast_ref::<ListArray>()
            .map(|a| a.value_length(row) as usize),
        DataType::LargeList(_) => column
            .as_any()
            .downcast_ref::<LargeListArray>()
            .map(|a| a.value_length(row) as usize),
        _ => None,
    }
}

fn binary_payload_exceeds(column: &dyn Array, row: usize, remaining: &mut usize) -> bool {
    if cell_is_null(column, row) {
        return false;
    }

    if let Some(len) = binary_value_len(column, row) {
        if len > *remaining {
            return true;
        }
        *remaining -= len;
        return false;
    }

    match column.data_type() {
        DataType::Struct(_) => {
            let Some(s) = column.as_any().downcast_ref::<StructArray>() else {
                return false;
            };
            s.columns()
                .iter()
                .any(|child| binary_payload_exceeds(child.as_ref(), row, remaining))
        }
        DataType::List(_) => column
            .as_any()
            .downcast_ref::<ListArray>()
            .map(|a| binary_payload_array_exceeds(a.value(row).as_ref(), remaining))
            .unwrap_or(false),
        DataType::LargeList(_) => column
            .as_any()
            .downcast_ref::<LargeListArray>()
            .map(|a| binary_payload_array_exceeds(a.value(row).as_ref(), remaining))
            .unwrap_or(false),
        _ => false,
    }
}

fn binary_payload_array_exceeds(array: &dyn Array, remaining: &mut usize) -> bool {
    for row in 0..array.len() {
        if binary_payload_exceeds(array, row, remaining) {
            return true;
        }
    }
    false
}

fn compact_binary_cell_string(column: &dyn Array, row: usize) -> Option<String> {
    let mut remaining = MAX_INLINE_BINARY_BYTES;
    if !binary_payload_exceeds(column, row, &mut remaining) {
        return None;
    }

    if let Some(item_count) = list_value_len(column, row) {
        return Some(format!("list of size {}", item_count));
    }

    if let Some(byte_count) = binary_value_len(column, row) {
        return Some(format!("bytes ({})", format_byte_size(byte_count)));
    }

    if matches!(column.data_type(), DataType::Struct(_)) {
        return Some("struct (binary data)".to_string());
    }

    Some("binary data".to_string())
}

fn cell_is_null(column: &dyn Array, row: usize) -> bool {
    matches!(column.data_type(), DataType::Null) || column.is_null(row)
}

// Global store: handle → DataStore
static STORES: Mutex<Option<HashMap<u32, DataStore>>> = Mutex::new(None);
static NEXT_HANDLE: Mutex<u32> = Mutex::new(1);

fn with_stores<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<u32, DataStore>) -> R,
{
    // wasm32 is single-threaded, so poisoning only occurs if a prior call
    // panicked while holding the lock. Recover the inner value and carry on.
    let mut guard = STORES.lock().unwrap_or_else(|e| e.into_inner());
    let stores = guard.get_or_insert_with(HashMap::new);
    f(stores)
}

fn with_store<F, R>(handle: u32, f: F) -> Result<R, String>
where
    F: FnOnce(&DataStore) -> R,
{
    with_stores(|stores| {
        stores
            .get(&handle)
            .map(f)
            .ok_or_else(|| format!("Invalid handle: {}", handle))
    })
}

fn schema_metadata(
    schema: &arrow::datatypes::Schema,
) -> (usize, Vec<String>, Vec<String>, Vec<Option<String>>) {
    let num_cols = schema.fields().len();
    let col_names: Vec<String> = schema.fields().iter().map(|f| f.name().clone()).collect();
    let col_types: Vec<String> = schema
        .fields()
        .iter()
        .map(|f| DataStore::detect_col_type(f.data_type()).to_string())
        .collect();
    let col_timezones: Vec<Option<String>> = schema
        .fields()
        .iter()
        .map(|f| DataStore::extract_timezone(f.data_type()))
        .collect();

    (num_cols, col_names, col_types, col_timezones)
}

fn empty_streaming_store() -> DataStore {
    DataStore {
        schema: None,
        batches: Vec::new(),
        batch_offsets: Vec::new(),
        total_rows: 0,
        num_cols: 0,
        col_names: Vec::new(),
        col_types: Vec::new(),
        col_timezones: Vec::new(),
        original_columns: HashMap::new(),
        streaming_complete: false,
    }
}

fn set_store_schema(store: &mut DataStore, schema: Arc<arrow::datatypes::Schema>) {
    let (num_cols, col_names, col_types, col_timezones) = schema_metadata(&schema);
    store.schema = Some(schema);
    store.num_cols = num_cols;
    store.col_names = col_names;
    store.col_types = col_types;
    store.col_timezones = col_timezones;
}

fn append_batches_to_store(
    store: &mut DataStore,
    schema: Arc<arrow::datatypes::Schema>,
    batches: Vec<RecordBatch>,
) -> Result<(), String> {
    if store.streaming_complete {
        return Err("Arrow stream store is already finished".to_string());
    }

    if let Some(existing) = &store.schema {
        if existing.as_ref() != schema.as_ref() {
            return Err("Arrow stream chunk schema mismatch".to_string());
        }
    } else {
        set_store_schema(store, schema);
    }

    for batch in batches {
        store.batch_offsets.push(store.total_rows);
        store.total_rows += batch.num_rows();
        store.batches.push(batch);
    }

    Ok(())
}

fn arrow_stream_batches(
    ipc_bytes: &[u8],
) -> Result<(Arc<arrow::datatypes::Schema>, Vec<RecordBatch>), String> {
    let cursor = Cursor::new(ipc_bytes);
    let reader = StreamReader::try_new(cursor, None).map_err(|e| e.to_string())?;
    let schema = reader.schema();
    let mut batches = Vec::new();
    for batch in reader {
        batches.push(batch.map_err(|e| e.to_string())?);
    }
    Ok((schema, batches))
}

/// Store a vec of RecordBatches, returning a handle.
fn store_batches(
    batches: Vec<RecordBatch>,
    schema: Arc<arrow::datatypes::Schema>,
) -> Result<u32, String> {
    let mut store = empty_streaming_store();
    append_batches_to_store(&mut store, schema, batches)?;
    store.streaming_complete = true;

    let handle = {
        let mut h = NEXT_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
        let id = *h;
        *h += 1;
        id
    };

    with_stores(|stores| {
        stores.insert(handle, store);
    });

    Ok(handle)
}

/// Load Arrow IPC bytes into WASM memory. Returns a handle for subsequent operations.
#[wasm_bindgen]
pub fn load_ipc(ipc_bytes: &[u8]) -> Result<u32, JsValue> {
    let cursor = Cursor::new(ipc_bytes);
    let reader =
        StreamReader::try_new(cursor, None).map_err(|e| JsValue::from_str(&e.to_string()))?;
    let schema = reader.schema();

    let mut batches = Vec::new();
    for batch in reader {
        batches.push(batch.map_err(|e| JsValue::from_str(&e.to_string()))?);
    }

    store_batches(batches, schema).map_err(|e| JsValue::from_str(&e))
}

/// Load Parquet bytes into WASM memory. Returns a handle for subsequent operations.
/// This replaces the need for parquet-wasm — one WASM binary for everything.
#[wasm_bindgen]
pub fn load_parquet(parquet_bytes: &[u8]) -> Result<u32, JsValue> {
    let bytes = bytes::Bytes::copy_from_slice(parquet_bytes);
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let schema = builder.schema().clone();
    let reader = builder
        .build()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut batches = Vec::new();
    for batch in reader {
        batches.push(batch.map_err(|e| JsValue::from_str(&e.to_string()))?);
    }

    store_batches(batches, schema).map_err(|e| JsValue::from_str(&e))
}

/// Create an empty Arrow stream store. Append self-contained Arrow IPC stream
/// chunks with `append_arrow_stream_chunk`, then call `finish_arrow_stream_store`
/// when the manifest is complete.
#[wasm_bindgen]
pub fn create_arrow_stream_store() -> u32 {
    let handle = {
        let mut h = NEXT_HANDLE.lock().unwrap_or_else(|e| e.into_inner());
        let id = *h;
        *h += 1;
        id
    };

    with_stores(|stores| {
        stores.insert(handle, empty_streaming_store());
    });

    handle
}

/// Append one self-contained Arrow IPC stream chunk into an existing store.
/// The first chunk initializes the store schema; later chunks must match it.
#[wasm_bindgen]
pub fn append_arrow_stream_chunk(handle: u32, ipc_bytes: &[u8]) -> Result<(), JsValue> {
    let (schema, batches) = arrow_stream_batches(ipc_bytes).map_err(|e| JsValue::from_str(&e))?;
    with_stores(|stores| {
        let store = stores
            .get_mut(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("Invalid handle: {}", handle)))?;
        append_batches_to_store(store, schema, batches).map_err(|e| JsValue::from_str(&e))
    })
}

/// Mark an Arrow stream store as complete. Further chunk appends are rejected.
#[wasm_bindgen]
pub fn finish_arrow_stream_store(handle: u32) -> Result<(), JsValue> {
    with_stores(|stores| {
        let store = stores
            .get_mut(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("Invalid handle: {}", handle)))?;
        store.streaming_complete = true;
        Ok(())
    })
}

/// Free a loaded dataset from WASM memory.
#[wasm_bindgen]
pub fn free(handle: u32) {
    with_stores(|stores| {
        stores.remove(&handle);
    });
}

/// Get the number of rows in a loaded dataset.
#[wasm_bindgen]
pub fn num_rows(handle: u32) -> Result<u32, JsValue> {
    with_store(handle, |s| s.total_rows as u32).map_err(|e| JsValue::from_str(&e))
}

/// Get the number of columns in a loaded dataset.
#[wasm_bindgen]
pub fn num_cols(handle: u32) -> Result<u32, JsValue> {
    with_store(handle, |s| s.num_cols as u32).map_err(|e| JsValue::from_str(&e))
}

/// Get column names as a JSON array.
#[wasm_bindgen]
pub fn col_names(handle: u32) -> Result<JsValue, JsValue> {
    with_store(handle, |s| {
        // Returns Vec<String> — trivial serialization
        serde_wasm_bindgen::to_value(&s.col_names).unwrap_or(JsValue::NULL)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Get the detected type of a column ("numeric", "categorical", "boolean", "timestamp").
#[wasm_bindgen]
pub fn col_type(handle: u32, col: usize) -> Result<String, JsValue> {
    with_store(handle, |s| {
        s.col_types.get(col).cloned().unwrap_or_default()
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Get the IANA timezone of a timestamp column, or null if not set.
#[wasm_bindgen]
pub fn col_timezone(handle: u32, col: usize) -> Result<Option<String>, JsValue> {
    with_store(handle, |s| s.col_timezones.get(col).cloned().flatten())
        .map_err(|e| JsValue::from_str(&e))
}

/// Check if a cell is null.
#[wasm_bindgen]
pub fn is_null(handle: u32, row: usize, col: usize) -> Result<bool, JsValue> {
    with_store(handle, |s| {
        let (batch_idx, local_row) = s.resolve_row(row).unwrap_or((0, 0));
        let column = s.batches[batch_idx].column(col);
        cell_is_null(column.as_ref(), local_row)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Extract a single timestamp cell as epoch milliseconds. Returns None for
/// non-timestamp types or if the downcast fails.
fn timestamp_cell_ms(column: &dyn Array, local_row: usize) -> Option<i64> {
    match column.data_type() {
        DataType::Timestamp(TimeUnit::Millisecond, _) => column
            .as_any()
            .downcast_ref::<arrow::array::TimestampMillisecondArray>()
            .map(|a| a.value(local_row)),
        DataType::Timestamp(TimeUnit::Microsecond, _) => column
            .as_any()
            .downcast_ref::<arrow::array::TimestampMicrosecondArray>()
            .map(|a| a.value(local_row) / 1000),
        DataType::Timestamp(TimeUnit::Nanosecond, _) => column
            .as_any()
            .downcast_ref::<arrow::array::TimestampNanosecondArray>()
            .map(|a| a.value(local_row) / 1_000_000),
        DataType::Timestamp(TimeUnit::Second, _) => column
            .as_any()
            .downcast_ref::<arrow::array::TimestampSecondArray>()
            .map(|a| a.value(local_row) * 1000),
        DataType::Date32 => column
            .as_any()
            .downcast_ref::<arrow::array::Date32Array>()
            .map(|a| a.value(local_row) as i64 * 86_400_000),
        DataType::Date64 => column
            .as_any()
            .downcast_ref::<arrow::array::Date64Array>()
            .map(|a| a.value(local_row)),
        _ => None,
    }
}

/// Format epoch milliseconds for display, respecting the column timezone.
/// Date-only types (Date32/Date64) use "Apr 23, 2026".
/// Timestamp types with time precision use "Apr 23, 2026, 7:30 AM".
fn format_timestamp_ms(ms: i64, tz: Option<&str>, has_time: bool) -> String {
    use chrono_tz::Tz;
    let secs = ms / 1000;
    let nanos = ((ms % 1000) * 1_000_000) as u32;
    let Some(utc_dt) = DateTime::from_timestamp(secs, nanos) else {
        return ms.to_string();
    };
    let fmt = if has_time {
        "%b %-d, %Y, %-I:%M %p"
    } else {
        "%b %-d, %Y"
    };
    match tz.and_then(|s| s.parse::<Tz>().ok()) {
        Some(tz) => utc_dt.with_timezone(&tz).format(fmt).to_string(),
        None => utc_dt.format(fmt).to_string(),
    }
}

fn cell_string_for(store: &DataStore, col: usize, column: &dyn Array, local_row: usize) -> String {
    if cell_is_null(column, local_row) {
        return String::new();
    }

    if matches!(store.col_types.get(col).map(String::as_str), Some("image")) {
        return String::new();
    }

    if let Some(compact) = compact_binary_cell_string(column, local_row) {
        return compact;
    }

    // Strings (Utf8 / LargeUtf8 / Utf8View / Dict<string>) route through
    // the shared helper so all variants dispatch correctly.
    if let Some(s) = nteract_predicate::arrow_utils::string_at(column, local_row) {
        return s;
    }

    // Timestamps → human-readable date in the column's timezone (or UTC)
    if let Some(ms) = timestamp_cell_ms(column, local_row) {
        let tz = store.col_timezones.get(col).and_then(|t| t.as_deref());
        let has_time = matches!(column.data_type(), DataType::Timestamp(_, _));
        return format_timestamp_ms(ms, tz, has_time);
    }

    match column.data_type() {
        DataType::Boolean => column
            .as_any()
            .downcast_ref::<BooleanArray>()
            .map(|a| {
                if a.value(local_row) {
                    "Yes".into()
                } else {
                    "No".into()
                }
            })
            .unwrap_or_default(),
        DataType::Int32 => column
            .as_any()
            .downcast_ref::<Int32Array>()
            .map(|a| a.value(local_row).to_string())
            .unwrap_or_default(),
        DataType::Int64 => column
            .as_any()
            .downcast_ref::<Int64Array>()
            .map(|a| a.value(local_row).to_string())
            .unwrap_or_default(),
        DataType::Float64 => column
            .as_any()
            .downcast_ref::<Float64Array>()
            .map(|a| format!("{}", a.value(local_row)))
            .unwrap_or_default(),
        _ => ArrayFormatter::try_new(column, &Default::default())
            .ok()
            .map(|f| f.value(local_row).to_string())
            .unwrap_or_default(),
    }
}

fn cell_f64_for(column: &dyn Array, local_row: usize) -> f64 {
    if cell_is_null(column, local_row) {
        return f64::NAN;
    }

    // Timestamps → epoch ms as f64
    if let Some(ms) = timestamp_cell_ms(column, local_row) {
        return ms as f64;
    }

    match column.data_type() {
        DataType::Float64 => column
            .as_any()
            .downcast_ref::<Float64Array>()
            .map(|a| a.value(local_row))
            .unwrap_or(f64::NAN),
        DataType::Int32 => column
            .as_any()
            .downcast_ref::<Int32Array>()
            .map(|a| a.value(local_row) as f64)
            .unwrap_or(f64::NAN),
        DataType::Int64 => column
            .as_any()
            .downcast_ref::<Int64Array>()
            .map(|a| a.value(local_row) as f64)
            .unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

fn viewport_cells_for(s: &DataStore, rows: &[u32]) -> ViewportCells {
    let cell_count = rows.len().saturating_mul(s.num_cols);
    let mut out = ViewportCells {
        rows: Vec::with_capacity(rows.len()),
        strings: Vec::with_capacity(cell_count),
        numeric_values: Vec::with_capacity(cell_count),
        nulls: Vec::with_capacity(cell_count),
    };

    for &row_u32 in rows {
        out.rows.push(row_u32);
        let Some((batch_idx, local_row)) = s.resolve_row(row_u32 as usize) else {
            for _ in 0..s.num_cols {
                out.strings.push(String::new());
                out.numeric_values.push(None);
                out.nulls.push(true);
            }
            continue;
        };

        let batch = &s.batches[batch_idx];
        for col in 0..s.num_cols {
            let column = batch.column(col);
            let is_null = cell_is_null(column.as_ref(), local_row);
            out.nulls.push(is_null);
            if is_null {
                out.strings.push(String::new());
                out.numeric_values.push(None);
                continue;
            }

            if matches!(s.col_types.get(col).map(String::as_str), Some("image")) {
                out.strings.push(String::new());
            } else {
                out.strings
                    .push(cell_string_for(s, col, column.as_ref(), local_row));
            }
            if matches!(
                s.col_types.get(col).map(String::as_str),
                Some("numeric" | "timestamp")
            ) {
                out.numeric_values
                    .push(Some(cell_f64_for(column.as_ref(), local_row)));
            } else {
                out.numeric_values.push(None);
            }
        }
    }

    out
}

/// Get a cell value as a formatted string (for display).
#[wasm_bindgen]
pub fn get_cell_string(handle: u32, row: usize, col: usize) -> Result<String, JsValue> {
    with_store(handle, |s| {
        let (batch_idx, local_row) = match s.resolve_row(row) {
            Some(r) => r,
            None => return String::new(),
        };
        let column = s.batches[batch_idx].column(col);
        if cell_is_null(column.as_ref(), local_row) {
            return String::new();
        }

        cell_string_for(s, col, column.as_ref(), local_row)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Extract the `bytes` field from a `Struct{bytes, path}` array at `idx`.
/// Returns an empty vec when the cell is null, the struct lacks a `bytes`
/// field, or the bytes field is itself null. Shared between the
/// single-image and list-of-image code paths.
fn extract_bytes_from_struct(arr: &dyn Array, idx: usize) -> Vec<u8> {
    let Some(s) = arr.as_any().downcast_ref::<StructArray>() else {
        return Vec::new();
    };
    if cell_is_null(arr, idx) {
        return Vec::new();
    }
    let Some(bytes_col) = s.column_by_name("bytes") else {
        return Vec::new();
    };
    if cell_is_null(bytes_col.as_ref(), idx) {
        return Vec::new();
    }
    match bytes_col.data_type() {
        DataType::Binary => bytes_col
            .as_any()
            .downcast_ref::<BinaryArray>()
            .map(|a| a.value(idx).to_vec())
            .unwrap_or_default(),
        DataType::LargeBinary => bytes_col
            .as_any()
            .downcast_ref::<LargeBinaryArray>()
            .map(|a| a.value(idx).to_vec())
            .unwrap_or_default(),
        DataType::BinaryView => bytes_col
            .as_any()
            .downcast_ref::<BinaryViewArray>()
            .map(|a| a.value(idx).to_vec())
            .unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Pull the `bytes` field out of a `Struct{bytes, path}` cell. HuggingFace's
/// Image / Audio / Video / Pdf / Nifti features all share this on-disk shape;
/// the viewer needs the raw payload to render thumbnails or build a Blob URL.
/// Returns an empty vec for null cells, out-of-range rows, non-struct columns,
/// or structs that lack a `bytes` field — callers detect "no image here" by
/// the empty length.
fn cell_bytes_for(store: &DataStore, row: usize, col: usize) -> Vec<u8> {
    let (batch_idx, local_row) = match store.resolve_row(row) {
        Some(r) => r,
        None => return Vec::new(),
    };
    let column = store.batches[batch_idx].column(col);
    if cell_is_null(column.as_ref(), local_row) {
        return Vec::new();
    }
    if column.as_any().downcast_ref::<StructArray>().is_none() {
        return Vec::new();
    }
    extract_bytes_from_struct(column.as_ref(), local_row)
}

/// Number of images in a cell — `1` for a `Struct{bytes,path}`,
/// `len(list)` for a `List<Struct{bytes,path}>`, `0` for null/OOB/other.
fn cell_image_count_for(store: &DataStore, row: usize, col: usize) -> usize {
    let (batch_idx, local_row) = match store.resolve_row(row) {
        Some(r) => r,
        None => return 0,
    };
    let column = store.batches[batch_idx].column(col);
    if cell_is_null(column.as_ref(), local_row) {
        return 0;
    }
    match column.data_type() {
        DataType::Struct(_) => {
            // HF parquets often leave the struct itself non-null when only
            // the inner `bytes` field is missing; treat "bytes is null" as
            // "no image here" so callers don't render a broken Blob.
            let Some(s) = column.as_any().downcast_ref::<StructArray>() else {
                return 0;
            };
            let Some(bytes_col) = s.column_by_name("bytes") else {
                return 0;
            };
            if cell_is_null(bytes_col.as_ref(), local_row) {
                0
            } else {
                1
            }
        }
        DataType::List(_) => column
            .as_any()
            .downcast_ref::<ListArray>()
            .map(|a| a.value_length(local_row) as usize)
            .unwrap_or(0),
        DataType::LargeList(_) => column
            .as_any()
            .downcast_ref::<LargeListArray>()
            .map(|a| a.value_length(local_row) as usize)
            .unwrap_or(0),
        _ => 0,
    }
}

/// Bytes for the `idx`-th image in a cell. For a struct cell only `idx == 0`
/// is valid; for a list cell, `idx` indexes into the inner list. Empty vec
/// when the cell is null/OOB, the column isn't an image shape, or `idx` is
/// past the cell's image count.
fn cell_bytes_at_for(store: &DataStore, row: usize, col: usize, idx: usize) -> Vec<u8> {
    let (batch_idx, local_row) = match store.resolve_row(row) {
        Some(r) => r,
        None => return Vec::new(),
    };
    let column = store.batches[batch_idx].column(col);
    if cell_is_null(column.as_ref(), local_row) {
        return Vec::new();
    }
    match column.data_type() {
        DataType::Struct(_) => {
            if idx != 0 {
                return Vec::new();
            }
            extract_bytes_from_struct(column.as_ref(), local_row)
        }
        DataType::List(_) => {
            let Some(list) = column.as_any().downcast_ref::<ListArray>() else {
                return Vec::new();
            };
            let inner = list.value(local_row);
            if idx >= inner.len() {
                return Vec::new();
            }
            extract_bytes_from_struct(inner.as_ref(), idx)
        }
        DataType::LargeList(_) => {
            let Some(list) = column.as_any().downcast_ref::<LargeListArray>() else {
                return Vec::new();
            };
            let inner = list.value(local_row);
            if idx >= inner.len() {
                return Vec::new();
            }
            extract_bytes_from_struct(inner.as_ref(), idx)
        }
        _ => Vec::new(),
    }
}

/// Get the raw bytes of a `Struct{bytes, path}` cell — HuggingFace's
/// Image/Audio/Video/Pdf/Nifti shape. See `cell_bytes_for` for semantics.
#[wasm_bindgen]
pub fn get_cell_bytes(handle: u32, row: usize, col: usize) -> Result<Vec<u8>, JsValue> {
    with_store(handle, |s| cell_bytes_for(s, row, col)).map_err(|e| JsValue::from_str(&e))
}

/// Number of images in a cell. `1` for a single struct, `len` for a list,
/// `0` otherwise. The renderer pairs this with `get_cell_image_bytes_at`
/// to lay out a thumbnail strip without one round-trip per probe.
#[wasm_bindgen]
pub fn get_cell_image_count(handle: u32, row: usize, col: usize) -> Result<u32, JsValue> {
    with_store(handle, |s| cell_image_count_for(s, row, col) as u32)
        .map_err(|e| JsValue::from_str(&e))
}

/// Bytes for the `idx`-th image in a cell. Works for both `Struct{bytes,path}`
/// (only `idx == 0`) and `List<Struct{bytes,path}>`. See `cell_bytes_at_for`.
#[wasm_bindgen]
pub fn get_cell_image_bytes_at(
    handle: u32,
    row: usize,
    col: usize,
    idx: usize,
) -> Result<Vec<u8>, JsValue> {
    with_store(handle, |s| cell_bytes_at_for(s, row, col, idx)).map_err(|e| JsValue::from_str(&e))
}

/// Get a cell value as f64. Returns NaN for null or unsupported types.
/// Handles numeric types and timestamps (as epoch milliseconds).
#[wasm_bindgen]
pub fn get_cell_f64(handle: u32, row: usize, col: usize) -> Result<f64, JsValue> {
    with_store(handle, |s| {
        let (batch_idx, local_row) = match s.resolve_row(row) {
            Some(r) => r,
            None => return f64::NAN,
        };
        let column = s.batches[batch_idx].column(col);
        if cell_is_null(column.as_ref(), local_row) {
            return f64::NAN;
        }

        cell_f64_for(column.as_ref(), local_row)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Batch-fetch display strings and raw numeric values for viewport rows.
///
/// The frontend calls this once per render window instead of calling
/// is_null/get_cell_string/get_cell_f64 for every visible cell.
#[wasm_bindgen]
pub fn store_viewport_cells(handle: u32, rows: &[u32]) -> Result<JsValue, JsValue> {
    with_store(handle, |s| {
        let out = viewport_cells_for(s, rows);
        serde_wasm_bindgen::to_value(&out).unwrap_or(JsValue::NULL)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Compute value_counts for a column in a loaded store. Much faster than
/// the JS accumulator path since it iterates batches in Rust.
#[wasm_bindgen]
pub fn store_value_counts(handle: u32, col: usize) -> Result<JsValue, JsValue> {
    with_store(handle, |s| {
        let mut freq: HashMap<String, u32> = HashMap::new();
        for batch in &s.batches {
            let column = batch.column(col);
            if nteract_predicate::arrow_utils::for_each_string(column.as_ref(), |s| {
                *freq.entry(s.to_string()).or_insert(0) += 1;
            }) {
                continue;
            }
            match column.data_type() {
                DataType::Boolean => {
                    if let Some(arr) = column.as_any().downcast_ref::<BooleanArray>() {
                        for i in 0..arr.len() {
                            if !arr.is_null(i) {
                                let key = if arr.value(i) { "Yes" } else { "No" };
                                *freq.entry(key.to_string()).or_insert(0) += 1;
                            }
                        }
                    }
                }
                _ => {
                    if let Ok(formatter) =
                        ArrayFormatter::try_new(column.as_ref(), &Default::default())
                    {
                        for i in 0..column.len() {
                            if !cell_is_null(column.as_ref(), i) {
                                let key = compact_binary_cell_string(column.as_ref(), i)
                                    .unwrap_or_else(|| formatter.value(i).to_string());
                                *freq.entry(key).or_insert(0) += 1;
                            }
                        }
                    }
                }
            }
        }
        let mut counts: Vec<CategoryCount> = freq
            .into_iter()
            .map(|(label, count)| CategoryCount { label, count })
            .collect();
        counts.sort_by(|a, b| b.count.cmp(&a.count));
        // Returns Vec<CategoryCount> — simple structs with String/u32 fields
        serde_wasm_bindgen::to_value(&counts).unwrap_or(JsValue::NULL)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Compute histogram for a numeric column in a loaded store.
#[wasm_bindgen]
pub fn store_histogram(handle: u32, col: usize, num_bins: usize) -> Result<JsValue, JsValue> {
    with_store(handle, |s| {
        let mut values: Vec<f64> = Vec::new();
        for batch in &s.batches {
            let column = batch.column(col);
            match column.data_type() {
                DataType::Float64 => {
                    if let Some(arr) = column.as_any().downcast_ref::<Float64Array>() {
                        for i in 0..arr.len() {
                            if !arr.is_null(i) {
                                let v = arr.value(i);
                                if v.is_finite() {
                                    values.push(v);
                                }
                            }
                        }
                    }
                }
                DataType::Int32 => {
                    if let Some(arr) = column.as_any().downcast_ref::<Int32Array>() {
                        for i in 0..arr.len() {
                            if !arr.is_null(i) {
                                values.push(arr.value(i) as f64);
                            }
                        }
                    }
                }
                DataType::Int64 => {
                    if let Some(arr) = column.as_any().downcast_ref::<Int64Array>() {
                        for i in 0..arr.len() {
                            if !arr.is_null(i) {
                                values.push(arr.value(i) as f64);
                            }
                        }
                    }
                }
                _ => {}
            }
        }
        if values.is_empty() {
            // serde_wasm_bindgen serialization won't fail for simple structs
            return JsValue::from(js_sys::Array::new());
        }
        let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        // Constant column: collapse to a single degenerate bin at `min`
        // rather than stretching `num_bins` bins across `[min, min + num_bins]`.
        // Without this the TS consumer reads `bins[last].x1 = min + num_bins`
        // as the column max, producing header labels like "0.46 - 25.46" for
        // columns where every row is 0.459. See nteract/nteract#1847.
        if (max - min).abs() < f64::EPSILON {
            let single = vec![HistogramBin {
                x0: min,
                x1: min,
                count: u32::try_from(values.len()).unwrap_or(u32::MAX),
            }];
            return serde_wasm_bindgen::to_value(&single).unwrap_or(JsValue::NULL);
        }

        let bin_width = (max - min) / num_bins as f64;
        let mut bins: Vec<HistogramBin> = (0..num_bins)
            .map(|i| HistogramBin {
                x0: min + i as f64 * bin_width,
                x1: min + (i + 1) as f64 * bin_width,
                count: 0,
            })
            .collect();
        for v in &values {
            let mut idx = ((v - min) / bin_width) as usize;
            if idx >= num_bins {
                idx = num_bins - 1;
            }
            if idx > 0 && *v < bins[idx].x0 {
                idx -= 1;
            } else if idx + 1 < num_bins && *v >= bins[idx + 1].x0 {
                idx += 1;
            }
            bins[idx].count += 1;
        }
        // Returns Vec<HistogramBin> - simple struct with f64/u32 fields
        serde_wasm_bindgen::to_value(&bins).unwrap_or(JsValue::NULL)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Compute temporal histogram: bins timestamps by calendar unit (auto-detected).
/// Granularity: <48h → hourly, <90d → daily, <3y → monthly, else yearly.
/// Returns bins with x0/x1 as epoch milliseconds.
#[wasm_bindgen]
pub fn store_temporal_histogram(handle: u32, col: usize) -> Result<JsValue, JsValue> {
    with_store(handle, |s| {
        let mut ms_values: Vec<i64> = Vec::new();
        for batch in &s.batches {
            let column = batch.column(col);
            extract_timestamp_ms(column, &mut ms_values);
        }
        let (min_ms, max_ms) = match (ms_values.iter().min(), ms_values.iter().max()) {
            (Some(&lo), Some(&hi)) => (lo, hi),
            // Empty series: nothing to bin. Return an empty array so callers
            // can treat "no data" uniformly.
            _ => return JsValue::from(js_sys::Array::new()),
        };
        let range_ms = max_ms - min_ms;

        // Auto-detect granularity
        let ms_per_hour: i64 = 3_600_000;
        let ms_per_day: i64 = 86_400_000;
        let ms_per_month: i64 = 30 * ms_per_day; // approximate
        let ms_per_year: i64 = 365 * ms_per_day;

        let bin_width_ms = if range_ms < 48 * ms_per_hour {
            ms_per_hour
        } else if range_ms < 90 * ms_per_day {
            ms_per_day
        } else if range_ms < 3 * ms_per_year {
            ms_per_month
        } else {
            ms_per_year
        };

        // Align start to bin boundary
        let start = (min_ms / bin_width_ms) * bin_width_ms;
        let end = ((max_ms / bin_width_ms) + 1) * bin_width_ms;
        let num_bins = ((end - start) / bin_width_ms) as usize;

        // Cap at 100 bins to avoid huge arrays
        let (actual_start, actual_width, actual_count) = if num_bins > 100 {
            let w = (end - start) / 100;
            (start, w, 100usize)
        } else {
            (start, bin_width_ms, num_bins)
        };

        let mut bins: Vec<HistogramBin> = (0..actual_count)
            .map(|i| HistogramBin {
                x0: (actual_start + i as i64 * actual_width) as f64,
                x1: (actual_start + (i as i64 + 1) * actual_width) as f64,
                count: 0,
            })
            .collect();

        for &v in &ms_values {
            let mut idx = ((v - actual_start) / actual_width) as usize;
            if idx >= actual_count {
                idx = actual_count - 1;
            }
            bins[idx].count += 1;
        }

        // Returns Vec<HistogramBin> — simple struct with f64/u32 fields
        serde_wasm_bindgen::to_value(&bins).unwrap_or(JsValue::NULL)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Extract timestamp values as milliseconds from an Arrow column.
fn extract_timestamp_ms(column: &dyn Array, out: &mut Vec<i64>) {
    // Int64 fallback: treat raw i64 as epoch ms (common for cast timestamps)
    if matches!(column.data_type(), DataType::Int64) {
        if let Some(arr) = column.as_any().downcast_ref::<Int64Array>() {
            for i in 0..arr.len() {
                if !arr.is_null(i) {
                    out.push(arr.value(i));
                }
            }
        }
        return;
    }

    for i in 0..column.len() {
        if let Some(ms) = timestamp_cell_ms(column, i) {
            out.push(ms);
        }
    }
}

/// Count boolean values in a column: returns [true_count, false_count, null_count].
#[wasm_bindgen]
pub fn store_bool_counts(handle: u32, col: usize) -> Result<Vec<u32>, JsValue> {
    with_store(handle, |s| {
        let mut true_count: u32 = 0;
        let mut false_count: u32 = 0;
        let mut null_count: u32 = 0;
        for batch in &s.batches {
            let column = batch.column(col);
            if let Some(arr) = column.as_any().downcast_ref::<BooleanArray>() {
                for i in 0..arr.len() {
                    if arr.is_null(i) {
                        null_count += 1;
                    } else if arr.value(i) {
                        true_count += 1;
                    } else {
                        false_count += 1;
                    }
                }
            }
        }
        vec![true_count, false_count, null_count]
    })
    .map_err(|e| JsValue::from_str(&e))
}

// --- Filtered summaries (crossfilter) ---
// These take a byte mask (one byte per row, 0 = excluded, nonzero = included).
// Iterates batches once, checks mask per row — no allocation of filtered copies.

/// Filtered histogram: computes bins only for rows where mask[row] != 0.
#[wasm_bindgen]
pub fn store_filtered_histogram(
    handle: u32,
    col: usize,
    mask: &[u8],
    num_bins: usize,
) -> Result<JsValue, JsValue> {
    with_store(handle, |s| {
        let mut values: Vec<f64> = Vec::new();
        let mut global_row: usize = 0;
        for batch in &s.batches {
            let column = batch.column(col);
            let n = column.len();
            match column.data_type() {
                DataType::Float64 => {
                    if let Some(arr) = column.as_any().downcast_ref::<Float64Array>() {
                        for i in 0..n {
                            if global_row + i < mask.len()
                                && mask[global_row + i] != 0
                                && !arr.is_null(i)
                            {
                                let v = arr.value(i);
                                if v.is_finite() {
                                    values.push(v);
                                }
                            }
                        }
                    }
                }
                DataType::Int32 => {
                    if let Some(arr) = column.as_any().downcast_ref::<Int32Array>() {
                        for i in 0..n {
                            if global_row + i < mask.len()
                                && mask[global_row + i] != 0
                                && !arr.is_null(i)
                            {
                                values.push(arr.value(i) as f64);
                            }
                        }
                    }
                }
                DataType::Int64 => {
                    if let Some(arr) = column.as_any().downcast_ref::<Int64Array>() {
                        for i in 0..n {
                            if global_row + i < mask.len()
                                && mask[global_row + i] != 0
                                && !arr.is_null(i)
                            {
                                values.push(arr.value(i) as f64);
                            }
                        }
                    }
                }
                DataType::Timestamp(unit, _) => {
                    // Normalize to milliseconds to match the unfiltered histogram
                    // (`extract_timestamp_ms`) and the frontend's Date-based
                    // rendering. Without this, polars' default Datetime(us) /
                    // nanosecond clickhouse columns / second-precision epoch
                    // sources all fall through the old MillisecondArray-only
                    // downcast, leave `values` empty, and make the filtered
                    // histogram silently fall back to the unfiltered summary —
                    // so the header range never zooms in on a brushed filter.
                    match unit {
                        TimeUnit::Second => {
                            if let Some(arr) = column
                                .as_any()
                                .downcast_ref::<arrow::array::TimestampSecondArray>()
                            {
                                for i in 0..n {
                                    if global_row + i < mask.len()
                                        && mask[global_row + i] != 0
                                        && !arr.is_null(i)
                                    {
                                        values.push((arr.value(i) as f64) * 1000.0);
                                    }
                                }
                            }
                        }
                        TimeUnit::Millisecond => {
                            if let Some(arr) = column
                                .as_any()
                                .downcast_ref::<arrow::array::TimestampMillisecondArray>(
                            ) {
                                for i in 0..n {
                                    if global_row + i < mask.len()
                                        && mask[global_row + i] != 0
                                        && !arr.is_null(i)
                                    {
                                        values.push(arr.value(i) as f64);
                                    }
                                }
                            }
                        }
                        TimeUnit::Microsecond => {
                            if let Some(arr) = column
                                .as_any()
                                .downcast_ref::<arrow::array::TimestampMicrosecondArray>(
                            ) {
                                for i in 0..n {
                                    if global_row + i < mask.len()
                                        && mask[global_row + i] != 0
                                        && !arr.is_null(i)
                                    {
                                        values.push((arr.value(i) / 1_000) as f64);
                                    }
                                }
                            }
                        }
                        TimeUnit::Nanosecond => {
                            if let Some(arr) = column
                                .as_any()
                                .downcast_ref::<arrow::array::TimestampNanosecondArray>()
                            {
                                for i in 0..n {
                                    if global_row + i < mask.len()
                                        && mask[global_row + i] != 0
                                        && !arr.is_null(i)
                                    {
                                        values.push((arr.value(i) / 1_000_000) as f64);
                                    }
                                }
                            }
                        }
                    }
                }
                DataType::Date32 => {
                    // Date32 is days since epoch. Normalize to ms to match the
                    // unfiltered path (`extract_timestamp_ms` does the same).
                    if let Some(arr) = column.as_any().downcast_ref::<arrow::array::Date32Array>() {
                        for i in 0..n {
                            if global_row + i < mask.len()
                                && mask[global_row + i] != 0
                                && !arr.is_null(i)
                            {
                                values.push((arr.value(i) as i64 * 86_400_000) as f64);
                            }
                        }
                    }
                }
                DataType::Date64 => {
                    // Date64 is already milliseconds since epoch.
                    if let Some(arr) = column.as_any().downcast_ref::<arrow::array::Date64Array>() {
                        for i in 0..n {
                            if global_row + i < mask.len()
                                && mask[global_row + i] != 0
                                && !arr.is_null(i)
                            {
                                values.push(arr.value(i) as f64);
                            }
                        }
                    }
                }
                _ => {}
            }
            global_row += n;
        }
        if values.is_empty() {
            return JsValue::from(js_sys::Array::new());
        }
        let min = values.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        // Same degenerate-bin collapse as `store_histogram` - see
        // that function for the rationale. See nteract/nteract#1847.
        if (max - min).abs() < f64::EPSILON {
            let single = vec![HistogramBin {
                x0: min,
                x1: min,
                count: u32::try_from(values.len()).unwrap_or(u32::MAX),
            }];
            return serde_wasm_bindgen::to_value(&single).unwrap_or(JsValue::NULL);
        }

        let bin_width = (max - min) / num_bins as f64;
        let mut bins: Vec<HistogramBin> = (0..num_bins)
            .map(|i| HistogramBin {
                x0: min + i as f64 * bin_width,
                x1: min + (i + 1) as f64 * bin_width,
                count: 0,
            })
            .collect();
        for v in &values {
            let mut idx = ((v - min) / bin_width) as usize;
            if idx >= num_bins {
                idx = num_bins - 1;
            }
            if idx > 0 && *v < bins[idx].x0 {
                idx -= 1;
            } else if idx + 1 < num_bins && *v >= bins[idx + 1].x0 {
                idx += 1;
            }
            bins[idx].count += 1;
        }
        // Returns Vec<HistogramBin> - simple struct with f64/u32 fields
        serde_wasm_bindgen::to_value(&bins).unwrap_or(JsValue::NULL)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Filtered value_counts: counts string values only for rows where mask[row] != 0.
#[wasm_bindgen]
pub fn store_filtered_value_counts(
    handle: u32,
    col: usize,
    mask: &[u8],
) -> Result<JsValue, JsValue> {
    with_store(handle, |s| {
        let mut freq: HashMap<String, u32> = HashMap::new();
        let mut global_row: usize = 0;
        for batch in &s.batches {
            let column = batch.column(col);
            let n = column.len();
            // String-like columns: iterate via shared helper, applying the
            // filter mask per row (global_row + i maps into the full mask).
            let applied =
                nteract_predicate::arrow_utils::for_each_string_indexed(column.as_ref(), |i, s| {
                    if global_row + i < mask.len() && mask[global_row + i] != 0 {
                        *freq.entry(s.to_string()).or_insert(0) += 1;
                    }
                });
            if applied {
                global_row += n;
                continue;
            }
            match column.data_type() {
                DataType::Boolean => {
                    if let Some(arr) = column.as_any().downcast_ref::<BooleanArray>() {
                        for i in 0..n {
                            if global_row + i < mask.len()
                                && mask[global_row + i] != 0
                                && !arr.is_null(i)
                            {
                                let key = if arr.value(i) { "Yes" } else { "No" };
                                *freq.entry(key.to_string()).or_insert(0) += 1;
                            }
                        }
                    }
                }
                _ => {
                    if let Ok(formatter) =
                        ArrayFormatter::try_new(column.as_ref(), &Default::default())
                    {
                        for i in 0..n {
                            if global_row + i < mask.len()
                                && mask[global_row + i] != 0
                                && !cell_is_null(column.as_ref(), i)
                            {
                                let key = compact_binary_cell_string(column.as_ref(), i)
                                    .unwrap_or_else(|| formatter.value(i).to_string());
                                *freq.entry(key).or_insert(0) += 1;
                            }
                        }
                    }
                }
            }
            global_row += n;
        }
        let mut counts: Vec<CategoryCount> = freq
            .into_iter()
            .map(|(label, count)| CategoryCount { label, count })
            .collect();
        counts.sort_by(|a, b| b.count.cmp(&a.count));
        // Returns Vec<CategoryCount> or Vec<HistogramBin> — simple structs with String/f64/u32 fields
        serde_wasm_bindgen::to_value(&counts).unwrap_or(JsValue::NULL)
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Filtered bool counts: returns [true_count, false_count, null_count] for masked rows.
#[wasm_bindgen]
pub fn store_filtered_bool_counts(
    handle: u32,
    col: usize,
    mask: &[u8],
) -> Result<Vec<u32>, JsValue> {
    with_store(handle, |s| {
        let mut true_count: u32 = 0;
        let mut false_count: u32 = 0;
        let mut null_count: u32 = 0;
        let mut global_row: usize = 0;
        for batch in &s.batches {
            let column = batch.column(col);
            let n = column.len();
            if let Some(arr) = column.as_any().downcast_ref::<BooleanArray>() {
                for i in 0..n {
                    if global_row + i < mask.len() && mask[global_row + i] != 0 {
                        if arr.is_null(i) {
                            null_count += 1;
                        } else if arr.value(i) {
                            true_count += 1;
                        } else {
                            false_count += 1;
                        }
                    }
                }
            }
            global_row += n;
        }
        vec![true_count, false_count, null_count]
    })
    .map_err(|e| JsValue::from_str(&e))
}

/// Sort a column and return sorted row indices.
/// `ascending`: true for asc, false for desc.
/// Nulls are always sorted to the end.
#[wasm_bindgen]
pub fn store_sort_indices(handle: u32, col: usize, ascending: bool) -> Result<Vec<u32>, JsValue> {
    with_store(handle, |s| {
        // Concatenate column across all batches into a single array
        let arrays: Vec<&dyn Array> = s.batches.iter().map(|b| b.column(col).as_ref()).collect();

        if arrays.is_empty() {
            return Ok(Vec::new());
        }

        let combined = concat(&arrays).map_err(|e| format!("concat error: {}", e))?;

        let options = SortOptions {
            descending: !ascending,
            nulls_first: false, // nulls always at end
        };

        let indices = sort_to_indices(combined.as_ref(), Some(options), None)
            .map_err(|e| format!("sort error: {}", e))?;

        // Convert UInt32Array to Vec<u32>
        Ok(indices.values().iter().copied().collect())
    })
    .map_err(|e| JsValue::from_str(&e))?
    .map_err(|e: String| JsValue::from_str(&e))
}

/// Downgrade Arrow "view" types (Utf8View, BinaryView) to their non-view
/// equivalents (Utf8, Binary) before emitting IPC to the JS consumer. The
/// apache-arrow npm package used by the sift frontend (21.x at time of
/// writing) throws `Unrecognized type: "undefined" (24)` when it hits a
/// Utf8View field during schema decode, which silently empties the table
/// body. Normalizing server-side keeps the JS side on types it understands.
///
/// Currently handles the top-level column case (the actual repro path —
/// polars' default string encoding is Utf8View). Nested occurrences
/// (List<Utf8View>, Struct{s: Utf8View}) are left as-is; if they show up
/// in practice we can walk the types recursively.
///
/// Fast-path: if the batch has no view columns, returns `batch.clone()`.
///
/// See nteract/nteract#1853.
fn downgrade_view_types(batch: &RecordBatch) -> Result<RecordBatch, String> {
    use arrow::datatypes::{Field, Schema};
    use std::sync::Arc;

    let schema = batch.schema();
    let needs_cast = schema
        .fields()
        .iter()
        .any(|f| matches!(f.data_type(), DataType::Utf8View | DataType::BinaryView));
    if !needs_cast {
        return Ok(batch.clone());
    }

    let mut new_columns: Vec<arrow::array::ArrayRef> = Vec::with_capacity(batch.num_columns());
    let mut new_fields: Vec<Arc<Field>> = Vec::with_capacity(schema.fields().len());

    for (i, field) in schema.fields().iter().enumerate() {
        let col = batch.column(i);
        let (new_col, new_field) = match field.data_type() {
            DataType::Utf8View => (
                arrow_cast::cast(col.as_ref(), &DataType::Utf8)
                    .map_err(|e| format!("cast Utf8View→Utf8 on {}: {}", field.name(), e))?,
                // Preserve field-level metadata (e.g. Arrow extension
                // keys like `ARROW:extension:name`) by cloning the
                // original and only swapping the data type.
                Arc::new(field.as_ref().clone().with_data_type(DataType::Utf8)),
            ),
            DataType::BinaryView => (
                arrow_cast::cast(col.as_ref(), &DataType::Binary)
                    .map_err(|e| format!("cast BinaryView→Binary on {}: {}", field.name(), e))?,
                Arc::new(field.as_ref().clone().with_data_type(DataType::Binary)),
            ),
            _ => (col.clone(), field.clone()),
        };
        new_columns.push(new_col);
        new_fields.push(new_field);
    }

    // Preserve schema-level metadata too.
    let new_schema = Arc::new(Schema::new_with_metadata(
        new_fields,
        schema.metadata().clone(),
    ));
    RecordBatch::try_new(new_schema, new_columns).map_err(|e| format!("rebatch: {}", e))
}

/// Get a viewport slice as Arrow IPC bytes.
/// Returns the rows [start_row, end_row) serialized as Arrow IPC stream.
/// This is the hot-path function — one call per scroll frame.
#[wasm_bindgen]
pub fn get_viewport(handle: u32, start_row: u32, end_row: u32) -> Result<Vec<u8>, JsValue> {
    with_store(handle, |s| {
        let start = start_row as usize;
        let end = (end_row as usize).min(s.total_rows);
        if start >= end {
            return Err("empty viewport".to_string());
        }

        let mut slices: Vec<RecordBatch> = Vec::new();

        // Walk batches, slicing the ones that overlap [start, end)
        for (batch_idx, batch) in s.batches.iter().enumerate() {
            let batch_start = s.batch_offsets[batch_idx];
            let batch_end = batch_start + batch.num_rows();

            // Skip batches entirely before or after the viewport
            if batch_end <= start || batch_start >= end {
                continue;
            }

            // Compute the overlap
            let local_start = start.saturating_sub(batch_start);
            let local_end = if end < batch_end {
                end - batch_start
            } else {
                batch.num_rows()
            };

            let slice = batch.slice(local_start, local_end - local_start);
            slices.push(downgrade_view_types(&slice)?);
        }

        if slices.is_empty() {
            return Err("no data in viewport".to_string());
        }

        // All downgraded slices share the same (possibly-transformed) schema.
        let writer_schema = slices[0].schema();

        // Serialize to Arrow IPC stream
        let mut buf = Vec::new();
        let mut writer = StreamWriter::try_new(&mut buf, &writer_schema)
            .map_err(|e| format!("IPC writer error: {}", e))?;
        for slice in &slices {
            writer
                .write(slice)
                .map_err(|e| format!("IPC write error: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("IPC finish error: {}", e))?;
        drop(writer);

        Ok(buf)
    })
    .map_err(|e| JsValue::from_str(&e))?
    .map_err(|e: String| JsValue::from_str(&e))
}

/// Get a viewport slice for specific rows by index (for sorted/filtered views).
/// `indices` is a Uint32Array of row indices to fetch.
/// Returns Arrow IPC bytes containing those specific rows in order.
#[wasm_bindgen]
pub fn get_viewport_by_indices(handle: u32, indices: &[u32]) -> Result<Vec<u8>, JsValue> {
    with_store(handle, |s| {
        if indices.is_empty() || s.batches.is_empty() {
            return Err("empty indices".to_string());
        }

        let schema = s.batches[0].schema();
        let num_cols = schema.fields().len();

        // For each column, gather values at the requested indices using arrow take
        let mut columns: Vec<arrow::array::ArrayRef> = Vec::with_capacity(num_cols);

        for col_idx in 0..num_cols {
            // Concatenate column across all batches
            let arrays: Vec<&dyn Array> = s
                .batches
                .iter()
                .map(|b| b.column(col_idx).as_ref())
                .collect();
            let combined = concat(&arrays).map_err(|e| format!("concat error: {}", e))?;

            // Build indices array
            let idx_array = UInt32Array::from(indices.to_vec());
            let taken = arrow_select::take::take(combined.as_ref(), &idx_array, None)
                .map_err(|e| format!("take error: {}", e))?;
            columns.push(taken);
        }

        let batch =
            RecordBatch::try_new(schema, columns).map_err(|e| format!("batch error: {}", e))?;
        let batch = downgrade_view_types(&batch)?;

        let mut buf = Vec::new();
        let mut writer = StreamWriter::try_new(&mut buf, batch.schema_ref())
            .map_err(|e| format!("IPC writer error: {}", e))?;
        writer
            .write(&batch)
            .map_err(|e| format!("IPC write error: {}", e))?;
        writer
            .finish()
            .map_err(|e| format!("IPC finish error: {}", e))?;
        drop(writer);

        Ok(buf)
    })
    .map_err(|e| JsValue::from_str(&e))?
    .map_err(|e: String| JsValue::from_str(&e))
}

/// Get Parquet metadata: number of row groups and total rows.
/// Returns [num_row_groups, total_rows] as Vec<u32>.
#[wasm_bindgen]
pub fn parquet_metadata(parquet_bytes: &[u8]) -> Result<Vec<u32>, JsValue> {
    let bytes = bytes::Bytes::copy_from_slice(parquet_bytes);
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let metadata = builder.metadata();
    let num_row_groups = metadata.num_row_groups() as u32;
    let total_rows = metadata.file_metadata().num_rows() as u32;
    Ok(vec![num_row_groups, total_rows])
}

/// Extract canonical column hints from Parquet file-level metadata.
#[wasm_bindgen]
pub fn parquet_column_hints(parquet_bytes: &[u8]) -> Result<JsValue, JsValue> {
    let hints = predicate_parquet_column_hints(parquet_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&hints).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Extract canonical column hints from Arrow IPC schema metadata.
#[wasm_bindgen]
pub fn arrow_ipc_column_hints(ipc_bytes: &[u8]) -> Result<JsValue, JsValue> {
    let hints = predicate_arrow_ipc_column_hints(ipc_bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&hints).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Extract canonical column hints from Arrow IPC schema metadata using a row
/// count the caller already has from the loaded table.
#[wasm_bindgen]
pub fn arrow_ipc_column_hints_with_row_count(
    ipc_bytes: &[u8],
    total_rows: u32,
) -> Result<JsValue, JsValue> {
    let hints = predicate_arrow_ipc_column_hints_with_row_count(ipc_bytes, u64::from(total_rows))
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    serde_wasm_bindgen::to_value(&hints).map_err(|e| JsValue::from_str(&e.to_string()))
}

/// Load a single Parquet row group into a new or existing store.
/// If handle is 0, creates a new store and returns the handle.
/// If handle is non-zero, appends the row group to the existing store.
#[wasm_bindgen]
pub fn load_parquet_row_group(
    parquet_bytes: &[u8],
    row_group: usize,
    handle: u32,
) -> Result<u32, JsValue> {
    let bytes = bytes::Bytes::copy_from_slice(parquet_bytes);
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let schema = builder.schema().clone();

    let reader = builder
        .with_row_groups(vec![row_group])
        .build()
        .map_err(|e| JsValue::from_str(&e.to_string()))?;

    let mut batches = Vec::new();
    for batch in reader {
        batches.push(batch.map_err(|e| JsValue::from_str(&e.to_string()))?);
    }

    if handle == 0 {
        // Create new store
        store_batches(batches, schema).map_err(|e| JsValue::from_str(&e))
    } else {
        // Append to existing store
        with_stores(|stores| {
            if let Some(store) = stores.get_mut(&handle) {
                for batch in batches {
                    store.batch_offsets.push(store.total_rows);
                    store.total_rows += batch.num_rows();
                    store.batches.push(batch);
                }
                Ok(handle)
            } else {
                Err(JsValue::from_str(&format!("Invalid handle: {}", handle)))
            }
        })
    }
}

/// Check if a column has been cast (i.e. original data is saved and can be restored).
#[wasm_bindgen]
pub fn has_original_column(handle: u32, col: usize) -> Result<bool, JsValue> {
    with_store(handle, |s| s.original_columns.contains_key(&col)).map_err(|e| JsValue::from_str(&e))
}

/// Undo a column cast, restoring the original column data and type.
/// Returns the original column type string (e.g. "categorical", "numeric").
#[wasm_bindgen]
pub fn undo_cast_column(handle: u32, col: usize) -> Result<String, JsValue> {
    with_stores(|stores| {
        let store = stores
            .get_mut(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("Invalid handle: {}", handle)))?;

        let (original_cols, original_type) = store
            .original_columns
            .remove(&col)
            .ok_or_else(|| JsValue::from_str(&format!("Column {} has not been cast", col)))?;

        let mut new_batches = Vec::new();
        for (batch_idx, batch) in store.batches.iter().enumerate() {
            let mut columns: Vec<arrow::array::ArrayRef> = Vec::new();
            for i in 0..batch.num_columns() {
                if i == col {
                    columns.push(original_cols[batch_idx].clone());
                } else {
                    columns.push(batch.column(i).clone());
                }
            }
            let mut fields: Vec<arrow::datatypes::FieldRef> =
                batch.schema().fields().iter().cloned().collect();
            fields[col] = std::sync::Arc::new(arrow::datatypes::Field::new(
                fields[col].name(),
                original_cols[batch_idx].data_type().clone(),
                true,
            ));
            let new_schema = std::sync::Arc::new(arrow::datatypes::Schema::new(fields));
            new_batches.push(
                RecordBatch::try_new(new_schema, columns)
                    .map_err(|e| JsValue::from_str(&format!("Batch rebuild error: {}", e)))?,
            );
        }
        store.batches = new_batches;
        store.col_types[col] = original_type.clone();

        Ok(original_type)
    })
}

/// Cast a column to a different type in-place.
/// Supported casts: string→timestamp (parse ISO dates), string→numeric, etc.
/// Uses arrow-cast for type conversion. Updates the store's column type metadata.
/// Saves the original column data so it can be restored when casting back.
#[wasm_bindgen]
pub fn cast_column(handle: u32, col: usize, target_type: &str) -> Result<(), JsValue> {
    with_stores(|stores| {
        let store = stores
            .get_mut(&handle)
            .ok_or_else(|| JsValue::from_str(&format!("Invalid handle: {}", handle)))?;

        let target_dt = match target_type {
            "timestamp" => DataType::Timestamp(arrow::datatypes::TimeUnit::Millisecond, None),
            "numeric" => DataType::Float64,
            "boolean" => DataType::Boolean,
            "categorical" => DataType::Utf8,
            _ => {
                return Err(JsValue::from_str(&format!(
                    "Unknown target type: {}",
                    target_type
                )))
            }
        };

        // Check if we have saved originals for this column and the target matches
        if let Some((original_cols, original_type)) = store.original_columns.get(&col) {
            if target_type == original_type {
                // Restore original column data instead of arrow-casting
                let mut new_batches = Vec::new();
                for (batch_idx, batch) in store.batches.iter().enumerate() {
                    let mut columns: Vec<arrow::array::ArrayRef> = Vec::new();
                    for i in 0..batch.num_columns() {
                        if i == col {
                            columns.push(original_cols[batch_idx].clone());
                        } else {
                            columns.push(batch.column(i).clone());
                        }
                    }
                    let mut fields: Vec<arrow::datatypes::FieldRef> =
                        batch.schema().fields().iter().cloned().collect();
                    fields[col] = std::sync::Arc::new(arrow::datatypes::Field::new(
                        fields[col].name(),
                        original_cols[batch_idx].data_type().clone(),
                        true,
                    ));
                    let new_schema = std::sync::Arc::new(arrow::datatypes::Schema::new(fields));
                    new_batches.push(
                        RecordBatch::try_new(new_schema, columns).map_err(|e| {
                            JsValue::from_str(&format!("Batch rebuild error: {}", e))
                        })?,
                    );
                }
                store.batches = new_batches;
                store.col_types[col] = original_type.clone();
                store.original_columns.remove(&col);
                return Ok(());
            }
        }

        // Save original column data before casting (only if not already saved)
        if !store.original_columns.contains_key(&col) {
            let originals: Vec<arrow::array::ArrayRef> = store
                .batches
                .iter()
                .map(|b| b.column(col).clone())
                .collect();
            let original_type = store.col_types[col].clone();
            store
                .original_columns
                .insert(col, (originals, original_type));
        }

        // Cast the column in each batch
        let mut new_batches = Vec::new();
        for batch in &store.batches {
            let column = batch.column(col);
            let source_dt = column.data_type();

            let casted = if source_dt == &target_dt {
                column.clone()
            } else if target_type == "timestamp"
                && matches!(source_dt, DataType::Utf8 | DataType::LargeUtf8)
            {
                // String → Timestamp: parse ISO date strings manually.
                // Accept both StringArray (Utf8) and LargeStringArray (LargeUtf8).
                let str_arr: &dyn Array = match source_dt {
                    DataType::Utf8 => {
                        column
                            .as_any()
                            .downcast_ref::<StringArray>()
                            .ok_or_else(|| {
                                JsValue::from_str(
                                    "expected StringArray for Utf8 column during cast",
                                )
                            })? as &dyn Array
                    }
                    DataType::LargeUtf8 => column
                        .as_any()
                        .downcast_ref::<LargeStringArray>()
                        .ok_or_else(|| {
                            JsValue::from_str(
                                "expected LargeStringArray for LargeUtf8 column during cast",
                            )
                        })? as &dyn Array,
                    _ => unreachable!(),
                };
                let mut builder = arrow::array::TimestampMillisecondArray::builder(str_arr.len());
                let parse_value = |i: usize| -> Option<&str> {
                    if str_arr.is_null(i) {
                        return None;
                    }
                    if let Some(a) = str_arr.as_any().downcast_ref::<StringArray>() {
                        Some(a.value(i))
                    } else {
                        str_arr
                            .as_any()
                            .downcast_ref::<LargeStringArray>()
                            .map(|a| a.value(i))
                    }
                };
                for i in 0..str_arr.len() {
                    match parse_value(i) {
                        None => builder.append_null(),
                        Some(s) => {
                            if let Ok(dt) = chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                                // NaiveTime::default() is midnight; and_time
                                // returns NaiveDateTime directly — no Option.
                                let ts = dt
                                    .and_time(chrono::NaiveTime::default())
                                    .and_utc()
                                    .timestamp_millis();
                                builder.append_value(ts);
                            } else if let Ok(dt) =
                                chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S")
                            {
                                builder.append_value(dt.and_utc().timestamp_millis());
                            } else {
                                builder.append_null();
                            }
                        }
                    }
                }
                std::sync::Arc::new(builder.finish()) as arrow::array::ArrayRef
            } else {
                // Use arrow-cast for other conversions.
                // Wrap in catch_unwind because some casts panic instead of returning Err
                // (e.g., casting text with non-numeric values to Float64).
                let col_ref = column.clone();
                let dt = target_dt.clone();
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    arrow_cast::cast::cast(col_ref.as_ref(), &dt)
                }));
                match result {
                    Ok(Ok(arr)) => arr,
                    Ok(Err(e)) => return Err(JsValue::from_str(&format!("Cast error: {}", e))),
                    Err(_) => {
                        return Err(JsValue::from_str(
                            "Cast failed: incompatible data for target type",
                        ))
                    }
                }
            };

            // Rebuild the batch with the casted column
            let mut columns: Vec<arrow::array::ArrayRef> = Vec::new();
            for i in 0..batch.num_columns() {
                if i == col {
                    columns.push(casted.clone());
                } else {
                    columns.push(batch.column(i).clone());
                }
            }

            // Update schema for this column
            let mut fields: Vec<arrow::datatypes::FieldRef> =
                batch.schema().fields().iter().cloned().collect();
            fields[col] = std::sync::Arc::new(arrow::datatypes::Field::new(
                fields[col].name(),
                target_dt.clone(),
                true,
            ));
            let new_schema = std::sync::Arc::new(arrow::datatypes::Schema::new(fields));
            new_batches.push(
                RecordBatch::try_new(new_schema, columns)
                    .map_err(|e| JsValue::from_str(&format!("Batch rebuild error: {}", e)))?,
            );
        }

        store.batches = new_batches;
        store.col_types[col] = match target_type {
            "timestamp" => "timestamp".to_string(),
            "numeric" => "numeric".to_string(),
            "boolean" => "boolean".to_string(),
            _ => "categorical".to_string(),
        };

        Ok(())
    })
}

// --- Store-based filter rows ---

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum FilterSpec {
    #[serde(rename = "range")]
    Range { col: usize, min: f64, max: f64 },
    #[serde(rename = "set")]
    Set { col: usize, values: Vec<String> },
    #[serde(rename = "not_in")]
    NotIn { col: usize, values: Vec<String> },
    #[serde(rename = "boolean")]
    Boolean { col: usize, value: bool },
}

/// Apply filter predicates to the store and return matching row indices.
/// `filters_js` is a JSON array of filter specs:
///   [{kind: "range", col: 0, min: 10, max: 50},
///    {kind: "set", col: 1, values: ["a", "b"]},
///    {kind: "boolean", col: 3, value: true}]
/// Returns a Vec<u32> of row indices that pass ALL filters (AND logic).
#[wasm_bindgen]
pub fn store_filter_rows(handle: u32, filters_js: JsValue) -> Result<Vec<u32>, JsValue> {
    let filters: Vec<FilterSpec> = serde_wasm_bindgen::from_value(filters_js)
        .map_err(|e| JsValue::from_str(&format!("Failed to parse filters: {}", e)))?;

    if filters.is_empty() {
        // No filters — return all row indices
        return with_store(handle, |s| (0..s.total_rows as u32).collect())
            .map_err(|e| JsValue::from_str(&e));
    }

    // Pre-build HashSets for set and not_in filters
    let set_lookups: Vec<Option<HashSet<&str>>> = filters
        .iter()
        .map(|f| match f {
            FilterSpec::Set { values, .. } | FilterSpec::NotIn { values, .. } => {
                Some(values.iter().map(|s| s.as_str()).collect())
            }
            _ => None,
        })
        .collect();

    with_store(handle, |s| filter_rows_in_store(s, &filters, &set_lookups))
        .map_err(|e| JsValue::from_str(&e))
}

fn filter_rows_in_store(
    s: &DataStore,
    filters: &[FilterSpec],
    set_lookups: &[Option<HashSet<&str>>],
) -> Vec<u32> {
    let total = s.total_rows;
    let mut result = Vec::with_capacity(total);

    'row: for row in 0..total {
        let Some((batch_idx, local_row)) = s.resolve_row(row) else {
            continue;
        };
        let batch = &s.batches[batch_idx];

        for (fi, filter) in filters.iter().enumerate() {
            match filter {
                FilterSpec::Range { col, min, max } => {
                    if *col >= batch.num_columns() {
                        continue 'row;
                    }
                    let arr = batch.column(*col);
                    if arr.is_null(local_row) {
                        continue 'row;
                    }
                    let v = get_f64_value(arr.as_ref(), local_row);
                    if v.is_nan() || v < *min || v > *max {
                        continue 'row;
                    }
                }
                FilterSpec::Set { col, .. } => {
                    if *col >= batch.num_columns() {
                        continue 'row;
                    }
                    let arr = batch.column(*col);
                    let value = cell_string_for(s, *col, arr.as_ref(), local_row);
                    if let Some(ref lookup) = set_lookups[fi] {
                        if !lookup.contains(value.as_str()) {
                            continue 'row;
                        }
                    }
                }
                FilterSpec::NotIn { col, .. } => {
                    if *col >= batch.num_columns() {
                        continue 'row;
                    }
                    let arr = batch.column(*col);
                    let value = cell_string_for(s, *col, arr.as_ref(), local_row);
                    if let Some(ref lookup) = set_lookups[fi] {
                        // Inverted logic: skip row if value IS in the exclusion set
                        if lookup.contains(value.as_str()) {
                            continue 'row;
                        }
                    }
                }
                FilterSpec::Boolean { col, value } => {
                    if *col >= batch.num_columns() {
                        continue 'row;
                    }
                    let arr = batch.column(*col);
                    if arr.is_null(local_row) {
                        continue 'row;
                    }
                    if let Some(bool_arr) = arr.as_any().downcast_ref::<BooleanArray>() {
                        if bool_arr.value(local_row) != *value {
                            continue 'row;
                        }
                    } else {
                        continue 'row;
                    }
                }
            }
        }
        result.push(row as u32);
    }

    result
}

/// Extract an f64 from any numeric or timestamp array at the given row.
fn get_f64_value(arr: &dyn Array, row: usize) -> f64 {
    match arr.data_type() {
        DataType::Float64 => arr
            .as_any()
            .downcast_ref::<Float64Array>()
            .map(|a| a.value(row))
            .unwrap_or(f64::NAN),
        DataType::Float32 => arr
            .as_any()
            .downcast_ref::<arrow::array::Float32Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::Int32 => arr
            .as_any()
            .downcast_ref::<Int32Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::Int64 => arr
            .as_any()
            .downcast_ref::<Int64Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::UInt32 => arr
            .as_any()
            .downcast_ref::<UInt32Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::UInt64 => arr
            .as_any()
            .downcast_ref::<UInt64Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::Int16 => arr
            .as_any()
            .downcast_ref::<arrow::array::Int16Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::Int8 => arr
            .as_any()
            .downcast_ref::<arrow::array::Int8Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::UInt16 => arr
            .as_any()
            .downcast_ref::<arrow::array::UInt16Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::UInt8 => arr
            .as_any()
            .downcast_ref::<arrow::array::UInt8Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::Timestamp(TimeUnit::Millisecond, _) => arr
            .as_any()
            .downcast_ref::<arrow::array::TimestampMillisecondArray>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        DataType::Timestamp(TimeUnit::Microsecond, _) => arr
            .as_any()
            .downcast_ref::<arrow::array::TimestampMicrosecondArray>()
            .map(|a| a.value(row) as f64 / 1000.0)
            .unwrap_or(f64::NAN),
        DataType::Timestamp(TimeUnit::Nanosecond, _) => arr
            .as_any()
            .downcast_ref::<arrow::array::TimestampNanosecondArray>()
            .map(|a| a.value(row) as f64 / 1_000_000.0)
            .unwrap_or(f64::NAN),
        DataType::Timestamp(TimeUnit::Second, _) => arr
            .as_any()
            .downcast_ref::<arrow::array::TimestampSecondArray>()
            .map(|a| a.value(row) as f64 * 1000.0)
            .unwrap_or(f64::NAN),
        DataType::Date32 => arr
            .as_any()
            .downcast_ref::<arrow::array::Date32Array>()
            .map(|a| a.value(row) as f64 * 86_400_000.0)
            .unwrap_or(f64::NAN),
        DataType::Date64 => arr
            .as_any()
            .downcast_ref::<arrow::array::Date64Array>()
            .map(|a| a.value(row) as f64)
            .unwrap_or(f64::NAN),
        _ => f64::NAN,
    }
}

/// Extract a string value from any string, boolean, or dictionary-encoded column.
#[cfg(test)]
fn get_string_value(arr: &dyn Array, row: usize) -> String {
    // String-like types (Utf8 / LargeUtf8 / Utf8View / Dict<string>) via the
    // shared helper. Handles null internally.
    if let Some(s) = nteract_predicate::arrow_utils::string_at(arr, row) {
        return s;
    }
    if cell_is_null(arr, row) {
        return String::new();
    }
    match arr.data_type() {
        DataType::Boolean => arr
            .as_any()
            .downcast_ref::<BooleanArray>()
            .map(|a| {
                if a.value(row) {
                    "Yes".to_string()
                } else {
                    "No".to_string()
                }
            })
            .unwrap_or_default(),
        _ => ArrayFormatter::try_new(arr, &Default::default())
            .ok()
            .map(|formatter| formatter.value(row).to_string())
            .unwrap_or_default(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{
        ArrayRef, BinaryArray, BooleanArray, Float64Array, Int32Array, Int64Array,
        LargeBinaryArray, NullArray, StringArray, StructArray,
    };
    use arrow::datatypes::{Field, Schema};
    use std::collections::HashMap;
    use std::sync::Arc;

    #[test]
    fn format_date_only() {
        let ms = 1_776_902_400_000; // 2026-04-23 00:00:00 UTC
        assert_eq!(format_timestamp_ms(ms, None, false), "Apr 23, 2026");
    }

    #[test]
    fn format_datetime_utc() {
        let ms = 1_776_929_400_000; // 2026-04-23 07:30:00 UTC
        assert_eq!(format_timestamp_ms(ms, None, true), "Apr 23, 2026, 7:30 AM");
    }

    #[test]
    fn format_datetime_with_timezone() {
        let ms = 1_776_954_600_000; // 2026-04-23 14:30:00 UTC = 07:30 AM PDT
        assert_eq!(
            format_timestamp_ms(ms, Some("America/Los_Angeles"), true),
            "Apr 23, 2026, 7:30 AM"
        );
    }

    #[test]
    fn format_date_with_timezone_shifts_day() {
        // 2026-04-23 03:00:00 UTC = Apr 22 8:00 PM in LA
        let ms = 1_776_902_400_000 + 3 * 3_600_000;
        assert_eq!(
            format_timestamp_ms(ms, Some("America/Los_Angeles"), false),
            "Apr 22, 2026"
        );
    }

    #[test]
    fn format_midnight_utc_datetime() {
        let ms = 1_776_902_400_000; // 2026-04-23 00:00:00 UTC
        assert_eq!(
            format_timestamp_ms(ms, None, true),
            "Apr 23, 2026, 12:00 AM"
        );
    }

    #[test]
    fn format_invalid_timestamp() {
        assert_eq!(
            format_timestamp_ms(i64::MAX, None, false),
            i64::MAX.to_string()
        );
    }

    #[test]
    fn filter_string_value_matches_display_formatter_for_struct_rows() {
        let metrics = StructArray::from(vec![
            (
                Arc::new(Field::new("clicks", DataType::Int32, false)),
                Arc::new(Int32Array::from(vec![375, 651])) as ArrayRef,
            ),
            (
                Arc::new(Field::new("ratio", DataType::Float64, false)),
                Arc::new(Float64Array::from(vec![0.1, 0.2])) as ArrayRef,
            ),
        ]);
        let formatter = ArrayFormatter::try_new(&metrics, &Default::default()).unwrap();

        assert_eq!(
            get_string_value(&metrics, 0),
            formatter.value(0).to_string()
        );
        assert_eq!(
            get_string_value(&metrics, 1),
            formatter.value(1).to_string()
        );
        assert_ne!(
            get_string_value(&metrics, 1),
            format!("{:?}", metrics.as_any())
        );
    }

    #[test]
    fn filter_string_value_matches_display_formatter_after_concat() {
        let first = StructArray::from(vec![
            (
                Arc::new(Field::new("clicks", DataType::Int32, false)),
                Arc::new(Int32Array::from(vec![375])) as ArrayRef,
            ),
            (
                Arc::new(Field::new("ratio", DataType::Float64, false)),
                Arc::new(Float64Array::from(vec![0.353])) as ArrayRef,
            ),
        ]);
        let second = StructArray::from(vec![
            (
                Arc::new(Field::new("clicks", DataType::Int32, false)),
                Arc::new(Int32Array::from(vec![651])) as ArrayRef,
            ),
            (
                Arc::new(Field::new("ratio", DataType::Float64, false)),
                Arc::new(Float64Array::from(vec![0.118])) as ArrayRef,
            ),
        ]);
        let arrays: Vec<&dyn Array> = vec![&first, &second];
        let combined = concat(&arrays).unwrap();
        let first_formatter = ArrayFormatter::try_new(&first, &Default::default()).unwrap();
        let second_formatter = ArrayFormatter::try_new(&second, &Default::default()).unwrap();

        assert_eq!(
            get_string_value(combined.as_ref(), 0),
            first_formatter.value(0).to_string()
        );
        assert_eq!(
            get_string_value(combined.as_ref(), 1),
            second_formatter.value(0).to_string()
        );
    }

    fn ipc_stream(schema: Arc<Schema>, columns: Vec<ArrayRef>) -> Vec<u8> {
        let batch = RecordBatch::try_new(schema.clone(), columns).expect("record batch");
        let mut buf = Vec::new();
        {
            let mut writer = StreamWriter::try_new(&mut buf, &schema).expect("stream writer");
            writer.write(&batch).expect("write batch");
            writer.finish().expect("finish stream");
        }
        buf
    }

    fn append_ipc_chunk(store: &mut DataStore, ipc_bytes: &[u8]) -> Result<(), String> {
        let (schema, batches) = arrow_stream_batches(ipc_bytes)?;
        append_batches_to_store(store, schema, batches)
    }

    #[test]
    fn arrow_stream_chunks_append_to_empty_store() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("name", DataType::Utf8, false),
        ]));
        let first = ipc_stream(
            schema.clone(),
            vec![
                Arc::new(Int32Array::from(vec![1, 2])) as ArrayRef,
                Arc::new(StringArray::from(vec!["alpha", "beta"])) as ArrayRef,
            ],
        );
        let second = ipc_stream(
            schema,
            vec![
                Arc::new(Int32Array::from(vec![3])) as ArrayRef,
                Arc::new(StringArray::from(vec!["gamma"])) as ArrayRef,
            ],
        );
        let mut store = empty_streaming_store();

        append_ipc_chunk(&mut store, &first).expect("first chunk");
        append_ipc_chunk(&mut store, &second).expect("second chunk");

        assert_eq!(store.total_rows, 3);
        assert_eq!(store.batch_offsets, vec![0, 2]);
        assert_eq!(store.col_names, vec!["id", "name"]);
        assert_eq!(store.col_types, vec!["numeric", "categorical"]);
        assert_eq!(
            cell_string_for(&store, 1, store.batches[0].column(1).as_ref(), 1),
            "beta"
        );
        assert_eq!(
            cell_string_for(&store, 1, store.batches[1].column(1).as_ref(), 0),
            "gamma"
        );
    }

    #[test]
    fn arrow_stream_chunks_reject_schema_mismatch() {
        let first_schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let second_schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Utf8, false)]));
        let first = ipc_stream(
            first_schema,
            vec![Arc::new(Int32Array::from(vec![1])) as ArrayRef],
        );
        let second = ipc_stream(
            second_schema,
            vec![Arc::new(StringArray::from(vec!["bad"])) as ArrayRef],
        );
        let mut store = empty_streaming_store();

        append_ipc_chunk(&mut store, &first).expect("first chunk");
        let err = append_ipc_chunk(&mut store, &second).expect_err("schema mismatch");

        assert!(err.contains("schema mismatch"));
        assert_eq!(store.total_rows, 1);
    }

    #[test]
    fn arrow_stream_chunks_reject_appends_after_finish() {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let chunk = ipc_stream(
            schema,
            vec![Arc::new(Int32Array::from(vec![1])) as ArrayRef],
        );
        let mut store = empty_streaming_store();

        append_ipc_chunk(&mut store, &chunk).expect("first chunk");
        store.streaming_complete = true;
        let err = append_ipc_chunk(&mut store, &chunk).expect_err("finished store");

        assert!(err.contains("already finished"));
        assert_eq!(store.total_rows, 1);
    }

    #[test]
    fn store_filter_rows_matches_struct_value_count_labels() {
        let schema = Arc::new(Schema::new(vec![Field::new(
            "metrics",
            DataType::Struct(
                vec![
                    Field::new("clicks", DataType::Int64, false),
                    Field::new("ratio", DataType::Float64, false),
                ]
                .into(),
            ),
            false,
        )]));
        let first_metrics = StructArray::from(vec![
            (
                Arc::new(Field::new("clicks", DataType::Int64, false)),
                Arc::new(Int64Array::from(vec![375])) as ArrayRef,
            ),
            (
                Arc::new(Field::new("ratio", DataType::Float64, false)),
                Arc::new(Float64Array::from(vec![0.353])) as ArrayRef,
            ),
        ]);
        let second_metrics = StructArray::from(vec![
            (
                Arc::new(Field::new("clicks", DataType::Int64, false)),
                Arc::new(Int64Array::from(vec![651])) as ArrayRef,
            ),
            (
                Arc::new(Field::new("ratio", DataType::Float64, false)),
                Arc::new(Float64Array::from(vec![0.118])) as ArrayRef,
            ),
        ]);
        let first_batch =
            RecordBatch::try_new(schema.clone(), vec![Arc::new(first_metrics) as ArrayRef])
                .expect("record batch");
        let second_batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(second_metrics.clone()) as ArrayRef],
        )
        .expect("record batch");
        let store = DataStore {
            schema: Some(schema),
            batches: vec![first_batch, second_batch],
            batch_offsets: vec![0, 1],
            total_rows: 2,
            num_cols: 1,
            col_names: vec!["metrics".to_string()],
            col_types: vec!["categorical".to_string()],
            col_timezones: vec![None],
            original_columns: HashMap::new(),
            streaming_complete: true,
        };
        let formatter = ArrayFormatter::try_new(&second_metrics, &Default::default()).unwrap();
        let selected = formatter.value(0).to_string();
        let filters = vec![FilterSpec::Set {
            col: 0,
            values: vec![selected.clone()],
        }];
        let set_lookups = vec![Some(HashSet::from([selected.as_str()]))];

        assert_eq!(
            filter_rows_in_store(&store, &filters, &set_lookups),
            vec![1]
        );
    }

    #[test]
    fn viewport_cells_are_flattened_in_requested_order() {
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("name", DataType::Utf8, false),
            Field::new("score", DataType::Float64, true),
            Field::new("active", DataType::Boolean, false),
        ]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int32Array::from(vec![1, 2])) as ArrayRef,
                Arc::new(StringArray::from(vec!["Alice", "Bob"])) as ArrayRef,
                Arc::new(Float64Array::from(vec![None, Some(88.0)])) as ArrayRef,
                Arc::new(BooleanArray::from(vec![true, false])) as ArrayRef,
            ],
        )
        .expect("record batch");
        let store = DataStore {
            schema: Some(schema),
            batches: vec![batch],
            batch_offsets: vec![0],
            total_rows: 2,
            num_cols: 4,
            col_names: vec![
                "id".to_string(),
                "name".to_string(),
                "score".to_string(),
                "active".to_string(),
            ],
            col_types: vec![
                "numeric".to_string(),
                "categorical".to_string(),
                "numeric".to_string(),
                "boolean".to_string(),
            ],
            col_timezones: vec![None, None, None, None],
            original_columns: HashMap::new(),
            streaming_complete: true,
        };

        let out = viewport_cells_for(&store, &[1, 0]);

        assert_eq!(out.rows, vec![1, 0]);
        assert_eq!(
            out.strings,
            vec!["2", "Bob", "88", "No", "1", "Alice", "", "Yes"]
        );
        assert_eq!(
            out.numeric_values,
            vec![
                Some(2.0),
                None,
                Some(88.0),
                None,
                Some(1.0),
                None,
                None,
                None
            ]
        );
        assert_eq!(
            out.nulls,
            vec![false, false, false, false, false, false, true, false]
        );
    }

    #[test]
    fn viewport_cells_treat_null_arrays_as_null_cells() {
        let schema = Arc::new(Schema::new(vec![Field::new("empty", DataType::Null, true)]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(NullArray::new(3)) as ArrayRef])
            .expect("record batch");
        let store = DataStore {
            schema: Some(batch.schema()),
            batches: vec![batch],
            batch_offsets: vec![0],
            total_rows: 3,
            num_cols: 1,
            col_names: vec!["empty".to_string()],
            col_types: vec!["categorical".to_string()],
            col_timezones: vec![None],
            original_columns: HashMap::new(),
            streaming_complete: true,
        };

        let out = viewport_cells_for(&store, &[0, 2]);

        assert_eq!(out.rows, vec![0, 2]);
        assert_eq!(out.strings, vec!["", ""]);
        assert_eq!(out.numeric_values, vec![None, None]);
        assert_eq!(out.nulls, vec![true, true]);
        assert!(cell_is_null(store.batches[0].column(0).as_ref(), 1));
        assert_eq!(
            cell_string_for(&store, 0, store.batches[0].column(0).as_ref(), 1),
            ""
        );
        assert!(cell_f64_for(store.batches[0].column(0).as_ref(), 1).is_nan());
    }

    /// HuggingFace's Image / Audio / Video features all serialize as
    /// `Struct{bytes: Binary, path: String}`. The viewer needs the raw
    /// `bytes` field to render thumbnails / play audio; `cell_bytes_for`
    /// is the helper that yields it without materializing the whole
    /// struct cell.
    fn image_struct(
        rows: Vec<Option<&'static [u8]>>,
        paths: Vec<Option<&'static str>>,
    ) -> StructArray {
        let bytes = BinaryArray::from_opt_vec(rows);
        let path = StringArray::from(paths);
        StructArray::from(vec![
            (
                Arc::new(Field::new("bytes", DataType::Binary, true)),
                Arc::new(bytes) as ArrayRef,
            ),
            (
                Arc::new(Field::new("path", DataType::Utf8, true)),
                Arc::new(path) as ArrayRef,
            ),
        ])
    }

    fn store_with_one_struct_column(arr: StructArray) -> DataStore {
        let total_rows = arr.len();
        let col_type = DataStore::detect_col_type(arr.data_type()).to_string();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "img",
            arr.data_type().clone(),
            true,
        )]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(arr) as ArrayRef]).expect("record batch");
        DataStore {
            schema: Some(batch.schema()),
            batches: vec![batch],
            batch_offsets: vec![0],
            total_rows,
            num_cols: 1,
            col_names: vec!["img".to_string()],
            col_types: vec![col_type],
            col_timezones: vec![None],
            original_columns: HashMap::new(),
            streaming_complete: true,
        }
    }

    #[test]
    fn cell_bytes_returns_struct_bytes_field_for_binary_inner() {
        let arr = image_struct(
            vec![Some(b"\x89PNG\r\n\x1a\n"), Some(b"\xff\xd8\xff\xe0")],
            vec![Some("a.png"), Some("b.jpg")],
        );
        let store = store_with_one_struct_column(arr);

        assert_eq!(cell_bytes_for(&store, 0, 0), b"\x89PNG\r\n\x1a\n");
        assert_eq!(cell_bytes_for(&store, 1, 0), b"\xff\xd8\xff\xe0");
    }

    #[test]
    fn cell_bytes_returns_empty_for_null_struct_bytes_field() {
        let arr = image_struct(vec![None, Some(b"X")], vec![None, Some("ok")]);
        let store = store_with_one_struct_column(arr);

        assert!(cell_bytes_for(&store, 0, 0).is_empty());
        assert_eq!(cell_bytes_for(&store, 1, 0), b"X");
    }

    #[test]
    fn cell_bytes_returns_empty_for_out_of_range_row() {
        let arr = image_struct(vec![Some(b"X")], vec![Some("ok")]);
        let store = store_with_one_struct_column(arr);

        assert!(cell_bytes_for(&store, 5, 0).is_empty());
    }

    #[test]
    fn cell_bytes_supports_large_binary_inner() {
        let bytes = LargeBinaryArray::from_opt_vec(vec![Some(b"\x47\x49\x46\x38".as_ref())]);
        let path = StringArray::from(vec![Some("c.gif")]);
        let arr = StructArray::from(vec![
            (
                Arc::new(Field::new("bytes", DataType::LargeBinary, true)),
                Arc::new(bytes) as ArrayRef,
            ),
            (
                Arc::new(Field::new("path", DataType::Utf8, true)),
                Arc::new(path) as ArrayRef,
            ),
        ]);
        let store = store_with_one_struct_column(arr);

        assert_eq!(cell_bytes_for(&store, 0, 0), b"\x47\x49\x46\x38");
    }

    #[test]
    fn cell_bytes_returns_empty_when_struct_lacks_bytes_field() {
        let metrics = StructArray::from(vec![
            (
                Arc::new(Field::new("clicks", DataType::Int32, false)),
                Arc::new(Int32Array::from(vec![1])) as ArrayRef,
            ),
            (
                Arc::new(Field::new("ratio", DataType::Float64, false)),
                Arc::new(Float64Array::from(vec![0.5])) as ArrayRef,
            ),
        ]);
        let store = store_with_one_struct_column(metrics);

        assert!(cell_bytes_for(&store, 0, 0).is_empty());
    }

    /// HuggingFace's `images: List<Image>` shape (e.g. ShadenA/MathNet) needs
    /// a per-cell count + per-index byte access so the renderer can lay out a
    /// row of thumbnails. The list-cell helpers wrap that.
    fn list_of_image_struct(rows: Vec<Vec<&'static [u8]>>) -> ListArray {
        use arrow::buffer::OffsetBuffer;

        // Build flat children + offsets
        let mut all_bytes: Vec<Option<&[u8]>> = Vec::new();
        let mut all_paths: Vec<Option<&str>> = Vec::new();
        let mut offsets: Vec<i32> = vec![0];

        for row in &rows {
            for b in row {
                all_bytes.push(Some(b));
                all_paths.push(Some("p"));
            }
            offsets.push(all_bytes.len() as i32);
        }
        let bytes_arr = BinaryArray::from_opt_vec(all_bytes);
        let path_arr = StringArray::from(all_paths);
        let inner_struct = StructArray::from(vec![
            (
                Arc::new(Field::new("bytes", DataType::Binary, true)),
                Arc::new(bytes_arr) as ArrayRef,
            ),
            (
                Arc::new(Field::new("path", DataType::Utf8, true)),
                Arc::new(path_arr) as ArrayRef,
            ),
        ]);
        let inner_field = Arc::new(Field::new("item", inner_struct.data_type().clone(), true));
        ListArray::new(
            inner_field,
            OffsetBuffer::new(offsets.into()),
            Arc::new(inner_struct) as ArrayRef,
            None,
        )
    }

    fn list_of_blob_struct(rows: Vec<Vec<&'static [u8]>>) -> ListArray {
        use arrow::buffer::OffsetBuffer;

        let mut all_bytes: Vec<Option<&[u8]>> = Vec::new();
        let mut offsets: Vec<i32> = vec![0];

        for row in &rows {
            for b in row {
                all_bytes.push(Some(b));
            }
            offsets.push(all_bytes.len() as i32);
        }
        let bytes_arr = BinaryArray::from_opt_vec(all_bytes);
        let inner_struct = StructArray::from(vec![(
            Arc::new(Field::new("bytes", DataType::Binary, true)),
            Arc::new(bytes_arr) as ArrayRef,
        )]);
        let inner_field = Arc::new(Field::new("item", inner_struct.data_type().clone(), true));
        ListArray::new(
            inner_field,
            OffsetBuffer::new(offsets.into()),
            Arc::new(inner_struct) as ArrayRef,
            None,
        )
    }

    fn store_with_one_list_column(arr: ListArray) -> DataStore {
        let total_rows = arr.len();
        let col_type = DataStore::detect_col_type(arr.data_type()).to_string();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "images",
            arr.data_type().clone(),
            true,
        )]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(arr) as ArrayRef]).expect("record batch");
        DataStore {
            schema: Some(batch.schema()),
            batches: vec![batch],
            batch_offsets: vec![0],
            total_rows,
            num_cols: 1,
            col_names: vec!["images".to_string()],
            col_types: vec![col_type],
            col_timezones: vec![None],
            original_columns: HashMap::new(),
            streaming_complete: true,
        }
    }

    #[test]
    fn detects_image_columns_from_huggingface_struct_shapes_without_metadata() {
        let arr = image_struct(vec![Some(b"x")], vec![Some("a.png")]);
        assert_eq!(DataStore::detect_col_type(arr.data_type()), "image");

        let list = list_of_image_struct(vec![vec![b"\x89PNG"]]);
        assert_eq!(DataStore::detect_col_type(list.data_type()), "image");
    }

    #[test]
    fn viewport_cells_do_not_format_image_bytes_as_text() {
        let arr = image_struct(
            vec![Some(b"\x89PNG\r\n\x1a\nnot formatted as a struct")],
            vec![Some("a.png")],
        );
        let store = store_with_one_struct_column(arr);

        let out = viewport_cells_for(&store, &[0]);

        assert_eq!(out.rows, vec![0]);
        assert_eq!(out.strings, vec![""]);
        assert_eq!(out.numeric_values, vec![None]);
        assert_eq!(out.nulls, vec![false]);
    }

    #[test]
    fn viewport_cells_compact_large_binary_lists() {
        static LARGE_BYTES: [u8; MAX_INLINE_BINARY_BYTES + 1] = [b'x'; MAX_INLINE_BINARY_BYTES + 1];
        let arr = list_of_blob_struct(vec![vec![&LARGE_BYTES, b"small"]]);
        let total_rows = arr.len();
        let schema = Arc::new(Schema::new(vec![Field::new(
            "payloads",
            arr.data_type().clone(),
            true,
        )]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(arr) as ArrayRef]).expect("record batch");
        let store = DataStore {
            schema: Some(batch.schema()),
            batches: vec![batch],
            batch_offsets: vec![0],
            total_rows,
            num_cols: 1,
            col_names: vec!["payloads".to_string()],
            col_types: vec!["categorical".to_string()],
            col_timezones: vec![None],
            original_columns: HashMap::new(),
            streaming_complete: true,
        };

        let out = viewport_cells_for(&store, &[0]);

        assert_eq!(out.strings, vec!["list of size 2"]);
    }

    #[test]
    fn image_count_is_one_for_struct_cell_and_zero_for_null_or_oob() {
        let arr = image_struct(vec![Some(b"x"), None], vec![Some("a"), None]);
        let store = store_with_one_struct_column(arr);

        assert_eq!(cell_image_count_for(&store, 0, 0), 1);
        assert_eq!(cell_image_count_for(&store, 1, 0), 0, "null cell -> 0");
        assert_eq!(cell_image_count_for(&store, 99, 0), 0, "oob -> 0");
    }

    #[test]
    fn image_count_matches_inner_list_length() {
        let arr = list_of_image_struct(vec![
            vec![],
            vec![b"\x89PNG", b"\xff\xd8\xff", b"\x47\x49\x46\x38"],
            vec![b"only"],
        ]);
        let store = store_with_one_list_column(arr);

        assert_eq!(cell_image_count_for(&store, 0, 0), 0);
        assert_eq!(cell_image_count_for(&store, 1, 0), 3);
        assert_eq!(cell_image_count_for(&store, 2, 0), 1);
    }

    #[test]
    fn cell_bytes_at_returns_each_image_in_a_list() {
        let arr = list_of_image_struct(vec![vec![b"\x89PNG", b"\xff\xd8\xff"]]);
        let store = store_with_one_list_column(arr);

        assert_eq!(cell_bytes_at_for(&store, 0, 0, 0), b"\x89PNG");
        assert_eq!(cell_bytes_at_for(&store, 0, 0, 1), b"\xff\xd8\xff");
        assert!(
            cell_bytes_at_for(&store, 0, 0, 2).is_empty(),
            "out-of-range idx -> empty"
        );
    }

    #[test]
    fn cell_bytes_at_for_struct_cell_only_accepts_idx_zero() {
        let arr = image_struct(vec![Some(b"X")], vec![Some("a")]);
        let store = store_with_one_struct_column(arr);

        assert_eq!(cell_bytes_at_for(&store, 0, 0, 0), b"X");
        assert!(
            cell_bytes_at_for(&store, 0, 0, 1).is_empty(),
            "struct cell has no idx > 0"
        );
    }
}
