//! Stateful model tests for [`FileCheckpointCoordinator`].
//!
//! A shadow model predicts the outcome of every operation
//! (reserve/bind/complete_with_callbacks/commit_existing_with) and the
//! resulting coordinator, disk, and published-checkpoint state; each step
//! asserts the real coordinator against the prediction. Faults are injected
//! through a scripted [`CheckpointIo`] plus scripted prepare/abort/commit
//! callbacks, so every failure boundary in the two-phase save is reachable
//! deterministically.
//!
//! `SaveOutcome` plus `coordinator.checkpoint()` are the complete observable
//! record of a save. Oracles checked after every step:
//! - barrier and published checkpoint sequences are monotone
//! - reserving a sequence alone never supersedes an older viable save
//! - a save blocked before atomic replacement leaves disk untouched and the
//!   published checkpoint unchanged
//! - a commit failure after replacement advances disk bytes and the barrier
//!   but not the published checkpoint
//! - `Saved` advances the published checkpoint to exactly the completed
//!   save's checkpoint, and the disk bytes match it
//! - the published fingerprint equals the disk bytes whenever the published
//!   checkpoint owns the path (its content is what is on disk)
//! - no temporary files are left behind on any path

#![allow(clippy::expect_used, clippy::unwrap_used)]

use super::*;

use std::fs;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::time::Duration;

use proptest::prelude::*;

/// Distinct notebook contents. Content identity doubles as target identity:
/// exported heads derive from the content index, so re-saving the same
/// content exercises the AlreadyCurrent path.
const CONTENTS: [&[u8]; 4] = [
    b"{\"cells\":[\"alpha\"]}",
    b"{\"cells\":[\"beta\"]}",
    b"{\"cells\":[\"gamma\"]}",
    b"{\"cells\":[\"delta\"]}",
];

fn heads_for(content: usize) -> Vec<[u8; 32]> {
    vec![[u8::try_from(content).unwrap() + 1; 32]]
}

/// One scripted fault per completion. `Io` faults delegate to the real
/// filesystem IO and fail at exactly the scripted stage; `Prepare`,
/// `ReplaceThenAbortFails`, and `Commit` script the causal-journal callbacks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Fault {
    None,
    /// Prepared bytes do not match the fingerprint declared at bind time.
    MismatchedBytes,
    Io(SaveIoStage),
    Prepare,
    /// Replacement fails and the abort marker write also fails.
    ReplaceThenAbortFails,
    /// Replacement succeeds, then the causal journal commit fails.
    Commit,
}

#[derive(Debug, Clone)]
enum Op {
    Reserve,
    /// Bind an outstanding reservation (by pool index) to a content target.
    Bind {
        reservation: usize,
        content: usize,
    },
    /// Complete a bound claim (by pool index) with a scripted fault.
    Complete {
        claim: usize,
        fault: Fault,
    },
    /// Select the current disk revision as the checkpoint for an outstanding
    /// reservation, with a scripted journal-commit result.
    CommitExisting {
        reservation: usize,
        commit_fails: bool,
    },
}

/// Classified result of one applied op, for fixed-sequence assertions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StepOutcome {
    /// Op referenced an empty pool (or no disk file for CommitExisting).
    Skipped,
    Reserved,
    Bound,
    Saved,
    AlreadyCurrent,
    BlockedFingerprintMismatch,
    BlockedSuperseded,
    BlockedIo(SaveIoStage),
    BlockedCommit,
    ExistingCommitted,
    ExistingSuperseded,
    ExistingCommitFailed,
}

/// Fails at exactly one scripted stage; otherwise real filesystem IO.
struct ScriptedIo {
    fail_at: Option<SaveIoStage>,
}

impl CheckpointIo for ScriptedIo {
    fn create_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<File> {
        if self.fail_at == Some(SaveIoStage::CreateTemp) {
            return Err(io::Error::other("scripted create failure"));
        }
        RealCheckpointIo.create_temp(temporary_path, target_path)
    }

    fn write_temp(&self, temporary: &mut File, content: &[u8]) -> io::Result<()> {
        if self.fail_at == Some(SaveIoStage::WriteTemp) {
            return Err(io::Error::other("scripted write failure"));
        }
        RealCheckpointIo.write_temp(temporary, content)
    }

    fn flush_temp(&self, temporary: &File) -> io::Result<()> {
        if self.fail_at == Some(SaveIoStage::FlushTemp) {
            return Err(io::Error::other("scripted flush failure"));
        }
        RealCheckpointIo.flush_temp(temporary)
    }

    fn replace_temp(&self, temporary_path: &Path, target_path: &Path) -> io::Result<()> {
        if self.fail_at == Some(SaveIoStage::Replace) {
            return Err(io::Error::other("scripted replace failure"));
        }
        RealCheckpointIo.replace_temp(temporary_path, target_path)
    }

    fn remove_temp(&self, temporary_path: &Path) {
        RealCheckpointIo.remove_temp(temporary_path);
    }
}

struct ModelClock {
    calls: AtomicU64,
}

impl CheckpointClock for ModelClock {
    fn now(&self) -> SystemTime {
        let call = self.calls.fetch_add(1, AtomicOrdering::SeqCst);
        SystemTime::UNIX_EPOCH + Duration::from_secs(1_000 + call)
    }
}

/// The published checkpoint as the model sees it: which sequence published
/// which content. Sequences are claimed once, so this pair identifies the
/// full checkpoint (heads and fingerprint derive from the content index).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ModelCheckpoint {
    sequence: u64,
    content: usize,
}

#[derive(Debug, Default)]
struct Model {
    reserved: u64,
    barrier: u64,
    published: Option<ModelCheckpoint>,
    /// Content index currently on disk at the target path, if any.
    disk: Option<usize>,
}

struct BoundClaim {
    claim: SaveClaim,
    content: usize,
    /// The published checkpoint captured at bind time when the target already
    /// matched it, mirroring `SaveClaim::already_current`.
    already_current: Option<ModelCheckpoint>,
}

struct Runner {
    _directory: tempfile::TempDir,
    path: PathBuf,
    coordinator: FileCheckpointCoordinator,
    clock: ModelClock,
    reservations: Vec<SaveSequenceClaim>,
    claims: Vec<BoundClaim>,
    model: Model,
    last_barrier: u64,
    last_published_sequence: u64,
    /// The coordinator's published checkpoint as observed after the previous
    /// step, straight from `coordinator.checkpoint()` (not model-derived).
    /// Steps that publish must advance it to exactly the committed
    /// checkpoint; every other step must leave it unchanged.
    observed_checkpoint: Option<FileCheckpoint>,
}

impl Runner {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("notebook.ipynb");
        let coordinator = FileCheckpointCoordinator::default();
        Self {
            _directory: directory,
            path,
            coordinator,
            clock: ModelClock {
                calls: AtomicU64::new(0),
            },
            reservations: Vec::new(),
            claims: Vec::new(),
            model: Model::default(),
            last_barrier: 0,
            last_published_sequence: 0,
            observed_checkpoint: None,
        }
    }

    fn run(&mut self, ops: &[Op]) -> Vec<StepOutcome> {
        ops.iter().map(|op| self.apply(op)).collect()
    }

    fn apply(&mut self, op: &Op) -> StepOutcome {
        match op {
            Op::Reserve => self.apply_reserve(),
            Op::Bind {
                reservation,
                content,
            } => self.apply_bind(*reservation, *content),
            Op::Complete { claim, fault } => self.apply_complete(*claim, *fault),
            Op::CommitExisting {
                reservation,
                commit_fails,
            } => self.apply_commit_existing(*reservation, *commit_fails),
        }
    }

    fn apply_reserve(&mut self) -> StepOutcome {
        let reservation = self.coordinator.reserve().expect("sequence exhausted");
        self.model.reserved += 1;
        assert_eq!(reservation.sequence(), self.model.reserved);
        self.reservations.push(reservation);
        self.check_invariants(None);
        StepOutcome::Reserved
    }

    fn apply_bind(&mut self, reservation: usize, content: usize) -> StepOutcome {
        if self.reservations.is_empty() {
            self.check_invariants(None);
            return StepOutcome::Skipped;
        }
        let reservation = self
            .reservations
            .remove(reservation % self.reservations.len());
        let sequence = reservation.sequence();
        let target =
            FileCheckpointTarget::for_content(&self.path, heads_for(content), CONTENTS[content]);
        let claim = self.coordinator.bind(reservation, target);
        assert_eq!(claim.sequence(), sequence);

        // Binding snapshots AlreadyCurrent iff the published checkpoint
        // already matches the target (same path, heads, fingerprint).
        let predicted = self
            .model
            .published
            .filter(|published| published.content == content);
        assert_eq!(claim.already_current.is_some(), predicted.is_some());
        if let (Some(actual), Some(expected)) = (&claim.already_current, predicted) {
            assert_eq!(actual.save_sequence, expected.sequence);
        }

        self.claims.push(BoundClaim {
            claim,
            content,
            already_current: predicted,
        });
        self.check_invariants(None);
        StepOutcome::Bound
    }

    fn apply_complete(&mut self, claim: usize, fault: Fault) -> StepOutcome {
        if self.claims.is_empty() {
            self.check_invariants(None);
            return StepOutcome::Skipped;
        }
        let bound = self.claims.remove(claim % self.claims.len());
        let sequence = bound.claim.sequence();
        let content = bound.content;
        let expected = predict_complete(&self.model, sequence, bound.already_current, fault);

        let prepared: &[u8] = if fault == Fault::MismatchedBytes {
            b"prepared bytes that do not match the declared fingerprint"
        } else {
            CONTENTS[content]
        };
        let io = ScriptedIo {
            fail_at: match fault {
                Fault::Io(stage) => Some(stage),
                Fault::ReplaceThenAbortFails => Some(SaveIoStage::Replace),
                _ => None,
            },
        };
        let outcome = self.coordinator.complete_with_callbacks(
            bound.claim,
            prepared,
            &io,
            &self.clock,
            |_| {
                if fault == Fault::Prepare {
                    Err("scripted prepare failure".to_string())
                } else {
                    Ok(())
                }
            },
            |_| {
                if fault == Fault::ReplaceThenAbortFails {
                    Err("scripted abort failure".to_string())
                } else {
                    Ok(())
                }
            },
            |_| {
                if fault == Fault::Commit {
                    Err("scripted commit failure".to_string())
                } else {
                    Ok(())
                }
            },
        );

        let actual = classify_complete(&outcome, sequence, self.model.barrier);
        assert_eq!(
            actual, expected,
            "sequence {sequence} content {content} fault {fault:?}: {outcome:?}"
        );

        let saved_checkpoint = match &outcome {
            SaveOutcome::Saved { checkpoint } => {
                assert_eq!(checkpoint.path, self.path);
                assert_eq!(checkpoint.exported_heads, heads_for(content));
                assert_eq!(
                    checkpoint.file_fingerprint,
                    source_fingerprint(CONTENTS[content])
                );
                assert_eq!(checkpoint.save_sequence, sequence);
                Some(checkpoint.clone())
            }
            _ => None,
        };

        match expected {
            StepOutcome::Saved => {
                self.model.disk = Some(content);
                self.model.barrier = sequence;
                self.model.published = Some(ModelCheckpoint { sequence, content });
            }
            StepOutcome::AlreadyCurrent => {
                self.model.barrier = sequence;
            }
            // Commit failure after a visible replacement: disk bytes and the
            // ordering barrier advance, the published checkpoint does not.
            StepOutcome::BlockedCommit if fault == Fault::Commit => {
                self.model.disk = Some(content);
                self.model.barrier = sequence;
            }
            _ => {}
        }
        self.check_invariants(saved_checkpoint.as_ref());
        expected
    }

    fn apply_commit_existing(&mut self, reservation: usize, commit_fails: bool) -> StepOutcome {
        let Some(disk_content) = self.model.disk else {
            self.check_invariants(None);
            return StepOutcome::Skipped;
        };
        if self.reservations.is_empty() {
            self.check_invariants(None);
            return StepOutcome::Skipped;
        }
        let reservation = self
            .reservations
            .remove(reservation % self.reservations.len());
        let sequence = reservation.sequence();
        let checkpoint = FileCheckpoint {
            path: self.path.clone(),
            exported_heads: heads_for(disk_content),
            file_fingerprint: source_fingerprint(CONTENTS[disk_content]),
            save_sequence: sequence,
            saved_at: self.clock.now(),
        };

        let expected = if self.model.barrier > sequence {
            StepOutcome::ExistingSuperseded
        } else if commit_fails {
            StepOutcome::ExistingCommitFailed
        } else {
            StepOutcome::ExistingCommitted
        };

        let result =
            self.coordinator
                .commit_existing_with(reservation, checkpoint.clone(), |checkpoint| {
                    if commit_fails {
                        Err("scripted commit failure".to_string())
                    } else {
                        Ok(checkpoint.save_sequence)
                    }
                });

        let mut published = None;
        match (&result, expected) {
            (Ok(committed), StepOutcome::ExistingCommitted) => {
                assert_eq!(*committed, sequence);
                self.model.barrier = sequence;
                self.model.published = Some(ModelCheckpoint {
                    sequence,
                    content: disk_content,
                });
                published = Some(checkpoint);
            }
            (
                Err(SaveBlockedReason::Superseded { latest_sequence }),
                StepOutcome::ExistingSuperseded,
            ) => {
                assert_eq!(*latest_sequence, self.model.barrier);
            }
            (Err(SaveBlockedReason::Commit { .. }), StepOutcome::ExistingCommitFailed) => {}
            (other, expected) => {
                panic!("sequence {sequence}: expected {expected:?}, got {other:?}")
            }
        }
        self.check_invariants(published.as_ref());
        expected
    }

    /// Assert every oracle against the real coordinator, its published
    /// checkpoint, and disk. `published` is the exact checkpoint this step
    /// committed, if it committed one.
    fn check_invariants(&mut self, published: Option<&FileCheckpoint>) {
        assert_eq!(
            self.coordinator.latest_claimed_sequence(),
            self.model.reserved
        );
        assert_eq!(
            self.coordinator.latest_barrier_sequence(),
            self.model.barrier
        );

        // Barrier and published checkpoint sequences are monotone.
        assert!(self.model.barrier >= self.last_barrier);
        self.last_barrier = self.model.barrier;

        let checkpoint = self.coordinator.checkpoint();
        match (&checkpoint, &self.model.published) {
            (None, None) => {}
            (Some(actual), Some(expected)) => {
                assert_eq!(actual.save_sequence, expected.sequence);
                assert_eq!(actual.path, self.path);
                assert_eq!(actual.exported_heads, heads_for(expected.content));
                assert_eq!(
                    actual.file_fingerprint,
                    source_fingerprint(CONTENTS[expected.content])
                );
                assert!(expected.sequence >= self.last_published_sequence);
                self.last_published_sequence = expected.sequence;
            }
            (actual, expected) => {
                panic!("published checkpoint mismatch: actual {actual:?}, model {expected:?}")
            }
        }
        // The published checkpoint never runs ahead of the barrier.
        assert!(self.last_published_sequence <= self.model.barrier);

        match self.model.disk {
            Some(content) => assert_eq!(fs::read(&self.path).unwrap(), CONTENTS[content]),
            None => assert!(!self.path.exists()),
        }
        // No temporary-file litter on any path, fault or not.
        assert_eq!(
            fs::read_dir(self._directory.path()).unwrap().count(),
            usize::from(self.model.disk.is_some())
        );

        // When the published checkpoint owns the path, its fingerprint equals
        // the disk bytes.
        if let (Some(model_published), Some(disk)) = (&self.model.published, self.model.disk) {
            if model_published.content == disk {
                assert_eq!(
                    checkpoint.as_ref().unwrap().file_fingerprint,
                    source_fingerprint(&fs::read(&self.path).unwrap())
                );
            }
        }

        // The published checkpoint is the observable save record: a step
        // that committed advances it to exactly the committed checkpoint and
        // the disk bytes match it; every other step leaves it unchanged.
        match published {
            Some(expected) => {
                assert_eq!(checkpoint.as_ref(), Some(expected));
                assert_eq!(
                    source_fingerprint(&fs::read(&self.path).unwrap()),
                    expected.file_fingerprint
                );
            }
            None => assert_eq!(checkpoint, self.observed_checkpoint),
        }
        self.observed_checkpoint = checkpoint;
    }
}

/// Shadow-model prediction for `complete_with_callbacks`, mirroring the
/// coordinator's check order: fingerprint, the AlreadyCurrent fast path,
/// temp-file IO, the supersession barrier, then prepare/replace/commit.
fn predict_complete(
    model: &Model,
    sequence: u64,
    already_current: Option<ModelCheckpoint>,
    fault: Fault,
) -> StepOutcome {
    if fault == Fault::MismatchedBytes {
        return StepOutcome::BlockedFingerprintMismatch;
    }
    if let Some(snapshot) = already_current {
        if model.barrier > sequence {
            return StepOutcome::BlockedSuperseded;
        }
        if model.published == Some(snapshot) {
            return StepOutcome::AlreadyCurrent;
        }
        // The checkpoint moved since bind; fall through to the write path.
    }
    // Temp-file preparation happens before the barrier check, so these
    // faults surface as IO errors even for superseded claims.
    if let Fault::Io(stage) = fault {
        if stage != SaveIoStage::Replace {
            return StepOutcome::BlockedIo(stage);
        }
    }
    if model.barrier > sequence {
        return StepOutcome::BlockedSuperseded;
    }
    match fault {
        Fault::Prepare | Fault::ReplaceThenAbortFails | Fault::Commit => StepOutcome::BlockedCommit,
        Fault::Io(SaveIoStage::Replace) => StepOutcome::BlockedIo(SaveIoStage::Replace),
        Fault::None => StepOutcome::Saved,
        Fault::MismatchedBytes | Fault::Io(_) => unreachable!("handled above"),
    }
}

fn classify_complete(outcome: &SaveOutcome, sequence: u64, barrier_before: u64) -> StepOutcome {
    match outcome {
        SaveOutcome::Saved { .. } => StepOutcome::Saved,
        SaveOutcome::AlreadyCurrent { claim_sequence, .. } => {
            assert_eq!(*claim_sequence, sequence);
            StepOutcome::AlreadyCurrent
        }
        SaveOutcome::Blocked {
            save_sequence,
            reason,
        } => {
            assert_eq!(*save_sequence, Some(sequence));
            match reason {
                SaveBlockedReason::ContentFingerprintMismatch { .. } => {
                    StepOutcome::BlockedFingerprintMismatch
                }
                SaveBlockedReason::Superseded { latest_sequence } => {
                    assert_eq!(*latest_sequence, barrier_before);
                    StepOutcome::BlockedSuperseded
                }
                SaveBlockedReason::Io { stage, .. } => StepOutcome::BlockedIo(*stage),
                SaveBlockedReason::Commit { .. } => StepOutcome::BlockedCommit,
                other => panic!("unexpected blocked reason {other:?}"),
            }
        }
    }
}

// --- Fixed op sequences validating the oracles against known-good behavior ---

/// Re-expression of `newer_save_claim_blocks_older_completion_before_replace`
/// as a linearized op sequence: the newer completion lands first, the older
/// completion must block as superseded and leave the newer bytes on disk.
#[test]
fn fixed_newer_completion_blocks_older_completion_before_replace() {
    let mut runner = Runner::new();
    let outcomes = runner.run(&[
        Op::Reserve,
        Op::Reserve,
        Op::Bind {
            reservation: 0,
            content: 0,
        },
        Op::Bind {
            reservation: 0,
            content: 1,
        },
        Op::Complete {
            claim: 1,
            fault: Fault::None,
        },
        Op::Complete {
            claim: 0,
            fault: Fault::None,
        },
    ]);
    assert_eq!(outcomes[4], StepOutcome::Saved);
    assert_eq!(outcomes[5], StepOutcome::BlockedSuperseded);
    assert_eq!(runner.coordinator.checkpoint().unwrap().save_sequence, 2);
    assert_eq!(fs::read(&runner.path).unwrap(), CONTENTS[1]);
}

/// Re-expression of `failed_newer_preparation_does_not_burn_older_viable_save`:
/// a newer claim whose prepared bytes miss the declared fingerprint blocks
/// without crossing the barrier, so the older save still lands.
#[test]
fn fixed_failed_newer_preparation_does_not_burn_older_viable_save() {
    let mut runner = Runner::new();
    let outcomes = runner.run(&[
        Op::Reserve,
        Op::Reserve,
        Op::Bind {
            reservation: 0,
            content: 0,
        },
        Op::Bind {
            reservation: 0,
            content: 1,
        },
        Op::Complete {
            claim: 1,
            fault: Fault::MismatchedBytes,
        },
        Op::Complete {
            claim: 0,
            fault: Fault::None,
        },
    ]);
    assert_eq!(outcomes[4], StepOutcome::BlockedFingerprintMismatch);
    assert_eq!(outcomes[5], StepOutcome::Saved);
    assert_eq!(runner.coordinator.checkpoint().unwrap().save_sequence, 1);
    assert_eq!(fs::read(&runner.path).unwrap(), CONTENTS[0]);
}

/// A pre-replace fault on s2 never blocks a later s1 < s2 from reaching
/// Saved: no failure before a visible replacement crosses the barrier.
#[test]
fn fixed_pre_replace_fault_on_newer_save_never_blocks_older_save() {
    let pre_replace_faults = [
        Fault::Io(SaveIoStage::CreateTemp),
        Fault::Io(SaveIoStage::WriteTemp),
        Fault::Io(SaveIoStage::FlushTemp),
        Fault::Prepare,
        Fault::Io(SaveIoStage::Replace),
        Fault::ReplaceThenAbortFails,
    ];
    for fault in pre_replace_faults {
        let mut runner = Runner::new();
        let outcomes = runner.run(&[
            Op::Reserve,
            Op::Reserve,
            Op::Bind {
                reservation: 0,
                content: 0,
            },
            Op::Bind {
                reservation: 0,
                content: 1,
            },
            Op::Complete { claim: 1, fault },
            Op::Complete {
                claim: 0,
                fault: Fault::None,
            },
        ]);
        assert_ne!(outcomes[4], StepOutcome::Saved, "fault {fault:?}");
        assert_eq!(outcomes[5], StepOutcome::Saved, "fault {fault:?}");
        assert_eq!(runner.coordinator.checkpoint().unwrap().save_sequence, 1);
        assert_eq!(fs::read(&runner.path).unwrap(), CONTENTS[0]);
    }
}

/// A commit failure after the visible replacement advances disk bytes and
/// the barrier but not the published checkpoint, so an older completion is
/// superseded instead of overwriting the replaced file.
#[test]
fn fixed_commit_failure_after_replace_advances_disk_but_not_published_checkpoint() {
    let mut runner = Runner::new();
    let outcomes = runner.run(&[
        Op::Reserve,
        Op::Reserve,
        Op::Bind {
            reservation: 0,
            content: 0,
        },
        Op::Bind {
            reservation: 0,
            content: 1,
        },
        Op::Complete {
            claim: 1,
            fault: Fault::Commit,
        },
        Op::Complete {
            claim: 0,
            fault: Fault::None,
        },
    ]);
    assert_eq!(outcomes[4], StepOutcome::BlockedCommit);
    assert_eq!(outcomes[5], StepOutcome::BlockedSuperseded);
    assert!(runner.coordinator.checkpoint().is_none());
    assert_eq!(fs::read(&runner.path).unwrap(), CONTENTS[1]);
}

/// Reserving a sequence alone never supersedes: an older save and an
/// existing-revision commit both land while newer reservations are merely
/// outstanding.
#[test]
fn fixed_reservation_alone_never_supersedes() {
    let mut runner = Runner::new();
    let outcomes = runner.run(&[
        Op::Reserve,
        Op::Bind {
            reservation: 0,
            content: 0,
        },
        // s2 and s3 are reserved but never settled.
        Op::Reserve,
        Op::Reserve,
        Op::Complete {
            claim: 0,
            fault: Fault::None,
        },
        Op::CommitExisting {
            reservation: 0,
            commit_fails: false,
        },
    ]);
    assert_eq!(outcomes[4], StepOutcome::Saved);
    assert_eq!(outcomes[5], StepOutcome::ExistingCommitted);
    assert_eq!(runner.coordinator.checkpoint().unwrap().save_sequence, 2);
}

// --- Generative property ---

fn fault_strategy() -> impl Strategy<Value = Fault> {
    prop_oneof![
        6 => Just(Fault::None),
        1 => Just(Fault::MismatchedBytes),
        1 => Just(Fault::Io(SaveIoStage::CreateTemp)),
        1 => Just(Fault::Io(SaveIoStage::WriteTemp)),
        1 => Just(Fault::Io(SaveIoStage::FlushTemp)),
        1 => Just(Fault::Io(SaveIoStage::Replace)),
        1 => Just(Fault::Prepare),
        1 => Just(Fault::ReplaceThenAbortFails),
        1 => Just(Fault::Commit),
    ]
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        3 => Just(Op::Reserve),
        3 => (0..8usize, 0..CONTENTS.len()).prop_map(|(reservation, content)| Op::Bind {
            reservation,
            content,
        }),
        4 => (0..8usize, fault_strategy()).prop_map(|(claim, fault)| Op::Complete {
            claim,
            fault,
        }),
        1 => (0..8usize, any::<bool>()).prop_map(|(reservation, commit_fails)| {
            Op::CommitExisting {
                reservation,
                commit_fails,
            }
        }),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Drive arbitrary reserve/bind/complete/commit-existing interleavings
    /// with scripted faults through the shadow model; every step asserts the
    /// full oracle set in [`Runner::check_invariants`].
    #[test]
    fn checkpoint_coordinator_matches_model(ops in prop::collection::vec(op_strategy(), 1..24)) {
        let mut runner = Runner::new();
        for op in &ops {
            runner.apply(op);
        }
    }
}
