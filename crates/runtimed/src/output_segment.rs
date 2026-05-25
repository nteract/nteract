use anyhow::Context;
use runtime_doc::RuntimeStateDoc;

use crate::blob_store::BlobStore;

pub const OUTPUT_SEGMENT_MIME: &str = "application/vnd.nteract.output-segment+json";

pub async fn resolve_segment_outputs(
    doc: &RuntimeStateDoc,
    execution_id: &str,
    blob_store: &BlobStore,
) -> anyhow::Result<Vec<serde_json::Value>> {
    let outputs = doc.get_outputs(execution_id);
    let mut resolved = Vec::with_capacity(outputs.len());

    for output in &outputs {
        if output.get("output_type").and_then(|v| v.as_str()) == Some("output_segment") {
            let segment = output
                .get("segment")
                .and_then(|v| v.as_object())
                .context("segment manifest missing 'segment' field")?;
            let blob_hash = segment
                .get("blob")
                .and_then(|v| v.as_str())
                .context("segment manifest missing 'segment.blob' hash")?;

            let blob_bytes = blob_store
                .get(blob_hash)
                .await?
                .with_context(|| format!("segment blob {blob_hash} not found"))?;

            let segment_payload: serde_json::Value =
                serde_json::from_slice(&blob_bytes).context("parse segment blob JSON")?;

            let children = segment_payload
                .get("outputs")
                .and_then(|v| v.as_array())
                .context("segment blob missing 'outputs' array")?;

            resolved.extend(children.iter().cloned());
        } else {
            resolved.push(output.clone());
        }
    }

    Ok(resolved)
}
