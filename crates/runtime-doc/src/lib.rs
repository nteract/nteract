mod doc;
pub mod error;
mod handle;
mod projection;
mod types;

pub use doc::*;
pub use error::RuntimeStateError;
pub use handle::RuntimeStateHandle;
pub use projection::{diff_executions, ExecutionTransition, ExecutionTransitionKind};
pub use types::*;

/// Extract a human-readable message from a panic payload.
pub(crate) fn panic_payload_to_string(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else if let Some(s) = payload.downcast_ref::<&str>() {
        s.to_string()
    } else {
        "unknown panic".to_string()
    }
}
