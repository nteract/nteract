//! Host-mediated delivery for the existing output renderer. No arbitrary URL or
//! filesystem proxy: assets use the daemon's own allowlist, and blobs must belong
//! to an execution in a currently readable notebook attachment.

use base64::Engine;
use rmcp::model::{ReadResourceResult, ResourceContents};
use rmcp::ErrorData as McpError;
use serde_json::Value;
use std::collections::HashMap;

use crate::NteractMcp;

const ASSETS: &str = "nteract://renderer-assets/";
const ARROW_MANIFEST: &str = "application/vnd.nteract.arrow-stream-manifest+json";
const MAX_BYTES: usize = 16 * 1024 * 1024;

fn unavailable(message: impl Into<String>) -> McpError {
    McpError::resource_not_found(message.into(), None)
}

fn valid_hash(hash: &str) -> bool {
    hash.len() == 64
        && hash
            .bytes()
            .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}

fn valid_asset(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 100
        && !name.contains("..")
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
        && [".js", ".css", ".wasm"]
            .iter()
            .any(|extension| name.ends_with(extension))
}

/// Both the declared and actual response length are bounded. Redirects never
/// turn this fixed daemon endpoint into a request to another origin.
async fn fetch(base: &str, path: &str) -> Result<(Vec<u8>, String), McpError> {
    let url = url::Url::parse(base).map_err(|_| unavailable("Invalid daemon origin"))?;
    if url.scheme() != "http"
        || !matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"))
    {
        return Err(unavailable("Output resources require a local daemon"));
    }
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|error| McpError::internal_error(error.to_string(), None))?;
    let mut response = client
        .get(format!("{}{path}", base.trim_end_matches('/')))
        .send()
        .await
        .map_err(|error| unavailable(error.to_string()))?;
    if !response.status().is_success() {
        return Err(unavailable(format!(
            "Output resource returned {}",
            response.status()
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES as u64)
    {
        return Err(unavailable(
            "Output resource exceeds the 16 MiB transfer limit",
        ));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| unavailable(error.to_string()))?
    {
        if bytes.len().saturating_add(chunk.len()) > MAX_BYTES {
            return Err(unavailable(
                "Output resource exceeds the 16 MiB transfer limit",
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((bytes, mime))
}

fn direct_refs(output: &Value) -> Vec<&Value> {
    match output.get("output_type").and_then(Value::as_str) {
        Some("display_data" | "execute_result") => output
            .get("data")
            .and_then(Value::as_object)
            .map(|data| data.values().collect())
            .unwrap_or_default(),
        Some("stream") => output.get("text").into_iter().collect(),
        Some("error") => ["traceback", "rich"]
            .iter()
            .filter_map(|key| output.get(key))
            .collect(),
        _ => Vec::new(),
    }
}

fn directly_references(outputs: &[Value], hash: &str) -> bool {
    outputs
        .iter()
        .flat_map(direct_refs)
        .any(|reference| reference.get("blob").and_then(Value::as_str) == Some(hash))
}

fn manifest_references(manifest: &Value, hash: &str) -> bool {
    manifest
        .get("chunks")
        .and_then(Value::as_array)
        .is_some_and(|chunks| {
            chunks.iter().any(|chunk| {
                chunk
                    .get("hash")
                    .or_else(|| chunk.get("blob"))
                    .and_then(Value::as_str)
                    == Some(hash)
            })
        })
}

async fn authorized(
    outputs: &[Value],
    hash: &str,
    base: &str,
    comms: &HashMap<String, runtime_doc::CommDocEntry>,
) -> Result<bool, McpError> {
    if directly_references(outputs, hash) {
        return Ok(true);
    }
    if outputs
        .iter()
        .filter(|output| {
            matches!(
                output.get("output_type").and_then(Value::as_str),
                Some("display_data" | "execute_result")
            )
        })
        .filter_map(|output| output.get("data").and_then(Value::as_object))
        .filter_map(|data| crate::structured::matplotlib_checkpoint_blob(data, comms))
        .any(|(_, frame_hash)| frame_hash == hash)
    {
        return Ok(true);
    }
    // Arrow manifests can be inline, blob-backed, or an inline pointer to a
    // blob-backed manifest. Only follow these typed refs, never arbitrary JSON.
    for output in outputs {
        let Some(reference) = output.get("data").and_then(|data| data.get(ARROW_MANIFEST)) else {
            continue;
        };
        let mut value = reference.clone();
        for _ in 0..3 {
            if manifest_references(&value, hash) {
                return Ok(true);
            }
            if let Some(inline) = value.get("inline").and_then(Value::as_str) {
                value = serde_json::from_str(inline).unwrap_or(Value::Null);
            } else if let Some(blob) = value
                .get("blob")
                .and_then(Value::as_str)
                .filter(|hash| valid_hash(hash))
            {
                if blob == hash {
                    return Ok(true);
                }
                let (bytes, _) = fetch(base, &format!("/blob/{blob}")).await?;
                value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            } else {
                break;
            }
        }
        if manifest_references(&value, hash) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) async fn read(
    server: &NteractMcp,
    uri: &str,
) -> Option<Result<ReadResourceResult, McpError>> {
    if let Some(name) = uri.strip_prefix(ASSETS) {
        return Some(
            async {
                if !valid_asset(name) {
                    return Err(unavailable("Invalid renderer asset"));
                }
                // Assets are daemon-global, including when the active notebook
                // is hosted and a local notebook attachment is parked.
                let metadata = server.local_metadata_snapshot(true);
                let base = metadata
                    .blob_base_url
                    .ok_or_else(|| unavailable("Local renderer assets unavailable"))?;
                let (bytes, mime) = fetch(&base, &format!("/renderer-plugins/{name}")).await?;
                Ok(result(uri, bytes, mime))
            }
            .await,
        );
    }
    let tail = uri.strip_prefix("nteract://sessions/")?;
    if !tail.contains("/blobs/") {
        return None;
    }
    Some(
        async {
            let parts: Vec<_> = tail.split('/').collect();
            if parts.len() != 5
                || parts[1] != "executions"
                || parts[3] != "blobs"
                || uuid::Uuid::parse_str(parts[0]).is_err()
                || uuid::Uuid::parse_str(parts[2]).is_err()
                || !valid_hash(parts[4])
            {
                return Err(unavailable("Invalid output blob URI"));
            }
            let (session, execution, hash) = (parts[0], parts[2], parts[4]);
            let (notebook_id, _, _, observer) =
                super::resource_session(server, session, true).await?;
            let notebook_path = server
                .attachment_identity(session)
                .await
                .and_then(|(_, path)| path);
            let snapshot = super::observed_read(&observer)?;
            let metadata =
                crate::targets::with_handle(session.to_owned(), server.local_runtime_metadata())
                    .await;
            let base = metadata
                .blob_base_url
                .as_deref()
                .ok_or_else(|| unavailable("Local output blobs unavailable"))?;
            let outputs =
                if let Some(execution) = snapshot.snapshot.runtime.executions.get(execution) {
                    execution.outputs.clone()
                } else if let Some(path) = metadata.execution_store_path {
                    let record = runtimed_client::execution_store::ExecutionStore::new(path)
                        .read_record(execution)
                        .await
                        .filter(|record| {
                            record.context_kind == "notebook"
                                && (record.context_id == notebook_id
                                    || notebook_path.as_deref() == Some(record.context_id.as_str()))
                        })
                        .ok_or_else(|| unavailable("Execution does not belong to this notebook"))?;
                    record.outputs
                } else {
                    return Err(unavailable("Execution is unavailable"));
                };
            if !authorized(&outputs, hash, base, &snapshot.snapshot.runtime.comms).await? {
                return Err(unavailable("Blob is not referenced by this execution"));
            }
            let (bytes, mime) = fetch(base, &format!("/blob/{hash}")).await?;
            // A released/replaced attachment cannot finish an in-flight read.
            super::resource_session(server, session, true).await?;
            Ok(result(uri, bytes, mime))
        }
        .await,
    )
}

fn result(uri: &str, bytes: Vec<u8>, mime: String) -> ReadResourceResult {
    ReadResourceResult::new(vec![ResourceContents::BlobResourceContents {
        uri: uri.to_owned(),
        mime_type: Some(mime),
        blob: base64::engine::general_purpose::STANDARD.encode(bytes),
        meta: None,
    }])
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    async fn response_server(response: Vec<u8>) -> String {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            {
                let _ = stream.read(&mut request).await;
            }
            let _ = stream.write_all(&response).await;
        });
        format!("http://{address}")
    }

    #[tokio::test]
    async fn transfer_limits_cover_declared_and_streamed_lengths_and_redirects() {
        let base = response_server(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n",
                MAX_BYTES + 1
            )
            .into_bytes(),
        )
        .await;
        assert!(fetch(&base, "/blob/test")
            .await
            .unwrap_err()
            .message
            .contains("transfer limit"));
        let mut response = b"HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n".to_vec();
        response.resize(response.len() + MAX_BYTES + 1, b'a');
        let base = response_server(response).await;
        assert!(fetch(&base, "/blob/test")
            .await
            .unwrap_err()
            .message
            .contains("transfer limit"));
        let base = response_server(b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\n\r\n".to_vec()).await;
        assert!(fetch(&base, "/blob/test")
            .await
            .unwrap_err()
            .message
            .contains("302"));
        assert!(fetch("https://example.com", "/blob/test")
            .await
            .unwrap_err()
            .message
            .contains("local daemon"));
    }

    #[test]
    fn resource_names_cannot_select_arbitrary_paths_or_urls() {
        for bad in [
            "../sift.js",
            "sift.js?url=http://evil",
            "file:///tmp/secret",
            "sift.js/extra",
            "output.html",
        ] {
            assert!(!valid_asset(bad));
        }
        for good in [
            "sift.js",
            "sift.css",
            "sift_wasm.wasm",
            "plotly.js",
            "markdown.css",
        ] {
            assert!(valid_asset(good));
        }
        assert!(valid_hash(&"a".repeat(64)));
        for bad in ["../secret", "abc", &"G".repeat(64)] {
            assert!(!valid_hash(bad));
        }
    }

    #[test]
    fn only_typed_output_refs_grant_blob_access() {
        let outputs = vec![json!({"output_type":"display_data", "data":{
            "text/html":{"blob":"allowed"}, "application/json":{"inline":"{\"blob\":\"not-a-ref\"}"}
        }, "metadata":{"blob":"also-not-a-ref"}})];
        assert!(directly_references(&outputs, "allowed"));
        assert!(!directly_references(&outputs, "not-a-ref"));
        assert!(!directly_references(&outputs, "also-not-a-ref"));
        assert!(manifest_references(
            &json!({"chunks":[{"hash":"chunk"}]}),
            "chunk"
        ));
        assert!(!manifest_references(
            &json!({"metadata":{"hash":"secret"}}),
            "secret"
        ));
    }
    #[tokio::test]
    async fn typed_inline_arrow_manifests_grant_only_their_chunks() {
        let hash = "a".repeat(64);
        let outputs = vec![
            json!({"output_type":"display_data", "data":{ARROW_MANIFEST:{"inline":json!({"chunks":[{"hash":hash}]}).to_string()}}}),
        ];
        assert!(
            authorized(&outputs, &hash, "http://localhost:1", &HashMap::new())
                .await
                .unwrap()
        );
        assert!(!authorized(
            &outputs,
            &"b".repeat(64),
            "http://localhost:1",
            &HashMap::new()
        )
        .await
        .unwrap());
        let pointer = vec![
            json!({"output_type":"display_data", "data":{ARROW_MANIFEST:{"inline":json!({"blob":hash}).to_string()}}}),
        ];
        assert!(
            authorized(&pointer, &hash, "http://localhost:1", &HashMap::new())
                .await
                .unwrap()
        );
    }

    #[tokio::test]
    async fn matplotlib_checkpoint_requires_a_referenced_canvas_model() {
        let hash = "a".repeat(64);
        let unrelated = "b".repeat(64);
        let output = json!({"output_type":"display_data", "data":{
            "application/vnd.jupyter.widget-view+json":{"inline":"{\"model_id\":\"canvas\"}"}
        }});
        let entry = |hash: &str| runtime_doc::CommDocEntry {
            target_name: "jupyter.widget".into(),
            model_module: "jupyter-matplotlib".into(),
            model_name: "MPLCanvasModel".into(),
            state: json!({"_nteract_mpl_canvas":{"frame":{"blob":hash}, "size":[320,240]}}),
            outputs: Vec::new(),
            seq: 0,
            capture_msg_id: String::new(),
        };
        let mut comms = HashMap::from([
            ("canvas".into(), entry(&hash)),
            ("unreferenced".into(), entry(&unrelated)),
        ]);
        let outputs = vec![output];
        assert!(authorized(&outputs, &hash, "http://localhost:1", &comms)
            .await
            .unwrap());
        assert!(
            !authorized(&outputs, &unrelated, "http://localhost:1", &comms)
                .await
                .unwrap()
        );
        assert!(!authorized(&[], &hash, "http://localhost:1", &comms)
            .await
            .unwrap());
        comms.get_mut("canvas").unwrap().model_name = "PasswordModel".into();
        assert!(!authorized(&outputs, &hash, "http://localhost:1", &comms)
            .await
            .unwrap());
    }

    #[tokio::test]
    async fn unknown_attachment_cannot_read_even_a_well_formed_blob() {
        let server = NteractMcp::new(
            "/tmp/no-daemon.sock".into(),
            Some("http://localhost:1".into()),
            None,
        );
        let uri = format!(
            "nteract://sessions/{}/executions/{}/blobs/{}",
            uuid::Uuid::new_v4(),
            uuid::Uuid::new_v4(),
            "a".repeat(64)
        );
        assert!(read(&server, &uri).await.unwrap().is_err());
        assert!(read(&server, "nteract://renderer-assets/../secret.js")
            .await
            .unwrap()
            .is_err());
    }
}
