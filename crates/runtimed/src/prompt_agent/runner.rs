//! Runs dispatched prompt executions, one at a time.
//!
//! [`PromptWorker`] claims the first runnable prompt execution (queued, with
//! a context, not stopped; by `seq`), marks it running and runs it in a task.
//! The task streams the [`ModelBackend`]'s text into one markdown output and
//! then writes the final output before the terminal status. Once an
//! execution has its context, the agent is the only writer of the status
//! that leaves `queued`: on every document change (also while a run is
//! going) the worker cancels stopped executions it has not claimed and
//! applies the running execution's `stop_requested` count. The worker only
//! writes prompt-capability executions; it never touches kernel state, the
//! kernel queue or creates executions.

use std::panic::AssertUnwindSafe;
use std::pin::pin;
use std::sync::Arc;

use futures::FutureExt;
use runtime_doc::{RuntimeStateDoc, RuntimeStateError, RuntimeStateHandle};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::sleep_until;
use tracing::{debug, warn};

use super::backend::{CancelTokens, ModelBackend, PromptRequest};
use super::projector::OutputProjector;
use crate::blob_store::BlobStore;
use crate::prompt_cells::{prompt_error_manifest, EXPLORE_SYSTEM_PROMPT};

/// Text deltas buffered between a backend and the projector.
const TEXT_CHANNEL_CAPACITY: usize = 64;

struct CurrentRun {
    execution_id: String,
    cancel: CancelTokens,
    task: JoinHandle<()>,
}

/// Picks up and stops the prompt agent's runs.
pub(crate) struct PromptWorker {
    state: RuntimeStateHandle,
    blob_store: Arc<BlobStore>,
    backend: Arc<dyn ModelBackend>,
    current: Option<CurrentRun>,
    done_tx: mpsc::UnboundedSender<String>,
}

impl PromptWorker {
    /// Returns the worker and a receiver that yields the execution id of
    /// each run when it ends. Call [`Self::run_finished`] for each.
    pub fn new(
        state: RuntimeStateHandle,
        blob_store: Arc<BlobStore>,
        backend: Arc<dyn ModelBackend>,
    ) -> (Self, mpsc::UnboundedReceiver<String>) {
        let (done_tx, done_rx) = mpsc::unbounded_channel();
        (
            Self {
                state,
                blob_store,
                backend,
                current: None,
                done_tx,
            },
            done_rx,
        )
    }

    /// Cancel stopped dispatched executions, then apply a Stop to the
    /// current run, or start the next dispatched execution if nothing runs.
    /// Call after every RuntimeStateDoc change.
    pub fn maybe_start(&mut self) {
        if let Err(err) = self.state.with_doc(cancel_stopped) {
            warn!("[prompt-agent] Failed to cancel stopped prompts: {err}");
        }
        if self.current.is_some() {
            self.apply_stop();
            return;
        }
        let claim = self.state.with_doc(claim_next);
        let execution_id = match claim {
            Ok(Some(execution_id)) => execution_id,
            Ok(None) => return,
            Err(err) => {
                warn!("[prompt-agent] Failed to claim the next prompt: {err}");
                return;
            }
        };
        debug!("[prompt-agent] Starting prompt execution_id={execution_id}");

        let cancel = CancelTokens::default();
        let state = self.state.clone();
        let blob_store = Arc::clone(&self.blob_store);
        let backend = Arc::clone(&self.backend);
        let done_tx = self.done_tx.clone();
        let task = {
            let execution_id = execution_id.clone();
            let cancel = cancel.clone();
            tokio::spawn(async move {
                let run =
                    run_execution(&state, &blob_store, backend.as_ref(), &execution_id, cancel);
                if AssertUnwindSafe(run).catch_unwind().await.is_err() {
                    warn!("[prompt-agent] Prompt run panicked execution_id={execution_id}");
                    if !already_terminal(&state, &execution_id) {
                        write_error(
                            &state,
                            &execution_id,
                            "The prompt agent crashed while running this prompt.",
                        );
                    }
                    release(&state, &execution_id, false);
                }
                let _ = done_tx.send(execution_id);
            })
        };
        self.current = Some(CurrentRun {
            execution_id,
            cancel,
            task,
        });
    }

    /// Stop is state written by the daemon: the first Stop on the running
    /// execution interrupts it (partial text is kept), a second one kills
    /// it. An execution that already ended elsewhere (agent teardown) is
    /// killed outright: its output is discarded anyway (see
    /// [`already_terminal`]). Only the current run's own execution is read,
    /// so a Stop never reaches another prompt.
    fn apply_stop(&self) {
        let Some(run) = &self.current else {
            return;
        };
        let execution = self
            .state
            .read(|sd| sd.get_execution(&run.execution_id))
            .ok()
            .flatten();
        let (interrupt, kill) = match &execution {
            Some(execution) if execution.is_terminal() => (true, true),
            Some(execution) => (execution.stop_requested >= 1, execution.stop_requested >= 2),
            None => (false, false),
        };
        if interrupt && !run.cancel.interrupt.is_cancelled() {
            debug!(
                "[prompt-agent] Interrupting execution_id={}",
                run.execution_id
            );
            run.cancel.interrupt.cancel();
        }
        if kill && !run.cancel.kill.is_cancelled() {
            debug!("[prompt-agent] Killing execution_id={}", run.execution_id);
            run.cancel.kill.cancel();
        }
    }

    /// A run ended. Clears the slot and starts the next prompt.
    pub fn run_finished(&mut self, execution_id: &str) {
        if self
            .current
            .as_ref()
            .is_some_and(|run| run.execution_id == execution_id)
        {
            self.current = None;
        }
        self.maybe_start();
    }

    /// Abort the running prompt without writing anything (process exit; the
    /// coordinator resolves the execution when the agent disconnects).
    pub fn shutdown(&mut self) {
        if let Some(run) = self.current.take() {
            run.cancel.kill.cancel();
            run.task.abort();
        }
    }
}

/// Cancel every dispatched (has a context) prompt execution that is still
/// queued and has a Stop. It never started, so there is nothing to keep; the
/// coordinator removes its placeholder.
fn cancel_stopped(sd: &mut RuntimeStateDoc) -> Result<(), RuntimeStateError> {
    for (execution_id, execution) in sd.get_prompt_executions("queued") {
        if execution.context_blob.is_some() && execution.stop_requested > 0 {
            debug!("[prompt-agent] Cancelling stopped prompt execution_id={execution_id}");
            sd.set_execution_cancelled(&execution_id)?;
        }
    }
    Ok(())
}

/// Claim the next runnable prompt execution (status running) in one
/// document step. Runnable: queued, dispatched (has a context) and not
/// stopped, in `seq` order. Called only while nothing runs here, so a prompt
/// execution still `running` was left by a previous agent and is resolved as
/// an error first.
fn claim_next(sd: &mut RuntimeStateDoc) -> Result<Option<String>, RuntimeStateError> {
    for (stale, _) in sd.get_prompt_executions("running") {
        warn!("[prompt-agent] Resolving stale running prompt execution_id={stale}");
        sd.set_execution_done(&stale, false)?;
    }
    let next = sd
        .get_prompt_executions("queued")
        .into_iter()
        .find(|(_, execution)| execution.context_blob.is_some() && execution.stop_requested == 0);
    let Some((execution_id, _)) = next else {
        return Ok(None);
    };
    sd.set_execution_running(&execution_id)?;
    Ok(Some(execution_id))
}

/// True when the execution already has a terminal status in this agent's
/// copy of the document: the daemon ended it (agent teardown). Terminal
/// executions are final, so the agent then writes neither output nor status
/// and only frees its slot.
fn already_terminal(state: &RuntimeStateHandle, execution_id: &str) -> bool {
    state
        .read(|sd| sd.get_execution(execution_id))
        .ok()
        .flatten()
        .is_some_and(|execution| execution.is_terminal())
}

/// Terminal status. Callers write the final output BEFORE calling this. A
/// status the daemon already made terminal is never overwritten.
fn release(state: &RuntimeStateHandle, execution_id: &str, success: bool) {
    let result = state.with_doc(|sd| {
        if sd
            .get_execution(execution_id)
            .is_some_and(|execution| execution.is_terminal())
        {
            return Ok(());
        }
        sd.set_execution_done(execution_id, success)
    });
    if let Err(err) = result {
        warn!("[prompt-agent] Failed to finish execution_id={execution_id}: {err}");
    }
}

/// Append the `PromptError` output of a run that failed without text (R10).
fn write_error(state: &RuntimeStateHandle, execution_id: &str, message: &str) {
    let manifest = prompt_error_manifest(message);
    if let Err(err) = state.with_doc(|sd| sd.append_output(execution_id, &manifest).map(|_| ())) {
        warn!("[prompt-agent] Failed to write the error of execution_id={execution_id}: {err}");
    }
}

async fn run_execution(
    state: &RuntimeStateHandle,
    blob_store: &Arc<BlobStore>,
    backend: &dyn ModelBackend,
    execution_id: &str,
    cancel: CancelTokens,
) {
    let mut projector = OutputProjector::new(state.clone(), Arc::clone(blob_store), execution_id);

    let input = match load_context(state, blob_store, execution_id).await {
        Ok(input) => input,
        Err(message) => {
            warn!("[prompt-agent] {message} execution_id={execution_id}");
            if !already_terminal(state, execution_id) {
                write_error(state, execution_id, &message);
            }
            release(state, execution_id, false);
            return;
        }
    };

    let request = PromptRequest {
        system: EXPLORE_SYSTEM_PROMPT.to_string(),
        input,
    };
    let (text_tx, mut text_rx) = mpsc::channel(TEXT_CHANNEL_CAPACITY);
    let mut backend_run = pin!(backend.run(request, text_tx, cancel.clone()));
    let mut backend_result = None;

    loop {
        let flush_at = projector.flush_deadline();
        tokio::select! {
            biased;
            delta = text_rx.recv() => match delta {
                Some(delta) => projector.push(&delta),
                None => break,
            },
            result = &mut backend_run, if backend_result.is_none() => {
                backend_result = Some(result);
            }
            _ = async {
                match flush_at {
                    Some(at) => sleep_until(at).await,
                    None => std::future::pending().await,
                }
            } => {
                projector.flush_if_due().await;
            }
        }
    }
    let backend_result = match backend_result {
        Some(result) => result,
        None => backend_run.await,
    };

    // Ended elsewhere while this run was going (agent teardown): the
    // execution is final, so write nothing.
    if already_terminal(state, execution_id) {
        debug!("[prompt-agent] Execution already ended, discarding the run execution_id={execution_id}");
        return;
    }

    let stopped = cancel.stop_requested();
    let has_text = !projector.text().trim().is_empty();
    let success = match backend_result {
        // A stopped run keeps its partial text and ends as an error (R9).
        Ok(()) if stopped => {
            projector.finish(None, true).await;
            false
        }
        Ok(()) if has_text => {
            projector.finish(None, false).await;
            true
        }
        // Failure after the user stopped: keep what arrived, as a stop.
        Err(_) if stopped && !projector.text().is_empty() => {
            projector.finish(None, true).await;
            false
        }
        // Failure with partial text keeps the text and appends the reason.
        Err(message) if has_text => {
            let text = format!("{}\n\n**Agent error:** {message}", projector.text());
            projector.finish(Some(&text), false).await;
            false
        }
        // No text: one error output (R10).
        Ok(()) => {
            write_error(state, execution_id, "The model returned no answer.");
            false
        }
        Err(message) => {
            write_error(state, execution_id, &message);
            false
        }
    };
    release(state, execution_id, success);
    debug!(
        "[prompt-agent] Prompt finished execution_id={execution_id} success={success} stopped={stopped} writes={}",
        projector.writes()
    );
}

async fn load_context(
    state: &RuntimeStateHandle,
    blob_store: &BlobStore,
    execution_id: &str,
) -> Result<String, String> {
    let hash = state
        .read(|sd| sd.get_execution(execution_id).and_then(|e| e.context_blob))
        .map_err(|e| format!("Could not read the prompt: {e}"))?
        .ok_or_else(|| "The prompt has no context to send.".to_string())?;
    let bytes = blob_store
        .get(&hash)
        .await
        .map_err(|e| format!("Could not read the prompt context: {e}"))?
        .ok_or_else(|| "The prompt context is missing from the blob store.".to_string())?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
