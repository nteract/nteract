use automerge::AutomergeError;

#[derive(Debug, thiserror::Error)]
pub enum CommentsDocError {
    #[error("comments_doc_id is required for CommentsDoc")]
    MissingCommentsDocId,
    #[error("invalid comments_doc_id: {0}")]
    InvalidCommentsDocId(String),
    #[error("comments_doc_id mismatch: expected {expected}, got {actual}")]
    CommentsDocIdMismatch { expected: String, actual: String },
    #[error("comments_doc_id has conflicting visible values")]
    CommentsDocIdConflict,
    #[error("scaffold map '{0}' missing; doc may be corrupt")]
    MissingScaffold(&'static str),
    #[error("comment thread not found: {0}")]
    ThreadNotFound(String),
    #[error("comment message not found: {thread_id}/{message_id}")]
    MessageNotFound {
        thread_id: String,
        message_id: String,
    },
    #[error("comment thread already exists: {0}")]
    ThreadAlreadyExists(String),
    #[error("comment message already exists: {thread_id}/{message_id}")]
    MessageAlreadyExists {
        thread_id: String,
        message_id: String,
    },
    #[error("unauthorized comment actor: {0}")]
    UnauthorizedActor(String),
    #[error("after_thread_id not found: {0}")]
    AfterThreadNotFound(String),
    #[error("after_message_id not found: {0}")]
    AfterMessageNotFound(String),
    #[error("invalid comment position: {0}")]
    InvalidPosition(String),
    #[error("automerge: {0}")]
    Automerge(#[from] AutomergeError),
    #[error("automerge recovery: {0}")]
    AutomergeRecovery(Box<automerge_recovery::AutomergeOperationError>),
    #[error("serde: {0}")]
    Serde(#[from] serde_json::Error),
    #[error("CommentsDoc mutex poisoned")]
    LockPoisoned,
}

impl From<automerge_recovery::AutomergeOperationError> for CommentsDocError {
    fn from(error: automerge_recovery::AutomergeOperationError) -> Self {
        Self::AutomergeRecovery(Box::new(error))
    }
}
