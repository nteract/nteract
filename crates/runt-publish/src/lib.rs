#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use std::collections::{BTreeMap, HashSet, VecDeque};
use std::ffi::{OsStr, OsString};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use automerge::AutoCommit;
use clap::Parser;
use notebook_doc::NotebookDoc;
use notebook_sync::{connect, BroadcastReceiver, SnapshotPairBytes};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use runtime_doc::RuntimeStateDoc;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::time::{sleep, Duration, Instant};
use url::Url;

const ARROW_STREAM_MANIFEST_MIME: &str = "application/vnd.nteract.arrow-stream-manifest+json";
const DEFAULT_BLOB_CONTENT_TYPE: &str = "application/octet-stream";
const ARROW_STREAM_CONTENT_TYPE: &str = "application/vnd.apache.arrow.stream";
const DEFAULT_CLOUD_URL: &str = "https://preview.runt.run";
const ANACONDA_API_KEY_AUTH_PROVIDER: &str = "anaconda-api-key";
const NTERACT_CLOUD_URL_ENV: &str = "NTERACT_CLOUD_URL";
const NTERACT_CLOUD_AUTH_PROVIDER_ENV: &str = "NTERACT_CLOUD_AUTH_PROVIDER";
const NTERACT_PUBLISH_URL_ENV: &str = "NTERACT_PUBLISH_URL";
const NTERACT_API_KEY_ENV: &str = "NTERACT_API_KEY";
const NTERACT_PUBLISH_AUTH_PROVIDER_ENV: &str = "NTERACT_PUBLISH_AUTH_PROVIDER";
const NOTEBOOK_CLOUD_URL_ENV: &str = "NOTEBOOK_CLOUD_URL";
const NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID_ENV: &str = "NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID";
const NOTEBOOK_CLOUD_AUTH_PROVIDER_ENV: &str = "NOTEBOOK_CLOUD_AUTH_PROVIDER";
const NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN_ENV: &str = "NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN";
const NOTEBOOK_CLOUD_BEARER_TOKEN_ENV: &str = "NOTEBOOK_CLOUD_BEARER_TOKEN";
const ULID_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

const PUBLISH_ENV_KEYS: &[&str] = &[
    NTERACT_CLOUD_URL_ENV,
    NTERACT_CLOUD_AUTH_PROVIDER_ENV,
    NTERACT_PUBLISH_URL_ENV,
    NTERACT_API_KEY_ENV,
    NTERACT_PUBLISH_AUTH_PROVIDER_ENV,
    NOTEBOOK_CLOUD_URL_ENV,
    NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID_ENV,
    "NOTEBOOK_CLOUD_NOTEBOOK_ID",
    NOTEBOOK_CLOUD_BEARER_TOKEN_ENV,
    NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN_ENV,
    NOTEBOOK_CLOUD_AUTH_PROVIDER_ENV,
];

#[derive(Debug, Parser)]
#[command(
    name = "runt-publish",
    about = "Publish a local notebook through a runtimed daemon to notebook-cloud"
)]
struct Args {
    /// Local .ipynb file to open, or an active notebook UUID to publish.
    #[arg(value_name = "SOURCE")]
    source: Option<String>,

    /// Active daemon notebook UUID to publish instead of opening a file.
    #[arg(long = "source-notebook-id", env = "NOTEBOOK_CLOUD_SOURCE_NOTEBOOK_ID")]
    source_notebook_id: Option<String>,

    /// Hosted notebook-cloud base URL.
    #[arg(long = "url", env = "NTERACT_CLOUD_URL", default_value = DEFAULT_CLOUD_URL)]
    cloud_url: String,

    /// Load publishing env vars from a KEY=VALUE file before resolving credentials.
    #[arg(long = "env-file", value_name = "PATH")]
    _env_file: Vec<PathBuf>,

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
    #[arg(long = "dev-token", hide = true, hide_env_values = true)]
    dev_token: Option<String>,

    /// Bearer token for notebook-cloud publish auth. Explicit values override env;
    /// env fallback order is NTERACT_API_KEY, NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN,
    /// then NOTEBOOK_CLOUD_BEARER_TOKEN.
    #[arg(long = "bearer-token", hide_env_values = true)]
    bearer_token: Option<String>,

    /// Explicit provider for bearer-token auth. The current hosted deployment uses
    /// anaconda-api-key for publish bearer tokens.
    #[arg(long = "auth-provider", env = "NTERACT_CLOUD_AUTH_PROVIDER")]
    auth_provider: Option<String>,

    /// User label sent to notebook-cloud dev auth.
    #[arg(long, default_value = "runt-publish")]
    user: String,

    /// Operator label sent to notebook-cloud and used as the daemon peer label.
    #[arg(long, default_value = "agent:runt-publish")]
    operator: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PublishSource {
    Path(PathBuf),
    ActiveNotebookId(String),
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

struct SourceSnapshot {
    source_notebook_id: String,
    snapshot: SnapshotPairBytes,
    exported_cell_count: usize,
    _broadcast_rx: BroadcastReceiver,
}

#[derive(Debug)]
struct Publisher {
    client: reqwest::Client,
    base_url: Url,
    notebook_id: String,
    vanity_name: Option<String>,
    dev_token: Option<String>,
    bearer_token: Option<String>,
    auth_provider: Option<String>,
    user: String,
    operator: String,
    blob_base_url: Option<String>,
    blob_store_path: Option<PathBuf>,
}

pub async fn run_from_env_args() -> Result<()> {
    let raw_args = std::env::args_os().collect::<Vec<_>>();
    run_from_args(raw_args).await
}

pub async fn run_from_args(raw_args: Vec<OsString>) -> Result<()> {
    if !is_clap_short_circuit(&raw_args) {
        load_publish_env_files(&raw_args)?;
        apply_publish_env_aliases();
    }
    let args = Args::parse_from(raw_args);
    publish(args).await
}

async fn publish(args: Args) -> Result<()> {
    let publish_auth = resolve_publish_auth(&args)?;
    let publish_source = resolve_publish_source(&args)?;
    let notebook_id = args
        .notebook_id
        .clone()
        .unwrap_or_else(|| default_notebook_id(&publish_source));
    let socket_path = args
        .socket
        .clone()
        .unwrap_or_else(runtimed_client::daemon_paths::get_socket_path);

    let source_snapshot =
        export_source_snapshot(&args, &publish_source, socket_path.clone(), &notebook_id).await?;
    let (blob_base_url, blob_store_path) =
        runtimed_client::daemon_paths::get_blob_paths_async(&socket_path).await;
    let mut refs = collect_snapshot_blob_refs(
        &source_snapshot.snapshot.notebook_bytes,
        &source_snapshot.snapshot.runtime_state_bytes,
    )?;
    let initial_ref_count = refs.len();
    let runtime_state_doc_id =
        runtime_state_doc_id_from_notebook_snapshot(&source_snapshot.snapshot.notebook_bytes)?;

    let publisher = Publisher::new(
        args,
        publish_auth,
        notebook_id,
        blob_base_url,
        blob_store_path,
    )?;
    let uploaded_blobs = publisher.upload_blob_closure(&mut refs).await?;

    let runtime_heads_hash = heads_digest(&source_snapshot.snapshot.runtime_state_heads);
    let notebook_heads_hash = heads_digest(&source_snapshot.snapshot.notebook_heads);
    let runtime_state_doc_id_header = HeaderValue::from_str(&runtime_state_doc_id)
        .context("runtime state document id is not a valid header value")?;
    let mut runtime_snapshot_headers = HeaderMap::new();
    runtime_snapshot_headers.insert(
        "X-Runtime-State-Doc-Id",
        runtime_state_doc_id_header.clone(),
    );
    publisher
        .put_bytes(
            &[
                "api",
                "n",
                &publisher.notebook_id,
                "runtime-snapshots",
                &runtime_heads_hash,
            ],
            source_snapshot.snapshot.runtime_state_bytes,
            DEFAULT_BLOB_CONTENT_TYPE,
            runtime_snapshot_headers,
        )
        .await?;

    let mut snapshot_headers = HeaderMap::new();
    snapshot_headers.insert(
        "X-Runtime-Heads-Hash",
        HeaderValue::from_str(&runtime_heads_hash)
            .context("runtime heads hash is not a valid header value")?,
    );
    snapshot_headers.insert("X-Runtime-State-Doc-Id", runtime_state_doc_id_header);
    publisher
        .put_bytes(
            &[
                "api",
                "n",
                &publisher.notebook_id,
                "snapshots",
                &notebook_heads_hash,
            ],
            source_snapshot.snapshot.notebook_bytes,
            DEFAULT_BLOB_CONTENT_TYPE,
            snapshot_headers,
        )
        .await?;

    let catalog = publisher.get_catalog().await?;
    let revisions = catalog
        .get("revisions")
        .and_then(Value::as_array)
        .context("published catalog did not include revisions")?;
    let published_revision = revisions.iter().any(|revision| {
        revision.get("notebook_heads_hash").and_then(Value::as_str)
            == Some(notebook_heads_hash.as_str())
            && revision.get("runtime_heads_hash").and_then(Value::as_str)
                == Some(runtime_heads_hash.as_str())
    });
    if !published_revision {
        bail!("published catalog did not include the uploaded snapshot pair");
    }

    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "ok": true,
            "notebook_id": publisher.notebook_id,
            "source_notebook_id": source_snapshot.source_notebook_id,
            "viewer_url": publisher.viewer_url(),
            "runtime_state_doc_id": runtime_state_doc_id,
            "notebook_heads_hash": notebook_heads_hash,
            "runtime_heads_hash": runtime_heads_hash,
            "cell_count": source_snapshot.exported_cell_count,
            "initial_blob_refs": initial_ref_count,
            "total_blob_refs": refs.len(),
            "uploaded_blobs": uploaded_blobs,
        }))?
    );

    Ok(())
}

async fn export_source_snapshot(
    args: &Args,
    source: &PublishSource,
    socket_path: PathBuf,
    notebook_id: &str,
) -> Result<SourceSnapshot> {
    match source {
        PublishSource::Path(path) => export_path_source(args, path, socket_path, notebook_id).await,
        PublishSource::ActiveNotebookId(source_notebook_id) => {
            export_active_source(args, source_notebook_id, socket_path, notebook_id).await
        }
    }
}

async fn export_path_source(
    args: &Args,
    notebook_path: &Path,
    socket_path: PathBuf,
    notebook_id: &str,
) -> Result<SourceSnapshot> {
    let notebook_path = std::fs::canonicalize(notebook_path)
        .with_context(|| format!("canonicalize notebook path {}", notebook_path.display()))?;
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
    let expected_cell_count = expected_ipynb_cell_count(&notebook_path)?;
    wait_for_imported_cells(&open.handle, expected_cell_count).await?;
    open.handle.confirm_sync().await?;
    open.handle.confirm_state_sync().await?;

    let snapshot = open.handle.save_snapshot_pair()?;
    let exported_cell_count = notebook_snapshot_cell_count(&snapshot.notebook_bytes)?;
    if expected_cell_count > 0 && exported_cell_count == 0 {
        bail!(
            "exported NotebookDoc snapshot has no cells after importing {expected_cell_count} .ipynb cells"
        );
    }

    Ok(SourceSnapshot {
        source_notebook_id: open.info.notebook_id,
        snapshot,
        exported_cell_count,
        _broadcast_rx: open.broadcast_rx,
    })
}

async fn export_active_source(
    args: &Args,
    source_notebook_id: &str,
    socket_path: PathBuf,
    notebook_id: &str,
) -> Result<SourceSnapshot> {
    ensure_active_room_exists(&socket_path, source_notebook_id).await?;
    let open = connect::connect(
        socket_path.clone(),
        source_notebook_id.to_string(),
        &format!("{}:{}", args.operator, notebook_id),
    )
    .await
    .with_context(|| {
        format!(
            "connect to daemon at {} and publish active notebook {}",
            socket_path.display(),
            source_notebook_id
        )
    })?;
    open.handle.await_session_ready().await?;
    open.handle.confirm_sync().await?;
    open.handle.confirm_state_sync().await?;

    let snapshot = open.handle.save_snapshot_pair()?;
    let exported_cell_count = notebook_snapshot_cell_count(&snapshot.notebook_bytes)?;

    Ok(SourceSnapshot {
        source_notebook_id: source_notebook_id.to_string(),
        snapshot,
        exported_cell_count,
        _broadcast_rx: open.broadcast_rx,
    })
}

async fn ensure_active_room_exists(socket_path: &Path, notebook_id: &str) -> Result<()> {
    let client = runtimed_client::client::PoolClient::new(socket_path.to_path_buf());
    let rooms = client
        .list_rooms()
        .await
        .with_context(|| format!("list daemon rooms at {}", socket_path.display()))?;
    if rooms.iter().any(|room| room.notebook_id == notebook_id) {
        return Ok(());
    }

    bail!(
        "source notebook {notebook_id} is not an active daemon room; open it first or publish a local .ipynb path"
    )
}

impl Publisher {
    fn new(
        args: Args,
        publish_auth: PublishAuth,
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
            dev_token: publish_auth.dev_token,
            bearer_token: publish_auth.bearer_token,
            auth_provider: publish_auth.auth_provider,
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
            if self.remote_blob_exists(&blob_ref.hash).await? {
                continue;
            }
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

    async fn remote_blob_exists(&self, hash: &str) -> Result<bool> {
        let url = self.endpoint(&["api", "n", &self.notebook_id, "blobs", hash])?;
        let response = self
            .add_identity_headers(self.client.head(url.clone()))
            .send()
            .await?;
        if response.status().is_success() {
            return Ok(true);
        }
        if response.status().as_u16() == 404 {
            return Ok(false);
        }
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        bail!(
            "{} returned {} while checking blob existence: {}",
            url,
            status,
            text
        );
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

    async fn get_catalog(&self) -> Result<Value> {
        self.get_json(&["api", "n", &self.notebook_id]).await
    }

    fn add_identity_headers(
        &self,
        mut request: reqwest::RequestBuilder,
    ) -> reqwest::RequestBuilder {
        request = request
            .header("X-Operator", &self.operator)
            .header("X-Scope", "owner");

        if let Some(token) = &self.bearer_token {
            if let Some(provider) = &self.auth_provider {
                request = request.header("X-Notebook-Cloud-Auth-Provider", provider);
            }
            return request.bearer_auth(token);
        }

        request = request.header("X-User", &self.user);

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

#[derive(Debug, Clone, PartialEq, Eq)]
struct PublishAuth {
    dev_token: Option<String>,
    bearer_token: Option<String>,
    auth_provider: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum BearerTokenSource {
    ExplicitBearer,
    NteractApiKeyEnv,
    CloudBearerEnv,
    PublishBearerEnv,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DevTokenSource {
    Explicit,
}

impl BearerTokenSource {
    fn label(self) -> &'static str {
        match self {
            Self::ExplicitBearer => "--bearer-token",
            Self::NteractApiKeyEnv => NTERACT_API_KEY_ENV,
            Self::CloudBearerEnv => NOTEBOOK_CLOUD_BEARER_TOKEN_ENV,
            Self::PublishBearerEnv => NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN_ENV,
        }
    }

    fn is_publish_bearer_source(self) -> bool {
        matches!(self, Self::NteractApiKeyEnv | Self::PublishBearerEnv)
    }
}

fn resolve_publish_auth(args: &Args) -> Result<PublishAuth> {
    resolve_publish_auth_with_env(args, env_var_nonempty)
}

fn resolve_publish_auth_with_env(
    args: &Args,
    mut env: impl FnMut(&str) -> Option<String>,
) -> Result<PublishAuth> {
    let dev_token = resolve_dev_token(args, &mut env);
    let bearer = resolve_bearer_token(args, &mut env);

    if matches!(dev_token, Some((_, DevTokenSource::Explicit)))
        && !is_loopback_cloud_url(&args.cloud_url)
    {
        bail!("--dev-token is only for local notebook-cloud development; use {NTERACT_API_KEY_ENV} for hosted publishing");
    }

    if matches!(dev_token, Some((_, DevTokenSource::Explicit))) && bearer.is_some() {
        let source = bearer
            .as_ref()
            .map(|(_, source)| source.label())
            .unwrap_or("bearer token");
        bail!("use either --dev-token or {source}, not both");
    }

    let Some((bearer_token, source)) = bearer else {
        if dev_token.is_none() && !is_loopback_cloud_url(&args.cloud_url) {
            bail!(
                "hosted publishing requires {NTERACT_API_KEY_ENV} or --bearer-token; use a loopback URL for local dev publishing"
            );
        }
        return Ok(PublishAuth {
            dev_token: dev_token.map(|(token, _)| token),
            bearer_token: None,
            auth_provider: args
                .auth_provider
                .as_deref()
                .and_then(nonempty_string)
                .map(ToOwned::to_owned),
        });
    };

    let auth_provider = args
        .auth_provider
        .as_deref()
        .and_then(nonempty_string)
        .map(ToOwned::to_owned)
        .or_else(|| {
            source
                .is_publish_bearer_source()
                .then(|| ANACONDA_API_KEY_AUTH_PROVIDER.to_string())
        });

    Ok(PublishAuth {
        dev_token: None,
        bearer_token: Some(bearer_token),
        auth_provider,
    })
}

fn resolve_bearer_token(
    args: &Args,
    env: &mut impl FnMut(&str) -> Option<String>,
) -> Option<(String, BearerTokenSource)> {
    args.bearer_token
        .as_deref()
        .and_then(nonempty_string)
        .map(|token| (token.to_string(), BearerTokenSource::ExplicitBearer))
        .or_else(|| {
            env(NTERACT_API_KEY_ENV)
                .and_then(|token| nonempty_string(&token).map(ToOwned::to_owned))
                .map(|token| (token, BearerTokenSource::NteractApiKeyEnv))
        })
        .or_else(|| {
            env(NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN_ENV)
                .and_then(|token| nonempty_string(&token).map(ToOwned::to_owned))
                .map(|token| (token, BearerTokenSource::PublishBearerEnv))
        })
        .or_else(|| {
            env(NOTEBOOK_CLOUD_BEARER_TOKEN_ENV)
                .and_then(|token| nonempty_string(&token).map(ToOwned::to_owned))
                .map(|token| (token, BearerTokenSource::CloudBearerEnv))
        })
}

fn resolve_dev_token(
    args: &Args,
    _env: &mut impl FnMut(&str) -> Option<String>,
) -> Option<(String, DevTokenSource)> {
    args.dev_token
        .as_deref()
        .and_then(nonempty_string)
        .map(|token| (token.to_string(), DevTokenSource::Explicit))
}

fn nonempty_string(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}

fn env_var_nonempty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .and_then(|value| nonempty_string(&value).map(ToOwned::to_owned))
}

fn is_loopback_cloud_url(value: &str) -> bool {
    let Ok(url) = Url::parse(&with_trailing_slash(value)) else {
        return false;
    };
    matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"))
}

fn is_clap_short_circuit(args: &[OsString]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| matches!(arg.to_str(), Some("-h" | "--help" | "-V" | "--version")))
}

fn load_publish_env_files(raw_args: &[OsString]) -> Result<()> {
    let mut loaded = HashSet::new();
    let explicit_files = explicit_env_files_from_args(raw_args);

    for path in explicit_files {
        load_publish_env_file(expand_tilde(path), true, &mut loaded)?;
    }

    if let Some(path) = std::env::var_os("NOTEBOOK_CLOUD_ENV_FILE") {
        load_publish_env_file(expand_tilde(PathBuf::from(path)), true, &mut loaded)?;
    }

    for path in default_env_file_candidates() {
        load_publish_env_file(path, false, &mut loaded)?;
    }

    Ok(())
}

fn apply_publish_env_aliases() {
    set_env_alias_if_absent(
        NTERACT_CLOUD_URL_ENV,
        &[NOTEBOOK_CLOUD_URL_ENV, NTERACT_PUBLISH_URL_ENV],
    );
    set_env_alias_if_absent(
        NTERACT_CLOUD_AUTH_PROVIDER_ENV,
        &[
            NOTEBOOK_CLOUD_AUTH_PROVIDER_ENV,
            NTERACT_PUBLISH_AUTH_PROVIDER_ENV,
        ],
    );
}

fn set_env_alias_if_absent(canonical: &str, aliases: &[&str]) {
    if env_var_nonempty(canonical).is_some() {
        return;
    }
    for alias in aliases {
        if let Some(value) = env_var_nonempty(alias) {
            std::env::set_var(canonical, value);
            return;
        }
    }
}

fn explicit_env_files_from_args(raw_args: &[OsString]) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut iter = raw_args.iter().skip(1);
    while let Some(arg) = iter.next() {
        if arg == OsStr::new("--env-file") {
            if let Some(path) = iter.next() {
                files.push(PathBuf::from(path));
            }
            continue;
        }

        if let Some(value) = arg
            .to_str()
            .and_then(|value| value.strip_prefix("--env-file="))
            .filter(|value| !value.is_empty())
        {
            files.push(PathBuf::from(value));
        }
    }
    files
}

fn default_env_file_candidates() -> Vec<PathBuf> {
    let Ok(cwd) = std::env::current_dir() else {
        return Vec::new();
    };

    let mut candidates = Vec::new();
    for ancestor in cwd.ancestors() {
        candidates.push(ancestor.join(".env"));
        if ancestor.join(".git").exists() {
            break;
        }
    }
    candidates
}

fn load_publish_env_file(
    path: PathBuf,
    required: bool,
    loaded: &mut HashSet<PathBuf>,
) -> Result<()> {
    let canonical_for_dedupe = path.canonicalize().unwrap_or_else(|_| path.clone());
    if !loaded.insert(canonical_for_dedupe) {
        return Ok(());
    }

    let text = match std::fs::read_to_string(&path) {
        Ok(text) => text,
        Err(error) if !required && error.kind() == ErrorKind::NotFound => return Ok(()),
        Err(error) => {
            return Err(error)
                .with_context(|| format!("read publishing env file {}", path.display()))
        }
    };

    for line in text.lines() {
        let Some((key, value)) = parse_env_line(line) else {
            continue;
        };
        if !PUBLISH_ENV_KEYS.contains(&key.as_str()) {
            continue;
        }
        if std::env::var_os(&key).is_none() {
            std::env::set_var(&key, value);
        }
    }

    Ok(())
}

fn parse_env_line(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim();
    if trimmed.is_empty() || trimmed.starts_with('#') {
        return None;
    }

    let assignment = trimmed.strip_prefix("export ").unwrap_or(trimmed);
    let (key, raw_value) = assignment.split_once('=')?;
    let key = key.trim();
    if !is_env_key(key) {
        return None;
    }

    Some((key.to_string(), parse_env_value(raw_value.trim())))
}

fn is_env_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_uppercase() || ch.is_ascii_digit() || ch == '_')
}

fn parse_env_value(value: &str) -> String {
    if let Some(stripped) = strip_matching_quotes(value, '"') {
        return unescape_double_quoted_env_value(stripped);
    }
    if let Some(stripped) = strip_matching_quotes(value, '\'') {
        return stripped.to_string();
    }

    strip_unquoted_comment(value).trim().to_string()
}

fn strip_matching_quotes(value: &str, quote: char) -> Option<&str> {
    value
        .strip_prefix(quote)
        .and_then(|value| value.strip_suffix(quote))
}

fn unescape_double_quoted_env_value(value: &str) -> String {
    let mut output = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            output.push(ch);
            continue;
        }
        match chars.next() {
            Some('n') => output.push('\n'),
            Some('r') => output.push('\r'),
            Some('t') => output.push('\t'),
            Some('"') => output.push('"'),
            Some('\\') => output.push('\\'),
            Some(other) => {
                output.push('\\');
                output.push(other);
            }
            None => output.push('\\'),
        }
    }
    output
}

fn strip_unquoted_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    for index in 0..bytes.len() {
        if bytes[index] == b'#' && (index == 0 || bytes[index - 1].is_ascii_whitespace()) {
            return &value[..index];
        }
    }
    value
}

fn expand_tilde(path: PathBuf) -> PathBuf {
    let Some(value) = path.to_str() else {
        return path;
    };
    let Some(rest) = value.strip_prefix("~/") else {
        return path;
    };
    let Some(home) = std::env::var_os("HOME") else {
        return path;
    };
    PathBuf::from(home).join(rest)
}

fn collect_snapshot_blob_refs(
    notebook_bytes: &[u8],
    runtime_state_bytes: &[u8],
) -> Result<BTreeMap<String, BlobRef>> {
    let mut refs = BTreeMap::new();
    collect_runtime_snapshot_blob_refs(runtime_state_bytes, &mut refs)?;
    collect_notebook_snapshot_blob_refs(notebook_bytes, &mut refs)?;
    Ok(refs)
}

fn notebook_snapshot_cell_count(notebook_bytes: &[u8]) -> Result<usize> {
    let notebook_doc = NotebookDoc::load(notebook_bytes)
        .context("load NotebookDoc from exported snapshot bytes")?;
    Ok(notebook_doc.get_cells().len())
}

fn expected_ipynb_cell_count(path: &Path) -> Result<usize> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    let json: Value =
        serde_json::from_slice(&bytes).with_context(|| format!("parse {}", path.display()))?;
    Ok(json
        .get("cells")
        .and_then(Value::as_array)
        .map_or(0, Vec::len))
}

async fn wait_for_imported_cells(
    handle: &notebook_sync::handle::DocHandle,
    expected_cell_count: usize,
) -> Result<()> {
    if expected_cell_count == 0 {
        return Ok(());
    }

    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let observed = handle.get_cells().len();
        if observed >= expected_cell_count {
            return Ok(());
        }
        if Instant::now() >= deadline {
            bail!(
                "timed out waiting for notebook import: expected at least {expected_cell_count} cells, observed {observed}"
            );
        }
        handle.confirm_sync().await?;
        sleep(Duration::from_millis(250)).await;
    }
}

fn runtime_state_doc_id_from_notebook_snapshot(notebook_bytes: &[u8]) -> Result<String> {
    let notebook_doc = NotebookDoc::load(notebook_bytes)
        .context("load NotebookDoc from exported snapshot bytes")?;
    notebook_doc
        .runtime_state_doc_id()
        .context("NotebookDoc snapshot is missing runtime_state_doc_id")
}

fn collect_runtime_snapshot_blob_refs(
    runtime_state_bytes: &[u8],
    refs: &mut BTreeMap<String, BlobRef>,
) -> Result<()> {
    let runtime_doc = AutoCommit::load(runtime_state_bytes)
        .context("load RuntimeStateDoc from exported snapshot bytes")?;
    let state_doc = RuntimeStateDoc::from_doc(runtime_doc);
    let state = state_doc.read_state();

    for execution in state.executions.values() {
        for output in &execution.outputs {
            collect_blob_refs(output, refs);
        }
    }
    for comm in state.comms.values() {
        collect_blob_refs(&comm.state, refs);
        for output in &comm.outputs {
            collect_blob_refs(output, refs);
        }
    }

    Ok(())
}

fn collect_notebook_snapshot_blob_refs(
    notebook_bytes: &[u8],
    refs: &mut BTreeMap<String, BlobRef>,
) -> Result<()> {
    let notebook_doc = NotebookDoc::load(notebook_bytes)
        .context("load NotebookDoc from exported snapshot bytes")?;

    for cell in notebook_doc.get_cells() {
        for hash in cell.resolved_assets.values() {
            insert_blob_ref(refs, hash, None, None);
        }
        for bundle in cell.attachments.values() {
            for (media_type, attachment_ref) in bundle {
                insert_blob_ref(
                    refs,
                    &attachment_ref.blob_hash,
                    None,
                    Some(media_type.clone()),
                );
            }
        }
    }

    Ok(())
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
                insert_blob_ref(refs, &dep.hash, dep.size, dep.media_type);
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

    collect_manifest_blob_ref(value, manifest_content_type.clone(), true, &mut refs);

    if let Some(chunks) = value.get("chunks").and_then(Value::as_array) {
        for chunk in chunks {
            collect_manifest_blob_ref(chunk, manifest_content_type.clone(), true, &mut refs);
        }
    }

    if let Some(blobs) = value.get("blobs").and_then(Value::as_array) {
        for blob in blobs {
            collect_manifest_blob_ref(blob, None, false, &mut refs);
        }
    }

    if let Some(coalesced) = value.get("coalesced") {
        collect_manifest_blob_ref(coalesced, manifest_content_type.clone(), true, &mut refs);
        if let Some(segments) = coalesced.get("segments").and_then(Value::as_array) {
            for segment in segments {
                collect_manifest_blob_ref(segment, manifest_content_type.clone(), true, &mut refs);
            }
        }
    }

    refs
}

fn collect_manifest_blob_ref(
    value: &Value,
    fallback_media_type: Option<String>,
    default_to_arrow_stream: bool,
    refs: &mut Vec<BlobRef>,
) {
    let Some(hash) = value
        .get("blob")
        .or_else(|| value.get("hash"))
        .and_then(Value::as_str)
    else {
        return;
    };

    refs.push(BlobRef {
        hash: hash.to_string(),
        size: size_from_value(value),
        media_type: media_type_from_value(value)
            .or(fallback_media_type)
            .or_else(|| default_to_arrow_stream.then(|| ARROW_STREAM_CONTENT_TYPE.to_string())),
    });
}

fn insert_blob_ref(
    refs: &mut BTreeMap<String, BlobRef>,
    hash: &str,
    size: Option<u64>,
    media_type: Option<String>,
) {
    refs.entry(hash.to_string())
        .and_modify(|existing| {
            if existing.size.is_none() {
                existing.size = size;
            }
            if existing.media_type.is_none() {
                existing.media_type = media_type.clone();
            }
        })
        .or_insert_with(|| BlobRef {
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

fn resolve_publish_source(args: &Args) -> Result<PublishSource> {
    let source = args.source.as_deref().and_then(nonempty_string);
    let source_notebook_id = args.source_notebook_id.as_deref().and_then(nonempty_string);

    match (source, source_notebook_id) {
        (Some(_), Some(_)) => {
            bail!("provide either SOURCE or --source-notebook-id, not both")
        }
        (Some(source), None) => publish_source_from_arg(source),
        (None, Some(source_notebook_id)) => Ok(PublishSource::ActiveNotebookId(
            validate_source_notebook_id(source_notebook_id)?,
        )),
        (None, None) => bail!("provide a local .ipynb path or --source-notebook-id"),
    }
}

fn publish_source_from_arg(value: &str) -> Result<PublishSource> {
    if uuid::Uuid::parse_str(value).is_ok() {
        return Ok(PublishSource::ActiveNotebookId(value.to_string()));
    }
    Ok(PublishSource::Path(PathBuf::from(value)))
}

fn validate_source_notebook_id(value: &str) -> Result<String> {
    uuid::Uuid::parse_str(value)
        .with_context(|| format!("source notebook id {value:?} is not a UUID"))?;
    Ok(value.to_string())
}

fn default_notebook_id(source: &PublishSource) -> String {
    match source {
        PublishSource::Path(path) => default_notebook_id_from_path(path),
        PublishSource::ActiveNotebookId(_) => create_ulid(),
    }
}

fn default_notebook_id_from_path(path: &Path) -> String {
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(sanitize_notebook_id)
        .filter(|id| !id.is_empty());
    stem.unwrap_or_else(create_ulid)
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

fn create_ulid() -> String {
    let timestamp_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random_uuid = uuid::Uuid::new_v4();
    let mut random = [0u8; 10];
    random.copy_from_slice(&random_uuid.as_bytes()[..10]);
    create_ulid_from_parts(timestamp_ms, random)
}

fn create_ulid_from_parts(timestamp_ms: u128, random: [u8; 10]) -> String {
    let mut output = String::with_capacity(26);
    let mut time = timestamp_ms & ((1u128 << 48) - 1);
    let mut time_chars = [0u8; 10];
    for index in (0..time_chars.len()).rev() {
        time_chars[index] = ULID_ALPHABET[(time & 0b11111) as usize];
        time >>= 5;
    }
    for ch in time_chars {
        output.push(char::from(ch));
    }

    let mut random_value = 0u128;
    for byte in random {
        random_value = (random_value << 8) | u128::from(byte);
    }
    let mut random_chars = [0u8; 16];
    for index in (0..random_chars.len()).rev() {
        random_chars[index] = ULID_ALPHABET[(random_value & 0b11111) as usize];
        random_value >>= 5;
    }
    for ch in random_chars {
        output.push(char::from(ch));
    }

    output
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
    use automerge::transaction::Transactable;
    use notebook_doc::{AttachmentEncoding, AttachmentRef};
    use std::collections::HashMap;

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
        insert_blob_ref(&mut refs, "chunk-a", None, None);
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
            "blob": "single-stream",
            "size": 99,
            "content_type": ARROW_STREAM_CONTENT_TYPE,
            "chunks": [{"hash": "chunk-a", "size": 12}],
            "blobs": [{"hash": "sidecar", "content_type": "text/plain"}],
            "coalesced": {
                "hash": "coalesced-stream",
                "segments": [{"hash": "coalesced-segment"}]
            },
            "schema": {"hash": "schema-fingerprint-only"}
        });

        let deps = collect_blob_manifest_dependencies(&manifest);
        assert_eq!(
            deps.iter().map(|dep| dep.hash.as_str()).collect::<Vec<_>>(),
            vec![
                "single-stream",
                "chunk-a",
                "sidecar",
                "coalesced-stream",
                "coalesced-segment"
            ]
        );
        assert_eq!(deps[0].size, Some(99));
        assert_eq!(
            deps[0].media_type.as_deref(),
            Some(ARROW_STREAM_CONTENT_TYPE)
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
        let mut refs = BTreeMap::new();
        collect_runtime_snapshot_blob_refs(&runtime_state_bytes, &mut refs).unwrap();

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
    fn collects_notebook_doc_assets_and_attachment_blobs_from_snapshot() {
        let mut notebook_doc = NotebookDoc::new("publish-assets");
        notebook_doc
            .add_cell(0, "markdown-cell", "markdown")
            .unwrap();
        notebook_doc
            .update_source("markdown-cell", "![plot](attachment:plot.png)")
            .unwrap();
        notebook_doc
            .set_cell_resolved_assets(
                "markdown-cell",
                &HashMap::from([(
                    "attachment:plot.png".to_string(),
                    "resolved-asset-hash".to_string(),
                )]),
            )
            .unwrap();
        notebook_doc
            .set_cell_attachments(
                "markdown-cell",
                &HashMap::from([(
                    "plot.png".to_string(),
                    HashMap::from([(
                        "image/png".to_string(),
                        AttachmentRef {
                            blob_hash: "attachment-hash".to_string(),
                            encoding: AttachmentEncoding::Base64,
                        },
                    )]),
                )]),
            )
            .unwrap();

        let notebook_bytes = notebook_doc.save();
        let mut refs = BTreeMap::new();
        collect_notebook_snapshot_blob_refs(&notebook_bytes, &mut refs).unwrap();

        assert!(refs.contains_key("resolved-asset-hash"));
        assert_eq!(
            refs["attachment-hash"].media_type.as_deref(),
            Some("image/png")
        );
    }

    #[test]
    fn insert_blob_ref_keeps_first_hash_but_fills_missing_metadata() {
        let mut refs = BTreeMap::new();

        insert_blob_ref(&mut refs, "shared-hash", None, None);
        insert_blob_ref(
            &mut refs,
            "shared-hash",
            Some(42),
            Some("text/plain".to_string()),
        );

        assert_eq!(refs["shared-hash"].size, Some(42));
        assert_eq!(
            refs["shared-hash"].media_type.as_deref(),
            Some("text/plain")
        );
    }

    #[test]
    fn default_id_is_file_stem_slug() {
        assert_eq!(
            default_notebook_id(&PublishSource::Path(PathBuf::from("/tmp/Topic Viz!.ipynb"))),
            "topic-viz"
        );
    }

    #[test]
    fn active_source_default_id_is_ulid() {
        let source =
            PublishSource::ActiveNotebookId("018fc2e5-ea4b-7f7c-a079-6f42d90ff3a0".to_string());

        assert_is_canonical_ulid(&default_notebook_id(&source));
    }

    #[test]
    fn create_ulid_encodes_timestamp_and_random_bytes() {
        assert_eq!(
            create_ulid_from_parts(1, [0; 10]),
            "00000000010000000000000000"
        );
        assert_eq!(
            create_ulid_from_parts((1u128 << 48) - 1, [0xff; 10]),
            "7ZZZZZZZZZZZZZZZZZZZZZZZZZ"
        );
    }

    #[test]
    fn source_argument_uuid_selects_active_room() {
        let source_id = "018fc2e5-ea4b-7f7c-a079-6f42d90ff3a0";
        let args = Args::try_parse_from(["runt-publish", source_id]).unwrap();

        assert_eq!(
            resolve_publish_source(&args).unwrap(),
            PublishSource::ActiveNotebookId(source_id.to_string())
        );
    }

    #[test]
    fn source_argument_path_selects_file_open() {
        let args = Args::try_parse_from(["runt-publish", "Topic Viz.ipynb"]).unwrap();

        assert_eq!(
            resolve_publish_source(&args).unwrap(),
            PublishSource::Path(PathBuf::from("Topic Viz.ipynb"))
        );
    }

    #[test]
    fn source_notebook_id_requires_uuid() {
        let args =
            Args::try_parse_from(["runt-publish", "--source-notebook-id", "not-a-uuid"]).unwrap();
        let error = resolve_publish_source(&args).unwrap_err();

        assert!(
            error.to_string().contains("source notebook id"),
            "{error:#}"
        );
    }

    #[test]
    fn source_argument_conflicts_with_source_notebook_id() {
        let args = Args::try_parse_from([
            "runt-publish",
            "--source-notebook-id",
            "018fc2e5-ea4b-7f7c-a079-6f42d90ff3a0",
            "Topic Viz.ipynb",
        ])
        .unwrap();
        let error = resolve_publish_source(&args).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("provide either SOURCE or --source-notebook-id"),
            "{error:#}"
        );
    }

    #[test]
    fn missing_source_is_rejected() {
        let args = Args::try_parse_from(["runt-publish"]).unwrap();
        let error = resolve_publish_source(&args).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("provide a local .ipynb path or --source-notebook-id"),
            "{error:#}"
        );
    }

    #[test]
    fn runtime_state_doc_id_comes_from_notebook_pointer() {
        let mut notebook_doc = NotebookDoc::new("publish-runtime-pointer");
        let runtime_state_doc_id =
            runtime_state_doc_id_from_notebook_snapshot(&notebook_doc.save()).unwrap();

        assert_eq!(
            runtime_state_doc_id,
            notebook_doc.runtime_state_doc_id().unwrap()
        );
    }

    #[test]
    fn runtime_state_doc_id_is_required() {
        let mut notebook_doc = NotebookDoc::new("publish-runtime-pointer");
        notebook_doc
            .doc_mut()
            .delete(automerge::ROOT, "runtime_state_doc_id")
            .unwrap();

        let error = runtime_state_doc_id_from_notebook_snapshot(&notebook_doc.save()).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("NotebookDoc snapshot is missing runtime_state_doc_id"),
            "{error:#}"
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

    #[test]
    fn publisher_reads_catalog_by_notebook_id() {
        let publisher = Publisher {
            client: reqwest::Client::new(),
            base_url: Url::parse("https://cloud.test/").unwrap(),
            notebook_id: "topic-viz".to_string(),
            vanity_name: None,
            dev_token: None,
            bearer_token: None,
            auth_provider: None,
            user: "runt-publish".to_string(),
            operator: "agent:runt-publish".to_string(),
            blob_base_url: None,
            blob_store_path: None,
        };

        assert_eq!(
            publisher
                .endpoint(&["api", "n", &publisher.notebook_id])
                .unwrap()
                .as_str(),
            "https://cloud.test/api/n/topic-viz"
        );
    }

    #[test]
    fn default_cloud_url_targets_preview() {
        let args = with_env_var_removed(NTERACT_CLOUD_URL_ENV, || {
            Args::try_parse_from(["runt-publish", "topic.ipynb"]).unwrap()
        });

        assert_eq!(args.cloud_url, DEFAULT_CLOUD_URL);
    }

    #[test]
    fn nteract_api_key_env_uses_preview_provider_header() {
        let args = Args::try_parse_from(["runt-publish", "topic.ipynb"]).unwrap();
        let token = "api-key-token".to_string();
        let auth = resolve_publish_auth_with_env(&args, |name| {
            (name == NTERACT_API_KEY_ENV).then(|| token.clone())
        })
        .unwrap();

        assert_eq!(auth.bearer_token.as_deref(), Some(token.as_str()));
        assert_eq!(
            auth.auth_provider.as_deref(),
            Some(ANACONDA_API_KEY_AUTH_PROVIDER)
        );
        assert_eq!(auth.dev_token, None);
    }

    #[test]
    fn publish_bearer_env_uses_preview_provider_header() {
        let args = Args::try_parse_from(["runt-publish", "topic.ipynb"]).unwrap();
        let token = "publish-token".to_string();
        let auth = resolve_publish_auth_with_env(&args, |name| {
            (name == NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN_ENV).then(|| token.clone())
        })
        .unwrap();

        assert_eq!(auth.bearer_token.as_deref(), Some(token.as_str()));
        assert_eq!(
            auth.auth_provider.as_deref(),
            Some(ANACONDA_API_KEY_AUTH_PROVIDER)
        );
    }

    #[test]
    fn cloud_bearer_env_preserves_explicit_auth_provider() {
        let args = Args::try_parse_from([
            "runt-publish",
            "--auth-provider",
            "custom-provider",
            "topic.ipynb",
        ])
        .unwrap();
        let auth = resolve_publish_auth_with_env(&args, |name| {
            (name == NOTEBOOK_CLOUD_BEARER_TOKEN_ENV).then(|| "bearer-token".to_string())
        })
        .unwrap();

        assert_eq!(auth.bearer_token.as_deref(), Some("bearer-token"));
        assert_eq!(auth.auth_provider.as_deref(), Some("custom-provider"));
    }

    #[test]
    fn publish_bearer_env_ignores_smoke_dev_token_env() {
        let args = Args::try_parse_from(["runt-publish", "topic.ipynb"]).unwrap();
        let token = "api-key-token".to_string();
        let auth = resolve_publish_auth_with_env(&args, |name| match name {
            NTERACT_API_KEY_ENV => Some(token.clone()),
            "NOTEBOOK_CLOUD_DEV_TOKEN" => Some("stale-dev-token".to_string()),
            _ => None,
        })
        .unwrap();

        assert_eq!(auth.bearer_token.as_deref(), Some(token.as_str()));
        assert_eq!(auth.dev_token, None);
    }

    #[test]
    fn hosted_publish_requires_bearer_auth() {
        let args = Args::try_parse_from(["runt-publish", "topic.ipynb"]).unwrap();
        let error = resolve_publish_auth_with_env(&args, |_| None).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("hosted publishing requires NTERACT_API_KEY"),
            "{error:#}"
        );

        let local_args = Args::try_parse_from([
            "runt-publish",
            "--url",
            "http://127.0.0.1:8787",
            "topic.ipynb",
        ])
        .unwrap();
        let auth = resolve_publish_auth_with_env(&local_args, |_| None).unwrap();

        assert_eq!(auth.bearer_token, None);
        assert_eq!(auth.dev_token, None);
    }

    #[test]
    fn explicit_dev_token_conflicts_with_publish_bearer_env() {
        let args = Args::try_parse_from([
            "runt-publish",
            "--url",
            "http://127.0.0.1:8787",
            "--dev-token",
            "dev-token",
            "topic.ipynb",
        ])
        .unwrap();
        let error = resolve_publish_auth_with_env(&args, |name| {
            (name == NTERACT_API_KEY_ENV).then(|| "api-key-token".to_string())
        })
        .unwrap_err();

        assert!(error.to_string().contains("use either --dev-token"));
    }

    #[test]
    fn explicit_dev_token_is_local_only() {
        let args =
            Args::try_parse_from(["runt-publish", "--dev-token", "dev-token", "topic.ipynb"])
                .unwrap();
        let error = resolve_publish_auth_with_env(&args, |_| None).unwrap_err();

        assert!(
            error
                .to_string()
                .contains("--dev-token is only for local notebook-cloud development"),
            "{error:#}"
        );

        let local_args = Args::try_parse_from([
            "runt-publish",
            "--url",
            "http://localhost:8787",
            "--dev-token",
            "dev-token",
            "topic.ipynb",
        ])
        .unwrap();
        let auth = resolve_publish_auth_with_env(&local_args, |_| None).unwrap();

        assert_eq!(auth.dev_token.as_deref(), Some("dev-token"));
        assert_eq!(auth.bearer_token, None);
    }

    #[test]
    fn explicit_env_files_support_space_and_equals_forms() {
        let files = explicit_env_files_from_args(&[
            OsString::from("runt-publish"),
            OsString::from("--env-file"),
            OsString::from("~/codex/desktop/.env"),
            OsString::from("--env-file=/tmp/publish.env"),
            OsString::from("topic.ipynb"),
        ]);

        assert_eq!(
            files,
            vec![
                PathBuf::from("~/codex/desktop/.env"),
                PathBuf::from("/tmp/publish.env")
            ]
        );
    }

    #[test]
    fn parses_quoted_publish_env_values() {
        assert_eq!(
            parse_env_line("export NTERACT_API_KEY=\"abc.def\""),
            Some((NTERACT_API_KEY_ENV.to_string(), "abc.def".to_string()))
        );
        assert_eq!(
            parse_env_line("NTERACT_CLOUD_URL=https://preview.runt.run # preview"),
            Some((
                NTERACT_CLOUD_URL_ENV.to_string(),
                "https://preview.runt.run".to_string()
            ))
        );
    }

    fn with_env_var_removed<T>(name: &str, f: impl FnOnce() -> T) -> T {
        static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = ENV_LOCK.lock().unwrap();
        let previous = std::env::var_os(name);
        std::env::remove_var(name);
        let result = f();
        if let Some(value) = previous {
            std::env::set_var(name, value);
        } else {
            std::env::remove_var(name);
        }
        result
    }

    fn assert_is_canonical_ulid(value: &str) {
        assert_eq!(value.len(), 26);
        assert!(value.chars().all(
            |ch| matches!(ch, '0'..='9' | 'A'..='H' | 'J'..='K' | 'M'..='N' | 'P'..='T' | 'V'..='Z')
        ));
    }
}
