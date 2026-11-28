//! Scripted backend for tests.

use std::sync::{Arc, Mutex};

use futures::future::BoxFuture;
use tokio::sync::mpsc;

use super::backend::{CancelTokens, ModelBackend, PromptRequest};

/// One step of a scripted run.
#[derive(Debug, Clone)]
pub(crate) enum Step {
    Text(&'static str),
    /// Wait until the first Stop (interrupt), then end the run as stopped.
    UntilInterrupt,
    /// Wait until the second Stop (kill).
    UntilKill,
    /// End the run with this failure.
    Fail(&'static str),
}

/// Plays `steps`, then finishes (unless a step failed the run).
#[derive(Clone)]
pub(crate) struct FakeBackend {
    steps: Vec<Step>,
    requests: Arc<Mutex<Vec<PromptRequest>>>,
}

impl FakeBackend {
    pub(crate) fn new(steps: Vec<Step>) -> Self {
        Self {
            steps,
            requests: Arc::default(),
        }
    }

    pub(crate) fn requests(&self) -> Vec<PromptRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl ModelBackend for FakeBackend {
    fn run(
        &self,
        req: PromptRequest,
        deltas: mpsc::Sender<String>,
        cancel: CancelTokens,
    ) -> BoxFuture<'_, Result<(), String>> {
        self.requests.lock().unwrap().push(req);
        let steps = self.steps.clone();
        Box::pin(async move {
            for step in steps {
                match step {
                    Step::Text(text) => {
                        let _ = deltas.send(text.into()).await;
                    }
                    Step::UntilInterrupt => {
                        cancel.interrupt.cancelled().await;
                        break;
                    }
                    Step::UntilKill => {
                        cancel.kill.cancelled().await;
                        break;
                    }
                    Step::Fail(message) => return Err(message.into()),
                }
            }
            Ok(())
        })
    }
}
