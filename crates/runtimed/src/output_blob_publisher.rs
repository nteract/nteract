//! Optional remote publishing for blobs referenced by output manifests.
//!
//! Desktop/local kernels only need the local [`BlobStore`]. A cloud runtime
//! peer also has to make those same content-addressed bytes available through
//! preview's blob API before RuntimeStateDoc advertises the hash to browsers.

use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;

use notebook_cloud_transport::{CloudAuth, CloudWsConfig};
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

    pub(crate) fn cloud(config: &CloudWsConfig) -> Self {
        Self {
            cloud: Some(Arc::new(CloudBlobPublisher::new(config))),
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

        for blob in manifest.blob_refs() {
            cloud.publish_blob(blob, blob_store).await?;
        }
        Ok(())
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
    uploaded: Mutex<HashSet<String>>,
}

impl CloudBlobPublisher {
    fn new(config: &CloudWsConfig) -> Self {
        Self {
            client: reqwest::Client::new(),
            cloud_url: config.cloud_url.trim_end_matches('/').to_string(),
            notebook_id: config.notebook_id.clone(),
            scope: config.scope.clone(),
            auth: config.auth.clone(),
            uploaded: Mutex::new(HashSet::new()),
        }
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
        let url = blob_upload_url(&self.cloud_url, &self.notebook_id, &blob.hash);
        let mut request = self
            .client
            .put(url)
            .header("X-Scope", &self.scope)
            .header("X-Operator", "agent:runt:blob-publisher")
            .header("Content-Type", &blob.media_type)
            .body(bytes);
        request = apply_auth_headers(request, &self.auth);

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
    #[error("failed to upload blob {hash}: {message}")]
    RemoteRequest { hash: String, message: String },
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
            Self::MissingLocalBlob { .. } | Self::LocalRead { .. } | Self::SizeMismatch { .. } => {
                false
            }
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
    }
}
