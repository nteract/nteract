use automerge::AutomergeError;

#[derive(Debug, thiserror::Error)]
pub enum RuntimeStateError {
    #[error("scaffold map '{0}' missing; doc may be corrupt")]
    MissingScaffold(&'static str),
    #[error("env progress phase must serialize as an object")]
    InvalidProgressShape,
    #[error("automerge: {0}")]
    Automerge(#[from] AutomergeError),
    #[error("automerge recovery: {0}")]
    AutomergeRecovery(#[from] automerge_recovery::AutomergeOperationError),
    #[error("RuntimeStateDoc mutex poisoned")]
    LockPoisoned,
}
