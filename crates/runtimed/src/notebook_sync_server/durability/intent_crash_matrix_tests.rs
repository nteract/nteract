//! Restart-time crash matrix for pending file-checkpoint intents.
//!
//! Every row crashes a room between the durable checkpoint intent and its
//! terminal marker (abort or commit), restarts from the recovery journal,
//! and resolves the intent against a scripted disk state. The property each
//! row asserts is the resolution trichotomy of
//! [`RoomDurability::resolve_recovered_file_checkpoint`]:
//!
//! - disk bytes match the intended checkpoint => `Committed` with the
//!   checkpoint metadata (exported heads, save sequence, fingerprint, and
//!   any reconciliation generation) advanced to the intent
//! - disk bytes match the previous source => pending cleared, no metadata
//!   advance
//! - any third content => `SourceConflict` with the pending intent preserved
//!   verbatim, never a silent selection and never journal degradation
//!
//! Two oracles run on every row in addition to the branch expectation:
//!
//! - the recovery union is bit-identical across resolution; resolving may
//!   only move manifest metadata, never document bytes
//! - resolution is idempotent: a second resolve with the same observed
//!   fingerprint appends nothing and leaves the manifest bit-identical
//!
//! Faults are injected through filesystem state only: `RecoveryJournal`
//! reopens its file on every append, so a read-only journal file fails the
//! abort/commit marker append at exactly the crash-window boundary and heals
//! on restart. This matrix is about restart-time intent resolution; live
//! coordinator interleavings belong to `file_checkpoint::model_tests`.

use std::fs;
use std::path::{Path, PathBuf};

use automerge::{transaction::Transactable, AutoCommit, ROOT};
use uuid::Uuid;

use super::*;
use crate::notebook_sync_server::recovery::{source_fingerprint, RecoveryLoadOutcome};

const PREVIOUS_SOURCE: &[u8] = b"previous notebook bytes";
const INTENDED_SOURCE: &[u8] = b"intended replacement bytes";
const THIRD_SOURCE: &[u8] = b"external third revision";

/// Save sequence claimed by the interrupted checkpoint. The baseline source
/// commit owns sequence 0, so an advance is observable.
const SAVE_SEQUENCE: u64 = 2;

const BASELINE_GENERATION: u64 = 1;

/// How far the interrupted save got before the crash. In every window the
/// journal's last word is the prepared intent; the fault windows additionally
/// prove that a failed terminal-marker append degrades the live room without
/// consuming the durable intent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CrashWindow {
    /// Crash with the intent journaled and no terminal marker attempted.
    AfterPrepare,
    /// Replacement definitively did not occur and the abort marker append
    /// itself failed before the crash.
    AbortAppendFailed,
    /// The atomic replace landed (new bytes visible on disk) and the commit
    /// marker append failed before the crash.
    CommitAppendFailedAfterReplace,
}

/// Fingerprint the restarting room observes on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DiskAtRestart {
    Intended,
    Previous,
    Third,
    /// The empty-content digest, which is what a room hashes when its source
    /// read fails. Production short-circuits before the resolver in that
    /// state (covered by the room restart test
    /// `room_restart_with_missing_source_file_preserves_intent_without_resolving`);
    /// this row is defense in depth for the resolver itself.
    EmptyContent,
}

/// The trichotomy branch the row must land in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expected {
    CommittedAdvance,
    PendingClearedNoAdvance,
    SourceConflict,
}

struct Row {
    crash: CrashWindow,
    /// `Some` models a reconciliation save whose intent carries the selected
    /// source generation; `None` is an ordinary save.
    source_generation: Option<u64>,
    disk: DiskAtRestart,
    expected: Expected,
}

/// Fail journal appends inside `action` by making the journal file
/// read-only. `RecoveryJournal::append` opens the file for writing on every
/// call, so this is a deterministic, restart-healing fault seam.
fn with_read_only_journal(journal_path: &Path, action: impl FnOnce()) {
    let mut permissions = fs::metadata(journal_path).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(journal_path, permissions).unwrap();

    action();

    let mut permissions = fs::metadata(journal_path).unwrap().permissions();
    // The journal lives in a per-test tempdir, so restoring the write bit
    // broadly is safe here.
    #[allow(clippy::permissions_set_readonly_false)]
    permissions.set_readonly(false);
    fs::set_permissions(journal_path, permissions).unwrap();
}

fn journal_len(journal_path: &Path) -> u64 {
    fs::metadata(journal_path).unwrap().len()
}

struct RestartFixture {
    journal: RecoveryJournal,
    journal_path: PathBuf,
    canonical_path: PathBuf,
    previous_source: SourceFingerprint,
    intended_source: SourceFingerprint,
    /// Heads of the durable union carried by the checkpoint intent.
    intended_heads: Vec<[u8; 32]>,
    /// Manifest after the baseline source commit, before the intent.
    baseline: RecoveryManifest,
    _directory: tempfile::TempDir,
}

/// Run the live phase: durable baseline source, one further durable edit,
/// prepared checkpoint intent, scripted crash-window fault, crash.
fn crash_with_pending_intent(row: &Row) -> RestartFixture {
    let directory = tempfile::tempdir().unwrap();
    let journal_path = directory.path().join("room.recovery");
    let journal = RecoveryJournal::new(journal_path.clone());
    let canonical_path = directory.path().join("notebook.ipynb");
    let previous_source = source_fingerprint(PREVIOUS_SOURCE);
    let intended_source = source_fingerprint(INTENDED_SOURCE);

    // Baseline: the previous source durably staged and ready. This pins the
    // manifest's exported heads and save sequence 0 to the previous source,
    // so an advance by the resolved intent is observable.
    let mut doc = AutoCommit::new();
    doc.put(ROOT, "cell", "previous").unwrap();
    let source_heads: Vec<[u8; 32]> = doc.get_heads().iter().map(|head| head.0).collect();
    let source_change_hash = doc.get_changes(&[])[0].hash().0;
    let source_snapshot = doc.save();
    let durability = RoomDurability::journaled(
        journal.clone(),
        Uuid::nil(),
        Some(canonical_path.clone()),
        previous_source,
        BASELINE_GENERATION,
        source_snapshot.clone(),
    );
    durability
        .commit_snapshot(
            &source_snapshot,
            source_heads.clone(),
            DurableMutation::Source {
                generation: BASELINE_GENERATION,
                fingerprint: previous_source,
                staged_change_hashes: vec![source_change_hash],
            },
        )
        .unwrap();
    durability.commit_source_ready(BASELINE_GENERATION).unwrap();

    // One durable edit past the source baseline: the union the interrupted
    // save exported. Its heads differ from the baseline exported heads.
    doc.put(ROOT, "cell", "intended").unwrap();
    let intended_heads: Vec<[u8; 32]> = doc.get_heads().iter().map(|head| head.0).collect();
    let edited_snapshot = doc.save();
    durability
        .commit_snapshot(
            &edited_snapshot,
            intended_heads.clone(),
            DurableMutation::Daemon,
        )
        .unwrap();
    let baseline = durability.manifest();
    assert_eq!(baseline.exported_heads, source_heads);
    assert_eq!(baseline.file_save_sequence, Some(0));
    assert_ne!(baseline.exported_heads, intended_heads);

    durability
        .prepare_file_checkpoint(
            canonical_path.clone(),
            intended_source,
            intended_heads.clone(),
            SAVE_SEQUENCE,
            row.source_generation,
        )
        .unwrap();

    match row.crash {
        CrashWindow::AfterPrepare => {}
        CrashWindow::AbortAppendFailed => {
            with_read_only_journal(&journal_path, || {
                let error = durability.abort_file_checkpoint(SAVE_SEQUENCE).unwrap_err();
                assert!(
                    matches!(error, RoomDurabilityError::Journal(_)),
                    "read-only journal must fail the abort marker append, got {error:?}"
                );
            });
            assert!(
                durability.status().is_degraded(),
                "a failed abort append must be visible as live degradation"
            );
            assert!(
                durability.manifest().pending_file_checkpoint.is_some(),
                "a failed abort append must not consume the durable intent"
            );
        }
        CrashWindow::CommitAppendFailedAfterReplace => {
            with_read_only_journal(&journal_path, || {
                let error = durability
                    .commit_file_checkpoint(
                        canonical_path.clone(),
                        intended_source,
                        intended_heads.clone(),
                        SAVE_SEQUENCE,
                    )
                    .unwrap_err();
                assert!(
                    matches!(error, RoomDurabilityError::Journal(_)),
                    "read-only journal must fail the commit marker append, got {error:?}"
                );
            });
            assert!(
                durability.status().is_degraded(),
                "a failed commit append must be visible as live degradation"
            );
            assert!(
                durability.manifest().pending_file_checkpoint.is_some(),
                "a failed commit append must keep the intent pending for restart"
            );
        }
    }

    drop(durability); // Crash.

    RestartFixture {
        journal,
        journal_path,
        canonical_path,
        previous_source,
        intended_source,
        intended_heads,
        baseline,
        _directory: directory,
    }
}

fn run_row(row: Row) {
    let fixture = crash_with_pending_intent(&row);

    let observed = match row.disk {
        DiskAtRestart::Intended => fixture.intended_source,
        DiskAtRestart::Previous => fixture.previous_source,
        DiskAtRestart::Third => source_fingerprint(THIRD_SOURCE),
        // The digest of zero bytes; the journal load below must classify it
        // as a conflict, not a match.
        DiskAtRestart::EmptyContent => source_fingerprint(&[]),
    };

    // Restart: the load classification is the false-lockout guard. The
    // intended bytes must be recognized through the pending fingerprint (a
    // provisional conflict here would brick the room on every restart), the
    // previous bytes through the manifest fingerprint, and anything else
    // must preserve the full recovery instead of discarding it.
    let recovered = match (row.disk, fixture.journal.load(observed).unwrap()) {
        (DiskAtRestart::Intended | DiskAtRestart::Previous, RecoveryLoadOutcome::Match(r)) => r,
        (
            DiskAtRestart::Third | DiskAtRestart::EmptyContent,
            RecoveryLoadOutcome::SourceConflict { recovery, .. },
        ) => recovery,
        (disk, other) => panic!("unexpected load classification for {disk:?}: {other:?}"),
    };
    let union_before = recovered.record.automerge_snapshot.clone();

    let restarted = RoomDurability::recovered(fixture.journal.clone(), recovered);
    assert!(
        !restarted.status().is_degraded(),
        "a clean journal must not restart degraded, even after a failed marker append"
    );
    assert_eq!(
        restarted.durable_snapshot().as_ref(),
        union_before.as_slice()
    );
    let manifest_at_restart = restarted.manifest();
    let pending_at_restart = manifest_at_restart
        .pending_file_checkpoint
        .clone()
        .expect("every crash window leaves the durable intent as the journal's last word");
    assert_eq!(pending_at_restart.file_fingerprint, fixture.intended_source);
    assert_eq!(pending_at_restart.save_sequence, SAVE_SEQUENCE);
    assert_eq!(pending_at_restart.source_generation, row.source_generation);
    let journal_len_at_restart = journal_len(&fixture.journal_path);

    let first = restarted.resolve_recovered_file_checkpoint(observed);
    match row.expected {
        Expected::CommittedAdvance => {
            assert!(
                matches!(first, Ok(DurableCommitOutcome::Committed(_))),
                "intended bytes on disk must finalize the checkpoint, got {first:?}"
            );
            let manifest = restarted.manifest();
            assert_eq!(manifest.source_fingerprint, fixture.intended_source);
            assert_eq!(manifest.exported_heads, fixture.intended_heads);
            assert_eq!(manifest.file_save_sequence, Some(SAVE_SEQUENCE));
            assert_eq!(
                manifest.canonical_path,
                Some(fixture.canonical_path.clone())
            );
            assert!(manifest.pending_file_checkpoint.is_none());
            match row.source_generation {
                Some(generation) => {
                    // Reconciliation advances the generation atomically in
                    // the same record as the finalized checkpoint.
                    assert_eq!(manifest.source_generation, generation);
                    assert_eq!(manifest.source_phase, RecoverySourcePhase::DurablyStaged);
                }
                None => {
                    assert_eq!(manifest.source_generation, BASELINE_GENERATION);
                    assert_eq!(manifest.source_phase, RecoverySourcePhase::Ready);
                }
            }
            assert!(!restarted.status().is_degraded());

            // The finalized record is durable under the new fingerprint and
            // carries the identical recovery union.
            let reloaded = match fixture.journal.load(fixture.intended_source).unwrap() {
                RecoveryLoadOutcome::Match(reloaded) => reloaded,
                other => panic!("finalized checkpoint should match disk, got {other:?}"),
            };
            assert!(reloaded.record.manifest.pending_file_checkpoint.is_none());
            assert_eq!(reloaded.record.automerge_snapshot, union_before);
        }
        Expected::PendingClearedNoAdvance => {
            assert!(
                matches!(first, Ok(DurableCommitOutcome::Committed(_))),
                "previous bytes on disk must clear the intent, got {first:?}"
            );
            let manifest = restarted.manifest();
            assert!(manifest.pending_file_checkpoint.is_none());
            assert_eq!(manifest.source_fingerprint, fixture.previous_source);
            assert_eq!(manifest.exported_heads, fixture.baseline.exported_heads);
            assert_eq!(
                manifest.file_save_sequence,
                fixture.baseline.file_save_sequence
            );
            assert_eq!(
                manifest.source_generation, BASELINE_GENERATION,
                "an aborted reconciliation intent must not advance the generation"
            );
            assert_eq!(manifest.source_phase, fixture.baseline.source_phase);
            assert!(!restarted.status().is_degraded());

            let reloaded = match fixture.journal.load(fixture.previous_source).unwrap() {
                RecoveryLoadOutcome::Match(reloaded) => reloaded,
                other => panic!("cleared intent should match the previous source, got {other:?}"),
            };
            assert!(reloaded.record.manifest.pending_file_checkpoint.is_none());
            assert_eq!(reloaded.record.automerge_snapshot, union_before);
        }
        Expected::SourceConflict => {
            match first {
                Err(RoomDurabilityError::SourceConflict {
                    journal_source,
                    observed_source,
                }) => {
                    assert_eq!(journal_source, fixture.previous_source);
                    assert_eq!(observed_source, observed);
                }
                other => panic!("third content must be a source conflict, got {other:?}"),
            }
            assert_eq!(
                restarted.manifest(),
                manifest_at_restart,
                "a conflict must preserve the pending intent and every manifest field"
            );
            assert_eq!(
                journal_len(&fixture.journal_path),
                journal_len_at_restart,
                "a conflict must append nothing"
            );
            assert!(
                !restarted.status().is_degraded(),
                "a third revision is a reconciliation conflict, not failed journal durability"
            );
        }
    }

    // Oracle: the recovery union is bit-identical across resolution.
    assert_eq!(
        restarted.durable_snapshot().as_ref(),
        union_before.as_slice(),
        "resolution must not mutate recovered document state"
    );

    // Oracle: resolution is idempotent. A second resolve with the same
    // observed fingerprint appends nothing and leaves the manifest
    // bit-identical.
    let manifest_after_first = restarted.manifest();
    let journal_len_after_first = journal_len(&fixture.journal_path);
    let second = restarted.resolve_recovered_file_checkpoint(observed);
    match row.expected {
        Expected::CommittedAdvance | Expected::PendingClearedNoAdvance => {
            assert!(
                matches!(second, Ok(DurableCommitOutcome::AlreadyDurable(_))),
                "double resolve must be a no-op, got {second:?}"
            );
        }
        Expected::SourceConflict => {
            assert!(
                matches!(second, Err(RoomDurabilityError::SourceConflict { .. })),
                "an unresolved conflict must classify identically on retry, got {second:?}"
            );
        }
    }
    assert_eq!(restarted.manifest(), manifest_after_first);
    assert_eq!(journal_len(&fixture.journal_path), journal_len_after_first);
    assert_eq!(
        restarted.durable_snapshot().as_ref(),
        union_before.as_slice()
    );
}

/// Validated seed row: `restart_finalizes_file_replacement_from_durable_intent`
/// (unit) and `room_restart_finalizes_checkpoint_when_intended_file_replacement_landed`
/// (room integration) both exercise this cell.
#[test]
fn intended_bytes_on_disk_finalize_the_checkpoint() {
    run_row(Row {
        crash: CrashWindow::AfterPrepare,
        source_generation: None,
        disk: DiskAtRestart::Intended,
        expected: Expected::CommittedAdvance,
    });
}

/// Validated seed row: `restart_aborts_checkpoint_intent_when_old_file_remains`
/// (unit) exercises this cell.
#[test]
fn previous_bytes_on_disk_clear_the_intent_without_advance() {
    run_row(Row {
        crash: CrashWindow::AfterPrepare,
        source_generation: None,
        disk: DiskAtRestart::Previous,
        expected: Expected::PendingClearedNoAdvance,
    });
}

/// Validated seed row:
/// `room_restart_preserves_third_revision_as_source_conflict_not_journal_failure`
/// (room integration) exercises this cell.
#[test]
fn third_bytes_on_disk_are_a_source_conflict_with_intent_preserved() {
    run_row(Row {
        crash: CrashWindow::AfterPrepare,
        source_generation: None,
        disk: DiskAtRestart::Third,
        expected: Expected::SourceConflict,
    });
}

/// New cell: the abort marker append failed before the crash. Restart with
/// the previous bytes still resolves to the abort branch instead of leaving
/// the room degraded or the intent stuck.
#[test]
fn abort_append_failure_heals_on_restart_with_previous_bytes() {
    run_row(Row {
        crash: CrashWindow::AbortAppendFailed,
        source_generation: None,
        disk: DiskAtRestart::Previous,
        expected: Expected::PendingClearedNoAdvance,
    });
}

/// New cell: the replace was visible on disk when the commit marker append
/// failed. Restart must finalize the checkpoint from the durable intent, not
/// regenerate over the saved file or report a conflict.
#[test]
fn commit_append_failure_after_visible_replace_finalizes_on_restart() {
    run_row(Row {
        crash: CrashWindow::CommitAppendFailedAfterReplace,
        source_generation: None,
        disk: DiskAtRestart::Intended,
        expected: Expected::CommittedAdvance,
    });
}

/// New cell, defense in depth: the resolver refuses to pick a side on the
/// empty-content fingerprint (the digest a room computes when its source
/// read fails) and preserves the intent. This does not exercise the real
/// missing-file restart path; production short-circuits before the resolver
/// there, covered by
/// `room_restart_with_missing_source_file_preserves_intent_without_resolving`
/// in the room tests.
#[test]
fn empty_content_fingerprint_is_refused_as_source_conflict() {
    run_row(Row {
        crash: CrashWindow::AfterPrepare,
        source_generation: None,
        disk: DiskAtRestart::EmptyContent,
        expected: Expected::SourceConflict,
    });
}

/// New cell: a reconciliation intent carries the selected source generation
/// and the finalizing resolve advances it atomically with the checkpoint.
#[test]
fn reconciliation_intent_advances_generation_with_the_checkpoint() {
    run_row(Row {
        crash: CrashWindow::AfterPrepare,
        source_generation: Some(7),
        disk: DiskAtRestart::Intended,
        expected: Expected::CommittedAdvance,
    });
}

/// New cell: an aborted reconciliation intent must not advance the source
/// generation; the previous bytes clear it like an ordinary save.
#[test]
fn reconciliation_intent_abort_does_not_advance_generation() {
    run_row(Row {
        crash: CrashWindow::AfterPrepare,
        source_generation: Some(7),
        disk: DiskAtRestart::Previous,
        expected: Expected::PendingClearedNoAdvance,
    });
}
