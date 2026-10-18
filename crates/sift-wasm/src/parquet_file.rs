//! Byte-range Parquet reading.
//!
//! The host owns the file and reads ranges on request; WASM never holds the
//! whole file. A `ParquetFile` is opened from the footer alone, exposes the
//! byte ranges each row group needs, and decodes one row group at a time from
//! the bytes the host fetched for those ranges. Decoded row groups append to a
//! regular `DataStore`, so everything downstream (cells, summaries, sort,
//! filter, casts) is unchanged.
//!
//! Admission limits apply from the footer and cumulatively across appended
//! row groups: every row group ends up resident in this model, so the
//! decoded-bytes cap is a cap on the whole table.

use crate::store::{
    admit_parquet_footer, append_batches_to_store, collect_file_batches_into,
    empty_streaming_store, next_handle, set_store_schema, with_stores, FileLimits, FileUsage,
    PARQUET_BATCH_ROWS,
};
use bytes::{Buf, Bytes};
use nteract_predicate::parquet_features::{file_key_value_metadata, parse_parquet_column_hints};
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions};
use parquet::errors::{ParquetError, Result as ParquetResult};
use parquet::file::metadata::{ParquetMetaData, ParquetMetaDataReader};
use parquet::file::reader::{ChunkReader, Length};
use parquet::file::FOOTER_SIZE;
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use wasm_bindgen::prelude::*;

/// Smallest file that can carry a footer: leading magic, footer, trailing magic.
const MIN_PARQUET_FILE_LEN: u64 = 4 + FOOTER_SIZE as u64;

struct ParquetFile {
    arrow: ArrowReaderMetadata,
    file_len: u64,
    limits: FileLimits,
    /// Rows and retained memory of every row group committed to the store.
    /// Updated only after a row group both decodes and appends, so a rejected
    /// group never shows up here.
    usage: FileUsage,
    /// One flag per row group. A row group may be appended once per file
    /// handle, so a retried fetch cannot duplicate rows in the store.
    appended: Vec<bool>,
}

impl ParquetFile {
    fn metadata(&self) -> &Arc<ParquetMetaData> {
        self.arrow.metadata()
    }

    fn remaining_decoded_bytes(&self) -> u64 {
        u64::from(self.limits.decoded_bytes).saturating_sub(self.usage.memory.bytes)
    }
}

/// Byte range of a column chunk, validated. The parquet crate keeps these as
/// signed thrift values and `byte_range()` asserts on negatives, so a hostile
/// footer must be rejected here rather than trapping the module.
fn chunk_range(
    column: &parquet::file::metadata::ColumnChunkMetaData,
) -> Result<(u64, u64), String> {
    if column.data_page_offset() < 0 {
        return Err("Parquet column chunk data page offset is negative".to_string());
    }
    let start = match column.dictionary_page_offset() {
        Some(offset) => offset,
        None => column.data_page_offset(),
    };
    let start = u64::try_from(start).map_err(|_| "Parquet column chunk offset is negative")?;
    let length = u64::try_from(column.compressed_size())
        .map_err(|_| "Parquet column chunk size is negative")?;
    start
        .checked_add(length)
        .ok_or("Parquet column chunk range overflows")?;
    Ok((start, length))
}

/// Check every column chunk against the data region `[4, file_end)` and the
/// reader's addressable range. parquet's sync page reader narrows offsets to
/// `usize`, so on wasm32 anything past 4 GiB cannot be read correctly.
fn validate_chunk_ranges(
    metadata: &ParquetMetaData,
    file_end: u64,
    addressable: u64,
) -> Result<(), String> {
    for (group_index, group) in metadata.row_groups().iter().enumerate() {
        if group.num_rows() < 0 || group.total_byte_size() < 0 {
            return Err(format!(
                "Parquet row group {group_index} has a negative size"
            ));
        }
        for column in group.columns() {
            let (offset, length) =
                chunk_range(column).map_err(|e| format!("{e} (row group {group_index})"))?;
            let end = offset + length;
            if offset < 4 || end > file_end {
                return Err(format!(
                    "Parquet row group {group_index} column chunk lies outside the file"
                ));
            }
            if end > addressable {
                return Err(format!(
                    "Parquet row group {group_index} lies beyond {addressable} bytes, which this build cannot address"
                ));
            }
        }
    }
    Ok(())
}

static FILES: Mutex<Option<HashMap<u32, ParquetFile>>> = Mutex::new(None);

fn with_files<F, R>(f: F) -> R
where
    F: FnOnce(&mut HashMap<u32, ParquetFile>) -> R,
{
    let mut guard = FILES.lock().unwrap_or_else(|e| e.into_inner());
    let files = guard.get_or_insert_with(HashMap::new);
    f(files)
}

fn with_file<F, R>(handle: u32, f: F) -> Result<R, String>
where
    F: FnOnce(&mut ParquetFile) -> Result<R, String>,
{
    with_files(|files| {
        let file = files
            .get_mut(&handle)
            .ok_or_else(|| format!("Invalid Parquet file handle: {handle}"))?;
        f(file)
    })
}

fn js_err(message: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&message.to_string())
}

/// Decode the 8-byte footer tail and return the metadata length.
fn footer_metadata_length(tail: &[u8]) -> Result<usize, String> {
    if tail.len() < FOOTER_SIZE {
        return Err(format!(
            "Parquet footer needs {FOOTER_SIZE} bytes, got {}",
            tail.len()
        ));
    }
    let footer: [u8; FOOTER_SIZE] = tail[tail.len() - FOOTER_SIZE..]
        .try_into()
        .map_err(|_| "Parquet footer tail is not 8 bytes".to_string())?;
    let footer = ParquetMetaDataReader::decode_footer_tail(&footer).map_err(|e| e.to_string())?;
    if footer.is_encrypted_footer() {
        return Err("Encrypted Parquet files are not supported".to_string());
    }
    Ok(footer.metadata_length())
}

fn file_len_from_js(file_len: f64) -> Result<u64, String> {
    if !file_len.is_finite()
        || file_len < 0.0
        || file_len.fract() != 0.0
        || file_len > u64::MAX as f64
    {
        return Err("Parquet file length must be a non-negative integer".to_string());
    }
    Ok(file_len as u64)
}

/// Metadata length encoded in the last 8 bytes of a Parquet file. Rejects a
/// bad or encrypted magic before the host reads anything else. `tail` is the
/// end of the file; only its last 8 bytes are inspected.
#[wasm_bindgen]
pub fn parquet_footer_length(tail: &[u8]) -> Result<u32, JsValue> {
    let length = footer_metadata_length(tail).map_err(js_err)?;
    u32::try_from(length).map_err(|_| js_err("Parquet footer length exceeds u32"))
}

/// Open a Parquet file from its tail. `tail` must end with the footer and
/// contain at least `parquet_footer_length(tail) + 8` bytes. `file_len` is the
/// full file length, used to validate column chunk ranges. Admission limits
/// are checked from the footer here and cumulatively on every appended row
/// group. Returns a file handle; free it with `parquet_close`.
#[wasm_bindgen]
pub fn parquet_open(
    tail: &[u8],
    file_len: f64,
    max_rows: u32,
    max_columns: u32,
    max_decoded_bytes: u32,
) -> Result<u32, JsValue> {
    let limits = FileLimits {
        rows: max_rows,
        columns: max_columns,
        decoded_bytes: max_decoded_bytes,
    };
    open_parquet_file(tail, file_len_from_js(file_len).map_err(js_err)?, limits).map_err(js_err)
}

fn open_parquet_file(tail: &[u8], file_len: u64, limits: FileLimits) -> Result<u32, String> {
    let metadata_len = footer_metadata_length(tail)?;
    // The footer must leave room for the leading `PAR1` magic.
    if (metadata_len as u64) + MIN_PARQUET_FILE_LEN > file_len {
        return Err("Parquet footer length exceeds the file length".to_string());
    }
    let metadata_end = tail.len() - FOOTER_SIZE;
    let metadata_start = metadata_end.checked_sub(metadata_len).ok_or_else(|| {
        format!(
            "Parquet tail is too short for its footer: need {} bytes, got {}",
            metadata_len + FOOTER_SIZE,
            tail.len()
        )
    })?;
    let metadata = ParquetMetaDataReader::decode_metadata(&tail[metadata_start..metadata_end])
        .map_err(|e| e.to_string())?;
    let file_end = file_len - FOOTER_SIZE as u64 - metadata_len as u64;
    validate_chunk_ranges(&metadata, file_end, usize::MAX as u64)?;
    let arrow = ArrowReaderMetadata::try_new(Arc::new(metadata), ArrowReaderOptions::default())
        .map_err(|e| e.to_string())?;
    admit_parquet_footer(arrow.schema(), arrow.metadata(), limits)?;
    let appended = vec![false; arrow.metadata().num_row_groups()];
    let handle = next_handle();
    with_files(|files| {
        files.insert(
            handle,
            ParquetFile {
                arrow,
                file_len,
                limits,
                usage: FileUsage::default(),
                appended,
            },
        );
    });
    Ok(handle)
}

#[derive(Serialize)]
struct ParquetFileInfo {
    /// Row count from the footer, as a JS number.
    num_rows: f64,
    num_row_groups: u32,
    /// Row count per row group, in file order.
    row_group_rows: Vec<f64>,
    column_names: Vec<String>,
}

/// Footer summary for an open file: row counts and top-level column names.
#[wasm_bindgen]
pub fn parquet_file_info(file: u32) -> Result<JsValue, JsValue> {
    let info = with_file(file, |file| {
        let metadata = file.metadata();
        Ok(ParquetFileInfo {
            num_rows: metadata.file_metadata().num_rows().max(0) as f64,
            num_row_groups: metadata.num_row_groups() as u32,
            row_group_rows: metadata
                .row_groups()
                .iter()
                .map(|group| group.num_rows().max(0) as f64)
                .collect(),
            column_names: file
                .arrow
                .schema()
                .fields()
                .iter()
                .map(|field| field.name().clone())
                .collect(),
        })
    })
    .map_err(js_err)?;
    serde_wasm_bindgen::to_value(&info).map_err(js_err)
}

/// Canonical column hints (pandas index, HF features) from the open file's
/// footer metadata. Same output as `parquet_column_hints` on the full file.
#[wasm_bindgen]
pub fn parquet_file_column_hints(file: u32) -> Result<JsValue, JsValue> {
    let hints = with_file(file, |file| {
        let metadata = file.metadata();
        let kv_metadata = file_key_value_metadata(metadata);
        let total_rows = metadata.file_metadata().num_rows().max(0) as u64;
        let column_names: Vec<String> = file
            .arrow
            .schema()
            .fields()
            .iter()
            .map(|field| field.name().clone())
            .collect();
        Ok(parse_parquet_column_hints(
            &column_names,
            total_rows,
            &kv_metadata,
        ))
    })
    .map_err(js_err)?;
    serde_wasm_bindgen::to_value(&hints).map_err(js_err)
}

/// Create an empty, appendable store carrying the file's Arrow schema. Row
/// groups are appended with `parquet_append_row_group`; call
/// `finish_arrow_stream_store` after the last one.
#[wasm_bindgen]
pub fn parquet_create_store(file: u32) -> Result<u32, JsValue> {
    create_store(file).map_err(js_err)
}

fn create_store(file: u32) -> Result<u32, String> {
    let schema = with_file(file, |file| Ok(file.arrow.schema().clone()))?;
    let mut store = empty_streaming_store();
    set_store_schema(&mut store, schema);
    let handle = next_handle();
    with_stores(|stores| {
        stores.insert(handle, store);
    });
    Ok(handle)
}

/// Byte ranges of every column chunk in a row group, flattened as
/// `[offset, length, offset, length, ...]` in leaf column order. The host
/// fetches these (coalescing as it likes) and passes the same list back to
/// `parquet_append_row_group` with the concatenated bytes.
#[wasm_bindgen]
pub fn parquet_row_group_ranges(file: u32, row_group: u32) -> Result<Vec<f64>, JsValue> {
    row_group_ranges(file, row_group).map_err(js_err)
}

fn row_group_ranges(file: u32, row_group: u32) -> Result<Vec<f64>, String> {
    with_file(file, |file| {
        let group = row_group_metadata(file.metadata(), row_group)?;
        let mut ranges = Vec::with_capacity(group.columns().len() * 2);
        let mut compressed = 0u64;
        for column in group.columns() {
            let (offset, length) = chunk_range(column)?;
            compressed = compressed.saturating_add(length);
            ranges.push(offset as f64);
            ranges.push(length as f64);
        }
        // Reject before the host fetches anything it cannot keep. Compressed
        // bytes are what the fetch retains; the footer's uncompressed size is
        // the closer estimate of decoded Arrow memory when the writer is honest.
        let estimate = compressed.max(group.total_byte_size().max(0) as u64);
        let remaining = file.remaining_decoded_bytes();
        if estimate > remaining {
            return Err(format!(
                "Parquet row group {row_group} exceeds decoded bytes limit ({estimate} > {remaining} remaining)"
            ));
        }
        Ok(ranges)
    })
}

fn row_group_metadata(
    metadata: &ParquetMetaData,
    row_group: u32,
) -> Result<&parquet::file::metadata::RowGroupMetaData, String> {
    let index = row_group as usize;
    if index >= metadata.num_row_groups() {
        return Err(format!(
            "Parquet row group {row_group} out of range ({} row groups)",
            metadata.num_row_groups()
        ));
    }
    Ok(metadata.row_group(index))
}

/// Decode one row group from host-fetched bytes and append it to `store`.
/// `ranges` is `[offset, length, ...]`; `data` is the concatenation of those
/// ranges in the same order. Ranges may be coalesced supersets of the ones
/// returned by `parquet_row_group_ranges`, but every column chunk of the row
/// group must lie inside a single range. Returns the number of rows appended.
#[wasm_bindgen]
pub fn parquet_append_row_group(
    file: u32,
    store: u32,
    row_group: u32,
    ranges: &[f64],
    data: &[u8],
) -> Result<u32, JsValue> {
    append_row_group(file, store, row_group, ranges, data).map_err(js_err)
}

/// Everything decode needs, copied out of the registry so no lock is held
/// while the decoder runs. A decoder trap under the lock would poison every
/// later call on wasm32, where panics abort instead of unwinding.
struct AppendPlan {
    arrow: ArrowReaderMetadata,
    limits: FileLimits,
    usage: FileUsage,
    expected_rows: u64,
    reader: RangeSetReader,
}

fn append_row_group(
    file: u32,
    store: u32,
    row_group: u32,
    ranges: &[f64],
    data: &[u8],
) -> Result<u32, String> {
    let index = row_group as usize;
    let plan = with_file(file, |file| {
        let group = row_group_metadata(file.metadata(), row_group)?;
        let expected_rows = u64::try_from(group.num_rows())
            .map_err(|_| "Invalid negative Parquet row group row count")?;
        if file.appended[index] {
            return Err(format!("Parquet row group {row_group} is already loaded"));
        }
        let reader = RangeSetReader::new(file.file_len, ranges, data)?;
        for column in group.columns() {
            let (offset, length) = chunk_range(column)?;
            if !reader.covers(offset, length) {
                return Err(format!(
                    "Parquet row group {row_group} column chunk at {offset}+{length} is not covered by the fetched ranges"
                ));
            }
        }
        Ok(AppendPlan {
            arrow: file.arrow.clone(),
            limits: file.limits,
            // A snapshot: the registry's totals change only once the group is
            // in the store, so a rejected group leaves them describing exactly
            // what the store holds.
            usage: file.usage.clone(),
            expected_rows,
            reader,
        })
    })?;

    let AppendPlan {
        arrow,
        limits,
        mut usage,
        expected_rows,
        reader,
    } = plan;
    let batch_reader = ParquetRecordBatchReaderBuilder::new_with_metadata(reader, arrow.clone())
        .with_row_groups(vec![index])
        .with_batch_size(PARQUET_BATCH_ROWS as usize)
        .build()
        .map_err(|e| e.to_string())?;
    let batches = collect_file_batches_into(batch_reader, limits, &mut usage)?;
    let decoded_rows: u64 = batches.iter().map(|batch| batch.num_rows() as u64).sum();
    if decoded_rows != expected_rows {
        return Err("Parquet row group row count does not match its metadata".to_string());
    }

    with_stores(|stores| {
        let target = stores
            .get_mut(&store)
            .ok_or_else(|| format!("Invalid handle: {store}"))?;
        append_batches_to_store(target, arrow.schema().clone(), batches)
    })?;
    // The file may have been closed while decoding; the store still holds the
    // rows, and a closed file cannot be appended to again, so that is fine.
    let _ = with_file(file, |file| {
        file.usage = usage;
        file.appended[index] = true;
        Ok(())
    });
    u32::try_from(decoded_rows).map_err(|_| "Parquet row group exceeds u32 rows".to_string())
}

/// Release an open file's footer metadata. Stores created from it stay valid.
#[wasm_bindgen]
pub fn parquet_close(file: u32) {
    with_files(|files| {
        files.remove(&file);
    });
}

/// A `ChunkReader` over a sparse set of byte ranges from a larger file.
/// Reads must fall entirely inside one fetched range.
#[derive(Debug)]
struct RangeSetReader {
    file_len: u64,
    /// Sorted by offset, non-overlapping.
    segments: Vec<(u64, Bytes)>,
}

impl RangeSetReader {
    fn new(file_len: u64, ranges: &[f64], data: &[u8]) -> Result<Self, String> {
        if !ranges.len().is_multiple_of(2) {
            return Err("Parquet byte ranges must be [offset, length] pairs".to_string());
        }
        let mut segments = Vec::with_capacity(ranges.len() / 2);
        // One copy out of the wasm-bindgen buffer; segments are slices of it.
        let data = Bytes::copy_from_slice(data);
        let mut cursor = 0usize;
        for pair in ranges.chunks_exact(2) {
            let offset = range_component(pair[0], "offset")?;
            let length = range_component(pair[1], "length")?;
            if offset.saturating_add(length) > file_len {
                return Err("Parquet byte range lies outside the file".to_string());
            }
            let length = usize::try_from(length)
                .map_err(|_| "Parquet byte range length exceeds usize".to_string())?;
            let end = cursor
                .checked_add(length)
                .filter(|end| *end <= data.len())
                .ok_or_else(|| "Parquet byte range data is shorter than its ranges".to_string())?;
            // An empty range covers nothing; keeping it would let `locate`
            // land on it instead of a real segment at the same offset.
            if length > 0 {
                segments.push((offset, data.slice(cursor..end)));
            }
            cursor = end;
        }
        if cursor != data.len() {
            return Err("Parquet byte range data is longer than its ranges".to_string());
        }
        segments.sort_by_key(|(offset, _)| *offset);
        for pair in segments.windows(2) {
            if pair[0].0 + pair[0].1.len() as u64 > pair[1].0 {
                return Err("Parquet byte ranges overlap".to_string());
            }
        }
        Ok(Self { file_len, segments })
    }

    fn locate(&self, start: u64) -> Option<(&Bytes, usize)> {
        let index = match self
            .segments
            .binary_search_by(|(offset, _)| offset.cmp(&start))
        {
            Ok(index) => index,
            Err(0) => return None,
            Err(index) => index - 1,
        };
        let (offset, bytes) = &self.segments[index];
        let relative = start - offset;
        if relative >= bytes.len() as u64 {
            return None;
        }
        Some((bytes, relative as usize))
    }

    fn covers(&self, offset: u64, length: u64) -> bool {
        if length == 0 {
            return true;
        }
        match self.locate(offset) {
            Some((bytes, relative)) => relative as u64 + length <= bytes.len() as u64,
            None => false,
        }
    }
}

fn range_component(value: f64, label: &str) -> Result<u64, String> {
    if !value.is_finite() || value < 0.0 || value.fract() != 0.0 || value > u64::MAX as f64 {
        return Err(format!(
            "Parquet byte range {label} must be a non-negative integer"
        ));
    }
    Ok(value as u64)
}

impl Length for RangeSetReader {
    fn len(&self) -> u64 {
        self.file_len
    }
}

impl ChunkReader for RangeSetReader {
    type T = bytes::buf::Reader<Bytes>;

    fn get_read(&self, start: u64) -> ParquetResult<Self::T> {
        let (bytes, relative) = self.locate(start).ok_or_else(|| {
            ParquetError::General(format!("byte {start} is not in a fetched range"))
        })?;
        Ok(bytes.slice(relative..).reader())
    }

    fn get_bytes(&self, start: u64, length: usize) -> ParquetResult<Bytes> {
        let (bytes, relative) = self.locate(start).ok_or_else(|| {
            ParquetError::General(format!("byte {start} is not in a fetched range"))
        })?;
        let end = relative
            .checked_add(length)
            .filter(|end| *end <= bytes.len());
        match end {
            Some(end) => Ok(bytes.slice(relative..end)),
            None => Err(ParquetError::General(format!(
                "bytes {start}+{length} cross the end of a fetched range"
            ))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{free, get_cell_string, is_null, num_rows};
    use arrow::array::{ArrayRef, Int64Array, StringArray};
    use arrow::record_batch::RecordBatch;
    use std::sync::Arc;

    fn limits() -> FileLimits {
        FileLimits {
            rows: 100_000,
            columns: 256,
            decoded_bytes: 128 * 1024 * 1024,
        }
    }

    fn fixture_batch(rows: i64) -> RecordBatch {
        let numbers: Vec<Option<i64>> = (0..rows)
            .map(|i| if i % 5 == 3 { None } else { Some(i * 7) })
            .collect();
        let text: Vec<Option<String>> = (0..rows)
            .map(|i| {
                if i % 7 == 2 {
                    None
                } else {
                    Some(format!("row-{i}-東京"))
                }
            })
            .collect();
        RecordBatch::try_from_iter(vec![
            ("number", Arc::new(Int64Array::from(numbers)) as ArrayRef),
            ("text", Arc::new(StringArray::from(text)) as ArrayRef),
        ])
        .unwrap()
    }

    fn parquet_bytes(batch: &RecordBatch, row_group_size: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        let properties = parquet::file::properties::WriterProperties::builder()
            .set_max_row_group_size(row_group_size)
            .set_compression(parquet::basic::Compression::SNAPPY)
            .build();
        let mut writer =
            parquet::arrow::ArrowWriter::try_new(&mut bytes, batch.schema(), Some(properties))
                .unwrap();
        writer.write(batch).unwrap();
        writer.close().unwrap();
        bytes
    }

    /// Simulates the host: read the tail, grow it if the footer is longer,
    /// open the file.
    fn open_from_tail(file: &[u8], initial_tail: usize, limits: FileLimits) -> Result<u32, String> {
        let tail_start = file.len().saturating_sub(initial_tail);
        let metadata_len = footer_metadata_length(&file[tail_start..])?;
        let needed = metadata_len + FOOTER_SIZE;
        let tail = &file[file.len().saturating_sub(needed.max(initial_tail))..];
        open_parquet_file(tail, file.len() as u64, limits)
    }

    /// Simulates the host fetching exactly the ranges Rust asked for.
    fn fetch_ranges(file: &[u8], ranges: &[f64]) -> Vec<u8> {
        let mut data = Vec::new();
        for pair in ranges.chunks_exact(2) {
            let start = pair[0] as usize;
            let end = start + pair[1] as usize;
            data.extend_from_slice(&file[start..end]);
        }
        data
    }

    fn load_all_groups(file: &[u8], handle: u32) -> u32 {
        let store = create_store(handle).unwrap();
        let groups = with_file(handle, |f| Ok(f.metadata().num_row_groups())).unwrap();
        for group in 0..groups as u32 {
            let ranges = row_group_ranges(handle, group).unwrap();
            let data = fetch_ranges(file, &ranges);
            append_row_group(handle, store, group, &ranges, &data).unwrap();
        }
        crate::store::finish_arrow_stream_store(store).unwrap();
        store
    }

    #[test]
    fn ranged_load_matches_whole_file_decode() {
        let batch = fixture_batch(1000);
        let file = parquet_bytes(&batch, 128);
        let handle = open_from_tail(&file, 64, limits()).unwrap();
        let info = with_file(handle, |f| Ok(f.metadata().num_row_groups())).unwrap();
        assert_eq!(info, 8);

        let ranged = load_all_groups(&file, handle);
        parquet_close(handle);
        let whole = crate::store::load_parquet_bounded(&file, 100_000, 256, 128 << 20).unwrap();

        assert_eq!(num_rows(ranged).unwrap(), 1000);
        assert_eq!(num_rows(ranged).unwrap(), num_rows(whole).unwrap());
        for row in [0usize, 1, 127, 128, 129, 500, 998, 999] {
            for col in 0..2 {
                assert_eq!(
                    is_null(ranged, row, col).unwrap(),
                    is_null(whole, row, col).unwrap(),
                    "null mismatch at {row},{col}"
                );
                assert_eq!(
                    get_cell_string(ranged, row, col).unwrap(),
                    get_cell_string(whole, row, col).unwrap(),
                    "cell mismatch at {row},{col}"
                );
            }
        }
        free(ranged);
        free(whole);
    }

    #[test]
    fn coalesced_ranges_decode_too() {
        let batch = fixture_batch(300);
        let file = parquet_bytes(&batch, 100);
        let handle = open_from_tail(&file, 8, limits()).unwrap();
        let store = create_store(handle).unwrap();
        // The host may fetch one span covering every column chunk.
        let ranges = row_group_ranges(handle, 1).unwrap();
        let start = ranges
            .chunks_exact(2)
            .map(|p| p[0])
            .fold(f64::INFINITY, f64::min);
        let end = ranges
            .chunks_exact(2)
            .map(|p| p[0] + p[1])
            .fold(0.0, f64::max);
        let coalesced = vec![start, end - start];
        let data = fetch_ranges(&file, &coalesced);
        let appended = append_row_group(handle, store, 1, &coalesced, &data).unwrap();
        assert_eq!(appended, 100);
        assert_eq!(num_rows(store).unwrap(), 100);
        // Row group 1 starts at global row 100 in the file.
        assert_eq!(get_cell_string(store, 0, 0).unwrap(), (100 * 7).to_string());
        free(store);
        parquet_close(handle);
    }

    #[test]
    fn footer_rejects_bad_magic_and_short_tails() {
        let file = parquet_bytes(&fixture_batch(10), 10);
        let mut bad = file.clone();
        let n = bad.len();
        bad[n - 4..].copy_from_slice(b"NOPE");
        assert!(footer_metadata_length(&bad)
            .unwrap_err()
            .contains("Corrupt footer"));
        assert!(footer_metadata_length(&file[n - 3..])
            .unwrap_err()
            .contains("needs 8 bytes"));
        let mut encrypted = file.clone();
        encrypted[n - 4..].copy_from_slice(b"PARE");
        assert!(footer_metadata_length(&encrypted)
            .unwrap_err()
            .contains("Encrypted"));
        // A tail shorter than the footer metadata cannot be opened.
        assert!(open_parquet_file(&file[n - 8..], n as u64, limits())
            .unwrap_err()
            .contains("too short"));
        // A footer that claims more bytes than the file has is rejected.
        let metadata_len = footer_metadata_length(&file).unwrap();
        assert!(
            open_parquet_file(&file, (metadata_len + 8) as u64, limits())
                .unwrap_err()
                .contains("exceeds the file length")
        );
    }

    #[test]
    fn footer_admission_applies_before_any_row_group() {
        let file = parquet_bytes(&fixture_batch(50), 10);
        let mut tight = limits();
        tight.rows = 10;
        assert!(open_from_tail(&file, 64, tight)
            .unwrap_err()
            .contains("row limit"));
        tight = limits();
        tight.columns = 1;
        assert!(open_from_tail(&file, 64, tight)
            .unwrap_err()
            .contains("column limit"));
    }

    #[test]
    fn decoded_bytes_limit_accumulates_across_row_groups() {
        let batch = fixture_batch(400);
        let file = parquet_bytes(&batch, 200);
        // Measure what one row group retains, then cap just under two.
        let open = open_from_tail(&file, 64, limits()).unwrap();
        let store = create_store(open).unwrap();
        let ranges0 = row_group_ranges(open, 0).unwrap();
        let ranges1 = row_group_ranges(open, 1).unwrap();
        append_row_group(open, store, 0, &ranges0, &fetch_ranges(&file, &ranges0)).unwrap();
        let one_group = with_file(open, |f| Ok(f.usage.memory.bytes)).unwrap();
        assert!(one_group > 0);
        free(store);
        parquet_close(open);

        let mut tight = limits();
        tight.decoded_bytes = (one_group + one_group / 2) as u32;
        let handle = open_from_tail(&file, 64, tight).unwrap();
        let store = create_store(handle).unwrap();
        append_row_group(handle, store, 0, &ranges0, &fetch_ranges(&file, &ranges0)).unwrap();
        let ledger = with_file(handle, |f| Ok((f.usage.rows, f.usage.memory.bytes))).unwrap();
        assert_eq!(ledger.0, 200);

        // The footer sizes alone show the second group cannot fit, so the
        // host is told before it fetches anything.
        let early = row_group_ranges(handle, 1).unwrap_err();
        assert!(early.contains("decoded bytes limit"), "{early}");

        // A host that fetches anyway is stopped by the decode-time check, and
        // the rejected group leaves the store and both ledgers untouched.
        let late = append_row_group(handle, store, 1, &ranges1, &fetch_ranges(&file, &ranges1))
            .unwrap_err();
        assert!(late.contains("decoded bytes limit"), "{late}");
        assert_eq!(num_rows(store).unwrap(), 200);
        assert_eq!(
            with_file(handle, |f| Ok((f.usage.rows, f.usage.memory.bytes))).unwrap(),
            ledger
        );
        assert!(!with_file(handle, |f| Ok(f.appended[1])).unwrap());

        // A failed store append (freed target) also leaves the ledger alone.
        free(store);
        let gone = append_row_group(handle, store, 1, &ranges1, &fetch_ranges(&file, &ranges1));
        assert!(gone.is_err());
        assert_eq!(
            with_file(handle, |f| Ok((f.usage.rows, f.usage.memory.bytes))).unwrap(),
            ledger
        );
        parquet_close(handle);
    }

    /// Re-encode a file's footer with one column chunk's metadata replaced.
    fn footer_with_chunk(
        file: &[u8],
        edit: impl Fn(
            parquet::file::metadata::ColumnChunkMetaDataBuilder,
        ) -> parquet::file::metadata::ColumnChunkMetaDataBuilder,
    ) -> Vec<u8> {
        use parquet::file::metadata::ParquetMetaDataWriter;
        let metadata_len = footer_metadata_length(file).unwrap();
        let start = file.len() - FOOTER_SIZE - metadata_len;
        let metadata =
            ParquetMetaDataReader::decode_metadata(&file[start..file.len() - FOOTER_SIZE]).unwrap();
        let mut groups = metadata.row_groups().to_vec();
        let group = groups.remove(0);
        let mut columns = group.columns().to_vec();
        let column = columns.remove(0);
        columns.insert(0, edit(column.into_builder()).build().unwrap());
        groups.insert(
            0,
            group
                .into_builder()
                .set_column_metadata(columns)
                .build()
                .unwrap(),
        );
        let rewritten = ParquetMetaData::new(metadata.file_metadata().clone(), groups);
        let mut out = Vec::new();
        ParquetMetaDataWriter::new(&mut out, &rewritten)
            .finish()
            .unwrap();
        out
    }

    #[test]
    fn hostile_footers_are_rejected_not_trapped() {
        let file = parquet_bytes(&fixture_batch(30), 10);
        let len = file.len() as u64;
        for (label, tail) in [
            (
                "negative data page offset behind a dictionary page",
                footer_with_chunk(&file, |c| c.set_data_page_offset(-1)),
            ),
            (
                "negative data page offset",
                footer_with_chunk(&file, |c| {
                    c.set_dictionary_page_offset(None).set_data_page_offset(-1)
                }),
            ),
            (
                "negative dictionary page offset",
                footer_with_chunk(&file, |c| c.set_dictionary_page_offset(Some(-8))),
            ),
            (
                "negative compressed size",
                footer_with_chunk(&file, |c| c.set_total_compressed_size(-100)),
            ),
            (
                "offset before the magic",
                footer_with_chunk(&file, |c| {
                    c.set_dictionary_page_offset(None).set_data_page_offset(2)
                }),
            ),
            (
                "range past the data region",
                footer_with_chunk(&file, |c| c.set_total_compressed_size(1 << 40)),
            ),
            (
                "offset past the data region",
                footer_with_chunk(&file, |c| {
                    c.set_dictionary_page_offset(None)
                        .set_data_page_offset(1 << 40)
                }),
            ),
        ] {
            let error = open_parquet_file(&tail, len, limits()).unwrap_err();
            assert!(
                error.contains("Parquet") && !error.is_empty(),
                "{label}: {error}"
            );
        }
        // The same footer with honest values still opens.
        let honest = footer_with_chunk(&file, |c| c);
        let handle = open_parquet_file(&honest, len, limits()).unwrap();
        parquet_close(handle);
    }

    #[test]
    fn chunks_beyond_the_addressable_range_are_rejected() {
        let file = parquet_bytes(&fixture_batch(30), 10);
        let metadata_len = footer_metadata_length(&file).unwrap();
        let start = file.len() - FOOTER_SIZE - metadata_len;
        let metadata =
            ParquetMetaDataReader::decode_metadata(&file[start..file.len() - FOOTER_SIZE]).unwrap();
        let file_end = (file.len() - FOOTER_SIZE - metadata_len) as u64;
        validate_chunk_ranges(&metadata, file_end, u64::MAX).unwrap();
        // Pretend the build can only address the first 16 bytes.
        let error = validate_chunk_ranges(&metadata, file_end, 16).unwrap_err();
        assert!(error.contains("cannot address"), "{error}");
    }

    #[test]
    fn row_groups_append_once_and_need_their_bytes() {
        let file = parquet_bytes(&fixture_batch(30), 10);
        let handle = open_from_tail(&file, 64, limits()).unwrap();
        let store = create_store(handle).unwrap();
        let ranges = row_group_ranges(handle, 2).unwrap();
        let data = fetch_ranges(&file, &ranges);
        append_row_group(handle, store, 2, &ranges, &data).unwrap();
        let again = append_row_group(handle, store, 2, &ranges, &data).unwrap_err();
        assert!(again.contains("already loaded"));

        // Bytes for row group 0 do not cover row group 1.
        let wrong = row_group_ranges(handle, 0).unwrap();
        let error =
            append_row_group(handle, store, 1, &wrong, &fetch_ranges(&file, &wrong)).unwrap_err();
        assert!(error.contains("not covered"));

        // Data shorter than the declared ranges is rejected before decoding.
        let short =
            append_row_group(handle, store, 1, &ranges, &data[..data.len() - 1]).unwrap_err();
        assert!(short.contains("shorter"));

        assert!(row_group_ranges(handle, 3).is_err());
        assert_eq!(num_rows(store).unwrap(), 10);
        free(store);
        parquet_close(handle);
        assert!(row_group_ranges(handle, 0).is_err());
    }

    #[test]
    fn range_set_reader_bounds_reads_to_fetched_segments() {
        let data: Vec<u8> = (0..=255u8).collect();
        let reader = RangeSetReader::new(1000, &[100.0, 128.0, 500.0, 128.0], &data).unwrap();
        assert_eq!(reader.len(), 1000);
        assert_eq!(reader.get_bytes(100, 4).unwrap().as_ref(), &[0, 1, 2, 3]);
        assert_eq!(reader.get_bytes(600, 2).unwrap().as_ref(), &[228, 229]);
        assert!(reader.get_bytes(99, 1).is_err());
        assert!(reader.get_bytes(227, 2).is_err(), "crosses a segment end");
        assert!(reader.get_bytes(300, 1).is_err(), "gap between segments");
        assert!(reader.covers(100, 128));
        assert!(!reader.covers(100, 129));
        assert!(!reader.covers(228, 1));
        let mut read = reader.get_read(126).unwrap();
        let mut buf = [0u8; 2];
        std::io::Read::read_exact(&mut read, &mut buf).unwrap();
        assert_eq!(buf, [26, 27]);

        assert!(RangeSetReader::new(1000, &[0.0, 10.0, 5.0, 10.0], &[0; 20])
            .unwrap_err()
            .contains("overlap"));
        assert!(RangeSetReader::new(1000, &[990.0, 20.0], &[0; 20])
            .unwrap_err()
            .contains("outside the file"));
        assert!(RangeSetReader::new(1000, &[0.0, 10.0], &[0; 11])
            .unwrap_err()
            .contains("longer"));
        // An empty range at the same offset as a real one must not shadow it.
        let shadowed =
            RangeSetReader::new(1000, &[100.0, 0.0, 100.0, 4.0], &[7, 8, 9, 10]).unwrap();
        assert_eq!(shadowed.get_bytes(100, 4).unwrap().as_ref(), &[7, 8, 9, 10]);
        assert!(shadowed.covers(100, 0));
    }

    #[test]
    fn column_hints_and_info_come_from_the_footer() {
        let file = parquet_bytes(&fixture_batch(25), 10);
        let handle = open_from_tail(&file, 64, limits()).unwrap();
        let (rows, groups, per_group) = with_file(handle, |f| {
            let m = f.metadata();
            Ok((
                m.file_metadata().num_rows(),
                m.num_row_groups(),
                m.row_groups()
                    .iter()
                    .map(|g| g.num_rows())
                    .collect::<Vec<_>>(),
            ))
        })
        .unwrap();
        assert_eq!(rows, 25);
        assert_eq!(groups, 3);
        assert_eq!(per_group, vec![10, 10, 5]);
        // Native wasm-bindgen stubs cannot build JsValues, so compare the
        // hint computation directly against the whole-file path.
        let from_file = with_file(handle, |f| {
            let m = f.metadata();
            let names: Vec<String> = f
                .arrow
                .schema()
                .fields()
                .iter()
                .map(|x| x.name().clone())
                .collect();
            Ok(parse_parquet_column_hints(
                &names,
                m.file_metadata().num_rows() as u64,
                &file_key_value_metadata(m),
            ))
        })
        .unwrap();
        let from_bytes = nteract_predicate::parquet_column_hints(&file).unwrap();
        assert_eq!(from_file.len(), from_bytes.len());
        parquet_close(handle);
    }
}
