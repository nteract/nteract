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
        source: automerge::AutomergeError,
    },
    #[error(transparent)]
    Panic(#[from] AutomergeRecoveryError),
    #[error("[{label}] failed to rebuild document after Automerge panic")]
    RebuildFailed { label: String },
}

impl AutomergeOperationError {
    pub fn automerge(label: impl Into<String>, source: automerge::AutomergeError) -> Self {
        Self::Automerge {
            label: label.into(),
            source,
        }
    }

    pub fn rebuild_failed(label: impl Into<String>) -> Self {
        Self::RebuildFailed {
            label: label.into(),
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn returns_normal_closure_value() {
        let value = catch_automerge_panic("normal", || 42).unwrap();
        assert_eq!(value, 42);
    }

    #[test]
    fn captures_string_panic_payload() {
        let error = catch_automerge_panic("string", || {
            std::panic::panic_any("owned payload".to_string())
        })
        .unwrap_err();

        assert_eq!(error.label, "string");
        assert_eq!(error.panic_message, "owned payload");
    }

    #[test]
    fn captures_str_panic_payload() {
        let error = catch_automerge_panic("str", || panic!("borrowed payload")).unwrap_err();

        assert_eq!(error.label, "str");
        assert_eq!(error.panic_message, "borrowed payload");
    }

    #[test]
    fn captures_unknown_panic_payload() {
        let error =
            catch_automerge_panic("unknown", || std::panic::panic_any(17usize)).unwrap_err();

        assert_eq!(error.label, "unknown");
        assert_eq!(error.panic_message, "unknown panic");
    }
}
