//! Arrow IPC stream summarization and row reading for the TUI table viewer.
//!
//! DataFrame outputs are emitted as Arrow IPC streams. These helpers mirror the
//! Parquet N-API surface while sharing the same row/summary structs so the TUI
//! renderer can stay format-blind.

use std::io::Cursor;

use arrow::datatypes::{Schema, SchemaRef};
use arrow::ipc::reader::StreamReader;
use arrow::record_batch::RecordBatch;
use napi_derive::napi;
use nteract_predicate::parquet_features::parse_parquet_column_hints;
use nteract_predicate::parquet_summary;

use crate::parquet::{
    array_value_to_string, parquet_summary_to_result, ParquetRowPage, ParquetSummaryResult,
};

/// Summarize an Arrow IPC stream from a local blob/file path.
#[napi]
pub fn summarize_arrow_file(file_path: String) -> napi::Result<ParquetSummaryResult> {
    summarize_arrow_chunks(vec![file_path])
}

/// Summarize ordered Arrow IPC chunk files as one logical table.
#[napi]
pub fn summarize_arrow_chunks(file_paths: Vec<String>) -> napi::Result<ParquetSummaryResult> {
    summarize_arrow_paths(&file_paths).map_err(napi::Error::from_reason)
}

/// Read a page of rows from an Arrow IPC stream at a local blob/file path.
#[napi]
pub fn read_arrow_file(file_path: String, offset: i64, limit: i64) -> napi::Result<ParquetRowPage> {
    read_arrow_chunks(vec![file_path], offset, limit)
}

/// Read a page of rows from ordered Arrow IPC chunk files as one logical table.
#[napi]
pub fn read_arrow_chunks(
    file_paths: Vec<String>,
    offset: i64,
    limit: i64,
) -> napi::Result<ParquetRowPage> {
    read_arrow_rows_from_paths(&file_paths, offset, limit).map_err(napi::Error::from_reason)
}

fn summarize_arrow_paths(file_paths: &[String]) -> Result<ParquetSummaryResult, String> {
    let (schema, batches, num_bytes) = read_arrow_record_batches_from_paths(file_paths)?;
    let total_rows = batches.iter().map(|batch| batch.num_rows() as u64).sum();
    let column_names: Vec<String> = schema
        .fields()
        .iter()
        .map(|field| field.name().clone())
        .collect();
    let column_hints = parse_parquet_column_hints(&column_names, total_rows, schema.metadata());
    let summary = parquet_summary::summarize_record_batches(
        schema.as_ref(),
        &batches,
        num_bytes,
        column_hints,
    );

    Ok(parquet_summary_to_result(&summary))
}

fn read_arrow_rows_from_paths(
    file_paths: &[String],
    offset: i64,
    limit: i64,
) -> Result<ParquetRowPage, String> {
    let (schema, batches, _) = read_arrow_record_batches_from_paths(file_paths)?;
    Ok(read_arrow_rows_from_batches(
        schema.as_ref(),
        &batches,
        offset,
        limit,
    ))
}

fn read_arrow_record_batches_from_paths(
    file_paths: &[String],
) -> Result<(SchemaRef, Vec<RecordBatch>, u64), String> {
    if file_paths.is_empty() {
        return Err("Arrow error: no chunk paths provided".to_string());
    }

    let mut schema: Option<SchemaRef> = None;
    let mut batches = Vec::new();
    let mut num_bytes = 0_u64;

    for file_path in file_paths {
        let bytes =
            std::fs::read(file_path).map_err(|e| format!("Failed to read {file_path}: {e}"))?;
        num_bytes += bytes.len() as u64;
        let (chunk_schema, chunk_batches) = read_arrow_record_batches_from_bytes(bytes)?;
        if let Some(existing_schema) = schema.as_ref() {
            ensure_compatible_schema(existing_schema.as_ref(), chunk_schema.as_ref())?;
        } else {
            schema = Some(chunk_schema);
        }
        batches.extend(chunk_batches);
    }

    let schema = schema.ok_or_else(|| "Arrow error: no schema found".to_string())?;
    Ok((schema, batches, num_bytes))
}

fn read_arrow_record_batches_from_bytes(
    bytes: Vec<u8>,
) -> Result<(SchemaRef, Vec<RecordBatch>), String> {
    let mut reader = StreamReader::try_new(Cursor::new(bytes), None)
        .map_err(|e| format!("Arrow IPC error: {e}"))?;
    let schema = reader.schema();
    let mut batches = Vec::new();
    for batch in &mut reader {
        batches.push(batch.map_err(|e| format!("Arrow IPC batch read error: {e}"))?);
    }
    Ok((schema, batches))
}

fn ensure_compatible_schema(expected: &Schema, actual: &Schema) -> Result<(), String> {
    if expected.fields().len() != actual.fields().len() {
        return Err(format!(
            "Arrow error: chunk schema column count mismatch ({} != {})",
            expected.fields().len(),
            actual.fields().len()
        ));
    }

    for (idx, (expected_field, actual_field)) in expected
        .fields()
        .iter()
        .zip(actual.fields().iter())
        .enumerate()
    {
        if expected_field.name() != actual_field.name()
            || expected_field.data_type() != actual_field.data_type()
            || expected_field.is_nullable() != actual_field.is_nullable()
        {
            return Err(format!(
                "Arrow error: chunk schema mismatch at column {idx} (expected {}: {:?}, got {}: {:?})",
                expected_field.name(),
                expected_field.data_type(),
                actual_field.name(),
                actual_field.data_type()
            ));
        }
    }

    Ok(())
}

fn read_arrow_rows_from_batches(
    schema: &Schema,
    batches: &[RecordBatch],
    offset: i64,
    limit: i64,
) -> ParquetRowPage {
    let columns: Vec<String> = schema
        .fields()
        .iter()
        .map(|field| field.name().clone())
        .collect();
    let offset = offset.max(0) as usize;
    let limit = limit.max(0) as usize;
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut total_rows: usize = 0;
    let mut row_idx: usize = 0;

    for batch in batches {
        let batch_rows = batch.num_rows();
        total_rows += batch_rows;

        if row_idx + batch_rows <= offset {
            row_idx += batch_rows;
            continue;
        }

        let start = offset.saturating_sub(row_idx);
        let end = batch_rows.min(start + limit.saturating_sub(rows.len()));

        for r in start..end {
            if rows.len() >= limit {
                break;
            }
            let mut row: Vec<String> = Vec::with_capacity(batch.num_columns());
            for col in batch.columns() {
                row.push(array_value_to_string(col.as_ref(), r));
            }
            rows.push(row);
        }

        row_idx += batch_rows;
    }

    ParquetRowPage {
        columns,
        rows,
        total_rows: total_rows as i64,
        offset: offset as i64,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used)]

    use super::*;
    use arrow::array::{BooleanArray, Float64Array, Int32Array, StringViewArray};
    use arrow::datatypes::{DataType, Field};
    use arrow::ipc::writer::StreamWriter;
    use std::sync::Arc;

    fn sample_schema() -> SchemaRef {
        Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int32, false),
            Field::new("label", DataType::Utf8View, true),
            Field::new("score", DataType::Float64, false),
            Field::new("flag", DataType::Boolean, false),
        ]))
    }

    fn sample_batch(
        ids: Vec<i32>,
        labels: Vec<Option<&str>>,
        scores: Vec<f64>,
        flags: Vec<bool>,
    ) -> RecordBatch {
        RecordBatch::try_new(
            sample_schema(),
            vec![
                Arc::new(Int32Array::from(ids)),
                Arc::new(StringViewArray::from(labels)),
                Arc::new(Float64Array::from(scores)),
                Arc::new(BooleanArray::from(flags)),
            ],
        )
        .expect("record batch")
    }

    fn batch_to_ipc_bytes(batch: &RecordBatch) -> Vec<u8> {
        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer =
                StreamWriter::try_new(&mut cursor, batch.schema().as_ref()).expect("stream writer");
            writer.write(batch).expect("write batch");
            writer.finish().expect("finish stream");
        }
        cursor.into_inner()
    }

    fn write_temp_arrow(bytes: &[u8]) -> (std::path::PathBuf, String) {
        let path = std::env::temp_dir().join(format!(
            "runtimed-node-arrow-{}.arrow",
            uuid::Uuid::new_v4()
        ));
        std::fs::write(&path, bytes).expect("write arrow");
        let path_string = path.to_string_lossy().to_string();
        (path, path_string)
    }

    #[test]
    fn arrow_file_helpers_read_utf8_view_rows_and_stats() {
        let batch = sample_batch(
            vec![1, 2, 3],
            vec![Some("alpha"), None, Some("alpha")],
            vec![1.25, 2.5, 3.75],
            vec![true, false, true],
        );
        let bytes = batch_to_ipc_bytes(&batch);
        let (path, path_string) = write_temp_arrow(&bytes);

        let page = read_arrow_file(path_string.clone(), 0, 40).expect("rows");
        let summary = summarize_arrow_file(path_string).expect("summary");
        let _ = std::fs::remove_file(path);

        assert_eq!(page.columns, vec!["id", "label", "score", "flag"]);
        assert_eq!(page.total_rows, 3);
        assert_eq!(page.rows[0][1], "alpha");
        assert_eq!(page.rows[1][1], "null");
        assert_eq!(summary.num_rows, 3);
        assert_eq!(summary.columns[1].data_type, "string");
        assert_eq!(summary.columns[1].null_count, 1);

        let stats: serde_json::Value =
            serde_json::from_str(&summary.columns[1].stats_json).unwrap();
        assert_eq!(stats["kind"], "string");
        assert_eq!(stats["distinct_count"], 1);
    }

    #[test]
    fn arrow_chunks_paginate_across_ordered_streams() {
        let first = sample_batch(
            vec![1, 2],
            vec![Some("alpha"), Some("beta")],
            vec![1.0, 2.0],
            vec![true, false],
        );
        let second = sample_batch(
            vec![3, 4],
            vec![Some("gamma"), Some("delta")],
            vec![3.0, 4.0],
            vec![true, true],
        );
        let (first_path, first_path_string) = write_temp_arrow(&batch_to_ipc_bytes(&first));
        let (second_path, second_path_string) = write_temp_arrow(&batch_to_ipc_bytes(&second));

        let page = read_arrow_chunks(vec![first_path_string, second_path_string], 1, 3)
            .expect("chunked rows");
        let _ = std::fs::remove_file(first_path);
        let _ = std::fs::remove_file(second_path);

        assert_eq!(page.total_rows, 4);
        assert_eq!(page.offset, 1);
        assert_eq!(
            page.rows
                .iter()
                .map(|row| (row[0].as_str(), row[1].as_str()))
                .collect::<Vec<_>>(),
            vec![("2", "beta"), ("3", "gamma"), ("4", "delta")]
        );
    }
}
