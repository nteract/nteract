//! The replaceable model side of the prompt agent.
//!
//! A [`ModelBackend`] turns one [`PromptRequest`] into a stream of answer
//! text. The runner ([`super::runner`]) owns everything else: claiming work,
//! Stop, output projection and terminal status.

use futures::future::BoxFuture;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

/// One model call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PromptRequest {
    /// System prompt.
    pub system: String,
    /// The full user message: the `<notebook>` context followed by the prompt
    /// text, exactly as the coordinator stored it in the context blob.
    pub input: String,
}

/// Cooperative stop signals for one run.
///
/// The first Stop cancels `interrupt` (a backend should end its turn and
/// report what it has); a second Stop cancels `kill` (a backend must stop
/// immediately).
#[derive(Debug, Clone, Default)]
pub(crate) struct CancelTokens {
    pub interrupt: CancellationToken,
    pub kill: CancellationToken,
}

impl CancelTokens {
    /// Whether Stop was requested at least once.
    pub fn stop_requested(&self) -> bool {
        self.interrupt.is_cancelled() || self.kill.is_cancelled()
    }
}

/// A model backend. Implementations must be cancel-safe: dropping the future
/// returned by `run` must release every resource (child processes included).
pub(crate) trait ModelBackend: Send + Sync {
    /// Run one request, sending answer text as it arrives. Deltas
    /// concatenate; a backend that streams several text blocks puts the
    /// separator (a blank line) into the deltas. `Ok` means the model
    /// finished (or stopped after a cancel request); `Err` is a user-facing
    /// failure, and any text sent before it is partial.
    fn run(
        &self,
        req: PromptRequest,
        deltas: mpsc::Sender<String>,
        cancel: CancelTokens,
    ) -> BoxFuture<'_, Result<(), String>>;
}
