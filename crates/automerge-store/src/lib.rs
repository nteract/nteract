//! Durable, content-addressed storage for Automerge documents.
//!
//! The store follows the document layout used by `automerge-repo`: immutable
//! incremental chunks are addressed by content hash, full snapshots are
//! addressed by their causal heads, and compaction publishes a new snapshot
//! before deleting only the chunks it loaded. SQLite makes the chunk and the
//! caller-owned opaque application state visible in one durable transaction.
//!
//! Authentication, authorization, network sync, and projections such as
//! `.ipynb` files deliberately live above this crate. Callers must admit a
//! change batch before passing it to [`AutomergeDocumentStore::commit`].

use std::collections::HashSet;
use std::fmt;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use automerge::{AutoCommit, Change, ChangeHash};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use sha2::{Digest, Sha256};
use uuid::Uuid;

const CHUNK_KIND_SNAPSHOT: i64 = 0;
const CHUNK_KIND_INCREMENTAL: i64 = 1;
const HASH_BYTES: usize = 32;
const SQLITE_BUSY_TIMEOUT: Duration = Duration::from_secs(5);
const STORE_SCHEMA_VERSION: i64 = 1;

/// Stable identity of one stored Automerge document.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct DocumentId(Uuid);

impl DocumentId {
    pub fn new(id: Uuid) -> Self {
        Self(id)
    }

    pub fn as_uuid(self) -> Uuid {
        self.0
    }
}

impl From<Uuid> for DocumentId {
    fn from(value: Uuid) -> Self {
        Self::new(value)
    }
}

impl fmt::Display for DocumentId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

/// Fully materialized durable state returned by [`AutomergeDocumentStore::load`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoredDocument {
    /// Canonical full save of every snapshot and incremental chunk in storage.
    pub snapshot: Vec<u8>,
    /// Exact causal frontier committed with `application_state`.
    pub durable_heads: Vec<ChangeHash>,
    /// Versioned bytes owned and interpreted by the caller.
    pub application_state: Vec<u8>,
    /// Monotonic durable application commit sequence. Compaction does not
    /// advance this value.
    pub sequence: u64,
}

/// One already-admitted change batch and its atomically associated state.
#[derive(Clone, Debug)]
pub struct CommitRequest {
    pub document_id: DocumentId,
    pub changes: Vec<Change>,
    pub application_state: Vec<u8>,
}

/// Receipt returned only after SQLite has durably committed the batch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitReceipt {
    pub durable_heads: Vec<ChangeHash>,
    pub sequence: u64,
    /// False when both the causal history and application state were already
    /// durable. An application-state-only transition is a new commit.
    pub newly_persisted: bool,
}

/// Result of a maintenance compaction.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompactionReceipt {
    pub durable_heads: Vec<ChangeHash>,
    pub removed_chunks: usize,
}

/// Storage contract used by a document authority.
pub trait AutomergeDocumentStore: Send + Sync {
    fn load(&self, document_id: DocumentId) -> Result<Option<StoredDocument>, StoreError>;

    /// Merge and persist an admitted batch. The implementation must not return
    /// success until its durable transaction is complete.
    fn commit(&self, request: CommitRequest) -> Result<CommitReceipt, StoreError>;

    /// Install a complete verified history for genesis or migration. Once a
    /// document exists, this operation is idempotent only for the exact same
    /// heads and application state; it never replaces authoritative history.
    /// Ordinary edits and metadata transitions use [`Self::commit`].
    fn install_snapshot(
        &self,
        document_id: DocumentId,
        snapshot: &[u8],
        heads: &[ChangeHash],
        application_state: &[u8],
    ) -> Result<CommitReceipt, StoreError>;

    /// Compact immutable chunks without changing the durable application
    /// sequence. Failure is maintenance failure, not rollback of an earlier
    /// successful commit.
    fn compact(&self, document_id: DocumentId) -> Result<CompactionReceipt, StoreError>;
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("SQLite document store failed: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("Automerge document data is invalid: {0}")]
    Automerge(#[from] automerge::AutomergeError),
    #[error("document {0} is not installed")]
    DocumentNotFound(DocumentId),
    #[error("document {0} has metadata but no chunks")]
    MissingChunks(DocumentId),
    #[error("document {document_id} has invalid encoded heads length {actual}")]
    InvalidHeadsEncoding {
        document_id: DocumentId,
        actual: usize,
    },
    #[error("document {0} has duplicate durable heads")]
    DuplicateDurableHeads(DocumentId),
    #[error("snapshot heads do not match the declared heads")]
    SnapshotHeadsMismatch,
    #[error("document {0} is already installed with different authoritative state")]
    InstallConflict(DocumentId),
    #[error("document {0} materialized heads do not match its durable metadata")]
    DurableHeadsMismatch(DocumentId),
    #[error("document {document_id} chunk {chunk_key} failed its checksum")]
    ChunkChecksumMismatch {
        document_id: DocumentId,
        chunk_key: String,
    },
    #[error("document {document_id} chunk {chunk_key} does not match its storage key")]
    ChunkKeyMismatch {
        document_id: DocumentId,
        chunk_key: String,
    },
    #[error("document {0} produced an empty incremental save for new changes")]
    EmptyIncremental(DocumentId),
    #[error("document {0} commit sequence is exhausted")]
    SequenceExhausted(DocumentId),
    #[error("SQLite refused WAL journal mode and selected {0:?}")]
    WalUnavailable(String),
    #[error(
        "document store schema version {actual} is newer than the supported version {supported}"
    )]
    UnsupportedSchemaVersion { actual: i64, supported: i64 },
}

/// SQLite-backed implementation with an `fsync`-equivalent commit boundary.
///
/// The connection uses WAL mode and `synchronous=FULL`. All public operations
/// are synchronous so a caller can retain its own document lock until the
/// returned [`CommitReceipt`] is safe to acknowledge.
pub struct SqliteDocumentStore {
    connection: Mutex<Connection>,
}

impl SqliteDocumentStore {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, StoreError> {
        let mut connection = Connection::open(path)?;
        configure_connection(&connection)?;
        initialize_schema(&mut connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    fn lock_connection(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl AutomergeDocumentStore for SqliteDocumentStore {
    fn load(&self, document_id: DocumentId) -> Result<Option<StoredDocument>, StoreError> {
        let connection = self.lock_connection();
        load_document(&connection, document_id).map(|loaded| loaded.map(LoadedDocument::stored))
    }

    fn commit(&self, request: CommitRequest) -> Result<CommitReceipt, StoreError> {
        let mut connection = self.lock_connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut loaded = load_document(&transaction, request.document_id)?
            .ok_or(StoreError::DocumentNotFound(request.document_id))?;

        let previous_heads = loaded.durable_heads.clone();
        let mut seen = HashSet::new();
        let missing = request
            .changes
            .into_iter()
            .filter(|change| seen.insert(change.hash()))
            .filter(|change| loaded.document.get_change_by_hash(&change.hash()).is_none())
            .collect::<Vec<_>>();

        if missing.is_empty() && loaded.application_state == request.application_state {
            return Ok(CommitReceipt {
                durable_heads: previous_heads,
                sequence: loaded.sequence,
                newly_persisted: false,
            });
        }

        if !missing.is_empty() {
            loaded.document.apply_changes(missing)?;
            let incremental = loaded.document.save_after(&previous_heads);
            if incremental.is_empty() {
                return Err(StoreError::EmptyIncremental(request.document_id));
            }
            insert_incremental_chunk(&transaction, request.document_id, &incremental)?;
        }

        let durable_heads = canonical_heads(&loaded.document.get_heads());
        let sequence = next_sequence(request.document_id, loaded.sequence)?;
        update_document_row(
            &transaction,
            request.document_id,
            sequence,
            &durable_heads,
            &request.application_state,
        )?;
        transaction.commit()?;

        Ok(CommitReceipt {
            durable_heads,
            sequence,
            newly_persisted: true,
        })
    }

    fn install_snapshot(
        &self,
        document_id: DocumentId,
        snapshot: &[u8],
        heads: &[ChangeHash],
        application_state: &[u8],
    ) -> Result<CommitReceipt, StoreError> {
        let mut candidate = AutoCommit::load(snapshot)?;
        let actual_heads = canonical_heads(&candidate.get_heads());
        let declared_heads = canonical_heads(heads);
        if actual_heads != declared_heads {
            return Err(StoreError::SnapshotHeadsMismatch);
        }

        let mut connection = self.lock_connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing = load_document(&transaction, document_id)?;
        if let Some(existing) = &existing {
            if existing.durable_heads == actual_heads
                && existing.application_state == application_state
            {
                return Ok(CommitReceipt {
                    durable_heads: actual_heads,
                    sequence: existing.sequence,
                    newly_persisted: false,
                });
            }
            return Err(StoreError::InstallConflict(document_id));
        }

        let sequence = next_sequence(document_id, 0)?;
        update_document_row(
            &transaction,
            document_id,
            sequence,
            &actual_heads,
            application_state,
        )?;
        insert_snapshot_chunk(&transaction, document_id, snapshot, &actual_heads)?;
        transaction.commit()?;

        Ok(CommitReceipt {
            durable_heads: actual_heads,
            sequence,
            newly_persisted: true,
        })
    }

    fn compact(&self, document_id: DocumentId) -> Result<CompactionReceipt, StoreError> {
        let mut connection = self.lock_connection();
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut loaded = load_document(&transaction, document_id)?
            .ok_or(StoreError::DocumentNotFound(document_id))?;
        let snapshot = loaded.document.save();
        let snapshot_key =
            insert_snapshot_chunk(&transaction, document_id, &snapshot, &loaded.durable_heads)?;

        // Delete only the exact source chunks materialized above. A future
        // adapter that permits concurrent writers therefore cannot delete a
        // chunk it never observed and incorporated into this snapshot.
        let mut removed_chunks = 0;
        for chunk in loaded.source_chunks {
            if chunk.kind == CHUNK_KIND_SNAPSHOT && chunk.key == snapshot_key {
                continue;
            }
            removed_chunks += transaction.execute(
                "DELETE FROM chunks WHERE document_id = ?1 AND kind = ?2 AND chunk_key = ?3",
                params![document_id_bytes(document_id), chunk.kind, chunk.key],
            )?;
        }

        // Re-read through the public load algorithm before publishing the
        // maintenance transaction. This verifies the compacted snapshot and
        // durable-head metadata agree.
        load_document(&transaction, document_id)?
            .ok_or(StoreError::DocumentNotFound(document_id))?;
        transaction.commit()?;

        Ok(CompactionReceipt {
            durable_heads: loaded.durable_heads,
            removed_chunks,
        })
    }
}

struct LoadedDocument {
    document: AutoCommit,
    durable_heads: Vec<ChangeHash>,
    application_state: Vec<u8>,
    sequence: u64,
    source_chunks: Vec<ChunkIdentity>,
}

impl LoadedDocument {
    fn stored(mut self) -> StoredDocument {
        StoredDocument {
            snapshot: self.document.save(),
            durable_heads: self.durable_heads,
            application_state: self.application_state,
            sequence: self.sequence,
        }
    }
}

struct ChunkIdentity {
    kind: i64,
    key: Vec<u8>,
}

fn configure_connection(connection: &Connection) -> Result<(), StoreError> {
    connection.busy_timeout(SQLITE_BUSY_TIMEOUT)?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    let journal_mode: String =
        connection.query_row("PRAGMA journal_mode = WAL", [], |row| row.get(0))?;
    if !journal_mode.eq_ignore_ascii_case("wal") {
        return Err(StoreError::WalUnavailable(journal_mode));
    }
    connection.pragma_update(None, "synchronous", "FULL")?;
    Ok(())
}

fn initialize_schema(connection: &mut Connection) -> Result<(), StoreError> {
    let schema_version: i64 = connection.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    if schema_version > STORE_SCHEMA_VERSION {
        return Err(StoreError::UnsupportedSchemaVersion {
            actual: schema_version,
            supported: STORE_SCHEMA_VERSION,
        });
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute_batch(
        "CREATE TABLE IF NOT EXISTS documents (
             document_id      BLOB PRIMARY KEY NOT NULL CHECK(length(document_id) = 16),
             sequence         INTEGER NOT NULL CHECK(sequence >= 0),
             durable_heads    BLOB NOT NULL,
             application_state BLOB NOT NULL
         );
         CREATE TABLE IF NOT EXISTS chunks (
             document_id BLOB NOT NULL CHECK(length(document_id) = 16),
             kind        INTEGER NOT NULL CHECK(kind IN (0, 1)),
             chunk_key   BLOB NOT NULL CHECK(length(chunk_key) = 32),
             checksum    BLOB NOT NULL CHECK(length(checksum) = 32),
             bytes       BLOB NOT NULL CHECK(length(bytes) > 0),
             PRIMARY KEY(document_id, kind, chunk_key),
             FOREIGN KEY(document_id) REFERENCES documents(document_id) ON DELETE CASCADE
         );
         CREATE INDEX IF NOT EXISTS chunks_document_kind
             ON chunks(document_id, kind);",
    )?;
    if schema_version == 0 {
        transaction.pragma_update(None, "user_version", STORE_SCHEMA_VERSION)?;
    }
    transaction.commit()?;
    Ok(())
}

fn load_document(
    connection: &Connection,
    document_id: DocumentId,
) -> Result<Option<LoadedDocument>, StoreError> {
    let metadata = connection
        .query_row(
            "SELECT sequence, durable_heads, application_state
             FROM documents WHERE document_id = ?1",
            [document_id_bytes(document_id)],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            },
        )
        .optional()?;
    let Some((sequence, encoded_heads, application_state)) = metadata else {
        return Ok(None);
    };
    let sequence =
        u64::try_from(sequence).map_err(|_| StoreError::SequenceExhausted(document_id))?;
    let durable_heads = decode_heads(document_id, &encoded_heads)?;

    let mut statement = connection.prepare(
        "SELECT kind, chunk_key, checksum, bytes
         FROM chunks WHERE document_id = ?1
         ORDER BY kind ASC, chunk_key ASC",
    )?;
    let mut rows = statement.query([document_id_bytes(document_id)])?;
    let mut document = AutoCommit::new();
    let mut source_chunks = Vec::new();
    while let Some(row) = rows.next()? {
        let kind: i64 = row.get(0)?;
        let key: Vec<u8> = row.get(1)?;
        let checksum: Vec<u8> = row.get(2)?;
        let bytes: Vec<u8> = row.get(3)?;
        let content_hash = sha256(&bytes);
        if checksum.as_slice() != content_hash {
            return Err(StoreError::ChunkChecksumMismatch {
                document_id,
                chunk_key: hex_hash(&key),
            });
        }
        match kind {
            CHUNK_KIND_SNAPSHOT => {
                let mut snapshot = AutoCommit::load(&bytes)?;
                let snapshot_key = heads_hash(&canonical_heads(&snapshot.get_heads()));
                if key.as_slice() != snapshot_key {
                    return Err(StoreError::ChunkKeyMismatch {
                        document_id,
                        chunk_key: hex_hash(&key),
                    });
                }
            }
            CHUNK_KIND_INCREMENTAL if key.as_slice() != content_hash => {
                return Err(StoreError::ChunkKeyMismatch {
                    document_id,
                    chunk_key: hex_hash(&key),
                });
            }
            CHUNK_KIND_INCREMENTAL => {}
            _ => {
                return Err(StoreError::ChunkKeyMismatch {
                    document_id,
                    chunk_key: hex_hash(&key),
                });
            }
        }
        document.load_incremental(&bytes)?;
        source_chunks.push(ChunkIdentity { kind, key });
    }
    drop(rows);
    drop(statement);

    if source_chunks.is_empty() {
        return Err(StoreError::MissingChunks(document_id));
    }
    if canonical_heads(&document.get_heads()) != durable_heads {
        return Err(StoreError::DurableHeadsMismatch(document_id));
    }

    Ok(Some(LoadedDocument {
        document,
        durable_heads,
        application_state,
        sequence,
        source_chunks,
    }))
}

fn update_document_row(
    connection: &Connection,
    document_id: DocumentId,
    sequence: u64,
    durable_heads: &[ChangeHash],
    application_state: &[u8],
) -> Result<(), StoreError> {
    let sequence =
        i64::try_from(sequence).map_err(|_| StoreError::SequenceExhausted(document_id))?;
    connection.execute(
        "INSERT INTO documents(document_id, sequence, durable_heads, application_state)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(document_id) DO UPDATE SET
             sequence = excluded.sequence,
             durable_heads = excluded.durable_heads,
             application_state = excluded.application_state",
        params![
            document_id_bytes(document_id),
            sequence,
            encode_heads(durable_heads),
            application_state
        ],
    )?;
    Ok(())
}

fn insert_incremental_chunk(
    connection: &Connection,
    document_id: DocumentId,
    bytes: &[u8],
) -> Result<(), StoreError> {
    let content_hash = sha256(bytes);
    insert_chunk(
        connection,
        document_id,
        CHUNK_KIND_INCREMENTAL,
        &content_hash,
        &content_hash,
        bytes,
    )
}

fn insert_snapshot_chunk(
    connection: &Connection,
    document_id: DocumentId,
    bytes: &[u8],
    heads: &[ChangeHash],
) -> Result<Vec<u8>, StoreError> {
    let key = heads_hash(heads).to_vec();
    let checksum = sha256(bytes);
    insert_chunk(
        connection,
        document_id,
        CHUNK_KIND_SNAPSHOT,
        &key,
        &checksum,
        bytes,
    )?;
    Ok(key)
}

fn insert_chunk(
    connection: &Connection,
    document_id: DocumentId,
    kind: i64,
    key: &[u8],
    checksum: &[u8],
    bytes: &[u8],
) -> Result<(), StoreError> {
    connection.execute(
        "INSERT OR IGNORE INTO chunks(document_id, kind, chunk_key, checksum, bytes)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![document_id_bytes(document_id), kind, key, checksum, bytes],
    )?;
    Ok(())
}

fn next_sequence(document_id: DocumentId, current: u64) -> Result<u64, StoreError> {
    current
        .checked_add(1)
        .filter(|sequence| i64::try_from(*sequence).is_ok())
        .ok_or(StoreError::SequenceExhausted(document_id))
}

fn canonical_heads(heads: &[ChangeHash]) -> Vec<ChangeHash> {
    let mut heads = heads.to_vec();
    heads.sort_unstable_by_key(|head| head.0);
    heads
}

fn encode_heads(heads: &[ChangeHash]) -> Vec<u8> {
    canonical_heads(heads)
        .into_iter()
        .flat_map(|head| head.0)
        .collect()
}

fn decode_heads(document_id: DocumentId, bytes: &[u8]) -> Result<Vec<ChangeHash>, StoreError> {
    if !bytes.len().is_multiple_of(HASH_BYTES) {
        return Err(StoreError::InvalidHeadsEncoding {
            document_id,
            actual: bytes.len(),
        });
    }
    let mut heads = bytes
        .chunks_exact(HASH_BYTES)
        .map(|chunk| {
            let mut hash = [0_u8; HASH_BYTES];
            hash.copy_from_slice(chunk);
            ChangeHash(hash)
        })
        .collect::<Vec<_>>();
    if heads.windows(2).any(|pair| pair[0] >= pair[1]) {
        return Err(StoreError::DuplicateDurableHeads(document_id));
    }
    heads.shrink_to_fit();
    Ok(heads)
}

fn heads_hash(heads: &[ChangeHash]) -> [u8; HASH_BYTES] {
    sha256(&encode_heads(heads))
}

fn sha256(bytes: &[u8]) -> [u8; HASH_BYTES] {
    Sha256::digest(bytes).into()
}

fn document_id_bytes(document_id: DocumentId) -> [u8; 16] {
    *document_id.0.as_bytes()
}

fn hex_hash(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::{transaction::Transactable, ActorId, ReadDoc, ROOT};
    use std::sync::{Arc, Barrier};
    use tempfile::TempDir;

    struct TestStore {
        _directory: TempDir,
        path: std::path::PathBuf,
        store: SqliteDocumentStore,
    }

    impl TestStore {
        fn new() -> Self {
            let directory = tempfile::tempdir()
                .unwrap_or_else(|error| panic!("create document store test directory: {error}"));
            let path = directory.path().join("documents.sqlite");
            let store = SqliteDocumentStore::open(&path)
                .unwrap_or_else(|error| panic!("open document store: {error}"));
            Self {
                _directory: directory,
                path,
                store,
            }
        }

        fn chunk_count(&self, document_id: DocumentId) -> usize {
            let connection = self.store.lock_connection();
            connection
                .query_row(
                    "SELECT COUNT(*) FROM chunks WHERE document_id = ?1",
                    [document_id_bytes(document_id)],
                    |row| row.get(0),
                )
                .unwrap_or_else(|error| panic!("count chunks: {error}"))
        }
    }

    fn actor(label: &[u8]) -> ActorId {
        ActorId::from(label)
    }

    fn seed_document() -> AutoCommit {
        let mut document = AutoCommit::new().with_actor(actor(b"seed"));
        document
            .put(ROOT, "base", "present")
            .unwrap_or_else(|error| panic!("seed document: {error}"));
        document
    }

    fn install(
        store: &SqliteDocumentStore,
        document_id: DocumentId,
        document: &mut AutoCommit,
        application_state: &[u8],
    ) -> CommitReceipt {
        let heads = document.get_heads();
        let snapshot = document.save();
        store
            .install_snapshot(document_id, &snapshot, &heads, application_state)
            .unwrap_or_else(|error| panic!("install snapshot: {error}"))
    }

    fn load_doc(store: &SqliteDocumentStore, document_id: DocumentId) -> StoredDocument {
        store
            .load(document_id)
            .unwrap_or_else(|error| panic!("load document: {error}"))
            .unwrap_or_else(|| panic!("document {document_id} should exist"))
    }

    #[test]
    fn sqlite_uses_full_synchronous_wal() {
        let test = TestStore::new();
        let connection = test.store.lock_connection();
        let journal_mode: String = connection
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("read journal mode: {error}"));
        let synchronous: i64 = connection
            .query_row("PRAGMA synchronous", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("read synchronous mode: {error}"));
        let schema_version: i64 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap_or_else(|error| panic!("read schema version: {error}"));

        assert_eq!(journal_mode.to_ascii_lowercase(), "wal");
        assert_eq!(synchronous, 2, "SQLite FULL synchronous mode is 2");
        assert_eq!(schema_version, STORE_SCHEMA_VERSION);
    }

    #[test]
    fn newer_store_schema_is_rejected() {
        let directory = tempfile::tempdir()
            .unwrap_or_else(|error| panic!("create schema test directory: {error}"));
        let path = directory.path().join("documents.sqlite");
        let connection =
            Connection::open(&path).unwrap_or_else(|error| panic!("open future store: {error}"));
        connection
            .pragma_update(None, "user_version", STORE_SCHEMA_VERSION + 1)
            .unwrap_or_else(|error| panic!("set future schema version: {error}"));
        drop(connection);

        let result = SqliteDocumentStore::open(&path);
        assert!(matches!(
            result,
            Err(StoreError::UnsupportedSchemaVersion {
                actual,
                supported
            }) if actual == STORE_SCHEMA_VERSION + 1 && supported == STORE_SCHEMA_VERSION
        ));
    }

    #[test]
    fn snapshot_and_incremental_round_trip() {
        let test = TestStore::new();
        let document_id = DocumentId::new(Uuid::new_v4());
        let mut document = seed_document();
        let base_heads = document.get_heads();
        let installed = install(&test.store, document_id, &mut document, b"source-v1");

        document
            .put(ROOT, "next", 42_i64)
            .unwrap_or_else(|error| panic!("change document: {error}"));
        let receipt = test
            .store
            .commit(CommitRequest {
                document_id,
                changes: document.get_changes(&base_heads),
                application_state: b"source-v2".to_vec(),
            })
            .unwrap_or_else(|error| panic!("commit increment: {error}"));
        let stored = load_doc(&test.store, document_id);
        let loaded = AutoCommit::load(&stored.snapshot)
            .unwrap_or_else(|error| panic!("materialize stored document: {error}"));

        assert_eq!(installed.sequence, 1);
        assert_eq!(receipt.sequence, 2);
        assert_eq!(stored.durable_heads, canonical_heads(&document.get_heads()));
        assert_eq!(stored.application_state, b"source-v2");
        assert!(loaded.get(ROOT, "base").is_ok_and(|value| value.is_some()));
        assert!(loaded.get(ROOT, "next").is_ok_and(|value| value.is_some()));
    }

    #[test]
    fn duplicate_and_overlapping_batches_are_idempotent() {
        let test = TestStore::new();
        let document_id = DocumentId::new(Uuid::new_v4());
        let mut document = seed_document();
        let base_heads = document.get_heads();
        install(&test.store, document_id, &mut document, b"v1");

        document
            .put(ROOT, "first", 1_i64)
            .unwrap_or_else(|error| panic!("first change: {error}"));
        let first_batch = document.get_changes(&base_heads);
        let first = test
            .store
            .commit(CommitRequest {
                document_id,
                changes: first_batch.clone(),
                application_state: b"v2".to_vec(),
            })
            .unwrap_or_else(|error| panic!("first commit: {error}"));
        let duplicate = test
            .store
            .commit(CommitRequest {
                document_id,
                changes: first_batch,
                application_state: b"v2".to_vec(),
            })
            .unwrap_or_else(|error| panic!("duplicate commit: {error}"));

        document
            .put(ROOT, "second", 2_i64)
            .unwrap_or_else(|error| panic!("second change: {error}"));
        let overlap = test
            .store
            .commit(CommitRequest {
                document_id,
                changes: document.get_changes(&base_heads),
                application_state: b"v3".to_vec(),
            })
            .unwrap_or_else(|error| panic!("overlapping commit: {error}"));

        assert!(!duplicate.newly_persisted);
        assert_eq!(duplicate.sequence, first.sequence);
        assert!(overlap.newly_persisted);
        assert_eq!(overlap.sequence, first.sequence + 1);
        assert_eq!(test.chunk_count(document_id), 3);
        assert_eq!(load_doc(&test.store, document_id).application_state, b"v3");
    }

    #[test]
    fn independent_store_instances_merge_concurrent_branches_without_loss() {
        let test = TestStore::new();
        let second_store = SqliteDocumentStore::open(&test.path)
            .unwrap_or_else(|error| panic!("open second document store: {error}"));
        let document_id = DocumentId::new(Uuid::new_v4());
        let mut seed = seed_document();
        let base_heads = seed.get_heads();
        let base_snapshot = seed.save();
        install(&test.store, document_id, &mut seed, b"base");

        let mut left = AutoCommit::load(&base_snapshot)
            .unwrap_or_else(|error| panic!("load left branch: {error}"))
            .with_actor(actor(b"left"));
        let mut right = AutoCommit::load(&base_snapshot)
            .unwrap_or_else(|error| panic!("load right branch: {error}"))
            .with_actor(actor(b"right"));
        left.put(ROOT, "left", true)
            .unwrap_or_else(|error| panic!("left change: {error}"));
        right
            .put(ROOT, "right", true)
            .unwrap_or_else(|error| panic!("right change: {error}"));
        let left_changes = left.get_changes(&base_heads);
        let right_changes = right.get_changes(&base_heads);
        let barrier = Arc::new(Barrier::new(2));
        let first_store = &test.store;
        let second_store = &second_store;
        let (left_receipt, right_receipt) = std::thread::scope(|scope| {
            let left_barrier = Arc::clone(&barrier);
            let left = scope.spawn(move || {
                left_barrier.wait();
                first_store.commit(CommitRequest {
                    document_id,
                    changes: left_changes,
                    application_state: b"left".to_vec(),
                })
            });
            let right_barrier = Arc::clone(&barrier);
            let right = scope.spawn(move || {
                right_barrier.wait();
                second_store.commit(CommitRequest {
                    document_id,
                    changes: right_changes,
                    application_state: b"right".to_vec(),
                })
            });
            let left = left
                .join()
                .unwrap_or_else(|_| panic!("left store thread panicked"))
                .unwrap_or_else(|error| panic!("commit left branch: {error}"));
            let right = right
                .join()
                .unwrap_or_else(|_| panic!("right store thread panicked"))
                .unwrap_or_else(|error| panic!("commit right branch: {error}"));
            (left, right)
        });

        let stored = load_doc(&test.store, document_id);
        let merged = AutoCommit::load(&stored.snapshot)
            .unwrap_or_else(|error| panic!("load merged document: {error}"));
        let newest_receipt = if left_receipt.sequence > right_receipt.sequence {
            left_receipt
        } else {
            right_receipt
        };
        assert_eq!(stored.durable_heads, newest_receipt.durable_heads);
        assert_eq!(stored.durable_heads.len(), 2);
        assert!(merged.get(ROOT, "left").is_ok_and(|value| value.is_some()));
        assert!(merged.get(ROOT, "right").is_ok_and(|value| value.is_some()));
    }

    #[test]
    fn invalid_dependent_change_rolls_back_history_and_application_state() {
        let test = TestStore::new();
        let document_id = DocumentId::new(Uuid::new_v4());
        let mut stored = seed_document();
        let durable_heads = stored.get_heads();
        install(&test.store, document_id, &mut stored, b"stable");
        let chunks_before = test.chunk_count(document_id);

        let mut incomplete = AutoCommit::load(&stored.save())
            .unwrap_or_else(|error| panic!("load incomplete branch: {error}"))
            .with_actor(actor(b"incomplete"));
        incomplete
            .put(ROOT, "dependency", 1_i64)
            .unwrap_or_else(|error| panic!("dependency change: {error}"));
        let dependency_heads = incomplete.get_heads();
        incomplete
            .put(ROOT, "dependent", 2_i64)
            .unwrap_or_else(|error| panic!("dependent change: {error}"));
        let dependent_only = incomplete.get_changes(&dependency_heads);

        let result = test.store.commit(CommitRequest {
            document_id,
            changes: dependent_only,
            application_state: b"must-not-land".to_vec(),
        });
        assert!(
            result.is_err(),
            "incomplete batch unexpectedly committed: {result:?}"
        );

        let reloaded = load_doc(&test.store, document_id);
        assert_eq!(reloaded.application_state, b"stable");
        assert_eq!(reloaded.durable_heads, canonical_heads(&durable_heads));
        assert_eq!(reloaded.sequence, 1);
        assert_eq!(test.chunk_count(document_id), chunks_before);
    }

    #[test]
    fn install_never_replaces_existing_authoritative_state() {
        let test = TestStore::new();
        let document_id = DocumentId::new(Uuid::new_v4());
        let mut original = seed_document();
        let original_receipt = install(&test.store, document_id, &mut original, b"original");

        let idempotent = install(&test.store, document_id, &mut original, b"original");
        assert!(!idempotent.newly_persisted);
        assert_eq!(idempotent.sequence, original_receipt.sequence);

        let before = original.get_heads();
        original
            .put(ROOT, "replacement", true)
            .unwrap_or_else(|error| panic!("replacement change: {error}"));
        let replacement = original.save();
        let replacement_heads = original.get_heads();
        let result = test.store.install_snapshot(
            document_id,
            &replacement,
            &replacement_heads,
            b"replacement",
        );
        assert!(matches!(result, Err(StoreError::InstallConflict(id)) if id == document_id));

        let stored = load_doc(&test.store, document_id);
        assert_eq!(stored.durable_heads, canonical_heads(&before));
        assert_eq!(stored.application_state, b"original");
        assert_eq!(stored.sequence, original_receipt.sequence);
    }

    #[test]
    fn corrupted_chunk_is_rejected_before_materialization() {
        let test = TestStore::new();
        let document_id = DocumentId::new(Uuid::new_v4());
        let mut document = seed_document();
        install(&test.store, document_id, &mut document, b"state");

        {
            let connection = test.store.lock_connection();
            connection
                .execute(
                    "UPDATE chunks SET bytes = ?2 WHERE document_id = ?1",
                    params![document_id_bytes(document_id), b"corrupt".as_slice()],
                )
                .unwrap_or_else(|error| panic!("corrupt chunk: {error}"));
        }

        let result = test.store.load(document_id);
        assert!(matches!(
            result,
            Err(StoreError::ChunkChecksumMismatch { .. })
        ));
    }

    #[test]
    fn compaction_replaces_only_loaded_chunks_and_preserves_state() {
        let test = TestStore::new();
        let document_id = DocumentId::new(Uuid::new_v4());
        let mut document = seed_document();
        install(&test.store, document_id, &mut document, b"v1");

        for index in 0_i64..4 {
            let before = document.get_heads();
            document
                .put(ROOT, format!("value-{index}"), index)
                .unwrap_or_else(|error| panic!("change {index}: {error}"));
            test.store
                .commit(CommitRequest {
                    document_id,
                    changes: document.get_changes(&before),
                    application_state: format!("v{}", index + 2).into_bytes(),
                })
                .unwrap_or_else(|error| panic!("commit {index}: {error}"));
        }
        let before = load_doc(&test.store, document_id);
        assert_eq!(test.chunk_count(document_id), 5);

        let compacted = test
            .store
            .compact(document_id)
            .unwrap_or_else(|error| panic!("compact document: {error}"));
        let after = load_doc(&test.store, document_id);

        assert_eq!(compacted.removed_chunks, 5);
        assert_eq!(test.chunk_count(document_id), 1);
        assert_eq!(after.durable_heads, before.durable_heads);
        assert_eq!(after.application_state, before.application_state);
        assert_eq!(after.sequence, before.sequence);
        let compacted_doc = AutoCommit::load(&after.snapshot)
            .unwrap_or_else(|error| panic!("load compacted document: {error}"));
        for index in 0_i64..4 {
            assert!(compacted_doc
                .get(ROOT, format!("value-{index}"))
                .is_ok_and(|value| value.is_some()));
        }
    }
}
