//! Canonical interpretation of table schema metadata.
//!
//! Sift uses these hints for UI column behavior, while `repr-llm` can use the
//! same signal when describing rich table outputs for agents. Keep the JSON
//! metadata parsing here so native and WASM consumers agree on pandas/HF
//! meaning for both Parquet footers and Arrow IPC schemas.

use arrow::ipc::reader::StreamReader;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
use parquet::file::metadata::ParquetMetaData;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::io::Cursor;

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ParquetColumnHint {
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub numeric: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sortable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    pub pandas_index: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub semantic_type: Option<ParquetSemanticType>,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ParquetSemanticType {
    PandasIndex,
    HuggingfaceClassLabel,
    HuggingfaceImage,
    HuggingfaceImageList,
}

impl ParquetColumnHint {
    fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            column_type: None,
            numeric: None,
            sortable: None,
            width: None,
            label: None,
            pandas_index: false,
            semantic_type: None,
        }
    }

    fn has_effect(&self) -> bool {
        self.column_type.is_some()
            || self.numeric.is_some()
            || self.sortable.is_some()
            || self.width.is_some()
            || self.label.is_some()
            || self.pandas_index
            || self.semantic_type.is_some()
    }

    fn set_min_width(&mut self, width: u32) {
        self.width = Some(self.width.unwrap_or(0).max(width));
    }
}

pub fn parquet_file_key_value_metadata(
    parquet_bytes: &[u8],
) -> Result<HashMap<String, String>, Box<dyn std::error::Error + Send + Sync>> {
    let bytes = bytes::Bytes::copy_from_slice(parquet_bytes);
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)?;
    Ok(file_key_value_metadata(builder.metadata()))
}

pub fn parquet_column_hints(
    parquet_bytes: &[u8],
) -> Result<Vec<ParquetColumnHint>, Box<dyn std::error::Error + Send + Sync>> {
    let bytes = bytes::Bytes::copy_from_slice(parquet_bytes);
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)?;
    let metadata = builder.metadata();
    let kv_metadata = file_key_value_metadata(metadata);
    let total_rows = metadata.file_metadata().num_rows().max(0) as u64;
    let column_names: Vec<String> = builder
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
}

pub fn arrow_ipc_column_hints(
    ipc_bytes: &[u8],
) -> Result<Vec<ParquetColumnHint>, Box<dyn std::error::Error + Send + Sync>> {
    let mut reader = StreamReader::try_new(Cursor::new(ipc_bytes), None)?;
    let schema = reader.schema();
    let kv_metadata = schema.metadata().clone();
    let column_names: Vec<String> = schema
        .fields()
        .iter()
        .map(|field| field.name().clone())
        .collect();

    let mut total_rows = 0_u64;
    for batch in &mut reader {
        total_rows += batch?.num_rows() as u64;
    }

    Ok(parse_parquet_column_hints(
        &column_names,
        total_rows,
        &kv_metadata,
    ))
}

pub fn parse_parquet_column_hints(
    column_names: &[String],
    total_rows: u64,
    metadata: &HashMap<String, String>,
) -> Vec<ParquetColumnHint> {
    let pandas_index_cols = parse_pandas_index_columns(metadata);
    let hf_features = parse_huggingface_features(metadata);

    column_names
        .iter()
        .filter_map(|name| {
            let mut hint = ParquetColumnHint::new(name);
            apply_pandas_hint(&mut hint, total_rows, pandas_index_cols.contains(name));
            apply_huggingface_hint(&mut hint, hf_features.as_ref());
            hint.has_effect().then_some(hint)
        })
        .collect()
}

pub fn file_key_value_metadata(metadata: &ParquetMetaData) -> HashMap<String, String> {
    metadata
        .file_metadata()
        .key_value_metadata()
        .into_iter()
        .flatten()
        .filter_map(|kv| {
            kv.value
                .as_ref()
                .map(|value| (kv.key.clone(), value.clone()))
        })
        .collect()
}

fn parse_pandas_index_columns(metadata: &HashMap<String, String>) -> Vec<String> {
    let Some(raw) = metadata.get("pandas") else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(raw) else {
        return Vec::new();
    };
    value
        .get("index_columns")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(ToString::to_string)
        .collect()
}

fn parse_huggingface_features(metadata: &HashMap<String, String>) -> Option<Value> {
    let raw = metadata.get("huggingface")?;
    serde_json::from_str::<Value>(raw)
        .ok()?
        .get("info")?
        .get("features")
        .cloned()
}

fn apply_pandas_hint(hint: &mut ParquetColumnHint, total_rows: u64, in_pandas_metadata: bool) {
    if !in_pandas_metadata && !is_index_like_name(&hint.name) {
        return;
    }
    hint.pandas_index = true;
    hint.semantic_type = Some(ParquetSemanticType::PandasIndex);
    hint.sortable = Some(false);
    hint.set_min_width((formatted_digit_count(total_rows) * 9 + 24).max(60));
    if is_pandas_artifact_label(&hint.name) {
        hint.label = Some(String::new());
    }
}

fn apply_huggingface_hint(hint: &mut ParquetColumnHint, features: Option<&Value>) {
    let Some(feature) = features.and_then(|features| features.get(&hint.name)) else {
        return;
    };
    match feature.get("_type").and_then(Value::as_str) {
        Some("ClassLabel") => {
            hint.column_type = Some("categorical".to_string());
            hint.numeric = Some(false);
            hint.semantic_type = Some(ParquetSemanticType::HuggingfaceClassLabel);
        }
        Some("Image") => {
            apply_image_hint(hint, false);
        }
        Some("List") | Some("Sequence")
            if feature
                .get("feature")
                .and_then(|inner| inner.get("_type"))
                .and_then(Value::as_str)
                == Some("Image") =>
        {
            apply_image_hint(hint, true);
        }
        _ => {}
    }
}

fn apply_image_hint(hint: &mut ParquetColumnHint, is_list: bool) {
    hint.column_type = Some("image".to_string());
    hint.numeric = Some(false);
    hint.sortable = Some(false);
    hint.set_min_width(if is_list { 320 } else { 140 });
    hint.semantic_type = Some(if is_list {
        ParquetSemanticType::HuggingfaceImageList
    } else {
        ParquetSemanticType::HuggingfaceImage
    });
}

fn formatted_digit_count(value: u64) -> u32 {
    let digits = value.to_string().len() as u32;
    digits + digits.saturating_sub(1) / 3
}

fn is_index_like_name(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    is_pandas_artifact_label(&lower)
        || matches!(
            lower.as_str(),
            "index" | "id" | "_id" | "rowid" | "row_id" | "rownum" | "row_num"
        )
}

fn is_pandas_artifact_label(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("unnamed") {
        return rest
            .chars()
            .all(|ch| ch == ':' || ch == '_' || ch == ' ' || ch.is_ascii_digit());
    }
    if let Some(rest) = lower
        .strip_prefix("__index_level_")
        .and_then(|rest| rest.strip_suffix("__"))
    {
        return !rest.is_empty() && rest.chars().all(|ch| ch.is_ascii_digit());
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn metadata(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(key, value)| ((*key).to_string(), (*value).to_string()))
            .collect()
    }

    #[test]
    fn parses_pandas_and_huggingface_column_hints() {
        let columns = vec![
            "__index_level_0__".to_string(),
            "image".to_string(),
            "frames".to_string(),
            "label".to_string(),
        ];
        let metadata = metadata(&[
            ("pandas", r#"{"index_columns":["__index_level_0__"]}"#),
            (
                "huggingface",
                r#"{"info":{"features":{"image":{"_type":"Image"},"frames":{"_type":"Sequence","feature":{"_type":"Image"}},"label":{"_type":"ClassLabel","names":["cat","dog"]}}}}"#,
            ),
        ]);

        let hints = parse_parquet_column_hints(&columns, 12_345, &metadata);

        assert_eq!(hints.len(), 4);
        assert_eq!(
            hints[0],
            ParquetColumnHint {
                name: "__index_level_0__".to_string(),
                column_type: None,
                numeric: None,
                sortable: Some(false),
                width: Some(78),
                label: Some(String::new()),
                pandas_index: true,
                semantic_type: Some(ParquetSemanticType::PandasIndex),
            }
        );
        assert_eq!(hints[1].column_type.as_deref(), Some("image"));
        assert_eq!(hints[1].width, Some(140));
        assert_eq!(
            hints[1].semantic_type,
            Some(ParquetSemanticType::HuggingfaceImage)
        );
        assert_eq!(hints[2].width, Some(320));
        assert_eq!(
            hints[2].semantic_type,
            Some(ParquetSemanticType::HuggingfaceImageList)
        );
        assert_eq!(hints[3].column_type.as_deref(), Some("categorical"));
        assert_eq!(
            hints[3].semantic_type,
            Some(ParquetSemanticType::HuggingfaceClassLabel)
        );
    }

    #[test]
    fn tolerates_malformed_footer_json() {
        let columns = vec!["index".to_string(), "value".to_string()];
        let metadata = metadata(&[("pandas", "{"), ("huggingface", "{")]);

        let hints = parse_parquet_column_hints(&columns, 10, &metadata);

        assert_eq!(hints.len(), 1);
        assert_eq!(hints[0].name, "index");
        assert!(hints[0].pandas_index);
    }

    #[test]
    fn parses_arrow_ipc_schema_hints() {
        use arrow::array::{ArrayRef, Int64Array, StringArray};
        use arrow::datatypes::{DataType, Field, Schema};
        use arrow::ipc::writer::StreamWriter;
        use arrow::record_batch::RecordBatch;
        use std::sync::Arc;

        let schema = Arc::new(Schema::new_with_metadata(
            vec![
                Field::new("__index_level_0__", DataType::Int64, false),
                Field::new("image", DataType::Utf8, true),
            ],
            metadata(&[
                ("pandas", r#"{"index_columns":["__index_level_0__"]}"#),
                (
                    "huggingface",
                    r#"{"info":{"features":{"image":{"_type":"Image"}}}}"#,
                ),
            ]),
        ));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                Arc::new(Int64Array::from(vec![0, 1])) as ArrayRef,
                Arc::new(StringArray::from(vec!["0.png", "1.png"])) as ArrayRef,
            ],
        )
        .unwrap();

        let mut ipc = Vec::new();
        {
            let mut writer = StreamWriter::try_new(&mut ipc, &schema).unwrap();
            writer.write(&batch).unwrap();
            writer.finish().unwrap();
        }

        let hints = arrow_ipc_column_hints(&ipc).unwrap();

        assert_eq!(hints.len(), 2);
        assert!(hints[0].pandas_index);
        assert_eq!(hints[0].width, Some(60));
        assert_eq!(
            hints[1].semantic_type,
            Some(ParquetSemanticType::HuggingfaceImage)
        );
    }
}
