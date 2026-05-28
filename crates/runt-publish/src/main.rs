#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::ffi::OsString;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use automerge::AutoCommit;
use clap::Parser;
use notebook_sync::connect;
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use runtime_doc::RuntimeStateDoc;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use url::Url;

const ARROW_STREAM_MANIFEST_MIME: &str = "application/vnd.nteract.arrow-stream-manifest+json";
const DEFAULT_BLOB_CONTENT_TYPE: &str = "application/octet-stream";
const ARROW_STREAM_CONTENT_TYPE: &str = "application/vnd.apache.arrow.stream";

#[derive(Debug, Parser)]
#[command(
    name = "runt-publish",
    about = "Publish a local notebook through a runtimed daemon to notebook-cloud"
)]
struct Args {
    /// Local .ipynb file to open through the daemon and publish.
    notebook: PathBuf,

    /// Hosted notebook-cloud base URL.
    #[arg(long = "url", env = "NOTEBOOK_CLOUD_URL")]
    cloud_url: String,

    /// Hosted notebook id. Defaults to NOTEBOOK_CLOUD_NOTEBOOK_ID, then the file stem.
    #[arg(long = "id", env = "NOTEBOOK_CLOUD_NOTEBOOK_ID")]
    notebook_id: Option<String>,

    /// Optional vanity path segment for the reported viewer URL: /n/{id}/{vanity-name}.
    #[arg(long)]
    vanity_name: Option<String>,

    /// Override the runtimed daemon socket path. Defaults to RUNTIMED_SOCKET_PATH, then the
    /// current channel's default socket.
    #[arg(long)]
    socket: Option<PathBuf>,

    /// Dev publish token for deployed notebook-cloud environments.
    #[arg(
        long = "dev-token",
        env = "NOTEBOOK_CLOUD_DEV_TOKEN",
        hide_env_values = true
    )]
    dev_token: Option<String>,

    /// User label sent to notebook-cloud dev auth.
    #[arg(long, default_value = "runt-publish")]
    user: String,

    /// Operator label sent to notebook-cloud and used as the daemon peer label.
    #[arg(long, default_value = "runt-publish")]
    operator: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct BlobRef {
    hash: String,
    size: Option<u64>,
    media_type: Option<String>,
}

#[derive(Debug)]
struct LocalBlob {
    bytes: Vec<u8>,
    media_type: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BlobMeta {
    media_type: Option<String>,
}

#[derive(Debug)]
struct Publisher {
    client: reqwest::Client,
    base_url: Url,
    notebook_id: String,
    vanity_name: Option<String>,
    dev_token: Option<String>,
    user: String,
    operator: String,
    blob_base_url: Option<String>,
    blob_store_path: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let notebook_path = std::fs::canonicalize(&args.notebook)
        .with_context(|| format!("canonicalize notebook path {}", args.notebook.display()))?;
    let notebook_id = args
        .notebook_id
        .clone()
        .unwrap_or_else(|| default_notebook_id(&notebook_path));
    let socket_path = args
        .socket
        .clone()
        .unwrap_or_else(runtimed_client::daemon_paths::get_socket_path);

    let open = connect::connect_open(
        socket_path.clone(),
        notebook_path.clone(),
        &format!("{}:{}", args.operator, notebook_id),
    )
    .await
    .with_context(|| {
        format!(
            "connect to daemon at {} and open {}",
            socket_path.display(),
            notebook_path.display()
        )
    })?;
    open.handle.await_session_ready().await?;
    open.handle.confirm_sync().await?;
    open.handle.confirm_state_sync().await?;

    let snapshot = open.handle.save_snapshot_pair()?;
    let (blob_base_url, blob_store_path) =
        runtimed_client::daemon_paths::get_blob_paths_async(&socket_path).await;
    let mut refs = collect_snapshot_blob_refs(&snapshot.runtime_state_bytes)?;
    let initial_ref_count = refs.len();

    let publisher = Publisher::new(args, notebook_id, blob_base_url, blob_store_path)?;
    let uploaded_blobs = publisher.upload_blob_closure(&mut refs).await?;

    let runtime_heads_hash = heads_digest(&snapshot.runtime_state_heads);
    let notebook_heads_hash = heads_digest(&snapshot.notebook_heads);
    publisher
        .put_bytes(
            &[
                "api",
                "n",
                &publisher.notebook_id,
                "runtime-snapshots",
                &runtime_heads_hash,
            ],
            snapshot.runtime_state_bytes,
            DEFAULT_BLOB_CONTENT_TYPE,
            HeaderMap::new(),
        )
        .await?;

    let mut snapshot_headers = HeaderMap::new();
    snapshot_headers.insert(
        "X-Runtime-Heads-Hash",
        HeaderValue::from_str(&runtime_heads_hash)
            .context("runtime heads hash is not a valid header value")?,
    );
    publisher
        .put_bytes(
            &[
                "api",
                "n",
                &publisher.notebook_id,
                "snapshots",
                &notebook_heads_hash,
            ],
            snapshot.notebook_bytes,
            DEFAULT_BLOB_CONTENT_TYPE,
            snapshot_headers,
        )
        .await?;

    let render = publisher
        .get_json(&["api", "n", &publisher.notebook_id, "render"])
        .await?;
    if render.get("source").and_then(Value::as_str) != Some("snapshot-pair") {
        bail!("latest render was not materialized from the uploaded snapshot pair");
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "ok": true,
            "notebook_id": publisher.notebook_id,
            "source_notebook_id": open.info.notebook_id,
            "viewer_url": publisher.viewer_url(),
            "notebook_heads_hash": notebook_heads_hash,
            "runtime_heads_hash": runtime_heads_hash,
            "initial_blob_refs": initial_ref_count,
            "total_blob_refs": refs.len(),
            "uploaded_blobs": uploaded_blobs,
            "render_source": render.get("source").and_then(Value::as_str),
        }))?
    );

    drop(open.broadcast_rx);
    Ok(())
}

impl Publisher {
    fn new(
        args: Args,
        notebook_id: String,
        blob_base_url: Option<String>,
        blob_store_path: Option<PathBuf>,
    ) -> Result<Self> {
        let base_url = Url::parse(&with_trailing_slash(&args.cloud_url))
            .with_context(|| format!("parse notebook-cloud URL {}", args.cloud_url))?;
        Ok(Self {
            client: reqwest::Client::new(),
            base_url,
            notebook_id,
            vanity_name: args.vanity_name,
            dev_token: args.dev_token,
            user: args.user,
            operator: args.operator,
            blob_base_url,
            blob_store_path,
        })
    }

    async fn upload_blob_closure(&self, refs: &mut BTreeMap<String, BlobRef>) -> Result<usize> {
        let mut uploaded = 0usize;
        let mut seen = HashSet::new();
        let mut queue: VecDeque<String> = refs.keys().cloned().collect();

        while let Some(hash) = queue.pop_front() {
            if !seen.insert(hash.clone()) {
                continue;
            }

            let blob_ref = refs
                .get(&hash)
                .cloned()
                .with_context(|| format!("missing queued blob ref {hash}"))?;
            let local_blob = self.read_local_blob(&blob_ref.hash).await?;
            let content_type = blob_ref
                .media_type
                .clone()
                .or_else(|| local_blob.media_type.clone())
                .unwrap_or_else(|| DEFAULT_BLOB_CONTENT_TYPE.to_string());

            self.put_bytes(
                &["api", "n", &self.notebook_id, "blobs", &blob_ref.hash],
                local_blob.bytes.clone(),
                &content_type,
                HeaderMap::new(),
            )
            .await?;
            uploaded += 1;

            if let Ok(value) = serde_json::from_slice::<Value>(&local_blob.bytes) {
                for dep in collect_blob_manifest_dependencies(&value) {
                    if !refs.contains_key(&dep.hash) {
                        queue.push_back(dep.hash.clone());
                        refs.insert(dep.hash.clone(), dep);
                    }
                }
            }
        }

        Ok(uploaded)
    }

    async fn read_local_blob(&self, hash: &str) -> Result<LocalBlob> {
        if let Some(root) = &self.blob_store_path {
            for candidate in local_blob_candidates(root, hash) {
                if let Ok(bytes) = tokio::fs::read(&candidate).await {
                    let meta = read_blob_meta(&candidate).await;
                    return Ok(LocalBlob {
                        media_type: meta.and_then(|m| m.media_type),
                        bytes,
                    });
                }
            }
        }

        if let Some(base_url) = &self.blob_base_url {
            for candidate in hash_candidates(hash) {
                let url = format!("{}/blob/{}", base_url.trim_end_matches('/'), candidate);
                let response = self.client.get(&url).send().await;
                if let Ok(response) = response {
                    if response.status().is_success() {
                        let media_type = response
                            .headers()
                            .get(CONTENT_TYPE)
                            .and_then(|value| value.to_str().ok())
                            .map(ToOwned::to_owned);
                        let bytes = response.bytes().await?.to_vec();
                        return Ok(LocalBlob { media_type, bytes });
                    }
                }
            }
        }

        Err(anyhow!("unable to resolve local blob {hash}"))
    }

    async fn put_bytes(
        &self,
        path: &[&str],
        bytes: Vec<u8>,
        content_type: &str,
        extra_headers: HeaderMap,
    ) -> Result<Value> {
        let url = self.endpoint(path)?;
        let mut request = self.add_identity_headers(
            self.client
                .put(url.clone())
                .header(CONTENT_TYPE, content_type)
                .body(bytes),
        );

        for (name, value) in extra_headers {
            if let Some(name) = name {
                request = request.header(name, value);
            }
        }

        let response = request.send().await?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            bail!("{} returned {}: {}", url, status, text);
        }
        serde_json::from_str(&text).with_context(|| format!("decode JSON response from {url}"))
    }

    async fn get_json(&self, path: &[&str]) -> Result<Value> {
        let url = self.endpoint(path)?;
        let response = self
            .add_identity_headers(self.client.get(url.clone()))
            .send()
            .await?;
        let status = response.status();
        let text = response.text().await?;
        if !status.is_success() {
            bail!("{} returned {}: {}", url, status, text);
        }
        serde_json::from_str(&text).with_context(|| format!("decode JSON response from {url}"))
    }

    fn add_identity_headers(
        &self,
        mut request: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        request = request
            .header("X-User", &self.user)
            .header("X-Operator", &self.operator)
            .header("X-Scope", "owner");

        if let Some(token) = &self.dev_token {
            request = request.header("X-Notebook-Cloud-Dev-Token", token);
        }
        request
    }

    fn endpoint(&self, path: &[&str]) -> Result<Url> {
        let joined = path
            .iter()
            .map(|segment| urlencoding::encode(segment).into_owned())
            .collect::<Vec<_>>()
            .join("/");
        self.base_url
            .join(&joined)
            .with_context(|| format!("build endpoint path {joined}"))
    }

    fn viewer_url(&self) -> String {
        let id = urlencoding::encode(&self.notebook_id);
        let mut url = format!("{}n/{}", self.base_url, id);
        if let Some(slug) = self
            .vanity_name
            .as_deref()
            .filter(|slug| !slug.trim().is_empty())
        {
            url.push('/');
            url.push_str(&urlencoding::encode(slug.trim()));
        }
        url
    }
}

fn collect_snapshot_blob_refs(runtime_state_bytes: &[u8]) -> Result<BTreeMap<String, BlobRef>> {
    let runtime_doc = AutoCommit::load(runtime_state_bytes)
        .context("load RuntimeStateDoc from exported snapshot bytes")?;
    let state_doc = RuntimeStateDoc::from_doc(runtime_doc);
    let state = state_doc.read_state();
    let mut refs = BTreeMap::new();

    for execution in state.executions.values() {
        for output in &execution.outputs {
            collect_blob_refs(output, &mut refs);
        }
    }
    for comm in state.comms.values() {
        collect_blob_refs(&comm.state, &mut refs);
        for output in &comm.outputs {
            collect_blob_refs(output, &mut refs);
        }
    }

    Ok(refs)
}

fn collect_blob_refs(value: &Value, refs: &mut BTreeMap<String, BlobRef>) {
    match value {
        Value::Array(items) => {
            for item in items {
                collect_blob_refs(item, refs);
            }
        }
        Value::Object(map) => {
            if let Some(blob) = map.get("blob").and_then(Value::as_str) {
                insert_blob_ref(
                    refs,
                    blob,
                    size_from_value(value),
                    media_type_from_value(value),
                );
            }

            if let Some(manifest_ref) = map.get(ARROW_STREAM_MANIFEST_MIME) {
                collect_content_ref_or_manifest(manifest_ref, refs);
            }

            for item in map.values() {
                collect_blob_refs(item, refs);
            }
        }
        _ => {}
    }
}

fn collect_content_ref_or_manifest(value: &Value, refs: &mut BTreeMap<String, BlobRef>) {
    if let Some(inline) = value.get("inline").and_then(Value::as_str) {
        if let Ok(manifest) = serde_json::from_str::<Value>(inline) {
            for dep in collect_blob_manifest_dependencies(&manifest) {
                refs.entry(dep.hash.clone()).or_insert(dep);
            }
        }
        return;
    }
    if let Some(blob) = value.get("blob").and_then(Value::as_str) {
        insert_blob_ref(
            refs,
            blob,
            size_from_value(value),
            media_type_from_value(value),
        );
    }
}

fn collect_blob_manifest_dependencies(value: &Value) -> Vec<BlobRef> {
    let mut refs = Vec::new();
    let manifest_content_type = value
        .get("content_type")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    if let Some(chunks) = value.get("chunks").and_then(Value::as_array) {
        for chunk in chunks {
            if let Some(hash) = chunk
                .get("blob")
                .or_else(|| chunk.get("hash"))
                .and_then(Value::as_str)
            {
                refs.push(BlobRef {
                    hash: hash.to_string(),
                    size: size_from_value(chunk),
                    media_type: media_type_from_value(chunk)
                        .or_else(|| manifest_content_type.clone())
                        .or_else(|| Some(ARROW_STREAM_CONTENT_TYPE.to_string())),
                });
            }
        }
    }

    if let Some(blobs) = value.get("blobs").and_then(Value::as_array) {
        for blob in blobs {
            if let Some(hash) = blob
                .get("blob")
                .or_else(|| blob.get("hash"))
                .and_then(Value::as_str)
            {
                refs.push(BlobRef {
                    hash: hash.to_string(),
                    size: size_from_value(blob),
                    media_type: media_type_from_value(blob),
                });
            }
        }
    }

    refs
}

fn insert_blob_ref(
    refs: &mut BTreeMap<String, BlobRef>,
    hash: &str,
    size: Option<u64>,
    media_type: Option<String>,
) {
    refs.entry(hash.to_string()).or_insert_with(|| BlobRef {
        hash: hash.to_string(),
        size,
        media_type,
    });
}

fn size_from_value(value: &Value) -> Option<u64> {
    value.get("size").and_then(Value::as_u64)
}

fn media_type_from_value(value: &Value) -> Option<String> {
    value
        .get("media_type")
        .or_else(|| value.get("content_type"))
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

async fn read_blob_meta(path: &Path) -> Option<BlobMeta> {
    let meta_path = path_with_meta_suffix(path);
    let text = tokio::fs::read_to_string(meta_path).await.ok()?;
    serde_json::from_str(&text).ok()
}

fn path_with_meta_suffix(path: &Path) -> PathBuf {
    let mut value: OsString = path.as_os_str().to_os_string();
    value.push(".meta");
    PathBuf::from(value)
}

fn local_blob_candidates(root: &Path, hash: &str) -> Vec<PathBuf> {
    hash_candidates(hash)
        .into_iter()
        .filter_map(|candidate| sharded_blob_path(root, &candidate))
        .collect()
}

fn sharded_blob_path(root: &Path, candidate: &str) -> Option<PathBuf> {
    if candidate.len() < 2 || !candidate.is_ascii() {
        return None;
    }
    let (prefix, suffix) = candidate.split_at(2);
    Some(root.join(prefix).join(suffix))
}

fn hash_candidates(hash: &str) -> Vec<String> {
    let mut candidates = vec![hash.to_string()];
    if let Some(stripped) = hash.strip_prefix("sha256:") {
        candidates.push(stripped.to_string());
    }
    candidates
}

fn heads_digest(heads: &[String]) -> String {
    let input = if heads.is_empty() {
        "empty".to_string()
    } else {
        let mut sorted = heads.to_vec();
        sorted.sort();
        sorted.join("\n")
    };
    let digest = Sha256::digest(input.as_bytes());
    format!("heads-{}", &hex::encode(digest)[..24])
}

fn default_notebook_id(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(sanitize_notebook_id)
        .filter(|id| !id.is_empty());
    stem.unwrap_or_else(|| uuid::Uuid::new_v4().to_string())
}

fn sanitize_notebook_id(value: &str) -> String {
    value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
                ch.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

fn with_trailing_slash(value: &str) -> String {
    if value.ends_with('/') {
        value.to_string()
    } else {
        format!("{value}/")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_nested_arrow_chunks_from_inline_manifest() {
        let output = json!({
            "data": {
                ARROW_STREAM_MANIFEST_MIME: {
                    "inline": json!({
                        "content_type": ARROW_STREAM_CONTENT_TYPE,
                        "chunks": [
                            {"hash": "chunk-a", "size": 10},
                            {"blob": "chunk-b", "content_type": "application/custom"}
                        ],
                        "schema": {"hash": "schema-fingerprint-only"}
                    }).to_string()
                }
            }
        });
        let mut refs = BTreeMap::new();
        collect_blob_refs(&output, &mut refs);

        assert!(refs.contains_key("chunk-a"));
        assert!(refs.contains_key("chunk-b"));
        assert!(!refs.contains_key("schema-fingerprint-only"));
        assert_eq!(
            refs["chunk-a"].media_type.as_deref(),
            Some(ARROW_STREAM_CONTENT_TYPE)
        );
        assert_eq!(refs["chunk-a"].size, Some(10));
        assert_eq!(
            refs["chunk-b"].media_type.as_deref(),
            Some("application/custom")
        );
    }

    #[test]
    fn expands_blob_manifest_dependencies() {
        let manifest = json!({
            "chunks": [{"hash": "chunk-a", "size": 12}],
            "blobs": [{"hash": "sidecar", "content_type": "text/plain"}]
        });

        let deps = collect_blob_manifest_dependencies(&manifest);
        assert_eq!(
            deps.iter().map(|dep| dep.hash.as_str()).collect::<Vec<_>>(),
            vec!["chunk-a", "sidecar"]
        );
    }

    #[test]
    fn collects_widget_comm_state_blobs_from_runtime_snapshot() {
        let mut state_doc = RuntimeStateDoc::new();
        state_doc
            .put_comm(
                "widget-model",
                "jupyter.widget",
                "anywidget",
                "AnyModel",
                &json!({
                    "_model_module": "anywidget",
                    "_model_name": "AnyModel",
                    "_esm": {
                        "blob": "esm-hash",
                        "size": 24,
                        "media_type": "text/javascript"
                    },
                    "binary_value": {
                        "blob": "binary-hash",
                        "size": 12,
                        "media_type": "application/octet-stream"
                    }
                }),
                0,
            )
            .unwrap();

        let runtime_state_bytes = state_doc.doc_mut().save();
        let refs = collect_snapshot_blob_refs(&runtime_state_bytes).unwrap();

        assert_eq!(
            refs["esm-hash"].media_type.as_deref(),
            Some("text/javascript")
        );
        assert_eq!(refs["esm-hash"].size, Some(24));
        assert_eq!(
            refs["binary-hash"].media_type.as_deref(),
            Some("application/octet-stream")
        );
        assert_eq!(refs["binary-hash"].size, Some(12));
    }

    #[test]
    fn default_id_is_file_stem_slug() {
        assert_eq!(
            default_notebook_id(Path::new("/tmp/Topic Viz!.ipynb")),
            "topic-viz"
        );
    }

    #[test]
    fn sharded_blob_path_skips_non_ascii_hashes() {
        assert_eq!(sharded_blob_path(Path::new("/tmp/blobs"), "éabc"), None);
        assert_eq!(
            sharded_blob_path(Path::new("/tmp/blobs"), "abcd"),
            Some(Path::new("/tmp/blobs").join("ab").join("cd"))
        );
    }
}
