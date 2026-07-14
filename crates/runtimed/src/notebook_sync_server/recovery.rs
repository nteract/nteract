//! Crash-safe, append-only recovery journal primitives for file-backed rooms.
//!
//! The journal stores complete Automerge snapshots rather than incremental
//! changes. Each record is independently checksummed, so recovery can stop at
//! a torn or corrupt tail and use the last complete record. Callers must
//! serialize append and compaction operations for a journal path.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::paths::notebook_doc_filename;

const RECORD_MAGIC: [u8; 8] = *b"NTRJNL01";
const RECORD_FORMAT_VERSION: u16 = 1;
pub(crate) const RECOVERY_MANIFEST_VERSION: u16 = 1;

const HEADER_PREFIX_LEN: usize = 8 + 2 + 4 + 8;
const CHECKSUM_LEN: usize = 32;
const HEADER_LEN: usize = HEADER_PREFIX_LEN + CHECKSUM_LEN;
const MAX_MANIFEST_BYTES: usize = 256 * 1024;
const MAX_AUTOMERGE_SNAPSHOT_BYTES: usize = 256 * 1024 * 1024;
const MAX_RECORD_BYTES: usize = HEADER_LEN + MAX_MANIFEST_BYTES + MAX_AUTOMERGE_SNAPSHOT_BYTES;
/// Full snapshots keep recovery simple and independently checksummed, but the
/// active journal must remain bounded on mutation-heavy rooms.
const COMPACT_AFTER_RECORDS: usize = 32;
const COMPACT_AFTER_BYTES: u64 = 64 * 1024 * 1024;

/// SHA-256 of the exact source `.ipynb` bytes associated with a recovery
/// generation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub(crate) struct SourceFingerprint([u8; 32]);

impl SourceFingerprint {
    pub(crate) fn from_content(bytes: &[u8]) -> Self {
        Self(Sha256::digest(bytes).into())
    }

    pub(crate) fn to_hex(self) -> String {
        hex::encode(self.0)
    }

    /// Raw digest bytes, for comparison against externally tracked disk
    /// hashes (the watcher classifier's known-disk-hash guard).
    pub(crate) fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// Compute the content fingerprint used to distinguish a matching source file
/// from an externally edited one.
pub(crate) fn source_fingerprint(bytes: &[u8]) -> SourceFingerprint {
    SourceFingerprint::from_content(bytes)
}

/// Durable progress of the file-backed source generation represented by a
/// journal record. This is independent from whether a previous process had
/// already exposed all batches to its then-connected peers.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum RecoverySourcePhase {
    /// No immutable source generation has reached the journal yet.
    #[default]
    Pending,
    /// The exact staged source changes are durable. Restart may finalize this
    /// generation, but must not regenerate it with a new actor/history.
    DurablyStaged,
    /// Source publication and its runtime-sidecar reconstruction completed.
    Ready,
    /// A source task failed before becoming durably staged.
    Failed,
}

/// Durable intent written before atomically replacing a notebook file.
///
/// A crash can otherwise leave the new `.ipynb` bytes visible while the
/// journal still names the previous fingerprint, manufacturing a source
/// conflict on restart. Recovery accepts either the old fingerprint (replace
/// never happened) or this intended fingerprint (replace happened), then
/// appends the corresponding abort/final checkpoint marker.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct PendingFileCheckpoint {
    pub(crate) canonical_path: PathBuf,
    pub(crate) file_fingerprint: SourceFingerprint,
    pub(crate) exported_heads: Vec<[u8; 32]>,
    pub(crate) save_sequence: u64,
    #[serde(default)]
    pub(crate) source_generation: Option<u64>,
}

/// Versioned causal metadata stored beside every full Automerge snapshot.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RecoveryManifest {
    pub(crate) version: u16,
    pub(crate) sequence: u64,
    pub(crate) notebook_id: Uuid,
    pub(crate) canonical_path: Option<PathBuf>,
    /// NotebookDoc schema version represented by `automerge_snapshot`.
    /// This is independent from the journal manifest and record formats.
    pub(crate) notebook_schema_version: u64,
    pub(crate) source_fingerprint: SourceFingerprint,
    pub(crate) source_generation: u64,
    #[serde(default)]
    pub(crate) source_phase: RecoverySourcePhase,
    pub(crate) staged_change_hashes: Vec<[u8; 32]>,
    /// Peer-authored changes durably accepted after (or concurrently with)
    /// source publication. Recovery uses this evidence to forbid implicit
    /// source regeneration over collaborative work.
    #[serde(default)]
    pub(crate) peer_change_hashes: Vec<[u8; 32]>,
    pub(crate) durable_heads: Vec<[u8; 32]>,
    pub(crate) exported_heads: Vec<[u8; 32]>,
    #[serde(default)]
    pub(crate) file_save_sequence: Option<u64>,
    #[serde(default)]
    pub(crate) pending_file_checkpoint: Option<PendingFileCheckpoint>,
}

impl RecoveryManifest {
    pub(crate) fn new(
        sequence: u64,
        notebook_id: Uuid,
        canonical_path: Option<PathBuf>,
        notebook_schema_version: u64,
        source_fingerprint: SourceFingerprint,
        source_generation: u64,
    ) -> Self {
        Self {
            version: RECOVERY_MANIFEST_VERSION,
            sequence,
            notebook_id,
            canonical_path,
            notebook_schema_version,
            source_fingerprint,
            source_generation,
            source_phase: RecoverySourcePhase::Pending,
            staged_change_hashes: Vec::new(),
            peer_change_hashes: Vec::new(),
            durable_heads: Vec::new(),
            exported_heads: Vec::new(),
            file_save_sequence: None,
            pending_file_checkpoint: None,
        }
    }

    fn validate(&self) -> Result<(), RecoveryJournalError> {
        if self.version != RECOVERY_MANIFEST_VERSION {
            return Err(RecoveryJournalError::UnsupportedManifestVersion {
                version: self.version,
            });
        }
        Ok(())
    }
}

/// One independently recoverable journal record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryRecord {
    pub(crate) manifest: RecoveryManifest,
    pub(crate) automerge_snapshot: Vec<u8>,
}

/// A corrupt or incomplete suffix ignored after the newest valid record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum JournalTailIssue {
    TruncatedHeader {
        offset: u64,
        available: u64,
    },
    InvalidMagic {
        offset: u64,
    },
    UnsupportedRecordVersion {
        offset: u64,
        version: u16,
    },
    InvalidLengths {
        offset: u64,
        manifest_len: u64,
        snapshot_len: u64,
    },
    TruncatedPayload {
        offset: u64,
        expected: u64,
        available: u64,
    },
    ChecksumMismatch {
        offset: u64,
    },
    InvalidManifest {
        offset: u64,
        reason: String,
    },
    UnsupportedManifestVersion {
        offset: u64,
        version: u16,
    },
}

impl JournalTailIssue {
    fn is_unsupported_version(&self) -> bool {
        matches!(
            self,
            Self::UnsupportedRecordVersion { .. } | Self::UnsupportedManifestVersion { .. }
        )
    }

    /// Only byte-short EOF records are unambiguously torn appends. Semantic
    /// corruption (bad checksum/magic/manifest/length) may sit in the middle
    /// of otherwise valid data, so truncating it would silently destroy
    /// evidence and any valid suffix.
    pub(crate) fn is_repairable_torn_suffix(&self) -> bool {
        matches!(
            self,
            Self::TruncatedHeader { .. } | Self::TruncatedPayload { .. }
        )
    }
}

/// Why no complete recovery record could be returned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecoveryUnavailableReason {
    MissingJournal,
    EmptyJournal,
    NoValidRecord { tail: JournalTailIssue },
}

/// A valid record plus any ignored suffix that followed it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveredJournalRecord {
    pub(crate) record: RecoveryRecord,
    pub(crate) ignored_tail: Option<JournalTailIssue>,
}

/// Recovery classification against the exact bytes currently on disk.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecoveryLoadOutcome {
    Match(RecoveredJournalRecord),
    SourceConflict {
        recovery: RecoveredJournalRecord,
        current_source_fingerprint: SourceFingerprint,
    },
    Unavailable {
        reason: RecoveryUnavailableReason,
    },
}

/// Latest authoritative record from a journal, without comparing it to a
/// source file. This is used to recover the room identity when the auxiliary
/// path registry is missing or unavailable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecoveryLatestOutcome {
    Recovered(Box<RecoveredJournalRecord>),
    Unavailable { reason: RecoveryUnavailableReason },
}

/// Result of searching the room recovery directory for a canonical path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RecoveryJournalDiscovery {
    NotFound,
    Found {
        notebook_id: Uuid,
        journal_path: PathBuf,
    },
}

#[derive(Debug, Error)]
pub(crate) enum RecoveryJournalDiscoveryError {
    #[error("could not inspect recovery directory {directory}: {source}")]
    Directory {
        directory: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("could not inspect recovery journal {journal}: {source}")]
    Journal {
        journal: PathBuf,
        #[source]
        source: Box<RecoveryJournalError>,
    },
    #[error(
        "recovery journal {journal} claims notebook {notebook_id}, but that identity belongs at {expected}"
    )]
    MisboundJournal {
        notebook_id: Uuid,
        journal: PathBuf,
        expected: PathBuf,
    },
    #[error(
        "multiple recovery journals claim canonical notebook path {canonical_path}: {candidates:?}"
    )]
    AmbiguousPath {
        canonical_path: PathBuf,
        candidates: Vec<(Uuid, PathBuf)>,
    },
}

/// The durably published copy of an archived recovery journal.
///
/// Archives are directories so the authoritative journal and its optional
/// manifest sidecar become visible under one unique path at the same instant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryArchivePaths {
    pub(crate) directory: PathBuf,
    pub(crate) journal: PathBuf,
    pub(crate) manifest: Option<PathBuf>,
}

/// Result of preserving the old active journal and atomically replacing it
/// with one reconciled record. The active name is never intentionally absent
/// at a successful boundary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RecoveryArchiveReplacement {
    pub(crate) archive: RecoveryArchivePaths,
    pub(crate) durability_warning: Option<String>,
}

#[derive(Debug, Error)]
pub(crate) enum RecoveryJournalError {
    #[error("recovery journal I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("recovery manifest serialization failed: {0}")]
    ManifestSerialization(#[from] serde_json::Error),
    #[error("unsupported recovery manifest version {version}")]
    UnsupportedManifestVersion { version: u16 },
    #[error("Automerge recovery snapshot is empty")]
    EmptySnapshot,
    #[error("recovery manifest is {actual} bytes; maximum is {maximum}")]
    ManifestTooLarge { actual: usize, maximum: usize },
    #[error("Automerge recovery snapshot is {actual} bytes; maximum is {maximum}")]
    SnapshotTooLarge { actual: usize, maximum: usize },
    #[error("encoded recovery record is {actual} bytes; maximum is {maximum}")]
    RecordTooLarge { actual: usize, maximum: usize },
    #[error("journal contains no valid record before corrupt tail: {tail:?}")]
    NoValidRecord { tail: JournalTailIssue },
    #[error("refusing to rewrite recovery data from a newer format: {tail:?}")]
    UnsupportedTailVersion { tail: JournalTailIssue },
    #[error("refusing to truncate corrupt recovery data without reconciliation: {tail:?}")]
    CorruptTailRequiresReconciliation { tail: JournalTailIssue },
    #[error(
        "recovery archive was published at {archive:?}, but the active journal was not retired: {source}"
    )]
    ArchiveNotCommitted {
        archive: RecoveryArchivePaths,
        #[source]
        source: io::Error,
    },
}

/// Filesystem-backed append-only journal.
#[derive(Debug, Clone)]
pub(crate) struct RecoveryJournal {
    path: PathBuf,
    /// Process-local append cursor. The journal path is room-owned, and clones
    /// share this cache so ordinary appends do not re-read and re-hash every
    /// previous full snapshot. A length or modification-time mismatch forces
    /// a complete rescan, preserving externally corrupted same-length data.
    append_cursor: Arc<Mutex<Option<JournalAppendCursor>>>,
}

#[derive(Debug, Clone, Copy)]
struct JournalAppendCursor {
    file_len: u64,
    modified: Option<std::time::SystemTime>,
    last_valid_end: u64,
    valid_record_count: usize,
}

impl RecoveryJournal {
    pub(crate) fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            append_cursor: Arc::new(Mutex::new(None)),
        }
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Atomically replaced index for the newest committed journal record.
    ///
    /// The append-only journal remains the recovery authority. This sidecar
    /// makes the latest identity/fingerprint/head metadata directly
    /// inspectable without weakening torn-tail recovery: it is replaced only
    /// after the corresponding checksummed record has been flushed.
    pub(crate) fn manifest_path(&self) -> PathBuf {
        let file_name = self
            .path
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| "room.recovery".to_string());
        self.path
            .with_file_name(format!("{file_name}.manifest.json"))
    }

    /// Append one full snapshot and flush it before returning.
    ///
    /// A torn suffix after an older valid record is truncated and flushed
    /// before the new record is written. A wholly corrupt journal or a record
    /// from a newer format is never overwritten implicitly.
    pub(crate) fn append(
        &self,
        manifest: &RecoveryManifest,
        automerge_snapshot: &[u8],
    ) -> Result<(), RecoveryJournalError> {
        self.append_with_directory_sync(manifest, automerge_snapshot, sync_directory)
    }

    fn append_with_directory_sync<SyncDirectory>(
        &self,
        manifest: &RecoveryManifest,
        automerge_snapshot: &[u8],
        mut sync_directory: SyncDirectory,
    ) -> Result<(), RecoveryJournalError>
    where
        SyncDirectory: FnMut(&Path) -> io::Result<()>,
    {
        let mut append_cursor = self
            .append_cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let encoded = encode_record(manifest, automerge_snapshot)?;
        ensure_parent_directory(&self.path)?;

        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&self.path)?;

        // Establish the complete directory chain and the new journal name
        // before writing its first record. An unsuccessful directory flush
        // leaves the file empty, so the next append retries every required
        // flush instead of mistaking mere pathname existence for durability.
        let metadata = file.metadata()?;
        if metadata.len() == 0 {
            sync_pathname_directory_chain(&self.path, &mut sync_directory)?;
        }
        let file_len = metadata.len();
        let file_modified = metadata.modified().ok();
        let (last_valid_end, valid_record_count, ignored_tail) =
            match append_cursor.as_ref().filter(|cursor| {
                cursor.file_len == file_len
                    && cursor.modified.is_some()
                    && cursor.modified == file_modified
            }) {
                Some(cursor) => (cursor.last_valid_end, cursor.valid_record_count, None),
                None => {
                    let scan = scan_file(&mut file)?;
                    (
                        scan.last_valid_end,
                        scan.valid_record_count,
                        scan.ignored_tail,
                    )
                }
            };

        if let Some(tail) = &ignored_tail {
            if tail.is_unsupported_version() {
                return Err(RecoveryJournalError::UnsupportedTailVersion { tail: tail.clone() });
            }
            if valid_record_count == 0 {
                return Err(RecoveryJournalError::NoValidRecord { tail: tail.clone() });
            }
            if !tail.is_repairable_torn_suffix() {
                return Err(RecoveryJournalError::CorruptTailRequiresReconciliation {
                    tail: tail.clone(),
                });
            }
            file.set_len(last_valid_end)?;
            file.sync_all()?;
        }

        let start_offset = last_valid_end;
        file.seek(SeekFrom::Start(start_offset))?;
        file.write_all(&encoded.bytes)?;
        file.sync_all()?;
        drop(file);

        // The record above is the durable batch marker. The manifest is only
        // an inspectability index, so its replacement is deliberately
        // best-effort after that commit point. A failure here is logged, not
        // returned: returning an error would invite callers to roll back an
        // already durable batch and let restart replay work that was never
        // acknowledged.
        if let Err(error) = serde_json::to_vec(manifest)
            .map_err(RecoveryJournalError::from)
            .and_then(|bytes| {
                replace_file_atomically(&self.manifest_path(), &bytes)
                    .map_err(RecoveryJournalError::from)
            })
        {
            tracing::warn!(
                "[notebook-sync] Recovery journal manifest sidecar update failed for {}: {}",
                self.path.display(),
                error
            );
        }

        let encoded_len = u64::try_from(encoded.bytes.len()).map_err(|_| {
            RecoveryJournalError::RecordTooLarge {
                actual: encoded.bytes.len(),
                maximum: MAX_RECORD_BYTES,
            }
        })?;
        let appended_end = start_offset + encoded_len;
        let appended_record_count = valid_record_count.saturating_add(1);
        let should_compact =
            appended_record_count >= COMPACT_AFTER_RECORDS || appended_end >= COMPACT_AFTER_BYTES;
        let (active_end, active_record_count) = if should_compact {
            // The just-appended record is already the newest complete record.
            // Replacing the active file with those same encoded bytes is a
            // crash-safe production compaction and avoids a second full scan.
            match replace_file_atomically(&self.path, &encoded.bytes) {
                Ok(()) => (encoded_len, 1),
                Err(error) => {
                    // The append above is already the durable commit point.
                    // Compaction is maintenance; failing it must not invite a
                    // caller to roll back a batch restart will replay.
                    tracing::warn!(
                        "[notebook-sync] Recovery journal compaction deferred for {}: {}",
                        self.path.display(),
                        error
                    );
                    (appended_end, appended_record_count)
                }
            }
        } else {
            (appended_end, appended_record_count)
        };
        *append_cursor = Some(JournalAppendCursor {
            file_len: active_end,
            modified: std::fs::metadata(&self.path)
                .and_then(|metadata| metadata.modified())
                .ok(),
            last_valid_end: active_end,
            valid_record_count: active_record_count,
        });

        Ok(())
    }

    /// Load the last complete valid record without consulting a source file.
    ///
    /// Identity discovery uses this authoritative scan rather than the
    /// best-effort manifest sidecar. A valid record followed by a torn tail is
    /// still recoverable and reports that tail on the returned record.
    pub(crate) fn latest_record(&self) -> Result<RecoveryLatestOutcome, RecoveryJournalError> {
        let mut file = match File::open(&self.path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok(RecoveryLatestOutcome::Unavailable {
                    reason: RecoveryUnavailableReason::MissingJournal,
                });
            }
            Err(error) => return Err(error.into()),
        };
        let scan = scan_file(&mut file)?;
        let Some(record) = scan.latest else {
            let reason = match scan.ignored_tail {
                Some(tail) => RecoveryUnavailableReason::NoValidRecord { tail },
                None => RecoveryUnavailableReason::EmptyJournal,
            };
            return Ok(RecoveryLatestOutcome::Unavailable { reason });
        };

        Ok(RecoveryLatestOutcome::Recovered(Box::new(
            RecoveredJournalRecord {
                record,
                ignored_tail: scan.ignored_tail,
            },
        )))
    }

    /// Load the last complete valid record and compare its source fingerprint
    /// with the exact current source bytes.
    pub(crate) fn load(
        &self,
        current_source_fingerprint: SourceFingerprint,
    ) -> Result<RecoveryLoadOutcome, RecoveryJournalError> {
        let recovery = match self.latest_record()? {
            RecoveryLatestOutcome::Recovered(recovery) => *recovery,
            RecoveryLatestOutcome::Unavailable { reason } => {
                return Ok(RecoveryLoadOutcome::Unavailable { reason });
            }
        };

        let matches_source = recovery.record.manifest.source_fingerprint
            == current_source_fingerprint
            || recovery
                .record
                .manifest
                .pending_file_checkpoint
                .as_ref()
                .is_some_and(|pending| pending.file_fingerprint == current_source_fingerprint);
        if matches_source {
            Ok(RecoveryLoadOutcome::Match(recovery))
        } else {
            Ok(RecoveryLoadOutcome::SourceConflict {
                recovery,
                current_source_fingerprint,
            })
        }
    }

    /// Preserve the current journal and sidecar in a uniquely published
    /// archive directory while leaving the active names untouched.
    fn publish_archive_copy(&self) -> Result<RecoveryArchivePaths, RecoveryJournalError> {
        match File::open(&self.path) {
            Ok(file) => drop(file),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err(RecoveryJournalError::Io(error));
            }
            Err(error) => return Err(error.into()),
        }

        let active_manifest = self.manifest_path();
        let manifest_present = active_manifest.try_exists()?;
        let (staging_directory, archive) =
            create_archive_staging_directory(&self.path, manifest_present)?;
        let staging_journal = staging_directory.join(
            archive
                .journal
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("room.recovery")),
        );
        let staging_manifest = archive.manifest.as_ref().map(|path| {
            staging_directory.join(
                path.file_name()
                    .unwrap_or_else(|| std::ffi::OsStr::new("room.recovery.manifest.json")),
            )
        });

        let stage_result = (|| {
            copy_file_durably(&self.path, &staging_journal)?;
            if let Some(staging_manifest) = &staging_manifest {
                copy_file_durably(&active_manifest, staging_manifest)?;
            }
            sync_directory(&staging_directory)?;
            std::fs::rename(&staging_directory, &archive.directory)?;
            sync_parent_directory(&archive.directory)
        })();

        if let Err(source) = stage_result {
            if staging_directory.exists() {
                let _ = std::fs::remove_dir_all(&staging_directory);
                return Err(source.into());
            }
            return Err(RecoveryJournalError::ArchiveNotCommitted { archive, source });
        }
        Ok(archive)
    }

    /// Preserve the current active journal, then atomically replace the active
    /// name with one reconciled record.
    ///
    /// The replacement bytes are fully encoded before the archive copy is
    /// published. A failure before atomic replacement leaves the old active
    /// journal in place; a failure reported after replacement is recognized by
    /// its exact bytes and returned as a durability warning. There is no
    /// successful or retryable boundary where the active name is absent.
    pub(crate) fn archive_and_replace(
        &self,
        manifest: &RecoveryManifest,
        automerge_snapshot: &[u8],
    ) -> Result<RecoveryArchiveReplacement, RecoveryJournalError> {
        self.archive_and_replace_with(manifest, automerge_snapshot, replace_file_atomically)
    }

    fn archive_and_replace_with<ReplaceActive>(
        &self,
        manifest: &RecoveryManifest,
        automerge_snapshot: &[u8],
        replace_active: ReplaceActive,
    ) -> Result<RecoveryArchiveReplacement, RecoveryJournalError>
    where
        ReplaceActive: FnOnce(&Path, &[u8]) -> io::Result<()>,
    {
        let mut append_guard = self
            .append_cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let encoded = encode_record(manifest, automerge_snapshot)?;
        let archive = self.publish_archive_copy()?;
        let durability_warning = match replace_active(&self.path, &encoded.bytes) {
            Ok(()) => None,
            Err(source) => {
                let replacement_is_active =
                    std::fs::read(&self.path).is_ok_and(|active| active == encoded.bytes);
                if !replacement_is_active {
                    return Err(RecoveryJournalError::ArchiveNotCommitted { archive, source });
                }
                Some(format!(
                    "reconciled journal replacement committed, but its directory flush failed: {source}"
                ))
            }
        };

        let encoded_len = u64::try_from(encoded.bytes.len()).map_err(|_| {
            RecoveryJournalError::RecordTooLarge {
                actual: encoded.bytes.len(),
                maximum: MAX_RECORD_BYTES,
            }
        })?;
        *append_guard = Some(JournalAppendCursor {
            file_len: encoded_len,
            modified: std::fs::metadata(&self.path)
                .and_then(|metadata| metadata.modified())
                .ok(),
            last_valid_end: encoded_len,
            valid_record_count: 1,
        });

        // The active journal is authoritative. Refreshing its inspectability
        // sidecar remains best-effort after the replacement commit point.
        if let Ok(manifest_bytes) = serde_json::to_vec(manifest) {
            let _ = replace_file_atomically(&self.manifest_path(), &manifest_bytes);
        }

        Ok(RecoveryArchiveReplacement {
            archive,
            durability_warning,
        })
    }
}

/// Find the UUID-owned recovery journal whose latest checksummed manifest
/// claims `canonical_path`.
///
/// This is deliberately a fallback for a missing path-registry entry. It scans
/// the authoritative `*.recovery` records and never trusts the optional JSON
/// manifest index. Multiple claims are a recovery conflict, not an invitation
/// to pick whichever directory entry happened to be visited first.
pub(crate) fn discover_journal_by_canonical_path(
    docs_dir: &Path,
    canonical_path: &Path,
) -> Result<RecoveryJournalDiscovery, RecoveryJournalDiscoveryError> {
    let entries = match std::fs::read_dir(docs_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RecoveryJournalDiscovery::NotFound);
        }
        Err(source) => {
            return Err(RecoveryJournalDiscoveryError::Directory {
                directory: docs_dir.to_path_buf(),
                source,
            });
        }
    };

    let mut journal_paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|source| RecoveryJournalDiscoveryError::Directory {
            directory: docs_dir.to_path_buf(),
            source,
        })?;
        let path = entry.path();
        if path
            .extension()
            .is_some_and(|extension| extension == "recovery")
        {
            journal_paths.push(path);
        }
    }
    journal_paths.sort();

    let mut candidates = Vec::new();
    for journal_path in journal_paths {
        let journal = RecoveryJournal::new(&journal_path);
        let recovery = match journal.latest_record() {
            Ok(RecoveryLatestOutcome::Recovered(recovery)) => recovery,
            Ok(RecoveryLatestOutcome::Unavailable {
                reason:
                    RecoveryUnavailableReason::MissingJournal | RecoveryUnavailableReason::EmptyJournal,
            }) => continue,
            Ok(RecoveryLatestOutcome::Unavailable {
                reason: RecoveryUnavailableReason::NoValidRecord { tail },
            }) => {
                return Err(RecoveryJournalDiscoveryError::Journal {
                    journal: journal_path,
                    source: Box::new(RecoveryJournalError::NoValidRecord { tail }),
                });
            }
            Err(source) => {
                return Err(RecoveryJournalDiscoveryError::Journal {
                    journal: journal_path,
                    source: Box::new(source),
                });
            }
        };

        let manifest = &recovery.record.manifest;
        if manifest.canonical_path.as_deref() != Some(canonical_path) {
            continue;
        }

        let expected = docs_dir
            .join(notebook_doc_filename(&manifest.notebook_id.to_string()))
            .with_extension("recovery");
        if journal_path != expected {
            return Err(RecoveryJournalDiscoveryError::MisboundJournal {
                notebook_id: manifest.notebook_id,
                journal: journal_path,
                expected,
            });
        }
        candidates.push((manifest.notebook_id, journal_path));
    }

    match candidates.len() {
        0 => Ok(RecoveryJournalDiscovery::NotFound),
        1 => {
            let (notebook_id, journal_path) = candidates.remove(0);
            Ok(RecoveryJournalDiscovery::Found {
                notebook_id,
                journal_path,
            })
        }
        _ => Err(RecoveryJournalDiscoveryError::AmbiguousPath {
            canonical_path: canonical_path.to_path_buf(),
            candidates,
        }),
    }
}

struct EncodedRecord {
    bytes: Vec<u8>,
}

fn encode_record(
    manifest: &RecoveryManifest,
    automerge_snapshot: &[u8],
) -> Result<EncodedRecord, RecoveryJournalError> {
    manifest.validate()?;
    if automerge_snapshot.is_empty() {
        return Err(RecoveryJournalError::EmptySnapshot);
    }
    if automerge_snapshot.len() > MAX_AUTOMERGE_SNAPSHOT_BYTES {
        return Err(RecoveryJournalError::SnapshotTooLarge {
            actual: automerge_snapshot.len(),
            maximum: MAX_AUTOMERGE_SNAPSHOT_BYTES,
        });
    }

    let manifest_bytes = serde_json::to_vec(manifest)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(RecoveryJournalError::ManifestTooLarge {
            actual: manifest_bytes.len(),
            maximum: MAX_MANIFEST_BYTES,
        });
    }

    let total_len = HEADER_LEN
        .checked_add(manifest_bytes.len())
        .and_then(|length| length.checked_add(automerge_snapshot.len()))
        .ok_or(RecoveryJournalError::RecordTooLarge {
            actual: usize::MAX,
            maximum: MAX_RECORD_BYTES,
        })?;
    if total_len > MAX_RECORD_BYTES {
        return Err(RecoveryJournalError::RecordTooLarge {
            actual: total_len,
            maximum: MAX_RECORD_BYTES,
        });
    }

    let manifest_len = u32::try_from(manifest_bytes.len()).map_err(|_| {
        RecoveryJournalError::ManifestTooLarge {
            actual: manifest_bytes.len(),
            maximum: MAX_MANIFEST_BYTES,
        }
    })?;
    let snapshot_len = u64::try_from(automerge_snapshot.len()).map_err(|_| {
        RecoveryJournalError::SnapshotTooLarge {
            actual: automerge_snapshot.len(),
            maximum: MAX_AUTOMERGE_SNAPSHOT_BYTES,
        }
    })?;

    let mut prefix = Vec::with_capacity(HEADER_PREFIX_LEN);
    prefix.extend_from_slice(&RECORD_MAGIC);
    prefix.extend_from_slice(&RECORD_FORMAT_VERSION.to_le_bytes());
    prefix.extend_from_slice(&manifest_len.to_le_bytes());
    prefix.extend_from_slice(&snapshot_len.to_le_bytes());

    let checksum = record_checksum(&prefix, &manifest_bytes, automerge_snapshot);
    let mut bytes = Vec::with_capacity(total_len);
    bytes.extend_from_slice(&prefix);
    bytes.extend_from_slice(&checksum);
    bytes.extend_from_slice(&manifest_bytes);
    bytes.extend_from_slice(automerge_snapshot);
    Ok(EncodedRecord { bytes })
}

struct JournalScan {
    latest: Option<RecoveryRecord>,
    ignored_tail: Option<JournalTailIssue>,
    last_valid_end: u64,
    file_len: u64,
    valid_record_count: usize,
}

fn scan_file(file: &mut File) -> Result<JournalScan, RecoveryJournalError> {
    let file_len = file.metadata()?.len();
    file.seek(SeekFrom::Start(0))?;

    let mut latest = None;
    let mut offset = 0_u64;
    let mut last_valid_end = 0_u64;
    let mut ignored_tail = None;
    let mut valid_record_count = 0_usize;

    while offset < file_len {
        let available_header = file_len - offset;
        if available_header < HEADER_LEN as u64 {
            ignored_tail = Some(JournalTailIssue::TruncatedHeader {
                offset,
                available: available_header,
            });
            break;
        }

        let mut header = [0_u8; HEADER_LEN];
        file.read_exact(&mut header)?;
        if header[..RECORD_MAGIC.len()] != RECORD_MAGIC {
            ignored_tail = Some(JournalTailIssue::InvalidMagic { offset });
            break;
        }

        let record_version = read_u16(&header[8..10]);
        if record_version != RECORD_FORMAT_VERSION {
            ignored_tail = Some(JournalTailIssue::UnsupportedRecordVersion {
                offset,
                version: record_version,
            });
            break;
        }

        let manifest_len = u64::from(read_u32(&header[10..14]));
        let snapshot_len = read_u64(&header[14..22]);
        let payload_len = match manifest_len.checked_add(snapshot_len) {
            Some(length)
                if manifest_len <= MAX_MANIFEST_BYTES as u64
                    && snapshot_len > 0
                    && snapshot_len <= MAX_AUTOMERGE_SNAPSHOT_BYTES as u64
                    && length <= (MAX_RECORD_BYTES - HEADER_LEN) as u64 =>
            {
                length
            }
            _ => {
                ignored_tail = Some(JournalTailIssue::InvalidLengths {
                    offset,
                    manifest_len,
                    snapshot_len,
                });
                break;
            }
        };

        let available_payload = file_len - offset - HEADER_LEN as u64;
        if available_payload < payload_len {
            ignored_tail = Some(JournalTailIssue::TruncatedPayload {
                offset,
                expected: payload_len,
                available: available_payload,
            });
            break;
        }

        let manifest_size =
            usize::try_from(manifest_len).map_err(|_| RecoveryJournalError::RecordTooLarge {
                actual: usize::MAX,
                maximum: MAX_RECORD_BYTES,
            })?;
        let snapshot_size =
            usize::try_from(snapshot_len).map_err(|_| RecoveryJournalError::RecordTooLarge {
                actual: usize::MAX,
                maximum: MAX_RECORD_BYTES,
            })?;
        let mut manifest_bytes = vec![0_u8; manifest_size];
        let mut automerge_snapshot = vec![0_u8; snapshot_size];
        file.read_exact(&mut manifest_bytes)?;
        file.read_exact(&mut automerge_snapshot)?;

        let expected_checksum: [u8; 32] = header[HEADER_PREFIX_LEN..HEADER_LEN]
            .try_into()
            .map_err(|_| RecoveryJournalError::RecordTooLarge {
                actual: HEADER_LEN,
                maximum: HEADER_LEN,
            })?;
        let actual_checksum = record_checksum(
            &header[..HEADER_PREFIX_LEN],
            &manifest_bytes,
            &automerge_snapshot,
        );
        if actual_checksum != expected_checksum {
            ignored_tail = Some(JournalTailIssue::ChecksumMismatch { offset });
            break;
        }

        let manifest: RecoveryManifest = match serde_json::from_slice(&manifest_bytes) {
            Ok(manifest) => manifest,
            Err(error) => {
                ignored_tail = Some(JournalTailIssue::InvalidManifest {
                    offset,
                    reason: error.to_string(),
                });
                break;
            }
        };
        if manifest.version != RECOVERY_MANIFEST_VERSION {
            ignored_tail = Some(JournalTailIssue::UnsupportedManifestVersion {
                offset,
                version: manifest.version,
            });
            break;
        }

        let record_len = HEADER_LEN as u64 + payload_len;
        last_valid_end = offset + record_len;
        offset = last_valid_end;
        latest = Some(RecoveryRecord {
            manifest,
            automerge_snapshot,
        });
        valid_record_count = valid_record_count.saturating_add(1);
    }

    Ok(JournalScan {
        latest,
        ignored_tail,
        last_valid_end,
        file_len,
        valid_record_count,
    })
}

fn record_checksum(prefix: &[u8], manifest: &[u8], snapshot: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(prefix);
    hasher.update(manifest);
    hasher.update(snapshot);
    hasher.finalize().into()
}

fn read_u16(bytes: &[u8]) -> u16 {
    let mut value = [0_u8; 2];
    value.copy_from_slice(bytes);
    u16::from_le_bytes(value)
}

fn read_u32(bytes: &[u8]) -> u32 {
    let mut value = [0_u8; 4];
    value.copy_from_slice(bytes);
    u32::from_le_bytes(value)
}

fn read_u64(bytes: &[u8]) -> u64 {
    let mut value = [0_u8; 8];
    value.copy_from_slice(bytes);
    u64::from_le_bytes(value)
}

fn create_archive_staging_directory(
    journal_path: &Path,
    manifest_present: bool,
) -> Result<(PathBuf, RecoveryArchivePaths), RecoveryJournalError> {
    ensure_parent_directory(journal_path)?;
    let journal_name = journal_path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "room.recovery".to_string());
    let manifest_name = format!("{journal_name}.manifest.json");

    // UUID collisions are fantastically unlikely, but retrying keeps the
    // create-new uniqueness guarantee explicit and bounded.
    for _ in 0..16 {
        let archive_id = Uuid::new_v4().simple();
        let archive_directory =
            journal_path.with_file_name(format!("{journal_name}.archive-{archive_id}"));
        let staging_directory =
            journal_path.with_file_name(format!(".{journal_name}.archive-{archive_id}.staging"));
        if archive_directory.try_exists()? {
            continue;
        }
        match std::fs::create_dir(&staging_directory) {
            Ok(()) => {
                let archive = RecoveryArchivePaths {
                    journal: archive_directory.join(&journal_name),
                    manifest: manifest_present.then(|| archive_directory.join(&manifest_name)),
                    directory: archive_directory,
                };
                return Ok((staging_directory, archive));
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }

    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not allocate a unique recovery archive path after 16 attempts",
    )
    .into())
}

/// Copy exactly the source length captured at open time without buffering the
/// whole journal in memory, then flush the copy before publishing it.
fn copy_file_durably(source_path: &Path, destination_path: &Path) -> io::Result<()> {
    let source = File::open(source_path)?;
    let metadata = source.metadata()?;
    let expected_len = metadata.len();
    let mut bounded_source = source.take(expected_len);
    let mut destination = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination_path)?;
    let copied = io::copy(&mut bounded_source, &mut destination)?;
    if copied != expected_len {
        return Err(io::Error::new(
            io::ErrorKind::UnexpectedEof,
            format!(
                "recovery source changed while archiving: expected {expected_len} bytes, copied {copied}"
            ),
        ));
    }
    std::fs::set_permissions(destination_path, metadata.permissions())?;
    destination.sync_all()
}

fn ensure_parent_directory(path: &Path) -> io::Result<()> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

fn canonical_parent_directory(path: &Path) -> io::Result<PathBuf> {
    match path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        Some(parent) => parent.canonicalize(),
        None => std::env::current_dir()?.canonicalize(),
    }
}

/// Flush the directory containing `path`, then each ancestor through the
/// filesystem root. Leaf-to-root ordering makes each child durable before the
/// parent entry that makes the child reachable.
fn sync_pathname_directory_chain<SyncDirectory>(
    path: &Path,
    sync_directory: &mut SyncDirectory,
) -> io::Result<()>
where
    SyncDirectory: FnMut(&Path) -> io::Result<()>,
{
    let parent = canonical_parent_directory(path)?;
    for directory in parent.ancestors() {
        sync_directory(directory)?;
    }
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn replace_file_atomically(path: &Path, bytes: &[u8]) -> io::Result<()> {
    ensure_parent_directory(path)?;
    let temporary_path = sibling_temp_path(path);
    let result = (|| {
        let mut temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)?;
        temporary.write_all(bytes)?;
        if let Ok(metadata) = std::fs::metadata(path) {
            std::fs::set_permissions(&temporary_path, metadata.permissions())?;
        }
        temporary.sync_all()?;
        drop(temporary);
        replace_file(&temporary_path, path)?;
        sync_parent_directory(path)
    })();

    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

fn sibling_temp_path(path: &Path) -> PathBuf {
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let sequence = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "recovery-journal".to_string());
    path.with_file_name(format!(
        ".{file_name}.{}-{sequence}.compact.tmp",
        std::process::id()
    ))
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt as _;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let mut source_wide: Vec<u16> = source.as_os_str().encode_wide().collect();
    source_wide.push(0);
    let mut destination_wide: Vec<u16> = destination.as_os_str().encode_wide().collect();
    destination_wide.push(0);

    // SAFETY: both paths are owned, NUL-terminated UTF-16 buffers that remain
    // alive for the duration of the call.
    let result = unsafe {
        MoveFileExW(
            source_wide.as_ptr(),
            destination_wide.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn sync_parent_directory(path: &Path) -> io::Result<()> {
    sync_directory(&canonical_parent_directory(path)?)
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;
    use automerge::{transaction::Transactable, AutoCommit, ROOT};

    fn snapshot(value: &str) -> Vec<u8> {
        let mut document = AutoCommit::new();
        document.put(ROOT, "value", value).unwrap();
        document.save()
    }

    fn manifest(sequence: u64, source: &[u8]) -> RecoveryManifest {
        let mut manifest = RecoveryManifest::new(
            sequence,
            Uuid::from_u128(0x1234),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            notebook_doc::SCHEMA_VERSION,
            source_fingerprint(source),
            7,
        );
        manifest.staged_change_hashes = vec![[sequence as u8; 32]];
        manifest.durable_heads = vec![[(sequence + 1) as u8; 32]];
        manifest.exported_heads = vec![[(sequence + 2) as u8; 32]];
        manifest
    }

    fn matched_record(outcome: RecoveryLoadOutcome) -> RecoveredJournalRecord {
        match outcome {
            RecoveryLoadOutcome::Match(recovery) => recovery,
            other => panic!("expected matching recovery record, got {other:?}"),
        }
    }

    #[test]
    fn source_fingerprint_is_sha256_of_exact_content() {
        let fingerprint = source_fingerprint(b"abc");
        assert_eq!(
            fingerprint.to_hex(),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_ne!(fingerprint, source_fingerprint(b"abc\n"));
    }

    #[test]
    fn notebook_schema_version_round_trips_independently_from_journal_version() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let source = b"source";
        let mut manifest = manifest(1, source);
        manifest.notebook_schema_version = 42;

        journal.append(&manifest, &snapshot("value")).unwrap();
        let recovered = matched_record(journal.load(source_fingerprint(source)).unwrap());

        assert_eq!(recovered.record.manifest.version, RECOVERY_MANIFEST_VERSION);
        assert_eq!(recovered.record.manifest.notebook_schema_version, 42);
    }

    #[test]
    fn append_and_load_selects_latest_matching_snapshot() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let source = b"{\"cells\":[]}";
        let first_snapshot = snapshot("first");
        let second_snapshot = snapshot("second");

        journal
            .append(&manifest(1, source), &first_snapshot)
            .unwrap();
        let first_end = std::fs::metadata(&path).unwrap().len();
        assert!(first_end > 0);
        journal
            .append(&manifest(2, source), &second_snapshot)
            .unwrap();
        assert!(std::fs::metadata(&path).unwrap().len() > first_end);

        assert_eq!(journal.path(), path);
        let recovered = matched_record(journal.load(source_fingerprint(source)).unwrap());
        let indexed_manifest: RecoveryManifest =
            serde_json::from_slice(&std::fs::read(journal.manifest_path()).unwrap()).unwrap();
        assert_eq!(recovered.record.manifest.sequence, 2);
        assert_eq!(indexed_manifest, recovered.record.manifest);
        assert_eq!(recovered.record.automerge_snapshot, second_snapshot);
        assert!(recovered.ignored_tail.is_none());
        AutoCommit::load(&recovered.record.automerge_snapshot).unwrap();
    }

    #[test]
    fn canonical_path_discovery_uses_authoritative_journal_without_sidecar() {
        let directory = tempfile::tempdir().unwrap();
        let canonical_path = directory.path().join("recover-me.ipynb");
        let notebook_id = Uuid::new_v4();
        let journal_path = directory
            .path()
            .join(notebook_doc_filename(&notebook_id.to_string()))
            .with_extension("recovery");
        let journal = RecoveryJournal::new(&journal_path);
        let source = b"source";
        let mut durable_manifest = manifest(1, source);
        durable_manifest.notebook_id = notebook_id;
        durable_manifest.canonical_path = Some(canonical_path.clone());
        journal
            .append(&durable_manifest, &snapshot("acknowledged"))
            .unwrap();

        // The JSON sidecar is only an inspectability index. Identity recovery
        // must still work when it is missing and the authoritative journal has
        // a torn suffix after its last complete record.
        std::fs::remove_file(journal.manifest_path()).unwrap();
        let mut file = OpenOptions::new().append(true).open(&journal_path).unwrap();
        file.write_all(b"torn-tail").unwrap();
        file.sync_all().unwrap();

        assert_eq!(
            discover_journal_by_canonical_path(directory.path(), &canonical_path).unwrap(),
            RecoveryJournalDiscovery::Found {
                notebook_id,
                journal_path,
            }
        );
    }

    #[test]
    fn canonical_path_discovery_refuses_ambiguous_journals() {
        let directory = tempfile::tempdir().unwrap();
        let canonical_path = directory.path().join("ambiguous.ipynb");
        let mut notebook_ids = Vec::new();

        for sequence in [1_u64, 2] {
            let notebook_id = Uuid::new_v4();
            notebook_ids.push(notebook_id);
            let journal_path = directory
                .path()
                .join(notebook_doc_filename(&notebook_id.to_string()))
                .with_extension("recovery");
            let mut durable_manifest = manifest(sequence, b"source");
            durable_manifest.notebook_id = notebook_id;
            durable_manifest.canonical_path = Some(canonical_path.clone());
            RecoveryJournal::new(journal_path)
                .append(&durable_manifest, &snapshot("acknowledged"))
                .unwrap();
        }

        let error =
            discover_journal_by_canonical_path(directory.path(), &canonical_path).unwrap_err();
        match error {
            RecoveryJournalDiscoveryError::AmbiguousPath { candidates, .. } => {
                let candidate_ids = candidates
                    .into_iter()
                    .map(|(notebook_id, _)| notebook_id)
                    .collect::<Vec<_>>();
                assert_eq!(candidate_ids.len(), 2);
                assert!(notebook_ids.iter().all(|id| candidate_ids.contains(id)));
            }
            other => panic!("expected ambiguous recovery journals, got {other:?}"),
        }
    }

    #[test]
    fn first_journal_pathname_sync_is_retried_after_failure() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let source = b"source";
        let recovered_snapshot = snapshot("durable after retry");
        let mut first_attempted_directory = None;

        let error = journal
            .append_with_directory_sync(&manifest(1, source), &recovered_snapshot, |directory| {
                first_attempted_directory = Some(directory.to_path_buf());
                Err(io::Error::other("injected directory sync failure"))
            })
            .unwrap_err();

        assert!(matches!(error, RecoveryJournalError::Io(_)));
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        let canonical_parent = path.parent().unwrap().canonicalize().unwrap();
        assert_eq!(first_attempted_directory, Some(canonical_parent.clone()));

        let mut retried_directories = Vec::new();
        journal
            .append_with_directory_sync(&manifest(1, source), &recovered_snapshot, |directory| {
                retried_directories.push(directory.to_path_buf());
                Ok(())
            })
            .unwrap();

        assert!(std::fs::metadata(&path).unwrap().len() > 0);
        assert_eq!(retried_directories.first(), Some(&canonical_parent));
        let recovered = matched_record(journal.load(source_fingerprint(source)).unwrap());
        assert_eq!(recovered.record.manifest.sequence, 1);
        assert_eq!(recovered.record.automerge_snapshot, recovered_snapshot);
    }

    #[test]
    fn first_journal_flushes_every_new_directory_entry_leaf_to_root() {
        let directory = tempfile::tempdir().unwrap();
        let stable_parent = directory.path().join("stable");
        std::fs::create_dir(&stable_parent).unwrap();
        let path = stable_parent
            .join("new-parent")
            .join("new-child")
            .join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let mut synced_directories = Vec::new();

        journal
            .append_with_directory_sync(&manifest(1, b"source"), &snapshot("nested"), |directory| {
                synced_directories.push(directory.to_path_buf());
                Ok(())
            })
            .unwrap();

        let canonical_child = path.parent().unwrap().canonicalize().unwrap();
        let canonical_new_parent = canonical_child.parent().unwrap().to_path_buf();
        let canonical_stable_parent = canonical_new_parent.parent().unwrap().to_path_buf();
        assert_eq!(
            &synced_directories[..3],
            &[
                canonical_child,
                canonical_new_parent,
                canonical_stable_parent
            ]
        );
    }

    #[test]
    #[cfg(unix)]
    fn manifest_index_failure_does_not_turn_a_committed_append_into_failure() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let source = b"source";

        journal
            .append(&manifest(1, source), &snapshot("first"))
            .unwrap();
        let previous_manifest_bytes = std::fs::read(journal.manifest_path()).unwrap();

        // Removing write permission on the directory blocks the sidecar's
        // atomic replace (temp-file create, then rename) without touching the
        // journal file, which is already open for the append below.
        let original_permissions = std::fs::metadata(directory.path()).unwrap().permissions();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();

        let recovered_snapshot = snapshot("durable despite stale index");
        let append_result = journal.append(&manifest(2, source), &recovered_snapshot);

        std::fs::set_permissions(directory.path(), original_permissions).unwrap();

        assert!(append_result.is_ok());
        assert_eq!(
            std::fs::read(journal.manifest_path()).unwrap(),
            previous_manifest_bytes
        );
        let recovered = matched_record(journal.load(source_fingerprint(source)).unwrap());
        assert_eq!(recovered.record.manifest.sequence, 2);
        assert_eq!(recovered.record.automerge_snapshot, recovered_snapshot);
    }

    #[test]
    fn load_reports_source_conflict_without_discarding_recovery() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let snapshot = snapshot("unsaved");
        journal
            .append(&manifest(1, b"source-a"), &snapshot)
            .unwrap();

        match journal.load(source_fingerprint(b"source-b")).unwrap() {
            RecoveryLoadOutcome::SourceConflict {
                recovery,
                current_source_fingerprint,
            } => {
                assert_eq!(recovery.record.automerge_snapshot, snapshot);
                assert_eq!(
                    recovery.record.manifest.source_fingerprint,
                    source_fingerprint(b"source-a")
                );
                assert_eq!(current_source_fingerprint, source_fingerprint(b"source-b"));
            }
            other => panic!("expected source conflict, got {other:?}"),
        }
    }

    #[test]
    fn reconciled_replacement_failure_keeps_old_active_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        journal
            .append(&manifest(1, b"old-source"), &snapshot("old"))
            .unwrap();
        let original = std::fs::read(&path).unwrap();

        let error = journal
            .archive_and_replace_with(
                &manifest(2, b"new-source"),
                &snapshot("new"),
                |_path, _bytes| Err(io::Error::other("injected replacement failure")),
            )
            .unwrap_err();
        let archive = match error {
            RecoveryJournalError::ArchiveNotCommitted { archive, source } => {
                assert_eq!(source.kind(), io::ErrorKind::Other);
                archive
            }
            other => panic!("expected replacement failure, got {other:?}"),
        };

        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(std::fs::read(&archive.journal).unwrap(), original);
        let recovered = matched_record(journal.load(source_fingerprint(b"old-source")).unwrap());
        assert_eq!(recovered.record.manifest.sequence, 1);
    }

    #[test]
    fn torn_tail_recovers_last_complete_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let source = b"source";
        let first_snapshot = snapshot("first");
        let second_snapshot = snapshot("second");
        journal
            .append(&manifest(1, source), &first_snapshot)
            .unwrap();
        let first_end = std::fs::metadata(&path).unwrap().len();
        journal
            .append(&manifest(2, source), &second_snapshot)
            .unwrap();
        let second_end = std::fs::metadata(&path).unwrap().len();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(second_end - 7)
            .unwrap();

        let recovered = matched_record(journal.load(source_fingerprint(source)).unwrap());
        assert_eq!(recovered.record.manifest.sequence, 1);
        assert_eq!(recovered.record.automerge_snapshot, first_snapshot);
        assert!(matches!(
            recovered.ignored_tail,
            Some(JournalTailIssue::TruncatedPayload { offset, .. }) if offset == first_end
        ));
    }

    #[test]
    fn checksum_failure_at_tail_recovers_previous_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let source = b"source";
        journal
            .append(&manifest(1, source), &snapshot("first"))
            .unwrap();
        let first_end = std::fs::metadata(&path).unwrap().len();
        journal
            .append(&manifest(2, source), &snapshot("second"))
            .unwrap();
        let second_end = std::fs::metadata(&path).unwrap().len();

        let mut file = File::options().read(true).write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(second_end - 1)).unwrap();
        let mut byte = [0_u8; 1];
        file.read_exact(&mut byte).unwrap();
        file.seek(SeekFrom::Start(second_end - 1)).unwrap();
        file.write_all(&[byte[0] ^ 0xff]).unwrap();
        file.sync_all().unwrap();

        let recovered = matched_record(journal.load(source_fingerprint(source)).unwrap());
        assert_eq!(recovered.record.manifest.sequence, 1);
        assert_eq!(
            recovered.ignored_tail,
            Some(JournalTailIssue::ChecksumMismatch { offset: first_end })
        );
    }

    #[test]
    fn append_refuses_to_truncate_corrupt_record_and_valid_suffix() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let source = b"source";
        journal
            .append(&manifest(1, source), &snapshot("first"))
            .unwrap();
        let first_end = std::fs::metadata(&path).unwrap().len();
        journal
            .append(&manifest(2, source), &snapshot("second"))
            .unwrap();
        journal
            .append(&manifest(3, source), &snapshot("valid suffix"))
            .unwrap();

        // The second record starts exactly where the first one ends.
        let second_start = first_end;
        let mut file = File::options().read(true).write(true).open(&path).unwrap();
        file.seek(SeekFrom::Start(second_start + HEADER_LEN as u64))
            .unwrap();
        let mut byte = [0_u8; 1];
        file.read_exact(&mut byte).unwrap();
        file.seek(SeekFrom::Start(second_start + HEADER_LEN as u64))
            .unwrap();
        file.write_all(&[byte[0] ^ 0xff]).unwrap();
        file.sync_all().unwrap();
        drop(file);
        *journal
            .append_cursor
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let preserved = std::fs::read(&path).unwrap();

        let error = journal
            .append(&manifest(4, source), &snapshot("must not append"))
            .unwrap_err();
        assert!(matches!(
            error,
            RecoveryJournalError::CorruptTailRequiresReconciliation {
                tail: JournalTailIssue::ChecksumMismatch { offset }
            } if offset == first_end
        ));
        assert_eq!(std::fs::read(&path).unwrap(), preserved);
    }

    #[test]
    fn append_repairs_torn_tail_after_valid_record() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let source = b"source";
        journal
            .append(&manifest(1, source), &snapshot("first"))
            .unwrap();
        let first_end = std::fs::metadata(&path).unwrap().len();
        journal
            .append(&manifest(2, source), &snapshot("torn"))
            .unwrap();
        let torn_end = std::fs::metadata(&path).unwrap().len();
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(torn_end - 11)
            .unwrap();

        let replacement_manifest = manifest(3, source);
        let replacement_snapshot = snapshot("replacement");
        let replacement_len = encode_record(&replacement_manifest, &replacement_snapshot)
            .unwrap()
            .bytes
            .len() as u64;
        journal
            .append(&replacement_manifest, &replacement_snapshot)
            .unwrap();
        assert_eq!(
            std::fs::metadata(&path).unwrap().len(),
            first_end + replacement_len
        );

        let recovered = matched_record(journal.load(source_fingerprint(source)).unwrap());
        assert_eq!(recovered.record.manifest.sequence, 3);
        assert_eq!(recovered.record.automerge_snapshot, replacement_snapshot);
        assert!(recovered.ignored_tail.is_none());
    }

    #[test]
    fn append_automatically_compacts_the_active_journal() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bounded.recovery");
        let journal = RecoveryJournal::new(&path);
        for sequence in 1..=COMPACT_AFTER_RECORDS {
            let manifest = manifest(sequence as u64, b"source");
            journal.append(&manifest, &snapshot("value")).unwrap();
        }

        // Compaction replaced the bounded journal with just the newest
        // record: its on-disk length is one record, not COMPACT_AFTER_RECORDS.
        let newest_manifest = manifest(COMPACT_AFTER_RECORDS as u64, b"source");
        let single_record_len = encode_record(&newest_manifest, &snapshot("value"))
            .unwrap()
            .bytes
            .len() as u64;
        assert_eq!(std::fs::metadata(&path).unwrap().len(), single_record_len);

        let latest = match journal.latest_record().unwrap() {
            RecoveryLatestOutcome::Recovered(recovery) => recovery,
            other => panic!("expected compacted recovery record, got {other:?}"),
        };
        assert_eq!(
            latest.record.manifest.sequence,
            COMPACT_AFTER_RECORDS as u64
        );
    }

    #[test]
    fn unavailable_distinguishes_missing_empty_and_invalid_journals() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("room.recovery");
        let journal = RecoveryJournal::new(&path);
        let fingerprint = source_fingerprint(b"source");

        assert_eq!(
            journal.load(fingerprint).unwrap(),
            RecoveryLoadOutcome::Unavailable {
                reason: RecoveryUnavailableReason::MissingJournal
            }
        );

        File::create(&path).unwrap().sync_all().unwrap();
        assert_eq!(
            journal.load(fingerprint).unwrap(),
            RecoveryLoadOutcome::Unavailable {
                reason: RecoveryUnavailableReason::EmptyJournal
            }
        );

        std::fs::write(&path, b"partial").unwrap();
        assert!(matches!(
            journal.load(fingerprint).unwrap(),
            RecoveryLoadOutcome::Unavailable {
                reason: RecoveryUnavailableReason::NoValidRecord {
                    tail: JournalTailIssue::TruncatedHeader { offset: 0, .. }
                }
            }
        ));
    }

    #[test]
    fn invalid_manifest_version_is_rejected_before_append() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let mut invalid = manifest(1, b"source");
        invalid.version = RECOVERY_MANIFEST_VERSION + 1;

        assert!(matches!(
            journal.append(&invalid, &snapshot("value")),
            Err(RecoveryJournalError::UnsupportedManifestVersion { version })
                if version == RECOVERY_MANIFEST_VERSION + 1
        ));
        assert!(!journal.path().exists());
    }
}
