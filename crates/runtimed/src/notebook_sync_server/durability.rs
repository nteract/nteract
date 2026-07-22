//! Room-wide durability coordination for NotebookDoc history.
//!
//! One coordinator serializes source, peer, daemon, and file-checkpoint
//! records for a room. Callers that mutate the live NotebookDoc commit its
//! resulting snapshot here before releasing the document lock or publishing
//! an acknowledgement/broadcast. The append-only journal is authoritative;
//! the watch state makes durable-head barriers and degradation observable.

use std::collections::HashSet;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use automerge::{AutoCommit, Change, ChangeHash};
use tokio::sync::watch;
use uuid::Uuid;

use super::recovery::{
    PendingFileCheckpoint, RecoveredJournalRecord, RecoveryJournal, RecoveryJournalError,
    RecoveryManifest, RecoverySourcePhase, RecoveryUnavailableReason, SourceFingerprint,
};

/// Structural classification of a room degradation. The kind is lifecycle
/// policy, not display text: shutdown and reaping consult it through
/// `RoomDurabilityStatus::requires_durability_repair`, so every mark site
/// must declare which failure class it is reporting.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DegradationKind {
    /// The durability boundary itself failed: the journal cannot accept
    /// records or has preserved corrupt data. The room must stay resident
    /// for explicit repair because disk plus journal no longer reconstruct
    /// its acknowledged state.
    DurabilityBoundary,
    /// A source-level conflict or failure while the recovery journal stays
    /// healthy. Disk plus journal reconstruct the same degraded lifecycle
    /// on reopen, so the room may be reaped or cleanly shut down.
    SourceState,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RoomDegradation {
    pub(crate) kind: DegradationKind,
    pub(crate) reason: String,
}

impl RoomDegradation {
    fn boundary(reason: impl Into<String>) -> Self {
        Self {
            kind: DegradationKind::DurabilityBoundary,
            reason: reason.into(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RoomDurabilityStatus {
    pub(crate) has_durable_record: bool,
    pub(crate) journal_sequence: u64,
    pub(crate) durable_heads: Vec<String>,
    pub(crate) exported_heads: Vec<String>,
    pub(crate) source_generation: u64,
    pub(crate) source_phase: RecoverySourcePhase,
    pub(crate) source_fingerprint: SourceFingerprint,
    pub(crate) has_peer_changes: bool,
    pub(crate) degraded: Option<RoomDegradation>,
}

impl RoomDurabilityStatus {
    pub(crate) fn is_degraded(&self) -> bool {
        self.degraded.is_some()
    }

    pub(crate) fn degraded_reason(&self) -> Option<String> {
        self.degraded
            .as_ref()
            .map(|degradation| degradation.reason.clone())
    }

    /// Only a failed durability boundary requires the room to stay resident
    /// for repair. A `SourceState` degradation is durable recovery evidence,
    /// not a storage failure.
    pub(crate) fn requires_durability_repair(&self) -> bool {
        matches!(
            &self.degraded,
            Some(RoomDegradation {
                kind: DegradationKind::DurabilityBoundary,
                ..
            })
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DurableMutation {
    Source {
        generation: u64,
        fingerprint: SourceFingerprint,
        staged_change_hashes: Vec<[u8; 32]>,
    },
    Peer {
        change_hashes: Vec<[u8; 32]>,
    },
    SourceReady {
        generation: u64,
    },
    Daemon,
    FileCheckpoint {
        canonical_path: PathBuf,
        file_fingerprint: SourceFingerprint,
        exported_heads: Vec<[u8; 32]>,
        save_sequence: u64,
        /// Explicit source reconciliation advances the room generation in
        /// the same journal record as the selected file checkpoint. Ordinary
        /// saves leave source-task identity unchanged.
        source_generation: Option<u64>,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum DurableCommitOutcome {
    Committed(RoomDurabilityStatus),
    AlreadyDurable(RoomDurabilityStatus),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ReconciledSourceCommit {
    pub(crate) status: RoomDurabilityStatus,
    pub(crate) archived_directory: PathBuf,
    pub(crate) archive_durability_warning: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum RoomDurabilityError {
    #[error("room recovery journal failed: {0}")]
    Journal(#[from] RecoveryJournalError),
    #[error("durable Automerge snapshot is invalid: {0}")]
    InvalidSnapshot(String),
    #[error("invalid durable Automerge head {head}: {reason}")]
    InvalidHead { head: String, reason: String },
    #[error("timed out waiting for durable Automerge heads")]
    TimedOut,
    #[error("room durability is degraded: {0}")]
    Degraded(String),
    #[error("room durability commits are frozen for clean shutdown")]
    ShutdownInProgress,
    #[error("room journal sequence is exhausted")]
    SequenceExhausted,
    #[error("file checkpoint heads are not contained in the durable recovery snapshot")]
    FileCheckpointHeadsNotDurable,
    #[error(
        "external source changed while journal heads were not exported (journal source {journal_source:?}, observed source {observed_source:?})"
    )]
    SourceConflict {
        journal_source: SourceFingerprint,
        observed_source: SourceFingerprint,
    },
    #[error("room does not have an active recovery journal")]
    JournalUnavailable,
    #[error("active recovery journal could not be archived: {0:?}")]
    ArchiveUnavailable(RecoveryUnavailableReason),
    #[error(
        "recovery journal was archived at {archive:?}, but the reconciled source record failed: {source}"
    )]
    ReconciledSourceAfterArchive {
        archive: PathBuf,
        #[source]
        source: Box<RecoveryJournalError>,
    },
}

/// Run one synchronous document serialization/journal boundary without
/// starving unrelated tasks on runtimed's multi-thread executor.
///
/// The operation deliberately stays on the current task so callers can retain
/// a borrowed NotebookDoc guard across the causal durability boundary. Tokio
/// replaces the occupied worker while the closure performs blocking disk I/O.
/// Current-thread test runtimes execute inline because `block_in_place` is not
/// available there.
pub(crate) fn run_blocking_durability_boundary<T>(operation: impl FnOnce() -> T) -> T {
    let multi_thread_runtime = tokio::runtime::Handle::try_current()
        .map(|handle| handle.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread)
        .unwrap_or(false);
    if multi_thread_runtime {
        tokio::task::block_in_place(operation)
    } else {
        operation()
    }
}

/// Commit a daemon-authored NotebookDoc mutation before it is acknowledged or
/// advertised to another peer.
///
/// Callers retain the document write guard across this synchronous journal
/// append. A failed append restores the exact pre-mutation document and actor,
/// then closes mutation and execution capabilities until recovery is
/// reconciled. RuntimeState changes paired with the NotebookDoc mutation remain
/// the caller's rollback responsibility.
pub(crate) fn commit_daemon_notebook_mutation(
    room: &super::NotebookRoom,
    doc: &mut notebook_doc::NotebookDoc,
    baseline_heads: &[ChangeHash],
    rollback_snapshot: &[u8],
    rollback_actor: &str,
    operation: &str,
) -> Result<(), String> {
    run_blocking_durability_boundary(|| {
        let heads = doc.get_heads();
        if heads == baseline_heads {
            return Ok(());
        }
        let snapshot = doc.save();
        let raw_heads = heads.iter().map(|head| head.0).collect::<Vec<_>>();
        if let Err(error) =
            room.durability
                .commit_snapshot(&snapshot, raw_heads, DurableMutation::Daemon)
        {
            let document_readable =
                match notebook_doc::NotebookDoc::load_with_actor(rollback_snapshot, rollback_actor)
                {
                    Ok(restored) => {
                        *doc = restored;
                        true
                    }
                    Err(_) => false,
                };
            let document_heads = doc.get_heads_hex();
            let reason =
                format!("{operation} journal commit failed before acknowledgement: {error}");
            room.durability
                .mark_degraded(DegradationKind::DurabilityBoundary, reason.clone());
            room.lifecycle
                .mark_degraded(reason.clone(), document_heads, document_readable);
            let _ = room.state.with_doc(|state| {
                state.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                    reason: reason.clone(),
                }))
            });
            return Err(reason);
        }
        Ok(())
    })
}

struct DurabilityState {
    manifest: RecoveryManifest,
    durable_snapshot: Arc<[u8]>,
    has_durable_record: bool,
    degraded: Option<RoomDegradation>,
}

/// Single serialization point for all durable NotebookDoc history in a room.
pub(crate) struct RoomDurability {
    journal: Mutex<Option<RecoveryJournal>>,
    state: Mutex<DurabilityState>,
    status_tx: watch::Sender<RoomDurabilityStatus>,
    accepting_commits: AtomicBool,
}

impl RoomDurability {
    /// Create a journal-backed coordinator before source publication.
    pub(crate) fn journaled(
        journal: RecoveryJournal,
        notebook_id: Uuid,
        canonical_path: Option<PathBuf>,
        source_fingerprint: SourceFingerprint,
        source_generation: u64,
        genesis_snapshot: Vec<u8>,
    ) -> Self {
        let manifest = RecoveryManifest::new(
            0,
            notebook_id,
            canonical_path,
            notebook_doc::SCHEMA_VERSION,
            source_fingerprint,
            source_generation,
        );
        Self::from_state(Some(journal), manifest, genesis_snapshot, false, None)
    }

    /// Restore the exact latest complete record selected by recovery scanning.
    pub(crate) fn recovered(journal: RecoveryJournal, recovered: RecoveredJournalRecord) -> Self {
        let degraded = recovered
            .ignored_tail
            .as_ref()
            .filter(|tail| !tail.is_repairable_torn_suffix())
            .map(|tail| {
                RoomDegradation::boundary(format!(
                    "recovery journal has preserved corrupt data: {tail:?}"
                ))
            });
        let mut manifest = recovered.record.manifest;
        if degraded.is_none() {
            promote_full_coverage_checkpoint_baseline(&mut manifest);
        }
        Self::from_state(
            Some(journal),
            manifest,
            recovered.record.automerge_snapshot,
            true,
            degraded,
        )
    }

    /// Explicitly ephemeral rooms expose an in-memory satisfied barrier. All
    /// persistent rooms, including untitled rooms, are journal-backed before
    /// they can acknowledge changes.
    pub(crate) fn volatile(notebook_id: Uuid, snapshot: Vec<u8>, heads: Vec<[u8; 32]>) -> Self {
        let mut manifest = RecoveryManifest::new(
            0,
            notebook_id,
            None,
            notebook_doc::SCHEMA_VERSION,
            super::recovery::source_fingerprint(&[]),
            0,
        );
        manifest.durable_heads = heads;
        Self::from_state(None, manifest, snapshot, true, None)
    }

    fn from_state(
        journal: Option<RecoveryJournal>,
        manifest: RecoveryManifest,
        durable_snapshot: Vec<u8>,
        has_durable_record: bool,
        degraded: Option<RoomDegradation>,
    ) -> Self {
        let state = DurabilityState {
            manifest,
            durable_snapshot: durable_snapshot.into(),
            has_durable_record,
            degraded,
        };
        let status = status_from_state(&state);
        let (status_tx, _) = watch::channel(status);
        Self {
            journal: Mutex::new(journal),
            state: Mutex::new(state),
            status_tx,
            accepting_commits: AtomicBool::new(true),
        }
    }

    fn ensure_accepting_commits(&self) -> Result<(), RoomDurabilityError> {
        if self.accepting_commits.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(RoomDurabilityError::ShutdownInProgress)
        }
    }

    /// Close the room's journal commit point after a final snapshot was
    /// committed while holding the live NotebookDoc lock.
    pub(crate) fn freeze_commits(&self) {
        self.accepting_commits.store(false, Ordering::Release);
    }

    pub(crate) fn thaw_commits(&self) {
        self.accepting_commits.store(true, Ordering::Release);
    }

    fn lock_state(&self) -> MutexGuard<'_, DurabilityState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub(crate) fn journal(&self) -> Option<RecoveryJournal> {
        self.journal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    /// Durably attach the recovery journal when an untitled room becomes
    /// file-backed.
    ///
    /// The causal file checkpoint is already present in the in-memory
    /// manifest when this is called. The first journal record therefore binds
    /// the exact saved heads, file fingerprint, and current recovery union in
    /// one durable marker before the room starts acknowledging later edits as
    /// a file-backed session.
    pub(crate) fn promote_to_journal(
        &self,
        journal: RecoveryJournal,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let mut state = self.lock_state();
        let mut active = self
            .journal
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(current) = active.as_ref() {
            if current.path() == journal.path() {
                return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                    &state,
                )));
            }
            return Err(RoomDurabilityError::InvalidSnapshot(format!(
                "room recovery journal is already bound to {}",
                current.path().display()
            )));
        }

        if state.manifest.canonical_path.is_none() || state.manifest.file_save_sequence.is_none() {
            return Err(RoomDurabilityError::InvalidSnapshot(
                "a room must have a committed file checkpoint before journal promotion".to_string(),
            ));
        }
        let mut promoted_manifest = state.manifest.clone();
        if promoted_manifest.source_phase == RecoverySourcePhase::Pending {
            let mut durable = AutoCommit::load(&state.durable_snapshot)
                .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
            promoted_manifest.sequence = promoted_manifest
                .sequence
                .checked_add(1)
                .ok_or(RoomDurabilityError::SequenceExhausted)?;
            promoted_manifest.source_generation = promoted_manifest
                .source_generation
                .checked_add(1)
                .ok_or(RoomDurabilityError::SequenceExhausted)?;
            promoted_manifest.source_phase = RecoverySourcePhase::Ready;
            promoted_manifest.staged_change_hashes = durable
                .get_changes(&[])
                .iter()
                .map(|change| change.hash().0)
                .collect();
        }

        if let Err(error) = journal.append(&promoted_manifest, &state.durable_snapshot) {
            let reason = error.to_string();
            state.degraded = Some(RoomDegradation::boundary(reason.clone()));
            self.status_tx.send_replace(status_from_state(&state));
            return Err(RoomDurabilityError::Journal(error));
        }
        *active = Some(journal);
        state.manifest = promoted_manifest;
        state.has_durable_record = true;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    pub(crate) fn status(&self) -> RoomDurabilityStatus {
        self.status_tx.borrow().clone()
    }

    pub(crate) fn subscribe(&self) -> watch::Receiver<RoomDurabilityStatus> {
        self.status_tx.subscribe()
    }

    pub(crate) fn durable_snapshot(&self) -> Arc<[u8]> {
        Arc::clone(&self.lock_state().durable_snapshot)
    }

    pub(crate) fn manifest(&self) -> RecoveryManifest {
        self.lock_state().manifest.clone()
    }

    /// Commit a complete NotebookDoc snapshot and its exact causal heads.
    ///
    /// This method is synchronous by design so a caller may hold the live
    /// document write lock through journal fsync without carrying an async
    /// mutex guard across `.await`. The room stays unavailable to other
    /// document readers until the durable marker has landed.
    pub(crate) fn commit_snapshot(
        &self,
        snapshot: &[u8],
        durable_heads: Vec<[u8; 32]>,
        mutation: DurableMutation,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let mut candidate = AutoCommit::load(snapshot)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;

        let mut state = self.lock_state();
        let (committed_snapshot, durable_heads) =
            if state.has_durable_record && matches!(&mutation, DurableMutation::Daemon) {
                // Reaper and shutdown snapshots are captured before their
                // blocking journal write. A peer batch may commit in between.
                // Merge the already-durable union into the candidate so an
                // older daemon snapshot can never regress acknowledged heads.
                let mut durable = AutoCommit::load(&state.durable_snapshot)
                    .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
                let missing = durable
                    .get_changes(&[])
                    .into_iter()
                    .filter(|change| candidate.get_change_by_hash(&change.hash()).is_none())
                    .collect::<Vec<_>>();
                candidate
                    .apply_changes(missing)
                    .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
                let heads = candidate.get_heads().iter().map(|head| head.0).collect();
                (candidate.save(), heads)
            } else {
                (snapshot.to_vec(), durable_heads)
            };
        if state.has_durable_record
            && state.manifest.durable_heads == durable_heads
            && mutation_is_already_reflected(&state.manifest, &mutation)
        {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        }

        let mut manifest = state.manifest.clone();
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        manifest.durable_heads = durable_heads.clone();
        if matches!(&mutation, DurableMutation::Source { .. }) {
            // An imported source snapshot is already represented by the exact
            // bytes on disk, so it is a causal clean baseline even though no
            // user-initiated save event occurred.
            manifest.exported_heads = durable_heads;
            manifest.file_save_sequence = Some(0);
        }
        apply_mutation_to_manifest(&mut manifest, mutation);

        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &committed_snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }

        state.manifest = manifest;
        state.durable_snapshot = committed_snapshot.into();
        state.has_durable_record = true;
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    /// Commit a generation-owned staged source without replacing peer changes
    /// that were accepted while preparation was in flight.
    ///
    /// The source snapshot and peer snapshot are forks of the same canonical
    /// genesis. Merge the exact staged changes into the current durable union,
    /// retain peer-authored hashes, and keep `exported_heads` pinned to the
    /// staged source revision represented by the bytes already on disk.
    pub(crate) fn commit_staged_source(
        &self,
        staged_snapshot: &[u8],
        staged_heads: Vec<[u8; 32]>,
        generation: u64,
        fingerprint: SourceFingerprint,
        staged_change_hashes: Vec<[u8; 32]>,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let required_heads = staged_heads
            .iter()
            .copied()
            .map(ChangeHash)
            .collect::<Vec<_>>();
        let mut staged = AutoCommit::load(staged_snapshot)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        if !required_heads
            .iter()
            .all(|head| staged.get_change_by_hash(head).is_some())
        {
            return Err(RoomDurabilityError::InvalidSnapshot(
                "staged source snapshot does not contain its declared heads".to_string(),
            ));
        }

        let mutation = DurableMutation::Source {
            generation,
            fingerprint,
            staged_change_hashes,
        };
        let mut state = self.lock_state();
        if state.has_durable_record
            && mutation_is_already_reflected(&state.manifest, &mutation)
            && state.manifest.exported_heads == staged_heads
            && snapshot_contains_heads(&state.durable_snapshot, &required_heads)?
        {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        }

        let mut durable = AutoCommit::load(&state.durable_snapshot)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        let missing = staged
            .get_changes(&[])
            .into_iter()
            .filter(|change| durable.get_change_by_hash(&change.hash()).is_none())
            .collect::<Vec<_>>();
        durable
            .apply_changes(missing)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        let durable_heads = durable.get_heads().iter().map(|head| head.0).collect();
        let durable_snapshot = durable.save();

        let mut manifest = state.manifest.clone();
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        manifest.durable_heads = durable_heads;
        manifest.exported_heads = staged_heads;
        manifest.file_save_sequence = Some(0);
        apply_mutation_to_manifest(&mut manifest, mutation);

        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &durable_snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }

        state.manifest = manifest;
        state.durable_snapshot = durable_snapshot.into();
        state.has_durable_record = true;
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    /// Mark a durably staged generation fully reconstructed and publishable.
    ///
    /// This is a separate journal record from staging so a crash between the
    /// NotebookDoc commit and runtime-sidecar reconstruction restarts in
    /// `DurablyStaged` and resumes the same generation instead of reporting a
    /// false Ready state.
    pub(crate) fn commit_source_ready(
        &self,
        generation: u64,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let mut state = self.lock_state();
        if state.manifest.source_generation != generation {
            return Err(RoomDurabilityError::InvalidSnapshot(format!(
                "source generation {} cannot complete durable generation {}",
                generation, state.manifest.source_generation
            )));
        }
        let mutation = DurableMutation::SourceReady { generation };
        if state.has_durable_record && mutation_is_already_reflected(&state.manifest, &mutation) {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        }
        if state.manifest.source_phase != RecoverySourcePhase::DurablyStaged {
            return Err(RoomDurabilityError::InvalidSnapshot(format!(
                "source generation {generation} is not durably staged"
            )));
        }

        let mut manifest = state.manifest.clone();
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        apply_mutation_to_manifest(&mut manifest, mutation);
        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &state.durable_snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }

        state.manifest = manifest;
        state.has_durable_record = true;
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    /// Append a causal file checkpoint without replacing the recovery union.
    ///
    /// The durable snapshot may contain peer changes newer than the captured
    /// heads exported to `.ipynb`. Verify those heads are ancestors of the
    /// recovery snapshot, then advance only manifest checkpoint metadata.
    pub(crate) fn prepare_file_checkpoint(
        &self,
        canonical_path: PathBuf,
        file_fingerprint: SourceFingerprint,
        exported_heads: Vec<[u8; 32]>,
        save_sequence: u64,
        source_generation: Option<u64>,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let required_heads = exported_heads
            .iter()
            .copied()
            .map(ChangeHash)
            .collect::<Vec<_>>();
        let mut state = self.lock_state();
        if !snapshot_contains_heads(&state.durable_snapshot, &required_heads)? {
            return Err(RoomDurabilityError::FileCheckpointHeadsNotDurable);
        }
        let pending = PendingFileCheckpoint {
            canonical_path,
            file_fingerprint,
            exported_heads,
            save_sequence,
            source_generation,
        };
        if state.manifest.pending_file_checkpoint.as_ref() == Some(&pending) {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        }
        if let Some(existing) = &state.manifest.pending_file_checkpoint {
            return Err(RoomDurabilityError::InvalidSnapshot(format!(
                "file checkpoint {} is still pending before sequence {} can prepare",
                existing.save_sequence, save_sequence
            )));
        }

        let mut manifest = state.manifest.clone();
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        manifest.pending_file_checkpoint = Some(pending);
        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &state.durable_snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }
        state.manifest = manifest;
        state.has_durable_record = true;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    /// Clear a prepared checkpoint after atomic replacement definitively did
    /// not occur. A crash before this marker is harmless: restart observes
    /// the old source fingerprint and appends the same abort transition.
    pub(crate) fn abort_file_checkpoint(
        &self,
        save_sequence: u64,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let mut state = self.lock_state();
        let Some(pending) = state.manifest.pending_file_checkpoint.as_ref() else {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        };
        if pending.save_sequence != save_sequence {
            return Err(RoomDurabilityError::InvalidSnapshot(format!(
                "cannot abort checkpoint sequence {save_sequence}; sequence {} is pending",
                pending.save_sequence
            )));
        }
        let mut manifest = state.manifest.clone();
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        manifest.pending_file_checkpoint = None;
        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &state.durable_snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }
        state.manifest = manifest;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    /// Resolve a checkpoint intent discovered during restart. Disk matching
    /// the intended bytes proves replacement happened; matching the previous
    /// source proves it did not. Any third fingerprint remains a real source
    /// conflict and is never selected silently.
    pub(crate) fn resolve_recovered_file_checkpoint(
        &self,
        current_source_fingerprint: SourceFingerprint,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let mut state = self.lock_state();
        let Some(pending) = state.manifest.pending_file_checkpoint.clone() else {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        };
        let mut manifest = state.manifest.clone();
        if current_source_fingerprint == pending.file_fingerprint {
            apply_mutation_to_manifest(
                &mut manifest,
                DurableMutation::FileCheckpoint {
                    canonical_path: pending.canonical_path,
                    file_fingerprint: pending.file_fingerprint,
                    exported_heads: pending.exported_heads,
                    save_sequence: pending.save_sequence,
                    source_generation: pending.source_generation,
                },
            );
        } else if current_source_fingerprint == manifest.source_fingerprint {
            manifest.pending_file_checkpoint = None;
        } else {
            return Err(RoomDurabilityError::SourceConflict {
                journal_source: manifest.source_fingerprint,
                observed_source: current_source_fingerprint,
            });
        }
        // Resolution just cleared the intent, so the coverage evaluation runs
        // on the post-resolution manifest. This is the same normalization
        // restore applies: without it, a crash between the atomic file
        // replace and the intent-commit journal append would restore as
        // source_degraded until a second restart re-read the resolved tail.
        if state.degraded.is_none() {
            promote_full_coverage_checkpoint_baseline(&mut manifest);
        }
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &state.durable_snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }
        state.manifest = manifest;
        state.has_durable_record = true;
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    pub(crate) fn commit_file_checkpoint(
        &self,
        canonical_path: PathBuf,
        file_fingerprint: SourceFingerprint,
        exported_heads: Vec<[u8; 32]>,
        save_sequence: u64,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.commit_file_checkpoint_with_generation(
            canonical_path,
            file_fingerprint,
            exported_heads,
            save_sequence,
            None,
        )
    }

    /// Commit the file checkpoint selected by an explicit source
    /// reconciliation and advance its generation atomically in the same
    /// journal record. The caller restores interactive capabilities only
    /// after this returns successfully.
    pub(crate) fn commit_reconciled_file_checkpoint(
        &self,
        canonical_path: PathBuf,
        file_fingerprint: SourceFingerprint,
        exported_heads: Vec<[u8; 32]>,
        save_sequence: u64,
        source_generation: u64,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.commit_file_checkpoint_with_generation(
            canonical_path,
            file_fingerprint,
            exported_heads,
            save_sequence,
            Some(source_generation),
        )
    }

    fn commit_file_checkpoint_with_generation(
        &self,
        canonical_path: PathBuf,
        file_fingerprint: SourceFingerprint,
        exported_heads: Vec<[u8; 32]>,
        save_sequence: u64,
        source_generation: Option<u64>,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let required_heads = exported_heads
            .iter()
            .copied()
            .map(ChangeHash)
            .collect::<Vec<_>>();
        let mut state = self.lock_state();
        if !snapshot_contains_heads(&state.durable_snapshot, &required_heads)? {
            return Err(RoomDurabilityError::FileCheckpointHeadsNotDurable);
        }

        let expected_pending = PendingFileCheckpoint {
            canonical_path: canonical_path.clone(),
            file_fingerprint,
            exported_heads: exported_heads.clone(),
            save_sequence,
            source_generation,
        };
        let mutation = DurableMutation::FileCheckpoint {
            canonical_path,
            file_fingerprint,
            exported_heads,
            save_sequence,
            source_generation,
        };
        if let Some(pending) = &state.manifest.pending_file_checkpoint {
            if pending != &expected_pending {
                return Err(RoomDurabilityError::InvalidSnapshot(format!(
                    "file checkpoint sequence {save_sequence} does not match prepared intent {}",
                    pending.save_sequence
                )));
            }
        }
        let already_reflected =
            state.has_durable_record && mutation_is_already_reflected(&state.manifest, &mutation);
        let mut manifest = state.manifest.clone();
        if !already_reflected {
            apply_mutation_to_manifest(&mut manifest, mutation);
        }
        // A successful ordinary save that exports every durable head is the
        // same complete source baseline that restore and intent resolution
        // already recognize. Stage it in the save's commit record so a room
        // created at a path is joinable before it has to restart once.
        if state.degraded.is_none() {
            promote_full_coverage_checkpoint_baseline(&mut manifest);
        }
        if already_reflected && manifest == state.manifest {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        }
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;

        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &state.durable_snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }

        state.manifest = manifest;
        state.has_durable_record = true;
        // A file checkpoint does not reconcile a pre-existing source conflict
        // or journal degradation. Explicit reconciliation owns that transition.
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    /// Retire the active recovery history and commit a deliberate disk-source
    /// replacement as the first record in a new active journal.
    ///
    /// The supplied snapshot is the live recovered document plus a causal
    /// delete/recreate change authored by the reconciliation operation. It
    /// therefore retains knowledge of the archived history for convergence
    /// with already-connected peers while making the selected disk cells and
    /// metadata the visible winners. This method owns the durability mutex
    /// from archive through append so peer/source/checkpoint commits cannot
    /// land between those two commit points.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn archive_and_commit_reconciled_source(
        &self,
        snapshot: &[u8],
        durable_heads: Vec<[u8; 32]>,
        canonical_path: PathBuf,
        source_fingerprint: SourceFingerprint,
        source_generation: u64,
        replacement_change_hashes: Vec<[u8; 32]>,
        save_sequence: u64,
    ) -> Result<ReconciledSourceCommit, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let mut candidate = AutoCommit::load(snapshot)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        let mut actual_heads = candidate
            .get_heads()
            .iter()
            .map(|head| head.0)
            .collect::<Vec<_>>();
        let mut declared_heads = durable_heads.clone();
        actual_heads.sort_unstable();
        declared_heads.sort_unstable();
        if actual_heads != declared_heads {
            return Err(RoomDurabilityError::InvalidSnapshot(
                "reconciled source snapshot heads do not match the declared heads".to_string(),
            ));
        }

        let mut state = self.lock_state();
        let journal = self
            .journal()
            .ok_or(RoomDurabilityError::JournalUnavailable)?;
        let sequence = state
            .manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        let mut manifest = RecoveryManifest::new(
            sequence,
            state.manifest.notebook_id,
            Some(canonical_path),
            notebook_doc::SCHEMA_VERSION,
            source_fingerprint,
            source_generation,
        );
        manifest.source_phase = RecoverySourcePhase::DurablyStaged;
        manifest.staged_change_hashes = replacement_change_hashes;
        manifest.durable_heads = durable_heads.clone();
        manifest.exported_heads = durable_heads;
        manifest.file_save_sequence = Some(save_sequence);

        let replacement = journal.archive_and_replace(&manifest, snapshot)?;

        state.manifest = manifest;
        state.durable_snapshot = Arc::from(snapshot);
        state.has_durable_record = true;
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(ReconciledSourceCommit {
            status,
            archived_directory: replacement.archive.directory,
            archive_durability_warning: replacement.durability_warning,
        })
    }

    /// Merge peer-authored changes into the durable recovery union.
    ///
    /// During source publication the live room may intentionally expose only
    /// a prefix of the staged source history. The durable snapshot already
    /// contains the complete staged generation, so peer changes are applied
    /// to that snapshot rather than replacing it with the live prefix. A
    /// restart can therefore resume the same staged hashes while preserving
    /// every acknowledged peer change.
    pub(crate) fn commit_peer_changes(
        &self,
        changes: Vec<Change>,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        if changes.is_empty() {
            return Ok(DurableCommitOutcome::AlreadyDurable(self.status()));
        }

        let mut state = self.lock_state();
        let mut durable = AutoCommit::load(&state.durable_snapshot)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        let peer_hashes = changes
            .iter()
            .map(|change| change.hash().0)
            .collect::<Vec<_>>();
        let missing = changes
            .into_iter()
            .filter(|change| durable.get_change_by_hash(&change.hash()).is_none())
            .collect::<Vec<_>>();
        if missing.is_empty()
            && peer_hashes
                .iter()
                .all(|hash| state.manifest.peer_change_hashes.contains(hash))
        {
            return Ok(DurableCommitOutcome::AlreadyDurable(status_from_state(
                &state,
            )));
        }
        durable
            .apply_changes(missing)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        let durable_heads = durable.get_heads().iter().map(|head| head.0).collect();
        let snapshot = durable.save();

        let mut manifest = state.manifest.clone();
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        manifest.durable_heads = durable_heads;
        apply_mutation_to_manifest(
            &mut manifest,
            DurableMutation::Peer {
                change_hashes: peer_hashes,
            },
        );
        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }

        state.manifest = manifest;
        state.durable_snapshot = snapshot.into();
        state.has_durable_record = true;
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    /// Commit one fully prepared external file revision as a new immutable
    /// source generation and causal disk checkpoint.
    ///
    /// Callers hold the live NotebookDoc lock from authoring through this
    /// synchronous append. The precondition is checked under the durability
    /// lock, so peer changes prepared concurrently either land first and force
    /// a conflict or land afterward and remain causally dirty.
    pub(crate) fn commit_external_source_revision(
        &self,
        changes: Vec<Change>,
        observed_source: SourceFingerprint,
        canonical_path: PathBuf,
        save_sequence: u64,
    ) -> Result<DurableCommitOutcome, RoomDurabilityError> {
        self.ensure_accepting_commits()?;
        let mut state = self.lock_state();
        if state.has_durable_record
            && state.manifest.durable_heads != state.manifest.exported_heads
            && state.manifest.source_fingerprint != observed_source
        {
            return Err(RoomDurabilityError::SourceConflict {
                journal_source: state.manifest.source_fingerprint,
                observed_source,
            });
        }

        let mut durable = AutoCommit::load(&state.durable_snapshot)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        let source_hashes = changes
            .iter()
            .map(|change| change.hash().0)
            .collect::<Vec<_>>();
        let missing = changes
            .into_iter()
            .filter(|change| durable.get_change_by_hash(&change.hash()).is_none())
            .collect::<Vec<_>>();
        durable
            .apply_changes(missing)
            .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
        let durable_heads = durable
            .get_heads()
            .iter()
            .map(|head| head.0)
            .collect::<Vec<_>>();
        let snapshot = durable.save();
        let generation = state
            .manifest
            .source_generation
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;

        let mut manifest = state.manifest.clone();
        manifest.sequence = manifest
            .sequence
            .checked_add(1)
            .ok_or(RoomDurabilityError::SequenceExhausted)?;
        manifest.source_generation = generation;
        manifest.source_phase = RecoverySourcePhase::DurablyStaged;
        manifest.source_fingerprint = observed_source;
        manifest.staged_change_hashes = source_hashes;
        manifest.durable_heads = durable_heads.clone();
        manifest.exported_heads = durable_heads;
        manifest.canonical_path = Some(canonical_path);
        manifest.file_save_sequence = Some(save_sequence);

        if let Some(journal) = self.journal() {
            if let Err(error) = journal.append(&manifest, &snapshot) {
                let reason = error.to_string();
                state.degraded = Some(RoomDegradation::boundary(reason.clone()));
                self.status_tx.send_replace(status_from_state(&state));
                return Err(RoomDurabilityError::Journal(error));
            }
        }
        state.manifest = manifest;
        state.durable_snapshot = snapshot.into();
        state.has_durable_record = true;
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        Ok(DurableCommitOutcome::Committed(status))
    }

    pub(crate) fn mark_degraded(
        &self,
        kind: DegradationKind,
        reason: impl Into<String>,
    ) -> RoomDurabilityStatus {
        let mut state = self.lock_state();
        state.degraded = Some(RoomDegradation {
            kind,
            reason: reason.into(),
        });
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        status
    }

    pub(crate) fn clear_degraded(&self) -> RoomDurabilityStatus {
        let mut state = self.lock_state();
        state.degraded = None;
        let status = status_from_state(&state);
        self.status_tx.send_replace(status.clone());
        status
    }

    /// Wait until the latest durable snapshot contains every required change.
    /// A failed durability boundary returns immediately instead of
    /// masquerading as a timeout, and the wait always has a caller-supplied
    /// bound. A `SourceState` degradation does not short-circuit: the journal
    /// is healthy, so it can still satisfy the head barrier.
    pub(crate) async fn await_durable(
        &self,
        required_heads: &[String],
        timeout: Duration,
    ) -> Result<RoomDurabilityStatus, RoomDurabilityError> {
        let parsed = parse_heads(required_heads)?;
        let mut receiver = self.subscribe();
        let wait = async {
            loop {
                let status = receiver.borrow().clone();
                if let Some(RoomDegradation {
                    kind: DegradationKind::DurabilityBoundary,
                    reason,
                }) = &status.degraded
                {
                    return Err(RoomDurabilityError::Degraded(reason.clone()));
                }
                let snapshot = self.durable_snapshot();
                if status.has_durable_record && snapshot_contains_heads(&snapshot, &parsed)? {
                    return Ok(status);
                }
                if receiver.changed().await.is_err() {
                    let current = self.status();
                    if let Some(RoomDegradation {
                        kind: DegradationKind::DurabilityBoundary,
                        reason,
                    }) = current.degraded
                    {
                        return Err(RoomDurabilityError::Degraded(reason));
                    }
                    return Err(RoomDurabilityError::TimedOut);
                }
            }
        };
        tokio::time::timeout(timeout, wait)
            .await
            .map_err(|_| RoomDurabilityError::TimedOut)?
    }
}

fn status_from_state(state: &DurabilityState) -> RoomDurabilityStatus {
    RoomDurabilityStatus {
        has_durable_record: state.has_durable_record,
        journal_sequence: state.manifest.sequence,
        durable_heads: state
            .manifest
            .durable_heads
            .iter()
            .map(hex::encode)
            .collect(),
        exported_heads: state
            .manifest
            .exported_heads
            .iter()
            .map(hex::encode)
            .collect(),
        source_generation: state.manifest.source_generation,
        source_phase: state.manifest.source_phase,
        source_fingerprint: state.manifest.source_fingerprint,
        has_peer_changes: !state.manifest.peer_change_hashes.is_empty(),
        degraded: state.degraded.clone(),
    }
}

/// Promote a manifest whose committed file checkpoint exported every durable
/// head to a durably staged baseline.
///
/// Such a checkpoint proves the file on disk is a complete baseline for this
/// journal, even when no import ever staged a source generation (a notebook
/// created at a path is born without one; ordinary saves record checkpoints,
/// not staged sources). Both restore ([`RoomDurability::recovered`]) and
/// recovered-intent resolution
/// ([`RoomDurability::resolve_recovered_file_checkpoint`]) reach this shape
/// and must land in the joinable DurablyStaged phase instead of failing
/// materialization as source_degraded. A foreign disk write still fails
/// finalization as a source conflict through the fingerprint check.
///
/// The promotion never fires while a checkpoint intent is unresolved (its
/// dedicated resolution path owns the transition) or when any durable head is
/// missing from the export. Callers gate on their degraded state: a journal
/// with preserved corrupt data must not be promoted.
///
/// This normalization changes only `source_phase`. In particular it preserves
/// both `source_generation` and journal `sequence`; the caller owns the append
/// sequence for the record carrying the transition.
fn promote_full_coverage_checkpoint_baseline(manifest: &mut RecoveryManifest) {
    if matches!(
        manifest.source_phase,
        RecoverySourcePhase::Pending | RecoverySourcePhase::Failed
    ) && manifest.pending_file_checkpoint.is_none()
        && manifest.file_checkpoint_covers_durable_heads()
    {
        manifest.source_phase = RecoverySourcePhase::DurablyStaged;
    }
}

fn apply_mutation_to_manifest(manifest: &mut RecoveryManifest, mutation: DurableMutation) {
    match mutation {
        DurableMutation::Source {
            generation,
            fingerprint,
            staged_change_hashes,
        } => {
            manifest.source_generation = generation;
            manifest.source_fingerprint = fingerprint;
            manifest.source_phase = RecoverySourcePhase::DurablyStaged;
            manifest.staged_change_hashes = staged_change_hashes;
        }
        DurableMutation::Peer { change_hashes } => {
            let mut seen = manifest
                .peer_change_hashes
                .iter()
                .copied()
                .collect::<HashSet<_>>();
            for hash in change_hashes {
                if seen.insert(hash) {
                    manifest.peer_change_hashes.push(hash);
                }
            }
        }
        DurableMutation::SourceReady { generation } => {
            manifest.source_generation = generation;
            manifest.source_phase = RecoverySourcePhase::Ready;
        }
        DurableMutation::Daemon => {}
        DurableMutation::FileCheckpoint {
            canonical_path,
            file_fingerprint,
            exported_heads,
            save_sequence,
            source_generation,
        } => {
            manifest.canonical_path = Some(canonical_path);
            manifest.source_fingerprint = file_fingerprint;
            manifest.exported_heads = exported_heads;
            manifest.file_save_sequence = Some(save_sequence);
            if let Some(source_generation) = source_generation {
                manifest.source_generation = source_generation;
                manifest.source_phase = RecoverySourcePhase::DurablyStaged;
            }
            manifest.pending_file_checkpoint = None;
        }
    }
}

fn mutation_is_already_reflected(manifest: &RecoveryManifest, mutation: &DurableMutation) -> bool {
    match mutation {
        DurableMutation::Source {
            generation,
            fingerprint,
            staged_change_hashes,
        } => {
            manifest.source_generation == *generation
                && manifest.source_fingerprint == *fingerprint
                && manifest.staged_change_hashes == *staged_change_hashes
        }
        DurableMutation::Peer { change_hashes } => change_hashes
            .iter()
            .all(|hash| manifest.peer_change_hashes.contains(hash)),
        DurableMutation::SourceReady { generation } => {
            manifest.source_generation == *generation
                && manifest.source_phase == RecoverySourcePhase::Ready
        }
        DurableMutation::Daemon => true,
        DurableMutation::FileCheckpoint {
            canonical_path,
            file_fingerprint,
            exported_heads,
            save_sequence,
            source_generation,
        } => {
            manifest.canonical_path.as_ref() == Some(canonical_path)
                && manifest.source_fingerprint == *file_fingerprint
                && manifest.exported_heads == *exported_heads
                && manifest.file_save_sequence == Some(*save_sequence)
                && source_generation
                    .is_none_or(|generation| manifest.source_generation == generation)
                && manifest.pending_file_checkpoint.is_none()
        }
    }
}

fn parse_heads(heads: &[String]) -> Result<Vec<ChangeHash>, RoomDurabilityError> {
    heads
        .iter()
        .map(|head| {
            ChangeHash::from_str(head).map_err(|error| RoomDurabilityError::InvalidHead {
                head: head.clone(),
                reason: error.to_string(),
            })
        })
        .collect()
}

fn snapshot_contains_heads(
    snapshot: &[u8],
    required_heads: &[ChangeHash],
) -> Result<bool, RoomDurabilityError> {
    if required_heads.is_empty() {
        return Ok(true);
    }
    let mut doc = AutoCommit::load(snapshot)
        .map_err(|error| RoomDurabilityError::InvalidSnapshot(error.to_string()))?;
    Ok(required_heads
        .iter()
        .all(|head| doc.get_change_by_hash(head).is_some()))
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod intent_crash_matrix_tests;

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod property_tests;

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use automerge::{transaction::Transactable, ReadDoc, ROOT};

    use super::*;
    use crate::notebook_sync_server::recovery::{source_fingerprint, RecoveryLoadOutcome};

    #[tokio::test]
    async fn blocking_boundary_runs_on_current_thread_test_runtime() {
        assert_eq!(run_blocking_durability_boundary(|| 42), 42);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn blocking_boundary_runs_on_multithread_runtime() {
        assert_eq!(run_blocking_durability_boundary(|| 42), 42);
    }

    fn snapshot_with_change(value: i64) -> (Vec<u8>, Vec<[u8; 32]>, Vec<String>, [u8; 32]) {
        let mut doc = AutoCommit::new();
        doc.put(ROOT, "value", value).unwrap();
        let heads = doc.get_heads();
        let raw_heads = heads.iter().map(|head| head.0).collect::<Vec<_>>();
        let encoded_heads = heads.iter().map(ToString::to_string).collect::<Vec<_>>();
        let change_hash = doc.get_changes(&[])[0].hash().0;
        (doc.save(), raw_heads, encoded_heads, change_hash)
    }

    #[tokio::test]
    async fn peer_commit_is_durable_before_barrier_and_survives_restart() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let source = source_fingerprint(b"source");
        let mut genesis_doc = AutoCommit::new();
        let genesis = genesis_doc.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            source,
            1,
            genesis,
        );
        let (snapshot, heads, encoded_heads, change_hash) = snapshot_with_change(7);

        durability
            .commit_snapshot(
                &snapshot,
                heads,
                DurableMutation::Peer {
                    change_hashes: vec![change_hash],
                },
            )
            .unwrap();
        let status = durability
            .await_durable(&encoded_heads, Duration::from_millis(50))
            .await
            .unwrap();
        assert!(status.has_peer_changes);

        let recovered = match journal.load(source).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        assert_eq!(
            recovered.record.manifest.peer_change_hashes,
            vec![change_hash]
        );
        assert_eq!(recovered.record.automerge_snapshot, snapshot);
    }

    /// A notebook created at a path has no separately staged source
    /// generation. Its first full-coverage file checkpoint is itself the
    /// complete baseline and must become durably staged in the same commit.
    #[test]
    fn full_coverage_checkpoint_commits_as_staged_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let path = PathBuf::from("/tmp/notebook.ipynb");
        let mut genesis_doc = AutoCommit::new();
        let genesis = genesis_doc.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(path.clone()),
            source_fingerprint(b""),
            0,
            genesis,
        );
        let (snapshot, heads, _encoded_heads, change_hash) = snapshot_with_change(7);
        durability
            .commit_snapshot(
                &snapshot,
                heads.clone(),
                DurableMutation::Peer {
                    change_hashes: vec![change_hash],
                },
            )
            .unwrap();
        let exported = source_fingerprint(b"exported ipynb bytes");
        durability
            .commit_file_checkpoint(path, exported, heads, 1)
            .unwrap();
        assert_eq!(
            durability.manifest().source_phase,
            RecoverySourcePhase::DurablyStaged
        );

        let recovered = match journal.load(exported).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        assert_eq!(
            recovered.record.manifest.source_phase,
            RecoverySourcePhase::DurablyStaged
        );

        let reloaded = RoomDurability::recovered(journal, recovered);
        assert_eq!(
            reloaded.manifest().source_phase,
            RecoverySourcePhase::DurablyStaged
        );
        reloaded.commit_source_ready(0).unwrap();
        assert_eq!(reloaded.manifest().source_phase, RecoverySourcePhase::Ready);
    }

    /// Journals written before save-side baseline staging can still contain a
    /// full-coverage Pending or Failed checkpoint. Restore promotes both
    /// legacy shapes without changing their source generation.
    #[test]
    fn recovered_legacy_full_coverage_checkpoint_restores_as_staged_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let path = PathBuf::from("/tmp/notebook.ipynb");
        let mut genesis_doc = AutoCommit::new();
        let genesis = genesis_doc.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(path.clone()),
            source_fingerprint(b""),
            0,
            genesis,
        );
        let (snapshot, heads, _encoded_heads, change_hash) = snapshot_with_change(7);
        durability
            .commit_snapshot(
                &snapshot,
                heads.clone(),
                DurableMutation::Peer {
                    change_hashes: vec![change_hash],
                },
            )
            .unwrap();
        let exported = source_fingerprint(b"exported ipynb bytes");
        durability
            .commit_file_checkpoint(path, exported, heads, 1)
            .unwrap();

        let mut recovered = match journal.load(exported).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        recovered.record.manifest.source_phase = RecoverySourcePhase::Pending;

        // No code path writes Failed today, but it is a serialized variant of
        // the on-disk journal format, and restore already treats it exactly
        // like Pending. The baseline promotion must cover it the same way so
        // a journal written with Failed cannot restore as an unjoinable room.
        let mut failed_record = recovered.clone();
        failed_record.record.manifest.source_phase = RecoverySourcePhase::Failed;

        let reloaded = RoomDurability::recovered(journal.clone(), recovered);
        let manifest = reloaded.manifest();
        assert_eq!(manifest.source_phase, RecoverySourcePhase::DurablyStaged);
        assert!(manifest.file_checkpoint_covers_durable_heads());
        reloaded.commit_source_ready(0).unwrap();
        assert_eq!(reloaded.manifest().source_phase, RecoverySourcePhase::Ready);

        let reloaded_from_failed = RoomDurability::recovered(journal, failed_record);
        assert_eq!(
            reloaded_from_failed.manifest().source_phase,
            RecoverySourcePhase::DurablyStaged
        );
    }

    /// A checkpoint committed while the room is degraded remains Pending even
    /// when it covers every durable head. Once the degradation is cleared,
    /// recommitting that already-recorded checkpoint appends the missing staged
    /// transition exactly once, then becomes idempotent. This is the durability
    /// path used by an `AlreadyCurrent` save.
    #[test]
    fn repeated_full_coverage_checkpoint_stages_legacy_pending_record_once() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let path = PathBuf::from("/tmp/notebook.ipynb");
        let mut genesis_doc = AutoCommit::new();
        let genesis = genesis_doc.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(path.clone()),
            source_fingerprint(b""),
            0,
            genesis,
        );
        let (snapshot, heads, _encoded_heads, change_hash) = snapshot_with_change(7);
        durability
            .commit_snapshot(
                &snapshot,
                heads.clone(),
                DurableMutation::Peer {
                    change_hashes: vec![change_hash],
                },
            )
            .unwrap();
        let exported = source_fingerprint(b"exported ipynb bytes");
        durability.mark_degraded(
            DegradationKind::SourceState,
            "source projection unavailable",
        );
        durability
            .commit_file_checkpoint(path.clone(), exported, heads.clone(), 1)
            .unwrap();
        assert_eq!(
            durability.manifest().source_phase,
            RecoverySourcePhase::Pending
        );
        let pending = match journal.load(exported).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        assert_eq!(
            pending.record.manifest.source_phase,
            RecoverySourcePhase::Pending
        );

        durability.clear_degraded();
        let before_sequence = durability.manifest().sequence;
        let promoted = durability
            .commit_file_checkpoint(path.clone(), exported, heads.clone(), 1)
            .unwrap();
        assert!(matches!(promoted, DurableCommitOutcome::Committed(_)));
        assert_eq!(
            durability.manifest().source_phase,
            RecoverySourcePhase::DurablyStaged
        );
        assert_eq!(durability.manifest().sequence, before_sequence + 1);

        let repeated = durability
            .commit_file_checkpoint(path, exported, heads, 1)
            .unwrap();
        assert!(matches!(repeated, DurableCommitOutcome::AlreadyDurable(_)));
        assert_eq!(durability.manifest().sequence, before_sequence + 1);
    }

    /// A durable peer change committed after an already-staged baseline means
    /// disk is a stale prefix, but the baseline remains valid: recovery can
    /// replay the durable peer tail on top of it.
    #[test]
    fn recovered_checkpoint_with_unexported_tail_keeps_staged_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let path = PathBuf::from("/tmp/notebook.ipynb");
        let mut doc = AutoCommit::new();
        doc.put(ROOT, "value", 1_i64).unwrap();
        let first_snapshot = doc.save();
        let first_heads = doc
            .get_heads()
            .iter()
            .map(|head| head.0)
            .collect::<Vec<_>>();
        let first_hash = doc.get_changes(&[])[0].hash().0;
        doc.put(ROOT, "value", 2_i64).unwrap();
        let second_snapshot = doc.save();
        let second_heads = doc
            .get_heads()
            .iter()
            .map(|head| head.0)
            .collect::<Vec<_>>();
        let second_hash = doc
            .get_changes(&[])
            .iter()
            .map(|change| change.hash().0)
            .find(|hash| *hash != first_hash)
            .unwrap();
        let mut genesis_doc = AutoCommit::new();
        let genesis = genesis_doc.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(path.clone()),
            source_fingerprint(b""),
            0,
            genesis,
        );
        durability
            .commit_snapshot(
                &first_snapshot,
                first_heads.clone(),
                DurableMutation::Peer {
                    change_hashes: vec![first_hash],
                },
            )
            .unwrap();
        let exported = source_fingerprint(b"exported ipynb bytes");
        durability
            .commit_file_checkpoint(path, exported, first_heads, 1)
            .unwrap();
        durability
            .commit_snapshot(
                &second_snapshot,
                second_heads.clone(),
                DurableMutation::Peer {
                    change_hashes: vec![second_hash],
                },
            )
            .unwrap();

        let recovered = match journal.load(exported).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        let reloaded = RoomDurability::recovered(journal, recovered);
        let manifest = reloaded.manifest();
        assert!(!manifest.file_checkpoint_covers_durable_heads());
        assert_eq!(manifest.source_phase, RecoverySourcePhase::DurablyStaged);
        let required_heads = second_heads
            .iter()
            .copied()
            .map(ChangeHash)
            .collect::<Vec<_>>();
        assert!(snapshot_contains_heads(&reloaded.durable_snapshot(), &required_heads).unwrap());
    }

    /// An unresolved checkpoint intent owns its recovery through
    /// `resolve_recovered_file_checkpoint`; the baseline restore must not
    /// preempt that resolution.
    #[test]
    fn recovered_pending_checkpoint_intent_is_not_claimed_as_baseline() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let path = PathBuf::from("/tmp/notebook.ipynb");
        let mut genesis_doc = AutoCommit::new();
        let genesis = genesis_doc.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(path.clone()),
            source_fingerprint(b""),
            0,
            genesis,
        );
        let (snapshot, heads, _encoded_heads, change_hash) = snapshot_with_change(7);
        durability
            .commit_snapshot(
                &snapshot,
                heads.clone(),
                DurableMutation::Peer {
                    change_hashes: vec![change_hash],
                },
            )
            .unwrap();
        let exported = source_fingerprint(b"exported ipynb bytes");
        durability
            .prepare_file_checkpoint(path, exported, heads, 1, None)
            .unwrap();

        // The journal's latest record is the crash shape: an intent written
        // before its commit marker.
        let recovered = match journal.load(exported).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        assert!(recovered.record.manifest.pending_file_checkpoint.is_some());
        let reloaded = RoomDurability::recovered(journal, recovered);
        assert_eq!(
            reloaded.manifest().source_phase,
            RecoverySourcePhase::Pending
        );
        assert!(reloaded.manifest().pending_file_checkpoint.is_some());
    }

    #[tokio::test]
    async fn degraded_barrier_fails_without_waiting_for_timeout() {
        let (snapshot, heads, encoded_heads, _) = snapshot_with_change(1);
        let durability = RoomDurability::volatile(Uuid::nil(), snapshot, heads);
        durability.mark_degraded(DegradationKind::DurabilityBoundary, "disk full");

        let error = durability
            .await_durable(&encoded_heads, Duration::from_secs(10))
            .await
            .unwrap_err();
        assert!(matches!(error, RoomDurabilityError::Degraded(reason) if reason == "disk full"));
    }

    /// A source-level degradation leaves the journal healthy, so a durable
    /// snapshot that already contains the required heads still satisfies the
    /// barrier instead of failing as a storage error.
    #[tokio::test]
    async fn source_state_degradation_does_not_fail_a_satisfied_barrier() {
        let (snapshot, heads, encoded_heads, _) = snapshot_with_change(1);
        let durability = RoomDurability::volatile(Uuid::nil(), snapshot, heads);
        durability.mark_degraded(
            DegradationKind::SourceState,
            "source_conflict: disk changed while journal heads were not exported",
        );

        let status = durability
            .await_durable(&encoded_heads, Duration::from_secs(10))
            .await
            .expect("a healthy journal must satisfy the barrier despite a source conflict");
        assert!(status.is_degraded());
        assert!(!status.requires_durability_repair());
    }

    #[test]
    fn shutdown_freeze_rejects_later_commits_until_transaction_is_thawed() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let source = source_fingerprint(b"source");
        let mut genesis_doc = AutoCommit::new();
        let genesis = genesis_doc.save();
        let durability = RoomDurability::journaled(journal, Uuid::nil(), None, source, 0, genesis);
        let initial_manifest = durability.manifest();
        let (snapshot, heads, _, _) = snapshot_with_change(11);

        durability.freeze_commits();
        assert!(matches!(
            durability.commit_snapshot(&snapshot, heads.clone(), DurableMutation::Daemon),
            Err(RoomDurabilityError::ShutdownInProgress)
        ));
        assert_eq!(
            durability.manifest(),
            initial_manifest,
            "a post-barrier mutation must not advance acknowledged recovery heads"
        );

        durability.thaw_commits();
        durability
            .commit_snapshot(&snapshot, heads.clone(), DurableMutation::Daemon)
            .unwrap();
        assert_eq!(durability.manifest().durable_heads, heads);
    }

    #[test]
    fn older_durable_snapshot_satisfies_ancestor_head_barrier() {
        let mut doc = AutoCommit::new();
        doc.put(ROOT, "first", 1).unwrap();
        let required = doc.get_heads();
        doc.put(ROOT, "second", 2).unwrap();
        let snapshot = doc.save();

        assert!(snapshot_contains_heads(&snapshot, &required).unwrap());
    }

    #[test]
    fn stale_daemon_snapshot_cannot_regress_a_newer_peer_commit() {
        let mut older = AutoCommit::new();
        older.put(ROOT, "source", 1).unwrap();
        let older_heads = older.get_heads();
        let older_snapshot = older.save();
        let durability = RoomDurability::volatile(
            Uuid::nil(),
            older_snapshot.clone(),
            older_heads.iter().map(|head| head.0).collect(),
        );

        let mut peer = AutoCommit::load(&older_snapshot).unwrap();
        let peer_baseline = peer.get_heads();
        peer.put(ROOT, "peer", 2).unwrap();
        durability
            .commit_peer_changes(peer.get_changes(&peer_baseline))
            .unwrap();
        let after_peer = durability.status();

        durability
            .commit_snapshot(
                &older_snapshot,
                older_heads.iter().map(|head| head.0).collect(),
                DurableMutation::Daemon,
            )
            .unwrap();

        let recovered = AutoCommit::load(&durability.durable_snapshot()).unwrap();
        assert_eq!(
            recovered.get(ROOT, "peer").unwrap().unwrap().0.to_i64(),
            Some(2)
        );
        assert_eq!(durability.status().durable_heads, after_peer.durable_heads);
    }

    #[test]
    fn file_checkpoint_advances_manifest_without_regressing_newer_durable_snapshot() {
        let mut doc = AutoCommit::new();
        doc.put(ROOT, "exported", 1).unwrap();
        let exported_heads = doc.get_heads();
        doc.put(ROOT, "peer", 2).unwrap();
        let durable_heads = doc.get_heads();
        let durable_snapshot = doc.save();
        let durability = RoomDurability::volatile(
            Uuid::nil(),
            durable_snapshot.clone(),
            durable_heads.iter().map(|head| head.0).collect(),
        );
        let path = PathBuf::from("/tmp/notebook.ipynb");
        let fingerprint = source_fingerprint(b"checkpoint");

        durability
            .commit_file_checkpoint(
                path.clone(),
                fingerprint,
                exported_heads.iter().map(|head| head.0).collect(),
                9,
            )
            .unwrap();

        let manifest = durability.manifest();
        assert_eq!(manifest.canonical_path, Some(path));
        assert_eq!(manifest.exported_heads, vec![exported_heads[0].0]);
        assert_eq!(manifest.durable_heads, vec![durable_heads[0].0]);
        assert_eq!(manifest.file_save_sequence, Some(9));
        assert_eq!(durability.durable_snapshot().as_ref(), durable_snapshot);
    }

    #[test]
    fn file_checkpoint_rejects_heads_absent_from_recovery_union() {
        let (snapshot, heads, _, _) = snapshot_with_change(1);
        let durability = RoomDurability::volatile(Uuid::nil(), snapshot, heads);

        let error = durability
            .commit_file_checkpoint(
                PathBuf::from("/tmp/notebook.ipynb"),
                source_fingerprint(b"checkpoint"),
                vec![[0xff; 32]],
                1,
            )
            .unwrap_err();

        assert!(matches!(
            error,
            RoomDurabilityError::FileCheckpointHeadsNotDurable
        ));
        assert!(durability.manifest().exported_heads.is_empty());
    }

    #[test]
    fn restart_finalizes_file_replacement_from_durable_intent() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let old_source = source_fingerprint(b"old source");
        let new_source = source_fingerprint(b"new source");
        let (snapshot, heads, _, change_hash) = snapshot_with_change(1);
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            old_source,
            1,
            snapshot.clone(),
        );
        durability
            .commit_snapshot(
                &snapshot,
                heads.clone(),
                DurableMutation::Source {
                    generation: 1,
                    fingerprint: old_source,
                    staged_change_hashes: vec![change_hash],
                },
            )
            .unwrap();
        durability.commit_source_ready(1).unwrap();
        durability
            .prepare_file_checkpoint(
                PathBuf::from("/tmp/notebook.ipynb"),
                new_source,
                heads.clone(),
                2,
                None,
            )
            .unwrap();
        drop(durability);

        let recovered = match journal.load(new_source).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("pending replacement should be recoverable, got {other:?}"),
        };
        assert!(recovered.record.manifest.pending_file_checkpoint.is_some());
        let restarted = RoomDurability::recovered(journal.clone(), recovered);
        restarted
            .resolve_recovered_file_checkpoint(new_source)
            .unwrap();

        let manifest = restarted.manifest();
        assert_eq!(manifest.source_fingerprint, new_source);
        assert_eq!(manifest.exported_heads, heads);
        assert_eq!(manifest.file_save_sequence, Some(2));
        assert!(manifest.pending_file_checkpoint.is_none());
        let latest = match journal.load(new_source).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("finalized checkpoint should match disk, got {other:?}"),
        };
        assert!(latest.record.manifest.pending_file_checkpoint.is_none());
    }

    #[test]
    fn restart_aborts_checkpoint_intent_when_old_file_remains() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let old_source = source_fingerprint(b"old source");
        let new_source = source_fingerprint(b"new source");
        let (snapshot, heads, _, change_hash) = snapshot_with_change(1);
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            old_source,
            1,
            snapshot.clone(),
        );
        durability
            .commit_snapshot(
                &snapshot,
                heads.clone(),
                DurableMutation::Source {
                    generation: 1,
                    fingerprint: old_source,
                    staged_change_hashes: vec![change_hash],
                },
            )
            .unwrap();
        durability
            .prepare_file_checkpoint(
                PathBuf::from("/tmp/notebook.ipynb"),
                new_source,
                heads,
                2,
                None,
            )
            .unwrap();
        drop(durability);

        let recovered = match journal.load(old_source).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("old source should prove replacement did not occur, got {other:?}"),
        };
        let restarted = RoomDurability::recovered(journal.clone(), recovered);
        restarted
            .resolve_recovered_file_checkpoint(old_source)
            .unwrap();
        let manifest = restarted.manifest();
        assert_eq!(manifest.source_fingerprint, old_source);
        assert!(manifest.pending_file_checkpoint.is_none());
    }

    #[test]
    fn staged_source_merges_peer_changes_accepted_during_preparation() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let source_fingerprint = source_fingerprint(b"source");
        let mut genesis = AutoCommit::new();
        genesis.put(ROOT, "genesis", 1).unwrap();
        let genesis_snapshot = genesis.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            source_fingerprint,
            1,
            genesis_snapshot.clone(),
        );

        let mut peer = AutoCommit::load(&genesis_snapshot).unwrap();
        let peer_heads = peer.get_heads();
        peer.put(ROOT, "peer", 2).unwrap();
        let peer_changes = peer.get_changes(&peer_heads);
        durability.commit_peer_changes(peer_changes).unwrap();

        let mut staged = AutoCommit::load(&genesis_snapshot).unwrap();
        staged.put(ROOT, "source", 3).unwrap();
        let staged_heads = staged.get_heads();
        let staged_hashes = staged
            .get_changes(&genesis.get_heads())
            .iter()
            .map(|change| change.hash().0)
            .collect::<Vec<_>>();
        let staged_snapshot = staged.save();
        durability
            .commit_staged_source(
                &staged_snapshot,
                staged_heads.iter().map(|head| head.0).collect(),
                1,
                source_fingerprint,
                staged_hashes,
            )
            .unwrap();

        let recovered = match journal.load(source_fingerprint).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        let recovered_doc = AutoCommit::load(&recovered.record.automerge_snapshot).unwrap();
        assert_eq!(
            recovered_doc
                .get(ROOT, "source")
                .unwrap()
                .unwrap()
                .0
                .to_i64(),
            Some(3)
        );
        assert_eq!(
            recovered_doc.get(ROOT, "peer").unwrap().unwrap().0.to_i64(),
            Some(2)
        );
        assert_eq!(
            recovered.record.manifest.exported_heads,
            staged_heads.iter().map(|head| head.0).collect::<Vec<_>>()
        );
        assert_ne!(
            recovered.record.manifest.durable_heads,
            recovered.record.manifest.exported_heads
        );
    }

    #[test]
    fn observed_source_commit_rechecks_unsaved_heads_after_async_preparation() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let disk_source = source_fingerprint(b"original disk source");
        let mut genesis = AutoCommit::new();
        let genesis_snapshot = genesis.save();
        let durability = RoomDurability::journaled(
            journal,
            Uuid::nil(),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            disk_source,
            1,
            genesis_snapshot,
        );

        let mut source = AutoCommit::new();
        source.put(ROOT, "source", 1).unwrap();
        let source_heads = source.get_heads();
        let source_hashes = source
            .get_changes(&[])
            .iter()
            .map(|change| change.hash().0)
            .collect();
        durability
            .commit_snapshot(
                &source.save(),
                source_heads.iter().map(|head| head.0).collect(),
                DurableMutation::Source {
                    generation: 1,
                    fingerprint: disk_source,
                    staged_change_hashes: source_hashes,
                },
            )
            .unwrap();

        // Simulate a peer batch landing after the watcher preflight but before
        // its prepared source changes acquire the document lock.
        let mut peer = AutoCommit::load(&durability.durable_snapshot()).unwrap();
        let before_peer = peer.get_heads();
        peer.put(ROOT, "peer", 2).unwrap();
        durability
            .commit_peer_changes(peer.get_changes(&before_peer))
            .unwrap();
        let before_observed = durability.status();

        let mut observed = AutoCommit::load(&durability.durable_snapshot()).unwrap();
        let before_disk = observed.get_heads();
        observed.put(ROOT, "external", 3).unwrap();
        let observed_fingerprint = source_fingerprint(b"new external source");
        let error = durability
            .commit_external_source_revision(
                observed.get_changes(&before_disk),
                observed_fingerprint,
                PathBuf::from("/tmp/notebook.ipynb"),
                2,
            )
            .unwrap_err();

        assert!(matches!(
            error,
            RoomDurabilityError::SourceConflict {
                journal_source,
                observed_source,
            } if journal_source == disk_source && observed_source == observed_fingerprint
        ));
        let after = durability.status();
        assert_eq!(after.journal_sequence, before_observed.journal_sequence);
        assert_eq!(after.durable_heads, before_observed.durable_heads);
        assert_eq!(after.source_fingerprint, disk_source);
    }

    #[test]
    fn sequential_clean_external_revisions_advance_the_causal_file_checkpoint() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let path = PathBuf::from("/tmp/notebook.ipynb");
        let original_source = source_fingerprint(b"original source");
        let mut genesis = AutoCommit::new();
        let genesis_snapshot = genesis.save();
        let durability = RoomDurability::journaled(
            journal,
            Uuid::nil(),
            Some(path.clone()),
            original_source,
            1,
            genesis_snapshot,
        );

        let mut initial = AutoCommit::new();
        let initial_heads = initial.get_heads();
        initial.put(ROOT, "source", 0).unwrap();
        durability
            .commit_staged_source(
                &initial.save(),
                initial.get_heads().iter().map(|head| head.0).collect(),
                1,
                original_source,
                initial
                    .get_changes(&initial_heads)
                    .iter()
                    .map(|change| change.hash().0)
                    .collect(),
            )
            .unwrap();
        durability.commit_source_ready(1).unwrap();

        for (value, bytes, save_sequence) in [
            (1, b"revision one".as_slice(), 2),
            (2, b"revision two".as_slice(), 3),
        ] {
            let mut external = AutoCommit::load(&durability.durable_snapshot()).unwrap();
            let before = external.get_heads();
            external.put(ROOT, "source", value).unwrap();
            let fingerprint = source_fingerprint(bytes);
            let status = match durability
                .commit_external_source_revision(
                    external.get_changes(&before),
                    fingerprint,
                    path.clone(),
                    save_sequence,
                )
                .unwrap()
            {
                DurableCommitOutcome::Committed(status)
                | DurableCommitOutcome::AlreadyDurable(status) => status,
            };
            assert_eq!(status.durable_heads, status.exported_heads);
            assert_eq!(status.source_fingerprint, fingerprint);
            assert_eq!(status.source_phase, RecoverySourcePhase::DurablyStaged);
            durability
                .commit_source_ready(status.source_generation)
                .unwrap();
        }

        let mut peer = AutoCommit::load(&durability.durable_snapshot()).unwrap();
        let before_peer = peer.get_heads();
        peer.put(ROOT, "peer", true).unwrap();
        durability
            .commit_peer_changes(peer.get_changes(&before_peer))
            .unwrap();
        let before_conflict = durability.status();

        let mut external = AutoCommit::load(&durability.durable_snapshot()).unwrap();
        let before_external = external.get_heads();
        external.put(ROOT, "source", 3).unwrap();
        let observed_source = source_fingerprint(b"revision three");
        let error = durability
            .commit_external_source_revision(
                external.get_changes(&before_external),
                observed_source,
                path,
                4,
            )
            .unwrap_err();
        assert!(matches!(
            error,
            RoomDurabilityError::SourceConflict {
                observed_source: conflict_source,
                ..
            } if conflict_source == observed_source
        ));
        assert_eq!(durability.status(), before_conflict);
    }

    #[test]
    fn reconciled_file_checkpoint_advances_source_generation_in_the_same_record() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let old_source = source_fingerprint(b"old source");
        let (snapshot, heads, _, _) = snapshot_with_change(4);
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            old_source,
            2,
            snapshot.clone(),
        );
        durability
            .commit_snapshot(&snapshot, heads.clone(), DurableMutation::Daemon)
            .unwrap();
        let selected_source = source_fingerprint(b"selected recovered source");

        durability
            .commit_reconciled_file_checkpoint(
                PathBuf::from("/tmp/recovered.ipynb"),
                selected_source,
                heads.clone(),
                9,
                3,
            )
            .unwrap();

        let recovered = match journal.load(selected_source).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected matching recovery, got {other:?}"),
        };
        assert_eq!(recovered.record.manifest.source_generation, 3);
        assert_eq!(recovered.record.manifest.durable_heads, heads);
        assert_eq!(recovered.record.manifest.exported_heads, heads);
        assert_eq!(recovered.record.manifest.file_save_sequence, Some(9));
        assert_eq!(
            recovered.record.manifest.canonical_path,
            Some(PathBuf::from("/tmp/recovered.ipynb"))
        );
    }

    #[test]
    fn archive_reload_preserves_old_history_and_commits_a_new_active_journal() {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let old_source = source_fingerprint(b"recovered source");
        let (recovered_snapshot, recovered_heads, _, peer_hash) = snapshot_with_change(7);
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(PathBuf::from("/tmp/notebook.ipynb")),
            old_source,
            4,
            recovered_snapshot.clone(),
        );
        durability
            .commit_snapshot(
                &recovered_snapshot,
                recovered_heads.clone(),
                DurableMutation::Peer {
                    change_hashes: vec![peer_hash],
                },
            )
            .unwrap();

        let recovered_head_hashes = recovered_heads
            .iter()
            .copied()
            .map(ChangeHash)
            .collect::<Vec<_>>();
        let mut disk_selected = AutoCommit::load(&recovered_snapshot).unwrap();
        disk_selected.put(ROOT, "disk-selected", 11).unwrap();
        let replacement_hashes = disk_selected
            .get_changes(&recovered_head_hashes)
            .iter()
            .map(|change| change.hash().0)
            .collect::<Vec<_>>();
        let selected_heads = disk_selected
            .get_heads()
            .iter()
            .map(|head| head.0)
            .collect::<Vec<_>>();
        let selected_snapshot = disk_selected.save();
        let selected_source = source_fingerprint(b"disk source");

        let commit = durability
            .archive_and_commit_reconciled_source(
                &selected_snapshot,
                selected_heads.clone(),
                PathBuf::from("/tmp/notebook.ipynb"),
                selected_source,
                5,
                replacement_hashes.clone(),
                12,
            )
            .unwrap();

        assert!(commit.archived_directory.is_dir());
        assert_eq!(commit.status.source_generation, 5);
        assert!(!commit.status.has_peer_changes);
        let active = match journal.load(selected_source).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected selected active recovery, got {other:?}"),
        };
        assert_eq!(
            active.record.manifest.staged_change_hashes,
            replacement_hashes
        );
        assert!(active.record.manifest.peer_change_hashes.is_empty());
        assert_eq!(active.record.manifest.durable_heads, selected_heads);
        assert_eq!(active.record.manifest.exported_heads, selected_heads);
        assert_eq!(active.record.manifest.file_save_sequence, Some(12));

        let archived = RecoveryJournal::new(commit.archived_directory.join("room.recovery"));
        let archived_record = match archived.load(old_source).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("expected preserved archived recovery, got {other:?}"),
        };
        assert_eq!(
            archived_record.record.manifest.peer_change_hashes,
            vec![peer_hash]
        );
        assert_eq!(
            archived_record.record.automerge_snapshot,
            recovered_snapshot
        );
    }
}
