//! Bounded notebook change observation over the existing sync peer.
//!
//! An owner follows an active or parked session. Readers contain snapshots and
//! watch receivers, never a `DocHandle` or sync command sender. Dropping the
//! owner invalidates readers even if a client keeps a pending wait alive.

use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use comments_doc::CommentsProjection;
use notebook_sync::status::{ConnectionState, SyncStatus};
use notebook_sync::{DocHandle, NotebookSnapshot, SyncError};
use runtime_doc::RuntimeState;
use serde::Serialize;
use tokio::sync::watch;

const RETAINED_BATCHES: usize = 256;
const COALESCE: Duration = Duration::from_millis(100);

#[derive(Clone, Debug)]
pub struct ObservedNotebook {
    pub notebook: Arc<NotebookSnapshot>,
    pub runtime: Arc<RuntimeState>,
    pub comments: Option<Arc<CommentsProjection>>,
    pub status: SyncStatus,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeKind {
    Cells,
    NotebookMetadata,
    Runtime,
    Executions,
    Outputs,
    Comments,
    Status,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct NotebookChanges {
    pub kinds: BTreeSet<ChangeKind>,
    pub cell_ids: BTreeSet<String>,
    pub execution_ids: BTreeSet<String>,
    pub comment_thread_ids: BTreeSet<String>,
}

impl NotebookChanges {
    fn merge(&mut self, other: &Self) {
        self.kinds.extend(&other.kinds);
        self.cell_ids.extend(other.cell_ids.iter().cloned());
        self.execution_ids
            .extend(other.execution_ids.iter().cloned());
        self.comment_thread_ids
            .extend(other.comment_thread_ids.iter().cloned());
    }

    fn between(before: &ObservedNotebook, after: &ObservedNotebook) -> Self {
        let mut changes = Self::default();
        if before.notebook.cells.iter().map(|cell| &cell.id).ne(after
            .notebook
            .cells
            .iter()
            .map(|cell| &cell.id))
        {
            changes.kinds.insert(ChangeKind::Cells);
        }
        let old_cells: BTreeMap<_, _> = before
            .notebook
            .cells
            .iter()
            .map(|cell| (&cell.id, cell))
            .collect();
        let new_cells: BTreeMap<_, _> = after
            .notebook
            .cells
            .iter()
            .map(|cell| (&cell.id, cell))
            .collect();
        for id in old_cells.keys().chain(new_cells.keys()) {
            if old_cells.get(id) != new_cells.get(id) {
                changes.cell_ids.insert((*id).clone());
                changes.kinds.insert(ChangeKind::Cells);
            }
        }
        for id in before
            .notebook
            .execution_pointers
            .keys()
            .chain(after.notebook.execution_pointers.keys())
        {
            let old = before.notebook.execution_pointers.get(id);
            let new = after.notebook.execution_pointers.get(id);
            if old != new {
                changes.kinds.insert(ChangeKind::Executions);
                changes.kinds.insert(ChangeKind::Outputs);
                changes.cell_ids.insert(id.clone());
                changes
                    .execution_ids
                    .extend(old.into_iter().chain(new).cloned());
            }
        }
        if before.notebook.notebook_metadata != after.notebook.notebook_metadata {
            changes.kinds.insert(ChangeKind::NotebookMetadata);
        }
        if before.runtime != after.runtime {
            changes.kinds.insert(ChangeKind::Runtime);
            for id in before
                .runtime
                .executions
                .keys()
                .chain(after.runtime.executions.keys())
            {
                let old = before.runtime.executions.get(id);
                let new = after.runtime.executions.get(id);
                if old != new {
                    changes.kinds.insert(ChangeKind::Executions);
                    changes.execution_ids.insert(id.clone());
                    if old.map(|execution| &execution.outputs)
                        != new.map(|execution| &execution.outputs)
                    {
                        changes.kinds.insert(ChangeKind::Outputs);
                    }
                    for execution in old.into_iter().chain(new) {
                        if let Some(cell_id) = &execution.cell_id {
                            changes.cell_ids.insert(cell_id.clone());
                        }
                    }
                }
            }
        }
        if before.comments != after.comments {
            changes.kinds.insert(ChangeKind::Comments);
            let old: BTreeMap<_, _> = before
                .comments
                .iter()
                .flat_map(|projection| &projection.threads)
                .map(|thread| (&thread.id, thread))
                .collect();
            let new: BTreeMap<_, _> = after
                .comments
                .iter()
                .flat_map(|projection| &projection.threads)
                .map(|thread| (&thread.id, thread))
                .collect();
            for id in old.keys().chain(new.keys()) {
                if old.get(id) != new.get(id) {
                    changes.comment_thread_ids.insert((*id).clone());
                }
            }
        }
        if before.status != after.status {
            changes.kinds.insert(ChangeKind::Status);
        }
        changes
    }
}

struct Inputs {
    notebook: watch::Receiver<NotebookSnapshot>,
    runtime: watch::Receiver<RuntimeState>,
    comments: watch::Receiver<Option<Arc<CommentsProjection>>>,
    status: watch::Receiver<SyncStatus>,
}

impl Inputs {
    fn current(&mut self, previous: Option<&ObservedNotebook>) -> ObservedNotebook {
        let notebook = match previous {
            Some(previous) if !self.notebook.has_changed().unwrap_or(true) => {
                previous.notebook.clone()
            }
            _ => Arc::new(self.notebook.borrow_and_update().clone()),
        };
        let runtime = match previous {
            Some(previous) if !self.runtime.has_changed().unwrap_or(true) => {
                previous.runtime.clone()
            }
            _ => Arc::new(self.runtime.borrow_and_update().clone()),
        };
        let mut status = self.status.borrow_and_update().clone();
        if self.status.has_changed().is_err() {
            status.connection = ConnectionState::Disconnected;
        }
        ObservedNotebook {
            notebook,
            runtime,
            comments: self.comments.borrow_and_update().clone(),
            status,
        }
    }
}

struct Journal {
    generation: String,
    sequence: u64,
    view: ObservedNotebook,
    history: VecDeque<(u64, NotebookChanges)>,
    released: bool,
}

impl Journal {
    fn cursor(&self) -> String {
        format!("{}:{}", self.generation, self.sequence)
    }

    fn record(&mut self, next: ObservedNotebook) -> bool {
        let changes = NotebookChanges::between(&self.view, &next);
        self.view = next;
        if changes.kinds.is_empty() {
            return false;
        }
        self.sequence = match self.sequence.checked_add(1) {
            Some(sequence) => sequence,
            None => {
                self.generation = uuid::Uuid::new_v4().to_string();
                self.history.clear();
                1
            }
        };
        self.history.push_back((self.sequence, changes));
        if self.history.len() > RETAINED_BATCHES {
            self.history.pop_front();
        }
        true
    }

    fn since(&self, after: Option<&str>) -> ChangeRead {
        let mut result = ChangeRead {
            outcome: ChangeOutcome::Baseline,
            cursor: self.cursor(),
            changes: NotebookChanges::default(),
            snapshot: self.view.clone(),
        };
        if self.released || self.view.status.connection == ConnectionState::Disconnected {
            result.outcome = ChangeOutcome::Unavailable;
            return result;
        }
        let Some(after) = after else {
            return result;
        };
        let parsed = after.rsplit_once(':').and_then(|(generation, sequence)| {
            (generation == self.generation)
                .then_some(sequence)?
                .parse::<u64>()
                .ok()
        });
        let oldest = self
            .history
            .front()
            .map_or(self.sequence, |(sequence, _)| sequence - 1);
        let Some(sequence) =
            parsed.filter(|sequence| *sequence >= oldest && *sequence <= self.sequence)
        else {
            result.outcome = ChangeOutcome::ResyncRequired;
            return result;
        };
        result.outcome = if sequence == self.sequence {
            ChangeOutcome::Unchanged
        } else {
            ChangeOutcome::Changed
        };
        for (_, changes) in self.history.iter().filter(|(entry, _)| *entry > sequence) {
            result.changes.merge(changes);
        }
        result
    }
}

struct State {
    inputs: Inputs,
    journal: Journal,
    changed: watch::Sender<u64>,
}

/// Own this alongside a session; move it when parking or resuming the session.
pub struct ObservationOwner {
    reader: ObservationReader,
    task: tokio::task::JoinHandle<()>,
}

#[derive(Clone)]
pub struct ObservationReader {
    state: Arc<Mutex<State>>,
    changed: watch::Receiver<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChangeOutcome {
    Baseline,
    Changed,
    Unchanged,
    TimedOut,
    ResyncRequired,
    Unavailable,
}

#[derive(Clone, Debug)]
pub struct ChangeRead {
    pub outcome: ChangeOutcome,
    pub cursor: String,
    pub changes: NotebookChanges,
    /// Snapshot paired with this cursor. Resource reads must use this snapshot
    /// rather than independently sampling a later document version.
    pub snapshot: ObservedNotebook,
}

impl ObservationOwner {
    /// Requires a Tokio runtime. Subscribe to every source before capturing
    /// the baseline, so a concurrent local/remote edit cannot disappear.
    pub fn new(handle: &DocHandle) -> Result<Self, Box<SyncError>> {
        Self::from_inputs(Inputs {
            notebook: handle.subscribe(),
            runtime: handle.subscribe_runtime_state(),
            comments: handle.subscribe_comments()?,
            status: handle.subscribe_status(),
        })
    }

    fn from_inputs(mut inputs: Inputs) -> Result<Self, Box<SyncError>> {
        let view = inputs.current(None);
        let journal = Journal {
            generation: uuid::Uuid::new_v4().to_string(),
            sequence: 0,
            view,
            history: VecDeque::new(),
            released: false,
        };
        let mut notebook = inputs.notebook.clone();
        let mut runtime = inputs.runtime.clone();
        let mut comments = inputs.comments.clone();
        let mut status = inputs.status.clone();
        let (changed, receiver) = watch::channel(0);
        let reader = ObservationReader {
            state: Arc::new(Mutex::new(State {
                inputs,
                journal,
                changed,
            })),
            changed: receiver,
        };
        let worker = reader.clone();
        let task = tokio::spawn(async move {
            loop {
                let closed = tokio::select! {
                    result = notebook.changed() => result.is_err(),
                    result = runtime.changed() => result.is_err(),
                    result = comments.changed() => result.is_err(),
                    result = status.changed() => result.is_err(),
                };
                if closed {
                    worker.invalidate();
                    return;
                }
                tokio::time::sleep(COALESCE).await;
                // A closed channel is observed on the next iteration. The
                // public read path also sees disconnected status immediately.
                if worker.read(None).is_err() {
                    return;
                }
            }
        });
        Ok(Self { reader, task })
    }

    pub fn reader(&self) -> ObservationReader {
        self.reader.clone()
    }
}

impl Drop for ObservationOwner {
    fn drop(&mut self) {
        self.reader.invalidate();
        self.task.abort();
    }
}

impl ObservationReader {
    pub(crate) fn same_attachment(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.state, &other.state)
    }

    pub fn execution_watcher(
        &self,
        execution_id: &str,
    ) -> Result<notebook_sync::execution_watch::ExecutionWatcher, Box<SyncError>> {
        let state = self.state.lock().map_err(|_| SyncError::LockPoisoned)?;
        let cell_id = state
            .inputs
            .runtime
            .borrow()
            .executions
            .get(execution_id)
            .and_then(|execution| execution.cell_id.clone())
            .unwrap_or_default();
        Ok(
            notebook_sync::execution_watch::ExecutionWatcher::from_receiver(
                state.inputs.runtime.clone(),
                cell_id,
                execution_id,
            ),
        )
    }

    pub fn read(&self, after: Option<&str>) -> Result<ChangeRead, Box<SyncError>> {
        let mut state = self.state.lock().map_err(|_| SyncError::LockPoisoned)?;
        if !state.journal.released {
            let State {
                inputs,
                journal,
                changed,
            } = &mut *state;
            let view = inputs.current(Some(&journal.view));
            if journal.record(view) {
                changed.send_replace(journal.sequence);
            }
        }
        Ok(state.journal.since(after))
    }

    fn invalidate(&self) {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        state.journal.released = true;
        state
            .changed
            .send_modify(|sequence| *sequence = sequence.wrapping_add(1));
    }

    /// A cancellation only drops this future; it cannot send kernel requests.
    pub async fn wait(&self, after: &str, timeout: Duration) -> Result<ChangeRead, Box<SyncError>> {
        let mut changed = self.changed.clone();
        let ready = tokio::time::timeout(timeout, async {
            loop {
                changed.borrow_and_update();
                let result = self.read(Some(after))?;
                if result.outcome != ChangeOutcome::Unchanged {
                    return Ok(result);
                }
                if changed.changed().await.is_err() {
                    self.invalidate();
                }
            }
        })
        .await;
        match ready {
            Ok(result) => result,
            Err(_) => {
                let mut result = self.read(Some(after))?;
                if result.outcome == ChangeOutcome::Unchanged {
                    result.outcome = ChangeOutcome::TimedOut;
                }
                Ok(result)
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) struct Fixture {
        pub(crate) owner: ObservationOwner,
        pub(crate) notebook: watch::Sender<NotebookSnapshot>,
        pub(crate) runtime: watch::Sender<RuntimeState>,
        _comments: watch::Sender<Option<Arc<CommentsProjection>>>,
        _status: watch::Sender<SyncStatus>,
    }

    pub(crate) fn fixture() -> Fixture {
        let (notebook, notebook_rx) = watch::channel(NotebookSnapshot::empty());
        let (runtime, runtime_rx) = watch::channel(RuntimeState::default());
        let (comments, comments_rx) = watch::channel(None);
        let (status, status_rx) = watch::channel(SyncStatus::connected_pending());
        let owner = ObservationOwner::from_inputs(Inputs {
            notebook: notebook_rx,
            runtime: runtime_rx,
            comments: comments_rx,
            status: status_rx,
        })
        .unwrap();
        Fixture {
            owner,
            notebook,
            runtime,
            _comments: comments,
            _status: status,
        }
    }

    pub(crate) fn edited(source: &str) -> NotebookSnapshot {
        let mut doc = notebook_doc::NotebookDoc::new("observed-notebook");
        doc.add_cell_after("cell-1", "code", None).unwrap();
        doc.update_source("cell-1", source).unwrap();
        NotebookSnapshot::from_doc(&doc.into_inner())
    }

    #[tokio::test]
    async fn edits_between_baseline_and_wait_are_returned_with_the_matching_snapshot() {
        let fixture = fixture();
        let reader = fixture.owner.reader();
        let baseline = reader.read(None).unwrap();
        fixture.notebook.send_replace(edited("print(2)"));
        let changed = reader
            .wait(&baseline.cursor, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(changed.outcome, ChangeOutcome::Changed);
        assert_eq!(changed.snapshot.notebook.cells[0].source, "print(2)");
        assert_eq!(changed.changes.cell_ids, BTreeSet::from(["cell-1".into()]));
        assert_eq!(
            reader.read(Some(&changed.cursor)).unwrap().outcome,
            ChangeOutcome::Unchanged
        );
    }

    #[tokio::test]
    async fn burst_changes_coalesce_without_copying_source_into_the_history() {
        let fixture = fixture();
        let reader = fixture.owner.reader();
        let baseline = reader.read(None).unwrap();
        for index in 0..20 {
            fixture
                .notebook
                .send_replace(edited(&format!("print({index})")));
        }
        let changed = reader
            .wait(&baseline.cursor, Duration::from_secs(1))
            .await
            .unwrap();
        let state = reader.state.lock().unwrap();
        assert_eq!(state.journal.sequence, 1);
        assert_eq!(state.journal.history.len(), 1);
        assert_eq!(changed.snapshot.notebook.cells[0].source, "print(19)");
        assert!(!serde_json::to_string(&changed.changes)
            .unwrap()
            .contains("print"));
    }

    #[tokio::test]
    async fn expired_foreign_and_future_cursors_require_rebaseline() {
        let fixture = fixture();
        let reader = fixture.owner.reader();
        let baseline = reader.read(None).unwrap();
        let mut first_cursor = String::new();
        for index in 0..=RETAINED_BATCHES {
            fixture.notebook.send_replace(edited(&index.to_string()));
            let change = reader.read(None).unwrap();
            if index == 0 {
                first_cursor = change.cursor;
            }
        }
        assert_eq!(
            reader.state.lock().unwrap().journal.history.len(),
            RETAINED_BATCHES
        );
        assert_eq!(
            reader.read(Some(&baseline.cursor)).unwrap().outcome,
            ChangeOutcome::ResyncRequired
        );
        assert_eq!(
            reader.read(Some(&first_cursor)).unwrap().outcome,
            ChangeOutcome::Changed
        );
        assert_eq!(
            reader.read(Some("foreign:0")).unwrap().outcome,
            ChangeOutcome::ResyncRequired
        );
        let future = format!("{}:999999", reader.state.lock().unwrap().journal.generation);
        assert_eq!(
            reader.read(Some(&future)).unwrap().outcome,
            ChangeOutcome::ResyncRequired
        );
    }

    #[tokio::test]
    async fn releasing_session_wakes_pending_wait_and_invalidates_retained_reader() {
        let fixture = fixture();
        let reader = fixture.owner.reader();
        let baseline = reader.read(None).unwrap();
        let pending = {
            let reader = reader.clone();
            tokio::spawn(
                async move { reader.wait(&baseline.cursor, Duration::from_secs(30)).await },
            )
        };
        drop(fixture.owner);
        let result = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(result.outcome, ChangeOutcome::Unavailable);
        assert_eq!(
            reader.read(None).unwrap().outcome,
            ChangeOutcome::Unavailable
        );
    }

    #[tokio::test]
    async fn cancelled_wait_does_not_destroy_observation_and_timeout_is_explicit() {
        let fixture = fixture();
        let reader = fixture.owner.reader();
        let baseline = reader.read(None).unwrap();
        let pending = {
            let reader = reader.clone();
            let cursor = baseline.cursor.clone();
            tokio::spawn(async move { reader.wait(&cursor, Duration::from_secs(30)).await })
        };
        pending.abort();
        let timeout = reader
            .wait(&baseline.cursor, Duration::from_millis(1))
            .await
            .unwrap();
        assert_eq!(timeout.outcome, ChangeOutcome::TimedOut);
        fixture.notebook.send_replace(edited("still connected"));
        assert_eq!(
            reader
                .wait(&baseline.cursor, Duration::from_secs(1))
                .await
                .unwrap()
                .outcome,
            ChangeOutcome::Changed
        );
    }

    #[tokio::test]
    async fn execution_pointer_changes_are_visible_even_without_a_runtime_update() {
        let fixture = fixture();
        fixture.notebook.send_replace(edited("pass"));
        let reader = fixture.owner.reader();
        let baseline = reader.read(None).unwrap();
        fixture.notebook.send_modify(|snapshot| {
            Arc::make_mut(&mut snapshot.execution_pointers).insert("cell-1".into(), "run-2".into());
        });
        let change = reader.read(Some(&baseline.cursor)).unwrap();
        assert_eq!(
            change.changes.execution_ids,
            BTreeSet::from(["run-2".into()])
        );
        assert!(change.changes.kinds.contains(&ChangeKind::Outputs));
        assert_eq!(
            change.snapshot.notebook.execution_pointers["cell-1"],
            "run-2"
        );
    }

    #[tokio::test]
    async fn output_updates_keep_the_exact_execution_and_cell_identity() {
        let fixture = fixture();
        let reader = fixture.owner.reader();
        let baseline = reader.read(None).unwrap();
        fixture.runtime.send_modify(|runtime| {
            runtime.executions.insert("run-1".into(), serde_json::from_value(serde_json::json!({"status":"done","cell_id":"cell-1","outputs":[{"output_type":"stream","text":"done"}]})).unwrap());
        });
        let changed = reader
            .wait(&baseline.cursor, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(
            changed.changes.execution_ids,
            BTreeSet::from(["run-1".into()])
        );
        assert_eq!(changed.changes.cell_ids, BTreeSet::from(["cell-1".into()]));
        assert!(changed.changes.kinds.contains(&ChangeKind::Outputs));
    }
}
