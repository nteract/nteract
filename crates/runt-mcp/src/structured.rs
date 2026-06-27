//! Build structuredContent JSON for MCP output rendering.
//!
//! Tools that produce cell output (execute_cell, create_cell, set_cell, etc.)
//! return both text content (for LLM consumption) and structured JSON that
//! the output.html renderer can display.
//!
//! The manifest-based functions (`cell_structured_content_from_manifests`,
//! `manifest_output_to_structured`) read inline content directly from
//! ContentRef entries and emit blob URLs for blob-stored content. Zero blob
//! fetches — structured content is always compact.

use notebook_doc::mime::MimeKind;
use runtime_doc::CommDocEntry;
use runtimed_outputs::output_resolver;
use runtimed_outputs::resolved_output::{DataValue, Output};
use serde_json::{json, Value};
use std::collections::HashMap;

const WIDGET_VIEW_MIME: &str = "application/vnd.jupyter.widget-view+json";
const JUPYTER_MATPLOTLIB_MODULE: &str = "jupyter-matplotlib";
const MPL_CANVAS_MODEL: &str = "MPLCanvasModel";
const MPL_CANVAS_CHECKPOINT_KEY: &str = "_nteract_mpl_canvas";

/// Check if a MIME type is a visualization spec (Plotly, Vega-Lite, Vega).
fn is_viz_mime(mime: &str) -> bool {
    mime == "application/vnd.plotly.v1+json"
        || (mime.starts_with("application/vnd.vegalite.v")
            && (mime.ends_with("+json") || mime.ends_with(".json")))
        || (mime.starts_with("application/vnd.vega.v")
            && !mime.starts_with("application/vnd.vegalite.")
            && (mime.ends_with("+json") || mime.ends_with(".json")))
}

fn is_static_raster_mime(mime: &str) -> bool {
    matches!(
        mime,
        "image/png" | "image/jpeg" | "image/gif" | "image/webp"
    )
}

/// Inputs for [`cell_structured_content_from_manifests`].
pub struct CellStructuredContentManifestInput<'a> {
    pub cell_id: &'a str,
    pub cell_type: &'a str,
    pub source: &'a str,
    pub output_manifests: &'a [serde_json::Value],
    pub execution_count: Option<i64>,
    pub status: &'a str,
    pub blob_base_url: &'a Option<String>,
    pub comms: Option<&'a HashMap<String, CommDocEntry>>,
    pub resolved_outputs_by_manifest: Option<&'a [Option<Output>]>,
}

/// Build structuredContent JSON directly from manifest Values and blob URLs.
///
/// Unlike [`cell_structured_content`] which requires fully-resolved outputs,
/// this function reads inline content directly from ContentRef entries and
/// emits blob URLs for anything stored in the blob store. Zero blob fetches.
pub fn cell_structured_content_from_manifests(
    input: CellStructuredContentManifestInput<'_>,
) -> Value {
    let outputs = input
        .output_manifests
        .iter()
        .enumerate()
        .map(|(index, manifest)| {
            manifest_output_to_structured_with_resolved(
                manifest,
                input.blob_base_url,
                input.comms,
                input
                    .resolved_outputs_by_manifest
                    .and_then(|outputs| outputs.get(index))
                    .and_then(Option::as_ref),
            )
        })
        .collect::<Vec<_>>();

    let mut content = json!({
        "cell": {
            "cell_id": input.cell_id,
            "source": input.source,
            "cell_type": input.cell_type,
            "outputs": outputs,
            "execution_count": input.execution_count,
            "status": input.status,
        }
    });

    if let Some(base) = input.blob_base_url {
        content["blob_base_url"] = Value::String(base.clone());
    }

    content
}

/// Convert a single output manifest Value to structured JSON for the output renderer.
///
/// Reads inline content directly from ContentRef entries and emits blob URLs
/// for blob-stored content. No blob fetches are performed.
#[cfg(test)]
fn manifest_output_to_structured(
    manifest: &Value,
    blob_base_url: &Option<String>,
    comms: Option<&HashMap<String, CommDocEntry>>,
) -> Value {
    manifest_output_to_structured_with_resolved(manifest, blob_base_url, comms, None)
}

fn manifest_output_to_structured_with_resolved(
    manifest: &Value,
    blob_base_url: &Option<String>,
    comms: Option<&HashMap<String, CommDocEntry>>,
    resolved_output: Option<&Output>,
) -> Value {
    let output_type = manifest
        .get("output_type")
        .and_then(|v| v.as_str())
        .unwrap_or("");

    // The daemon stamps `output_id` on every manifest (non-empty UUID). The
    // MCP-App renderer uses it as a stable React key so stream appends don't
    // re-mount sibling outputs. Propagate it on every variant.
    let output_id = manifest
        .get("output_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| Value::String(s.to_string()));

    let attach_id = |mut out: Value| -> Value {
        if let Some(id) = output_id.as_ref() {
            if let Some(obj) = out.as_object_mut() {
                obj.insert("output_id".to_string(), id.clone());
            }
        }
        out
    };

    match output_type {
        "stream" => {
            let name = manifest.get("name").cloned().unwrap_or(Value::Null);
            // text is a ContentRef: {"inline": "..."} or {"blob": "hash", "size": N}
            let text = manifest
                .get("text")
                .and_then(|cr| resolve_text_content_ref(cr, blob_base_url))
                .unwrap_or(Value::Null);
            let mut out = json!({
                "output_type": "stream",
                "name": name,
                "text": text,
            });
            if let Some(preview) = manifest.get("llm_preview") {
                out["llm_preview"] = preview.clone();
            }
            attach_id(out)
        }
        "error" => {
            // traceback is a ContentRef (inline JSON string or blob), not a
            // raw string[]. Resolve it: parse inline JSON → array, or fall
            // back to a blob URL for rare oversized tracebacks.
            let traceback = manifest
                .get("traceback")
                .and_then(|cr| {
                    // Inline ContentRef: the value is a JSON-stringified array
                    // e.g. {"inline": "[\"line1\", \"line2\"]"}
                    if let Some(inline) = cr.get("inline").and_then(|v| v.as_str()) {
                        serde_json::from_str::<Value>(inline).ok()
                    } else if let Some(hash) = cr.get("blob").and_then(|v| v.as_str()) {
                        // Blob-stored traceback — return URL for renderer to fetch
                        blob_base_url
                            .as_ref()
                            .map(|base| Value::String(format!("{}/blob/{}", base, hash)))
                    } else if cr.is_array() {
                        // Legacy: already a plain JSON array
                        Some(cr.clone())
                    } else {
                        None
                    }
                })
                .unwrap_or(Value::Null);
            let mut out = json!({
                "output_type": "error",
                "ename": manifest.get("ename").cloned().unwrap_or(Value::Null),
                "evalue": manifest.get("evalue").cloned().unwrap_or(Value::Null),
                "traceback": traceback,
            });
            if let Some(preview) = manifest.get("llm_preview") {
                out["llm_preview"] = preview.clone();
            }
            attach_id(out)
        }
        "display_data" | "execute_result" => {
            let mut data = serde_json::Map::new();

            if let Some(data_map) = manifest.get("data").and_then(|v| v.as_object()) {
                // Check for blob-backed raster images that will survive as
                // Blob Store URLs, then skip redundant text/html. Inline
                // rasters are intentionally omitted from MCP tool responses,
                // so they must not suppress richer HTML fallbacks.
                let has_renderable_image = data_map.iter().any(|(mime, content_ref)| {
                    is_static_raster_mime(mime)
                        && blob_base_url.is_some()
                        && output_resolver::content_ref_meta(content_ref)
                            .blob_hash
                            .is_some()
                });

                for (mime, content_ref) in data_map {
                    // Skip text/html when a raster image exists — avoids large
                    // base64 data URIs or redundant chart HTML.
                    if mime == "text/html" && has_renderable_image {
                        continue;
                    }
                    if is_viz_mime(mime) || mime == "application/geo+json" {
                        // Viz specs: emit blob URL or inline data.
                        // The MCP App renderer fetches blob URLs on demand
                        // and parses inline JSON directly.
                        let meta = output_resolver::content_ref_meta(content_ref);
                        if let Some(hash) = meta.blob_hash {
                            if let Some(base) = blob_base_url.as_ref() {
                                data.insert(
                                    mime.clone(),
                                    Value::String(format!("{}/blob/{}", base, hash)),
                                );
                            }
                        } else if meta.is_inline {
                            // Small viz specs inlined in the CRDT — pass through
                            if let Some(inline) = content_ref.get("inline") {
                                data.insert(mime.clone(), inline.clone());
                            }
                        }
                        continue;
                    }

                    let meta = output_resolver::content_ref_meta(content_ref);

                    // Binary blobs can be rendered via Blob Store URLs. Inline
                    // binary has no URL to hand to the MCP app, and inlining
                    // raster base64 would expose image bytes in tool responses.
                    let should_drop_inline_binary = notebook_doc::mime::mime_kind(mime)
                        == MimeKind::Binary
                        && (!mime.starts_with("image/") || is_static_raster_mime(mime));

                    let json_value = if let Some(hash) = meta.blob_hash {
                        // Blob-stored content — always emit blob URL regardless
                        // of MIME kind. The renderer or client fetches as needed.
                        blob_base_url
                            .as_ref()
                            .map(|base| Value::String(format!("{}/blob/{}", base, hash)))
                    } else if meta.is_inline && !should_drop_inline_binary {
                        // Inline text/JSON content — extract directly. Inline
                        // binary/raster content is silently dropped; the client
                        // falls back to text/plain or text/llm+plain.
                        content_ref.get("inline").cloned()
                    } else {
                        None
                    };

                    if let Some(jv) = json_value {
                        data.insert(mime.clone(), jv);
                    }
                }
            }

            // Synthesize text/llm+plain from viz specs that were skipped
            if data.is_empty() || !data.contains_key("text/llm+plain") {
                if let Some(data_map) = manifest.get("data").and_then(|v| v.as_object()) {
                    for (mime, content_ref) in data_map {
                        if is_viz_mime(mime) || mime == "application/geo+json" {
                            // Only try inline content (no blob fetches)
                            if let Some(inline) = content_ref.get("inline").and_then(|v| v.as_str())
                            {
                                if let Ok(spec) = serde_json::from_str::<Value>(inline) {
                                    if let Some(summary) = repr_llm::summarize_viz(mime, &spec) {
                                        data.insert(
                                            "text/llm+plain".to_string(),
                                            Value::String(summary),
                                        );
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Synthesize a safe widget summary for MCP App/static clients that
            // cannot attach to the live comm bridge. Do not include raw widget
            // state here; Password widgets can store plaintext values.
            if let (Some(data_map), Some(comms)) =
                (manifest.get("data").and_then(|v| v.as_object()), comms)
            {
                if let Some(checkpoint) =
                    matplotlib_checkpoint_from_data_map(data_map, comms, blob_base_url)
                {
                    if let Some(image_url) = checkpoint.image_url {
                        data.insert("image/png".to_string(), Value::String(image_url));
                    }
                    if !data.contains_key("text/llm+plain") {
                        data.insert(
                            "text/llm+plain".to_string(),
                            Value::String(checkpoint.summary),
                        );
                    }
                }
            }
            if !data.contains_key("text/llm+plain") {
                if let (Some(data_map), Some(comms)) =
                    (manifest.get("data").and_then(|v| v.as_object()), comms)
                {
                    if let Some(summary) = widget_summary_from_data_map(data_map, comms) {
                        data.insert("text/llm+plain".to_string(), Value::String(summary));
                    }
                }
            }

            merge_resolved_llm_plain(&mut data, resolved_output);

            let mut result = json!({
                "output_type": output_type,
                "data": data,
            });

            if let Some(count) = manifest.get("execution_count").and_then(|v| v.as_i64()) {
                result["execution_count"] = json!(count);
            }

            attach_id(result)
        }
        _ => attach_id(json!({"output_type": output_type})),
    }
}

fn merge_resolved_llm_plain(
    data: &mut serde_json::Map<String, Value>,
    resolved_output: Option<&Output>,
) {
    let Some(resolved_output) = resolved_output else {
        return;
    };
    if data.contains_key("text/llm+plain") {
        return;
    }
    if !matches!(
        resolved_output.output_type.as_str(),
        "display_data" | "execute_result"
    ) {
        return;
    }
    let Some(resolved_data) = resolved_output.data.as_ref() else {
        return;
    };
    let Some(DataValue::Text(summary)) = resolved_data.get("text/llm+plain") else {
        return;
    };

    data.insert("text/llm+plain".to_string(), Value::String(summary.clone()));
}

fn widget_model_id_from_content_ref(content_ref: &Value) -> Option<String> {
    if let Some(inline) = content_ref.get("inline") {
        if let Some(raw) = inline.as_str() {
            return serde_json::from_str::<Value>(raw).ok().and_then(|v| {
                v.get("model_id")
                    .and_then(|id| id.as_str())
                    .map(str::to_string)
            });
        }
        return inline
            .get("model_id")
            .and_then(|id| id.as_str())
            .map(str::to_string);
    }

    content_ref
        .get("model_id")
        .and_then(|id| id.as_str())
        .map(str::to_string)
}

fn widget_summary_from_data_map(
    data_map: &serde_json::Map<String, Value>,
    comms: &HashMap<String, CommDocEntry>,
) -> Option<String> {
    let model_id = widget_model_id_from_content_ref(data_map.get(WIDGET_VIEW_MIME)?)?;
    let entry = comms.get(&model_id)?;
    Some(output_resolver::format_widget_summary(
        &model_id, entry, comms,
    ))
}

struct MatplotlibCheckpoint {
    image_url: Option<String>,
    summary: String,
}

fn matplotlib_checkpoint_from_data_map(
    data_map: &serde_json::Map<String, Value>,
    comms: &HashMap<String, CommDocEntry>,
    blob_base_url: &Option<String>,
) -> Option<MatplotlibCheckpoint> {
    let model_id = widget_model_id_from_content_ref(data_map.get(WIDGET_VIEW_MIME)?)?;
    let entry = comms.get(&model_id)?;
    if entry.model_module != JUPYTER_MATPLOTLIB_MODULE || entry.model_name != MPL_CANVAS_MODEL {
        return None;
    }

    let checkpoint = entry.state.get(MPL_CANVAS_CHECKPOINT_KEY)?;
    let frame = checkpoint.get("frame")?;
    let hash = frame.get("blob").and_then(|v| v.as_str())?;
    let image_url = blob_base_url
        .as_ref()
        .map(|base| format!("{}/blob/{}", base, hash));
    let size = checkpoint
        .get("size")
        .and_then(|v| v.as_array())
        .and_then(|items| {
            let width = items.first()?.as_u64()?;
            let height = items.get(1)?.as_u64()?;
            Some(format!(" {width}x{height}"))
        })
        .unwrap_or_default();

    Some(MatplotlibCheckpoint {
        image_url,
        summary: format!("[matplotlib widget checkpoint: image/png{size}]"),
    })
}

/// Resolve a text ContentRef to a JSON value (inline text or blob URL).
fn resolve_text_content_ref(content_ref: &Value, blob_base_url: &Option<String>) -> Option<Value> {
    let meta = output_resolver::content_ref_meta(content_ref);
    if meta.is_inline {
        content_ref.get("inline").cloned()
    } else if let Some(hash) = meta.blob_hash {
        blob_base_url
            .as_ref()
            .map(|base| Value::String(format!("{}/blob/{}", base, hash)))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn inline_ref(content: &str) -> serde_json::Value {
        json!({"inline": content})
    }

    fn blob_ref(hash: &str, size: u64) -> serde_json::Value {
        json!({"blob": hash, "size": size})
    }

    #[test]
    fn structured_inline_content_passes_through() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "text/plain": inline_ref("hello"),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        assert_eq!(data["text/plain"], "hello");
    }

    #[test]
    fn structured_blob_becomes_url() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "image/png": blob_ref("abc123", 50_000),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        assert_eq!(data["image/png"], "http://localhost:9999/blob/abc123");
    }

    #[test]
    fn structured_no_blob_base_url_omits_blobs() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "image/png": blob_ref("abc123", 50_000),
                "text/plain": inline_ref("fallback"),
            },
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        // Blob entry not included (no base URL to construct from)
        assert!(!data.contains_key("image/png"));
        // Inline entry still present
        assert_eq!(data["text/plain"], "fallback");
    }

    #[test]
    fn structured_viz_mime_inline_included() {
        // Inline viz specs are included for MCP App plugin rendering.
        // TODO: consider always blob-storing viz specs to avoid bloating
        // structured content visible to Claude Code. Currently small specs
        // (< 1KB) are inlined in the CRDT and passed through here.
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.plotly.v1+json": inline_ref("{\"data\": []}"),
                "text/plain": inline_ref("Figure()"),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        assert_eq!(data["application/vnd.plotly.v1+json"], "{\"data\": []}");
        assert_eq!(data["text/plain"], "Figure()");
    }

    #[test]
    fn structured_html_skipped_when_raster_image_exists() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "text/html": inline_ref("<img src='data:...' />"),
                "image/png": blob_ref("img_hash", 40_000),
                "text/plain": inline_ref("<Figure>"),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        assert!(!data.contains_key("text/html"));
        assert_eq!(data["image/png"], "http://localhost:9999/blob/img_hash");
    }

    #[test]
    fn structured_inline_image_does_not_suppress_html() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "text/html": inline_ref("<img src='data:...' />"),
                "image/png": inline_ref("iVBORw0KGgoAAAA...base64..."),
                "text/plain": inline_ref("<Figure>"),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        assert_eq!(data["text/html"], "<img src='data:...' />");
        assert!(!data.contains_key("image/png"));
        assert_eq!(data["text/plain"], "<Figure>");
    }

    #[test]
    fn structured_output_id_propagates_on_every_variant() {
        // The daemon stamps `output_id` on every manifest and the MCP App
        // uses it as a React key. Structured output must preserve it.
        let blob_base = Some("http://localhost:9999".to_string());

        let stream = json!({
            "output_type": "stream",
            "output_id": "id-stream",
            "name": "stdout",
            "text": inline_ref("hi"),
        });
        assert_eq!(
            manifest_output_to_structured(&stream, &blob_base, None)["output_id"],
            "id-stream"
        );

        let error = json!({
            "output_type": "error",
            "output_id": "id-error",
            "ename": "E",
            "evalue": "v",
            "traceback": inline_ref("[\"l1\"]"),
        });
        assert_eq!(
            manifest_output_to_structured(&error, &blob_base, None)["output_id"],
            "id-error"
        );

        let display = json!({
            "output_type": "display_data",
            "output_id": "id-display",
            "data": {
                "text/plain": inline_ref("hello"),
            },
        });
        assert_eq!(
            manifest_output_to_structured(&display, &blob_base, None)["output_id"],
            "id-display"
        );
    }

    #[test]
    fn structured_missing_output_id_is_omitted() {
        // If a manifest arrives without output_id (legacy fixture,
        // pre-create_manifest write path), we don't synthesize one —
        // the renderer falls back to its positional key.
        let manifest = json!({
            "output_type": "stream",
            "name": "stdout",
            "text": inline_ref("hi"),
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        assert!(result.get("output_id").is_none());
    }

    #[test]
    fn structured_empty_output_id_is_omitted() {
        let manifest = json!({
            "output_type": "stream",
            "output_id": "",
            "name": "stdout",
            "text": inline_ref("hi"),
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        assert!(result.get("output_id").is_none());
    }

    #[test]
    fn structured_binary_mime_never_inlined() {
        // Binary MIMEs like parquet must never leak as inline text in
        // structured content — they render as garbled bytes in Cowork
        // and any other client that displays the JSON.
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.apache.parquet": inline_ref("PAR1\x00\x00binary garbage"),
                "text/plain": inline_ref("DataFrame(5 rows)"),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let data = result["data"]
            .as_object()
            .expect("data should be an object");
        // Parquet should be excluded (binary, inline — no blob URL to emit)
        assert!(
            !data.contains_key("application/vnd.apache.parquet"),
            "binary MIME should not be inlined in structured content"
        );
        // Text fallback still present
        assert_eq!(data["text/plain"], "DataFrame(5 rows)");
    }

    #[test]
    fn structured_binary_mime_blob_url_still_works() {
        // Binary MIMEs stored as blobs should still emit blob URLs
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.apache.parquet": blob_ref("pq_hash", 100_000),
                "text/plain": inline_ref("DataFrame(5 rows)"),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let data = result["data"]
            .as_object()
            .expect("data should be an object");
        assert_eq!(
            data["application/vnd.apache.parquet"],
            "http://localhost:9999/blob/pq_hash"
        );
    }

    #[test]
    fn structured_image_inline_is_omitted() {
        // Inline raster content would put image bytes directly in MCP tool
        // responses. Blob-backed images still emit Blob Store URLs.
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "image/png": inline_ref("iVBORw0KGgoAAAA...base64..."),
                "text/plain": inline_ref("<Figure>"),
            },
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        let data = result["data"]
            .as_object()
            .expect("data should be an object");
        assert!(
            !data.contains_key("image/png"),
            "inline base64 images should not be serialized in structured content"
        );
        assert_eq!(data["text/plain"], "<Figure>");
    }

    #[test]
    fn structured_audio_inline_suppressed() {
        // Audio is binary and NOT renderable as a data: URI in this context
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "audio/wav": inline_ref("RIFF....binary"),
                "text/plain": inline_ref("<Audio>"),
            },
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        let data = result["data"]
            .as_object()
            .expect("data should be an object");
        assert!(
            !data.contains_key("audio/wav"),
            "non-image binary should not be inlined"
        );
    }

    #[test]
    fn structured_html_included_without_raster_image() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "text/html": inline_ref("<b>bold</b>"),
                "text/plain": inline_ref("bold"),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        assert_eq!(data["text/html"], "<b>bold</b>");
    }

    #[test]
    fn structured_llm_plain_included_as_fallback() {
        // text/llm+plain should NOT be filtered out in structured content
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "text/llm+plain": inline_ref("Summary of output"),
                "image/png": blob_ref("img", 10_000),
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        let Some(data) = result["data"].as_object() else {
            panic!("data should be an object");
        };
        assert_eq!(data["text/llm+plain"], "Summary of output");
    }

    #[test]
    fn structured_merges_resolved_llm_plain_for_blob_backed_viz_specs() {
        // Real Plotly/Vega specs usually exceed the inline ContentRef threshold.
        // The structured renderer still needs the blob URL, while the MCP output
        // payload should carry the already-resolved LLM summary.
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.plotly.v1+json": blob_ref("plotly_hash", 4_096),
                "text/plain": inline_ref("Figure()"),
            },
        });
        let resolved_outputs_by_manifest = vec![Some(Output::display_data(HashMap::from([(
            "text/llm+plain".to_string(),
            runtimed_outputs::resolved_output::DataValue::Text(
                "Plotly chart: 1 bar trace".to_string(),
            ),
        )])))];
        let blob_base = Some("http://localhost:9999".to_string());

        let result = cell_structured_content_from_manifests(CellStructuredContentManifestInput {
            cell_id: "cell-plotly",
            cell_type: "code",
            source: "fig",
            output_manifests: &[manifest],
            execution_count: Some(1),
            status: "done",
            blob_base_url: &blob_base,
            comms: None,
            resolved_outputs_by_manifest: Some(&resolved_outputs_by_manifest),
        });

        let data = result["cell"]["outputs"][0]["data"]
            .as_object()
            .expect("output data should be an object");
        assert_eq!(
            data["application/vnd.plotly.v1+json"],
            "http://localhost:9999/blob/plotly_hash"
        );
        assert_eq!(data["text/llm+plain"], "Plotly chart: 1 bar trace");
    }

    #[test]
    fn structured_resolved_llm_plain_stays_aligned_when_manifest_resolution_drops_output() {
        let dropped_manifest = json!({
            "output_type": "display_data",
        });
        let plotly_manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.plotly.v1+json": blob_ref("plotly_hash", 4_096),
            },
        });
        let resolved_outputs_by_manifest = vec![
            None,
            Some(Output::display_data(HashMap::from([(
                "text/llm+plain".to_string(),
                runtimed_outputs::resolved_output::DataValue::Text(
                    "Plotly chart: aligned summary".to_string(),
                ),
            )]))),
        ];
        let manifests = vec![dropped_manifest, plotly_manifest];
        let blob_base = Some("http://localhost:9999".to_string());

        let result = cell_structured_content_from_manifests(CellStructuredContentManifestInput {
            cell_id: "cell-plotly",
            cell_type: "code",
            source: "fig",
            output_manifests: &manifests,
            execution_count: Some(1),
            status: "done",
            blob_base_url: &blob_base,
            comms: None,
            resolved_outputs_by_manifest: Some(&resolved_outputs_by_manifest),
        });

        let outputs = result["cell"]["outputs"]
            .as_array()
            .expect("outputs should be an array");
        let first_data = outputs[0]["data"]
            .as_object()
            .expect("first output data should be an object");
        assert!(
            !first_data.contains_key("text/llm+plain"),
            "summary must not be injected into a preceding dropped manifest"
        );
        let second_data = outputs[1]["data"]
            .as_object()
            .expect("second output data should be an object");
        assert_eq!(
            second_data["application/vnd.plotly.v1+json"],
            "http://localhost:9999/blob/plotly_hash"
        );
        assert_eq!(
            second_data["text/llm+plain"],
            "Plotly chart: aligned summary"
        );
    }

    #[test]
    fn structured_resolved_llm_plain_does_not_overwrite_existing_summary() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "text/llm+plain": inline_ref("author summary"),
            },
        });
        let resolved_outputs_by_manifest = vec![Some(Output::display_data(HashMap::from([(
            "text/llm+plain".to_string(),
            runtimed_outputs::resolved_output::DataValue::Text("resolved summary".to_string()),
        )])))];

        let result = cell_structured_content_from_manifests(CellStructuredContentManifestInput {
            cell_id: "cell-summary",
            cell_type: "code",
            source: "display",
            output_manifests: &[manifest],
            execution_count: Some(1),
            status: "done",
            blob_base_url: &None,
            comms: None,
            resolved_outputs_by_manifest: Some(&resolved_outputs_by_manifest),
        });

        assert_eq!(
            result["cell"]["outputs"][0]["data"]["text/llm+plain"],
            "author summary"
        );
    }

    #[test]
    fn structured_widget_view_gets_safe_summary_from_comms() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.jupyter.widget-view+json": inline_ref(r#"{"model_id":"slider-1"}"#),
            },
        });
        let mut comms = HashMap::new();
        comms.insert(
            "slider-1".to_string(),
            CommDocEntry {
                target_name: "jupyter.widget".to_string(),
                model_module: "@jupyter-widgets/controls".to_string(),
                model_name: "IntSliderModel".to_string(),
                state: json!({"value": 7, "min": 0, "max": 10}),
                outputs: Vec::new(),
                seq: 0,
                capture_msg_id: String::new(),
            },
        );

        let result = manifest_output_to_structured(&manifest, &None, Some(&comms));
        let summary = result["data"]["text/llm+plain"]
            .as_str()
            .expect("widget summary should be present");

        assert!(summary.contains("IntSlider"));
        assert!(summary.contains("7"));
    }

    #[test]
    fn structured_matplotlib_widget_view_emits_checkpoint_image_url() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.jupyter.widget-view+json": inline_ref(r#"{"model_id":"mpl-1"}"#),
            },
        });
        let mut comms = HashMap::new();
        comms.insert(
            "mpl-1".to_string(),
            CommDocEntry {
                target_name: "jupyter.widget".to_string(),
                model_module: "jupyter-matplotlib".to_string(),
                model_name: "MPLCanvasModel".to_string(),
                state: json!({
                    "_nteract_mpl_canvas": {
                        "version": 1,
                        "frame": {
                            "blob": "pnghash",
                            "size": 100,
                            "media_type": "image/png"
                        },
                        "image_mode": "full",
                        "size": [320, 240],
                        "frame_seq": 1
                    }
                }),
                outputs: Vec::new(),
                seq: 0,
                capture_msg_id: String::new(),
            },
        );
        let blob_base = Some("http://localhost:9999".to_string());

        let result = manifest_output_to_structured(&manifest, &blob_base, Some(&comms));

        assert_eq!(
            result["data"]["image/png"],
            "http://localhost:9999/blob/pnghash"
        );
        assert_eq!(
            result["data"]["text/llm+plain"],
            "[matplotlib widget checkpoint: image/png 320x240]"
        );
    }

    #[test]
    fn structured_widget_summary_masks_password_values() {
        let manifest = json!({
            "output_type": "display_data",
            "data": {
                "application/vnd.jupyter.widget-view+json": inline_ref(r#"{"model_id":"password-1"}"#),
            },
        });
        let mut comms = HashMap::new();
        comms.insert(
            "password-1".to_string(),
            CommDocEntry {
                target_name: "jupyter.widget".to_string(),
                model_module: "@jupyter-widgets/controls".to_string(),
                model_name: "PasswordModel".to_string(),
                state: json!({"value": "hunter2"}),
                outputs: Vec::new(),
                seq: 0,
                capture_msg_id: String::new(),
            },
        );

        let result = manifest_output_to_structured(&manifest, &None, Some(&comms));
        let summary = result["data"]["text/llm+plain"]
            .as_str()
            .expect("widget summary should be present");

        assert!(summary.contains("****"));
        assert!(!summary.contains("hunter2"));
    }

    #[test]
    fn structured_stream_inline() {
        let manifest = json!({
            "output_type": "stream",
            "name": "stdout",
            "text": inline_ref("hello"),
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        assert_eq!(result["output_type"], "stream");
        assert_eq!(result["name"], "stdout");
        assert_eq!(result["text"], "hello");
    }

    #[test]
    fn structured_stream_blob_text() {
        let manifest = json!({
            "output_type": "stream",
            "name": "stdout",
            "text": blob_ref("stream_hash", 5_000),
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        assert_eq!(result["text"], "http://localhost:9999/blob/stream_hash");
    }

    #[test]
    fn structured_error_inline_traceback_parsed() {
        // Daemon stores traceback as ContentRef with JSON-stringified array
        let manifest = json!({
            "output_type": "error",
            "ename": "ValueError",
            "evalue": "bad",
            "traceback": inline_ref(r#"["line 1", "line 2"]"#),
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        assert_eq!(result["output_type"], "error");
        assert_eq!(result["ename"], "ValueError");
        // Traceback should be a parsed JSON array, not the raw ContentRef
        let Some(tb) = result["traceback"].as_array() else {
            panic!("traceback should be an array");
        };
        assert_eq!(tb.len(), 2);
        assert_eq!(tb[0], "line 1");
        assert_eq!(tb[1], "line 2");
    }

    #[test]
    fn structured_error_blob_traceback_becomes_url() {
        let manifest = json!({
            "output_type": "error",
            "ename": "RecursionError",
            "evalue": "maximum recursion depth exceeded",
            "traceback": blob_ref("tb_hash_123", 8_000),
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        assert_eq!(
            result["traceback"],
            "http://localhost:9999/blob/tb_hash_123"
        );
    }

    #[test]
    fn structured_error_legacy_traceback_array() {
        // Legacy outputs may have a plain JSON array (not a ContentRef)
        let manifest = json!({
            "output_type": "error",
            "ename": "TypeError",
            "evalue": "oops",
            "traceback": ["line 1", "line 2"],
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        let Some(tb) = result["traceback"].as_array() else {
            panic!("legacy array should pass through");
        };
        assert_eq!(tb.len(), 2);
    }

    #[test]
    fn structured_execute_result_has_count() {
        let manifest = json!({
            "output_type": "execute_result",
            "data": {
                "text/plain": inline_ref("42"),
            },
            "execution_count": 7,
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        assert_eq!(result["execution_count"], 7);
    }

    #[test]
    fn structured_stream_includes_preview_when_blob() {
        let manifest = json!({
            "output_type": "stream",
            "name": "stdout",
            "text": blob_ref("stream_hash", 50_000),
            "llm_preview": {
                "head": "line 0\n",
                "tail": "line 99\n",
                "total_bytes": 50_000u64,
                "total_lines": 100u64,
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        assert_eq!(result["text"], "http://localhost:9999/blob/stream_hash");
        assert_eq!(result["llm_preview"]["total_lines"], 100);
        assert_eq!(result["llm_preview"]["head"], "line 0\n");
    }

    #[test]
    fn structured_error_includes_preview_when_blob() {
        let manifest = json!({
            "output_type": "error",
            "ename": "RecursionError",
            "evalue": "too deep",
            "traceback": blob_ref("tb_hash", 8_000),
            "llm_preview": {
                "last_frame": "RecursionError: too deep",
                "total_bytes": 8_000u64,
                "frames": 200u32,
            },
        });
        let blob_base = Some("http://localhost:9999".to_string());
        let result = manifest_output_to_structured(&manifest, &blob_base, None);
        assert_eq!(result["traceback"], "http://localhost:9999/blob/tb_hash");
        assert_eq!(result["llm_preview"]["frames"], 200);
        assert_eq!(
            result["llm_preview"]["last_frame"],
            "RecursionError: too deep"
        );
    }

    #[test]
    fn structured_stream_no_preview_for_inline() {
        let manifest = json!({
            "output_type": "stream",
            "name": "stdout",
            "text": inline_ref("hello"),
        });
        let result = manifest_output_to_structured(&manifest, &None, None);
        assert!(result.get("llm_preview").is_none());
    }

    #[test]
    fn cell_structured_content_wrapper() {
        let manifests = vec![json!({
            "output_type": "stream",
            "name": "stdout",
            "text": inline_ref("output"),
        })];
        let blob_base = Some("http://localhost:9999".to_string());
        let result = cell_structured_content_from_manifests(CellStructuredContentManifestInput {
            cell_id: "cell-123",
            cell_type: "code",
            source: "print('hello')",
            output_manifests: &manifests,
            execution_count: Some(3),
            status: "done",
            blob_base_url: &blob_base,
            comms: None,
            resolved_outputs_by_manifest: None,
        });
        assert_eq!(result["cell"]["cell_id"], "cell-123");
        assert_eq!(result["cell"]["cell_type"], "code");
        assert_eq!(result["cell"]["source"], "print('hello')");
        assert_eq!(result["cell"]["execution_count"], 3);
        assert_eq!(result["cell"]["status"], "done");
        let Some(outputs) = result["cell"]["outputs"].as_array() else {
            panic!("outputs should be an array");
        };
        assert_eq!(outputs.len(), 1);
    }
}
