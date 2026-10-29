//! Content-addressed blob store for notebook outputs.
//!
//! Stores blobs (images, HTML, rich data) on disk at a configurable root
//! directory. Each blob is identified by its SHA-256 hash (hex-encoded) and
//! stored in a two-level shard directory:
//!
//! ```text
//! <root>/
//!   a1/
//!     b2c3d4...       # raw bytes
//!     b2c3d4....meta  # JSON metadata sidecar
//! ```
//!
//! All writes are atomic: data is written to a temp file in the shard
//! directory and renamed into place, so readers never see partial writes.

use std::collections::{BTreeMap, HashMap, VecDeque};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex, MutexGuard,
};
use std::time::{Duration, Instant};

use bytes::Bytes;
use chrono::{DateTime, Utc};
use notebook_protocol::protocol::BlobDurability;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::time::sleep;
use tracing::debug;

/// Maximum blob size accepted by `put()` (100 MiB).
pub const MAX_BLOB_SIZE: usize = 100 * 1024 * 1024;
/// Maximum bytes retained in the ephemeral in-memory layer (64 MiB).
pub const EPHEMERAL_BLOB_CAP_BYTES: usize = 64 * 1024 * 1024;
const BLOB_FILE_LOCK_RETRY_MS: u64 = 10;
const BLOB_FILE_LOCK_TIMEOUT_SECS: u64 = 10;

// Stable shard inode: never unlink a lock file while another process may hold it.
struct BlobFileLock {
    _file: std::fs::File,
}

/// Metadata stored alongside each blob.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobMeta {
    pub media_type: String,
    pub size: u64,
    pub created_at: DateTime<Utc>,
    #[serde(default = "default_blob_durability")]
    pub durability: BlobDurability,
    /// Explicit producer leases. Legacy/unmanaged ephemeral blobs have none.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    ephemeral_leases: BTreeMap<String, u64>,
}

/// One producer's independent ownership of ephemeral blobs in the shared store.
#[derive(Clone, Debug)]
pub(crate) struct EphemeralBlobOwner {
    id: String,
    generation: Arc<AtomicU64>,
}

impl Default for EphemeralBlobOwner {
    fn default() -> Self {
        Self {
            id: uuid::Uuid::new_v4().to_string(),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }
}

impl EphemeralBlobOwner {
    pub(crate) fn next_lease(&self) -> EphemeralBlobLease {
        EphemeralBlobLease {
            owner: self.id.clone(),
            generation: self.generation.fetch_add(1, Ordering::Relaxed) + 1,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct EphemeralBlobLease {
    owner: String,
    pub(crate) generation: u64,
}

fn default_blob_durability() -> BlobDurability {
    BlobDurability::Durable
}

fn merged_durability(existing: BlobDurability, incoming: BlobDurability) -> BlobDurability {
    if existing == BlobDurability::Durable || incoming == BlobDurability::Durable {
        BlobDurability::Durable
    } else {
        BlobDurability::Ephemeral
    }
}

#[derive(Debug)]
struct BlobStoreInner {
    root: PathBuf,
    memory_cap: usize,
    memory: Mutex<MemoryLayer>,
}

/// In-memory blob cache layered on top of the on-disk store.
///
/// Eviction is **insertion-order FIFO**, not LRU. `get` does not refresh
/// recency; `evict_to_cap` pops from the front of the insertion order. A
/// frequently-read durable blob inserted early still falls out first when
/// the cap is exceeded. Tests and comments that reference "LRU" predate
/// the FIFO semantics — the algorithm has always been FIFO. Punchlist BS-8.
#[derive(Debug)]
struct MemoryLayer {
    entries: HashMap<String, MemoryEntry>,
    order: VecDeque<(String, u64)>,
    total_bytes: usize,
    cap: usize,
    next_seq: u64,
}

#[derive(Debug, Clone)]
struct MemoryEntry {
    data: Bytes,
    media_type: String,
    created_at: DateTime<Utc>,
    durability: BlobDurability,
    seq: u64,
}

impl MemoryEntry {
    fn meta(&self) -> BlobMeta {
        BlobMeta {
            media_type: self.media_type.clone(),
            size: self.data.len() as u64,
            created_at: self.created_at,
            durability: self.durability,
            ephemeral_leases: BTreeMap::new(),
        }
    }
}

impl MemoryLayer {
    fn new(cap: usize) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            total_bytes: 0,
            cap,
            next_seq: 0,
        }
    }

    fn insert(
        &mut self,
        hash: String,
        data: Bytes,
        media_type: String,
        created_at: DateTime<Utc>,
        durability: BlobDurability,
    ) {
        if data.len() > self.cap {
            return;
        }

        let durability = match self.entries.remove(&hash) {
            Some(existing) => {
                self.total_bytes = self.total_bytes.saturating_sub(existing.data.len());
                if existing.durability == BlobDurability::Durable
                    || durability == BlobDurability::Durable
                {
                    BlobDurability::Durable
                } else {
                    BlobDurability::Ephemeral
                }
            }
            None => durability,
        };

        // Re-putting the same content leaves a stale order entry behind. The
        // sequence check in eviction skips those stale entries without scanning.
        let seq = self.next_seq;
        self.next_seq = self.next_seq.wrapping_add(1);
        self.total_bytes += data.len();
        self.order.push_back((hash.clone(), seq));
        self.entries.insert(
            hash,
            MemoryEntry {
                data,
                media_type,
                created_at,
                durability,
                seq,
            },
        );

        self.evict_to_cap();
    }

    fn get(&self, hash: &str) -> Option<MemoryEntry> {
        self.entries.get(hash).cloned()
    }

    fn contains(&self, hash: &str) -> bool {
        self.entries.contains_key(hash)
    }

    fn remove(&mut self, hash: &str) -> bool {
        if let Some(entry) = self.entries.remove(hash) {
            self.total_bytes = self.total_bytes.saturating_sub(entry.data.len());
            true
        } else {
            false
        }
    }

    fn evict_to_cap(&mut self) {
        while self.total_bytes > self.cap {
            let Some((hash, seq)) = self.order.pop_front() else {
                break;
            };
            let should_remove = self
                .entries
                .get(&hash)
                .is_some_and(|entry| entry.seq == seq);
            if should_remove {
                if let Some(entry) = self.entries.remove(&hash) {
                    debug!(
                        blob = %hash,
                        bytes = entry.data.len(),
                        "evicted blob from ephemeral memory layer"
                    );
                    self.total_bytes = self.total_bytes.saturating_sub(entry.data.len());
                }
            }
        }
    }
}

/// Content-addressed blob store with durable disk storage and an ephemeral
/// in-memory layer for transient widget buffers.
#[derive(Debug, Clone)]
pub struct BlobStore {
    inner: Arc<BlobStoreInner>,
}

/// Streaming reader for a single blob.
///
/// Either an already-buffered `Bytes` (hot in the memory layer) or an open
/// `tokio::fs::File` waiting to stream from disk. Carries the byte length so
/// callers can stamp `Content-Length` without a second metadata fetch.
#[derive(Debug)]
pub enum BlobReader {
    /// Blob was hot in the memory layer; no disk read required.
    InMemory { bytes: Bytes, size: u64 },
    /// Blob lives on disk only; an open `File` is ready to be streamed.
    Disk { file: tokio::fs::File, size: u64 },
}

impl BlobReader {
    /// Byte length of the blob, suitable for the `Content-Length` header.
    pub fn size(&self) -> u64 {
        match self {
            BlobReader::InMemory { size, .. } | BlobReader::Disk { size, .. } => *size,
        }
    }
}

impl BlobStore {
    /// Create a new BlobStore rooted at `root`.
    ///
    /// The directory is created lazily on first `put()`.
    pub fn new(root: PathBuf) -> Self {
        Self::with_ephemeral_cap(root, EPHEMERAL_BLOB_CAP_BYTES)
    }

    /// Create a `BlobStore` with an explicit in-memory cap.
    ///
    /// `BlobStore::new` uses the production default
    /// [`EPHEMERAL_BLOB_CAP_BYTES`] (64 MiB). Tests that need to force the
    /// disk-streaming path (BS-1 punchlist) construct the store with a small
    /// cap so payloads above the cap spill to disk.
    pub fn with_ephemeral_cap(root: PathBuf, cap: usize) -> Self {
        Self {
            inner: Arc::new(BlobStoreInner {
                root,
                memory_cap: cap,
                memory: Mutex::new(MemoryLayer::new(cap)),
            }),
        }
    }

    /// Get the root directory of this blob store.
    pub fn root(&self) -> &Path {
        &self.inner.root
    }

    /// Store `data` with the given `media_type`.
    ///
    /// Returns the SHA-256 hex hash of the raw bytes.
    /// Rejects data larger than 100 MiB.
    /// Idempotent: if the blob already exists, returns the hash without writing.
    ///
    /// Concurrent puts of identical content are safe: if another writer places
    /// the blob or metadata first (e.g. `rename` fails with `AlreadyExists` on
    /// Windows), we detect the existing file and return `Ok(hash)`.
    pub async fn put(&self, data: &[u8], media_type: &str) -> io::Result<String> {
        self.put_with_durability(data, media_type, BlobDurability::Durable)
            .await
    }

    /// Store `data` with an explicit durability hint.
    ///
    /// `Durable` writes through to disk and primes the in-memory layer.
    /// `Ephemeral` is also written to disk because runtime agents run in a
    /// separate process and must be able to rehydrate frontend-uploaded comm
    /// buffers by hash. The durability metadata keeps those disk records
    /// eligible for `delete_if_ephemeral` once superseded.
    pub async fn put_with_durability(
        &self,
        data: &[u8],
        media_type: &str,
        durability: BlobDurability,
    ) -> io::Result<String> {
        self.put_with_lease(data, media_type, durability, None)
            .await
    }

    /// Acquire a producer lease in the same file-lock transaction as the write.
    /// Other producers must release their own leases before eager deletion.
    pub(crate) async fn put_leased_ephemeral(
        &self,
        data: &[u8],
        media_type: &str,
        lease: &EphemeralBlobLease,
    ) -> io::Result<String> {
        self.put_with_lease(data, media_type, BlobDurability::Ephemeral, Some(lease))
            .await
    }

    async fn put_with_lease(
        &self,
        data: &[u8],
        media_type: &str,
        durability: BlobDurability,
        lease: Option<&EphemeralBlobLease>,
    ) -> io::Result<String> {
        if data.len() > MAX_BLOB_SIZE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!(
                    "blob too large: {} bytes (max {})",
                    data.len(),
                    MAX_BLOB_SIZE
                ),
            ));
        }

        let hash = hex::encode(Sha256::digest(data));
        let created_at = Utc::now();

        match durability {
            BlobDurability::Durable => {
                let effective_durability = self
                    .put_disk(&hash, data, media_type, BlobDurability::Durable, None)
                    .await?;
                self.insert_memory(
                    &hash,
                    Bytes::copy_from_slice(data),
                    media_type,
                    created_at,
                    effective_durability,
                );
                Ok(hash)
            }
            BlobDurability::Ephemeral => {
                let effective_durability = self
                    .put_disk(&hash, data, media_type, BlobDurability::Ephemeral, lease)
                    .await?;
                if data.len() > self.memory_cap() {
                    // A single entry larger than the cap can never be cached
                    // without violating the budget, so leave it as disk-only
                    // ephemeral content until supersession or sweep cleanup.
                    debug!(
                        blob = %hash,
                        bytes = data.len(),
                        cap = self.memory_cap(),
                        "ephemeral blob exceeds memory cap; keeping disk-only"
                    );
                } else {
                    self.insert_memory(
                        &hash,
                        Bytes::copy_from_slice(data),
                        media_type,
                        created_at,
                        effective_durability,
                    );
                }
                Ok(hash)
            }
        }
    }

    async fn put_disk(
        &self,
        hash: &str,
        data: &[u8],
        media_type: &str,
        durability: BlobDurability,
        lease: Option<&EphemeralBlobLease>,
    ) -> io::Result<BlobDurability> {
        let (shard_dir, blob_path, meta_path) = self.paths(hash);
        let _lock = self.acquire_blob_file_lock(&shard_dir, &meta_path).await?;
        // Timestamp the actual write, after any lock wait, so a mark pass that
        // ran during the wait cannot sweep the new upload with zero grace.
        let created_at = Utc::now();
        // Fast path: both files already present.
        // If the caller provides a different media_type than what's stored,
        // update the metadata sidecar (e.g., blob was first stored as
        // application/json but is now text/javascript for anywidget _esm).
        if meta_path.exists() {
            // Fail closed on unreadable metadata: discarding another producer's
            // lease would turn a harmless write into a later data-loss hazard.
            let json = tokio::fs::read_to_string(&meta_path).await?;
            let mut meta: BlobMeta = serde_json::from_str(&json).map_err(io::Error::other)?;
            let mixed_ownership = meta.durability == BlobDurability::Ephemeral
                && durability == BlobDurability::Ephemeral
                && (lease.is_some() != !meta.ephemeral_leases.is_empty());
            meta.durability = if mixed_ownership {
                // Unmanaged comm buffers have no release token. On a shared hash
                // keep both producers safe and let ordinary mark-and-sweep own
                // reclamation. Normal leased animation blobs still retire eagerly.
                BlobDurability::Durable
            } else {
                merged_durability(meta.durability, durability)
            };
            meta.media_type = media_type.to_string();
            meta.created_at = created_at;
            if meta.durability == BlobDurability::Durable {
                meta.ephemeral_leases.clear();
            } else if let Some(lease) = lease {
                let generation = meta
                    .ephemeral_leases
                    .entry(lease.owner.clone())
                    .or_default();
                *generation = (*generation).max(lease.generation);
            }
            if !blob_path.exists() {
                let tmp = shard_dir.join(format!(".tmp.{}", uuid::Uuid::new_v4()));
                tokio::fs::write(&tmp, data).await?;
                if let Err(error) = tokio::fs::rename(&tmp, &blob_path).await {
                    tokio::fs::remove_file(&tmp).await.ok();
                    return Err(error);
                }
            }
            self.write_meta(&shard_dir, &meta_path, &meta).await?;
            return Ok(meta.durability);
        }

        // --- Blob ---
        // Write to a temp file and atomically rename into place.
        // On Windows `rename` fails with AlreadyExists when the target exists,
        // so a concurrent put of the same content can race here. Since the hash
        // is derived from the bytes, any existing file with the same name has
        // identical content — we just need to ensure the metadata sidecar exists.
        let we_wrote_blob;
        let tmp_blob = shard_dir.join(format!(".tmp.{}", uuid::Uuid::new_v4()));
        match async {
            tokio::fs::write(&tmp_blob, data).await?;
            tokio::fs::rename(&tmp_blob, &blob_path).await
        }
        .await
        {
            Ok(()) => {
                we_wrote_blob = true;
            }
            Err(e) => {
                tokio::fs::remove_file(&tmp_blob).await.ok();
                if blob_path.exists() {
                    // Concurrent writer placed the blob — proceed to metadata.
                    we_wrote_blob = false;
                } else {
                    return Err(e);
                }
            }
        }

        // --- Metadata sidecar ---
        let meta = BlobMeta {
            media_type: media_type.to_string(),
            size: data.len() as u64,
            created_at,
            durability,
            ephemeral_leases: lease
                .map(|lease| BTreeMap::from([(lease.owner.clone(), lease.generation)]))
                .unwrap_or_default(),
        };
        let meta_json = serde_json::to_string(&meta).map_err(io::Error::other)?;

        let tmp_meta = shard_dir.join(format!(".tmp.{}.meta", uuid::Uuid::new_v4()));
        match async {
            tokio::fs::write(&tmp_meta, meta_json).await?;
            tokio::fs::rename(&tmp_meta, &meta_path).await
        }
        .await
        {
            Ok(()) => {}
            Err(e) => {
                tokio::fs::remove_file(&tmp_meta).await.ok();
                if meta_path.exists() && lease.is_none() {
                    // Concurrent writer placed metadata — done.
                    return Ok(durability);
                }
                // Metadata write truly failed. If *we* created the blob (not a
                // concurrent writer), remove it to avoid leaving orphaned data.
                if we_wrote_blob {
                    tokio::fs::remove_file(&blob_path).await.ok();
                }
                return Err(e);
            }
        }

        Ok(durability)
    }

    /// Store a blob by streaming already-staged part files into the
    /// content-addressed namespace.
    ///
    /// The caller supplies the expected final digest and byte count. The store
    /// re-hashes while copying so a corrupt or mismatched staging manifest never
    /// publishes a partial blob.
    pub async fn put_part_files_with_hash(
        &self,
        parts: &[PathBuf],
        media_type: &str,
        expected_size: u64,
        expected_hash: &str,
        durability: BlobDurability,
    ) -> io::Result<String> {
        if !Self::validate_hash(expected_hash) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "expected multipart blob hash is not a valid sha256 hex digest",
            ));
        }

        let (shard_dir, blob_path, meta_path) = self.paths(expected_hash);
        let _lock = self.acquire_blob_file_lock(&shard_dir, &meta_path).await?;
        let created_at = Utc::now();
        let existing_meta = if meta_path.exists() {
            let json = tokio::fs::read_to_string(&meta_path).await?;
            let mut meta: BlobMeta = serde_json::from_str(&json).map_err(io::Error::other)?;
            meta.durability = if !meta.ephemeral_leases.is_empty() {
                BlobDurability::Durable
            } else {
                merged_durability(meta.durability, durability)
            };
            meta.ephemeral_leases.clear();
            meta.media_type = media_type.to_string();
            meta.created_at = created_at;
            Some(meta)
        } else {
            None
        };
        if blob_path.exists() {
            if let Some(meta) = &existing_meta {
                self.write_meta(&shard_dir, &meta_path, meta).await?;
                return Ok(expected_hash.to_string());
            }
        }

        let tmp_blob = shard_dir.join(format!(".tmp.{}", uuid::Uuid::new_v4()));
        let mut out = tokio::fs::File::create(&tmp_blob).await?;
        let mut hasher = Sha256::new();
        let mut total_size = 0_u64;
        let mut buf = vec![0_u8; 64 * 1024];

        for part_path in parts {
            let mut input = tokio::fs::File::open(part_path).await?;
            loop {
                let read = input.read(&mut buf).await?;
                if read == 0 {
                    break;
                }
                total_size = total_size.checked_add(read as u64).ok_or_else(|| {
                    io::Error::new(io::ErrorKind::InvalidData, "multipart blob size overflow")
                })?;
                hasher.update(&buf[..read]);
                out.write_all(&buf[..read]).await?;
            }
        }
        out.flush().await?;
        out.sync_all().await?;
        drop(out);

        if total_size != expected_size {
            tokio::fs::remove_file(&tmp_blob).await.ok();
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "final size mismatch: got {} bytes, expected {}",
                    total_size, expected_size
                ),
            ));
        }

        let actual_hash = hex::encode(hasher.finalize());
        if actual_hash != expected_hash {
            tokio::fs::remove_file(&tmp_blob).await.ok();
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("final hash mismatch: got {actual_hash}, expected {expected_hash}"),
            ));
        }

        let we_wrote_blob;
        match tokio::fs::rename(&tmp_blob, &blob_path).await {
            Ok(()) => {
                we_wrote_blob = true;
            }
            Err(e) => {
                tokio::fs::remove_file(&tmp_blob).await.ok();
                if blob_path.exists() {
                    we_wrote_blob = false;
                } else {
                    return Err(e);
                }
            }
        }

        let meta = existing_meta.unwrap_or_else(|| BlobMeta {
            media_type: media_type.to_string(),
            size: expected_size,
            created_at,
            durability,
            ephemeral_leases: BTreeMap::new(),
        });
        let meta_json = serde_json::to_string(&meta).map_err(io::Error::other)?;
        let tmp_meta = shard_dir.join(format!(".tmp.{}.meta", uuid::Uuid::new_v4()));
        match async {
            tokio::fs::write(&tmp_meta, meta_json).await?;
            tokio::fs::rename(&tmp_meta, &meta_path).await
        }
        .await
        {
            Ok(()) => {}
            Err(e) => {
                tokio::fs::remove_file(&tmp_meta).await.ok();
                if meta_path.exists() {
                    return Ok(expected_hash.to_string());
                }
                if we_wrote_blob {
                    tokio::fs::remove_file(&blob_path).await.ok();
                }
                return Err(e);
            }
        }

        Ok(expected_hash.to_string())
    }

    fn insert_memory(
        &self,
        hash: &str,
        data: Bytes,
        media_type: &str,
        created_at: DateTime<Utc>,
        durability: BlobDurability,
    ) {
        let mut memory = self.memory_layer();
        memory.insert(
            hash.to_string(),
            data,
            media_type.to_string(),
            created_at,
            durability,
        );
    }

    fn memory_layer(&self) -> MutexGuard<'_, MemoryLayer> {
        match self.inner.memory.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    fn memory_cap(&self) -> usize {
        self.inner.memory_cap
    }

    async fn acquire_blob_file_lock(
        &self,
        shard_dir: &Path,
        _meta_path: &Path,
    ) -> io::Result<BlobFileLock> {
        tokio::fs::create_dir_all(shard_dir).await?;
        // At most 256 persistent lock files, independent of animation churn.
        let lock_path = shard_dir.join(".writer.lock");
        let file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        let started = Instant::now();
        loop {
            match file.try_lock() {
                Ok(()) => return Ok(BlobFileLock { _file: file }),
                Err(std::fs::TryLockError::WouldBlock) => {
                    if started.elapsed() >= Duration::from_secs(BLOB_FILE_LOCK_TIMEOUT_SECS) {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            format!(
                                "timed out acquiring blob file lock at {}",
                                lock_path.display()
                            ),
                        ));
                    }
                    sleep(Duration::from_millis(BLOB_FILE_LOCK_RETRY_MS)).await;
                }
                Err(std::fs::TryLockError::Error(error)) => return Err(error),
            }
        }
    }

    /// Retrieve blob bytes by hash. Returns `None` if not found.
    pub async fn get(&self, hash: &str) -> io::Result<Option<Vec<u8>>> {
        if !Self::validate_hash(hash) {
            return Ok(None);
        }
        if let Some(entry) = {
            let memory = self.memory_layer();
            memory.get(hash)
        } {
            return Ok(Some(entry.data.to_vec()));
        }
        let (_, blob_path, _) = self.paths(hash);
        match tokio::fs::read(&blob_path).await {
            Ok(data) => Ok(Some(data)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Open a blob for streaming reads.
    ///
    /// Returns the blob as either an in-memory `Bytes` (when the memory layer
    /// already holds it) or an open `tokio::fs::File` ready to be read
    /// incrementally (when the blob lives only on disk). Both variants carry
    /// the byte length, which the HTTP server uses for `Content-Length`.
    ///
    /// This is the streaming counterpart to [`Self::get`]: where `get` reads
    /// the whole blob into a `Vec<u8>`, this method lets a caller hand a file
    /// handle to a streaming body without ever buffering the blob in the
    /// daemon's heap. Punchlist BS-1.
    pub async fn open_reader(&self, hash: &str) -> io::Result<Option<BlobReader>> {
        if !Self::validate_hash(hash) {
            return Ok(None);
        }
        if let Some(entry) = {
            let memory = self.memory_layer();
            memory.get(hash)
        } {
            let size = entry.data.len() as u64;
            return Ok(Some(BlobReader::InMemory {
                bytes: entry.data,
                size,
            }));
        }
        let (_, blob_path, _) = self.paths(hash);
        match tokio::fs::File::open(&blob_path).await {
            Ok(file) => {
                let size = match file.metadata().await {
                    Ok(meta) => meta.len(),
                    Err(e) => return Err(e),
                };
                Ok(Some(BlobReader::Disk { file, size }))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Retrieve blob metadata by hash. Returns `None` if not found.
    pub async fn get_meta(&self, hash: &str) -> io::Result<Option<BlobMeta>> {
        if !Self::validate_hash(hash) {
            return Ok(None);
        }
        if let Some(entry) = {
            let memory = self.memory_layer();
            memory.get(hash)
        } {
            return Ok(Some(entry.meta()));
        }
        let (_, _, meta_path) = self.paths(hash);
        match tokio::fs::read_to_string(&meta_path).await {
            Ok(json) => {
                let meta: BlobMeta = serde_json::from_str(&json)
                    .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
                Ok(Some(meta))
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Check if a blob exists (without reading it).
    pub fn exists(&self, hash: &str) -> bool {
        if !Self::validate_hash(hash) {
            return false;
        }
        {
            let memory = self.memory_layer();
            if memory.contains(hash) {
                return true;
            }
        }
        let (_, blob_path, _) = self.paths(hash);
        blob_path.exists()
    }

    /// Delete a blob and its metadata. Returns `true` if the blob existed.
    pub async fn delete(&self, hash: &str) -> io::Result<bool> {
        if !Self::validate_hash(hash) {
            return Ok(false);
        }
        let existed_in_memory = {
            let mut memory = self.memory_layer();
            memory.remove(hash)
        };
        let (_, blob_path, meta_path) = self.paths(hash);
        let existed = blob_path.exists();
        if existed {
            tokio::fs::remove_file(&blob_path).await.ok();
            tokio::fs::remove_file(&meta_path).await.ok();
        }
        Ok(existed || existed_in_memory)
    }

    /// GC rechecks age under the writer lock. A re-put after the mark pass
    /// refreshes metadata and must not be swept using the older observation.
    pub(crate) async fn delete_if_older_than(
        &self,
        hash: &str,
        cutoff: DateTime<Utc>,
    ) -> io::Result<bool> {
        if !Self::validate_hash(hash) {
            return Ok(false);
        }
        let (shard, blob, meta_path) = self.paths(hash);
        let _lock = self.acquire_blob_file_lock(&shard, &meta_path).await?;
        let json = match tokio::fs::read_to_string(&meta_path).await {
            Ok(json) => json,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let meta: BlobMeta = serde_json::from_str(&json).map_err(io::Error::other)?;
        if meta.created_at >= cutoff {
            return Ok(false);
        }
        tokio::fs::remove_file(&blob).await?;
        tokio::fs::remove_file(&meta_path).await?;
        self.memory_layer().remove(hash);
        Ok(true)
    }

    /// Delete a blob only when it is known ephemeral.
    ///
    /// Durable entries are left intact because they may be referenced by
    /// outputs, attachments, or another durable path with the same hash.
    pub async fn delete_if_ephemeral(&self, hash: &str) -> io::Result<bool> {
        if !Self::validate_hash(hash) {
            return Ok(false);
        }
        let (shard, blob, meta_path) = self.paths(hash);
        let _lock = self.acquire_blob_file_lock(&shard, &meta_path).await?;
        let json = match tokio::fs::read_to_string(&meta_path).await {
            Ok(json) => json,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let meta: BlobMeta = serde_json::from_str(&json).map_err(io::Error::other)?;
        if meta.durability != BlobDurability::Ephemeral || !meta.ephemeral_leases.is_empty() {
            return Ok(false);
        }
        match tokio::fs::remove_file(&blob).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        tokio::fs::remove_file(&meta_path).await?;
        self.memory_layer().remove(hash);
        Ok(true)
    }

    async fn write_meta(&self, shard: &Path, path: &Path, meta: &BlobMeta) -> io::Result<()> {
        let tmp = shard.join(format!(".tmp.{}.meta", uuid::Uuid::new_v4()));
        let result = async {
            tokio::fs::write(&tmp, serde_json::to_vec(meta).map_err(io::Error::other)?).await?;
            tokio::fs::rename(&tmp, path).await
        }
        .await;
        if result.is_err() {
            tokio::fs::remove_file(&tmp).await.ok();
        }
        result
    }

    /// Release only the generation that was retired. A concurrent re-put renews
    /// that owner's generation, so a delayed release cannot delete reused bytes.
    /// Crashed owners leave safe leases behind; the ordinary all-room GC reclaims
    /// unreferenced leftovers after its grace period rather than guessing liveness.
    pub(crate) async fn release_ephemeral_lease(
        &self,
        hash: &str,
        lease: &EphemeralBlobLease,
    ) -> io::Result<bool> {
        if !Self::validate_hash(hash) {
            return Ok(false);
        }
        let (shard, blob, meta_path) = self.paths(hash);
        let _lock = self.acquire_blob_file_lock(&shard, &meta_path).await?;
        let json = match tokio::fs::read_to_string(&meta_path).await {
            Ok(json) => json,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        let mut meta: BlobMeta = serde_json::from_str(&json).map_err(io::Error::other)?;
        if meta.durability != BlobDurability::Ephemeral
            || meta.ephemeral_leases.get(&lease.owner) != Some(&lease.generation)
        {
            return Ok(false);
        }
        meta.ephemeral_leases.remove(&lease.owner);
        if !meta.ephemeral_leases.is_empty() {
            self.write_meta(&shard, &meta_path, &meta).await?;
            return Ok(false);
        }
        // Hold the same cross-process file lock through removal. A writer either
        // renewed a lease before this check or recreates complete bytes afterward.
        match tokio::fs::remove_file(&blob).await {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        tokio::fs::remove_file(&meta_path).await?;
        self.memory_layer().remove(hash);
        Ok(true)
    }

    /// List all blob hashes in the store.
    pub async fn list(&self) -> io::Result<Vec<String>> {
        let mut hashes = Vec::new();

        if !self.inner.root.exists() {
            return Ok(hashes);
        }

        let mut shard_entries = tokio::fs::read_dir(&self.inner.root).await?;
        while let Some(shard) = shard_entries.next_entry().await? {
            if !shard.path().is_dir() {
                continue;
            }
            let shard_name = shard.file_name().to_string_lossy().to_string();
            if shard_name.len() != 2 || !shard_name.chars().all(|c| c.is_ascii_hexdigit()) {
                continue;
            }

            let mut blob_entries = match tokio::fs::read_dir(shard.path()).await {
                Ok(e) => e,
                Err(_) => continue,
            };
            while let Some(entry) = blob_entries.next_entry().await? {
                let name = entry.file_name().to_string_lossy().to_string();
                if name.ends_with(".meta") || name.starts_with(".tmp") {
                    continue;
                }
                let full_hash = format!("{}{}", shard_name, name);
                if Self::validate_hash(&full_hash) {
                    hashes.push(full_hash);
                }
            }
        }

        Ok(hashes)
    }

    /// Compute shard dir, blob path, and meta path for a given hash.
    fn paths(&self, hash: &str) -> (PathBuf, PathBuf, PathBuf) {
        let shard = &hash[..2];
        let rest = &hash[2..];
        let shard_dir = self.inner.root.join(shard);
        let blob_path = shard_dir.join(rest);
        let meta_path = shard_dir.join(format!("{}.meta", rest));
        (shard_dir, blob_path, meta_path)
    }

    /// Validate that a hash looks like a 64-character hex string.
    fn validate_hash(hash: &str) -> bool {
        hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
    }

    #[cfg(test)]
    fn memory_contains_for_test(&self, hash: &str) -> bool {
        let memory = self.memory_layer();
        memory.contains(hash)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn test_store(dir: &TempDir) -> BlobStore {
        BlobStore::new(dir.path().join("blobs"))
    }

    fn test_store_with_cap(dir: &TempDir, cap: usize) -> BlobStore {
        BlobStore::with_ephemeral_cap(dir.path().join("blobs"), cap)
    }

    fn disk_blob_exists(store: &BlobStore, hash: &str) -> bool {
        let (_, blob_path, meta_path) = store.paths(hash);
        blob_path.exists() && meta_path.exists()
    }

    async fn disk_blob_durability(store: &BlobStore, hash: &str) -> Option<BlobDurability> {
        let (_, _, meta_path) = store.paths(hash);
        let json = tokio::fs::read_to_string(meta_path).await.ok()?;
        serde_json::from_str::<BlobMeta>(&json)
            .ok()
            .map(|meta| meta.durability)
    }

    #[tokio::test]
    async fn leased_blob_survives_other_agent_retirement_then_is_reclaimed() {
        let dir = TempDir::new().unwrap();
        let a = BlobStore::with_ephemeral_cap(dir.path().to_path_buf(), 0);
        let b = BlobStore::with_ephemeral_cap(dir.path().to_path_buf(), 0);
        let a_lease = EphemeralBlobOwner::default().next_lease();
        let b_lease = EphemeralBlobOwner::default().next_lease();
        let hash = a
            .put_leased_ephemeral(b"shared", "x/test", &a_lease)
            .await
            .unwrap();
        assert_eq!(
            hash,
            b.put_leased_ephemeral(b"shared", "x/test", &b_lease)
                .await
                .unwrap()
        );
        assert!(!a.release_ephemeral_lease(&hash, &a_lease).await.unwrap());
        assert_eq!(b.get(&hash).await.unwrap().unwrap(), b"shared");
        assert!(
            !a.delete_if_ephemeral(&hash).await.unwrap(),
            "unmanaged retirement cannot remove another producer's lease"
        );
        assert!(b.release_ephemeral_lease(&hash, &b_lease).await.unwrap());
        assert!(a.get(&hash).await.unwrap().is_none());
        assert!(b.get_meta(&hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn retired_generation_cannot_release_reused_content() {
        let dir = TempDir::new().unwrap();
        let store = BlobStore::with_ephemeral_cap(dir.path().to_path_buf(), 0);
        let owner = EphemeralBlobOwner::default();
        let retired = owner.next_lease();
        let current = owner.next_lease();
        let hash = store
            .put_leased_ephemeral(b"reused", "x/test", &retired)
            .await
            .unwrap();
        store
            .put_leased_ephemeral(b"reused", "x/test", &current)
            .await
            .unwrap();
        // An earlier in-flight put can complete after a newer one too.
        store
            .put_leased_ephemeral(b"reused", "x/test", &retired)
            .await
            .unwrap();
        assert!(!store
            .release_ephemeral_lease(&hash, &retired)
            .await
            .unwrap());
        assert!(store.get(&hash).await.unwrap().is_some());
        assert!(store
            .release_ephemeral_lease(&hash, &current)
            .await
            .unwrap());
        // The inverse interleaving recreates complete bytes after deletion.
        let next = owner.next_lease();
        store
            .put_leased_ephemeral(b"reused", "x/test", &next)
            .await
            .unwrap();
        assert_eq!(store.get(&hash).await.unwrap().unwrap(), b"reused");
    }

    #[tokio::test]
    async fn leased_and_unmanaged_writes_promote_both_collision_orders() {
        for managed_first in [false, true] {
            let dir = TempDir::new().unwrap();
            let a = BlobStore::with_ephemeral_cap(dir.path().to_path_buf(), 0);
            let b = BlobStore::with_ephemeral_cap(dir.path().to_path_buf(), 0);
            let lease = EphemeralBlobOwner::default().next_lease();
            let hash = if managed_first {
                let hash = a
                    .put_leased_ephemeral(b"overlap", "x/test", &lease)
                    .await
                    .unwrap();
                b.put_with_durability(b"overlap", "x/test", BlobDurability::Ephemeral)
                    .await
                    .unwrap();
                hash
            } else {
                let hash = b
                    .put_with_durability(b"overlap", "x/test", BlobDurability::Ephemeral)
                    .await
                    .unwrap();
                a.put_leased_ephemeral(b"overlap", "x/test", &lease)
                    .await
                    .unwrap();
                hash
            };
            assert_eq!(
                disk_blob_durability(&a, &hash).await,
                Some(BlobDurability::Durable)
            );
            assert!(!a.release_ephemeral_lease(&hash, &lease).await.unwrap());
            assert!(!b.delete_if_ephemeral(&hash).await.unwrap());
            a.put_leased_ephemeral(b"overlap", "x/test", &lease)
                .await
                .unwrap();
            assert_eq!(
                disk_blob_durability(&a, &hash).await,
                Some(BlobDurability::Durable)
            );
            assert_eq!(b.get(&hash).await.unwrap().unwrap(), b"overlap");
        }
    }

    #[tokio::test]
    async fn multipart_write_promotes_a_leased_blob() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 0);
        let lease = EphemeralBlobOwner::default().next_lease();
        let hash = store
            .put_leased_ephemeral(b"overlap", "x/test", &lease)
            .await
            .unwrap();
        store
            .put_part_files_with_hash(&[], "x/test", 7, &hash, BlobDurability::Ephemeral)
            .await
            .unwrap();
        assert_eq!(
            disk_blob_durability(&store, &hash).await,
            Some(BlobDurability::Durable)
        );
        assert!(!store.release_ephemeral_lease(&hash, &lease).await.unwrap());
    }

    #[tokio::test]
    async fn gc_rechecks_reused_blob_age_under_writer_lock() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 0);
        let owner = EphemeralBlobOwner::default();
        let lease = owner.next_lease();
        let hash = store
            .put_leased_ephemeral(b"reused", "x/test", &lease)
            .await
            .unwrap();
        let (_, _, path) = store.paths(&hash);
        let mut meta: BlobMeta =
            serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        meta.created_at = Utc::now() - chrono::Duration::days(31);
        tokio::fs::write(&path, serde_json::to_vec(&meta).unwrap())
            .await
            .unwrap();
        let cutoff = Utc::now() - chrono::Duration::days(30);
        // GC's mark pass does not know about this newly announced reference.
        store
            .put_leased_ephemeral(b"reused", "x/test", &owner.next_lease())
            .await
            .unwrap();
        assert!(!store.delete_if_older_than(&hash, cutoff).await.unwrap());
        assert!(store.get(&hash).await.unwrap().is_some());
        // An abandoned old lease remains reclaimable by normal mark-and-sweep.
        tokio::fs::write(&path, serde_json::to_vec(&meta).unwrap())
            .await
            .unwrap();
        assert!(store.delete_if_older_than(&hash, cutoff).await.unwrap());
    }

    #[tokio::test]
    async fn invalid_lease_metadata_fails_closed() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 0);
        let lease = EphemeralBlobOwner::default().next_lease();
        let hash = store
            .put_leased_ephemeral(b"safe", "x/test", &lease)
            .await
            .unwrap();
        let (_, blob, meta) = store.paths(&hash);
        tokio::fs::write(&meta, b"not JSON").await.unwrap();
        assert!(store
            .put_leased_ephemeral(b"safe", "x/test", &lease)
            .await
            .is_err());
        assert!(store.release_ephemeral_lease(&hash, &lease).await.is_err());
        assert!(store.delete_if_ephemeral(&hash).await.is_err());
        assert!(blob.exists());
    }

    #[tokio::test]
    async fn test_put_and_get() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let data = b"hello world";
        let hash = store.put(data, "text/plain").await.unwrap();
        assert_eq!(hash.len(), 64);

        let retrieved = store.get(&hash).await.unwrap().unwrap();
        assert_eq!(retrieved, data);
    }

    #[tokio::test]
    async fn test_idempotent_put() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let data = b"same content";
        let hash1 = store.put(data, "text/plain").await.unwrap();
        let hash2 = store.put(data, "text/plain").await.unwrap();
        assert_eq!(hash1, hash2);
    }

    #[tokio::test]
    async fn test_same_bytes_different_media_type() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let data = b"same bytes";
        let hash1 = store.put(data, "text/plain").await.unwrap();
        let hash2 = store.put(data, "application/octet-stream").await.unwrap();
        // Same bytes = same hash (media type doesn't affect hash)
        assert_eq!(hash1, hash2);
        // Metadata updates to the latest media type (e.g., content first
        // stored as application/json then re-stored as text/javascript
        // for anywidget _esm).
        let meta = store.get_meta(&hash1).await.unwrap().unwrap();
        assert_eq!(meta.media_type, "application/octet-stream");
    }

    #[tokio::test]
    async fn test_size_limit() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let data = vec![0u8; MAX_BLOB_SIZE + 1];
        let result = store.put(&data, "application/octet-stream").await;
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
    }

    #[tokio::test]
    async fn test_get_not_found() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let fake_hash = "a".repeat(64);
        let result = store.get(&fake_hash).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_get_meta() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let data = b"png bytes";
        let hash = store.put(data, "image/png").await.unwrap();

        let meta = store.get_meta(&hash).await.unwrap().unwrap();
        assert_eq!(meta.media_type, "image/png");
        assert_eq!(meta.size, data.len() as u64);
    }

    #[tokio::test]
    async fn test_exists() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let fake_hash = "b".repeat(64);
        assert!(!store.exists(&fake_hash));

        let hash = store.put(b"data", "text/plain").await.unwrap();
        assert!(store.exists(&hash));
    }

    #[tokio::test]
    async fn test_delete() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let hash = store.put(b"to delete", "text/plain").await.unwrap();
        assert!(store.exists(&hash));

        let deleted = store.delete(&hash).await.unwrap();
        assert!(deleted);
        assert!(!store.exists(&hash));
        assert!(store.get(&hash).await.unwrap().is_none());
        assert!(store.get_meta(&hash).await.unwrap().is_none());

        // Deleting again returns false
        let deleted_again = store.delete(&hash).await.unwrap();
        assert!(!deleted_again);
    }

    #[tokio::test]
    async fn test_list() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let hash1 = store.put(b"one", "text/plain").await.unwrap();
        let hash2 = store.put(b"two", "text/plain").await.unwrap();
        let hash3 = store.put(b"three", "text/plain").await.unwrap();

        let mut hashes = store.list().await.unwrap();
        hashes.sort();

        let mut expected = vec![hash1, hash2, hash3];
        expected.sort();

        assert_eq!(hashes, expected);
    }

    #[tokio::test]
    async fn test_list_empty_store() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let hashes = store.list().await.unwrap();
        assert!(hashes.is_empty());
    }

    #[tokio::test]
    async fn test_invalid_hash_returns_none() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        // Too short
        assert!(store.get("abc").await.unwrap().is_none());
        assert!(store.get_meta("abc").await.unwrap().is_none());
        assert!(!store.exists("abc"));
        assert!(!store.delete("abc").await.unwrap());

        // Non-hex characters
        let bad = format!("{}z", "a".repeat(63));
        assert!(store.get(&bad).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_concurrent_puts_same_content() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let data = b"concurrent content";
        let store1 = store.clone();
        let store2 = store.clone();

        let (hash1, hash2) = tokio::join!(
            async { store1.put(data, "text/plain").await.unwrap() },
            async { store2.put(data, "text/plain").await.unwrap() },
        );

        assert_eq!(hash1, hash2);
        assert_eq!(store.get(&hash1).await.unwrap().unwrap(), data);
    }

    #[tokio::test]
    async fn put_ephemeral_is_disk_backed_for_runtime_agent() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let hash = store
            .put_with_durability(
                b"ephemeral",
                "application/octet-stream",
                BlobDurability::Ephemeral,
            )
            .await
            .unwrap();

        assert!(store.memory_contains_for_test(&hash));
        assert!(disk_blob_exists(&store, &hash));
        assert_eq!(
            disk_blob_durability(&store, &hash).await,
            Some(BlobDurability::Ephemeral)
        );
        assert_eq!(store.get(&hash).await.unwrap().unwrap(), b"ephemeral");

        let runtime_agent_store = test_store(&dir);
        assert_eq!(
            runtime_agent_store.get(&hash).await.unwrap().unwrap(),
            b"ephemeral"
        );
    }

    #[tokio::test]
    async fn put_durable_lives_in_both_memory_and_disk() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let hash = store
            .put_with_durability(b"durable", "text/plain", BlobDurability::Durable)
            .await
            .unwrap();

        assert!(store.memory_contains_for_test(&hash));
        assert!(disk_blob_exists(&store, &hash));
    }

    #[tokio::test]
    async fn get_ephemeral_after_memory_eviction_falls_back_to_disk() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 2);

        let evicted = store
            .put_with_durability(b"a", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();
        store
            .put_with_durability(b"b", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();
        store
            .put_with_durability(b"c", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();

        assert!(!store.memory_contains_for_test(&evicted));
        assert!(disk_blob_exists(&store, &evicted));
        assert_eq!(store.get(&evicted).await.unwrap().unwrap(), b"a");
    }

    #[tokio::test]
    async fn get_durable_after_eviction_falls_back_to_disk() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 2);

        let durable = store
            .put_with_durability(b"a", "text/plain", BlobDurability::Durable)
            .await
            .unwrap();
        store
            .put_with_durability(b"b", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();
        store
            .put_with_durability(b"c", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();

        assert!(!store.memory_contains_for_test(&durable));
        assert!(disk_blob_exists(&store, &durable));
        assert_eq!(store.get(&durable).await.unwrap().unwrap(), b"a");
    }

    #[tokio::test]
    async fn put_oversize_ephemeral_falls_through_to_disk() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 2);

        let hash = store
            .put_with_durability(b"abc", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();

        assert!(!store.memory_contains_for_test(&hash));
        assert!(disk_blob_exists(&store, &hash));
        assert_eq!(store.get(&hash).await.unwrap().unwrap(), b"abc");
    }

    #[tokio::test]
    async fn put_durable_then_ephemeral_same_hash_keeps_disk_copy() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let hash = store
            .put_with_durability(b"same", "text/plain", BlobDurability::Durable)
            .await
            .unwrap();
        let hash2 = store
            .put_with_durability(b"same", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();

        assert_eq!(hash, hash2);
        assert!(store.memory_contains_for_test(&hash));
        assert!(disk_blob_exists(&store, &hash));
        assert_eq!(
            disk_blob_durability(&store, &hash).await,
            Some(BlobDurability::Durable)
        );
        assert!(!store.delete_if_ephemeral(&hash).await.unwrap());
        assert!(disk_blob_exists(&store, &hash));
    }

    #[tokio::test]
    async fn put_ephemeral_then_durable_same_hash_promotes_to_disk() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);

        let hash = store
            .put_with_durability(b"same", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();
        assert!(disk_blob_exists(&store, &hash));
        assert_eq!(
            disk_blob_durability(&store, &hash).await,
            Some(BlobDurability::Ephemeral)
        );

        let hash2 = store
            .put_with_durability(b"same", "text/plain", BlobDurability::Durable)
            .await
            .unwrap();

        assert_eq!(hash, hash2);
        assert!(store.memory_contains_for_test(&hash));
        assert!(disk_blob_exists(&store, &hash));
        assert_eq!(
            disk_blob_durability(&store, &hash).await,
            Some(BlobDurability::Durable)
        );
    }

    #[tokio::test]
    async fn fifo_eviction_oldest_first() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 2);

        let first = store
            .put_with_durability(b"a", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();
        let second = store
            .put_with_durability(b"b", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();
        let third = store
            .put_with_durability(b"c", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();

        assert!(!store.memory_contains_for_test(&first));
        assert!(store.memory_contains_for_test(&second));
        assert!(store.memory_contains_for_test(&third));
    }

    #[tokio::test]
    async fn delete_if_ephemeral_removes_ephemeral_only() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);
        let hash = store
            .put_with_durability(b"ephemeral", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();

        assert!(store.delete_if_ephemeral(&hash).await.unwrap());
        assert!(!store.memory_contains_for_test(&hash));
        assert!(!disk_blob_exists(&store, &hash));
        assert!(store.get(&hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_if_ephemeral_removes_disk_only_ephemeral() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 2);
        let hash = store
            .put_with_durability(b"oversize", "text/plain", BlobDurability::Ephemeral)
            .await
            .unwrap();

        assert!(!store.memory_contains_for_test(&hash));
        assert!(disk_blob_exists(&store, &hash));

        assert!(store.delete_if_ephemeral(&hash).await.unwrap());
        assert!(!disk_blob_exists(&store, &hash));
        assert!(store.get(&hash).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_if_ephemeral_skips_durable() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);
        let hash = store
            .put_with_durability(b"durable", "text/plain", BlobDurability::Durable)
            .await
            .unwrap();

        assert!(!store.delete_if_ephemeral(&hash).await.unwrap());
        assert!(store.memory_contains_for_test(&hash));
        assert!(disk_blob_exists(&store, &hash));
        assert_eq!(store.get(&hash).await.unwrap().unwrap(), b"durable");
    }

    #[tokio::test]
    async fn delete_if_ephemeral_returns_false_for_unknown_hash() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);
        let missing = "a".repeat(64);

        assert!(!store.delete_if_ephemeral(&missing).await.unwrap());
    }
    #[tokio::test]
    async fn metadata_only_reupload_preserves_other_producer_lease() {
        let dir = TempDir::new().unwrap();
        let a = test_store_with_cap(&dir, 0);
        let b = test_store_with_cap(&dir, 0);
        let owner_a = EphemeralBlobOwner::default();
        let lease_a = owner_a.next_lease();
        let lease_b = EphemeralBlobOwner::default().next_lease();
        let hash = a
            .put_leased_ephemeral(b"restore", "text/plain", &lease_a)
            .await
            .unwrap();
        b.put_leased_ephemeral(b"restore", "text/plain", &lease_b)
            .await
            .unwrap();
        tokio::fs::remove_file(a.paths(&hash).1).await.unwrap();
        let renewed = owner_a.next_lease();
        a.put_leased_ephemeral(b"restore", "text/plain", &renewed)
            .await
            .unwrap();
        assert_eq!(b.get(&hash).await.unwrap().unwrap(), b"restore");
        a.release_ephemeral_lease(&hash, &renewed).await.unwrap();
        assert!(
            disk_blob_exists(&b, &hash),
            "restoring bytes must preserve B's lease"
        );
        b.release_ephemeral_lease(&hash, &lease_b).await.unwrap();
        assert!(!disk_blob_exists(&a, &hash));
    }

    #[tokio::test]
    async fn metadata_only_multipart_reupload_keeps_managed_bytes_safe() {
        let dir = TempDir::new().unwrap();
        let store = test_store_with_cap(&dir, 0);
        let lease = EphemeralBlobOwner::default().next_lease();
        let hash = store
            .put_leased_ephemeral(b"restore", "text/plain", &lease)
            .await
            .unwrap();
        tokio::fs::remove_file(store.paths(&hash).1).await.unwrap();
        let part = dir.path().join("part");
        tokio::fs::write(&part, b"restore").await.unwrap();
        store
            .put_part_files_with_hash(&[part], "text/plain", 7, &hash, BlobDurability::Ephemeral)
            .await
            .unwrap();
        assert_eq!(store.get(&hash).await.unwrap().unwrap(), b"restore");
        store.release_ephemeral_lease(&hash, &lease).await.unwrap();
        assert!(!store.delete_if_ephemeral(&hash).await.unwrap());
        assert_eq!(
            disk_blob_durability(&store, &hash).await,
            Some(BlobDurability::Durable)
        );
    }

    #[tokio::test]
    async fn shard_lock_keeps_one_inode_even_when_old_and_contended() {
        let dir = TempDir::new().unwrap();
        let store = test_store(&dir);
        let (shard, _, meta) = store.paths(&"a".repeat(64));
        let first = store.acquire_blob_file_lock(&shard, &meta).await.unwrap();
        let path = shard.join(".writer.lock");
        let witness = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        witness
            .set_times(std::fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH))
            .unwrap();
        let contender_store = store.clone();
        let contender_shard = shard.clone();
        let contender = tokio::spawn(async move {
            contender_store
                .acquire_blob_file_lock(&contender_shard, &meta)
                .await
                .unwrap()
        });
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(
            !contender.is_finished(),
            "age must never evict a live lock holder"
        );
        assert!(matches!(
            witness.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(first);
        let second = contender.await.unwrap();
        assert!(
            matches!(witness.try_lock(), Err(std::fs::TryLockError::WouldBlock)),
            "contender must lock the same inode"
        );
        drop(second);
        witness.try_lock().unwrap();
        assert!(
            path.exists(),
            "release must not unlink the stable lock file"
        );
    }
}
