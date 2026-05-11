//! Output resolution -- delegates to runtimed-client's canonical implementation.
//!
//! Re-exports are adapted to use the local PyO3 `Output` and `DataValue` types.

use std::collections::HashMap;
use std::path::PathBuf;

use runtime_doc::CommDocEntry;
use runtimed_outputs::output_resolver as shared;

use crate::output::{DataValue, Output};

/// Convert a shared DataValue to a local (PyO3) DataValue.
fn convert_dv(dv: runtimed_outputs::resolved_output::DataValue) -> DataValue {
    match dv {
        runtimed_outputs::resolved_output::DataValue::Text(s) => DataValue::Text(s),
        runtimed_outputs::resolved_output::DataValue::Binary(b) => DataValue::Binary(b),
        runtimed_outputs::resolved_output::DataValue::Json(v) => DataValue::Json(v),
    }
}

/// Convert a shared Output to a local (PyO3) Output.
fn convert_output(o: runtimed_outputs::resolved_output::Output) -> Output {
    Output {
        output_type: o.output_type,
        name: o.name,
        text: o.text,
        data: o
            .data
            .map(|d| d.into_iter().map(|(k, v)| (k, convert_dv(v))).collect()),
        ename: o.ename,
        evalue: o.evalue,
        traceback: o.traceback,
        execution_count: o.execution_count,
        blob_urls: o.blob_urls,
        blob_paths: o.blob_paths,
    }
}

/// Resolve all outputs for a cell snapshot.
pub async fn resolve_cell_outputs(
    raw_outputs: &[serde_json::Value],
    blob_base_url: &Option<String>,
    blob_store_path: &Option<PathBuf>,
    comms: Option<&HashMap<String, CommDocEntry>>,
) -> Vec<Output> {
    shared::resolve_cell_outputs(raw_outputs, blob_base_url, blob_store_path, comms)
        .await
        .into_iter()
        .map(convert_output)
        .collect()
}

/// Resolve a cell's outputs into LLM-facing text without materializing full blobs.
pub async fn resolve_cell_output_texts_for_llm(
    raw_outputs: &[serde_json::Value],
    blob_base_url: &Option<String>,
    blob_store_path: &Option<PathBuf>,
    comms: Option<&HashMap<String, CommDocEntry>>,
) -> Vec<String> {
    shared::resolve_cell_output_texts_for_llm(
        raw_outputs,
        shared::ResolveCtx {
            blob_base_url: blob_base_url.as_deref(),
            blob_store_path: blob_store_path.as_deref(),
            comms,
            length: shared::OutputLength::Preview,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::*;
    use runtimed_outputs::resolved_output as shared_output;
    use serde_json::json;

    #[test]
    fn convert_output_preserves_typed_data_and_blob_metadata() {
        let output = shared_output::Output {
            output_type: "execute_result".to_string(),
            name: None,
            text: None,
            data: Some(HashMap::from([
                (
                    "text/plain".to_string(),
                    shared_output::DataValue::Text("hello".to_string()),
                ),
                (
                    "image/png".to_string(),
                    shared_output::DataValue::Binary(vec![0, 1, 2, 255]),
                ),
                (
                    "application/json".to_string(),
                    shared_output::DataValue::Json(json!({"ok": true})),
                ),
            ])),
            ename: None,
            evalue: None,
            traceback: None,
            execution_count: Some(7),
            blob_urls: Some(HashMap::from([(
                "image/png".to_string(),
                "http://127.0.0.1/blob/image".to_string(),
            )])),
            blob_paths: Some(HashMap::from([(
                "image/png".to_string(),
                "/tmp/runt/blob-image".to_string(),
            )])),
        };

        let converted = convert_output(output);

        assert_eq!(converted.output_type, "execute_result");
        assert_eq!(converted.execution_count, Some(7));
        assert_eq!(
            converted.blob_urls.unwrap()["image/png"],
            "http://127.0.0.1/blob/image"
        );
        assert_eq!(
            converted.blob_paths.unwrap()["image/png"],
            "/tmp/runt/blob-image"
        );

        let data = converted.data.unwrap();
        let DataValue::Text(text) = &data["text/plain"] else {
            panic!("text/plain should convert to text");
        };
        assert_eq!(text, "hello");

        let DataValue::Binary(bytes) = &data["image/png"] else {
            panic!("image/png should convert to binary");
        };
        assert_eq!(bytes, &[0, 1, 2, 255]);

        let DataValue::Json(value) = &data["application/json"] else {
            panic!("application/json should convert to JSON");
        };
        assert_eq!(value["ok"], true);
    }

    #[tokio::test]
    async fn resolves_llm_output_texts_without_full_blob_resolution() {
        let manifest_text = serde_json::json!({
            "version": 1,
            "content_type": "application/vnd.apache.arrow.stream",
            "summary": {
                "total_rows": 20,
                "included_rows": 20,
                "sampled": false
            },
            "schema": {
                "fields": 1,
                "columns": [
                    {"name": "value", "type": "int64", "nullable": true}
                ]
            },
            "chunks": [
                {"hash": "chunk_hash_should_not_be_fetched", "size": 8192, "row_count": 20}
            ],
            "llm": {
                "content_type": "text/llm+plain",
                "text": "TABLE_REPR v1\nshape: 20 rows x 1 columns"
            }
        })
        .to_string();
        let raw_outputs = vec![json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.nteract.arrow-stream-manifest+json": {"inline": manifest_text}
            }
        })];

        let texts = resolve_cell_output_texts_for_llm(&raw_outputs, &None, &None, None).await;

        assert_eq!(texts, vec!["TABLE_REPR v1\nshape: 20 rows x 1 columns"]);
    }
}
