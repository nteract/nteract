//! Panic recovery helpers for Automerge operations.
//!
//! This crate intentionally depends only on `automerge` and error plumbing.
//! Document-specific rebuild, peer-state reset, and retry policy belongs in the
//! owning document crates.

use std::any::Any;
use std::panic::AssertUnwindSafe;

/// Panic captured from an Automerge operation.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("[{label}] automerge panicked: {panic_message}")]
pub struct AutomergeRecoveryError {
    pub label: String,
    pub panic_message: String,
}

impl AutomergeRecoveryError {
    pub fn new(label: impl Into<String>, panic_message: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            panic_message: panic_message.into(),
        }
    }
}

/// Error returned by document-level recovering Automerge operations.
#[derive(Debug, thiserror::Error)]
pub enum AutomergeOperationError {
    #[error("[{label}] automerge operation failed: {source}")]
    Automerge {
        label: String,
        #[source]
        source: Box<automerge::AutomergeError>,
    },
    #[error(transparent)]
    Panic(#[from] AutomergeRecoveryError),
    #[error("[{label}] failed to rebuild document after Automerge panic: {source}")]
    RebuildFailed {
        label: String,
        #[source]
        source: AutomergeRebuildError,
    },
}

impl AutomergeOperationError {
    pub fn automerge(label: impl Into<String>, source: automerge::AutomergeError) -> Self {
        Self::Automerge {
            label: label.into(),
            source: Box::new(source),
        }
    }

    pub fn rebuild_failed(label: impl Into<String>, source: AutomergeRebuildError) -> Self {
        Self::RebuildFailed {
            label: label.into(),
            source,
        }
    }
}

/// Error returned when save/load rebuild cannot safely replace a document.
#[derive(Debug, thiserror::Error)]
pub enum AutomergeRebuildError {
    #[error(transparent)]
    Panic(#[from] AutomergeRecoveryError),
    #[error("load failed: {source}")]
    Load {
        #[source]
        source: Box<automerge::AutomergeError>,
    },
    #[error("rebuilt notebook would lose cells ({before} -> {after})")]
    CellLoss { before: usize, after: usize },
}

impl AutomergeRebuildError {
    pub fn load(source: automerge::AutomergeError) -> Self {
        Self::Load {
            source: Box::new(source),
        }
    }

    pub fn cell_loss(before: usize, after: usize) -> Self {
        Self::CellLoss { before, after }
    }
}

/// Convert a panic payload into stable human-readable text.
pub fn panic_payload_to_string(payload: Box<dyn Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else {
        "unknown panic".to_string()
    }
}

/// Catch a panic from an Automerge operation without exposing `catch_unwind` at call sites.
pub fn catch_automerge_panic<T>(
    label: impl Into<String>,
    f: impl FnOnce() -> T,
) -> Result<T, AutomergeRecoveryError> {
    let label = label.into();
    match std::panic::catch_unwind(AssertUnwindSafe(f)) {
        Ok(value) => Ok(value),
        Err(payload) => Err(AutomergeRecoveryError::new(
            label,
            panic_payload_to_string(payload),
        )),
    }
}

/// Flattened outcome from an Automerge operation that can either return an
/// operation error or panic.
#[derive(Debug)]
pub enum AutomergeAttempt<T, E = automerge::AutomergeError> {
    Success(T),
    OperationError(E),
    Panic(AutomergeRecoveryError),
}

impl<T, E> AutomergeAttempt<T, E> {
    fn from_caught_result(
        caught: Result<Result<T, E>, AutomergeRecoveryError>,
    ) -> AutomergeAttempt<T, E> {
        match caught {
            Ok(result) => result.map_or_else(Self::OperationError, Self::Success),
            Err(error) => Self::Panic(error),
        }
    }
}

impl<T> AutomergeAttempt<T, automerge::AutomergeError> {
    pub fn into_operation_result(
        self,
        label: impl Into<String>,
    ) -> Result<T, AutomergeOperationError> {
        let label = label.into();
        match self {
            Self::Success(value) => Ok(value),
            Self::OperationError(source) => Err(AutomergeOperationError::automerge(label, source)),
            Self::Panic(error) => Err(AutomergeOperationError::Panic(error)),
        }
    }
}

/// Catch an Automerge operation that returns a `Result` and flatten the
/// operation error plus panic channels into an explicit outcome.
pub fn catch_automerge_result<T, E>(
    label: impl Into<String>,
    f: impl FnOnce() -> Result<T, E>,
) -> AutomergeAttempt<T, E> {
    AutomergeAttempt::from_caught_result(catch_automerge_panic(label, f))
}

/// Run an Automerge operation and, when it panics or returns a caller-marked
/// recoverable error, rebuild caller-owned state and retry once.
///
/// The `context` is intentionally opaque to this crate. Document owners use it
/// to keep their document, per-peer `sync::State`, and any retry frame together
/// without making this small crate depend on higher-level document crates.
pub fn recoverable_automerge_operation<C, T>(
    label: impl Into<String>,
    context: &mut C,
    mut operation: impl FnMut(&mut C) -> Result<T, automerge::AutomergeError>,
    should_rebuild: impl Fn(&automerge::AutomergeError) -> bool,
    mut rebuild: impl FnMut(&mut C) -> Result<(), AutomergeRebuildError>,
) -> Result<T, AutomergeOperationError> {
    let label = label.into();

    let first_panic = match catch_automerge_result(label.clone(), || operation(context)) {
        AutomergeAttempt::Success(value) => return Ok(value),
        AutomergeAttempt::OperationError(source) if should_rebuild(&source) => None,
        AutomergeAttempt::OperationError(source) => {
            return Err(AutomergeOperationError::automerge(label, source));
        }
        AutomergeAttempt::Panic(error) => Some(error),
    };

    if let Err(source) = rebuild(context) {
        return Err(AutomergeOperationError::rebuild_failed(label, source));
    }

    match catch_automerge_result(label.clone(), || operation(context)) {
        AutomergeAttempt::Success(value) => Ok(value),
        AutomergeAttempt::OperationError(source) => {
            Err(AutomergeOperationError::automerge(label, source))
        }
        AutomergeAttempt::Panic(error) => {
            Err(AutomergeOperationError::Panic(first_panic.unwrap_or(error)))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::{
        sync, sync::SyncDoc, transaction::Transactable, ActorId, AutoCommit, ChangeHash, ObjType,
        ReadDoc, ROOT,
    };
    use std::fmt::Debug;

    #[test]
    fn returns_normal_closure_value() {
        match catch_automerge_panic("normal", || 42) {
            Ok(value) => assert_eq!(value, 42),
            Err(error) => panic!("expected normal value, got {error}"),
        }
    }

    #[test]
    fn captures_string_panic_payload() {
        let error = match catch_automerge_panic("string", || {
            std::panic::panic_any("owned payload".to_string())
        }) {
            Ok(_) => panic!("expected panic capture"),
            Err(error) => error,
        };

        assert_eq!(error.label, "string");
        assert_eq!(error.panic_message, "owned payload");
    }

    #[test]
    fn captures_str_panic_payload() {
        let error = match catch_automerge_panic("str", || panic!("borrowed payload")) {
            Ok(_) => panic!("expected panic capture"),
            Err(error) => error,
        };

        assert_eq!(error.label, "str");
        assert_eq!(error.panic_message, "borrowed payload");
    }

    #[test]
    fn captures_unknown_panic_payload() {
        let error = match catch_automerge_panic("unknown", || std::panic::panic_any(17usize)) {
            Ok(_) => panic!("expected panic capture"),
            Err(error) => error,
        };

        assert_eq!(error.label, "unknown");
        assert_eq!(error.panic_message, "unknown panic");
    }

    #[test]
    fn catch_result_flattens_success() {
        match catch_automerge_result("success", || Ok::<_, &'static str>(7)) {
            AutomergeAttempt::Success(value) => assert_eq!(value, 7),
            other => panic!("expected success, got {other:?}"),
        }
    }

    #[test]
    fn catch_result_flattens_operation_error() {
        match catch_automerge_result("operation-error", || Err::<(), _>("bad op")) {
            AutomergeAttempt::OperationError(error) => assert_eq!(error, "bad op"),
            other => panic!("expected operation error, got {other:?}"),
        }
    }

    #[test]
    fn catch_result_flattens_panic() {
        match catch_automerge_result("panic", || -> Result<(), &'static str> {
            panic!("bad panic")
        }) {
            AutomergeAttempt::Panic(error) => {
                assert_eq!(error.label, "panic");
                assert_eq!(error.panic_message, "bad panic");
            }
            other => panic!("expected panic, got {other:?}"),
        }
    }

    #[test]
    fn recoverable_operation_returns_normal_value_without_rebuild() {
        let mut rebuilds = 0;
        let result = recoverable_automerge_operation(
            "normal",
            &mut rebuilds,
            |_| Ok(42),
            |_| true,
            |rebuilds| {
                *rebuilds += 1;
                Ok(())
            },
        );
        let value = match result {
            Ok(value) => value,
            Err(error) => panic!("normal operation should succeed, got {error:?}"),
        };

        assert_eq!(value, 42);
        assert_eq!(rebuilds, 0);
    }

    #[test]
    fn recoverable_operation_rebuilds_after_marked_error_and_retries_once() {
        let mut calls = 0;
        let result = recoverable_automerge_operation(
            "recoverable-error",
            &mut calls,
            |calls| {
                *calls += 1;
                if *calls == 1 {
                    Err(automerge::AutomergeError::PatchLogMismatch)
                } else {
                    Ok("retried")
                }
            },
            |source| matches!(source, automerge::AutomergeError::PatchLogMismatch),
            |_| Ok(()),
        );
        let value = match result {
            Ok(value) => value,
            Err(error) => panic!("recoverable error should rebuild and retry, got {error:?}"),
        };

        assert_eq!(value, "retried");
        assert_eq!(calls, 2);
    }

    #[test]
    fn recoverable_operation_returns_unmarked_error_without_rebuild() {
        let mut rebuilt = false;
        let result = recoverable_automerge_operation::<_, ()>(
            "nonrecoverable-error",
            &mut rebuilt,
            |_| Err(automerge::AutomergeError::InvalidObjId("bad object".into())),
            |_| false,
            |rebuilt| {
                *rebuilt = true;
                Ok(())
            },
        );
        let error = match result {
            Ok(()) => panic!("unmarked error should not recover"),
            Err(error) => error,
        };

        assert!(!rebuilt);
        assert!(matches!(error, AutomergeOperationError::Automerge { .. }));
    }

    #[test]
    fn recoverable_operation_rebuilds_after_panic_and_preserves_first_repeated_panic() {
        let mut calls = 0;
        let result = recoverable_automerge_operation::<_, ()>(
            "repeated-panic",
            &mut calls,
            |calls| {
                *calls += 1;
                if *calls == 1 {
                    panic!("first panic");
                }
                panic!("second panic");
            },
            |_| false,
            |_| Ok(()),
        );
        let error = match result {
            Ok(()) => panic!("repeated panic should fail"),
            Err(error) => error,
        };

        match error {
            AutomergeOperationError::Panic(error) => {
                assert_eq!(error.label, "repeated-panic");
                assert_eq!(error.panic_message, "first panic");
            }
            other => panic!("expected panic error, got {other:?}"),
        }
        assert_eq!(calls, 2);
    }

    #[test]
    fn historical_fork_at_missing_ops_regression_is_fixed_by_desktop_patch() {
        let (mut daemon, old_heads) = build_missing_ops_historical_fork_doc();
        let fork_at = catch_automerge_panic("missing-ops-fork-at", || daemon.fork_at(&old_heads));
        assert!(
            fork_at.is_ok(),
            "desktop-patched Automerge should not panic on historical fork_at"
        );
    }

    #[test]
    fn missing_ops_operation_matrix_stays_non_panicking() {
        let (mut daemon, old_heads) = build_missing_ops_historical_fork_doc();
        let current_heads = daemon.get_heads();

        let get_changes =
            catch_automerge_panic("missing-ops-get-changes", || daemon.get_changes(&old_heads));
        assert!(get_changes.is_ok(), "get_changes should not panic");

        let diff = catch_automerge_panic("missing-ops-diff", || {
            daemon.diff(&old_heads, &current_heads)
        });
        assert!(diff.is_ok(), "diff should not panic");

        let save_after =
            catch_automerge_panic("missing-ops-save-after", || daemon.save_after(&old_heads));
        assert!(save_after.is_ok(), "save_after should not panic");

        let mut sync_state = sync::State::new();
        let generate_sync_message = catch_automerge_panic("missing-ops-generate-sync", || {
            daemon.sync().generate_sync_message(&mut sync_state)
        });
        assert!(
            generate_sync_message.is_ok(),
            "generate_sync_message should not panic"
        );

        let (mut isolated_doc, isolated_heads) = build_missing_ops_historical_fork_doc();
        let isolated_transaction =
            catch_automerge_panic("missing-ops-isolated-transaction", || {
                isolated_doc.isolate(&isolated_heads);
                must(
                    isolated_doc.put(ROOT, "isolated", true),
                    "isolated transaction write should succeed",
                );
                isolated_doc.integrate();
            });
        assert!(
            isolated_transaction.is_ok(),
            "isolated AutoCommit transaction should not panic"
        );

        let fork_at = catch_automerge_panic("missing-ops-fork-at", || daemon.fork_at(&old_heads));
        assert!(fork_at.is_ok(), "fork_at should not panic");
    }

    #[test]
    fn save_load_rebuild_preserves_fixed_historical_fork_at_behavior() {
        let (mut daemon, old_heads) = build_missing_ops_historical_fork_doc();
        let bytes = daemon.save();
        let mut rebuilt = must(AutoCommit::load(&bytes), "saved bad doc should reload");

        let fork_at = catch_automerge_panic("rebuilt-missing-ops-fork-at", || {
            rebuilt.fork_at(&old_heads)
        });
        assert!(
            fork_at.is_ok(),
            "desktop-patched Automerge should keep historical fork_at non-panicking after save/load"
        );
    }

    fn build_missing_ops_historical_fork_doc() -> (AutoCommit, Vec<ChangeHash>) {
        let mut daemon = AutoCommit::new();
        daemon.set_actor(ActorId::from(b"daemon" as &[u8]));

        let text = must(
            daemon.put_object(ROOT, "source", ObjType::Text),
            "source text object should be created",
        );
        must(
            daemon.splice_text(&text, 0, 0, "# notebook cell\n"),
            "initial source text should be inserted",
        );
        daemon.commit();

        let mut peer = AutoCommit::new();
        peer.set_actor(ActorId::from(b"wasm" as &[u8]));
        let mut peer_sync = sync::State::new();
        let mut daemon_sync = sync::State::new();
        sync_docs_until_quiet(&mut daemon, &mut daemon_sync, &mut peer, &mut peer_sync);

        let mut checkpoint_heads = Vec::new();

        for i in 0..=200 {
            let pos = must(peer.text(&text), "peer text should be readable").len();
            must(
                peer.splice_text(
                    &text,
                    pos,
                    0,
                    &format!("{}", (b'a' + (i % 26) as u8) as char),
                ),
                "peer text append should succeed",
            );
            peer.commit();

            if i % 10 == 0 {
                sync_one_message(&mut peer, &mut peer_sync, &mut daemon, &mut daemon_sync);

                let mut fork = daemon.fork();
                fork.set_actor(ActorId::from(format!("d:f{}", i).as_bytes()));
                must(
                    fork.put(ROOT, "exec_count", (i / 10) as i64),
                    "daemon fork metadata write should succeed",
                );
                fork.commit();
                must(daemon.merge(&mut fork), "daemon fork merge should succeed");

                sync_one_message(&mut daemon, &mut daemon_sync, &mut peer, &mut peer_sync);
            }

            if i == 100 {
                checkpoint_heads.push(daemon.get_heads());
            }
        }

        let old_heads = must_some(
            checkpoint_heads.pop(),
            "checkpoint heads should be captured",
        );
        (daemon, old_heads)
    }

    fn sync_docs_until_quiet(
        left: &mut AutoCommit,
        left_sync: &mut sync::State,
        right: &mut AutoCommit,
        right_sync: &mut sync::State,
    ) {
        for _ in 0..20 {
            let mut progressed = false;
            if let Some(msg) = left.sync().generate_sync_message(left_sync) {
                must(
                    right.sync().receive_sync_message(right_sync, msg),
                    "right doc should receive sync message",
                );
                progressed = true;
            }
            if let Some(msg) = right.sync().generate_sync_message(right_sync) {
                must(
                    left.sync().receive_sync_message(left_sync, msg),
                    "left doc should receive sync message",
                );
                progressed = true;
            }
            if !progressed {
                break;
            }
        }
    }

    fn sync_one_message(
        from: &mut AutoCommit,
        from_sync: &mut sync::State,
        to: &mut AutoCommit,
        to_sync: &mut sync::State,
    ) {
        if let Some(msg) = from.sync().generate_sync_message(from_sync) {
            must(
                to.sync().receive_sync_message(to_sync, msg),
                "target doc should receive one sync message",
            );
        }
        if let Some(msg) = to.sync().generate_sync_message(to_sync) {
            must(
                from.sync().receive_sync_message(from_sync, msg),
                "source doc should receive one sync reply",
            );
        }
    }

    fn must<T, E: Debug>(result: Result<T, E>, context: &str) -> T {
        match result {
            Ok(value) => value,
            Err(error) => panic!("{context}: {error:?}"),
        }
    }

    fn must_some<T>(value: Option<T>, context: &str) -> T {
        match value {
            Some(value) => value,
            None => panic!("{context}"),
        }
    }
}
