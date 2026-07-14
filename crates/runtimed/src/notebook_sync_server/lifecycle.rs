//! Room-owned source and availability state.
//!
//! Source preparation and document availability are deliberately separate
//! axes. A durable staged projection can be readable while its exact Automerge
//! changes are still publishing into the live room, and a source failure can
//! degrade capabilities without erasing either the projection or live peer
//! edits.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use automerge::{Change, ChangeHash};
use runtimed_client::protocol::NotebookProjection;
use tokio::sync::watch;

use super::recovery::SourceFingerprint;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum RoomSourceFingerprint {
    NotApplicable,
    Pending,
    Content(SourceFingerprint),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomSourceProgressStage {
    Preparing,
    Journaling,
    Publishing,
    Complete,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomSourceProgress {
    pub stage: RoomSourceProgressStage,
    pub completed: usize,
    pub total: Option<usize>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomSourceError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomSourceRetry {
    NotNeeded,
    RegenerateIfPristine,
    ResumeStaged,
    ExplicitReconciliation,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomSourceStatus {
    pub generation: u64,
    pub fingerprint: RoomSourceFingerprint,
    pub progress: RoomSourceProgress,
    pub error: Option<RoomSourceError>,
    pub retry: RoomSourceRetry,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomSourceState {
    Preparing(RoomSourceStatus),
    Publishing(RoomSourceStatus),
    Ready(RoomSourceStatus),
    Failed(RoomSourceStatus),
}

impl RoomSourceState {
    pub fn status(&self) -> &RoomSourceStatus {
        match self {
            Self::Preparing(status)
            | Self::Publishing(status)
            | Self::Ready(status)
            | Self::Failed(status) => status,
        }
    }

    pub fn generation(&self) -> u64 {
        self.status().generation
    }

    pub fn is_in_progress(&self) -> bool {
        matches!(self, Self::Preparing(_) | Self::Publishing(_))
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RoomCapabilities {
    pub read_projection: bool,
    pub read_document: bool,
    pub mutate: bool,
    pub execute: bool,
}

impl RoomCapabilities {
    fn attached() -> Self {
        Self::default()
    }

    fn projection_ready() -> Self {
        Self {
            read_projection: true,
            ..Self::default()
        }
    }

    fn interactive() -> Self {
        Self {
            read_projection: true,
            read_document: true,
            mutate: true,
            execute: true,
        }
    }

    fn degraded(read_projection: bool, read_document: bool) -> Self {
        Self {
            read_projection,
            read_document,
            mutate: false,
            execute: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RoomAvailabilityStatus {
    pub generation: u64,
    pub document_heads: Vec<String>,
    pub projection_heads: Vec<String>,
    pub capabilities: RoomCapabilities,
    pub reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomAvailability {
    Attached(RoomAvailabilityStatus),
    ProjectionReady(RoomAvailabilityStatus),
    Interactive(RoomAvailabilityStatus),
    Degraded(RoomAvailabilityStatus),
}

impl RoomAvailability {
    pub fn status(&self) -> &RoomAvailabilityStatus {
        match self {
            Self::Attached(status)
            | Self::ProjectionReady(status)
            | Self::Interactive(status)
            | Self::Degraded(status) => status,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[allow(dead_code)]
pub enum RoomAvailabilityTarget {
    Attached,
    ProjectionReady,
    Interactive,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomWaitResult<T> {
    Reached(T),
    Current(T),
}

impl<T> RoomWaitResult<T> {
    pub fn into_current(self) -> T {
        match self {
            Self::Reached(value) | Self::Current(value) => value,
        }
    }
}

/// One immutable group of source-authored Automerge changes.
#[derive(Clone)]
pub struct StagedChangeBatch {
    pub changes: Vec<Change>,
    pub hashes: Vec<ChangeHash>,
    #[allow(dead_code)]
    pub resulting_heads: Vec<ChangeHash>,
}

#[derive(Clone)]
pub struct StagedExecutionImport {
    pub execution_id: String,
    pub success: bool,
    pub execution_count: Option<i64>,
    pub outputs: Vec<serde_json::Value>,
}

#[derive(Clone)]
pub struct StagedWidgetCommImport {
    pub comm_id: String,
    pub model_module: String,
    pub model_name: String,
    pub state: serde_json::Value,
    pub seq: u64,
}

/// Durable, generation-owned source artifact replayed into the live room.
#[derive(Clone)]
pub(crate) struct StagedImportArtifact {
    pub generation: u64,
    pub fingerprint: SourceFingerprint,
    pub change_batches: Vec<StagedChangeBatch>,
    pub change_hashes: Vec<ChangeHash>,
    pub staged_heads: Vec<ChangeHash>,
    pub snapshot: Arc<[u8]>,
    pub source_content: Arc<[u8]>,
    pub cell_count: usize,
    pub loaded_sources: HashMap<String, String>,
    pub executions: Vec<StagedExecutionImport>,
    pub widget_comms: Vec<StagedWidgetCommImport>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomSourceStart {
    Started { generation: u64 },
    Observing { generation: u64 },
}

/// The single owner for both lifecycle axes and generation artifacts.
pub struct RoomLifecycle {
    transition: Mutex<()>,
    source_tx: watch::Sender<RoomSourceState>,
    availability_tx: watch::Sender<RoomAvailability>,
    task_claimed: AtomicBool,
    genesis_snapshot: Arc<[u8]>,
    staged: RwLock<Option<Arc<StagedImportArtifact>>>,
    prepared_projection: RwLock<Option<Arc<NotebookProjection>>>,
    projection: RwLock<Option<Arc<NotebookProjection>>>,
}

impl RoomLifecycle {
    pub fn new(genesis_snapshot: Vec<u8>, document_heads: Vec<String>) -> Arc<Self> {
        let source = RoomSourceState::Ready(RoomSourceStatus {
            generation: 0,
            fingerprint: RoomSourceFingerprint::NotApplicable,
            progress: RoomSourceProgress {
                stage: RoomSourceProgressStage::Complete,
                completed: 0,
                total: Some(0),
            },
            error: None,
            retry: RoomSourceRetry::NotNeeded,
        });
        let availability = RoomAvailability::Interactive(RoomAvailabilityStatus {
            generation: 0,
            document_heads,
            projection_heads: Vec::new(),
            capabilities: RoomCapabilities::interactive(),
            reason: None,
        });
        let (source_tx, _) = watch::channel(source);
        let (availability_tx, _) = watch::channel(availability);
        Arc::new(Self {
            transition: Mutex::new(()),
            source_tx,
            availability_tx,
            task_claimed: AtomicBool::new(false),
            genesis_snapshot: genesis_snapshot.into(),
            staged: RwLock::new(None),
            prepared_projection: RwLock::new(None),
            projection: RwLock::new(None),
        })
    }

    pub(crate) fn test_default() -> Arc<Self> {
        Self::new(Vec::new(), Vec::new())
    }

    fn lock_transition(&self) -> std::sync::MutexGuard<'_, ()> {
        self.transition
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub fn source_state(&self) -> RoomSourceState {
        self.source_tx.borrow().clone()
    }

    pub fn availability(&self) -> RoomAvailability {
        self.availability_tx.borrow().clone()
    }

    pub fn subscribe_source(&self) -> watch::Receiver<RoomSourceState> {
        self.source_tx.subscribe()
    }

    pub fn subscribe_availability(&self) -> watch::Receiver<RoomAvailability> {
        self.availability_tx.subscribe()
    }

    pub fn genesis_snapshot(&self) -> Arc<[u8]> {
        Arc::clone(&self.genesis_snapshot)
    }

    pub fn staged_import(&self, generation: u64) -> Option<Arc<StagedImportArtifact>> {
        self.staged
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|artifact| artifact.generation == generation)
            .cloned()
    }

    pub fn projection(&self, generation: u64) -> Option<Arc<NotebookProjection>> {
        self.projection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|projection| projection.load_generation == generation)
            .cloned()
    }

    /// Most recently published immutable projection, regardless of whether a
    /// later source/checkpoint generation is currently degraded.
    ///
    /// `NotebookProjection::load_generation` and `projection_heads` retain the
    /// artifact's original provenance. Callers must not relabel it as the
    /// current generation.
    pub fn latest_projection(&self) -> Option<Arc<NotebookProjection>> {
        self.projection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    pub(crate) fn prepared_projection(&self, generation: u64) -> Option<Arc<NotebookProjection>> {
        self.prepared_projection
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .as_ref()
            .filter(|projection| projection.load_generation == generation)
            .cloned()
    }

    /// Enter source preparation before the room is published.
    pub fn mark_source_required(&self) -> bool {
        let _guard = self.lock_transition();
        let current = self.source_state();
        match &current {
            RoomSourceState::Preparing(_) | RoomSourceState::Publishing(_) => return true,
            RoomSourceState::Ready(status)
                if status.generation == 0
                    && matches!(status.fingerprint, RoomSourceFingerprint::NotApplicable) => {}
            // Ready generations are sticky for the room lifetime. Failed
            // generations may advance only through a claimed safe retry or an
            // explicit reconciliation; a generic open/attach path must never
            // erase their retry policy or retained recovery evidence.
            RoomSourceState::Ready(_) | RoomSourceState::Failed(_) => return false,
        }
        let generation = current.generation().saturating_add(1);
        self.task_claimed.store(false, Ordering::Release);
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.source_tx
            .send_replace(RoomSourceState::Preparing(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Pending,
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Preparing,
                    completed: 0,
                    total: None,
                },
                error: None,
                retry: RoomSourceRetry::RegenerateIfPristine,
            }));
        let previous = self.availability();
        self.availability_tx
            .send_replace(RoomAvailability::Attached(RoomAvailabilityStatus {
                generation,
                document_heads: previous.status().document_heads.clone(),
                projection_heads: Vec::new(),
                capabilities: RoomCapabilities::attached(),
                reason: None,
            }));
        true
    }

    pub fn begin_source(&self) -> RoomSourceStart {
        let _guard = self.lock_transition();
        let generation = self.source_state().generation();
        if !self.source_state().is_in_progress() {
            return RoomSourceStart::Observing { generation };
        }
        if self.task_claimed.swap(true, Ordering::AcqRel) {
            RoomSourceStart::Observing { generation }
        } else {
            RoomSourceStart::Started { generation }
        }
    }

    pub fn retry_failed_claimed(&self) -> Option<u64> {
        let _guard = self.lock_transition();
        let RoomSourceState::Failed(previous) = self.source_state() else {
            return None;
        };
        let generation = previous.generation.saturating_add(1);
        self.task_claimed.store(true, Ordering::Release);
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.source_tx
            .send_replace(RoomSourceState::Preparing(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Pending,
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Preparing,
                    completed: 0,
                    total: None,
                },
                error: None,
                retry: RoomSourceRetry::RegenerateIfPristine,
            }));
        let availability = self.availability();
        self.availability_tx
            .send_replace(RoomAvailability::Attached(RoomAvailabilityStatus {
                generation,
                document_heads: availability.status().document_heads.clone(),
                projection_heads: Vec::new(),
                capabilities: RoomCapabilities::attached(),
                reason: None,
            }));
        Some(generation)
    }

    /// Reclaim a failed staged generation without changing its identity.
    pub fn resume_failed_staged_claimed(&self) -> Option<u64> {
        let _guard = self.lock_transition();
        let RoomSourceState::Failed(previous) = self.source_state() else {
            return None;
        };
        let artifact = self.staged_import(previous.generation)?;
        self.task_claimed.store(true, Ordering::Release);
        let mut status = previous;
        status.progress.stage = RoomSourceProgressStage::Preparing;
        status.error = None;
        status.retry = RoomSourceRetry::ResumeStaged;
        self.source_tx
            .send_replace(RoomSourceState::Preparing(status.clone()));
        let availability = self.availability();
        self.availability_tx
            .send_replace(RoomAvailability::Attached(RoomAvailabilityStatus {
                generation: status.generation,
                document_heads: availability.status().document_heads.clone(),
                projection_heads: Vec::new(),
                capabilities: RoomCapabilities::attached(),
                reason: None,
            }));
        debug_assert_eq!(artifact.generation, status.generation);
        Some(status.generation)
    }

    /// Retain a prepared immutable artifact before the non-cancellable journal
    /// worker starts. It is not readable yet; the only purpose of this pending
    /// ownership is to let a cancelled/failed task retry the same hashes rather
    /// than regenerating a second import.
    pub(crate) fn record_prepared_artifacts(
        &self,
        generation: u64,
        artifact: Arc<StagedImportArtifact>,
        projection: Arc<NotebookProjection>,
    ) -> bool {
        let _guard = self.lock_transition();
        let RoomSourceState::Preparing(status) = self.source_state() else {
            return false;
        };
        if status.generation != generation
            || artifact.generation != generation
            || projection.load_generation != generation
        {
            return false;
        }
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(artifact);
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(projection);
        true
    }

    pub(crate) fn note_prepared(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        total_cells: usize,
    ) -> bool {
        let _guard = self.lock_transition();
        let RoomSourceState::Preparing(mut status) = self.source_state() else {
            return false;
        };
        if status.generation != generation {
            return false;
        }
        status.fingerprint = RoomSourceFingerprint::Content(fingerprint);
        status.progress.total = Some(total_cells);
        self.source_tx
            .send_replace(RoomSourceState::Preparing(status));
        true
    }

    pub fn note_journaling(&self, generation: u64) -> bool {
        let _guard = self.lock_transition();
        let RoomSourceState::Preparing(mut status) = self.source_state() else {
            return false;
        };
        if status.generation != generation {
            return false;
        }
        status.progress.stage = RoomSourceProgressStage::Journaling;
        self.source_tx
            .send_replace(RoomSourceState::Preparing(status));
        true
    }

    /// Install the durable staged artifact and expose its projection.
    pub fn publish_projection_ready(
        &self,
        generation: u64,
        artifact: Arc<StagedImportArtifact>,
        projection: Arc<NotebookProjection>,
        document_heads: Vec<String>,
    ) -> bool {
        let _guard = self.lock_transition();
        let current = self.source_state();
        if current.generation() != generation
            || artifact.generation != generation
            || projection.load_generation != generation
        {
            return false;
        }
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&artifact));
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&projection));
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(projection);

        let RoomSourceState::Preparing(mut status) = current else {
            // A cancellation/panic may terminalize the task lease while the
            // non-cancellable journal worker is flushing. The worker still
            // installs the now-durable immutable artifact here so a later
            // explicit retry resumes these exact hashes. Keep the terminal
            // failure and mutation gates intact until that retry is claimed.
            if let RoomSourceState::Failed(mut status) = current {
                status.retry = RoomSourceRetry::ResumeStaged;
                self.source_tx
                    .send_replace(RoomSourceState::Failed(status.clone()));
                self.availability_tx
                    .send_replace(RoomAvailability::Degraded(RoomAvailabilityStatus {
                        generation,
                        document_heads,
                        projection_heads: artifact
                            .staged_heads
                            .iter()
                            .map(ToString::to_string)
                            .collect(),
                        capabilities: RoomCapabilities::projection_ready(),
                        reason: status.error.map(|error| error.message),
                    }));
            }
            return false;
        };
        status.progress = RoomSourceProgress {
            stage: RoomSourceProgressStage::Publishing,
            completed: 0,
            total: Some(artifact.change_batches.len()),
        };
        status.retry = RoomSourceRetry::ResumeStaged;
        self.source_tx
            .send_replace(RoomSourceState::Publishing(status));
        self.availability_tx
            .send_replace(RoomAvailability::ProjectionReady(RoomAvailabilityStatus {
                generation,
                document_heads,
                projection_heads: artifact
                    .staged_heads
                    .iter()
                    .map(ToString::to_string)
                    .collect(),
                capabilities: RoomCapabilities::projection_ready(),
                reason: None,
            }));
        true
    }

    pub fn note_published_batch(
        &self,
        generation: u64,
        completed_batches: usize,
        document_heads: Vec<String>,
    ) -> bool {
        let _guard = self.lock_transition();
        let RoomSourceState::Publishing(mut status) = self.source_state() else {
            return false;
        };
        if status.generation != generation {
            return false;
        }
        status.progress.completed = completed_batches;
        self.source_tx
            .send_replace(RoomSourceState::Publishing(status));
        let availability = self.availability();
        self.availability_tx
            .send_replace(RoomAvailability::ProjectionReady(RoomAvailabilityStatus {
                generation,
                document_heads,
                projection_heads: availability.status().projection_heads.clone(),
                capabilities: RoomCapabilities::projection_ready(),
                reason: None,
            }));
        true
    }

    pub fn complete_ready(
        &self,
        generation: u64,
        cell_count: usize,
        document_heads: Vec<String>,
    ) -> bool {
        let _guard = self.lock_transition();
        let current = self.source_state();
        if current.generation() != generation || !current.is_in_progress() {
            return false;
        }
        let Some(projection) = self.projection(generation) else {
            return false;
        };
        let mut status = current.status().clone();
        status.progress = RoomSourceProgress {
            stage: RoomSourceProgressStage::Complete,
            completed: cell_count,
            total: Some(cell_count),
        };
        status.error = None;
        status.retry = RoomSourceRetry::NotNeeded;
        self.source_tx.send_replace(RoomSourceState::Ready(status));
        self.task_claimed.store(false, Ordering::Release);
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        self.availability_tx
            .send_replace(RoomAvailability::Interactive(RoomAvailabilityStatus {
                generation,
                projection_heads: projection.projection_heads.clone(),
                document_heads,
                capabilities: RoomCapabilities::interactive(),
                reason: None,
            }));
        true
    }

    pub fn complete_failed(&self, generation: u64, code: &str, message: String) -> bool {
        let _guard = self.lock_transition();
        let current = self.source_state();
        if current.generation() != generation || !current.is_in_progress() {
            return false;
        }
        let has_staged = self.staged_import(generation).is_some();
        let mut status = current.status().clone();
        status.error = Some(RoomSourceError {
            code: code.to_string(),
            message: message.clone(),
        });
        status.retry = if has_staged {
            RoomSourceRetry::ResumeStaged
        } else {
            RoomSourceRetry::RegenerateIfPristine
        };
        self.source_tx.send_replace(RoomSourceState::Failed(status));
        self.task_claimed.store(false, Ordering::Release);
        let availability = self.availability();
        let retained_projection = self.latest_projection();
        let projection_available = retained_projection.is_some();
        let projection_heads = retained_projection
            .as_ref()
            .map(|projection| projection.projection_heads.clone())
            .unwrap_or_default();
        self.availability_tx
            .send_replace(RoomAvailability::Degraded(RoomAvailabilityStatus {
                generation,
                document_heads: availability.status().document_heads.clone(),
                projection_heads,
                capabilities: if projection_available {
                    RoomCapabilities::projection_ready()
                } else {
                    RoomCapabilities::attached()
                },
                reason: Some(message),
            }));
        true
    }

    /// Close mutation/execution capabilities after a durability or source
    /// conflict without discarding the readable recovery state.
    pub(crate) fn mark_degraded(
        &self,
        reason: String,
        document_heads: Vec<String>,
        document_readable: bool,
    ) {
        self.mark_degraded_with_code("source_degraded", reason, document_heads, document_readable);
    }

    pub(crate) fn mark_source_conflict(&self, reason: String, document_heads: Vec<String>) {
        self.mark_degraded_with_code("source_conflict", reason, document_heads, true);
    }

    fn mark_degraded_with_code(
        &self,
        code: &str,
        reason: String,
        document_heads: Vec<String>,
        document_readable: bool,
    ) {
        let _guard = self.lock_transition();
        let current = self.source_state();
        let generation = current.generation();
        let retained_projection = self.latest_projection();
        let projection_readable = retained_projection.is_some();
        let projection_heads = retained_projection
            .as_ref()
            .map(|projection| projection.projection_heads.clone())
            .unwrap_or_default();
        let mut source_status = current.status().clone();
        source_status.error = Some(RoomSourceError {
            code: code.to_string(),
            message: reason.clone(),
        });
        source_status.retry = if code == "source_conflict" {
            RoomSourceRetry::ExplicitReconciliation
        } else if self.staged_import(generation).is_some() {
            RoomSourceRetry::ResumeStaged
        } else {
            RoomSourceRetry::ExplicitReconciliation
        };
        self.source_tx
            .send_replace(RoomSourceState::Failed(source_status));
        self.task_claimed.store(false, Ordering::Release);
        self.availability_tx
            .send_replace(RoomAvailability::Degraded(RoomAvailabilityStatus {
                generation,
                document_heads,
                projection_heads,
                capabilities: RoomCapabilities::degraded(projection_readable, document_readable),
                reason: Some(reason),
            }));
    }

    /// Restore a matching durable source generation that still needs its
    /// process-local projection and runtime sidecars reconstructed before it
    /// can become Interactive. The generation is retained exactly; restart
    /// never authors a replacement source history.
    pub(crate) fn restore_recovered_pending(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        cell_count: usize,
        document_heads: Vec<String>,
    ) {
        let _guard = self.lock_transition();
        self.task_claimed.store(false, Ordering::Release);
        self.source_tx
            .send_replace(RoomSourceState::Preparing(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Content(fingerprint),
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Preparing,
                    completed: 0,
                    total: Some(cell_count),
                },
                error: None,
                retry: RoomSourceRetry::ResumeStaged,
            }));
        self.availability_tx
            .send_replace(RoomAvailability::Attached(RoomAvailabilityStatus {
                generation,
                projection_heads: Vec::new(),
                document_heads,
                capabilities: RoomCapabilities::attached(),
                reason: None,
            }));
    }

    pub(crate) fn publish_recovered_projection_ready(
        &self,
        generation: u64,
        projection: Arc<NotebookProjection>,
        document_heads: Vec<String>,
    ) -> bool {
        let _guard = self.lock_transition();
        let RoomSourceState::Preparing(mut status) = self.source_state() else {
            return false;
        };
        if status.generation != generation || projection.load_generation != generation {
            return false;
        }
        let projection_heads = projection.projection_heads.clone();
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(projection);
        status.progress.stage = RoomSourceProgressStage::Publishing;
        status.progress.completed = status.progress.total.unwrap_or_default();
        self.source_tx
            .send_replace(RoomSourceState::Publishing(status));
        self.availability_tx
            .send_replace(RoomAvailability::ProjectionReady(RoomAvailabilityStatus {
                generation,
                projection_heads,
                document_heads,
                capabilities: RoomCapabilities::projection_ready(),
                reason: None,
            }));
        true
    }

    /// Restore a peer-authored recovery union for which no immutable source
    /// generation exists. Reads remain available, but regeneration is unsafe
    /// because it would invent a new source history over collaborative edits.
    pub(crate) fn restore_incomplete_source(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        cell_count: usize,
        document_heads: Vec<String>,
        reason: String,
    ) {
        let _guard = self.lock_transition();
        self.task_claimed.store(false, Ordering::Release);
        self.source_tx
            .send_replace(RoomSourceState::Failed(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Content(fingerprint),
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Complete,
                    completed: cell_count,
                    total: Some(cell_count),
                },
                error: Some(RoomSourceError {
                    code: "source_degraded".to_string(),
                    message: reason.clone(),
                }),
                retry: RoomSourceRetry::ExplicitReconciliation,
            }));
        self.availability_tx
            .send_replace(RoomAvailability::Degraded(RoomAvailabilityStatus {
                generation,
                projection_heads: Vec::new(),
                document_heads,
                capabilities: RoomCapabilities::degraded(false, true),
                reason: Some(reason),
            }));
    }

    /// Initialize a room with both recovered Automerge truth and a divergent
    /// disk source preserved. Reads remain available; mutation and execution
    /// require one of the explicit reconciliation operations.
    pub(crate) fn restore_source_conflict(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        cell_count: usize,
        document_heads: Vec<String>,
        reason: String,
    ) {
        let _guard = self.lock_transition();
        self.task_claimed.store(false, Ordering::Release);
        self.source_tx
            .send_replace(RoomSourceState::Failed(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Content(fingerprint),
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Complete,
                    completed: cell_count,
                    total: Some(cell_count),
                },
                error: Some(RoomSourceError {
                    code: "source_conflict".to_string(),
                    message: reason.clone(),
                }),
                retry: RoomSourceRetry::ExplicitReconciliation,
            }));
        self.availability_tx
            .send_replace(RoomAvailability::Degraded(RoomAvailabilityStatus {
                generation,
                projection_heads: Vec::new(),
                document_heads,
                capabilities: RoomCapabilities::degraded(false, true),
                reason: Some(reason),
            }));
    }

    pub fn recover_failed(
        &self,
        cell_count: usize,
        document_heads: Vec<String>,
        projection: Arc<NotebookProjection>,
    ) -> Option<u64> {
        let _guard = self.lock_transition();
        let RoomSourceState::Failed(previous) = self.source_state() else {
            return None;
        };
        let generation = previous.generation.saturating_add(1);
        if projection.load_generation != generation {
            return None;
        }
        let projection_heads = projection.projection_heads.clone();
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(projection);
        let status = RoomSourceStatus {
            generation,
            fingerprint: previous.fingerprint,
            progress: RoomSourceProgress {
                stage: RoomSourceProgressStage::Complete,
                completed: cell_count,
                total: Some(cell_count),
            },
            error: None,
            retry: RoomSourceRetry::NotNeeded,
        };
        self.source_tx.send_replace(RoomSourceState::Ready(status));
        self.task_claimed.store(false, Ordering::Release);
        self.availability_tx
            .send_replace(RoomAvailability::Interactive(RoomAvailabilityStatus {
                generation,
                document_heads,
                projection_heads,
                capabilities: RoomCapabilities::interactive(),
                reason: None,
            }));
        Some(generation)
    }

    /// Adopt the causal file checkpoint that turns an untitled room into a
    /// file-backed source generation.
    pub(crate) fn promote_file_backed_checkpoint(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        cell_count: usize,
        projection: Arc<NotebookProjection>,
        document_heads: Vec<String>,
    ) {
        let _guard = self.lock_transition();
        debug_assert_eq!(projection.load_generation, generation);
        self.task_claimed.store(false, Ordering::Release);
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&projection));
        self.source_tx
            .send_replace(RoomSourceState::Ready(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Content(fingerprint),
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Complete,
                    completed: cell_count,
                    total: Some(cell_count),
                },
                error: None,
                retry: RoomSourceRetry::NotNeeded,
            }));
        self.availability_tx
            .send_replace(RoomAvailability::Interactive(RoomAvailabilityStatus {
                generation,
                projection_heads: projection.projection_heads.clone(),
                document_heads,
                capabilities: RoomCapabilities::interactive(),
                reason: None,
            }));
    }

    /// Publish one fully journaled external file revision as the room's new
    /// source generation and replace any retained projection atomically.
    pub(crate) fn complete_external_source_revision(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        cell_count: usize,
        projection: Arc<NotebookProjection>,
        document_heads: Vec<String>,
    ) {
        let _guard = self.lock_transition();
        debug_assert_eq!(projection.load_generation, generation);
        self.task_claimed.store(false, Ordering::Release);
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&projection));
        self.source_tx
            .send_replace(RoomSourceState::Ready(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Content(fingerprint),
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Complete,
                    completed: cell_count,
                    total: Some(cell_count),
                },
                error: None,
                retry: RoomSourceRetry::NotNeeded,
            }));
        self.availability_tx
            .send_replace(RoomAvailability::Interactive(RoomAvailabilityStatus {
                generation,
                projection_heads: projection.projection_heads.clone(),
                document_heads,
                capabilities: RoomCapabilities::interactive(),
                reason: None,
            }));
    }

    /// Complete an explicit recovered-room/source decision and restore the
    /// mutation/execute capabilities only after its file and journal commit.
    pub(crate) fn complete_reconciliation(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        cell_count: usize,
        projection: Arc<NotebookProjection>,
        document_heads: Vec<String>,
    ) {
        let _guard = self.lock_transition();
        debug_assert_eq!(
            generation,
            self.source_state().generation().saturating_add(1),
            "reconciliation must publish the generation committed in its journal checkpoint"
        );
        debug_assert_eq!(projection.load_generation, generation);
        self.task_claimed.store(false, Ordering::Release);
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(Arc::clone(&projection));
        self.source_tx
            .send_replace(RoomSourceState::Ready(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Content(fingerprint),
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Complete,
                    completed: cell_count,
                    total: Some(cell_count),
                },
                error: None,
                retry: RoomSourceRetry::NotNeeded,
            }));
        self.availability_tx
            .send_replace(RoomAvailability::Interactive(RoomAvailabilityStatus {
                generation,
                projection_heads: projection.projection_heads.clone(),
                document_heads,
                capabilities: RoomCapabilities::interactive(),
                reason: None,
            }));
    }

    /// A reconciliation may commit its selected NotebookDoc and journal before
    /// a RuntimeState/Comms sidecar projection fails. Keep that committed
    /// generation readable but non-interactive. A projection from the prior
    /// generation remains inspectable with its original generation/heads; it
    /// must never be relabeled as the newly committed document generation.
    pub(crate) fn fail_reconciliation(
        &self,
        generation: u64,
        fingerprint: SourceFingerprint,
        cell_count: usize,
        document_heads: Vec<String>,
        reason: String,
    ) {
        let _guard = self.lock_transition();
        self.task_claimed.store(false, Ordering::Release);
        *self
            .staged
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        *self
            .prepared_projection
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
        let retained_projection = self.latest_projection();
        let projection_heads = retained_projection
            .as_ref()
            .map(|projection| projection.projection_heads.clone())
            .unwrap_or_default();
        self.source_tx
            .send_replace(RoomSourceState::Failed(RoomSourceStatus {
                generation,
                fingerprint: RoomSourceFingerprint::Content(fingerprint),
                progress: RoomSourceProgress {
                    stage: RoomSourceProgressStage::Complete,
                    completed: cell_count,
                    total: Some(cell_count),
                },
                error: Some(RoomSourceError {
                    code: "source_degraded".to_string(),
                    message: reason.clone(),
                }),
                retry: RoomSourceRetry::ExplicitReconciliation,
            }));
        self.availability_tx
            .send_replace(RoomAvailability::Degraded(RoomAvailabilityStatus {
                generation,
                projection_heads,
                document_heads,
                capabilities: RoomCapabilities::degraded(retained_projection.is_some(), true),
                reason: Some(reason),
            }));
    }

    pub async fn wait_for_source_settled(
        &self,
        timeout: Duration,
    ) -> RoomWaitResult<RoomSourceState> {
        let mut receiver = self.subscribe_source();
        let wait = async {
            loop {
                let state = receiver.borrow().clone();
                if !state.is_in_progress() {
                    return state;
                }
                if receiver.changed().await.is_err() {
                    return self.source_state();
                }
            }
        };
        match tokio::time::timeout(timeout, wait).await {
            Ok(state) => RoomWaitResult::Reached(state),
            Err(_) => RoomWaitResult::Current(self.source_state()),
        }
    }

    pub async fn wait_for_availability(
        &self,
        target: RoomAvailabilityTarget,
        timeout: Duration,
    ) -> RoomWaitResult<RoomAvailability> {
        let mut receiver = self.subscribe_availability();
        let wait = async {
            loop {
                let state = receiver.borrow().clone();
                let reached = matches!(
                    (target, &state),
                    (RoomAvailabilityTarget::Attached, _)
                        | (
                            RoomAvailabilityTarget::ProjectionReady,
                            RoomAvailability::ProjectionReady(_) | RoomAvailability::Interactive(_)
                        )
                        | (
                            RoomAvailabilityTarget::Interactive,
                            RoomAvailability::Interactive(_)
                        )
                );
                if reached || matches!(state, RoomAvailability::Degraded(_)) {
                    return state;
                }
                if receiver.changed().await.is_err() {
                    return self.availability();
                }
            }
        };
        match tokio::time::timeout(timeout, wait).await {
            Ok(state) if !matches!(state, RoomAvailability::Degraded(_)) => {
                RoomWaitResult::Reached(state)
            }
            Ok(state) => RoomWaitResult::Current(state),
            Err(_) => RoomWaitResult::Current(self.availability()),
        }
    }

    #[cfg(test)]
    pub fn task_claimed(&self) -> bool {
        self.task_claimed.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub fn reset_in_progress(&self) {
        let _guard = self.lock_transition();
        let current = self.source_state();
        if current.is_in_progress() {
            let generation = current.generation();
            self.source_tx
                .send_replace(RoomSourceState::Ready(RoomSourceStatus {
                    generation,
                    fingerprint: RoomSourceFingerprint::NotApplicable,
                    progress: RoomSourceProgress {
                        stage: RoomSourceProgressStage::Complete,
                        completed: 0,
                        total: Some(0),
                    },
                    error: None,
                    retry: RoomSourceRetry::NotNeeded,
                }));
            self.task_claimed.store(false, Ordering::Release);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty_staged_generation(
        generation: u64,
    ) -> (Arc<StagedImportArtifact>, Arc<NotebookProjection>) {
        let fingerprint = SourceFingerprint::from_content(b"source");
        let artifact = Arc::new(StagedImportArtifact {
            generation,
            fingerprint,
            change_batches: Vec::new(),
            change_hashes: Vec::new(),
            staged_heads: Vec::new(),
            snapshot: Arc::from([]),
            source_content: Arc::from([]),
            cell_count: 0,
            loaded_sources: HashMap::new(),
            executions: Vec::new(),
            widget_comms: Vec::new(),
        });
        let projection = Arc::new(NotebookProjection {
            schema_version: 2,
            load_generation: generation,
            notebook_id: "notebook".to_string(),
            notebook_path: None,
            cells: Vec::new(),
            dependencies: Vec::new(),
            runtime: Default::default(),
            source_state: Default::default(),
            availability: runtimed_client::protocol::NotebookAvailabilityProjection {
                phase: runtimed_client::protocol::NotebookAvailabilityPhase::Attached,
                generation,
                document_heads: Vec::new(),
                projection_heads: Vec::new(),
                capabilities: runtimed_client::protocol::NotebookCapabilities {
                    read: false,
                    mutate: false,
                    execute: false,
                },
                reason: None,
            },
            readiness: runtimed_client::protocol::NotebookReadiness {
                projection: false,
                document: false,
                runtime: false,
            },
            projection_complete: true,
            projection_heads: vec![format!("projection-head-{generation}")],
            notebook_heads: vec![format!("projection-head-{generation}")],
            runtime_state_heads: Vec::new(),
            captured_at: chrono::Utc::now(),
        });
        (artifact, projection)
    }

    #[tokio::test]
    async fn source_and_availability_are_independent_axes() {
        let lifecycle = RoomLifecycle::test_default();
        lifecycle.mark_source_required();
        assert!(matches!(
            lifecycle.source_state(),
            RoomSourceState::Preparing(_)
        ));
        assert!(matches!(
            lifecycle.availability(),
            RoomAvailability::Attached(_)
        ));
    }

    #[tokio::test]
    async fn bounded_wait_returns_current_state() {
        let lifecycle = RoomLifecycle::test_default();
        lifecycle.mark_source_required();
        let result = lifecycle
            .wait_for_availability(
                RoomAvailabilityTarget::ProjectionReady,
                Duration::from_millis(1),
            )
            .await;
        assert!(matches!(
            result,
            RoomWaitResult::Current(RoomAvailability::Attached(_))
        ));
    }

    #[tokio::test]
    async fn failed_generation_is_sticky_and_notifies_authoritative_waiters() {
        let lifecycle = RoomLifecycle::test_default();
        assert!(lifecycle.mark_source_required());
        let generation = match lifecycle.begin_source() {
            RoomSourceStart::Started { generation } => generation,
            other => panic!("source generation should be claimable, got {other:?}"),
        };
        let mut waiter = lifecycle.subscribe_source();
        assert!(lifecycle.complete_failed(
            generation,
            "source_degraded",
            "injected journal failure".to_string(),
        ));
        waiter.changed().await.unwrap();
        let failed = waiter.borrow().clone();
        assert!(matches!(
            failed,
            RoomSourceState::Failed(ref status)
                if status.generation == generation
                    && status.error.as_ref().is_some_and(|error| error.code == "source_degraded")
        ));

        assert!(!lifecycle.mark_source_required());
        assert_eq!(lifecycle.source_state(), failed);
    }

    #[test]
    fn prepared_artifact_is_retained_but_not_readable_until_journal_publish() {
        let lifecycle = RoomLifecycle::test_default();
        lifecycle.mark_source_required();
        let generation = match lifecycle.begin_source() {
            RoomSourceStart::Started { generation } => generation,
            other => panic!("source generation should be claimable, got {other:?}"),
        };
        let (artifact, projection) = empty_staged_generation(generation);

        assert!(lifecycle.record_prepared_artifacts(
            generation,
            Arc::clone(&artifact),
            Arc::clone(&projection),
        ));
        assert!(lifecycle.staged_import(generation).is_some());
        assert!(lifecycle.prepared_projection(generation).is_some());
        assert!(lifecycle.projection(generation).is_none());

        assert!(lifecycle.complete_failed(
            generation,
            "cancelled",
            "source owner cancelled".to_string(),
        ));
        assert!(matches!(
            lifecycle.source_state(),
            RoomSourceState::Failed(RoomSourceStatus {
                retry: RoomSourceRetry::ResumeStaged,
                ..
            })
        ));
        assert!(
            !lifecycle
                .availability()
                .status()
                .capabilities
                .read_projection
        );

        // A non-cancellable journal worker may finish after the task lease
        // terminalized the generation. Its projection becomes readable, but
        // mutation remains gated until an explicit retry reclaims the same
        // generation and republishes the exact staged hashes.
        assert!(!lifecycle.publish_projection_ready(
            generation,
            Arc::clone(&artifact),
            Arc::clone(&projection),
            Vec::new(),
        ));
        assert!(lifecycle.projection(generation).is_some());
        let capabilities = lifecycle.availability().status().capabilities;
        assert!(capabilities.read_projection);
        assert!(!capabilities.mutate);

        assert_eq!(lifecycle.resume_failed_staged_claimed(), Some(generation));
        assert!(lifecycle.note_journaling(generation));
        let expected_projection = Arc::clone(&projection);
        assert!(lifecycle.publish_projection_ready(generation, artifact, projection, Vec::new(),));
        assert!(matches!(
            lifecycle.source_state(),
            RoomSourceState::Publishing(_)
        ));
        assert!(matches!(
            lifecycle.availability(),
            RoomAvailability::ProjectionReady(_)
        ));
        assert!(lifecycle.complete_ready(
            generation,
            0,
            vec!["document-head-with-peer-edits".to_string()],
        ));
        let retained = lifecycle
            .projection(generation)
            .expect("Ready generation must retain its immutable projection");
        assert!(Arc::ptr_eq(&retained, &expected_projection));
        let availability = lifecycle.availability();
        assert!(matches!(availability, RoomAvailability::Interactive(_)));
        assert_eq!(
            availability.status().projection_heads,
            expected_projection.projection_heads
        );
        assert_eq!(
            availability.status().document_heads,
            vec!["document-head-with-peer-edits".to_string()]
        );
    }

    #[test]
    fn degraded_new_generation_retains_prior_projection_provenance() {
        let lifecycle = RoomLifecycle::test_default();
        let (_, projection) = empty_staged_generation(4);
        lifecycle.complete_external_source_revision(
            4,
            SourceFingerprint::from_content(b"ready source"),
            0,
            Arc::clone(&projection),
            vec!["ready-document-head".to_string()],
        );

        lifecycle.fail_reconciliation(
            5,
            SourceFingerprint::from_content(b"new source"),
            0,
            vec!["new-document-head".to_string()],
            "runtime sidecar failed".to_string(),
        );

        let retained = lifecycle
            .latest_projection()
            .expect("degraded room should retain the last readable projection");
        assert_eq!(retained.load_generation, 4);
        assert_eq!(
            retained.projection_heads,
            vec!["projection-head-4".to_string()]
        );
        let availability = lifecycle.availability();
        assert!(matches!(availability, RoomAvailability::Degraded(_)));
        assert_eq!(availability.status().generation, 5);
        assert!(availability.status().capabilities.read_projection);
        assert!(availability.status().capabilities.read_document);
        assert_eq!(
            availability.status().projection_heads,
            vec!["projection-head-4".to_string()]
        );
        assert_eq!(
            availability.status().document_heads,
            vec!["new-document-head".to_string()]
        );
    }

    #[test]
    fn committed_reconciliation_sidecar_failure_keeps_new_generation_read_only() {
        let lifecycle = RoomLifecycle::test_default();
        let fingerprint = SourceFingerprint::from_content(b"disk source");

        lifecycle.fail_reconciliation(
            5,
            fingerprint,
            2,
            vec!["head-disk".to_string()],
            "runtime sidecar failed".to_string(),
        );

        assert!(matches!(
            lifecycle.source_state(),
            RoomSourceState::Failed(RoomSourceStatus {
                generation: 5,
                fingerprint: RoomSourceFingerprint::Content(value),
                retry: RoomSourceRetry::ExplicitReconciliation,
                ..
            }) if value == fingerprint
        ));
        let availability = lifecycle.availability();
        assert!(matches!(availability, RoomAvailability::Degraded(_)));
        assert_eq!(availability.status().generation, 5);
        assert!(availability.status().capabilities.read_document);
        assert!(!availability.status().capabilities.read_projection);
        assert!(!availability.status().capabilities.mutate);
        assert!(!availability.status().capabilities.execute);
    }
}
