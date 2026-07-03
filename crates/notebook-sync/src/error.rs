//! Error types for notebook-sync operations.

use notebook_protocol::protocol::BlobUploadErrorKind;

/// Errors that can occur during notebook sync operations.
#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    /// The document mutex was poisoned (a thread panicked while holding it).
    #[error("Document lock poisoned")]
    LockPoisoned,

    /// An Automerge operation failed.
    #[error("Automerge error: {0}")]
    Automerge(#[from] automerge::AutomergeError),

    /// A network I/O error occurred.
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),

    /// The daemon endpoint is not available (not running, crashed, or permission issue).
    #[error("{message}")]
    DaemonUnavailable {
        message: String,
        #[source]
        source: std::io::Error,
    },

    /// The sync task has stopped (channels closed).
    #[error("Disconnected from sync task")]
    Disconnected,

    /// A daemon protocol error.
    #[error("Protocol error: {0}")]
    Protocol(String),

    /// The daemon refused this attach because the notebook is gone (no resident
    /// room and no recoverable doc). Distinct from a transient `Protocol` error
    /// so callers (e.g. the MCP rejoin) can treat it as definitive — clear the
    /// session rather than retry.
    #[error("{0}")]
    NotebookUnavailable(String),

    /// A blob upload failed before bytes were published.
    #[error("Blob upload failed: {0:?}")]
    BlobUpload(BlobUploadErrorKind),

    /// Connection timed out.
    #[error("Connection timed out")]
    Timeout,

    /// A cell was not found in the document.
    #[error("Cell not found: {0}")]
    CellNotFound(String),

    /// Serialization/deserialization error.
    #[error("Serialization error: {0}")]
    Serialization(String),

    /// Runtime state document setup or mutation failed.
    #[error("Runtime state error: {0}")]
    RuntimeState(#[from] runtime_doc::RuntimeStateError),

    /// Comments document setup or mutation failed.
    #[error("Comments error: {0}")]
    Comments(#[from] comments_doc::CommentsDocError),
}

impl From<serde_json::Error> for SyncError {
    fn from(e: serde_json::Error) -> Self {
        SyncError::Serialization(e.to_string())
    }
}
