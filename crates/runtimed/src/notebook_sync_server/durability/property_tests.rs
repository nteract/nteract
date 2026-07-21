//! Property-based recovery invariants for the [`RoomDurability`] journal
//! state machine.
//!
//! A shadow model drives random command sequences (peer commits through both
//! the snapshot and merge-into-durable-union paths, direct and prepared file
//! checkpoints, aborts, source-ready acks, crash/reloads) against a real
//! journal and a growing Automerge document, so every head and change hash in
//! the manifests is real. After every reload the recovered manifest must
//! satisfy the anti-undead invariants:
//!
//! 1. Classification totality: the manifest falls into exactly one of
//!    (a) DurablyStaged/Ready (joinable via the recovered-source path),
//!    (b) Pending with no peer changes (safe to regenerate),
//!    (c) an unresolved pending file-checkpoint intent (resolvable via
//!    [`RoomDurability::resolve_recovered_file_checkpoint`]),
//!    (d) Pending/Failed with peer changes and durable heads strictly beyond
//!    exported heads (requires explicit reconciliation).
//!    Case (d) is legal only when durable heads differ from exported heads,
//!    and a manifest with a full-coverage checkpoint and no unresolved intent
//!    must always land in (a) (the shared baseline normalization applied by
//!    both [`RoomDurability::recovered`] and
//!    [`RoomDurability::resolve_recovered_file_checkpoint`]).
//! 2. `exported_heads` are always contained in the durable snapshot.
//! 3. Recovery is idempotent: loading the same journal twice yields
//!    bit-identical manifests, including the normalized phase.
//! 4. `manifest.sequence` is strictly increasing across commits within one
//!    process lifetime.
//! 5. `file_checkpoint_covers_durable_heads()` is head-order-insensitive and
//!    false whenever a peer commit follows the last committed checkpoint.
//! 6. `commit_source_ready` transitions only a DurablyStaged phase with the
//!    matching generation (a Ready phase re-acks as `AlreadyDurable`; every
//!    other phase/generation combination is rejected without an append).

use std::path::PathBuf;

use automerge::{transaction::Transactable, ActorId, AutoCommit, Change, ChangeHash, ROOT};
use proptest::prelude::*;
use uuid::Uuid;

use super::*;
use crate::notebook_sync_server::recovery::{source_fingerprint, RecoveryLoadOutcome};

/// One generated command against the live coordinator. Ops that need state
/// the runner does not have (a pending intent, a durable record) degrade to
/// asserting the documented rejection instead of skipping silently.
#[derive(Debug, Clone, Copy)]
enum Op {
    /// Author a durable peer change committed as a full snapshot through
    /// `commit_snapshot(Peer)`; `concurrent` merges a forked actor so the
    /// document genuinely has multiple heads.
    PeerChange { concurrent: bool },
    /// Author a durable peer change committed as raw changes through
    /// `commit_peer_changes`, the production path that merges peer batches
    /// into the durable union instead of replacing the snapshot.
    PeerMerge { concurrent: bool },
    /// `commit_file_checkpoint` at the current durable heads without a
    /// prepared intent.
    DirectCheckpoint,
    /// `prepare_file_checkpoint` for fresh export bytes at the current heads.
    PrepareCheckpoint,
    /// Atomic replace lands, then the commit marker finalizes the prepared
    /// intent.
    CommitPrepared,
    /// Replacement definitively did not occur; the abort marker clears the
    /// prepared intent.
    AbortPrepared,
    /// `commit_source_ready` with the current (or a deliberately wrong)
    /// generation.
    SourceReady { wrong_generation: bool },
    /// Crash and restart: reload from the journal tail and continue against
    /// the recovered instance. With a prepared intent outstanding this is the
    /// crash-before-checkpoint-commit window; `replace_landed` scripts
    /// whether the atomic file replace became visible before the crash.
    Reload { replace_landed: bool },
}

fn op_strategy() -> impl Strategy<Value = Op> {
    prop_oneof![
        2 => any::<bool>().prop_map(|concurrent| Op::PeerChange { concurrent }),
        2 => any::<bool>().prop_map(|concurrent| Op::PeerMerge { concurrent }),
        2 => Just(Op::DirectCheckpoint),
        2 => Just(Op::PrepareCheckpoint),
        2 => Just(Op::CommitPrepared),
        1 => Just(Op::AbortPrepared),
        1 => any::<bool>().prop_map(|wrong_generation| Op::SourceReady { wrong_generation }),
        3 => any::<bool>().prop_map(|replace_landed| Op::Reload { replace_landed }),
    ]
}

/// The anti-undead classification of a recovered manifest. The decision tree
/// is total and mutually exclusive by construction; the assertions in
/// [`Runner::assert_recovered_invariants`] pin which states may reach each
/// bucket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecoveryCase {
    /// (a) DurablyStaged or Ready: joinable via the recovered-source path.
    Joinable,
    /// (b) Pending/Failed with no peer changes: safe to regenerate.
    Regenerable,
    /// (c) An unresolved checkpoint intent owns its resolution path. This
    /// model only reaches it with a Pending phase; Failed never occurs here
    /// because no command produces a failed source task.
    ResolvableIntent,
    /// (d) Peer changes with no staged source and unexported durable heads:
    /// requires explicit reconciliation.
    NeedsReconciliation,
}

fn classify(manifest: &RecoveryManifest) -> RecoveryCase {
    match manifest.source_phase {
        RecoverySourcePhase::DurablyStaged | RecoverySourcePhase::Ready => RecoveryCase::Joinable,
        RecoverySourcePhase::Pending | RecoverySourcePhase::Failed => {
            if manifest.pending_file_checkpoint.is_some() {
                RecoveryCase::ResolvableIntent
            } else if manifest.peer_change_hashes.is_empty() {
                RecoveryCase::Regenerable
            } else {
                RecoveryCase::NeedsReconciliation
            }
        }
    }
}

fn sorted(heads: &[[u8; 32]]) -> Vec<[u8; 32]> {
    let mut heads = heads.to_vec();
    heads.sort_unstable();
    heads
}

#[derive(Debug, Clone)]
struct PendingSave {
    fingerprint: SourceFingerprint,
    heads: Vec<[u8; 32]>,
    save_sequence: u64,
}

/// What the manifest must say, predicted purely from the applied commands.
#[derive(Debug)]
struct Model {
    phase: RecoverySourcePhase,
    generation: u64,
    has_peer_changes: bool,
    /// A peer commit advanced the durable heads after the last committed
    /// checkpoint, so checkpoint coverage must be false.
    peer_after_last_checkpoint: bool,
    pending: Option<PendingSave>,
    /// `file_save_sequence` has been set by a committed checkpoint.
    has_checkpoint: bool,
    exported_heads: Vec<[u8; 32]>,
    durable_heads: Vec<[u8; 32]>,
    /// Last journal sequence acknowledged as `Committed`.
    last_sequence: u64,
    has_record: bool,
}

impl Model {
    fn expected_coverage(&self) -> bool {
        self.has_checkpoint
            && !self.durable_heads.is_empty()
            && sorted(&self.exported_heads) == sorted(&self.durable_heads)
    }
}

struct Runner {
    _directory: tempfile::TempDir,
    journal: RecoveryJournal,
    canonical_path: PathBuf,
    durability: RoomDurability,
    doc: AutoCommit,
    /// Fingerprint of the bytes currently on disk at the canonical path.
    /// Checkpoint commits and landed replaces move it; nothing else does, so
    /// every reload observes either the manifest fingerprint or a pending
    /// intent's fingerprint, never third-party bytes.
    disk: SourceFingerprint,
    model: Model,
    edit_counter: u64,
    save_counter: u64,
}

impl Runner {
    fn new() -> Self {
        let directory = tempfile::tempdir().unwrap();
        let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
        let canonical_path = directory.path().join("notebook.ipynb");
        let disk = source_fingerprint(b"initial notebook bytes");
        let mut doc = AutoCommit::new();
        let genesis = doc.save();
        let durability = RoomDurability::journaled(
            journal.clone(),
            Uuid::nil(),
            Some(canonical_path.clone()),
            disk,
            0,
            genesis,
        );
        Self {
            _directory: directory,
            journal,
            canonical_path,
            durability,
            doc,
            disk,
            model: Model {
                phase: RecoverySourcePhase::Pending,
                generation: 0,
                has_peer_changes: false,
                peer_after_last_checkpoint: false,
                pending: None,
                has_checkpoint: false,
                exported_heads: Vec::new(),
                durable_heads: Vec::new(),
                last_sequence: 0,
                has_record: false,
            },
            edit_counter: 0,
            save_counter: 0,
        }
    }

    fn current_heads(&mut self) -> Vec<[u8; 32]> {
        self.doc.get_heads().iter().map(|head| head.0).collect()
    }

    fn next_export(&mut self) -> (u64, SourceFingerprint) {
        self.save_counter += 1;
        let fingerprint = source_fingerprint(format!("export {}", self.save_counter).as_bytes());
        (self.save_counter, fingerprint)
    }

    /// Invariant 4: every `Committed` outcome advances the journal sequence
    /// strictly within a process lifetime.
    fn expect_committed(&mut self, outcome: Result<DurableCommitOutcome, RoomDurabilityError>) {
        match outcome.unwrap() {
            DurableCommitOutcome::Committed(status) => {
                assert!(
                    status.journal_sequence > self.model.last_sequence,
                    "journal sequence must strictly increase: {} then {}",
                    self.model.last_sequence,
                    status.journal_sequence
                );
                self.model.last_sequence = status.journal_sequence;
                self.model.has_record = true;
            }
            other => panic!("expected a committed outcome, got {other:?}"),
        }
    }

    fn apply(&mut self, op: &Op) {
        match *op {
            Op::PeerChange { concurrent } => self.apply_peer_change(concurrent),
            Op::PeerMerge { concurrent } => self.apply_peer_merge(concurrent),
            Op::DirectCheckpoint => self.apply_direct_checkpoint(),
            Op::PrepareCheckpoint => self.apply_prepare_checkpoint(),
            Op::CommitPrepared => self.apply_commit_prepared(),
            Op::AbortPrepared => self.apply_abort_prepared(),
            Op::SourceReady { wrong_generation } => self.apply_source_ready(wrong_generation),
            Op::Reload { replace_landed } => self.apply_reload(replace_landed),
        }
        self.check_live_manifest();
    }

    /// Author one peer edit (optionally with a genuinely concurrent forked
    /// actor so the document has multiple heads) and return the new changes
    /// since the pre-edit heads.
    fn author_peer_edit(&mut self, concurrent: bool) -> Vec<Change> {
        self.edit_counter += 1;
        let edit = self.edit_counter;
        let baseline = self.doc.get_heads();
        if concurrent {
            let mut fork = self.doc.fork().with_actor(ActorId::random());
            fork.put(ROOT, format!("fork-{edit}"), edit as i64).unwrap();
            self.doc
                .put(ROOT, format!("main-{edit}"), edit as i64)
                .unwrap();
            self.doc.merge(&mut fork).unwrap();
        } else {
            self.doc
                .put(ROOT, format!("edit-{edit}"), edit as i64)
                .unwrap();
        }
        self.doc.get_changes(&baseline)
    }

    fn record_peer_commit(&mut self) {
        self.model.durable_heads = self.current_heads();
        self.model.has_peer_changes = true;
        self.model.peer_after_last_checkpoint = true;
    }

    fn apply_peer_change(&mut self, concurrent: bool) {
        let change_hashes = self
            .author_peer_edit(concurrent)
            .iter()
            .map(|change| change.hash().0)
            .collect::<Vec<_>>();
        let heads = self.current_heads();
        let snapshot = self.doc.save();
        let outcome = self.durability.commit_snapshot(
            &snapshot,
            heads,
            DurableMutation::Peer { change_hashes },
        );
        self.expect_committed(outcome);
        self.record_peer_commit();
    }

    /// The production peer path: raw changes merged into the durable union by
    /// `commit_peer_changes` instead of a caller-provided snapshot replacing
    /// it. The union already contains every previously committed change, so
    /// the merged heads must equal the live document heads.
    fn apply_peer_merge(&mut self, concurrent: bool) {
        let changes = self.author_peer_edit(concurrent);
        let outcome = self.durability.commit_peer_changes(changes.clone());
        self.expect_committed(outcome);
        self.record_peer_commit();

        // Re-sending the already-durable batch dedupes against both the
        // union and the manifest hashes without appending.
        let before = self.durability.manifest();
        let again = self.durability.commit_peer_changes(changes).unwrap();
        assert!(
            matches!(again, DurableCommitOutcome::AlreadyDurable(_)),
            "re-committing durable peer changes must be a no-op, got {again:?}"
        );
        assert_eq!(self.durability.manifest(), before);
    }

    fn apply_direct_checkpoint(&mut self) {
        let (save_sequence, fingerprint) = self.next_export();
        let heads = self.model.durable_heads.clone();
        if self.model.pending.is_some() {
            // A checkpoint that does not match the prepared intent is
            // rejected without consuming the intent or appending.
            let before = self.durability.manifest();
            let error = self
                .durability
                .commit_file_checkpoint(
                    self.canonical_path.clone(),
                    fingerprint,
                    heads,
                    save_sequence,
                )
                .unwrap_err();
            assert!(
                matches!(error, RoomDurabilityError::InvalidSnapshot(_)),
                "a mismatched checkpoint against a pending intent must be invalid, got {error:?}"
            );
            assert_eq!(self.durability.manifest(), before);
            return;
        }
        let outcome = self.durability.commit_file_checkpoint(
            self.canonical_path.clone(),
            fingerprint,
            heads.clone(),
            save_sequence,
        );
        self.expect_committed(outcome);
        self.disk = fingerprint;
        self.model.exported_heads = heads;
        self.model.has_checkpoint = true;
        self.model.peer_after_last_checkpoint = false;
        // Mirror `promote_full_coverage_checkpoint_baseline`: direct commits
        // have no pending intent or degradation in this model, and promotion
        // preserves both generation and sequence.
        if matches!(
            self.model.phase,
            RecoverySourcePhase::Pending | RecoverySourcePhase::Failed
        ) && self.model.expected_coverage()
        {
            self.model.phase = RecoverySourcePhase::DurablyStaged;
        }
    }

    fn apply_prepare_checkpoint(&mut self) {
        let (save_sequence, fingerprint) = self.next_export();
        let heads = self.model.durable_heads.clone();
        if self.model.pending.is_some() {
            // Only one intent may be outstanding; a second prepare is
            // rejected without appending.
            let before = self.durability.manifest();
            let error = self
                .durability
                .prepare_file_checkpoint(
                    self.canonical_path.clone(),
                    fingerprint,
                    heads,
                    save_sequence,
                    None,
                )
                .unwrap_err();
            assert!(
                matches!(error, RoomDurabilityError::InvalidSnapshot(_)),
                "a second prepared intent must be invalid, got {error:?}"
            );
            assert_eq!(self.durability.manifest(), before);
            return;
        }
        let outcome = self.durability.prepare_file_checkpoint(
            self.canonical_path.clone(),
            fingerprint,
            heads.clone(),
            save_sequence,
            None,
        );
        self.expect_committed(outcome);
        self.model.pending = Some(PendingSave {
            fingerprint,
            heads,
            save_sequence,
        });
    }

    fn apply_commit_prepared(&mut self) {
        let Some(pending) = self.model.pending.clone() else {
            return;
        };
        // The atomic file replace becomes visible before the commit marker.
        self.disk = pending.fingerprint;
        let outcome = self.durability.commit_file_checkpoint(
            self.canonical_path.clone(),
            pending.fingerprint,
            pending.heads.clone(),
            pending.save_sequence,
        );
        self.expect_committed(outcome);
        self.model.exported_heads = pending.heads;
        self.model.has_checkpoint = true;
        self.model.pending = None;
        self.model.peer_after_last_checkpoint = false;
        // Mirror `promote_full_coverage_checkpoint_baseline` after the commit
        // clears the prepared intent.
        if matches!(
            self.model.phase,
            RecoverySourcePhase::Pending | RecoverySourcePhase::Failed
        ) && self.model.expected_coverage()
        {
            self.model.phase = RecoverySourcePhase::DurablyStaged;
        }
    }

    fn apply_abort_prepared(&mut self) {
        match self.model.pending.clone() {
            Some(pending) => {
                let outcome = self.durability.abort_file_checkpoint(pending.save_sequence);
                self.expect_committed(outcome);
                self.model.pending = None;
            }
            None => {
                // Aborting with no outstanding intent is an idempotent no-op.
                let before = self.durability.manifest();
                let outcome = self.durability.abort_file_checkpoint(0).unwrap();
                assert!(
                    matches!(outcome, DurableCommitOutcome::AlreadyDurable(_)),
                    "aborting without an intent must be a no-op, got {outcome:?}"
                );
                assert_eq!(self.durability.manifest(), before);
            }
        }
    }

    /// Invariant 6: `commit_source_ready` transitions only DurablyStaged with
    /// the matching generation. Ready re-acks as `AlreadyDurable`; a wrong
    /// generation or an unstaged phase is rejected without an append.
    fn apply_source_ready(&mut self, wrong_generation: bool) {
        let generation = if wrong_generation {
            self.model.generation + 1
        } else {
            self.model.generation
        };
        let before = self.durability.manifest();
        let result = self.durability.commit_source_ready(generation);
        if wrong_generation {
            assert!(
                matches!(result, Err(RoomDurabilityError::InvalidSnapshot(_))),
                "a mismatched generation must be invalid, got {result:?}"
            );
            assert_eq!(self.durability.manifest(), before);
            return;
        }
        match self.model.phase {
            RecoverySourcePhase::DurablyStaged => {
                self.expect_committed(result);
                self.model.phase = RecoverySourcePhase::Ready;
            }
            RecoverySourcePhase::Ready => {
                assert!(
                    matches!(result, Ok(DurableCommitOutcome::AlreadyDurable(_))),
                    "re-acking a Ready generation must be a no-op, got {result:?}"
                );
                assert_eq!(self.durability.manifest(), before);
            }
            RecoverySourcePhase::Pending | RecoverySourcePhase::Failed => {
                assert!(
                    matches!(result, Err(RoomDurabilityError::InvalidSnapshot(_))),
                    "an unstaged phase must reject source-ready, got {result:?}"
                );
                assert_eq!(self.durability.manifest(), before);
            }
        }
    }

    fn apply_reload(&mut self, replace_landed: bool) {
        if !self.model.has_record {
            // Nothing was ever committed; the journal file does not exist.
            assert!(matches!(
                self.journal.load(self.disk).unwrap(),
                RecoveryLoadOutcome::Unavailable { .. }
            ));
            return;
        }
        if let Some(pending) = &self.model.pending {
            // Crash before the checkpoint commit marker: the intent is the
            // journal tail and the scripted flag decides whether the atomic
            // replace became visible before the crash.
            if replace_landed {
                self.disk = pending.fingerprint;
            }
        }

        // Invariant 3: recovery is idempotent. Two loads of the same journal
        // against the same disk produce bit-identical records, and two
        // `recovered` coordinators produce bit-identical manifests (including
        // the full-coverage baseline normalization).
        let first = match self.journal.load(self.disk).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("disk always matches the journal or its intent, got {other:?}"),
        };
        let second = match self.journal.load(self.disk).unwrap() {
            RecoveryLoadOutcome::Match(recovered) => recovered,
            other => panic!("disk always matches the journal or its intent, got {other:?}"),
        };
        assert_eq!(first, second);
        assert!(first.ignored_tail.is_none());
        let snapshot = first.record.automerge_snapshot.clone();
        assert_eq!(
            first.record.manifest.sequence, self.model.last_sequence,
            "the journal tail is the last committed record"
        );
        let recovered = RoomDurability::recovered(self.journal.clone(), first);
        let recovered_again = RoomDurability::recovered(self.journal.clone(), second);
        assert_eq!(recovered.manifest(), recovered_again.manifest());
        assert!(!recovered.status().is_degraded());

        // The full-coverage baseline normalization from `recovered`: a
        // Pending/Failed manifest with no unresolved intent whose checkpoint
        // exported every durable head restores as DurablyStaged.
        if matches!(
            self.model.phase,
            RecoverySourcePhase::Pending | RecoverySourcePhase::Failed
        ) && self.model.pending.is_none()
            && self.model.expected_coverage()
        {
            self.model.phase = RecoverySourcePhase::DurablyStaged;
        }
        self.assert_recovered_invariants(&recovered.manifest(), &snapshot);
        self.durability = recovered;

        // Case (c) continuation: an intent that survived recovery resolves
        // against the observed disk bytes. The disk is either the intended
        // replacement or the previous source, so resolution always commits;
        // third-party bytes (the SourceConflict branch) are covered by
        // `intent_crash_matrix_tests`.
        if let Some(pending) = self.model.pending.clone() {
            let outcome = self.durability.resolve_recovered_file_checkpoint(self.disk);
            self.expect_committed(outcome);
            let manifest = self.durability.manifest();
            assert!(manifest.pending_file_checkpoint.is_none());
            if replace_landed {
                assert_eq!(manifest.source_fingerprint, pending.fingerprint);
                assert_eq!(manifest.exported_heads, pending.heads);
                assert_eq!(manifest.file_save_sequence, Some(pending.save_sequence));
                self.model.exported_heads = pending.heads;
                self.model.has_checkpoint = true;
                self.model.peer_after_last_checkpoint = false;
            }
            self.model.pending = None;
            // Resolution re-applies the full-coverage baseline normalization
            // once the intent is cleared, in either branch: a landed replace
            // that finalized a covering checkpoint and an aborted replace
            // whose prior checkpoint still covers every durable head both
            // become joinable in this restart, not the next one.
            if matches!(
                self.model.phase,
                RecoverySourcePhase::Pending | RecoverySourcePhase::Failed
            ) && self.model.expected_coverage()
            {
                self.model.phase = RecoverySourcePhase::DurablyStaged;
            }
            assert_eq!(manifest.source_phase, self.model.phase);
        }
    }

    /// Invariants 1, 2, and 5 against a freshly recovered manifest and its
    /// durable snapshot.
    fn assert_recovered_invariants(&self, manifest: &RecoveryManifest, snapshot: &[u8]) {
        // Invariant 2: exported (and durable) heads are contained in the
        // durable snapshot.
        let mut durable = AutoCommit::load(snapshot).unwrap();
        for head in manifest
            .exported_heads
            .iter()
            .chain(manifest.durable_heads.iter())
        {
            assert!(
                durable.get_change_by_hash(&ChangeHash(*head)).is_some(),
                "manifest head {} is missing from the durable snapshot",
                hex::encode(head)
            );
        }

        self.assert_coverage_matches_model(manifest);

        // Invariant 1: classification totality and reachability.
        let case = classify(manifest);
        if manifest.file_checkpoint_covers_durable_heads()
            && manifest.pending_file_checkpoint.is_none()
        {
            // A full-coverage checkpoint is a complete baseline; an
            // unresolved intent keeps its dedicated resolution path instead.
            assert_eq!(
                case,
                RecoveryCase::Joinable,
                "a full-coverage checkpoint must restore joinable: {manifest:?}"
            );
        }
        if case == RecoveryCase::NeedsReconciliation {
            assert!(!manifest.peer_change_hashes.is_empty());
            assert_ne!(
                sorted(&manifest.durable_heads),
                sorted(&manifest.exported_heads),
                "explicit reconciliation is required only when durable heads \
                 are strictly beyond exported heads: {manifest:?}"
            );
        }
        assert_eq!(manifest.source_phase, self.model.phase);
        assert_eq!(
            manifest.pending_file_checkpoint.is_some(),
            self.model.pending.is_some()
        );
    }

    /// Invariant 5: coverage equals the model prediction (in particular it is
    /// false whenever a peer commit followed the last checkpoint) and is
    /// insensitive to head order.
    fn assert_coverage_matches_model(&self, manifest: &RecoveryManifest) {
        let coverage = manifest.file_checkpoint_covers_durable_heads();
        assert_eq!(coverage, self.model.expected_coverage(), "{manifest:?}");
        if self.model.peer_after_last_checkpoint {
            assert!(
                !coverage,
                "a peer commit after the last checkpoint leaves durable heads unexported"
            );
        }
        let mut reversed = manifest.clone();
        reversed.durable_heads.reverse();
        reversed.exported_heads.reverse();
        assert_eq!(reversed.file_checkpoint_covers_durable_heads(), coverage);
    }

    /// Model conformance of the live manifest after every command.
    fn check_live_manifest(&self) {
        let manifest = self.durability.manifest();
        assert_eq!(manifest.sequence, self.model.last_sequence);
        assert_eq!(manifest.source_phase, self.model.phase);
        assert_eq!(manifest.source_generation, self.model.generation);
        assert_eq!(manifest.durable_heads, self.model.durable_heads);
        assert_eq!(manifest.exported_heads, self.model.exported_heads);
        assert_eq!(
            manifest.pending_file_checkpoint.is_some(),
            self.model.pending.is_some()
        );
        assert_eq!(
            !manifest.peer_change_hashes.is_empty(),
            self.model.has_peer_changes
        );
        self.assert_coverage_matches_model(&manifest);
        assert!(!self.durability.status().is_degraded());
    }
}

// --- Fixed sequences validating the model against known-good behavior ---

/// The full recovered-baseline arc as one deterministic sequence: peer edits,
/// a covering checkpoint, its immediate DurablyStaged baseline, a crash, and
/// the source-ready completion to Ready.
#[test]
fn fixed_covering_checkpoint_reloads_joinable_and_completes_ready() {
    let mut runner = Runner::new();
    runner.apply(&Op::PeerChange { concurrent: true });
    runner.apply(&Op::DirectCheckpoint);
    runner.apply(&Op::Reload {
        replace_landed: false,
    });
    assert_eq!(runner.model.phase, RecoverySourcePhase::DurablyStaged);
    runner.apply(&Op::SourceReady {
        wrong_generation: false,
    });
    assert_eq!(runner.model.phase, RecoverySourcePhase::Ready);
    runner.apply(&Op::Reload {
        replace_landed: false,
    });
    assert_eq!(runner.model.phase, RecoverySourcePhase::Ready);
}

/// A peer commit after a staged checkpoint makes disk a stale prefix, but the
/// staged checkpoint remains a valid baseline for replaying the durable tail.
#[test]
fn fixed_unexported_peer_tail_keeps_staged_baseline() {
    let mut runner = Runner::new();
    runner.apply(&Op::PeerChange { concurrent: false });
    runner.apply(&Op::DirectCheckpoint);
    runner.apply(&Op::PeerChange { concurrent: false });
    runner.apply(&Op::Reload {
        replace_landed: false,
    });
    let manifest = runner.durability.manifest();
    assert_eq!(classify(&manifest), RecoveryCase::Joinable);
    assert_ne!(
        sorted(&manifest.durable_heads),
        sorted(&manifest.exported_heads)
    );
}

/// A crash between the prepared intent and its commit marker resolves on
/// reload, and the resolution itself applies the baseline normalization: the
/// finalized covering checkpoint is joinable in the same restart.
#[test]
fn fixed_crashed_intent_resolves_and_normalizes_in_one_restart() {
    let mut runner = Runner::new();
    runner.apply(&Op::PeerChange { concurrent: false });
    runner.apply(&Op::PrepareCheckpoint);
    runner.apply(&Op::Reload {
        replace_landed: true,
    });
    assert!(runner.model.expected_coverage());
    assert_eq!(runner.model.phase, RecoverySourcePhase::DurablyStaged);
    // The restored baseline completes the normal recovered-source path.
    runner.apply(&Op::SourceReady {
        wrong_generation: false,
    });
    assert_eq!(runner.model.phase, RecoverySourcePhase::Ready);
    runner.apply(&Op::Reload {
        replace_landed: false,
    });
    assert_eq!(runner.model.phase, RecoverySourcePhase::Ready);
}

/// An aborted intent leaves the previous covering checkpoint as the last
/// committed export; clearing the intent restores it as a joinable baseline
/// through the same normalization.
#[test]
fn fixed_aborted_intent_with_prior_covering_checkpoint_restores_joinable() {
    let mut runner = Runner::new();
    runner.apply(&Op::PeerChange { concurrent: false });
    runner.apply(&Op::DirectCheckpoint);
    runner.apply(&Op::PrepareCheckpoint);
    runner.apply(&Op::Reload {
        replace_landed: false,
    });
    assert!(runner.model.expected_coverage());
    assert_eq!(runner.model.phase, RecoverySourcePhase::DurablyStaged);
}

/// Coverage compares head sets, not head vectors: permuted orders agree, and
/// one unexported durable head breaks coverage in any order.
#[test]
fn fixed_checkpoint_coverage_is_order_insensitive() {
    let mut manifest = RecoveryManifest::new(
        3,
        Uuid::nil(),
        Some(PathBuf::from("/tmp/notebook.ipynb")),
        notebook_doc::SCHEMA_VERSION,
        source_fingerprint(b"exported"),
        0,
    );
    manifest.file_save_sequence = Some(1);
    manifest.durable_heads = vec![[1; 32], [2; 32], [3; 32]];
    manifest.exported_heads = vec![[3; 32], [1; 32], [2; 32]];
    assert!(manifest.file_checkpoint_covers_durable_heads());

    manifest.durable_heads.push([4; 32]);
    assert!(!manifest.file_checkpoint_covers_durable_heads());
    manifest.durable_heads.reverse();
    assert!(!manifest.file_checkpoint_covers_durable_heads());
}

/// Resolving a recovered checkpoint intent whose replacement landed applies
/// the full-coverage baseline normalization in the same restart. A crash
/// between the atomic file replace and the intent-commit journal append
/// restores with the intent pending (so `recovered` must not promote), and
/// the resolve that finalizes the checkpoint leaves a manifest with a
/// full-coverage checkpoint and no unresolved intent, which must be joinable
/// (case (a)) immediately rather than reading as source_degraded until a
/// second restart re-runs the normalization.
#[test]
fn resolved_full_coverage_checkpoint_restores_as_staged_baseline() {
    let directory = tempfile::tempdir().unwrap();
    let journal = RecoveryJournal::new(directory.path().join("room.recovery"));
    let path = PathBuf::from("/tmp/notebook.ipynb");
    let mut doc = AutoCommit::new();
    let genesis = doc.save();
    let durability = RoomDurability::journaled(
        journal.clone(),
        Uuid::nil(),
        Some(path.clone()),
        source_fingerprint(b"previous notebook bytes"),
        0,
        genesis,
    );
    doc.put(ROOT, "cell", "edited").unwrap();
    let heads = doc
        .get_heads()
        .iter()
        .map(|head| head.0)
        .collect::<Vec<_>>();
    let change_hash = doc.get_changes(&[])[0].hash().0;
    durability
        .commit_snapshot(
            &doc.save(),
            heads.clone(),
            DurableMutation::Peer {
                change_hashes: vec![change_hash],
            },
        )
        .unwrap();
    let intended = source_fingerprint(b"intended replacement bytes");
    durability
        .prepare_file_checkpoint(path, intended, heads, 1, None)
        .unwrap();
    drop(durability); // Crash after the atomic replace, before the commit marker.

    let recovered = match journal.load(intended).unwrap() {
        RecoveryLoadOutcome::Match(recovered) => recovered,
        other => panic!("expected matching recovery, got {other:?}"),
    };
    let restarted = RoomDurability::recovered(journal, recovered);
    restarted
        .resolve_recovered_file_checkpoint(intended)
        .unwrap();

    let manifest = restarted.manifest();
    assert!(manifest.pending_file_checkpoint.is_none());
    assert!(manifest.file_checkpoint_covers_durable_heads());
    // The disk file is a byte-exact export of every durable head, so the
    // resolved manifest is a joinable staged baseline in this restart.
    assert_eq!(manifest.source_phase, RecoverySourcePhase::DurablyStaged);
}

// --- Generative property ---

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    /// Drive random command sequences through the shadow model. Every command
    /// asserts live-manifest conformance, and every Reload (plus one forced
    /// final Reload) asserts the recovery invariants from the module doc.
    #[test]
    fn recovery_journal_reload_matches_model(
        ops in prop::collection::vec(op_strategy(), 1..=12),
        final_replace_landed in any::<bool>(),
    ) {
        let mut runner = Runner::new();
        for op in &ops {
            runner.apply(op);
        }
        runner.apply(&Op::Reload { replace_landed: final_replace_landed });
    }
}
