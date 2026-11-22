//! The per-room prompt coordinator task.
//!
//! Owns one [`PromptState`] per tracked prompt execution and drives it with
//! [`transition`]: it feeds in events (messages, RuntimeStateDoc changes) and
//! runs the returned effects at its edge. Each pass over the runs
//! (`scan`) first finalizes terminal runs and only then dispatches waiting
//! ones, so a prompt below another prompt sees that prompt's finished answer
//! cells and not its placeholder.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use tokio::sync::{broadcast, mpsc};
use tracing::{debug, info, warn};

use super::accept::waiting_on;
use super::answer;
use super::context::build_context;
use super::machine::{transition, Effect, PromptEvent, PromptState};
use super::{prompt_error_manifest, AgentEnsurer, PromptCoordinatorMsg};
use crate::notebook_sync_server::NotebookRoom;
use crate::task_supervisor::{spawn_supervised, PanicInfo};

struct Run {
    prompt_cell_id: String,
    state: PromptState,
}

struct Coordinator {
    room: Arc<NotebookRoom>,
    ensurer: AgentEnsurer,
    weak_tx: mpsc::WeakUnboundedSender<PromptCoordinatorMsg>,
    runs: HashMap<String, Run>,
    /// `(prompt_cell_id, execution_id)` of runs whose finalize failed. They
    /// are retried on every scan so the placeholder does not stay "streaming".
    unfinalized: Vec<(String, String)>,
}

pub(super) fn spawn(
    room: Arc<NotebookRoom>,
    ensurer: AgentEnsurer,
    rx: mpsc::UnboundedReceiver<PromptCoordinatorMsg>,
    weak_tx: mpsc::WeakUnboundedSender<PromptCoordinatorMsg>,
) {
    let coordinator = Coordinator {
        room,
        ensurer,
        weak_tx,
        runs: HashMap::new(),
        unfinalized: Vec::new(),
    };
    spawn_supervised("prompt-coordinator", coordinator.run(rx), |_| {});
}

/// True when the execution is terminal or no longer exists.
fn execution_ended(sd: &runtime_doc::RuntimeStateDoc, execution_id: &str) -> bool {
    sd.get_execution(execution_id)
        .is_none_or(|execution| execution.is_terminal())
}

/// Record a dispatch failure on the execution: an error output the prompt
/// cell header can show (R10) and the `error` status. Does nothing when the
/// execution already ended.
fn fail_execution(room: &NotebookRoom, execution_id: &str, message: &str) {
    warn!("[prompt-cells] Prompt {execution_id} failed: {message}");
    let result = room.state.with_doc(|sd| {
        if execution_ended(sd, execution_id) {
            return Ok(());
        }
        sd.append_output(execution_id, &prompt_error_manifest(message))?;
        sd.set_execution_done(execution_id, false)
    });
    if let Err(error) = result {
        warn!("[prompt-cells] Could not record failure of {execution_id}: {error}");
    }
}

/// Build the context, store it on the execution (which makes it runnable for
/// the agent), then make sure an agent runs. The context comes first so an
/// agent that is already up sees the work at once; if no agent can be started
/// the caller fails the execution.
async fn dispatch(
    room: &Arc<NotebookRoom>,
    ensurer: &AgentEnsurer,
    execution_id: &str,
    prompt_cell_id: &str,
) -> Result<(), String> {
    let context = build_context(room, prompt_cell_id).await?;
    let hash = room
        .blob_store
        .put(context.as_bytes(), "text/plain")
        .await
        .map_err(|error| format!("Could not store the prompt context: {error}"))?;
    let queued = room
        .state
        .with_doc(|sd| {
            // Ended or stopped while the context was being built: do not make
            // it runnable. Until the context is written the daemon is the
            // only writer of its status, so a stopped run is cancelled here.
            // Status check and context are one step.
            let Some(execution) = sd.get_execution(execution_id) else {
                return Ok(false);
            };
            if execution.status != "queued" {
                return Ok(false);
            }
            if execution.stop_requested > 0 {
                sd.set_execution_cancelled(execution_id)?;
                return Ok(false);
            }
            sd.set_execution_context(execution_id, &hash)?;
            Ok(true)
        })
        .map_err(|error| format!("Could not dispatch the prompt: {error}"))?;
    if !queued {
        debug!("[prompt-cells] {execution_id} ended before dispatch");
        return Ok(());
    }
    debug!(
        "[prompt-cells] Dispatched {execution_id} ({} chars of context)",
        context.chars().count()
    );
    ensurer(Arc::clone(room)).await
}

/// Finalize every answer placeholder whose execution is terminal or missing
/// (a stuck "streaming" cell, for example after a daemon restart or an agent
/// teardown mid-stream): partial text becomes answer cells, an empty
/// placeholder is deleted. Returns the placeholders whose execution is still
/// live, as `(prompt_cell_id, execution_id, execution)`.
///
/// A plain async function (no coordinator task needed) so room teardown can
/// run it after the coordinator's channel was dropped.
pub(crate) async fn resolve_stale_placeholders(
    room: &NotebookRoom,
) -> Vec<(String, String, runtime_doc::ExecutionState)> {
    let cells = {
        let doc = room.doc.read().await;
        doc.get_cells()
    };
    let mut live = Vec::new();
    for (prompt_cell_id, execution_id) in answer::streaming_placeholders(&cells) {
        let execution = room
            .state
            .read(|sd| sd.get_execution(&execution_id))
            .ok()
            .flatten();
        match execution {
            Some(execution) if !execution.is_terminal() => {
                live.push((prompt_cell_id, execution_id, execution));
            }
            _ => {
                debug!("[prompt-cells] Sweeping stale placeholder of {execution_id}");
                finalize_run(room, &prompt_cell_id, &execution_id).await;
            }
        }
    }
    live
}

/// Finalize one run's placeholder. Returns false when it could not be
/// written.
async fn finalize_run(room: &NotebookRoom, prompt_cell_id: &str, execution_id: &str) -> bool {
    match answer::finalize(room, prompt_cell_id, execution_id).await {
        Ok(count) => {
            debug!("[prompt-cells] Wrote {count} answer cell(s) for {execution_id}");
            true
        }
        Err(error) => {
            warn!("[prompt-cells] Could not finalize {execution_id}: {error}");
            false
        }
    }
}

impl Coordinator {
    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<PromptCoordinatorMsg>) {
        info!(
            "[prompt-cells] Coordinator started for room {}",
            self.room.id
        );
        let mut state_rx = self.room.state.subscribe();
        self.sweep().await;
        self.scan().await;
        loop {
            tokio::select! {
                msg = rx.recv() => match msg {
                    Some(msg) => self.handle(msg).await,
                    None => break,
                },
                changed = state_rx.recv() => {
                    // Lagged: some notifications were dropped; the scan below
                    // re-reads everything anyway.
                    if matches!(changed, Err(broadcast::error::RecvError::Closed)) {
                        break;
                    }
                    while state_rx.try_recv().is_ok() {}
                }
            }
            self.scan().await;
        }
        info!(
            "[prompt-cells] Coordinator stopped for room {}",
            self.room.id
        );
    }

    /// At start-up, resolve answer placeholders no run owns (see
    /// [`resolve_stale_placeholders`]) and adopt every live one: an earlier
    /// coordinator may have died, or the request that started this one is
    /// being accepted right now. A run with its context was dispatched, so
    /// it is watched until it ends. One without is accepted again, waiting
    /// on what is active above it now (the same rule as at accept time), so
    /// a concurrent `Accepted` for it changes nothing.
    async fn sweep(&mut self) {
        let live = resolve_stale_placeholders(&self.room).await;
        let mut adopted = Vec::new();
        {
            let doc = self.room.doc.read().await;
            let cells = doc.get_cells();
            for (prompt_cell_id, execution_id, execution) in live {
                if self.runs.contains_key(&execution_id) {
                    continue;
                }
                let (state, effects) = if execution.context_blob.is_some() {
                    (PromptState::Dispatched, Vec::new())
                } else {
                    let waiting = cells
                        .iter()
                        .position(|cell| cell.id == prompt_cell_id)
                        .map(|index| waiting_on(&self.room, &doc, &cells, index))
                        .unwrap_or_default();
                    PromptState::accepted(waiting)
                };
                self.runs.insert(
                    execution_id.clone(),
                    Run {
                        prompt_cell_id: prompt_cell_id.clone(),
                        state,
                    },
                );
                adopted.push((execution_id, prompt_cell_id, effects));
            }
        }
        for (execution_id, prompt_cell_id, effects) in adopted {
            debug!("[prompt-cells] Adopted live prompt run {execution_id}");
            self.run_effects(&execution_id, &prompt_cell_id, effects)
                .await;
        }
    }

    async fn handle(&mut self, msg: PromptCoordinatorMsg) {
        match msg {
            PromptCoordinatorMsg::Accepted {
                execution_id,
                prompt_cell_id,
                waiting_on,
            } => {
                if self.runs.contains_key(&execution_id) {
                    return;
                }
                let (state, effects) = PromptState::accepted(waiting_on);
                self.runs.insert(
                    execution_id.clone(),
                    Run {
                        prompt_cell_id: prompt_cell_id.clone(),
                        state,
                    },
                );
                self.run_effects(&execution_id, &prompt_cell_id, effects)
                    .await;
            }
            PromptCoordinatorMsg::Dispatched {
                execution_id,
                result,
            } => {
                let event = match result {
                    Ok(()) => PromptEvent::DispatchSucceeded,
                    Err(error) => {
                        warn!("[prompt-cells] Dispatch of {execution_id} failed: {error}");
                        PromptEvent::DispatchFailed { error }
                    }
                };
                self.apply(&execution_id, event).await;
            }
        }
    }

    /// Observe the RuntimeStateDoc: finalize terminal runs first, then let
    /// waiting runs whose waiters finished dispatch. A waiter that is itself a
    /// tracked prompt run only counts as finished once it is finalized (its
    /// run is forgotten and its finalize did not fail), so a prompt below
    /// never dispatches between the earlier prompt's terminal status and its
    /// answer cells. A Stop needs no message: it ends the execution (or marks
    /// it), which shows up here.
    async fn scan(&mut self) {
        for (prompt_cell_id, execution_id) in std::mem::take(&mut self.unfinalized) {
            self.finalize(&prompt_cell_id, &execution_id).await;
        }
        if self.runs.is_empty() {
            return;
        }
        let terminal: Vec<String> = {
            let runs = &self.runs;
            self.room
                .state
                .read(|sd| {
                    runs.keys()
                        .filter(|eid| execution_ended(sd, eid))
                        .cloned()
                        .collect()
                })
                .unwrap_or_default()
        };
        for execution_id in terminal {
            self.apply(&execution_id, PromptEvent::OwnTerminal).await;
        }
        let settled: Vec<(String, BTreeSet<String>)> = {
            let runs = &self.runs;
            let unfinalized = &self.unfinalized;
            self.room
                .state
                .read(|sd| {
                    let mut settled = Vec::new();
                    for (eid, run) in runs {
                        let PromptState::Waiting { waiting_on } = &run.state else {
                            continue;
                        };
                        let done: BTreeSet<String> = waiting_on
                            .iter()
                            .filter(|waiter| {
                                execution_ended(sd, waiter)
                                    && !runs.contains_key(*waiter)
                                    && !unfinalized.iter().any(|(_, eid)| eid == *waiter)
                            })
                            .cloned()
                            .collect();
                        if !done.is_empty() {
                            settled.push((eid.clone(), done));
                        }
                    }
                    settled
                })
                .unwrap_or_default()
        };
        for (execution_id, done) in settled {
            self.apply(&execution_id, PromptEvent::WaitersSettled { settled: done })
                .await;
        }
    }

    /// Apply `event` to the run and run the effects it yields.
    async fn apply(&mut self, execution_id: &str, event: PromptEvent) {
        let Some(run) = self.runs.get_mut(execution_id) else {
            return;
        };
        let (next, effects) = transition(&run.state, event);
        let prompt_cell_id = run.prompt_cell_id.clone();
        if next.as_ref() != Some(&run.state) {
            debug!("[prompt-cells] {execution_id}: {:?} -> {next:?}", run.state);
        }
        match next {
            Some(state) => run.state = state,
            None => {
                self.runs.remove(execution_id);
            }
        }
        self.run_effects(execution_id, &prompt_cell_id, effects)
            .await;
    }

    async fn run_effects(
        &mut self,
        execution_id: &str,
        prompt_cell_id: &str,
        effects: Vec<Effect>,
    ) {
        for effect in effects {
            match effect {
                Effect::Dispatch => self.spawn_dispatch(execution_id, prompt_cell_id),
                Effect::FailExecution { error } => {
                    fail_execution(&self.room, execution_id, &error);
                }
                Effect::Finalize => self.finalize(prompt_cell_id, execution_id).await,
            }
        }
    }

    async fn finalize(&mut self, prompt_cell_id: &str, execution_id: &str) {
        if !finalize_run(&self.room, prompt_cell_id, execution_id).await {
            self.unfinalized
                .push((prompt_cell_id.to_string(), execution_id.to_string()));
        }
    }

    fn spawn_dispatch(&self, execution_id: &str, prompt_cell_id: &str) {
        let room = Arc::clone(&self.room);
        let ensurer = Arc::clone(&self.ensurer);
        let weak_tx = self.weak_tx.clone();
        let execution_id = execution_id.to_string();
        let prompt_cell_id = prompt_cell_id.to_string();
        let on_panic = {
            let weak_tx = weak_tx.clone();
            let execution_id = execution_id.clone();
            move |_: &PanicInfo| {
                report_dispatch(
                    &weak_tx,
                    execution_id,
                    Err("Internal error while starting the prompt".to_string()),
                );
            }
        };
        spawn_supervised(
            "prompt-dispatch",
            async move {
                let result = dispatch(&room, &ensurer, &execution_id, &prompt_cell_id).await;
                report_dispatch(&weak_tx, execution_id, result);
            },
            on_panic,
        );
    }
}

/// Tell the coordinator how a dispatch task ended (nothing to do when the
/// coordinator is already gone).
fn report_dispatch(
    weak_tx: &mpsc::WeakUnboundedSender<PromptCoordinatorMsg>,
    execution_id: String,
    result: Result<(), String>,
) {
    if let Some(tx) = weak_tx.upgrade() {
        let _ = tx.send(PromptCoordinatorMsg::Dispatched {
            execution_id,
            result,
        });
    }
}
