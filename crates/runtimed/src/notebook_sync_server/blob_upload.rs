use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use chrono::{DateTime, Utc};
use notebook_protocol::connection::NotebookFrameType;
use notebook_protocol::protocol::{
    BlobDurability, BlobUploadErrorKind, BlobUploadPart, NotebookRequest, NotebookResponse,
    NotebookResponseEnvelope, PutBlobHeader,
};
use sha2::{Digest, Sha256};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use super::peer_writer::PeerWriter;
use crate::blob_store::BlobStore;

const PUT_BLOB_QUEUE_CAPACITY: usize = 1;
const DEFAULT_MULTIPART_PART_SIZE: u64 = 8 * 1024 * 1024;
const MAX_MULTIPART_PART_SIZE: u64 = 32 * 1024 * 1024;
const MAX_PEER_STAGED_BYTES: u64 = 256 * 1024 * 1024;
const MULTIPART_UPLOAD_TTL: Duration = Duration::from_secs(60 * 60);

#[derive(Clone)]
pub(super) struct MultipartUploadState {
    inner: Arc<Mutex<MultipartUploadRegistry>>,
}

struct MultipartUploadRegistry {
    uploads_root: PathBuf,
    uploads: HashMap<String, UploadSession>,
    staged_bytes: u64,
    budget_bytes: u64,
    ttl: Duration,
}

struct UploadSession {
    upload_id: String,
    media_type: String,
    expected_size: u64,
    expected_sha256: Option<String>,
    part_size: u64,
    expires_at: DateTime<Utc>,
    dir: PathBuf,
    parts: BTreeMap<u32, StagedPart>,
    active_part: bool,
    completing: bool,
}

#[derive(Clone)]
struct StagedPart {
    sha256: String,
    size: u64,
    path: PathBuf,
}

struct CompletionPlan {
    upload_id: String,
    media_type: String,
    expected_size: u64,
    expected_sha256: Option<String>,
    part_paths: Vec<PathBuf>,
    cleanup_dir: PathBuf,
}

impl Drop for MultipartUploadRegistry {
    fn drop(&mut self) {
        for upload in self.uploads.values() {
            std::fs::remove_dir_all(&upload.dir).ok();
        }
    }
}

impl MultipartUploadState {
    pub(super) fn new(blob_store: &BlobStore) -> Self {
        Self::with_options(
            blob_store.root().join("uploads"),
            MAX_PEER_STAGED_BYTES,
            MULTIPART_UPLOAD_TTL,
        )
    }

    fn with_options(uploads_root: PathBuf, budget_bytes: u64, ttl: Duration) -> Self {
        Self {
            inner: Arc::new(Mutex::new(MultipartUploadRegistry {
                uploads_root,
                uploads: HashMap::new(),
                staged_bytes: 0,
                budget_bytes,
                ttl,
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, MultipartUploadRegistry> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn sweep_expired(&self) -> Vec<PathBuf> {
        let now = Utc::now();
        let mut registry = self.lock();
        let expired = registry
            .uploads
            .iter()
            .filter(|(_upload_id, upload)| upload.expires_at <= now)
            .map(|(upload_id, _upload)| upload_id.clone())
            .collect::<Vec<_>>();
        expired
            .into_iter()
            .filter_map(|upload_id| registry.remove_upload(&upload_id).map(|upload| upload.dir))
            .collect()
    }
}

impl MultipartUploadRegistry {
    fn remove_upload(&mut self, upload_id: &str) -> Option<UploadSession> {
        let upload = self.uploads.remove(upload_id)?;
        let upload_bytes = upload.parts.values().map(|part| part.size).sum::<u64>();
        self.staged_bytes = self.staged_bytes.saturating_sub(upload_bytes);
        Some(upload)
    }
}

pub(super) struct PutBlobWorker {
    tx: mpsc::Sender<Vec<u8>>,
    in_flight: Arc<AtomicBool>,
    pub(super) handle: tokio::task::JoinHandle<anyhow::Result<()>>,
}

impl Drop for PutBlobWorker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub(super) fn spawn_put_blob_worker(
    blob_store: Arc<BlobStore>,
    peer_writer: PeerWriter,
    multipart_uploads: MultipartUploadState,
    notebook_id: String,
    peer_id: String,
) -> PutBlobWorker {
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(PUT_BLOB_QUEUE_CAPACITY);
    let in_flight = Arc::new(AtomicBool::new(false));
    let worker_in_flight = in_flight.clone();
    let handle = tokio::spawn(async move {
        while let Some(payload) = rx.recv().await {
            debug!(
                "[notebook-sync] Handling PutBlob peer={} notebook={} payload_bytes={}",
                peer_id,
                notebook_id,
                payload.len()
            );
            let result =
                handle_put_blob_frame(&payload, &blob_store, &peer_writer, &multipart_uploads)
                    .await;
            worker_in_flight.store(false, Ordering::Release);
            result?;
        }
        Ok(())
    });
    PutBlobWorker {
        tx,
        in_flight,
        handle,
    }
}

pub(super) fn enqueue_put_blob(
    worker: &PutBlobWorker,
    peer_writer: &PeerWriter,
    payload: Vec<u8>,
    notebook_id: &str,
    peer_id: &str,
) -> anyhow::Result<()> {
    if worker.in_flight.swap(true, Ordering::AcqRel) {
        send_blob_upload_error(
            peer_writer,
            put_blob_request_id(&payload),
            BlobUploadErrorKind::TooManyInFlight,
        )?;
        return Ok(());
    }

    match worker.tx.try_send(payload) {
        Ok(()) => Ok(()),
        Err(mpsc::error::TrySendError::Full(payload)) => {
            worker.in_flight.store(false, Ordering::Release);
            send_blob_upload_error(
                peer_writer,
                put_blob_request_id(&payload),
                BlobUploadErrorKind::TooManyInFlight,
            )
        }
        Err(mpsc::error::TrySendError::Closed(_payload)) => {
            worker.in_flight.store(false, Ordering::Release);
            anyhow::bail!(
                "PutBlob worker stopped for notebook {} peer {}",
                notebook_id,
                peer_id
            )
        }
    }
}

pub(crate) async fn handle_put_blob_frame(
    payload: &[u8],
    blob_store: &Arc<BlobStore>,
    peer_writer: &PeerWriter,
    multipart_uploads: &MultipartUploadState,
) -> anyhow::Result<()> {
    let (header, body) = match PutBlobHeader::try_parse(payload) {
        Ok(parsed) => parsed,
        Err(error) => {
            send_blob_upload_error(peer_writer, error.id, error.reason)?;
            return Ok(());
        }
    };

    match header {
        PutBlobHeader::Put {
            id,
            media_type,
            size,
            sha256,
            durability,
            purpose,
        } => {
            let durability = durability.unwrap_or(BlobDurability::Durable);
            debug!(
                "[notebook-sync] PutBlob id={} media_type={} size={} durability={:?} purpose={:?}",
                id, media_type, size, durability, purpose
            );
            if body.len() as u64 != size {
                send_blob_upload_error(peer_writer, Some(id), BlobUploadErrorKind::SizeMismatch)?;
                return Ok(());
            }

            let actual_sha256 = hex::encode(Sha256::digest(body));
            if actual_sha256 != sha256 {
                send_blob_upload_error(peer_writer, Some(id), BlobUploadErrorKind::HashMismatch)?;
                return Ok(());
            }

            match blob_store
                .put_with_durability(body, &media_type, durability)
                .await
            {
                Ok(hash) => {
                    send_blob_response(
                        peer_writer,
                        Some(id),
                        NotebookResponse::BlobStored {
                            hash,
                            size,
                            media_type,
                        },
                    )?;
                }
                Err(error) => {
                    warn!("[notebook-sync] PutBlob store failed: {}", error);
                    send_blob_upload_error(
                        peer_writer,
                        Some(id),
                        BlobUploadErrorKind::Io {
                            message: error.to_string(),
                        },
                    )?;
                }
            }
        }
        PutBlobHeader::Part {
            id,
            upload_id,
            part_number,
            size,
            sha256,
        } => {
            debug!(
                "[notebook-sync] PutBlob part id={} upload_id={} part_number={} size={}",
                id, upload_id, part_number, size
            );
            if body.len() as u64 != size {
                send_blob_upload_error(
                    peer_writer,
                    Some(id),
                    BlobUploadErrorKind::PartSizeMismatch,
                )?;
                return Ok(());
            }

            let actual_sha256 = hex::encode(Sha256::digest(body));
            if actual_sha256 != sha256 {
                send_blob_upload_error(
                    peer_writer,
                    Some(id),
                    BlobUploadErrorKind::PartHashMismatch,
                )?;
                return Ok(());
            }

            match begin_part_upload(multipart_uploads, &upload_id, part_number, size, &sha256) {
                PartBegin::Ready { path } => {
                    if let Err(error) = write_staged_part(&path, body).await {
                        warn!("[notebook-sync] PutBlob part write failed: {}", error);
                        if let PartFinish::Error { cleanup_file, .. } = finish_part_upload(
                            multipart_uploads,
                            &upload_id,
                            part_number,
                            size,
                            &sha256,
                            path,
                            false,
                        ) {
                            cleanup_upload_file(cleanup_file).await;
                        }
                        send_blob_upload_error(
                            peer_writer,
                            Some(id),
                            BlobUploadErrorKind::Io {
                                message: error.to_string(),
                            },
                        )?;
                        return Ok(());
                    }

                    match finish_part_upload(
                        multipart_uploads,
                        &upload_id,
                        part_number,
                        size,
                        &sha256,
                        path,
                        true,
                    ) {
                        PartFinish::Stored => {
                            send_blob_response(
                                peer_writer,
                                Some(id),
                                NotebookResponse::BlobPartStored {
                                    upload_id,
                                    part_number,
                                    sha256,
                                },
                            )?;
                        }
                        PartFinish::Error {
                            reason,
                            cleanup_file,
                        } => {
                            cleanup_upload_file(cleanup_file).await;
                            send_blob_upload_error(peer_writer, Some(id), reason)?;
                        }
                    }
                }
                PartBegin::AlreadyStored => {
                    send_blob_response(
                        peer_writer,
                        Some(id),
                        NotebookResponse::BlobPartStored {
                            upload_id,
                            part_number,
                            sha256,
                        },
                    )?;
                }
                PartBegin::Error {
                    reason,
                    cleanup_dir,
                } => {
                    cleanup_upload_dir(cleanup_dir).await;
                    send_blob_upload_error(peer_writer, Some(id), reason)?;
                }
            }
        }
    }

    Ok(())
}

pub(super) async fn maybe_handle_blob_upload_request(
    multipart_uploads: &MultipartUploadState,
    blob_store: &Arc<BlobStore>,
    request: &NotebookRequest,
) -> Option<NotebookResponse> {
    match request {
        NotebookRequest::CreateBlobUpload {
            media_type,
            size,
            sha256,
            part_size,
            purpose,
        } => Some(
            handle_create_blob_upload(
                multipart_uploads,
                media_type.clone(),
                *size,
                sha256.clone(),
                *part_size,
                purpose.clone(),
            )
            .await,
        ),
        NotebookRequest::CompleteBlobUpload { upload_id, parts } => {
            Some(handle_complete_blob_upload(multipart_uploads, blob_store, upload_id, parts).await)
        }
        NotebookRequest::AbortBlobUpload { upload_id } => {
            Some(handle_abort_blob_upload(multipart_uploads, upload_id).await)
        }
        _ => None,
    }
}

enum PartBegin {
    Ready {
        path: PathBuf,
    },
    AlreadyStored,
    Error {
        reason: BlobUploadErrorKind,
        cleanup_dir: Option<PathBuf>,
    },
}

enum PartFinish {
    Stored,
    Error {
        reason: BlobUploadErrorKind,
        cleanup_file: Option<PathBuf>,
    },
}

struct CompletionError {
    reason: BlobUploadErrorKind,
    cleanup_dir: Option<PathBuf>,
}

async fn cleanup_upload_dirs(paths: Vec<PathBuf>) {
    for path in paths {
        tokio::fs::remove_dir_all(path).await.ok();
    }
}

async fn cleanup_upload_dir(path: Option<PathBuf>) {
    if let Some(path) = path {
        tokio::fs::remove_dir_all(path).await.ok();
    }
}

async fn cleanup_upload_file(path: Option<PathBuf>) {
    if let Some(path) = path {
        tokio::fs::remove_file(path).await.ok();
    }
}

async fn handle_create_blob_upload(
    multipart_uploads: &MultipartUploadState,
    media_type: String,
    size: u64,
    sha256: Option<String>,
    part_size: Option<u64>,
    _purpose: Option<String>,
) -> NotebookResponse {
    cleanup_upload_dirs(multipart_uploads.sweep_expired()).await;

    let part_size = part_size.unwrap_or(DEFAULT_MULTIPART_PART_SIZE);
    if part_size == 0 || part_size > MAX_MULTIPART_PART_SIZE {
        return NotebookResponse::BlobUploadError {
            reason: BlobUploadErrorKind::OverCap,
        };
    }
    if size > MAX_PEER_STAGED_BYTES {
        return NotebookResponse::BlobUploadError {
            reason: BlobUploadErrorKind::OverPeerBudget,
        };
    }
    if sha256.as_deref().is_some_and(|hash| !is_sha256_hex(hash)) {
        return NotebookResponse::BlobUploadError {
            reason: BlobUploadErrorKind::FinalHashMismatch,
        };
    }

    let upload_id = uuid::Uuid::new_v4().to_string();
    let (dir, expires_at) = {
        let mut registry = multipart_uploads.lock();
        if !registry.uploads.is_empty()
            || registry.staged_bytes.saturating_add(size) > registry.budget_bytes
        {
            return NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::OverPeerBudget,
            };
        }
        let dir = registry.uploads_root.join(&upload_id);
        let expires_at = Utc::now()
            + chrono::Duration::from_std(registry.ttl)
                .unwrap_or_else(|_| chrono::Duration::hours(1));
        registry.uploads.insert(
            upload_id.clone(),
            UploadSession {
                upload_id: upload_id.clone(),
                media_type,
                expected_size: size,
                expected_sha256: sha256,
                part_size,
                expires_at,
                dir: dir.clone(),
                parts: BTreeMap::new(),
                active_part: false,
                completing: false,
            },
        );
        (dir, expires_at)
    };

    if let Err(error) = tokio::fs::create_dir_all(&dir).await {
        let mut registry = multipart_uploads.lock();
        registry.remove_upload(&upload_id);
        return NotebookResponse::BlobUploadError {
            reason: BlobUploadErrorKind::Io {
                message: error.to_string(),
            },
        };
    }

    NotebookResponse::BlobUploadCreated {
        upload_id,
        part_size,
        expires_at: expires_at.to_rfc3339(),
    }
}

fn begin_part_upload(
    multipart_uploads: &MultipartUploadState,
    upload_id: &str,
    part_number: u32,
    size: u64,
    sha256: &str,
) -> PartBegin {
    let mut registry = multipart_uploads.lock();
    let projected_staged_bytes = registry.staged_bytes.saturating_add(size);
    let budget_bytes = registry.budget_bytes;
    let Some(upload) = registry.uploads.get_mut(upload_id) else {
        return PartBegin::Error {
            reason: BlobUploadErrorKind::UnknownUpload,
            cleanup_dir: None,
        };
    };
    if upload.expires_at <= Utc::now() {
        let dir = registry.remove_upload(upload_id).map(|upload| upload.dir);
        return PartBegin::Error {
            reason: BlobUploadErrorKind::SessionExpired,
            cleanup_dir: dir,
        };
    }
    if upload.active_part || upload.completing {
        return PartBegin::Error {
            reason: BlobUploadErrorKind::OverPeerBudget,
            cleanup_dir: None,
        };
    }
    if size > upload.part_size {
        return PartBegin::Error {
            reason: BlobUploadErrorKind::PartSizeMismatch,
            cleanup_dir: None,
        };
    }
    if let Some(existing) = upload.parts.get(&part_number) {
        if existing.sha256 == sha256 && existing.size == size {
            return PartBegin::AlreadyStored;
        }
        return PartBegin::Error {
            reason: BlobUploadErrorKind::DuplicatePartConflict,
            cleanup_dir: None,
        };
    }
    if projected_staged_bytes > budget_bytes {
        return PartBegin::Error {
            reason: BlobUploadErrorKind::OverPeerBudget,
            cleanup_dir: None,
        };
    }
    upload.active_part = true;
    PartBegin::Ready {
        path: upload.dir.join(format!("{part_number}.part")),
    }
}

fn is_sha256_hex(hash: &str) -> bool {
    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn finish_part_upload(
    multipart_uploads: &MultipartUploadState,
    upload_id: &str,
    part_number: u32,
    size: u64,
    sha256: &str,
    path: PathBuf,
    write_succeeded: bool,
) -> PartFinish {
    let mut registry = multipart_uploads.lock();
    let Some(upload) = registry.uploads.get_mut(upload_id) else {
        return PartFinish::Error {
            reason: BlobUploadErrorKind::UnknownUpload,
            cleanup_file: Some(path),
        };
    };
    upload.active_part = false;
    if !write_succeeded {
        return PartFinish::Stored;
    }
    if let Some(existing) = upload.parts.get(&part_number) {
        if existing.sha256 == sha256 && existing.size == size {
            return PartFinish::Stored;
        }
        return PartFinish::Error {
            reason: BlobUploadErrorKind::DuplicatePartConflict,
            cleanup_file: Some(path),
        };
    }

    upload.parts.insert(
        part_number,
        StagedPart {
            sha256: sha256.to_string(),
            size,
            path,
        },
    );
    registry.staged_bytes = registry.staged_bytes.saturating_add(size);
    PartFinish::Stored
}

async fn write_staged_part(path: &PathBuf, body: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let tmp_path = path.with_extension(format!("tmp.{}", uuid::Uuid::new_v4()));
    match async {
        tokio::fs::write(&tmp_path, body).await?;
        tokio::fs::rename(&tmp_path, path).await
    }
    .await
    {
        Ok(()) => Ok(()),
        Err(error) => {
            tokio::fs::remove_file(&tmp_path).await.ok();
            Err(error)
        }
    }
}

async fn handle_complete_blob_upload(
    multipart_uploads: &MultipartUploadState,
    blob_store: &Arc<BlobStore>,
    upload_id: &str,
    parts: &[BlobUploadPart],
) -> NotebookResponse {
    cleanup_upload_dirs(multipart_uploads.sweep_expired()).await;
    let mut plan = match prepare_completion(multipart_uploads, upload_id, parts) {
        Ok(plan) => plan,
        Err(error) => {
            cleanup_upload_dir(error.cleanup_dir).await;
            return NotebookResponse::BlobUploadError {
                reason: error.reason,
            };
        }
    };

    let final_hash = match plan.expected_sha256.take() {
        Some(hash) => hash,
        None => match hash_part_files(&plan.part_paths).await {
            Ok((hash, size)) if size == plan.expected_size => hash,
            Ok((_hash, _size)) => {
                clear_completing(multipart_uploads, &plan.upload_id);
                return NotebookResponse::BlobUploadError {
                    reason: BlobUploadErrorKind::ManifestMismatch,
                };
            }
            Err(error) => {
                clear_completing(multipart_uploads, &plan.upload_id);
                return NotebookResponse::BlobUploadError {
                    reason: BlobUploadErrorKind::Io {
                        message: error.to_string(),
                    },
                };
            }
        },
    };

    match blob_store
        .put_part_files_with_hash(
            &plan.part_paths,
            &plan.media_type,
            plan.expected_size,
            &final_hash,
            BlobDurability::Durable,
        )
        .await
    {
        Ok(hash) => {
            finish_completion(multipart_uploads, &plan.upload_id);
            tokio::fs::remove_dir_all(&plan.cleanup_dir).await.ok();
            NotebookResponse::BlobStored {
                hash,
                size: plan.expected_size,
                media_type: plan.media_type,
            }
        }
        Err(error) => {
            clear_completing(multipart_uploads, &plan.upload_id);
            let message = error.to_string();
            let reason = if message.contains("final hash mismatch") {
                BlobUploadErrorKind::FinalHashMismatch
            } else if message.contains("final size mismatch") {
                BlobUploadErrorKind::ManifestMismatch
            } else {
                BlobUploadErrorKind::Io { message }
            };
            NotebookResponse::BlobUploadError { reason }
        }
    }
}

fn prepare_completion(
    multipart_uploads: &MultipartUploadState,
    upload_id: &str,
    manifest: &[BlobUploadPart],
) -> Result<CompletionPlan, CompletionError> {
    let mut registry = multipart_uploads.lock();
    let Some(upload) = registry.uploads.get_mut(upload_id) else {
        return Err(CompletionError {
            reason: BlobUploadErrorKind::UnknownUpload,
            cleanup_dir: None,
        });
    };
    if upload.expires_at <= Utc::now() {
        let dir = registry.remove_upload(upload_id).map(|upload| upload.dir);
        return Err(CompletionError {
            reason: BlobUploadErrorKind::SessionExpired,
            cleanup_dir: dir,
        });
    }
    if upload.active_part || upload.completing {
        return Err(CompletionError {
            reason: BlobUploadErrorKind::OverPeerBudget,
            cleanup_dir: None,
        });
    }

    let mut seen = BTreeSet::new();
    let mut total_size = 0_u64;
    let mut part_paths = Vec::with_capacity(manifest.len());
    for manifest_part in manifest {
        if !seen.insert(manifest_part.part_number) {
            return Err(CompletionError {
                reason: BlobUploadErrorKind::ManifestMismatch,
                cleanup_dir: None,
            });
        }
        let Some(staged) = upload.parts.get(&manifest_part.part_number) else {
            return Err(CompletionError {
                reason: BlobUploadErrorKind::ManifestMismatch,
                cleanup_dir: None,
            });
        };
        if staged.sha256 != manifest_part.sha256 || staged.size != manifest_part.size {
            return Err(CompletionError {
                reason: BlobUploadErrorKind::ManifestMismatch,
                cleanup_dir: None,
            });
        }
        total_size = total_size.checked_add(staged.size).ok_or(CompletionError {
            reason: BlobUploadErrorKind::ManifestMismatch,
            cleanup_dir: None,
        })?;
        part_paths.push(staged.path.clone());
    }
    if total_size != upload.expected_size {
        return Err(CompletionError {
            reason: BlobUploadErrorKind::ManifestMismatch,
            cleanup_dir: None,
        });
    }
    if upload.parts.len() != manifest.len() {
        return Err(CompletionError {
            reason: BlobUploadErrorKind::ManifestMismatch,
            cleanup_dir: None,
        });
    }

    upload.completing = true;
    Ok(CompletionPlan {
        upload_id: upload.upload_id.clone(),
        media_type: upload.media_type.clone(),
        expected_size: upload.expected_size,
        expected_sha256: upload.expected_sha256.clone(),
        part_paths,
        cleanup_dir: upload.dir.clone(),
    })
}

fn finish_completion(multipart_uploads: &MultipartUploadState, upload_id: &str) {
    let mut registry = multipart_uploads.lock();
    registry.remove_upload(upload_id);
}

fn clear_completing(multipart_uploads: &MultipartUploadState, upload_id: &str) {
    let mut registry = multipart_uploads.lock();
    if let Some(upload) = registry.uploads.get_mut(upload_id) {
        upload.completing = false;
    }
}

async fn hash_part_files(paths: &[PathBuf]) -> std::io::Result<(String, u64)> {
    let mut hasher = Sha256::new();
    let mut total_size = 0_u64;
    let mut buf = vec![0_u8; 64 * 1024];
    for path in paths {
        let mut file = tokio::fs::File::open(path).await?;
        loop {
            let read = file.read(&mut buf).await?;
            if read == 0 {
                break;
            }
            total_size = total_size.checked_add(read as u64).ok_or_else(|| {
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "multipart blob size overflow",
                )
            })?;
            hasher.update(&buf[..read]);
        }
    }
    Ok((hex::encode(hasher.finalize()), total_size))
}

async fn handle_abort_blob_upload(
    multipart_uploads: &MultipartUploadState,
    upload_id: &str,
) -> NotebookResponse {
    cleanup_upload_dirs(multipart_uploads.sweep_expired()).await;
    let dir = {
        let mut registry = multipart_uploads.lock();
        match registry.remove_upload(upload_id) {
            Some(upload) => upload.dir,
            None => {
                return NotebookResponse::BlobUploadError {
                    reason: BlobUploadErrorKind::UnknownUpload,
                };
            }
        }
    };
    tokio::fs::remove_dir_all(dir).await.ok();
    NotebookResponse::BlobUploadAborted {
        upload_id: upload_id.to_string(),
    }
}

fn send_blob_upload_error(
    peer_writer: &PeerWriter,
    id: Option<String>,
    reason: BlobUploadErrorKind,
) -> anyhow::Result<()> {
    send_blob_response(
        peer_writer,
        id,
        NotebookResponse::BlobUploadError { reason },
    )
}

fn put_blob_request_id(payload: &[u8]) -> Option<String> {
    match PutBlobHeader::try_parse(payload) {
        Ok((header, _body)) => Some(header.id().to_string()),
        Err(error) => error.id,
    }
}

#[cfg(test)]
impl PutBlobWorker {
    fn for_test_busy(tx: mpsc::Sender<Vec<u8>>) -> Self {
        Self {
            tx,
            in_flight: Arc::new(AtomicBool::new(true)),
            handle: tokio::spawn(std::future::pending::<anyhow::Result<()>>()),
        }
    }
}

fn send_blob_response(
    peer_writer: &PeerWriter,
    id: Option<String>,
    response: NotebookResponse,
) -> anyhow::Result<()> {
    peer_writer.send_json(
        NotebookFrameType::Response,
        &NotebookResponseEnvelope { id, response },
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use notebook_protocol::connection;
    use notebook_protocol::protocol::{NotebookResponse, NotebookResponseEnvelope};

    fn payload(id: &str, media_type: &str, size: u64, sha256: &str, body: &[u8]) -> Vec<u8> {
        payload_with_durability(id, media_type, size, sha256, body, None)
    }

    fn payload_with_durability(
        id: &str,
        media_type: &str,
        size: u64,
        sha256: &str,
        body: &[u8],
        durability: Option<BlobDurability>,
    ) -> Vec<u8> {
        let header = serde_json::json!({
            "op": "put",
            "id": id,
            "media_type": media_type,
            "size": size,
            "sha256": sha256,
            "durability": durability,
        });
        let header_bytes = serde_json::to_vec(&header).expect("header serializes");
        let mut payload = Vec::new();
        payload.extend_from_slice(&(header_bytes.len() as u32).to_be_bytes());
        payload.extend_from_slice(&header_bytes);
        payload.extend_from_slice(body);
        payload
    }

    fn part_payload(
        id: &str,
        upload_id: &str,
        part_number: u32,
        sha256: &str,
        body: &[u8],
    ) -> Vec<u8> {
        PutBlobHeader::Part {
            id: id.to_string(),
            upload_id: upload_id.to_string(),
            part_number,
            size: body.len() as u64,
            sha256: sha256.to_string(),
        }
        .encode_frame(body)
        .expect("part frame encodes")
    }

    async fn create_upload(
        state: &MultipartUploadState,
        blob_store: &Arc<BlobStore>,
        body: &[u8],
        part_size: Option<u64>,
    ) -> String {
        let response = handle_create_blob_upload(
            state,
            "application/octet-stream".to_string(),
            body.len() as u64,
            Some(hex::encode(Sha256::digest(body))),
            part_size,
            None,
        )
        .await;
        match response {
            NotebookResponse::BlobUploadCreated { upload_id, .. } => {
                assert!(!blob_store.exists(&hex::encode(Sha256::digest(body))));
                upload_id
            }
            other => panic!("unexpected create response: {other:?}"),
        }
    }

    async fn run_part_handler(
        blob_store: &Arc<BlobStore>,
        state: &MultipartUploadState,
        payload: &[u8],
    ) -> NotebookResponseEnvelope {
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, _writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());
        handle_put_blob_frame(payload, blob_store, &peer_writer, state)
            .await
            .expect("part handler succeeds");
        let frame = connection::recv_typed_frame(&mut reader)
            .await
            .expect("frame read succeeds")
            .expect("response frame");
        serde_json::from_slice(&frame.payload).expect("response envelope")
    }

    fn disk_blob_exists(store: &BlobStore, hash: &str) -> bool {
        let shard_dir = store.root().join(&hash[..2]);
        let rest = &hash[2..];
        let blob_path = shard_dir.join(rest);
        let meta_path = shard_dir.join(format!("{rest}.meta"));
        blob_path.exists() && meta_path.exists()
    }

    async fn run_handler(
        payload: &[u8],
    ) -> (
        tempfile::TempDir,
        Arc<BlobStore>,
        NotebookResponseEnvelope,
        super::super::peer_writer::PeerWriterTask,
    ) {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());
        let multipart_uploads = MultipartUploadState::new(&blob_store);

        handle_put_blob_frame(payload, &blob_store, &peer_writer, &multipart_uploads)
            .await
            .expect("handler succeeds");

        let frame = connection::recv_typed_frame(&mut reader)
            .await
            .expect("frame read succeeds")
            .expect("response frame");
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        let envelope = serde_json::from_slice(&frame.payload).expect("response envelope");

        (tmp, blob_store, envelope, writer_task)
    }

    fn staged_bytes(state: &MultipartUploadState) -> u64 {
        state.lock().staged_bytes
    }

    #[tokio::test]
    async fn put_blob_success_stores_blob_and_replies() {
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-1", "application/octet-stream", 3, &sha256, body);

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-1"));
        match envelope.response {
            NotebookResponse::BlobStored {
                hash,
                size,
                media_type,
            } => {
                assert_eq!(hash, sha256);
                assert_eq!(size, 3);
                assert_eq!(media_type, "application/octet-stream");
                assert_eq!(
                    blob_store.get(&hash).await.unwrap().as_deref(),
                    Some(&body[..])
                );
            }
            other => panic!("unexpected response: {other:?}"),
        }
    }

    #[tokio::test]
    async fn put_blob_ephemeral_success_keeps_blob_visible_to_other_store_instances() {
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload_with_durability(
            "blob-ephemeral",
            "application/octet-stream",
            3,
            &sha256,
            body,
            Some(BlobDurability::Ephemeral),
        );

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-ephemeral"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobStored { ref hash, .. } if hash == &sha256
        ));
        assert_eq!(
            blob_store.get(&sha256).await.unwrap().as_deref(),
            Some(&body[..])
        );
        assert!(disk_blob_exists(&blob_store, &sha256));

        let other_store = BlobStore::new(_tmp.path().join("blobs"));
        assert_eq!(
            other_store.get(&sha256).await.unwrap().as_deref(),
            Some(&body[..])
        );
    }

    #[tokio::test]
    async fn put_blob_hash_mismatch_replies_without_storing() {
        let wrong_hash = "0".repeat(64);
        let request_payload = payload("blob-2", "application/octet-stream", 3, &wrong_hash, b"abc");

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-2"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::HashMismatch
            }
        ));
        assert!(blob_store.get(&wrong_hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn put_blob_size_mismatch_replies_without_storing() {
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-3", "application/octet-stream", 4, &sha256, body);

        let (_tmp, blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id.as_deref(), Some("blob-3"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::SizeMismatch
            }
        ));
        assert!(blob_store.get(&sha256).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn put_blob_invalid_header_replies_with_parse_error() {
        let mut request_payload = Vec::new();
        request_payload.extend_from_slice(&64_u32.to_be_bytes());
        request_payload.extend_from_slice(b"{\"op\":\"put\"");

        let (_tmp, _blob_store, envelope, _writer_task) = run_handler(&request_payload).await;

        assert_eq!(envelope.id, None);
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::InvalidHeader
            }
        ));
    }

    #[tokio::test]
    async fn put_blob_repeat_is_idempotent() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, _writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());
        let multipart_uploads = MultipartUploadState::new(&blob_store);
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-repeat", "text/plain", 3, &sha256, body);

        handle_put_blob_frame(
            &request_payload,
            &blob_store,
            &peer_writer,
            &multipart_uploads,
        )
        .await
        .unwrap();
        handle_put_blob_frame(
            &request_payload,
            &blob_store,
            &peer_writer,
            &multipart_uploads,
        )
        .await
        .unwrap();

        for _ in 0..2 {
            let frame = connection::recv_typed_frame(&mut reader)
                .await
                .unwrap()
                .unwrap();
            let envelope: NotebookResponseEnvelope =
                serde_json::from_slice(&frame.payload).unwrap();
            assert_eq!(envelope.id.as_deref(), Some("blob-repeat"));
            assert!(matches!(
                envelope.response,
                NotebookResponse::BlobStored { ref hash, .. } if hash == &sha256
            ));
        }
        assert_eq!(
            blob_store.get(&sha256).await.unwrap().as_deref(),
            Some(&body[..])
        );
    }

    #[tokio::test]
    async fn put_blob_concurrent_two_peers_store_and_reply_independently() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let body_a = b"peer-a";
        let hash_a = hex::encode(Sha256::digest(body_a));
        let payload_a = payload("blob-a", "text/plain", body_a.len() as u64, &hash_a, body_a);
        let body_b = b"peer-b";
        let hash_b = hex::encode(Sha256::digest(body_b));
        let payload_b = payload("blob-b", "text/plain", body_b.len() as u64, &hash_b, body_b);

        let (mut reader_a, writer_a) = tokio::io::duplex(1024 * 1024);
        let (peer_writer_a, _task_a) =
            super::super::peer_writer::spawn_peer_writer(writer_a, "notebook".into(), "a".into());
        let (mut reader_b, writer_b) = tokio::io::duplex(1024 * 1024);
        let (peer_writer_b, _task_b) =
            super::super::peer_writer::spawn_peer_writer(writer_b, "notebook".into(), "b".into());
        let multipart_uploads_a = MultipartUploadState::new(&blob_store);
        let multipart_uploads_b = MultipartUploadState::new(&blob_store);

        let (result_a, result_b) = tokio::join!(
            handle_put_blob_frame(
                &payload_a,
                &blob_store,
                &peer_writer_a,
                &multipart_uploads_a
            ),
            handle_put_blob_frame(
                &payload_b,
                &blob_store,
                &peer_writer_b,
                &multipart_uploads_b
            )
        );
        result_a.unwrap();
        result_b.unwrap();

        let frame_a = connection::recv_typed_frame(&mut reader_a)
            .await
            .unwrap()
            .unwrap();
        let envelope_a: NotebookResponseEnvelope =
            serde_json::from_slice(&frame_a.payload).unwrap();
        let frame_b = connection::recv_typed_frame(&mut reader_b)
            .await
            .unwrap()
            .unwrap();
        let envelope_b: NotebookResponseEnvelope =
            serde_json::from_slice(&frame_b.payload).unwrap();

        assert_eq!(envelope_a.id.as_deref(), Some("blob-a"));
        assert!(matches!(
            envelope_a.response,
            NotebookResponse::BlobStored { ref hash, .. } if hash == &hash_a
        ));
        assert_eq!(envelope_b.id.as_deref(), Some("blob-b"));
        assert!(matches!(
            envelope_b.response,
            NotebookResponse::BlobStored { ref hash, .. } if hash == &hash_b
        ));
        assert_eq!(
            blob_store.get(&hash_a).await.unwrap().as_deref(),
            Some(&body_a[..])
        );
        assert_eq!(
            blob_store.get(&hash_b).await.unwrap().as_deref(),
            Some(&body_b[..])
        );
    }

    #[tokio::test]
    async fn put_blob_busy_worker_replies_without_blocking_peer_loop() {
        let (worker_tx, _worker_rx) = mpsc::channel(PUT_BLOB_QUEUE_CAPACITY);
        let worker = PutBlobWorker::for_test_busy(worker_tx);
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, _writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());
        let body = b"abc";
        let sha256 = hex::encode(Sha256::digest(body));
        let request_payload = payload("blob-busy", "text/plain", body.len() as u64, &sha256, body);

        let start = std::time::Instant::now();
        enqueue_put_blob(&worker, &peer_writer, request_payload, "notebook", "peer")
            .expect("busy worker should report a structured response");
        assert!(
            start.elapsed() < std::time::Duration::from_millis(50),
            "busy worker should not block the peer loop"
        );

        let frame = connection::recv_typed_frame(&mut reader)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        let envelope: NotebookResponseEnvelope = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(envelope.id.as_deref(), Some("blob-busy"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::TooManyInFlight
            }
        ));
    }

    #[tokio::test]
    async fn put_blob_busy_worker_replies_to_multipart_part_without_blocking_peer_loop() {
        let (worker_tx, _worker_rx) = mpsc::channel(PUT_BLOB_QUEUE_CAPACITY);
        let worker = PutBlobWorker::for_test_busy(worker_tx);
        let (mut reader, writer) = tokio::io::duplex(1024 * 1024);
        let (peer_writer, _writer_task) =
            super::super::peer_writer::spawn_peer_writer(writer, "notebook".into(), "peer".into());
        let sha256 = hex::encode(Sha256::digest(b"abc"));
        let request_payload = part_payload("part-busy", "upload-busy", 1, &sha256, b"abc");

        let start = std::time::Instant::now();
        enqueue_put_blob(&worker, &peer_writer, request_payload, "notebook", "peer")
            .expect("busy worker should report a structured response");
        assert!(
            start.elapsed() < std::time::Duration::from_millis(50),
            "busy multipart worker should not block the peer loop"
        );

        let frame = connection::recv_typed_frame(&mut reader)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(frame.frame_type, NotebookFrameType::Response);
        let envelope: NotebookResponseEnvelope = serde_json::from_slice(&frame.payload).unwrap();
        assert_eq!(envelope.id.as_deref(), Some("part-busy"));
        assert!(matches!(
            envelope.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::TooManyInFlight
            }
        ));
    }

    #[tokio::test]
    async fn multipart_upload_success_publishes_only_on_complete() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let state = MultipartUploadState::new(&blob_store);
        let body = b"abcdef";
        let final_hash = hex::encode(Sha256::digest(body));
        let upload_id = create_upload(&state, &blob_store, body, Some(3)).await;

        let first_hash = hex::encode(Sha256::digest(b"abc"));
        let first = part_payload("part-1", &upload_id, 1, &first_hash, b"abc");
        let first_response = run_part_handler(&blob_store, &state, &first).await;
        assert!(matches!(
            first_response.response,
            NotebookResponse::BlobPartStored { part_number: 1, .. }
        ));
        assert_eq!(staged_bytes(&state), 3);
        assert!(!blob_store.exists(&final_hash));

        let second_hash = hex::encode(Sha256::digest(b"def"));
        let second = part_payload("part-2", &upload_id, 2, &second_hash, b"def");
        let second_response = run_part_handler(&blob_store, &state, &second).await;
        assert!(matches!(
            second_response.response,
            NotebookResponse::BlobPartStored { part_number: 2, .. }
        ));
        assert_eq!(staged_bytes(&state), 6);

        let response = handle_complete_blob_upload(
            &state,
            &blob_store,
            &upload_id,
            &[
                BlobUploadPart {
                    part_number: 1,
                    sha256: first_hash,
                    size: 3,
                },
                BlobUploadPart {
                    part_number: 2,
                    sha256: second_hash,
                    size: 3,
                },
            ],
        )
        .await;
        match response {
            NotebookResponse::BlobStored { hash, size, .. } => {
                assert_eq!(hash, final_hash);
                assert_eq!(size, 6);
                assert_eq!(
                    blob_store.get(&hash).await.unwrap().as_deref(),
                    Some(&body[..])
                );
            }
            other => panic!("unexpected complete response: {other:?}"),
        }
        assert_eq!(staged_bytes(&state), 0);
    }

    #[tokio::test]
    async fn multipart_part_reput_is_idempotent_but_conflict_is_rejected() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let state = MultipartUploadState::new(&blob_store);
        let upload_id = create_upload(&state, &blob_store, b"abc", Some(3)).await;
        let sha256 = hex::encode(Sha256::digest(b"abc"));
        let request = part_payload("part-1", &upload_id, 1, &sha256, b"abc");

        let first = run_part_handler(&blob_store, &state, &request).await;
        let second = run_part_handler(&blob_store, &state, &request).await;
        assert!(matches!(
            first.response,
            NotebookResponse::BlobPartStored { part_number: 1, .. }
        ));
        assert!(matches!(
            second.response,
            NotebookResponse::BlobPartStored { part_number: 1, .. }
        ));

        let conflict_hash = hex::encode(Sha256::digest(b"abd"));
        let conflict = part_payload("part-conflict", &upload_id, 1, &conflict_hash, b"abd");
        let conflict_response = run_part_handler(&blob_store, &state, &conflict).await;
        assert!(matches!(
            conflict_response.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::DuplicatePartConflict
            }
        ));
    }

    #[tokio::test]
    async fn multipart_complete_rejects_manifest_mismatch_without_publishing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let state = MultipartUploadState::new(&blob_store);
        let body = b"abcdef";
        let final_hash = hex::encode(Sha256::digest(body));
        let upload_id = create_upload(&state, &blob_store, body, Some(3)).await;
        let first_hash = hex::encode(Sha256::digest(b"abc"));
        let first = part_payload("part-1", &upload_id, 1, &first_hash, b"abc");
        run_part_handler(&blob_store, &state, &first).await;

        let response = handle_complete_blob_upload(
            &state,
            &blob_store,
            &upload_id,
            &[BlobUploadPart {
                part_number: 1,
                sha256: first_hash,
                size: 3,
            }],
        )
        .await;
        assert!(matches!(
            response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::ManifestMismatch
            }
        ));
        assert!(!blob_store.exists(&final_hash));
    }

    #[tokio::test]
    async fn multipart_complete_rejects_final_hash_mismatch_without_publishing() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let state = MultipartUploadState::new(&blob_store);
        let body = b"abc";
        let actual_hash = hex::encode(Sha256::digest(body));
        let wrong_final_hash = "0".repeat(64);
        let response = handle_create_blob_upload(
            &state,
            "application/octet-stream".to_string(),
            body.len() as u64,
            Some(wrong_final_hash.clone()),
            Some(3),
            None,
        )
        .await;
        let upload_id = match response {
            NotebookResponse::BlobUploadCreated { upload_id, .. } => upload_id,
            other => panic!("unexpected create response: {other:?}"),
        };

        let part = part_payload("part-1", &upload_id, 1, &actual_hash, body);
        run_part_handler(&blob_store, &state, &part).await;
        let response = handle_complete_blob_upload(
            &state,
            &blob_store,
            &upload_id,
            &[BlobUploadPart {
                part_number: 1,
                sha256: actual_hash.clone(),
                size: 3,
            }],
        )
        .await;
        assert!(matches!(
            response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::FinalHashMismatch
            }
        ));
        assert!(!blob_store.exists(&actual_hash));
        assert!(!blob_store.exists(&wrong_final_hash));
    }

    #[tokio::test]
    async fn multipart_abort_removes_upload_and_later_parts_are_unknown() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let state = MultipartUploadState::new(&blob_store);
        let upload_id = create_upload(&state, &blob_store, b"abc", Some(3)).await;
        let sha256 = hex::encode(Sha256::digest(b"abc"));
        let request = part_payload("part-before-abort", &upload_id, 1, &sha256, b"abc");
        let response = run_part_handler(&blob_store, &state, &request).await;
        assert!(matches!(
            response.response,
            NotebookResponse::BlobPartStored { part_number: 1, .. }
        ));
        assert_eq!(staged_bytes(&state), 3);

        let abort = handle_abort_blob_upload(&state, &upload_id).await;
        assert!(matches!(
            abort,
            NotebookResponse::BlobUploadAborted { upload_id: ref id } if id == &upload_id
        ));
        assert_eq!(staged_bytes(&state), 0);

        let request = part_payload("part-after-abort", &upload_id, 1, &sha256, b"abc");
        let response = run_part_handler(&blob_store, &state, &request).await;
        assert!(matches!(
            response.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::UnknownUpload
            }
        ));
    }

    #[tokio::test]
    async fn multipart_upload_ids_are_peer_scoped() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let peer_a = MultipartUploadState::new(&blob_store);
        let peer_b = MultipartUploadState::new(&blob_store);
        let upload_id = create_upload(&peer_a, &blob_store, b"abc", Some(3)).await;

        let sha256 = hex::encode(Sha256::digest(b"abc"));
        let request = part_payload("part-cross-peer", &upload_id, 1, &sha256, b"abc");
        let response = run_part_handler(&blob_store, &peer_b, &request).await;
        assert!(matches!(
            response.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::UnknownUpload
            }
        ));
    }

    #[tokio::test]
    async fn multipart_budget_and_expiry_are_enforced() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let blob_store = Arc::new(BlobStore::new(tmp.path().join("blobs")));
        let small_budget = MultipartUploadState::with_options(
            tmp.path().join("budget-uploads"),
            2,
            MULTIPART_UPLOAD_TTL,
        );
        let over_budget = handle_create_blob_upload(
            &small_budget,
            "application/octet-stream".to_string(),
            3,
            Some(hex::encode(Sha256::digest(b"abc"))),
            Some(3),
            None,
        )
        .await;
        assert!(matches!(
            over_budget,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::OverPeerBudget
            }
        ));

        let expired = MultipartUploadState::with_options(
            tmp.path().join("expired-uploads"),
            MAX_PEER_STAGED_BYTES,
            Duration::ZERO,
        );
        let upload_id = create_upload(&expired, &blob_store, b"abc", Some(3)).await;
        let sha256 = hex::encode(Sha256::digest(b"abc"));
        let request = part_payload("part-expired", &upload_id, 1, &sha256, b"abc");
        let response = run_part_handler(&blob_store, &expired, &request).await;
        assert!(matches!(
            response.response,
            NotebookResponse::BlobUploadError {
                reason: BlobUploadErrorKind::SessionExpired
            }
        ));
    }
}
