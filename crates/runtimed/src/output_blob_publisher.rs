//! Optional remote publishing for blobs referenced by output manifests.
//!
//! Desktop/local kernels only need the local [`BlobStore`]. A cloud runtime
//! peer also has to make those same content-addressed bytes available through
//! preview's blob API before RuntimeStateDoc advertises the hash to browsers.
//! When the agent has a [`TokenRefresher`], every upload asks it for the
//! current token, so blob uploads and room reconnects share one credential.

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use notebook_cloud_transport::{CloudAuth, CloudWsConfig, TokenRefresher};
use reqwest::StatusCode;
use tokio::sync::Mutex;
use tokio::time::{sleep, Duration};
use tracing::{debug, warn};

use crate::blob_store::BlobStore;
use crate::output_store::{OutputBlobRef, OutputManifest};

const BLOB_UPLOAD_ATTEMPTS: usize = 3;
const BLOB_UPLOAD_RETRY_BASE_DELAY_MS: u64 = 150;

#[derive(Clone, Default)]
pub(crate) struct OutputBlobPublisher {
    cloud: Option<Arc<CloudBlobPublisher>>,
}

impl OutputBlobPublisher {
    pub(crate) fn none() -> Self {
        Self { cloud: None }
    }

    /// `refresher`, when set, supplies the token for each upload; `None`
    /// keeps the static token from `config.auth`.
    pub(crate) fn cloud(config: &CloudWsConfig, refresher: Option<TokenRefresher>) -> Self {
        Self {
            cloud: Some(Arc::new(CloudBlobPublisher::new(config, refresher))),
        }
    }

    pub(crate) async fn publish_manifest_blobs(
        &self,
        manifest: &OutputManifest,
        blob_store: &BlobStore,
    ) -> Result<(), BlobPublishError> {
        let Some(cloud) = &self.cloud else {
            return Ok(());
        };

        let blobs = manifest.blob_refs(blob_store).await.map_err(|error| {
            BlobPublishError::InvalidManifest {
                message: error.to_string(),
            }
        })?;
        for blob in blobs {
            cloud.publish_blob(blob, blob_store).await?;
        }
        Ok(())
    }

    /// Publish one non-manifest artifact before RuntimeStateDoc references it.
    pub(crate) async fn publish_artifact(
        &self,
        hash: String,
        size: u64,
        media_type: String,
        blob_store: &BlobStore,
    ) -> Result<(), BlobPublishError> {
        let Some(cloud) = &self.cloud else {
            return Ok(());
        };
        cloud
            .publish_blob(
                OutputBlobRef {
                    hash,
                    size,
                    media_type,
                },
                blob_store,
            )
            .await
    }
}

impl fmt::Debug for OutputBlobPublisher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("OutputBlobPublisher")
            .field("cloud", &self.cloud.is_some())
            .finish()
    }
}

struct CloudBlobPublisher {
    client: reqwest::Client,
    cloud_url: String,
    notebook_id: String,
    scope: String,
    auth: CloudAuth,
    refresher: Option<TokenRefresher>,
    uploaded: Mutex<HashSet<String>>,
}

impl CloudBlobPublisher {
    fn new(config: &CloudWsConfig, refresher: Option<TokenRefresher>) -> Self {
        Self {
            client: reqwest::Client::new(),
            cloud_url: config.cloud_url.trim_end_matches('/').to_string(),
            notebook_id: config.notebook_id.clone(),
            scope: config.scope.clone(),
            auth: config.auth.clone(),
            refresher,
            uploaded: Mutex::new(HashSet::new()),
        }
    }

    /// The credential for the next upload: the refresher's current token in
    /// `config.auth`'s variant, or the static auth when there is no refresher.
    async fn current_auth(&self, hash: &str) -> Result<CloudAuth, BlobPublishError> {
        let Some(refresh) = &self.refresher else {
            return Ok(self.auth.clone());
        };
        refresh()
            .await
            .map(|token| self.auth.with_token(token))
            .map_err(|error| {
                // Details (cache path, issuer) stay in the local log; the
                // error below can end up in a synced notebook output.
                warn!("[output-blob-publisher] credential refresh failed for blob {hash}: {error}");
                BlobPublishError::Credential {
                    hash: hash.to_string(),
                }
            })
    }

    async fn publish_blob(
        &self,
        blob: OutputBlobRef,
        blob_store: &BlobStore,
    ) -> Result<(), BlobPublishError> {
        let upload_key = upload_dedupe_key(&blob);
        if self.uploaded.lock().await.contains(&upload_key) {
            return Ok(());
        }

        let bytes = blob_store
            .get(&blob.hash)
            .await
            .map_err(|error| BlobPublishError::LocalRead {
                hash: blob.hash.clone(),
                message: error.to_string(),
            })?
            .ok_or_else(|| BlobPublishError::MissingLocalBlob {
                hash: blob.hash.clone(),
            })?;
        if bytes.len() as u64 != blob.size {
            return Err(BlobPublishError::SizeMismatch {
                hash: blob.hash,
                expected: blob.size,
                actual: bytes.len() as u64,
            });
        }

        for attempt in 1..=BLOB_UPLOAD_ATTEMPTS {
            match self.upload_blob_once(&blob, bytes.clone()).await {
                Ok(()) => {
                    debug!(
                        "[output-blob-publisher] uploaded blob {} ({} bytes, {})",
                        blob.hash, blob.size, blob.media_type
                    );
                    self.uploaded.lock().await.insert(upload_key);
                    return Ok(());
                }
                Err(error) if attempt < BLOB_UPLOAD_ATTEMPTS && error.is_retryable() => {
                    warn!(
                        "[output-blob-publisher] retrying blob {} upload after attempt {}/{} failed: {}",
                        blob.hash, attempt, BLOB_UPLOAD_ATTEMPTS, error
                    );
                    sleep(upload_retry_delay(attempt)).await;
                }
                Err(error) => return Err(error),
            }
        }

        Err(BlobPublishError::RemoteRequest {
            hash: blob.hash,
            message: "upload retry loop exhausted without a terminal error".to_string(),
        })
    }

    async fn upload_blob_once(
        &self,
        blob: &OutputBlobRef,
        bytes: Vec<u8>,
    ) -> Result<(), BlobPublishError> {
        let auth = self.current_auth(&blob.hash).await?;
        let url = blob_upload_url(&self.cloud_url, &self.notebook_id, &blob.hash);
        let mut request = self
            .client
            .put(url)
            .header("X-Scope", &self.scope)
            .header("X-Operator", "agent:runt:blob-publisher")
            .header("Content-Type", &blob.media_type)
            .body(bytes);
        request = apply_auth_headers(request, &auth);

        let response = request
            .send()
            .await
            .map_err(|error| BlobPublishError::RemoteRequest {
                hash: blob.hash.clone(),
                message: error.to_string(),
            })?;
        let status = response.status();
        if status != StatusCode::CREATED && status != StatusCode::OK {
            let body = response.text().await.unwrap_or_default();
            return Err(BlobPublishError::RemoteStatus {
                hash: blob.hash.clone(),
                status,
                body,
            });
        }

        Ok(())
    }
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum BlobPublishError {
    #[error("local blob {hash} is missing")]
    MissingLocalBlob { hash: String },
    #[error("failed to read local blob {hash}: {message}")]
    LocalRead { hash: String, message: String },
    #[error("local blob {hash} size mismatch: expected {expected}, got {actual}")]
    SizeMismatch {
        hash: String,
        expected: u64,
        actual: u64,
    },
    #[error("failed to enumerate output manifest blobs: {message}")]
    InvalidManifest { message: String },
    #[error("failed to upload blob {hash}: {message}")]
    RemoteRequest { hash: String, message: String },
    #[error("cloud credential refresh failed before uploading blob {hash}")]
    Credential { hash: String },
    #[error("blob {hash} upload failed with {status}: {body}")]
    RemoteStatus {
        hash: String,
        status: StatusCode,
        body: String,
    },
}

impl BlobPublishError {
    fn is_retryable(&self) -> bool {
        match self {
            Self::RemoteRequest { .. } => true,
            Self::RemoteStatus { status, .. } => {
                *status == StatusCode::REQUEST_TIMEOUT
                    || *status == StatusCode::TOO_MANY_REQUESTS
                    || status.is_server_error()
            }
            // The refresher already bounds its own requests; retrying here
            // would only stack more issuer timeouts onto the output path.
            Self::Credential { .. }
            | Self::MissingLocalBlob { .. }
            | Self::LocalRead { .. }
            | Self::SizeMismatch { .. }
            | Self::InvalidManifest { .. } => false,
        }
    }
}

pub(crate) async fn publish_or_warn(
    publisher: &OutputBlobPublisher,
    manifest: &OutputManifest,
    blob_store: &BlobStore,
    context: &str,
) -> Result<(), BlobPublishError> {
    match publisher.publish_manifest_blobs(manifest, blob_store).await {
        Ok(()) => Ok(()),
        Err(error) => {
            warn!("[output-blob-publisher] {context}: {error}");
            Err(error)
        }
    }
}

fn apply_auth_headers(
    request: reqwest::RequestBuilder,
    auth: &CloudAuth,
) -> reqwest::RequestBuilder {
    match auth {
        // Workstation credentials share OIDC's wire shape (plain bearer).
        CloudAuth::OidcBearer { token } | CloudAuth::WorkstationCredential { token } => {
            request.bearer_auth(token)
        }
        CloudAuth::AnacondaApiKey { token } => request
            .bearer_auth(token)
            .header("X-Notebook-Cloud-Auth-Provider", "anaconda-api-key"),
        CloudAuth::Dev { token, user } => request
            .header("X-Notebook-Cloud-Dev-Token", token)
            .header("X-User", user),
    }
}

fn blob_upload_url(cloud_url: &str, notebook_id: &str, hash: &str) -> String {
    format!(
        "{}/api/n/{}/blobs/{}",
        cloud_url.trim_end_matches('/'),
        encode_path_segment(notebook_id),
        encode_path_segment(hash)
    )
}

fn upload_dedupe_key(blob: &OutputBlobRef) -> String {
    format!("{}\0{}", blob.hash, blob.media_type)
}

fn upload_retry_delay(attempt: usize) -> Duration {
    let multiplier = 1u64 << attempt.saturating_sub(1);
    Duration::from_millis(BLOB_UPLOAD_RETRY_BASE_DELAY_MS * multiplier)
}

fn encode_path_segment(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                encoded.push(byte as char)
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blob_upload_url_percent_encodes_path_segments() {
        assert_eq!(
            blob_upload_url("https://preview.runt.run/", "room/id", "ab cd"),
            "https://preview.runt.run/api/n/room%2Fid/blobs/ab%20cd"
        );
    }

    #[test]
    fn upload_dedupe_key_includes_media_type() {
        let text = OutputBlobRef {
            hash: "a".repeat(64),
            size: 1,
            media_type: "text/plain".to_string(),
        };
        let json = OutputBlobRef {
            media_type: "application/json".to_string(),
            ..text.clone()
        };

        assert_ne!(upload_dedupe_key(&text), upload_dedupe_key(&json));
    }

    #[test]
    fn retry_policy_only_retries_transient_remote_failures() {
        assert!(BlobPublishError::RemoteRequest {
            hash: "a".to_string(),
            message: "connection reset".to_string(),
        }
        .is_retryable());
        assert!(BlobPublishError::RemoteStatus {
            hash: "a".to_string(),
            status: StatusCode::SERVICE_UNAVAILABLE,
            body: String::new(),
        }
        .is_retryable());
        assert!(BlobPublishError::RemoteStatus {
            hash: "a".to_string(),
            status: StatusCode::TOO_MANY_REQUESTS,
            body: String::new(),
        }
        .is_retryable());
        assert!(!BlobPublishError::RemoteStatus {
            hash: "a".to_string(),
            status: StatusCode::FORBIDDEN,
            body: String::new(),
        }
        .is_retryable());
        assert!(!BlobPublishError::SizeMismatch {
            hash: "a".to_string(),
            expected: 1,
            actual: 2,
        }
        .is_retryable());
        assert!(!BlobPublishError::Credential {
            hash: "a".to_string(),
        }
        .is_retryable());
    }

    // -- credential sharing ---------------------------------------------------

    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Local blob endpoint that records each upload's `Authorization` header.
    struct FakeBlobServer {
        url: String,
        authorizations: Arc<std::sync::Mutex<Vec<String>>>,
        _shutdown: tokio::sync::oneshot::Sender<()>,
    }

    async fn start_fake_blob_server() -> FakeBlobServer {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let authorizations = Arc::new(std::sync::Mutex::new(Vec::new()));
        let seen = authorizations.clone();
        let (shutdown_tx, mut shutdown_rx) = tokio::sync::oneshot::channel::<()>();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = &mut shutdown_rx => break,
                    accepted = listener.accept() => {
                        let Ok((stream, _)) = accepted else { break };
                        let seen = seen.clone();
                        tokio::spawn(async move {
                            let io = hyper_util::rt::TokioIo::new(stream);
                            let service = hyper::service::service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                                let seen = seen.clone();
                                async move {
                                    let auth = req
                                        .headers()
                                        .get("authorization")
                                        .and_then(|v| v.to_str().ok())
                                        .unwrap_or_default()
                                        .to_string();
                                    seen.lock().unwrap().push(auth);
                                    Ok::<_, std::convert::Infallible>(
                                        hyper::Response::builder()
                                            .status(201)
                                            .body(http_body_util::Full::new(bytes::Bytes::new()))
                                            .unwrap(),
                                    )
                                }
                            });
                            let _ = hyper::server::conn::http1::Builder::new()
                                .serve_connection(io, service)
                                .await;
                        });
                    }
                }
            }
        });
        FakeBlobServer {
            url,
            authorizations,
            _shutdown: shutdown_tx,
        }
    }

    fn oidc_config(cloud_url: &str, token: &str) -> CloudWsConfig {
        CloudWsConfig {
            cloud_url: cloud_url.to_string(),
            notebook_id: "nb-1".to_string(),
            scope: "runtime_peer".to_string(),
            auth: CloudAuth::OidcBearer {
                token: token.to_string(),
            },
            workstation: None,
        }
    }

    async fn store_with_blobs(dir: &std::path::Path, count: usize) -> (BlobStore, Vec<String>) {
        let store = BlobStore::new(dir.join("blobs"));
        let mut hashes = Vec::new();
        for i in 0..count {
            hashes.push(
                store
                    .put(format!("blob-{i}").as_bytes(), "text/plain")
                    .await
                    .unwrap(),
            );
        }
        (store, hashes)
    }

    async fn publish(
        publisher: &OutputBlobPublisher,
        store: &BlobStore,
        hash: &str,
    ) -> Result<(), BlobPublishError> {
        let size = store.get(hash).await.unwrap().unwrap().len() as u64;
        publisher
            .publish_artifact(hash.to_string(), size, "text/plain".to_string(), store)
            .await
    }

    #[tokio::test]
    async fn uploads_without_a_refresher_keep_the_static_token() {
        let server = start_fake_blob_server().await;
        let dir = tempfile::tempdir().unwrap();
        let (store, hashes) = store_with_blobs(dir.path(), 1).await;
        let publisher = OutputBlobPublisher::cloud(&oidc_config(&server.url, "static-token"), None);

        publish(&publisher, &store, &hashes[0]).await.unwrap();
        assert_eq!(
            *server.authorizations.lock().unwrap(),
            vec!["Bearer static-token".to_string()]
        );
    }

    #[tokio::test]
    async fn each_upload_asks_the_refresher_for_the_current_token() {
        let server = start_fake_blob_server().await;
        let dir = tempfile::tempdir().unwrap();
        let (store, hashes) = store_with_blobs(dir.path(), 2).await;
        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let refresher: TokenRefresher = Arc::new(move || {
            let n = counter.fetch_add(1, Ordering::SeqCst) + 1;
            Box::pin(async move { Ok(format!("fresh-token-{n}")) })
        });
        let publisher = OutputBlobPublisher::cloud(
            &oidc_config(&server.url, "expired-static-token"),
            Some(refresher),
        );

        publish(&publisher, &store, &hashes[0]).await.unwrap();
        publish(&publisher, &store, &hashes[1]).await.unwrap();
        assert_eq!(
            *server.authorizations.lock().unwrap(),
            vec![
                "Bearer fresh-token-1".to_string(),
                "Bearer fresh-token-2".to_string()
            ]
        );
    }

    #[tokio::test]
    async fn refresher_failure_fails_the_upload_without_sending_a_stale_token() {
        let server = start_fake_blob_server().await;
        let dir = tempfile::tempdir().unwrap();
        let (store, hashes) = store_with_blobs(dir.path(), 1).await;
        let refresher: TokenRefresher = Arc::new(|| {
            Box::pin(async {
                Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "oidc token refresh request failed",
                ))
            })
        });
        let publisher = OutputBlobPublisher::cloud(
            &oidc_config(&server.url, "expired-static-token"),
            Some(refresher),
        );

        let err = publish(&publisher, &store, &hashes[0]).await.unwrap_err();
        assert!(matches!(err, BlobPublishError::Credential { .. }), "{err}");
        // The display text can land in a synced output; it must not carry
        // local refresher details.
        assert!(!err
            .to_string()
            .contains("oidc token refresh request failed"));
        assert!(server.authorizations.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn expired_oidc_cache_refreshes_before_a_blob_upload() {
        use crate::workstation::oidc_refresh::test_support::*;

        let issuer = start_fake_issuer(FakeIssuerConfig::default()).await;
        let server = start_fake_blob_server().await;
        let dir = tempfile::tempdir().unwrap();
        let cache_path = dir.path().join("oidc.json");
        write_expired_cache(&cache_path, &issuer.url, None);
        let refresher = loopback_client(&cache_path, &issuer.url).into_token_refresher();
        let (store, hashes) = store_with_blobs(dir.path(), 1).await;
        let publisher = OutputBlobPublisher::cloud(
            &oidc_config(&server.url, "stale-access-token"),
            Some(refresher),
        );

        publish(&publisher, &store, &hashes[0]).await.unwrap();
        let seen = server.authorizations.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert_ne!(seen[0], "Bearer stale-access-token");
        assert!(seen[0].starts_with("Bearer "));
        assert_eq!(issuer.exchange_count.load(Ordering::SeqCst), 1);
    }
}
