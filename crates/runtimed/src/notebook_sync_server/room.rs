use super::*;
use crate::async_outcome::{recv_oneshot_with_timeout, TimedOneShot};
use sha2::Digest as _;

use super::comments_store::{
    comments_locator_for_room, comments_ref_for_room, CommentsSidecarStore,
};

/// Per-room identity.
///
/// Holds immutable identity and untitled working-directory context. The
/// mutable file-backed binding lives in `NotebookFileBinding`.
pub struct RoomIdentity {
    /// Persistence path for this room's Automerge document (not the .ipynb).
    pub persist_path: PathBuf,
    /// Working directory for untitled notebooks (used for project file detection).
    /// When the notebook_id is a UUID (untitled), this provides the directory
    /// context for finding pyproject.toml, pixi.toml, or environment.yaml.
    pub working_dir: RwLock<Option<PathBuf>>,
    /// Environment inheritance mode for daemon-created untitled notebooks.
    pub environment_mode: RwLock<notebook_protocol::connection::CreateNotebookEnvironmentMode>,
}

impl RoomIdentity {
    pub fn new(persist_path: PathBuf) -> Self {
        Self {
            persist_path,
            working_dir: RwLock::new(None),
            environment_mode: RwLock::new(Default::default()),
        }
    }
}

/// Owns the mutable relationship between a room and its `.ipynb` file.
///
/// This is the single daemon-side owner for canonical path state, file-backed
/// lifecycle handles, and the runtime-state `path` projection. Callers should
/// go through this type when a notebook is opened, promoted from untitled, or
/// saved-as to a new path.
pub struct NotebookFileBinding {
    /// The canonical `.ipynb` path, when this room is file-backed.
    path: RwLock<Option<PathBuf>>,
    /// Whether this notebook is ephemeral (in-memory only, no .ipynb on disk).
    is_ephemeral: AtomicBool,
    /// Shutdown signal for the `.ipynb` file watcher task.
    watcher_shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// Shutdown signal for the project-file watcher task.
    ///
    /// This watcher is derived from the bound notebook path and is rearmed when
    /// the binding moves to a new path.
    project_file_watcher_shutdown_tx: Mutex<Option<oneshot::Sender<()>>>,
    /// Shutdown/flush request channel for the `.ipynb` autosave task.
    autosave_shutdown_tx: Mutex<Option<mpsc::UnboundedSender<AutosaveShutdownRequest>>>,
}

pub struct NotebookFileBindingSaveSnapshot {
    pub was_untitled: bool,
    pub old_path: Option<PathBuf>,
    pub is_ephemeral: bool,
}

impl NotebookFileBinding {
    pub fn new(path: Option<PathBuf>, ephemeral: bool) -> Self {
        Self {
            path: RwLock::new(path),
            is_ephemeral: AtomicBool::new(ephemeral),
            watcher_shutdown_tx: Mutex::new(None),
            project_file_watcher_shutdown_tx: Mutex::new(None),
            autosave_shutdown_tx: Mutex::new(None),
        }
    }

    pub async fn path(&self) -> Option<PathBuf> {
        self.path.read().await.clone()
    }

    pub async fn has_saved_path(&self) -> bool {
        self.path.read().await.is_some()
    }

    pub fn is_ephemeral(&self) -> bool {
        self.is_ephemeral.load(Ordering::Relaxed)
    }

    pub async fn path_matches(&self, path: &Path) -> bool {
        self.path.read().await.as_deref() == Some(path)
    }

    pub async fn save_snapshot(&self) -> NotebookFileBindingSaveSnapshot {
        let old_path = self.path.read().await.clone();
        NotebookFileBindingSaveSnapshot {
            was_untitled: old_path.is_none(),
            old_path,
            is_ephemeral: self.is_ephemeral(),
        }
    }

    async fn set_bound_path(&self, canonical: PathBuf) {
        *self.path.write().await = Some(canonical);
    }

    fn mark_file_backed(&self) {
        self.is_ephemeral.store(false, Ordering::Relaxed);
    }

    #[cfg(test)]
    pub async fn set_path_for_test(&self, path: Option<PathBuf>) {
        *self.path.write().await = path;
    }

    #[cfg(test)]
    pub async fn has_project_file_watcher_for_test(&self) -> bool {
        self.project_file_watcher_shutdown_tx.lock().await.is_some()
    }

    #[cfg(test)]
    pub async fn has_autosave_shutdown_tx_for_test(&self) -> bool {
        self.autosave_shutdown_tx.lock().await.is_some()
    }

    pub async fn claim_path(
        rooms: &NotebookRooms,
        canonical: &Path,
        uuid: uuid::Uuid,
    ) -> Result<(), notebook_protocol::protocol::SaveBlockedReason> {
        try_claim_path(rooms, canonical, uuid).await
    }

    pub async fn release_path(rooms: &NotebookRooms, canonical: &Path) {
        rooms.unbind_path(canonical).await;
    }

    pub async fn replace_claim(rooms: &NotebookRooms, old: &Path, new: PathBuf, uuid: uuid::Uuid) {
        if let Err(e) = rooms.replace_path(old, new.clone(), uuid).await {
            warn!(
                "[notebook-sync] post-write path_index reinsert failed for {:?}: {} \
                 — room {} may be orphaned from path lookup",
                new, e, uuid
            );
        }
    }

    pub async fn set_runtime_path(room: &NotebookRoom, canonical: &Path) {
        let path_str = canonical.to_string_lossy().into_owned();
        if let Err(e) = room.state.with_doc(|sd| sd.set_path(Some(&path_str))) {
            warn!("[notebook-sync] set_path failed for {:?}: {}", canonical, e);
        }
        super::workstation_attachment::publish_local_workstation_attachment_for_notebook_path(
            &room.state,
            Some(canonical),
        );
    }

    pub async fn bind_existing(room: &Arc<NotebookRoom>, canonical: &Path) {
        Self::set_runtime_path(room, canonical).await;
        room.file_binding
            .start_file_lifecycle(room, canonical)
            .await;
    }

    pub async fn promote_after_save(room: &Arc<NotebookRoom>, canonical: PathBuf) {
        room.file_binding.set_bound_path(canonical.clone()).await;
        room.file_binding.mark_file_backed();
        Self::set_runtime_path(room, &canonical).await;
        room.file_binding
            .start_file_lifecycle(room, &canonical)
            .await;
        super::project_context::refresh_project_context_async(room, Some(canonical.as_path()))
            .await;
    }

    pub async fn rebind_after_save_as(room: &Arc<NotebookRoom>, canonical: PathBuf) {
        room.file_binding.set_bound_path(canonical.clone()).await;
        Self::set_runtime_path(room, &canonical).await;
        room.file_binding
            .start_file_lifecycle(room, &canonical)
            .await;
        super::project_context::refresh_project_context_async(room, Some(canonical.as_path()))
            .await;
    }

    async fn start_file_lifecycle(&self, room: &Arc<NotebookRoom>, canonical: &Path) {
        if canonical.extension().is_some_and(|ext| ext == "ipynb") {
            let shutdown_tx =
                spawn_notebook_file_watcher(canonical.to_path_buf(), Arc::clone(room));
            self.install_notebook_watcher_shutdown_tx(shutdown_tx).await;
        }

        let shutdown_tx =
            spawn_autosave_debouncer(canonical.to_string_lossy().into_owned(), Arc::clone(room));
        self.install_autosave_shutdown_tx(shutdown_tx).await;
    }

    pub async fn install_notebook_watcher_shutdown_tx(&self, shutdown_tx: oneshot::Sender<()>) {
        let previous_tx = self.watcher_shutdown_tx.lock().await.replace(shutdown_tx);
        if let Some(previous_tx) = previous_tx {
            let _ = previous_tx.send(());
        }
    }

    pub async fn shutdown_notebook_watcher(&self) -> bool {
        let shutdown_tx = self.watcher_shutdown_tx.lock().await.take();
        let Some(shutdown_tx) = shutdown_tx else {
            return false;
        };
        let _ = shutdown_tx.send(());
        true
    }

    pub async fn install_project_file_watcher_shutdown_tx(&self, shutdown_tx: oneshot::Sender<()>) {
        let previous_tx = self
            .project_file_watcher_shutdown_tx
            .lock()
            .await
            .replace(shutdown_tx);
        if let Some(previous_tx) = previous_tx {
            let _ = previous_tx.send(());
        }
    }

    pub async fn shutdown_project_file_watcher(&self) -> bool {
        let shutdown_tx = self.project_file_watcher_shutdown_tx.lock().await.take();
        let Some(shutdown_tx) = shutdown_tx else {
            return false;
        };
        let _ = shutdown_tx.send(());
        true
    }

    pub async fn install_autosave_shutdown_tx(
        &self,
        shutdown_tx: mpsc::UnboundedSender<AutosaveShutdownRequest>,
    ) {
        let previous_tx = self.autosave_shutdown_tx.lock().await.replace(shutdown_tx);

        if let Some(previous_tx) = previous_tx {
            let (ack_tx, ack_rx) = oneshot::channel::<bool>();
            if previous_tx.send(ack_tx).is_err() {
                return;
            }
            match recv_oneshot_with_timeout(ack_rx, std::time::Duration::from_secs(5)).await {
                TimedOneShot::Received(true) => {}
                TimedOneShot::Received(false) => {
                    warn!("[autosave] Replaced autosave task reported failed shutdown");
                }
                TimedOneShot::SenderDropped => {
                    warn!("[autosave] Replaced autosave task dropped shutdown ack");
                }
                TimedOneShot::TimedOut => {
                    warn!("[autosave] Timed out waiting for replaced autosave task shutdown");
                }
            }
        }
    }

    pub async fn shutdown_autosave(&self, notebook_id: &str, timeout: std::time::Duration) -> bool {
        let shutdown_tx = self.autosave_shutdown_tx.lock().await.take();
        let Some(shutdown_tx) = shutdown_tx else {
            return true;
        };

        let (ack_tx, ack_rx) = oneshot::channel::<bool>();
        if shutdown_tx.send(ack_tx).is_err() {
            debug!(
                "[autosave] Shutdown skipped for {} (autosave task already exited)",
                notebook_id
            );
            return true;
        }

        match recv_oneshot_with_timeout(ack_rx, timeout).await {
            TimedOneShot::Received(true) => true,
            TimedOneShot::Received(false) => false,
            TimedOneShot::SenderDropped => {
                warn!(
                    "[autosave] Shutdown ack dropped for {} before final save completed",
                    notebook_id
                );
                false
            }
            TimedOneShot::TimedOut => {
                warn!(
                    "[autosave] Timed out waiting for final save during shutdown of {}",
                    notebook_id
                );
                false
            }
        }
    }
}

/// Per-room broadcast fan-out.
///
/// Groups the four channels that distribute room-scoped events to peer sync
/// loops: document-change notifications, kernel broadcasts (Comm), and
/// presence traffic. `presence` holds the per-peer state that `presence_tx`
/// relays between connections.
pub struct RoomBroadcasts {
    /// Broadcast channel to notify all peers in this room of doc changes.
    pub changed_tx: broadcast::Sender<()>,
    /// Broadcast channel to notify autosave that runtime state changed data
    /// serialized into the `.ipynb` file, such as cell outputs or execution
    /// counts. This deliberately excludes generic RuntimeStateDoc updates like
    /// lifecycle, project context, path, and last_saved.
    pub file_dirty_tx: broadcast::Sender<()>,
    /// Broadcast channel for kernel Comm events (ipywidget messages and custom
    /// widget traffic). Runtime lifecycle and environment progress live in
    /// RuntimeStateDoc, not on this transient event channel.
    pub kernel_broadcast_tx: broadcast::Sender<NotebookBroadcast>,
    /// Broadcast channel for presence frames (cursor, selection, kernel state).
    /// Carries raw presence bytes plus the peer_id to relay to other peers.
    pub presence_tx: broadcast::Sender<(String, Vec<u8>)>,
    /// Transient peer state (cursors, selections, kernel status).
    /// Protected by RwLock for concurrent reads from multiple peer loops.
    pub presence: Arc<RwLock<PresenceState>>,
}

impl Default for RoomBroadcasts {
    fn default() -> Self {
        let (changed_tx, _) = broadcast::channel(16);
        let (file_dirty_tx, _) = broadcast::channel(16);
        let (kernel_broadcast_tx, _) = broadcast::channel(KERNEL_BROADCAST_CAPACITY);
        let (presence_tx, _) = broadcast::channel(64);
        Self {
            changed_tx,
            file_dirty_tx,
            kernel_broadcast_tx,
            presence_tx,
            presence: Arc::new(RwLock::new(PresenceState::new())),
        }
    }
}

/// Per-room persistence bookkeeping.
///
/// Always present on every room. The optional `debouncer` field nests the
/// two debouncer channels that only exist for non-ephemeral rooms
/// (untitled-saved or file-backed); save-baseline snapshots and the
/// streaming-load gate are needed whether the room is ephemeral today or
/// will be promoted to file-backed later.
pub struct RoomPersistence {
    /// Serializes causal `.ipynb` checkpoint claims and atomic replacement.
    /// The coordinator is shared with blocking workers so no Tokio mutex is
    /// held across filesystem I/O.
    file_checkpoint: Arc<super::file_checkpoint::FileCheckpointCoordinator>,
    /// Debouncer channels - present only when the room writes to a
    /// persisted Automerge doc (`notebook-docs/*.automerge`). Ephemeral
    /// rooms keep this `None`, and so do rooms promoted via Save (the
    /// `.automerge` stream is not restarted post-promotion - see comment
    /// in `finalize_untitled_promotion`).
    ///
    /// The `Mutex<Option<...>>` wrapper lets the reaper `.take()` the
    /// debouncer at room removal so the watch sender drops, the
    /// debouncer task exits via its shutdown arm, and one final flush
    /// lands before the room is dropped. Without `.take()` the
    /// sender would only drop when the `Arc<NotebookRoom>` itself
    /// drops, which races the room map removal.
    debouncer: std::sync::Mutex<Option<PersistDebouncer>>,
    /// Cell sources as they were written to disk at last save.
    ///
    /// The file watcher compares disk content against this snapshot (not the
    /// live CRDT) to distinguish our own autosave writes from genuine external
    /// changes (git pull, external editor).
    pub last_save_sources: RwLock<HashMap<String, String>>,
    /// Highest committed save sequence allowed to update the primary-path
    /// watcher baselines. Post-`spawn_blocking` save continuations may resume
    /// out of order, so the sources and disk hash are advanced together under
    /// `last_save_sources` only when this sequence is not stale.
    primary_save_baseline_sequence: AtomicU64,
    /// Previous visible execution_id per cell, captured just before a new
    /// execution pointer replaces it. This is intentionally daemon-local
    /// persistence bookkeeping, not RuntimeStateDoc schema: it lets Save keep
    /// the last visible outputs on disk while a re-execution is still queued
    /// or running with no outputs yet.
    previous_visible_executions: std::sync::Mutex<HashMap<String, String>>,
    /// SHA-256 of the `.ipynb` bytes as this daemon last saw them on disk:
    /// seeded at load, refreshed after every self-write and every file-watcher
    /// read. `save_notebook_to_disk` refuses a primary-path save when the
    /// on-disk bytes no longer match this baseline — another writer (a second
    /// daemon, `git pull`) changed the file and the watcher has not reconciled
    /// it into the doc yet. The refusal is `Retryable`: the watcher merges the
    /// external content and refreshes this baseline, and the autosave
    /// debouncer's next tick writes the merged state. `None` means "no disk
    /// content observed yet" (untitled rooms, Save As targets) and disables
    /// the check.
    last_known_disk_hash: std::sync::Mutex<Option<[u8; 32]>>,
    /// Hazard flag set when initial file materialization fails. Partial batches
    /// remain in the room so failure handling cannot erase concurrent document
    /// truth; the persistence guard uses this flag to keep those partial bytes
    /// from overwriting the source `.ipynb`.
    load_failed: AtomicBool,
}

/// The debounced `.automerge` persist channels. See `spawn_persist_debouncer`.
pub struct PersistDebouncer {
    /// Channel to send doc bytes to the debounced persistence task.
    /// Uses watch for "latest value" semantics — always keeps most recent state.
    pub persist_tx: watch::Sender<Option<Vec<u8>>>,
    /// Channel to request a synchronous flush from the persist debouncer.
    /// Receiver handles the request and replies on the oneshot after the write
    /// completes. Used by room eviction to guarantee disk consistency *before*
    /// the room is removed from the map, closing the race where a fast reconnect
    /// would load stale bytes from the still-pending .automerge file.
    pub flush_request_tx: mpsc::UnboundedSender<FlushRequest>,
}

impl RoomPersistence {
    /// Build a persistence struct with no active debouncer (ephemeral rooms).
    pub fn ephemeral() -> Self {
        Self {
            file_checkpoint: Arc::new(super::file_checkpoint::FileCheckpointCoordinator::default()),
            debouncer: std::sync::Mutex::new(None),
            last_save_sources: RwLock::new(HashMap::new()),
            primary_save_baseline_sequence: AtomicU64::new(0),
            previous_visible_executions: std::sync::Mutex::new(HashMap::new()),
            last_known_disk_hash: std::sync::Mutex::new(None),
            load_failed: AtomicBool::new(false),
        }
    }

    /// Build a persistence struct with an active .automerge debouncer.
    pub fn with_debouncer(
        persist_tx: watch::Sender<Option<Vec<u8>>>,
        flush_request_tx: mpsc::UnboundedSender<FlushRequest>,
    ) -> Self {
        Self {
            file_checkpoint: Arc::new(super::file_checkpoint::FileCheckpointCoordinator::default()),
            debouncer: std::sync::Mutex::new(Some(PersistDebouncer {
                persist_tx,
                flush_request_tx,
            })),
            last_save_sources: RwLock::new(HashMap::new()),
            primary_save_baseline_sequence: AtomicU64::new(0),
            previous_visible_executions: std::sync::Mutex::new(HashMap::new()),
            last_known_disk_hash: std::sync::Mutex::new(None),
            load_failed: AtomicBool::new(false),
        }
    }

    /// Record the `.ipynb` bytes this daemon just observed on disk (loaded,
    /// wrote, or ingested via the file watcher). Future primary-path saves
    /// compare the on-disk file against this baseline.
    pub fn note_disk_content(&self, bytes: &[u8]) {
        let digest: [u8; 32] = sha2::Sha256::digest(bytes).into();
        if let Ok(mut hash) = self.last_known_disk_hash.lock() {
            *hash = Some(digest);
        }
    }

    /// Advance the primary-path file watcher baselines monotonically.
    ///
    /// The async sources lock serializes post-save continuations. Checking the
    /// sequence after acquiring it prevents an older completion from
    /// overwriting both the source snapshot and disk fingerprint installed by
    /// a newer committed save.
    pub async fn note_primary_save_baseline(
        &self,
        save_sequence: u64,
        sources: HashMap<String, String>,
        bytes: &[u8],
    ) -> bool {
        let mut saved = self.last_save_sources.write().await;
        if self.primary_save_baseline_sequence.load(Ordering::Acquire) > save_sequence {
            return false;
        }
        *saved = sources;
        self.note_disk_content(bytes);
        self.primary_save_baseline_sequence
            .store(save_sequence, Ordering::Release);
        true
    }

    /// The baseline recorded by [`Self::note_disk_content`], if any.
    pub fn known_disk_hash(&self) -> Option<[u8; 32]> {
        self.last_known_disk_hash.lock().ok().and_then(|h| *h)
    }

    /// True when `bytes` differ from the recorded disk baseline. `false` when
    /// no baseline exists (nothing observed yet — the check is disabled).
    pub fn disk_content_diverged(&self, bytes: &[u8]) -> bool {
        match self.known_disk_hash() {
            Some(baseline) => {
                let digest: [u8; 32] = sha2::Sha256::digest(bytes).into();
                digest != baseline
            }
            None => false,
        }
    }

    pub fn remember_previous_visible_execution(&self, cell_id: &str, execution_id: &str) {
        if let Ok(mut previous) = self.previous_visible_executions.lock() {
            previous.insert(cell_id.to_string(), execution_id.to_string());
        }
    }

    pub fn previous_visible_execution(&self, cell_id: &str) -> Option<String> {
        self.previous_visible_executions
            .lock()
            .ok()
            .and_then(|previous| previous.get(cell_id).cloned())
    }

    /// Reserve request order before formatting, blob resolution, or
    /// serialization begins.
    pub(crate) fn claim_file_checkpoint(
        &self,
    ) -> Result<super::file_checkpoint::SaveSequenceClaim, super::file_checkpoint::SaveClaimError>
    {
        self.file_checkpoint.reserve()
    }

    /// Clone the room-owned checkpoint coordinator for a blocking completion.
    pub(crate) fn file_checkpoint_coordinator(
        &self,
    ) -> Arc<super::file_checkpoint::FileCheckpointCoordinator> {
        Arc::clone(&self.file_checkpoint)
    }

    /// Newest save sequence that reached a committed ordering barrier.
    pub(crate) fn latest_file_checkpoint_barrier_sequence(&self) -> u64 {
        self.file_checkpoint.latest_barrier_sequence()
    }

    pub(crate) fn restore_file_checkpoint(
        &self,
        checkpoint: super::file_checkpoint::FileCheckpoint,
    ) {
        self.primary_save_baseline_sequence
            .fetch_max(checkpoint.save_sequence, Ordering::AcqRel);
        self.file_checkpoint.restore(checkpoint);
    }

    pub fn clear_previous_visible_execution(&self, cell_id: &str) {
        if let Ok(mut previous) = self.previous_visible_executions.lock() {
            previous.remove(cell_id);
        }
    }

    /// True when this room has an active `.automerge` debouncer.
    pub fn has_debouncer(&self) -> bool {
        self.lock_debouncer().is_some()
    }

    /// Send the latest doc bytes to the debouncer. No-op when no
    /// debouncer is wired up (ephemeral rooms). The watch sender keeps
    /// only the most recent value, so a fast burst of edits collapses
    /// to one persist write.
    pub fn enqueue_persist_bytes(&self, bytes: Vec<u8>) {
        if let Some(d) = self.lock_debouncer().as_ref() {
            let _ = d.persist_tx.send(Some(bytes));
        }
    }

    /// Send a synchronous flush request. Returns the ack receiver if a
    /// debouncer is wired up and the send succeeded; `None` when the
    /// room is ephemeral or the debouncer task has already exited.
    /// Callers must `.await` the receiver outside any held lock.
    pub fn request_flush(&self) -> Option<tokio::sync::oneshot::Receiver<bool>> {
        let guard = self.lock_debouncer();
        let d = guard.as_ref()?;
        let (ack_tx, ack_rx) = tokio::sync::oneshot::channel::<bool>();
        if d.flush_request_tx.send(ack_tx).is_ok() {
            Some(ack_rx)
        } else {
            None
        }
    }

    /// Take the debouncer out of the room. Used by the reaper at room
    /// removal: dropping the returned `PersistDebouncer` drops the
    /// `watch::Sender` and the `mpsc::UnboundedSender`, which makes
    /// the persist task exit via its shutdown arm with one final
    /// flush. Returns `None` for ephemeral rooms or if a prior caller
    /// already took it.
    pub fn take_debouncer(&self) -> Option<PersistDebouncer> {
        self.lock_debouncer().take()
    }

    /// Lock the debouncer Mutex. Recovers from poisoning by treating
    /// the inner value as still usable — a panicking caller would only
    /// be writing the field, never mutating the inner channels.
    fn lock_debouncer(&self) -> std::sync::MutexGuard<'_, Option<PersistDebouncer>> {
        self.debouncer
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Flag a failed initial materialization so persistence preserves the
    /// source file until explicit recovery.
    pub fn mark_load_failed(&self) {
        self.load_failed.store(true, Ordering::Release);
    }

    /// True if initial materialization failed and has not been recovered.
    pub fn load_failed(&self) -> bool {
        self.load_failed.load(Ordering::Acquire)
    }

    /// Clear the failed-load hazard after successful recovery.
    pub fn clear_load_failed(&self) {
        self.load_failed.store(false, Ordering::Release);
    }
}

/// Room-owned lifecycle for the initial `.ipynb` materialization.
///
/// This state belongs to the room rather than to any peer connection. A peer
/// may stop waiting (or disconnect) without cancelling the shared load. The
/// generation makes task completion conditional: an older task cannot publish
/// `Ready` or `Failed` over a newer attempt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RoomInitialLoadState {
    NotNeeded { generation: u64 },
    Loading { generation: u64 },
    Ready { generation: u64, cell_count: usize },
    Failed { generation: u64, reason: String },
}

impl RoomInitialLoadState {
    pub fn generation(&self) -> u64 {
        match self {
            Self::NotNeeded { generation }
            | Self::Loading { generation }
            | Self::Ready { generation, .. }
            | Self::Failed { generation, .. } => *generation,
        }
    }

    pub fn is_loading(&self) -> bool {
        matches!(self, Self::Loading { .. })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RoomInitialLoadStart {
    Started { generation: u64 },
    Observing { generation: u64 },
}

/// Single-flight, observable initial-load state for one notebook room.
pub struct RoomInitialLoad {
    lifecycle: Arc<RoomLifecycle>,
    /// Legacy wire projection. The authoritative state is `lifecycle`; this
    /// sender only preserves the pre-progressive session protocol during the
    /// room-substrate slice.
    state_tx: watch::Sender<RoomInitialLoadState>,
}

impl Default for RoomInitialLoad {
    fn default() -> Self {
        Self::new(RoomLifecycle::test_default())
    }
}

impl RoomInitialLoad {
    pub(crate) fn new(lifecycle: Arc<RoomLifecycle>) -> Self {
        let initial = Self::project_state(&lifecycle.source_state());
        let (state_tx, _) = watch::channel(initial);
        Self {
            lifecycle,
            state_tx,
        }
    }

    pub(crate) fn project_state(source: &RoomSourceState) -> RoomInitialLoadState {
        let status = source.status();
        match source {
            RoomSourceState::Preparing(_) | RoomSourceState::Publishing(_) => {
                RoomInitialLoadState::Loading {
                    generation: status.generation,
                }
            }
            RoomSourceState::Ready(_)
                if status.generation == 0
                    && matches!(status.fingerprint, RoomSourceFingerprint::NotApplicable) =>
            {
                RoomInitialLoadState::NotNeeded {
                    generation: status.generation,
                }
            }
            RoomSourceState::Ready(_) => RoomInitialLoadState::Ready {
                generation: status.generation,
                cell_count: status.progress.completed,
            },
            RoomSourceState::Failed(_) => RoomInitialLoadState::Failed {
                generation: status.generation,
                reason: status
                    .error
                    .as_ref()
                    .map(|error| error.message.clone())
                    .unwrap_or_else(|| "source failed".to_string()),
            },
        }
    }

    fn refresh_legacy(&self) {
        self.state_tx
            .send_replace(Self::project_state(&self.lifecycle.source_state()));
    }

    pub fn subscribe(&self) -> watch::Receiver<RoomInitialLoadState> {
        self.state_tx.subscribe()
    }

    /// Subscribe to the authoritative source axis rather than the temporary
    /// legacy projection channel. Durability failures and source conflicts
    /// transition the lifecycle directly, so long-lived waiters must observe
    /// this channel to avoid missing a terminal state.
    pub(crate) fn subscribe_authoritative(&self) -> watch::Receiver<RoomSourceState> {
        self.lifecycle.subscribe_source()
    }

    pub fn state(&self) -> RoomInitialLoadState {
        Self::project_state(&self.lifecycle.source_state())
    }

    /// Publish `Loading` before a file-backed room becomes discoverable.
    /// The actual source task claims this generation with [`Self::begin`].
    pub fn mark_required(&self) {
        self.lifecycle.mark_source_required();
        self.refresh_legacy();
    }

    /// Start the first load, or join the generation already loading/settled.
    /// `Ready` is sticky for the room lifetime so a valid zero-cell notebook is
    /// not mistaken for "never loaded." `Failed` is also sticky: retrying a
    /// partially materialized document requires an explicit reconciliation
    /// decision rather than blindly replaying file cells over live room state.
    pub fn begin(&self) -> (RoomInitialLoadStart, watch::Receiver<RoomInitialLoadState>) {
        if matches!(self.state(), RoomInitialLoadState::NotNeeded { .. }) {
            self.lifecycle.mark_source_required();
        }
        let start = match self.lifecycle.begin_source() {
            RoomSourceStart::Started { generation } => RoomInitialLoadStart::Started { generation },
            RoomSourceStart::Observing { generation } => {
                RoomInitialLoadStart::Observing { generation }
            }
        };
        self.refresh_legacy();
        (start, self.subscribe())
    }

    /// Atomically advance a failed generation and claim its source task.
    ///
    /// Production retry uses this combined transition so a resident room can
    /// never expose a new `Loading` generation without an owner between two
    /// separate calls. The returned generation must immediately be wrapped in
    /// a `RoomInitialLoadClaim`, whose drop guard terminalizes cancellation.
    pub(crate) fn retry_failed_claimed(&self) -> Option<u64> {
        let generation = self.lifecycle.retry_failed_claimed()?;
        self.refresh_legacy();
        Some(generation)
    }

    pub(crate) fn resume_failed_staged_claimed(&self) -> Option<u64> {
        let generation = self.lifecycle.resume_failed_staged_claimed()?;
        self.refresh_legacy();
        Some(generation)
    }

    /// Publish a coherent external recovery after a terminal source failure.
    ///
    /// File-watcher reconciliation and an explicit successful save establish a
    /// new authoritative baseline without replaying the failed source task.
    /// Advance the generation so waiters can distinguish that recovery from
    /// the failed attempt it supersedes.
    pub fn recover_failed(
        &self,
        cell_count: usize,
        projection: Arc<runtimed_client::protocol::NotebookProjection>,
    ) -> Option<u64> {
        let heads = projection.notebook_heads.clone();
        let generation = self
            .lifecycle
            .recover_failed(cell_count, heads, projection)?;
        self.refresh_legacy();
        Some(generation)
    }

    /// Wait for the current source generation to settle.
    ///
    /// Dropping this future only drops its watch receiver. It cannot cancel or
    /// mutate the room-owned source operation.
    pub async fn wait_until_settled(&self) -> RoomInitialLoadState {
        let state = self
            .lifecycle
            .wait_for_source_settled(std::time::Duration::from_secs(120))
            .await
            .into_current();
        Self::project_state(&state)
    }

    pub fn complete_ready(&self, generation: u64, cell_count: usize) -> bool {
        let heads = self
            .lifecycle
            .availability()
            .status()
            .document_heads
            .clone();
        self.complete_ready_with_heads(generation, cell_count, heads)
    }

    pub(crate) fn complete_ready_with_heads(
        &self,
        generation: u64,
        cell_count: usize,
        document_heads: Vec<String>,
    ) -> bool {
        let completed = self
            .lifecycle
            .complete_ready(generation, cell_count, document_heads);
        if completed {
            self.refresh_legacy();
        }
        completed
    }

    pub fn complete_failed(&self, generation: u64, reason: String) -> bool {
        let completed = self
            .lifecycle
            .complete_failed(generation, "source_failed", reason);
        if completed {
            self.refresh_legacy();
        }
        completed
    }

    pub fn is_loading(&self) -> bool {
        self.lifecycle.source_state().is_in_progress()
    }

    #[cfg(test)]
    pub fn task_claimed_for_test(&self) -> bool {
        self.lifecycle.task_claimed()
    }

    #[cfg(test)]
    fn reset_loading_for_test(&self) {
        self.lifecycle.reset_in_progress();
        self.refresh_legacy();
    }
}

/// Per-connection accounting for room eviction + `is_draining` reporting.
///
/// - `active_peers`: live counter, drives kernel teardown when it hits zero.
/// - `had_peers`: one-way latch flipped on first connect. Kept because the
///   Python SDK's `is_draining = (active_peers == 0 && had_peers)` check
///   needs to distinguish "brand-new, no one has connected yet" from
///   "drained, awaiting kernel teardown." Exposed on the `RoomInfo` wire type.
/// - `last_kernel_torn_down_at`: unix-epoch seconds when the room finished
///   kernel teardown after the last peer left. `0` means "never torn down"
///   (still active, still has a kernel, or the room was just created). The
///   ghost-room reaper uses this to remove rooms that have been kernel-less
///   and peer-less for longer than `GHOST_ROOM_TTL`. Cleared back to `0`
///   when a peer reconnects so the reaper won't fire on a live room.
/// - `connection_generation`: monotonic counter bumped every time a peer
///   connects. Kernel teardown snapshots it at start and re-checks before
///   every destructive step; a higher value means a peer reconnected
///   mid-teardown and the teardown task aborts before killing the kernel.
///   Also re-checked by the ghost reaper at remove time so a fast
///   disconnect/reconnect/disconnect cycle cannot land the reaper on a
///   room that was just touched.
pub struct RoomConnections {
    pub active_peers: AtomicUsize,
    pub had_peers: AtomicBool,
    pub last_kernel_torn_down_at: AtomicU64,
    pub connection_generation: AtomicU64,
    /// `true` while the kernel-teardown task is in the destructive
    /// section (ShutdownKernel RPC plus handle/request-tx clear). A
    /// peer that joined during this window saw `has_kernel = true` but
    /// the kernel is about to die: the connect path checks this flag
    /// and forces a fresh auto-launch instead of trusting the stale
    /// "has_kernel" snapshot.
    pub kernel_teardown_destructive: AtomicBool,
    /// In-flight handshake reservations. Bumped the moment a caller
    /// receives an `Arc<NotebookRoom>` from the registry; decremented
    /// when the handshake either commits (incrementing `active_peers`)
    /// or aborts. The room reaper requires `reservations == 0` in
    /// addition to `active_peers == 0` so a racing reconnect that has
    /// the Arc but has not yet bumped `active_peers` is not reaped out
    /// from under it.
    pub reservations: AtomicUsize,
}

impl Default for RoomConnections {
    fn default() -> Self {
        Self {
            active_peers: AtomicUsize::new(0),
            had_peers: AtomicBool::new(false),
            last_kernel_torn_down_at: AtomicU64::new(0),
            connection_generation: AtomicU64::new(0),
            kernel_teardown_destructive: AtomicBool::new(false),
            reservations: AtomicUsize::new(0),
        }
    }
}

impl RoomConnections {
    /// Unix-epoch seconds when the room last finished kernel teardown with
    /// no peers, or `None` if the room is currently active or has never had
    /// kernel teardown.
    pub fn last_kernel_torn_down_at(&self) -> Option<u64> {
        match self.last_kernel_torn_down_at.load(Ordering::Relaxed) {
            0 => None,
            ts => Some(ts),
        }
    }

    /// Stamp the teardown timestamp to "now" (unix epoch seconds).
    pub fn stamp_kernel_torn_down_now(&self) {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.last_kernel_torn_down_at.store(now, Ordering::Relaxed);
    }

    /// Clear the teardown timestamp. Called on peer reconnect so the
    /// ghost-room reaper does not race with an active room.
    pub fn clear_kernel_torn_down(&self) {
        self.last_kernel_torn_down_at.store(0, Ordering::Relaxed);
    }

    /// Bump the connection generation. Peer connect calls this so any
    /// in-flight kernel teardown or ghost-reaper sweep that snapshotted
    /// the previous value can detect "a peer happened" and abort.
    pub fn bump_connection_generation(&self) -> u64 {
        self.connection_generation.fetch_add(1, Ordering::Relaxed) + 1
    }

    /// Snapshot the current connection generation. Kernel teardown and
    /// the ghost reaper take this at start and re-compare under the
    /// rooms lock before destructive ops.
    pub fn connection_generation(&self) -> u64 {
        self.connection_generation.load(Ordering::Relaxed)
    }

    /// Number of in-flight handshake reservations against this room. The
    /// reaper combines this with `active_peers` to decide whether a room
    /// is truly peer-less. Held by `ReservationGuard`.
    pub fn reservations(&self) -> usize {
        self.reservations.load(Ordering::Relaxed)
    }
}

/// RAII guard for a handshake reservation against a room.
///
/// Bumps `RoomConnections::reservations` on construction, decrements on
/// drop. Hand-off contract: callers that receive an `Arc<NotebookRoom>`
/// from the registry hold a guard until the handshake either reaches
/// `active_peers.fetch_add(1)` or aborts. The reaper's peer-less
/// predicate is `active_peers == 0 && reservations == 0`, which closes
/// the gap where the Arc has been cloned out of the registry but the
/// active-peer increment has not yet landed.
///
/// The guard intentionally does not implement `Clone`; each
/// reservation is a single slot.
#[must_use = "drop the guard when the handshake commits or aborts; otherwise the reservation leaks until the room itself is dropped"]
pub struct ReservationGuard {
    room: Arc<NotebookRoom>,
}

impl ReservationGuard {
    /// Take a reservation on `room`. Increments `reservations` once.
    pub fn new(room: Arc<NotebookRoom>) -> Self {
        room.connections
            .reservations
            .fetch_add(1, Ordering::Relaxed);
        Self { room }
    }
}

impl Drop for ReservationGuard {
    fn drop(&mut self) {
        // Saturating-decrement guard against an accidental double-drop
        // (which would only happen on a misuse like manually `Drop`-ing
        // the value twice via `unsafe`; safe code can't reach it).
        self.room
            .connections
            .reservations
            .fetch_sub(1, Ordering::Relaxed);
    }
}

pub(crate) struct SourceReconciliationClaim {
    room: Arc<NotebookRoom>,
}

impl Drop for SourceReconciliationClaim {
    fn drop(&mut self) {
        self.room
            .source_reconciliation_claimed
            .store(false, Ordering::Release);
    }
}

pub struct NotebookRoom {
    /// Permanent, immutable UUID for this room, independent of the display
    /// path or string lookup keys used by callers. Rooms are still looked up
    /// by string key today; this identity is carried alongside that map for
    /// stable cross-process references.
    pub id: uuid::Uuid,
    /// The canonical Automerge notebook document.
    pub doc: Arc<RwLock<NotebookDoc>>,
    /// Broadcast channels + presence state for fan-out to peer sync loops.
    pub broadcasts: RoomBroadcasts,
    /// Disk persistence state for Automerge/doc save bookkeeping.
    pub persistence: RoomPersistence,
    /// Room-owned, generation-bearing initial file materialization lifecycle.
    pub initial_load: RoomInitialLoad,
    /// Authoritative source and availability axes plus durable staged artifacts.
    pub(crate) lifecycle: Arc<RoomLifecycle>,
    /// Serializes source, peer, daemon, and file-checkpoint journal records.
    pub(crate) durability: Arc<super::durability::RoomDurability>,
    /// Atomic lease for a reconciliation that may span async disk preparation.
    pub(crate) source_reconciliation_claimed: AtomicBool,
    /// File binding owner: canonical .ipynb path, file watcher, autosave.
    pub file_binding: NotebookFileBinding,
    /// Notebook identity: persist_path and working_dir.
    pub identity: RoomIdentity,
    /// Per-connection accounting: active_peers + had_peers.
    pub connections: RoomConnections,
    /// Hosted rooms are cloud-authoritative and must not auto-launch local kernels.
    /// Read via `is_hosted()`; set once via `mark_hosted()` before peers attach.
    pub(crate) hosted: AtomicBool,
    /// Blob store for output manifests.
    pub blob_store: Arc<BlobStore>,
    /// Trust state for this notebook (for auto-launch decisions).
    pub trust_state: Arc<RwLock<TrustState>>,
    /// Daemon-local package allowlist for familiar dependency auto-approval.
    ///
    /// `TrustedPackageStore` is `pub(crate)`, but `NotebookRoom` reaches
    /// visibility `pub` via `Daemon::test_get_room` (a `#[doc(hidden)]` test
    /// escape hatch). The store is not consumed across the crate boundary;
    /// allow the lint here rather than widen the store's surface.
    #[allow(private_interfaces)]
    pub trusted_packages: crate::trusted_packages::TrustedPackageStore,
    /// Per-notebook RuntimeStateDoc handle — daemon-authoritative ephemeral state
    /// (kernel status, queue, env sync). Clients sync read-only.
    /// Uses `std::sync::Mutex` internally (no `.await` needed).
    pub state: runtime_doc::RuntimeStateHandle,
    /// Per-notebook CommsDoc handle — widget comm state keyed by comm_id.
    /// RuntimeStateDoc remains the topology/membership source of truth.
    pub comms: runtime_doc::CommsDocHandle,
    /// Per-notebook CommentsDoc handle for authored comment threads.
    pub comments: comments_doc::CommentsDocHandle,
    /// Disk-backed sidecar store for CommentsDoc persistence.
    #[allow(private_interfaces)]
    pub comments_store: CommentsSidecarStore,
    /// Handle to the runtime agent subprocess that owns this notebook's kernel.
    /// Set by `LaunchKernel` or `auto_launch_kernel` when spawned.
    pub runtime_agent_handle: Arc<Mutex<Option<crate::runtime_agent_handle::RuntimeAgentHandle>>>,
    /// Environment path used by a runtime-agent-backed kernel, for GC protection.
    pub runtime_agent_env_path: Arc<RwLock<Option<PathBuf>>>,
    /// The environment config used at kernel launch. Stored so
    /// check_and_broadcast_sync_state can detect dependency drift
    /// without accessing the runtime agent's kernel directly.
    pub runtime_agent_launched_config: Arc<RwLock<Option<LaunchedEnvConfig>>>,
    /// Channel for sending RPC requests (LaunchKernel, Interrupt, etc.) to the
    /// runtime agent's sync connection. Set when runtime agent connects via
    /// socket, cleared on disconnect.
    pub runtime_agent_request_tx: Arc<Mutex<Option<RuntimeAgentRequestSender>>>,
    /// Per-spawn oneshot sender for the connect handler to signal that this
    /// generation's runtime agent has established its sync connection.
    /// Replaced on each agent spawn; previous sender is dropped (cancelling
    /// the old receiver). The connect handler `take()`s the sender.
    pub(crate) pending_runtime_agent_connect_tx: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    /// Monotonic generation counter for runtime agent spawns. Incremented
    /// before each spawn installs its oneshot/channels. Used by
    /// `reset_starting_state` to detect interleaving spawns: the generation
    /// is checked while holding each field's lock, so if it hasn't changed,
    /// no newer spawn has (or can) store a value in that field.
    pub(crate) runtime_agent_generation: Arc<AtomicU64>,
    /// Monotonic counter for execution queue ordering.
    /// The coordinator bumps this for each ExecuteCell and stamps the seq
    /// on the execution entry. The runtime agent sorts by seq to determine order.
    pub next_queue_seq: Arc<std::sync::atomic::AtomicU64>,
    /// The runtime_agent_id of the currently expected runtime agent. Used by the
    /// sync handler to validate connections and prevent stale cleanup from
    /// clobbering state.
    pub current_runtime_agent_id: Arc<RwLock<Option<String>>>,
}

impl NotebookRoom {
    pub(crate) fn try_claim_source_reconciliation(
        self: &Arc<Self>,
    ) -> Option<SourceReconciliationClaim> {
        self.source_reconciliation_claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| SourceReconciliationClaim {
                room: Arc::clone(self),
            })
    }

    /// True when this room is bridged to a hosted cloud notebook.
    pub fn is_hosted(&self) -> bool {
        self.hosted.load(Ordering::Relaxed)
    }

    /// Mark this room as hosted. This flag is monotonic for the room lifetime.
    pub fn mark_hosted(&self) {
        self.hosted.store(true, Ordering::Relaxed);
    }

    /// Create a fresh room, ignoring any persisted state.
    ///
    /// The .ipynb file is the source of truth. When a room is created, we start
    /// with an empty Automerge doc and let the first client populate it from
    /// their local .ipynb file. This prevents stale outputs from previous
    /// sessions from accumulating.
    ///
    /// Any existing persisted doc is deleted to avoid clutter.
    ///
    /// Note: Trust state is initialized from disk because the Automerge doc
    /// starts empty (first client hasn't synced yet). Once the doc is populated,
    /// `check_and_update_trust_state` keeps room.trust_state current.
    #[cfg(test)]
    pub fn new_fresh(
        uuid: uuid::Uuid,
        path: Option<PathBuf>,
        docs_dir: &Path,
        blob_store: Arc<BlobStore>,
        ephemeral: bool,
    ) -> Self {
        // A fresh room has `load_failed = false` by default, so the zeroing
        // guard does not fire for it: a legitimately-empty room from any init
        // path always saves. Tests that need the guard to fire drive a doc
        // empty and then call `mark_load_failed()` to model a failed load.
        Self::new_fresh_with_trusted_packages(
            uuid,
            path,
            docs_dir,
            blob_store,
            ephemeral,
            crate::trusted_packages::TrustedPackageStore::unavailable("not configured"),
        )
        .expect("create test notebook room runtime state")
    }

    #[allow(private_interfaces)]
    pub fn new_fresh_with_trusted_packages(
        uuid: uuid::Uuid,
        mut path: Option<PathBuf>,
        docs_dir: &Path,
        blob_store: Arc<BlobStore>,
        ephemeral: bool,
        trusted_packages: crate::trusted_packages::TrustedPackageStore,
    ) -> anyhow::Result<Self> {
        let id = uuid;
        // Use uuid string as the notebook_id for doc filename derivation and NotebookDoc construction.
        let notebook_id_str = uuid.to_string();

        let filename = notebook_doc_filename(&notebook_id_str);
        let persist_path = docs_dir.join(&filename);

        // All persistent rooms recover from the append-only journal first.
        // The legacy `.automerge` file is only a migration input for untitled
        // rooms that have no journal yet.
        let runtimed_actor = "runtimed";
        let recovery_journal =
            super::recovery::RecoveryJournal::new(persist_path.with_extension("recovery"));
        // UUID-only attach after restart still represents the same file-backed
        // room. Recover its canonical source path from the authoritative
        // journal before fingerprinting disk; treating a missing caller path
        // as empty bytes invents a false source conflict.
        if !ephemeral && path.is_none() {
            match recovery_journal.latest_record() {
                Ok(super::recovery::RecoveryLatestOutcome::Recovered(recovery)) => {
                    path = recovery.record.manifest.canonical_path.clone();
                }
                Ok(super::recovery::RecoveryLatestOutcome::Unavailable { .. }) => {}
                Err(error) => warn!(
                    "[notebook-sync] Could not recover canonical source path for {}: {}",
                    id, error
                ),
            }
        }
        let (source_bytes, source_read_error) = match path.as_ref() {
            Some(source_path) => match std::fs::read(source_path) {
                Ok(bytes) => (bytes, None),
                Err(error) => (
                    Vec::new(),
                    Some(format!(
                        "source_conflict: journal source {} could not be read: {}; recovered state was preserved",
                        source_path.display(),
                        error
                    )),
                ),
            },
            None => (Vec::new(), None),
        };
        let source_fingerprint = super::recovery::source_fingerprint(&source_bytes);
        let mut recovered_record = None;
        let mut startup_source_conflict = None;
        let mut startup_durability_degraded = None;
        let mut recovered_doc = None;
        if !ephemeral {
            match recovery_journal.load(source_fingerprint) {
                Ok(super::recovery::RecoveryLoadOutcome::Match(recovery)) => {
                    if recovery.record.manifest.notebook_id != id {
                        anyhow::bail!(
                            "recovery journal notebook identity {} does not match room {}",
                            recovery.record.manifest.notebook_id,
                            id
                        );
                    }
                    let loaded = NotebookDoc::load_with_actor(
                        &recovery.record.automerge_snapshot,
                        runtimed_actor,
                    )
                    .map_err(|error| anyhow::anyhow!("load recovered notebook: {error}"))?;
                    let recovered_schema = loaded.schema_version().ok_or_else(|| {
                        anyhow::anyhow!(
                            "recovery journal for {id} has no valid NotebookDoc schema version"
                        )
                    })?;
                    if recovered_schema != recovery.record.manifest.notebook_schema_version {
                        anyhow::bail!(
                            "recovery journal schema manifest {} does not match snapshot schema {} for {}",
                            recovery.record.manifest.notebook_schema_version,
                            recovered_schema,
                            id
                        );
                    }
                    info!(
                        "[notebook-sync] Restored journal generation {} for {}",
                        recovery.record.manifest.source_generation, id
                    );
                    // An unreadable source is not evidence that its bytes match
                    // the journal, even in the rare case where the recorded
                    // fingerprint is the empty-content digest.
                    startup_source_conflict = source_read_error.clone();
                    recovered_doc = Some(loaded);
                    recovered_record = Some(recovery);
                }
                Ok(super::recovery::RecoveryLoadOutcome::SourceConflict {
                    recovery,
                    current_source_fingerprint,
                }) => {
                    if recovery.record.manifest.notebook_id != id {
                        anyhow::bail!(
                            "recovery journal notebook identity {} does not match room {}",
                            recovery.record.manifest.notebook_id,
                            id
                        );
                    }
                    let loaded = NotebookDoc::load_with_actor(
                        &recovery.record.automerge_snapshot,
                        runtimed_actor,
                    )
                    .map_err(|error| anyhow::anyhow!("load conflicted recovery: {error}"))?;
                    let recovered_schema = loaded.schema_version().ok_or_else(|| {
                        anyhow::anyhow!(
                            "recovery journal for {id} has no valid NotebookDoc schema version"
                        )
                    })?;
                    if recovered_schema != recovery.record.manifest.notebook_schema_version {
                        anyhow::bail!(
                            "recovery journal schema manifest {} does not match snapshot schema {} for {}",
                            recovery.record.manifest.notebook_schema_version,
                            recovered_schema,
                            id
                        );
                    }
                    let reason = source_read_error.clone().unwrap_or_else(|| {
                        format!(
                            "source_conflict: disk fingerprint {} differs from recovery fingerprint {}; both were preserved",
                            current_source_fingerprint.to_hex(),
                            recovery.record.manifest.source_fingerprint.to_hex()
                        )
                    });
                    warn!("[notebook-sync] {reason}");
                    startup_source_conflict = Some(reason);
                    recovered_doc = Some(loaded);
                    recovered_record = Some(recovery);
                }
                Ok(super::recovery::RecoveryLoadOutcome::Unavailable { .. }) => {}
                Err(error) => {
                    // Keep the journal intact. Source preparation will either
                    // append successfully after a repairable tail or enter a
                    // visible degraded state; never delete recovery implicitly.
                    warn!(
                        "[notebook-sync] Could not inspect recovery journal for {}: {}",
                        id, error
                    );
                }
            }
        }

        let mut doc = if let Some(recovered) = recovered_doc {
            recovered
        } else if !ephemeral && path.is_none() && persist_path.exists() {
            info!(
                "[notebook-sync] Loading persisted doc for untitled notebook: {:?}",
                persist_path
            );
            NotebookDoc::load_or_create_with_actor(&persist_path, &notebook_id_str, runtimed_actor)
        } else {
            // NotebookDoc stores actor ids as strings.
            NotebookDoc::new_with_actor(&notebook_id_str, runtimed_actor)
        };
        // Spawn debounced persistence task (watch channel keeps latest value only)
        // Ephemeral rooms skip persistence entirely.
        // Store ephemeral flag in doc metadata so the GUI can show a banner
        if ephemeral {
            let _ = doc.set_metadata("ephemeral", "true");
        }
        let runtime_state_doc_id = doc.ensure_runtime_state_doc_id(&notebook_id_str)?;
        let _comms_doc_id = doc.ensure_comms_doc_id(&notebook_id_str)?;

        let (persist_tx, flush_request_tx) = if ephemeral {
            (None, None)
        } else {
            let (persist_tx, persist_rx) = watch::channel::<Option<Vec<u8>>>(None);
            let (flush_tx, flush_rx) = mpsc::unbounded_channel::<FlushRequest>();
            spawn_persist_debouncer(persist_rx, flush_rx, persist_path.clone());
            (Some(persist_tx), Some(flush_tx))
        };

        let trust_state = match &path {
            // Untitled notebooks have no .ipynb on disk — trust signature lives
            // in the persisted Automerge doc we just loaded.
            None => match doc.get_metadata_snapshot() {
                Some(snapshot) => verify_trust_from_snapshot(&snapshot, &trusted_packages),
                None => TrustState {
                    status: runt_trust::TrustStatus::NoDependencies,
                    info: runt_trust::TrustInfo {
                        status: runt_trust::TrustStatus::NoDependencies,
                        uv_dependencies: vec![],
                        approved_uv_dependencies: vec![],
                        conda_dependencies: vec![],
                        approved_conda_dependencies: vec![],
                        conda_channels: vec![],
                        approved_conda_channels: vec![],
                        pixi_dependencies: vec![],
                        approved_pixi_dependencies: vec![],
                        pixi_pypi_dependencies: vec![],
                        approved_pixi_pypi_dependencies: vec![],
                        pixi_channels: vec![],
                        approved_pixi_channels: vec![],
                    },
                    pending_launch: false,
                },
            },
            Some(_) if recovered_record.is_some() => match doc.get_metadata_snapshot() {
                Some(snapshot) => verify_trust_from_snapshot(&snapshot, &trusted_packages),
                None => TrustState {
                    status: runt_trust::TrustStatus::NoDependencies,
                    info: runt_trust::TrustInfo {
                        status: runt_trust::TrustStatus::NoDependencies,
                        uv_dependencies: vec![],
                        approved_uv_dependencies: vec![],
                        conda_dependencies: vec![],
                        approved_conda_dependencies: vec![],
                        conda_channels: vec![],
                        approved_conda_channels: vec![],
                        pixi_dependencies: vec![],
                        approved_pixi_dependencies: vec![],
                        pixi_pypi_dependencies: vec![],
                        approved_pixi_pypi_dependencies: vec![],
                        pixi_channels: vec![],
                        approved_pixi_channels: vec![],
                    },
                    pending_launch: false,
                },
            },
            Some(p) => {
                let mut initial = verify_trust_from_file(p, &trusted_packages);
                // #2150 reconciliation: a notebook whose inline deps exactly
                // match the project file's deps (pyproject/env.yml) has
                // already been opted into at the project level. Seed those
                // names into the allowlist with source="project_file" so the
                // allowlist - the single trust gate - reflects that. If the
                // store write fails, leave the room Untrusted (fail-closed:
                // approval can't bypass the allowlist).
                if matches!(initial.status, runt_trust::TrustStatus::Untrusted)
                    && project_file_deps_match_trust_info(p, &initial.info)
                {
                    match trusted_packages.add_from_info(&initial.info, "project_file") {
                        Ok(()) => {
                            initial = verify_trust_from_file(p, &trusted_packages);
                            info!(
                                "[notebook-sync] Reconciled project-file trust for {:?}: {:?}",
                                p, initial.status
                            );
                        }
                        Err(error) => {
                            warn!(
                                "[notebook-sync] Could not seed project-file deps into allowlist for {:?}: {} (notebook stays Untrusted)",
                                p, error
                            );
                        }
                    }
                }
                initial
            }
        };
        info!(
            "[notebook-sync] Trust status for {}: {:?}",
            notebook_id_str, trust_state.status
        );

        let (state_changed_tx, _) = broadcast::channel(16);
        let mut state_doc = RuntimeStateDoc::try_new()
            .map_err(|e| anyhow::anyhow!("create runtime state doc: {e}"))?;
        state_doc.set_runtime_state_doc_id(Some(&runtime_state_doc_id))?;
        let state = runtime_doc::RuntimeStateHandle::new(state_doc, state_changed_tx);
        let (comms_changed_tx, _) = broadcast::channel(16);
        let comms_doc = runtime_doc::CommsDoc::try_new()
            .map_err(|e| anyhow::anyhow!("create comms doc: {e}"))?;
        let comms = runtime_doc::CommsDocHandle::new(comms_doc, comms_changed_tx);
        let comments_store = CommentsSidecarStore::for_notebook_docs_dir(docs_dir);
        let comments_locator = comments_locator_for_room(id, path.as_deref());
        let comments_doc_id = comments_store.resolve_doc_id(&comments_locator)?;
        let comments_ref = comments_ref_for_room(id, path.as_deref());
        let comments = comments_store.load_or_create(&comments_doc_id, &comments_ref)?;

        // Seed path on the runtime-state doc so connecting peers see it via sync.
        if let Some(p) = path.as_ref() {
            let path_str = p.to_string_lossy().into_owned();
            let _ = state.with_doc(|sd| sd.set_path(Some(&path_str)));
        }
        super::workstation_attachment::publish_local_workstation_attachment_for_notebook_path(
            &state,
            path.as_deref(),
        );

        let persistence = match persist_tx.zip(flush_request_tx) {
            Some((p, f)) => RoomPersistence::with_debouncer(p, f),
            None => RoomPersistence::ephemeral(),
        };
        let document_head_hashes = doc.get_heads();
        let document_heads = document_head_hashes
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let genesis_snapshot = doc.save();
        let durability = if let Some(recovery) = recovered_record {
            Arc::new(super::durability::RoomDurability::recovered(
                recovery_journal,
                recovery,
            ))
        } else if !ephemeral {
            // Every persistent room, including an untitled one, acknowledges
            // NotebookDoc changes only through the append-only recovery
            // journal. The legacy debounced `.automerge` snapshot remains a
            // migration/read-compatibility input, never the durability truth
            // for a newly acknowledged change.
            Arc::new(super::durability::RoomDurability::journaled(
                recovery_journal,
                id,
                path.clone(),
                source_fingerprint,
                0,
                genesis_snapshot.clone(),
            ))
        } else {
            Arc::new(super::durability::RoomDurability::volatile(
                id,
                genesis_snapshot.clone(),
                document_head_hashes.iter().map(|head| head.0).collect(),
            ))
        };
        if durability.manifest().pending_file_checkpoint.is_some() {
            if let Some(reason) = source_read_error.clone() {
                // Missing/unreadable bytes prove neither side of the pending
                // replacement. Preserve the intent and recovered snapshot as
                // a source conflict; the journal itself remains healthy.
                startup_source_conflict = Some(reason);
            } else {
                match durability.resolve_recovered_file_checkpoint(source_fingerprint) {
                    Ok(_) => {
                        // `RecoveryJournal::load` compares disk with the
                        // pre-replacement fingerprint and may provisionally
                        // classify the intended new bytes as a conflict. The
                        // durable intent proves that exact replacement, so its
                        // successful finalization clears only that provisional
                        // classification.
                        if durability.status().source_fingerprint == source_fingerprint {
                            startup_source_conflict = None;
                        }
                    }
                    Err(super::durability::RoomDurabilityError::SourceConflict { .. }) => {
                        // Disk matches neither the old checkpoint nor the
                        // intended replacement. Preserve all three facts and
                        // require explicit source reconciliation, but do not
                        // misclassify a healthy journal as failed storage.
                        startup_source_conflict.get_or_insert_with(|| {
                            format!(
                                "source_conflict: disk fingerprint {} matches neither the recovery checkpoint nor its pending replacement; all versions were preserved",
                                source_fingerprint.to_hex()
                            )
                        });
                    }
                    Err(error) => {
                        let reason = format!(
                            "source_degraded: could not resolve interrupted file checkpoint: {error}"
                        );
                        durability.mark_degraded(reason.clone());
                        startup_durability_degraded = Some(reason);
                    }
                }
            }
        }
        if startup_durability_degraded.is_none() {
            startup_durability_degraded = durability.status().degraded_reason;
        }
        let lifecycle = RoomLifecycle::new(genesis_snapshot, document_heads);
        if durability.status().has_durable_record {
            let manifest = durability.manifest();
            let recovered_heads = manifest
                .durable_heads
                .iter()
                .map(hex::encode)
                .collect::<Vec<_>>();
            let cell_count = doc.cell_count();
            if let Some(save_sequence) = manifest.file_save_sequence {
                if let Some(checkpoint_path) = manifest.canonical_path.clone() {
                    let saved_at = std::fs::metadata(&checkpoint_path)
                        .and_then(|metadata| metadata.modified())
                        .unwrap_or(std::time::SystemTime::UNIX_EPOCH);
                    persistence.restore_file_checkpoint(super::file_checkpoint::FileCheckpoint {
                        path: checkpoint_path,
                        exported_heads: manifest.exported_heads.clone(),
                        file_fingerprint: manifest.source_fingerprint,
                        save_sequence,
                        saved_at,
                    });
                }
                let exported_heads = manifest
                    .exported_heads
                    .iter()
                    .map(hex::encode)
                    .collect::<Vec<_>>();
                state.with_doc(|runtime| {
                    runtime.set_file_checkpoint(&exported_heads, save_sequence)
                })?;
            }
            if manifest.canonical_path.is_none() && path.is_none() {
                // An untitled room has no external source task to resume. Its
                // recovered Automerge union is the active source of truth, so
                // the default NotNeeded/Interactive lifecycle is already the
                // correct state even when peer-authored hashes are present.
            } else if let Some(reason) = startup_source_conflict {
                state.with_doc(|runtime| {
                    runtime.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Conflict {
                        reason: reason.clone(),
                    }))
                })?;
                lifecycle.restore_source_conflict(
                    manifest.source_generation,
                    manifest.source_fingerprint,
                    cell_count,
                    recovered_heads,
                    reason,
                );
            } else if let Some(reason) = startup_durability_degraded {
                state.with_doc(|runtime| {
                    runtime.set_file_source_issue(Some(&runtime_doc::FileSourceIssue::Degraded {
                        reason: reason.clone(),
                    }))
                })?;
                lifecycle.restore_incomplete_source(
                    manifest.source_generation,
                    manifest.source_fingerprint,
                    cell_count,
                    recovered_heads,
                    reason,
                );
            } else {
                match manifest.source_phase {
                    super::recovery::RecoverySourcePhase::DurablyStaged
                    | super::recovery::RecoverySourcePhase::Ready => {
                        lifecycle.restore_recovered_pending(
                            manifest.source_generation,
                            manifest.source_fingerprint,
                            cell_count,
                            recovered_heads,
                        );
                    }
                    super::recovery::RecoverySourcePhase::Pending
                    | super::recovery::RecoverySourcePhase::Failed
                        if !manifest.peer_change_hashes.is_empty() =>
                    {
                        let reason = format!(
                            "source_degraded: recovery contains {} peer changes but no durably staged source generation",
                            manifest.peer_change_hashes.len()
                        );
                        state.with_doc(|runtime| {
                            runtime.set_file_source_issue(Some(
                                &runtime_doc::FileSourceIssue::Degraded {
                                    reason: reason.clone(),
                                },
                            ))
                        })?;
                        lifecycle.restore_incomplete_source(
                            manifest.source_generation,
                            manifest.source_fingerprint,
                            cell_count,
                            recovered_heads,
                            reason,
                        );
                    }
                    super::recovery::RecoverySourcePhase::Pending
                    | super::recovery::RecoverySourcePhase::Failed => {
                        // A source-free journal snapshot with no collaborative
                        // changes is safe to regenerate. Leave lifecycle at its
                        // pristine default; catalog publication claims a fresh
                        // source generation when file ingestion is requested.
                    }
                }
            }
        }
        let initial_load = RoomInitialLoad::new(Arc::clone(&lifecycle));

        Ok(Self {
            id,
            doc: Arc::new(RwLock::new(doc)),
            broadcasts: RoomBroadcasts::default(),
            persistence,
            initial_load,
            lifecycle,
            durability,
            source_reconciliation_claimed: AtomicBool::new(false),
            file_binding: NotebookFileBinding::new(path, ephemeral),
            identity: RoomIdentity::new(persist_path),
            connections: RoomConnections::default(),
            hosted: AtomicBool::new(false),
            blob_store,
            trust_state: Arc::new(RwLock::new(trust_state)),
            trusted_packages,
            state,
            comms,
            comments,
            comments_store,
            runtime_agent_handle: Arc::new(Mutex::new(None)),
            runtime_agent_env_path: Arc::new(RwLock::new(None)),
            runtime_agent_launched_config: Arc::new(RwLock::new(None)),
            runtime_agent_request_tx: Arc::new(Mutex::new(None)),
            pending_runtime_agent_connect_tx: Arc::new(Mutex::new(None)),
            runtime_agent_generation: Arc::new(AtomicU64::new(0)),
            next_queue_seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            current_runtime_agent_id: Arc::new(RwLock::new(None)),
        })
    }

    /// Create a new room by loading a persisted document or creating a fresh one.
    ///
    /// Note: This method is kept for tests that verify persistence behavior.
    /// For normal operation, `new_fresh` is used to ensure the .ipynb file
    /// is the source of truth.
    #[cfg(test)]
    pub fn load_or_create(notebook_id: &str, docs_dir: &Path, blob_store: Arc<BlobStore>) -> Self {
        // Derive UUID from notebook_id if it parses as a UUID, else mint a fresh one.
        let id = uuid::Uuid::parse_str(notebook_id).unwrap_or_else(|_| uuid::Uuid::new_v4());

        let filename = notebook_doc_filename(notebook_id);
        let persist_path = docs_dir.join(filename);
        let mut doc = NotebookDoc::load_or_create(&persist_path, notebook_id);
        let runtime_state_doc_id = doc
            .ensure_runtime_state_doc_id(notebook_id)
            .expect("seed runtime state document id");
        let _comms_doc_id = doc
            .ensure_comms_doc_id(notebook_id)
            .expect("seed comms document id");
        let (persist_tx, persist_rx) = watch::channel::<Option<Vec<u8>>>(None);
        let (flush_request_tx, flush_rx) = mpsc::unbounded_channel::<FlushRequest>();
        spawn_persist_debouncer(persist_rx, flush_rx, persist_path.clone());
        let path = if is_untitled_notebook(notebook_id) {
            None
        } else {
            Some(PathBuf::from(notebook_id))
        };
        // Test-only constructor: trust verification reads from an unavailable
        // store, so every notebook lands as Untrusted unless a test wires in
        // its own room. This matches the production fallback behavior.
        let trusted_packages =
            crate::trusted_packages::TrustedPackageStore::unavailable("not configured");
        let trust_state = match &path {
            None => match doc.get_metadata_snapshot() {
                Some(snapshot) => verify_trust_from_snapshot(&snapshot, &trusted_packages),
                None => TrustState {
                    status: runt_trust::TrustStatus::NoDependencies,
                    info: runt_trust::TrustInfo {
                        status: runt_trust::TrustStatus::NoDependencies,
                        uv_dependencies: vec![],
                        approved_uv_dependencies: vec![],
                        conda_dependencies: vec![],
                        approved_conda_dependencies: vec![],
                        conda_channels: vec![],
                        approved_conda_channels: vec![],
                        pixi_dependencies: vec![],
                        approved_pixi_dependencies: vec![],
                        pixi_pypi_dependencies: vec![],
                        approved_pixi_pypi_dependencies: vec![],
                        pixi_channels: vec![],
                        approved_pixi_channels: vec![],
                    },
                    pending_launch: false,
                },
            },
            Some(p) => {
                let mut initial = verify_trust_from_file(p, &trusted_packages);
                if matches!(initial.status, runt_trust::TrustStatus::Untrusted)
                    && project_file_deps_match_trust_info(p, &initial.info)
                    && trusted_packages
                        .add_from_info(&initial.info, "project_file")
                        .is_ok()
                {
                    initial = verify_trust_from_file(p, &trusted_packages);
                }
                initial
            }
        };
        let (state_changed_tx, _) = broadcast::channel(16);
        let mut state_doc = RuntimeStateDoc::new();
        state_doc
            .set_runtime_state_doc_id(Some(&runtime_state_doc_id))
            .expect("seed runtime state document identity");
        let state = runtime_doc::RuntimeStateHandle::new(state_doc, state_changed_tx);
        let (comms_changed_tx, _) = broadcast::channel(16);
        let comms =
            runtime_doc::CommsDocHandle::new(runtime_doc::CommsDoc::new(), comms_changed_tx);
        let comments_store = CommentsSidecarStore::for_notebook_docs_dir(docs_dir);
        let comments_locator = comments_locator_for_room(id, path.as_deref());
        let comments_doc_id = comments_store
            .resolve_doc_id(&comments_locator)
            .expect("seed comments document id");
        let comments_ref = comments_ref_for_room(id, path.as_deref());
        let comments = comments_store
            .load_or_create(&comments_doc_id, &comments_ref)
            .expect("create test comments document");
        if let Some(p) = path.as_ref() {
            let path_str = p.to_string_lossy().into_owned();
            let _ = state.with_doc(|sd| sd.set_path(Some(&path_str)));
        }
        super::workstation_attachment::publish_local_workstation_attachment_for_notebook_path(
            &state,
            path.as_deref(),
        );
        let document_head_hashes = doc.get_heads();
        let document_heads = document_head_hashes
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>();
        let genesis_snapshot = doc.save();
        let durability = Arc::new(super::durability::RoomDurability::journaled(
            super::recovery::RecoveryJournal::new(persist_path.with_extension("recovery")),
            id,
            path.clone(),
            super::recovery::source_fingerprint(
                &path
                    .as_ref()
                    .and_then(|source_path| std::fs::read(source_path).ok())
                    .unwrap_or_default(),
            ),
            0,
            genesis_snapshot.clone(),
        ));
        let lifecycle = RoomLifecycle::new(genesis_snapshot, document_heads);
        let initial_load = RoomInitialLoad::new(Arc::clone(&lifecycle));
        Self {
            id,
            doc: Arc::new(RwLock::new(doc)),
            broadcasts: RoomBroadcasts::default(),
            persistence: RoomPersistence::with_debouncer(persist_tx, flush_request_tx),
            initial_load,
            lifecycle,
            durability,
            source_reconciliation_claimed: AtomicBool::new(false),
            file_binding: NotebookFileBinding::new(path, false),
            identity: RoomIdentity::new(persist_path),
            connections: RoomConnections::default(),
            hosted: AtomicBool::new(false),
            blob_store,
            trust_state: Arc::new(RwLock::new(trust_state)),
            trusted_packages,
            state,
            comms,
            comments,
            comments_store,
            runtime_agent_handle: Arc::new(Mutex::new(None)),
            runtime_agent_env_path: Arc::new(RwLock::new(None)),
            runtime_agent_launched_config: Arc::new(RwLock::new(None)),
            runtime_agent_request_tx: Arc::new(Mutex::new(None)),
            pending_runtime_agent_connect_tx: Arc::new(Mutex::new(None)),
            runtime_agent_generation: Arc::new(AtomicU64::new(0)),
            next_queue_seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            current_runtime_agent_id: Arc::new(RwLock::new(None)),
        }
    }

    /// Check if this room has an active kernel.
    pub async fn has_kernel(&self) -> bool {
        // Check runtime agent handle
        let ra = self.runtime_agent_handle.lock().await;
        ra.as_ref().is_some_and(|a| a.is_alive())
    }

    /// Snapshot of cell sources as they were at last save. Empty before
    /// the first save, which is the correct baseline for "no disk write
    /// has happened yet."
    pub async fn last_save_sources_snapshot(&self) -> HashMap<String, String> {
        self.persistence.last_save_sources.read().await.clone()
    }

    /// True if a streaming load is currently in progress.
    pub fn is_loading(&self) -> bool {
        self.initial_load.is_loading()
    }

    /// Atomically claim the streaming-load role. Returns `true` if the
    /// caller won the race and should perform the load.
    #[cfg(test)]
    pub fn try_start_loading(&self) -> bool {
        if !self.initial_load.is_loading() {
            self.lifecycle.mark_source_required();
        }
        matches!(
            self.initial_load.begin().0,
            RoomInitialLoadStart::Started { .. }
        )
    }

    /// Mark the streaming load complete.
    #[cfg(test)]
    pub fn finish_loading(&self) {
        self.initial_load.reset_loading_for_test();
    }

    /// Flag the room as emptied by a failed streaming load. See
    /// `RoomPersistence::mark_load_failed`.
    pub fn mark_load_failed(&self) {
        self.persistence.mark_load_failed();
    }

    /// True if the room was emptied by a failed streaming load and not yet
    /// retried. See `RoomPersistence::load_failed`.
    pub fn load_failed(&self) -> bool {
        self.persistence.load_failed()
    }

    /// Clear the failed-load hazard flag. See
    /// `RoomPersistence::clear_load_failed`.
    pub fn clear_load_failed(&self) {
        self.persistence.clear_load_failed();
    }

    /// Clear the persistence hazard and publish a recovered Ready generation.
    ///
    /// A failed file-backed generation cannot become Ready without first
    /// capturing the bounded projection that generation will own. This keeps
    /// later projection reads from rebuilding an unqualified live-doc view.
    pub async fn mark_load_recovered(&self, cell_count: usize) -> anyhow::Result<Option<u64>> {
        let RoomSourceState::Failed(previous) = self.lifecycle.source_state() else {
            self.persistence.clear_load_failed();
            return Ok(None);
        };
        let generation = previous.generation.saturating_add(1);
        let projection = Arc::new(
            super::projection::build_live_notebook_projection_for_generation(self, generation)
                .await?,
        );
        let recovered = self.initial_load.recover_failed(cell_count, projection);
        if recovered.is_some() {
            self.persistence.clear_load_failed();
        }
        Ok(recovered)
    }

    /// Get kernel info if a kernel is running (runtime-agent-backed).
    ///
    /// Reads from RuntimeStateDoc (source of truth for runtime agent).
    pub async fn kernel_info(&self) -> Option<(String, String, String)> {
        // Check runtime agent — scope the lock so it drops before the next
        // `.await` on state_doc (deadlock prevention: no cross-lock holds).
        let is_alive = {
            let ra = self.runtime_agent_handle.lock().await;
            ra.as_ref().is_some_and(|a| a.is_alive())
        };
        if is_alive {
            let info = self.state.read(|sd| {
                let state = sd.read_state();
                // The daemon-info NotebookKernelInfo.status field is still a
                // legacy string; derive it from the typed lifecycle via
                // to_legacy so the daemon-info contract is unchanged.
                if !matches!(
                    state.kernel.lifecycle,
                    runtime_doc::RuntimeLifecycle::NotStarted
                ) {
                    let (legacy_status, _phase) = state.kernel.lifecycle.to_legacy();
                    Some((
                        state.kernel.name.clone(),
                        state.kernel.env_source.clone(),
                        legacy_status.to_string(),
                    ))
                } else {
                    None
                }
            });
            if let Ok(Some(info)) = info {
                return Some(info);
            }
        }
        None
    }
}
