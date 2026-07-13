//! Causal `.ipynb` checkpoint coordination.
//!
//! Saving is deliberately two phase. A claim receives a monotonic sequence,
//! then the complete temporary file is written and flushed without holding the
//! coordinator lock. The sequence is checked again while holding that lock
//! immediately before the synchronous atomic replacement. This prevents an
//! older completion from replacing a newer file or regressing checkpoint
//! metadata.

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use std::time::SystemTime;

use tokio::sync::broadcast;

use super::recovery::{source_fingerprint, SourceFingerprint};

const CHECKPOINT_EVENT_CAPACITY: usize = 32;

/// Exact file metadata a save intends to make durable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileCheckpointTarget {
    pub(crate) path: PathBuf,
    pub(crate) exported_heads: Vec<[u8; 32]>,
    pub(crate) file_fingerprint: SourceFingerprint,
}

impl FileCheckpointTarget {
    pub(crate) fn new(
        path: impl Into<PathBuf>,
        exported_heads: Vec<[u8; 32]>,
        file_fingerprint: SourceFingerprint,
    ) -> Self {
        Self {
            path: path.into(),
            exported_heads,
            file_fingerprint,
        }
    }

    pub(crate) fn for_content(
        path: impl Into<PathBuf>,
        exported_heads: Vec<[u8; 32]>,
        content: &[u8],
    ) -> Self {
        Self::new(path, exported_heads, source_fingerprint(content))
    }

    fn matches_checkpoint(&self, checkpoint: &FileCheckpoint) -> bool {
        self.path == checkpoint.path
            && self.exported_heads == checkpoint.exported_heads
            && self.file_fingerprint == checkpoint.file_fingerprint
    }
}

/// The last `.ipynb` revision known to have completed atomic replacement and
/// directory synchronization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileCheckpoint {
    pub(crate) path: PathBuf,
    pub(crate) exported_heads: Vec<[u8; 32]>,
    pub(crate) file_fingerprint: SourceFingerprint,
    pub(crate) save_sequence: u64,
    pub(crate) saved_at: SystemTime,
}

/// Emitted only after both file replacement and checkpoint advancement.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileCheckpointEvent {
    pub(crate) checkpoint: FileCheckpoint,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SaveIoStage {
    CreateTemp,
    WriteTemp,
    FlushTemp,
    Replace,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SaveBlockedReason {
    SequenceExhausted,
    ContentFingerprintMismatch {
        declared: SourceFingerprint,
        actual: SourceFingerprint,
    },
    Superseded {
        latest_sequence: u64,
    },
    Io {
        stage: SaveIoStage,
        message: String,
    },
    /// Atomic file replacement completed, but the causal journal marker did
    /// not. The file remains intact while checkpoint state/event publication
    /// stays blocked.
    Commit {
        message: String,
    },
}

/// Honest save result. `Saved` is the only outcome that advances the
/// checkpoint timestamp or emits a checkpoint event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SaveOutcome {
    Saved {
        checkpoint: FileCheckpoint,
    },
    AlreadyCurrent {
        checkpoint: FileCheckpoint,
        claim_sequence: u64,
    },
    Blocked {
        save_sequence: Option<u64>,
        reason: SaveBlockedReason,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct SaveClaimError;

/// A monotonic save sequence reserved before any asynchronous preparation.
///
/// The exact file target is bound only after notebook formatting, blob
/// resolution, and serialization finish. Reserving first makes request order,
/// rather than blocking-worker scheduling order, authoritative.
#[derive(Debug)]
pub(crate) struct SaveSequenceClaim {
    sequence: u64,
}

impl SaveSequenceClaim {
    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }
}

/// A one-shot claim. It is intentionally not `Clone`: completion consumes the
/// claim, and the coordinator checks its sequence again before replacement.
#[derive(Debug)]
pub(crate) struct SaveClaim {
    sequence: u64,
    target: FileCheckpointTarget,
    already_current: Option<FileCheckpoint>,
}

impl SaveClaim {
    pub(crate) fn sequence(&self) -> u64 {
        self.sequence
    }

    pub(crate) fn target(&self) -> &FileCheckpointTarget {
        &self.target
    }
}

#[derive(Debug)]
struct CheckpointState {
    latest_claimed_sequence: u64,
    checkpoint: Option<FileCheckpoint>,
}

/// Serializes sequence claims and the short replace/checkpoint commit section.
#[derive(Debug)]
pub(crate) struct FileCheckpointCoordinator {
    state: Mutex<CheckpointState>,
    events: broadcast::Sender<FileCheckpointEvent>,
}

impl Default for FileCheckpointCoordinator {
    fn default() -> Self {
        Self::new(None)
    }
}

impl FileCheckpointCoordinator {
    pub(crate) fn new(initial_checkpoint: Option<FileCheckpoint>) -> Self {
        let latest_claimed_sequence = initial_checkpoint
            .as_ref()
            .map_or(0, |checkpoint| checkpoint.save_sequence);
        let (events, _) = broadcast::channel(CHECKPOINT_EVENT_CAPACITY);
        Self {
            state: Mutex::new(CheckpointState {
                latest_claimed_sequence,
                checkpoint: initial_checkpoint,
            }),
            events,
        }
    }

    /// Reserve the next monotonic save sequence before asynchronous work.
    ///
    /// Even an already-current request advances the sequence so it can
    /// supersede an older in-flight write to a different revision.
    pub(crate) fn reserve(&self) -> Result<SaveSequenceClaim, SaveClaimError> {
        let mut state = self.lock_state();
        let Some(sequence) = state.latest_claimed_sequence.checked_add(1) else {
            return Err(SaveClaimError);
        };
        state.latest_claimed_sequence = sequence;
        Ok(SaveSequenceClaim { sequence })
    }

    /// Claim a fully prepared target in one synchronous operation.
    ///
    /// Production save paths reserve before preparation and use
    /// [`Self::complete_reserved`]. This convenience is retained for callers
    /// that already have immutable content and for focused coordinator tests.
    pub(crate) fn claim(&self, target: FileCheckpointTarget) -> Result<SaveClaim, SaveClaimError> {
        let reservation = self.reserve()?;
        Ok(self.bind(reservation, target))
    }

    fn bind(&self, reservation: SaveSequenceClaim, target: FileCheckpointTarget) -> SaveClaim {
        let sequence = reservation.sequence;
        let state = self.lock_state();
        let already_current = state
            .checkpoint
            .as_ref()
            .filter(|checkpoint| target.matches_checkpoint(checkpoint))
            .cloned();
        SaveClaim {
            sequence,
            target,
            already_current,
        }
    }

    pub(crate) fn checkpoint(&self) -> Option<FileCheckpoint> {
        self.lock_state().checkpoint.clone()
    }

    /// Restore the last journal-committed checkpoint during room startup.
    /// No event is emitted: this is recovered state, not a new file save.
    pub(crate) fn restore(&self, checkpoint: FileCheckpoint) {
        let mut state = self.lock_state();
        if state
            .checkpoint
            .as_ref()
            .is_some_and(|current| current.save_sequence > checkpoint.save_sequence)
        {
            return;
        }
        state.latest_claimed_sequence = state.latest_claimed_sequence.max(checkpoint.save_sequence);
        state.checkpoint = Some(checkpoint);
    }

    pub(crate) fn latest_claimed_sequence(&self) -> u64 {
        self.lock_state().latest_claimed_sequence
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<FileCheckpointEvent> {
        self.events.subscribe()
    }

    /// Claim, prepare, and causally commit one file checkpoint.
    pub(crate) fn save(&self, target: FileCheckpointTarget, content: &[u8]) -> SaveOutcome {
        self.save_with(target, content, &RealCheckpointIo, &SystemCheckpointClock)
    }

    /// Prepare and commit an exact previously ordered claim.
    ///
    /// Call [`Self::claim`] before handing work to `spawn_blocking`, then move
    /// that claim into the blocking task and complete it here. This preserves
    /// caller-visible save ordering even when blocking workers begin out of
    /// order.
    pub(crate) fn complete(&self, claim: SaveClaim, content: &[u8]) -> SaveOutcome {
        self.complete_with(claim, content, &RealCheckpointIo, &SystemCheckpointClock)
    }

    /// Bind an exact target to a sequence reserved before asynchronous
    /// preparation, then complete it on the calling thread.
    pub(crate) fn complete_reserved(
        &self,
        reservation: SaveSequenceClaim,
        target: FileCheckpointTarget,
        content: &[u8],
    ) -> SaveOutcome {
        let claim = self.bind(reservation, target);
        self.complete(claim, content)
    }

    /// Complete a reserved save and require a post-replacement causal commit
    /// before advancing coordinator state or emitting the checkpoint event.
    pub(crate) fn complete_reserved_with_commit(
        &self,
        reservation: SaveSequenceClaim,
        target: FileCheckpointTarget,
        content: &[u8],
        commit: impl FnOnce(&FileCheckpoint) -> Result<(), String>,
    ) -> SaveOutcome {
        let claim = self.bind(reservation, target);
        self.complete_with_commit(
            claim,
            content,
            &RealCheckpointIo,
            &SystemCheckpointClock,
            commit,
        )
    }

    /// Select an already-existing disk revision as the causal checkpoint for
    /// an explicit source reconciliation.
    ///
    /// This performs no file write and emits no `FileCheckpointEvent`. It
    /// holds the sequence lock from the final supersession check through the
    /// caller's journal commit and checkpoint publication, so an older async
    /// reload cannot regress a newer save request.
    pub(crate) fn commit_existing_with<T>(
        &self,
        reservation: SaveSequenceClaim,
        checkpoint: FileCheckpoint,
        commit: impl FnOnce(&FileCheckpoint) -> Result<T, String>,
    ) -> Result<T, SaveBlockedReason> {
        debug_assert_eq!(reservation.sequence, checkpoint.save_sequence);
        let mut state = self.lock_state();
        if state.latest_claimed_sequence != reservation.sequence {
            return Err(SaveBlockedReason::Superseded {
                latest_sequence: state.latest_claimed_sequence,
            });
        }
        let committed =
            commit(&checkpoint).map_err(|message| SaveBlockedReason::Commit { message })?;
        state.checkpoint = Some(checkpoint);
        Ok(committed)
    }

    fn save_with(
        &self,
        target: FileCheckpointTarget,
        content: &[u8],
        io: &dyn CheckpointIo,
        clock: &dyn CheckpointClock,
    ) -> SaveOutcome {
        let claim = match self.claim(target) {
            Ok(claim) => claim,
            Err(SaveClaimError) => {
                return SaveOutcome::Blocked {
                    save_sequence: None,
                    reason: SaveBlockedReason::SequenceExhausted,
                };
            }
        };
        self.complete_with(claim, content, io, clock)
    }

    fn complete_with(
        &self,
        claim: SaveClaim,
        content: &[u8],
        io: &dyn CheckpointIo,
        clock: &dyn CheckpointClock,
    ) -> SaveOutcome {
        self.complete_with_commit(claim, content, io, clock, |_| Ok(()))
    }

    fn complete_with_commit(
        &self,
        claim: SaveClaim,
        content: &[u8],
        io: &dyn CheckpointIo,
        clock: &dyn CheckpointClock,
        commit: impl FnOnce(&FileCheckpoint) -> Result<(), String>,
    ) -> SaveOutcome {
        let actual_fingerprint = source_fingerprint(content);
        if actual_fingerprint != claim.target.file_fingerprint {
            return SaveOutcome::Blocked {
                save_sequence: Some(claim.sequence),
                reason: SaveBlockedReason::ContentFingerprintMismatch {
                    declared: claim.target.file_fingerprint,
                    actual: actual_fingerprint,
                },
            };
        }

        if let Some(checkpoint) = claim.already_current {
            let state = self.lock_state();
            if state.latest_claimed_sequence != claim.sequence {
                return SaveOutcome::Blocked {
                    save_sequence: Some(claim.sequence),
                    reason: SaveBlockedReason::Superseded {
                        latest_sequence: state.latest_claimed_sequence,
                    },
                };
            }
            if state.checkpoint.as_ref() == Some(&checkpoint)
                && claim.target.matches_checkpoint(&checkpoint)
            {
                return SaveOutcome::AlreadyCurrent {
                    checkpoint,
                    claim_sequence: claim.sequence,
                };
            }
        }

        let temporary_path = sibling_temp_path(&claim.target.path, claim.sequence);
        let mut temporary = match io.create_temp(&temporary_path, &claim.target.path) {
            Ok(file) => file,
            Err(error) => {
                return blocked_io(claim.sequence, SaveIoStage::CreateTemp, error);
            }
        };
        if let Err(error) = io.write_temp(&mut temporary, content) {
            drop(temporary);
            io.remove_temp(&temporary_path);
            return blocked_io(claim.sequence, SaveIoStage::WriteTemp, error);
        }
        if let Err(error) = io.flush_temp(&temporary) {
            drop(temporary);
            io.remove_temp(&temporary_path);
            return blocked_io(claim.sequence, SaveIoStage::FlushTemp, error);
        }
        drop(temporary);

        // The temp file is complete and fsynced before checkpoint state is
        // serialized. Hold the same lock used by `claim` from this sequence
        // check through synchronous replacement and checkpoint publication.
        let mut state = self.lock_state();
        if state.latest_claimed_sequence != claim.sequence {
            let latest_sequence = state.latest_claimed_sequence;
            drop(state);
            io.remove_temp(&temporary_path);
            return SaveOutcome::Blocked {
                save_sequence: Some(claim.sequence),
                reason: SaveBlockedReason::Superseded { latest_sequence },
            };
        }

        if let Err(error) = io.replace_temp(&temporary_path, &claim.target.path) {
            drop(state);
            io.remove_temp(&temporary_path);
            return blocked_io(claim.sequence, SaveIoStage::Replace, error);
        }

        let checkpoint = FileCheckpoint {
            path: claim.target.path,
            exported_heads: claim.target.exported_heads,
            file_fingerprint: claim.target.file_fingerprint,
            save_sequence: claim.sequence,
            saved_at: clock.now(),
        };
        if let Err(message) = commit(&checkpoint) {
            return SaveOutcome::Blocked {
                save_sequence: Some(claim.sequence),
                reason: SaveBlockedReason::Commit { message },
            };
        }
        state.checkpoint = Some(checkpoint.clone());
        let _ = self.events.send(FileCheckpointEvent {
            checkpoint: checkpoint.clone(),
        });
        SaveOutcome::Saved { checkpoint }
    }

    fn lock_state(&self) -> MutexGuard<'_, CheckpointState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn blocked_io(sequence: u64, stage: SaveIoStage, error: io::Error) -> SaveOutcome {
    SaveOutcome::Blocked {
        save_sequence: Some(sequence),
        reason: SaveBlockedReason::Io {
            stage,
            message: error.to_string(),
        },
    }
}

trait CheckpointClock: Send + Sync {
    fn now(&self) -> SystemTime;
}

struct SystemCheckpointClock;

impl CheckpointClock for SystemCheckpointClock {
    fn now(&self) -> SystemTime {
        SystemTime::now()
    }
}

trait CheckpointIo: Send + Sync {
    fn create_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<File>;
    fn write_temp(&self, temporary: &mut File, content: &[u8]) -> io::Result<()>;
    fn flush_temp(&self, temporary: &File) -> io::Result<()>;
    fn replace_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<()>;
    fn remove_temp(&self, temporary_path: &Path);
}

struct RealCheckpointIo;

impl CheckpointIo for RealCheckpointIo {
    fn create_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<File> {
        ensure_parent_directory(target_path)?;
        let temporary = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(temporary_path)?;
        if let Ok(metadata) = std::fs::metadata(target_path) {
            std::fs::set_permissions(temporary_path, metadata.permissions())?;
        }
        Ok(temporary)
    }

    fn write_temp(&self, temporary: &mut File, content: &[u8]) -> io::Result<()> {
        temporary.write_all(content)
    }

    fn flush_temp(&self, temporary: &File) -> io::Result<()> {
        temporary.sync_all()
    }

    fn replace_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<()> {
        replace_file(temporary_path, target_path)?;
        sync_parent_directory(target_path)
    }

    fn remove_temp(&self, temporary_path: &Path) {
        let _ = std::fs::remove_file(temporary_path);
    }
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

fn sibling_temp_path(target: &Path, save_sequence: u64) -> PathBuf {
    static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
    let counter = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let file_name = target
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "notebook".to_string());
    target.with_file_name(format!(
        ".{file_name}.{}-{save_sequence}-{counter}.checkpoint.tmp",
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
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        File::open(parent)?.sync_all()?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn sync_parent_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::unwrap_used)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering as AtomicOrdering};
    use std::sync::{mpsc, Arc};
    use std::thread;
    use std::time::Duration;

    #[derive(Default)]
    struct CountingClock {
        calls: AtomicUsize,
    }

    impl CountingClock {
        fn calls(&self) -> usize {
            self.calls.load(AtomicOrdering::SeqCst)
        }
    }

    impl CheckpointClock for CountingClock {
        fn now(&self) -> SystemTime {
            let call = self.calls.fetch_add(1, AtomicOrdering::SeqCst) as u64;
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_000 + call)
        }
    }

    #[derive(Clone, Copy)]
    struct InjectedFailureIo {
        failure: SaveIoStage,
    }

    impl CheckpointIo for InjectedFailureIo {
        fn create_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<File> {
            if self.failure == SaveIoStage::CreateTemp {
                return Err(io::Error::other("injected create failure"));
            }
            RealCheckpointIo.create_temp(temporary_path, target_path)
        }

        fn write_temp(&self, temporary: &mut File, content: &[u8]) -> io::Result<()> {
            if self.failure == SaveIoStage::WriteTemp {
                return Err(io::Error::other("injected write failure"));
            }
            RealCheckpointIo.write_temp(temporary, content)
        }

        fn flush_temp(&self, temporary: &File) -> io::Result<()> {
            if self.failure == SaveIoStage::FlushTemp {
                return Err(io::Error::other("injected flush failure"));
            }
            RealCheckpointIo.flush_temp(temporary)
        }

        fn replace_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<()> {
            if self.failure == SaveIoStage::Replace {
                return Err(io::Error::other("injected replace failure"));
            }
            RealCheckpointIo.replace_temp(temporary_path, target_path)
        }

        fn remove_temp(&self, temporary_path: &Path) {
            RealCheckpointIo.remove_temp(temporary_path);
        }
    }

    struct BlockingFlushIo {
        prepared: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl CheckpointIo for BlockingFlushIo {
        fn create_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<File> {
            RealCheckpointIo.create_temp(temporary_path, target_path)
        }

        fn write_temp(&self, temporary: &mut File, content: &[u8]) -> io::Result<()> {
            RealCheckpointIo.write_temp(temporary, content)
        }

        fn flush_temp(&self, temporary: &File) -> io::Result<()> {
            RealCheckpointIo.flush_temp(temporary)?;
            self.prepared
                .send(())
                .map_err(|_| io::Error::other("prepared receiver dropped"))?;
            self.release
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .recv()
                .map_err(|_| io::Error::other("release sender dropped"))?;
            Ok(())
        }

        fn replace_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<()> {
            RealCheckpointIo.replace_temp(temporary_path, target_path)
        }

        fn remove_temp(&self, temporary_path: &Path) {
            RealCheckpointIo.remove_temp(temporary_path);
        }
    }

    fn target(path: &Path, head: u8, content: &[u8]) -> FileCheckpointTarget {
        FileCheckpointTarget::for_content(path, vec![[head; 32]], content)
    }

    fn assert_blocked_at(outcome: SaveOutcome, expected_stage: SaveIoStage) {
        assert!(matches!(
            outcome,
            SaveOutcome::Blocked {
                save_sequence: Some(1),
                reason: SaveBlockedReason::Io { stage, .. },
            } if stage == expected_stage
        ));
    }

    fn assert_no_commit(
        coordinator: &FileCheckpointCoordinator,
        clock: &CountingClock,
        events: &mut broadcast::Receiver<FileCheckpointEvent>,
    ) {
        assert!(coordinator.checkpoint().is_none());
        assert_eq!(clock.calls(), 0);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn successful_save_records_exact_causal_checkpoint_and_event() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        let content = b"{\"cells\":[]}";
        let target = target(&path, 9, content);
        let coordinator = FileCheckpointCoordinator::default();
        let clock = CountingClock::default();
        let mut events = coordinator.subscribe();

        let outcome = coordinator.save_with(target.clone(), content, &RealCheckpointIo, &clock);
        let checkpoint = match outcome {
            SaveOutcome::Saved { checkpoint } => checkpoint,
            other => panic!("expected saved checkpoint, got {other:?}"),
        };

        assert_eq!(std::fs::read(&path).unwrap(), content);
        assert_eq!(checkpoint.path, path);
        assert_eq!(checkpoint.exported_heads, vec![[9; 32]]);
        assert_eq!(checkpoint.file_fingerprint, source_fingerprint(content));
        assert_eq!(checkpoint.save_sequence, 1);
        assert_eq!(
            checkpoint.saved_at,
            SystemTime::UNIX_EPOCH + Duration::from_secs(1_000)
        );
        assert_eq!(coordinator.checkpoint(), Some(checkpoint.clone()));
        assert_eq!(events.try_recv().unwrap().checkpoint, checkpoint);
        assert_eq!(clock.calls(), 1);
    }

    #[test]
    fn already_current_advances_claim_but_not_checkpoint_timestamp_or_event() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        let content = b"current";
        let target = target(&path, 1, content);
        let coordinator = FileCheckpointCoordinator::default();
        let clock = CountingClock::default();
        let mut events = coordinator.subscribe();

        let saved = coordinator.save_with(target.clone(), content, &RealCheckpointIo, &clock);
        let checkpoint = match saved {
            SaveOutcome::Saved { checkpoint } => checkpoint,
            other => panic!("expected initial save, got {other:?}"),
        };
        assert_eq!(events.try_recv().unwrap().checkpoint, checkpoint);

        assert_eq!(
            coordinator.save_with(target, content, &RealCheckpointIo, &clock),
            SaveOutcome::AlreadyCurrent {
                checkpoint: checkpoint.clone(),
                claim_sequence: 2,
            }
        );
        assert_eq!(coordinator.latest_claimed_sequence(), 2);
        assert_eq!(coordinator.checkpoint(), Some(checkpoint));
        assert_eq!(clock.calls(), 1);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn write_failure_does_not_advance_checkpoint_timestamp_or_event() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        let content = b"new";
        let coordinator = FileCheckpointCoordinator::default();
        let clock = CountingClock::default();
        let mut events = coordinator.subscribe();

        let outcome = coordinator.save_with(
            target(&path, 1, content),
            content,
            &InjectedFailureIo {
                failure: SaveIoStage::WriteTemp,
            },
            &clock,
        );

        assert_blocked_at(outcome, SaveIoStage::WriteTemp);
        assert_no_commit(&coordinator, &clock, &mut events);
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn flush_failure_does_not_advance_checkpoint_timestamp_or_event() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        let content = b"new";
        let coordinator = FileCheckpointCoordinator::default();
        let clock = CountingClock::default();
        let mut events = coordinator.subscribe();

        let outcome = coordinator.save_with(
            target(&path, 1, content),
            content,
            &InjectedFailureIo {
                failure: SaveIoStage::FlushTemp,
            },
            &clock,
        );

        assert_blocked_at(outcome, SaveIoStage::FlushTemp);
        assert_no_commit(&coordinator, &clock, &mut events);
        assert!(!path.exists());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn replace_failure_preserves_old_file_and_does_not_advance_state() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        std::fs::write(&path, b"old").unwrap();
        let content = b"new";
        let coordinator = FileCheckpointCoordinator::default();
        let clock = CountingClock::default();
        let mut events = coordinator.subscribe();

        let outcome = coordinator.save_with(
            target(&path, 1, content),
            content,
            &InjectedFailureIo {
                failure: SaveIoStage::Replace,
            },
            &clock,
        );

        assert_blocked_at(outcome, SaveIoStage::Replace);
        assert_no_commit(&coordinator, &clock, &mut events);
        assert_eq!(std::fs::read(&path).unwrap(), b"old");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn journal_commit_failure_keeps_replaced_file_but_emits_no_checkpoint() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        std::fs::write(&path, b"old").unwrap();
        let content = b"new";
        let coordinator = FileCheckpointCoordinator::default();
        let clock = CountingClock::default();
        let mut events = coordinator.subscribe();
        let claim = coordinator.claim(target(&path, 1, content)).unwrap();

        let outcome =
            coordinator.complete_with_commit(claim, content, &RealCheckpointIo, &clock, |_| {
                Err("injected journal failure".to_string())
            });

        assert_eq!(
            outcome,
            SaveOutcome::Blocked {
                save_sequence: Some(1),
                reason: SaveBlockedReason::Commit {
                    message: "injected journal failure".to_string(),
                },
            }
        );
        assert_eq!(std::fs::read(&path).unwrap(), content);
        assert!(coordinator.checkpoint().is_none());
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert_eq!(clock.calls(), 1);
    }

    #[test]
    fn newer_save_claim_blocks_older_completion_before_replace() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        let old_content = b"old completion".to_vec();
        let new_content = b"new completion".to_vec();
        let coordinator = Arc::new(FileCheckpointCoordinator::default());
        let clock = Arc::new(CountingClock::default());
        let mut events = coordinator.subscribe();
        let (prepared_tx, prepared_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let old_io = BlockingFlushIo {
            prepared: prepared_tx,
            release: Mutex::new(release_rx),
        };
        let old_claim = coordinator.claim(target(&path, 1, &old_content)).unwrap();

        let old_coordinator = Arc::clone(&coordinator);
        let old_clock = Arc::clone(&clock);
        let old_thread = thread::spawn(move || {
            old_coordinator.complete_with(old_claim, &old_content, &old_io, old_clock.as_ref())
        });

        prepared_rx.recv().unwrap();
        let new_claim = coordinator.claim(target(&path, 2, &new_content)).unwrap();
        let new_outcome =
            coordinator.complete_with(new_claim, &new_content, &RealCheckpointIo, clock.as_ref());
        let new_checkpoint = match new_outcome {
            SaveOutcome::Saved { checkpoint } => checkpoint,
            other => panic!("expected newer save to commit, got {other:?}"),
        };
        release_tx.send(()).unwrap();
        let old_outcome = old_thread.join().unwrap();

        assert_eq!(
            old_outcome,
            SaveOutcome::Blocked {
                save_sequence: Some(1),
                reason: SaveBlockedReason::Superseded { latest_sequence: 2 },
            }
        );
        assert_eq!(std::fs::read(&path).unwrap(), new_content);
        assert_eq!(new_checkpoint.save_sequence, 2);
        assert_eq!(new_checkpoint.exported_heads, vec![[2; 32]]);
        assert_eq!(coordinator.checkpoint(), Some(new_checkpoint.clone()));
        assert_eq!(events.try_recv().unwrap().checkpoint, new_checkpoint);
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
        assert_eq!(clock.calls(), 1);
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn restored_checkpoint_continues_monotonic_sequence_claims() {
        let initial = FileCheckpoint {
            path: PathBuf::from("/tmp/notebook.ipynb"),
            exported_heads: vec![[4; 32]],
            file_fingerprint: source_fingerprint(b"old"),
            save_sequence: 41,
            saved_at: SystemTime::UNIX_EPOCH,
        };
        let coordinator = FileCheckpointCoordinator::new(Some(initial));

        let claim = coordinator
            .claim(FileCheckpointTarget::for_content(
                "/tmp/notebook.ipynb",
                vec![[5; 32]],
                b"new",
            ))
            .unwrap();

        assert_eq!(claim.sequence(), 42);
        assert_eq!(coordinator.latest_claimed_sequence(), 42);
        assert_eq!(claim.target().exported_heads, vec![[5; 32]]);
    }

    #[test]
    fn existing_source_checkpoint_rejects_a_superseded_reservation_before_commit() {
        let coordinator = FileCheckpointCoordinator::default();
        let old_reservation = coordinator.reserve().unwrap();
        let _new_reservation = coordinator.reserve().unwrap();
        let checkpoint = FileCheckpoint {
            path: PathBuf::from("/tmp/notebook.ipynb"),
            exported_heads: vec![[1; 32]],
            file_fingerprint: source_fingerprint(b"disk"),
            save_sequence: old_reservation.sequence(),
            saved_at: SystemTime::UNIX_EPOCH,
        };
        let mut commit_called = false;

        let result = coordinator.commit_existing_with(old_reservation, checkpoint, |_| {
            commit_called = true;
            Ok(())
        });

        assert_eq!(
            result,
            Err(SaveBlockedReason::Superseded { latest_sequence: 2 })
        );
        assert!(!commit_called);
        assert!(coordinator.checkpoint().is_none());
    }

    #[test]
    fn existing_source_checkpoint_commits_without_emitting_a_saved_event() {
        let coordinator = FileCheckpointCoordinator::default();
        let reservation = coordinator.reserve().unwrap();
        let checkpoint = FileCheckpoint {
            path: PathBuf::from("/tmp/notebook.ipynb"),
            exported_heads: vec![[7; 32]],
            file_fingerprint: source_fingerprint(b"disk"),
            save_sequence: reservation.sequence(),
            saved_at: SystemTime::UNIX_EPOCH,
        };
        let mut events = coordinator.subscribe();

        let committed = coordinator
            .commit_existing_with(reservation, checkpoint.clone(), |_| Ok(7))
            .unwrap();

        assert_eq!(committed, 7);
        assert_eq!(coordinator.checkpoint(), Some(checkpoint));
        assert!(matches!(
            events.try_recv(),
            Err(broadcast::error::TryRecvError::Empty)
        ));
    }
}
