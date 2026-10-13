//! CSV to Arrow IPC, for `@nteract/sift-csv`.
//!
//! Sift's table engine reads Arrow IPC streams and Parquet through
//! `sift-wasm`. This crate is the CSV front end: it infers a schema with
//! arrow-csv, decodes the file, and returns an uncompressed IPC stream that
//! `loadTableFile` accepts. It is a separate WebAssembly module so apps that
//! only open Parquet or Arrow do not carry the CSV parser.
//!
//! Type inference follows arrow-csv: `true`/`false` in any case are booleans,
//! integers are Int64, decimals and exponents are Float64, ISO dates are
//! Date32, and ISO timestamps are Timestamp. A column with mixed shapes is
//! Utf8. Empty fields are null in every column type.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::io::Cursor;

use arrow::csv::reader::Format;
use arrow::csv::ReaderBuilder;
use arrow::ipc::writer::StreamWriter;
use serde::Deserialize;
use wasm_bindgen::prelude::*;

/// Rows per decoded batch. The IPC stream keeps the same batching.
const BATCH_ROWS: usize = 8192;

/// Bounds and dialect for one conversion. Every limit is a hard ceiling: a
/// file that crosses one fails instead of being truncated or sampled.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CsvOptions {
    /// Field delimiter as a single ASCII byte. Default `,`.
    pub delimiter: u8,
    /// Whether the first record names the columns. Default true; otherwise
    /// columns are `column_1`, `column_2`, ...
    pub has_header: bool,
    /// Maximum input bytes.
    pub max_bytes: usize,
    /// Maximum data rows.
    pub max_rows: usize,
    /// Maximum columns.
    pub max_columns: usize,
    /// Maximum bytes in the resulting Arrow IPC stream, which is close to the
    /// memory Sift will retain for the table.
    pub max_output_bytes: usize,
}

impl Default for CsvOptions {
    fn default() -> Self {
        Self {
            delimiter: b',',
            has_header: true,
            max_bytes: 16 * 1024 * 1024,
            max_rows: 100_000,
            max_columns: 256,
            max_output_bytes: 128 * 1024 * 1024,
        }
    }
}

fn exceeds(value: usize, limit: usize, label: &str) -> Result<(), String> {
    if value > limit {
        return Err(format!("CSV exceeds {label} limit ({value} > {limit})"));
    }
    Ok(())
}

/// Convert CSV bytes to an uncompressed Arrow IPC stream.
pub fn csv_to_arrow_ipc(bytes: &[u8], options: &CsvOptions) -> Result<Vec<u8>, String> {
    exceeds(bytes.len(), options.max_bytes, "input byte")?;
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);

    let format = Format::default()
        .with_header(options.has_header)
        .with_delimiter(options.delimiter);

    // Inference reads the whole file so a late value cannot break the type
    // the early rows suggested. It is a second pass over the input, but the
    // input is bounded by max_bytes.
    let (schema, rows) = format
        .infer_schema(Cursor::new(bytes), None)
        .map_err(|e| e.to_string())?;
    if schema.fields().is_empty() {
        return Err("CSV has no columns".to_string());
    }
    exceeds(schema.fields().len(), options.max_columns, "column")?;
    exceeds(rows, options.max_rows, "row")?;

    let reader = ReaderBuilder::new(schema.into())
        .with_format(format)
        .with_batch_size(BATCH_ROWS)
        .build(Cursor::new(bytes))
        .map_err(|e| e.to_string())?;

    let mut output = Vec::new();
    let mut writer =
        StreamWriter::try_new(&mut output, reader.schema().as_ref()).map_err(|e| e.to_string())?;
    for batch in reader {
        let batch = batch.map_err(|e| e.to_string())?;
        writer.write(&batch).map_err(|e| e.to_string())?;
        exceeds(
            writer.get_ref().len(),
            options.max_output_bytes,
            "decoded byte",
        )?;
    }
    writer.finish().map_err(|e| e.to_string())?;
    drop(writer);
    exceeds(output.len(), options.max_output_bytes, "decoded byte")?;
    Ok(output)
}

/// JS entry point. `options` is a plain object with the camelCase fields of
/// [`CsvOptions`]; missing fields take the defaults.
#[wasm_bindgen(js_name = csvToArrowIpc)]
pub fn csv_to_arrow_ipc_js(bytes: &[u8], options: JsValue) -> Result<Vec<u8>, JsValue> {
    console_error_panic_hook::set_once();
    let options: CsvOptions = if options.is_undefined() || options.is_null() {
        CsvOptions::default()
    } else {
        serde_wasm_bindgen::from_value(options).map_err(|e| JsValue::from_str(&e.to_string()))?
    };
    csv_to_arrow_ipc(bytes, &options).map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{Array, AsArray};
    use arrow::datatypes::{DataType, Float64Type, Int64Type, SchemaRef};
    use arrow::ipc::reader::StreamReader;
    use arrow::record_batch::RecordBatch;

    fn decode(ipc: &[u8]) -> (SchemaRef, Vec<RecordBatch>) {
        let reader = StreamReader::try_new(Cursor::new(ipc), None).unwrap();
        let schema = reader.schema();
        let batches = reader.map(|b| b.unwrap()).collect();
        (schema, batches)
    }

    fn convert(csv: &str) -> (SchemaRef, Vec<RecordBatch>) {
        decode(&csv_to_arrow_ipc(csv.as_bytes(), &CsvOptions::default()).unwrap())
    }

    fn types(schema: &SchemaRef) -> Vec<DataType> {
        schema
            .fields()
            .iter()
            .map(|f| f.data_type().clone())
            .collect()
    }

    #[test]
    fn infers_the_types_pandas_writes() {
        let (schema, batches) = convert(
            "id,ratio,big,flag,day,when,name\n\
             1,0.30000000000000004,6.02e23,True,2024-01-02,2024-01-02 03:04:05,ann\n\
             2,0.3333333333333333,1.5e-3,False,2024-01-03,2024-01-03 03:04:05,bob\n",
        );
        assert_eq!(
            types(&schema),
            [
                DataType::Int64,
                DataType::Float64,
                DataType::Float64,
                DataType::Boolean,
                DataType::Date32,
                DataType::Timestamp(arrow::datatypes::TimeUnit::Second, None),
                DataType::Utf8,
            ]
        );
        let batch = &batches[0];
        assert_eq!(batch.num_rows(), 2);
        let ratio = batch.column(1).as_primitive::<Float64Type>();
        assert_eq!(ratio.value(0), 0.30000000000000004);
        assert_eq!(
            batch.column(2).as_primitive::<Float64Type>().value(0),
            6.02e23
        );
    }

    #[test]
    fn empty_fields_are_null_in_every_type() {
        let (schema, batches) = convert("n,s,b\n1,,true\n,x,\n3,\"\",false\n");
        assert_eq!(
            types(&schema),
            [DataType::Int64, DataType::Utf8, DataType::Boolean]
        );
        let batch = &batches[0];
        assert_eq!(batch.column(0).null_count(), 1);
        assert_eq!(batch.column(1).null_count(), 2);
        assert_eq!(batch.column(2).null_count(), 1);
        assert_eq!(batch.column(0).as_primitive::<Int64Type>().value(2), 3);
    }

    #[test]
    fn mixed_columns_fall_back_to_text_and_late_values_count() {
        // A text value in the last row must not fail a column inferred as
        // numeric from the first rows: inference reads the whole file.
        let mut csv = String::from("v\n");
        for i in 0..20_000 {
            csv.push_str(&format!("{i}\n"));
        }
        csv.push_str("n/a\n");
        let (schema, batches) = convert(&csv);
        assert_eq!(types(&schema), [DataType::Utf8]);
        assert_eq!(
            batches.iter().map(RecordBatch::num_rows).sum::<usize>(),
            20_001
        );
    }

    #[test]
    fn handles_bom_crlf_quotes_and_tsv() {
        let (schema, batches) = convert("\u{FEFF}a,b\r\n\"x, y\",\"say \"\"hi\"\"\"\r\n");
        assert_eq!(schema.field(0).name(), "a");
        let b = &batches[0];
        assert_eq!(b.column(0).as_string::<i32>().value(0), "x, y");
        assert_eq!(b.column(1).as_string::<i32>().value(0), "say \"hi\"");

        let tsv = CsvOptions {
            delimiter: b'\t',
            ..CsvOptions::default()
        };
        let (schema, _) = decode(&csv_to_arrow_ipc(b"a\tb\n1\t2\n", &tsv).unwrap());
        assert_eq!(schema.fields().len(), 2);

        let headless = CsvOptions {
            has_header: false,
            ..CsvOptions::default()
        };
        let (schema, batches) = decode(&csv_to_arrow_ipc(b"1,2\n3,4\n", &headless).unwrap());
        assert_eq!(schema.field(0).name(), "column_1");
        assert_eq!(batches[0].num_rows(), 2);
    }

    #[test]
    fn enforces_every_limit() {
        let small = |f: fn(&mut CsvOptions)| {
            let mut o = CsvOptions::default();
            f(&mut o);
            o
        };
        let csv = b"a,b,c\n1,2,3\n4,5,6\n";
        let err = |o: CsvOptions| csv_to_arrow_ipc(csv, &o).unwrap_err();
        assert!(err(small(|o| o.max_bytes = 4)).contains("input byte limit"));
        assert!(err(small(|o| o.max_columns = 2)).contains("column limit"));
        assert!(err(small(|o| o.max_rows = 1)).contains("row limit"));
        assert!(err(small(|o| o.max_output_bytes = 64)).contains("decoded byte limit"));
        assert!(csv_to_arrow_ipc(csv, &CsvOptions::default()).is_ok());
    }

    #[test]
    fn output_limit_includes_schema_and_end_marker() {
        for csv in [b"a,b\n".as_slice(), b"a,b\n1,2\n".as_slice()] {
            let output = csv_to_arrow_ipc(csv, &CsvOptions::default()).unwrap();
            let mut options = CsvOptions {
                max_output_bytes: output.len() - 1,
                ..CsvOptions::default()
            };
            assert!(
                csv_to_arrow_ipc(csv, &options).is_err(),
                "accepted {} bytes with limit {}",
                output.len(),
                options.max_output_bytes
            );
            options.max_output_bytes = output.len();
            assert_eq!(csv_to_arrow_ipc(csv, &options).unwrap().len(), output.len());
        }
    }

    #[test]
    fn ragged_rows_are_an_error() {
        let err = csv_to_arrow_ipc(b"a,b\n1,2\n3\n", &CsvOptions::default()).unwrap_err();
        assert!(err.contains("record"), "{err}");
    }

    #[test]
    fn header_only_and_empty_inputs() {
        let (schema, batches) = convert("a,b\n");
        assert_eq!(schema.fields().len(), 2);
        assert_eq!(batches.iter().map(RecordBatch::num_rows).sum::<usize>(), 0);
        assert!(csv_to_arrow_ipc(b"", &CsvOptions::default()).is_err());
    }
}
