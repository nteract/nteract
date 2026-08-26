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
    /// Current daemon-to-hosted-room bridge health. This watch channel is
    /// control-plane state: every peer gets the latest value on attach and
    /// subsequent transitions without coupling it to output/broadcast load.
    pub hosted_bridge_status_tx: watch::Sender<notebook_wire::HostedBridgeStatusWire>,
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
        let (hosted_bridge_status_tx, _) =
            watch::channel(notebook_wire::HostedBridgeStatusWire::NotApplicable);
        Self {
            changed_tx,
            file_dirty_tx,
            kernel_broadcast_tx,
            presence_tx,
            hosted_bridge_status_tx,
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

    /// Test-only view of the committed primary-save baseline sequence.
    #[cfg(test)]
    pub fn primary_save_baseline_sequence_for_test(&self) -> u64 {
        self.primary_save_baseline_sequence.load(Ordering::Acquire)
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
///
/// Thin projection facade over the room lifecycle's source axis: consumers
/// read [`RoomInitialLoadState`] snapshots via [`Self::state`] or follow the
/// authoritative source channel via [`Self::subscribe_authoritative`]. The
/// wrapper transitions carry the sticky Ready/Failed contract.
pub struct RoomInitialLoad {
    lifecycle: Arc<RoomLifecycle>,
}

impl Default for RoomInitialLoad {
    fn default() -> Self {
        Self::new(RoomLifecycle::test_default())
    }
}

impl RoomInitialLoad {
    pub(crate) fn new(lifecycle: Arc<RoomLifecycle>) -> Self {
        Self { lifecycle }
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

    /// Subscribe to the authoritative source axis. Durability failures and
    /// source conflicts transition the lifecycle directly, so long-lived
    /// waiters must observe this channel to avoid missing a terminal state.
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
    }

    /// Start the first load, or join the generation already loading/settled.
    /// `Ready` is sticky for the room lifetime so a valid zero-cell notebook is
    /// not mistaken for "never loaded." `Failed` is also sticky: retrying a
    /// partially materialized document requires an explicit reconciliation
    /// decision rather than blindly replaying file cells over live room state.
    pub fn begin(&self) -> RoomInitialLoadStart {
        if matches!(self.state(), RoomInitialLoadState::NotNeeded { .. }) {
            self.lifecycle.mark_source_required();
        }
        match self.lifecycle.begin_source() {
            RoomSourceStart::Started { generation } => RoomInitialLoadStart::Started { generation },
            RoomSourceStart::Observing { generation } => {
                RoomInitialLoadStart::Observing { generation }
            }
        }
    }

    /// Atomically advance a failed generation and claim its source task.
    ///
    /// Production retry uses this combined transition so a resident room can
    /// never expose a new `Loading` generation without an owner between two
    /// separate calls. The returned generation must immediately be wrapped in
    /// a `RoomInitialLoadClaim`, whose drop guard terminalizes cancellation.
    pub(crate) fn retry_failed_claimed(&self) -> Option<u64> {
        self.lifecycle.retry_failed_claimed()
    }

    pub(crate) fn resume_failed_staged_claimed(&self) -> Option<u64> {
        self.lifecycle.resume_failed_staged_claimed()
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
        self.lifecycle.recover_failed(cell_count, heads, projection)
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
        self.lifecycle
            .complete_ready(generation, cell_count, document_heads)
    }

    pub fn complete_failed(&self, generation: u64, reason: String) -> bool {
        self.lifecycle
            .complete_failed(generation, "source_failed", reason)
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
    /// Exact launch generation currently followed by the reconnect-driven
    /// auto-launch retry task. Zero means no follower. This keeps rapid
    /// disconnect/reconnect churn from accumulating detached pollers for the
    /// same stuck owner generation.
    pub auto_launch_retry_generation: AtomicU64,
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
            auto_launch_retry_generation: AtomicU64::new(0),
            kernel_teardown_destructive: AtomicBool::new(false),
            reservations: AtomicUsize::new(0),
        }
    }
}

impl RoomConnections {
    pub(crate) fn try_claim_auto_launch_retry(&self, generation: u64) -> bool {
        generation != 0
            && self
                .auto_launch_retry_generation
                .compare_exchange(0, generation, Ordering::AcqRel, Ordering::Acquire)
                .is_ok()
    }

    pub(crate) fn release_auto_launch_retry(&self, generation: u64) {
        let _ = self.auto_launch_retry_generation.compare_exchange(
            generation,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }

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

/// This daemon's belief about the cross-channel file claim for a
/// path-bound room (`runt_workspace::file_claims`).
///
/// A claim is held while the room has connected peers or unexported
/// durable state (durable heads beyond exported heads). A clean idle
/// room releases its claim after a grace window so another daemon
/// process can take the path, and re-acquires when a peer reconnects
/// or dirty state appears. This struct only tracks the local hold
/// state and idle-grace clock; the registry on disk stays the shared
/// source of truth, and `Daemon::reconcile_file_claims_once` is the
/// writer that keeps the two aligned.
///
/// Uses `std::sync::Mutex`: all accesses are short synchronous reads
/// and writes, never held across `.await`.
pub struct FileClaimHold {
    inner: std::sync::Mutex<FileClaimHoldInner>,
}

struct FileClaimHoldInner {
    held: bool,
    /// First observation of "no peers, nothing unexported". `None`
    /// while the room wants its claim.
    idle_clean_since: Option<std::time::Instant>,
    /// Set after warning once about a live foreign claim occupying a
    /// path this daemon still serves, so the reconciler does not
    /// repeat the warning every tick. Cleared on re-acquisition.
    foreign_conflict_warned: bool,
}

impl Default for FileClaimHold {
    fn default() -> Self {
        Self {
            inner: std::sync::Mutex::new(FileClaimHoldInner {
                held: false,
                idle_clean_since: None,
                foreign_conflict_warned: false,
            }),
        }
    }
}

impl FileClaimHold {
    fn lock(&self) -> std::sync::MutexGuard<'_, FileClaimHoldInner> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// The daemon acquired (or refreshed) the registry claim for this
    /// room's path.
    pub fn mark_held(&self) {
        let mut inner = self.lock();
        inner.held = true;
        inner.idle_clean_since = None;
        inner.foreign_conflict_warned = false;
    }

    /// The daemon released the registry claim (idle handoff, eviction).
    pub fn mark_released(&self) {
        let mut inner = self.lock();
        inner.held = false;
        inner.idle_clean_since = None;
    }

    /// The room wants its claim (peers connected or unexported state).
    /// Clears any idle-grace clock and reports whether the claim is
    /// currently believed held.
    pub fn note_wanted(&self) -> bool {
        let mut inner = self.lock();
        inner.idle_clean_since = None;
        inner.held
    }

    /// The room is idle and clean. Stamps the idle-grace clock on the
    /// first observation; returns `true` once the claim is still held
    /// and `grace` has elapsed with no `note_wanted`/`mark_held` in
    /// between, i.e. the claim is due for release.
    pub fn note_idle_clean(&self, grace: std::time::Duration) -> bool {
        let mut inner = self.lock();
        if !inner.held {
            return false;
        }
        let since = *inner
            .idle_clean_since
            .get_or_insert_with(std::time::Instant::now);
        since.elapsed() >= grace
    }

    /// One warning per foreign-conflict episode. Returns `true` the
    /// first time it is called after a `mark_held`.
    pub fn should_warn_foreign_conflict(&self) -> bool {
        let mut inner = self.lock();
        !std::mem::replace(&mut inner.foreign_conflict_warned, true)
    }
}

pub(crate) struct SourceReconciliationClaim {
    room: Arc<NotebookRoom>,
}

/// Daemon-local description of the kernel that currently owns this room.
///
/// RuntimeStateDoc remains the client-facing projection, but concurrent
/// Automerge lifecycle values cannot safely answer the daemon's idempotent
/// `LaunchKernel` RPC. This record is written only after launch succeeds and
/// is cleared when that kernel is shut down or its launch state is reset.
#[derive(Clone)]
pub(crate) struct ActiveKernelLaunch {
    pub runtime_agent_id: String,
    pub kernel_type: String,
    pub env_source: notebook_protocol::connection::EnvSource,
}

impl Drop for SourceReconciliationClaim {
    fn drop(&mut self) {
        self.room
            .source_reconciliation_claimed
            .store(false, Ordering::Release);
    }
}

/// Minimum spacing between auto-launch attempts after a failed one. A tight
/// client reconnect loop must not respawn runtime agents at connect
/// frequency; each failure holds the gate closed for this long.
pub(crate) const AUTO_LAUNCH_FAILURE_COOLDOWN: std::time::Duration =
    std::time::Duration::from_secs(5);

/// Per-room single-flight gate for all kernel launches.
///
/// Auto-launch and explicit `LaunchKernel` requests share this authority.
/// Callers that lose admission join the exact daemon-local generation instead
/// of inferring completion from RuntimeStateDoc. A failed attempt closes the
/// auto-launch gate for [`AUTO_LAUNCH_FAILURE_COOLDOWN`] so a reconnect loop
/// cannot turn connect frequency into agent spawn frequency; explicit requests
/// may retry immediately.
///
/// Sync-only state behind `std::sync::Mutex`; never hold the lock across an
/// `.await`.
#[derive(Default)]
pub(crate) struct KernelLaunchGate {
    state: std::sync::Mutex<KernelLaunchGateState>,
}

#[derive(Default)]
pub(super) struct KernelLaunchGateState {
    pub(super) in_flight_generation: Option<u64>,
    in_flight_cancel_tx: Option<tokio::sync::watch::Sender<bool>>,
    in_flight_abort_handle: Option<tokio::task::AbortHandle>,
    cooldown_until: Option<tokio::time::Instant>,
    admitted_count: u64,
    completed_outcomes: std::collections::BTreeMap<u64, KernelLaunchCompletion>,
    pub(super) cancelled_generations: std::collections::BTreeSet<u64>,
    expected_runtime_agent_id: Option<String>,
    connected_runtime_agent_id: Option<String>,
}

impl KernelLaunchGate {
    pub(super) fn lock_state(&self) -> std::sync::MutexGuard<'_, KernelLaunchGateState> {
        // Critical sections only mutate plain in-memory bookkeeping. Recovering
        // also keeps the token's Drop from double-panicking during unwind.
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Outcome of asking the gate for permission to auto-launch.
pub(crate) enum AutoLaunchAdmission {
    /// Caller owns the attempt; the gate stays closed until the token drops.
    Admitted(KernelLaunchAttempt),
    /// Another attempt is in flight; observe its exact daemon-local
    /// generation so a reconnect can retry after teardown releases it.
    InFlight { generation: u64 },
    /// A recent attempt failed; the gate reopens after `remaining`.
    CoolingDown { remaining: std::time::Duration },
}

pub(crate) enum ManualLaunchAdmission {
    Admitted(KernelLaunchAttempt),
    InFlight {
        generation: u64,
        cancel_rx: tokio::sync::watch::Receiver<bool>,
    },
}

enum KernelLaunchOutcome {
    /// Default: any drop without an explicit outcome (early return, panic
    /// unwind, launch error) counts as a failure. Auto-launch failures arm
    /// the reconnect cooldown; explicit launch failures do not.
    Failed,
    /// Kernel launched; reopen the gate immediately.
    Succeeded,
    /// Benign abort (no peers left, kernel already present); reopen the gate
    /// immediately so the next connect can launch without waiting.
    Released,
}

#[derive(Clone, Copy)]
enum KernelLaunchSource {
    Auto,
    Manual,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KernelLaunchCompletion {
    Failed,
    Succeeded,
    Released,
    Cancelled,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum KernelLaunchCommitRejection {
    Cancelled,
    AgentUnavailable,
}

pub(crate) async fn wait_for_kernel_launch_cancellation(
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    if *cancel_rx.borrow() {
        return;
    }
    loop {
        match cancel_rx.changed().await {
            Ok(()) if *cancel_rx.borrow() => return,
            Ok(()) => continue,
            Err(_) => std::future::pending::<()>().await,
        }
    }
}

/// Owned token for one auto or manual launch attempt. Dropping it reopens the
/// gate and records an exact-generation completion. The drop path arms the
/// cooldown only for auto-launch failures, so every early return and panic in
/// that flow is covered without throttling explicit requests.
pub(crate) struct KernelLaunchAttempt {
    room: Arc<NotebookRoom>,
    generation: u64,
    outcome: KernelLaunchOutcome,
    source: KernelLaunchSource,
    finished: bool,
    cancel_rx: tokio::sync::watch::Receiver<bool>,
}

impl KernelLaunchAttempt {
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }

    /// Whether `ShutdownKernel` cancelled this generation while it was
    /// running. Owners check this before starting a subprocess and again at
    /// the success linearization point.
    pub(crate) fn is_cancelled(&self) -> bool {
        *self.cancel_rx.borrow()
    }

    /// Install the runtime-agent identity only while this exact generation
    /// still owns the gate. Teardown can therefore cancel the generation or
    /// install its identity, never land between two independent authorities.
    pub(crate) fn expect_runtime_agent(&self, runtime_agent_id: &str) -> bool {
        let mut state = self.room.kernel_launch_gate.lock_state();
        if state.in_flight_generation != Some(self.generation)
            || state.cancelled_generations.contains(&self.generation)
        {
            return false;
        }
        state.expected_runtime_agent_id = Some(runtime_agent_id.to_string());
        state.connected_runtime_agent_id = None;
        true
    }

    pub(crate) fn cancellation_receiver(&self) -> tokio::sync::watch::Receiver<bool> {
        self.cancel_rx.clone()
    }

    /// Remove subprocess and connection state installed by this launch after
    /// teardown cancelled its generation. The launch token still owns the
    /// single-flight gate, so no successor can install newer agent resources
    /// while these fields are cleared. Unlike the general reset helper, this
    /// deliberately does not require provenance to remain installed: teardown
    /// clears provenance first, and may otherwise race between subprocess
    /// spawn and handle publication.
    pub(crate) async fn discard_cancelled_runtime_agent(&self, runtime_agent_id: &str) {
        {
            let mut current = self.room.current_runtime_agent_id.write().await;
            if current.as_deref() == Some(runtime_agent_id) {
                *current = None;
            }
        }
        {
            let mut state = self.room.kernel_launch_gate.lock_state();
            if state.expected_runtime_agent_id.as_deref() == Some(runtime_agent_id) {
                state.expected_runtime_agent_id = None;
            }
            if state.connected_runtime_agent_id.as_deref() == Some(runtime_agent_id) {
                state.connected_runtime_agent_id = None;
            }
        }
        self.room
            .clear_active_kernel_launch_if_agent(runtime_agent_id);
        *self.room.runtime_agent_handle.lock().await = None;
        *self.room.runtime_agent_request_tx.lock().await = None;
        *self.room.pending_runtime_agent_connect_tx.lock().await = None;
    }

    /// Atomically publish success and release the gate. A concurrent
    /// `ShutdownKernel` wins if it marked this generation first; the token is
    /// returned so the owner can tear down any kernel that just started before
    /// recording the cancelled completion.
    #[cfg(test)]
    pub(crate) fn succeed(self) -> Result<(), Self> {
        self.succeed_with(|| {})
    }

    /// Commit the daemon-local identity and client-facing success projection
    /// at the same linearization point as gate completion. The closure must be
    /// synchronous and follow the gate -> projection lock order.
    #[cfg(test)]
    pub(crate) fn succeed_with(mut self, commit: impl FnOnce()) -> Result<(), Self> {
        let cancelled = {
            let mut st = self.room.kernel_launch_gate.lock_state();
            if st.cancelled_generations.contains(&self.generation) {
                true
            } else {
                self.outcome = KernelLaunchOutcome::Succeeded;
                commit();
                st.completed_outcomes
                    .insert(self.generation, KernelLaunchCompletion::Succeeded);
                if self.generation > 1024 {
                    st.completed_outcomes.remove(&(self.generation - 1024));
                }
                if st.in_flight_generation == Some(self.generation) {
                    st.in_flight_generation = None;
                    st.in_flight_cancel_tx = None;
                    st.in_flight_abort_handle = None;
                }
                self.finished = true;
                false
            }
        };
        if cancelled {
            Err(self)
        } else {
            Ok(())
        }
    }

    pub(crate) fn succeed_with_agent(
        mut self,
        runtime_agent_id: &str,
        commit: impl FnOnce(),
    ) -> Result<(), (Self, KernelLaunchCommitRejection)> {
        let rejection = {
            let mut state = self.room.kernel_launch_gate.lock_state();
            if state.cancelled_generations.contains(&self.generation) {
                Some(KernelLaunchCommitRejection::Cancelled)
            } else if state.connected_runtime_agent_id.as_deref() != Some(runtime_agent_id) {
                Some(KernelLaunchCommitRejection::AgentUnavailable)
            } else {
                self.outcome = KernelLaunchOutcome::Succeeded;
                commit();
                state
                    .completed_outcomes
                    .insert(self.generation, KernelLaunchCompletion::Succeeded);
                if self.generation > 1024 {
                    state.completed_outcomes.remove(&(self.generation - 1024));
                }
                if state.in_flight_generation == Some(self.generation) {
                    state.in_flight_generation = None;
                    state.in_flight_cancel_tx = None;
                    state.in_flight_abort_handle = None;
                }
                self.finished = true;
                None
            }
        };
        match rejection {
            Some(rejection) => Err((self, rejection)),
            None => Ok(()),
        }
    }

    /// Mark the attempt a benign no-op: reopen the gate with no cooldown.
    pub(crate) fn release_without_cooldown(mut self) {
        self.outcome = KernelLaunchOutcome::Released;
    }

    /// Atomically finish a pre-spawn no-peer abort and, if a reconnect raced
    /// it, admit the successor on that peer's behalf. Shutdown cancellation
    /// and readmission contend on the same gate lock, eliminating the gap
    /// between token release and the successor decision.
    pub(crate) fn release_and_readmit_auto_if_peer_waiting(mut self) -> Option<Self> {
        let next = {
            let mut state = self.room.kernel_launch_gate.lock_state();
            let owner_abort_handle = state.in_flight_abort_handle.take();
            let cancelled = state.cancelled_generations.remove(&self.generation);
            state.completed_outcomes.insert(
                self.generation,
                if cancelled {
                    KernelLaunchCompletion::Cancelled
                } else {
                    KernelLaunchCompletion::Released
                },
            );
            if self.generation > 1024 {
                state.completed_outcomes.remove(&(self.generation - 1024));
            }
            if state.in_flight_generation == Some(self.generation) {
                state.in_flight_generation = None;
                state.in_flight_cancel_tx = None;
            }

            if cancelled
                || self
                    .room
                    .connections
                    .active_peers
                    .load(std::sync::atomic::Ordering::Acquire)
                    == 0
            {
                None
            } else {
                state.admitted_count = state.admitted_count.saturating_add(1);
                let generation = state.admitted_count;
                let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
                state.in_flight_generation = Some(generation);
                state.in_flight_cancel_tx = Some(cancel_tx);
                state.in_flight_abort_handle = owner_abort_handle;
                Some((generation, cancel_rx))
            }
        };
        self.finished = true;
        next.map(|(generation, cancel_rx)| Self {
            room: Arc::clone(&self.room),
            generation,
            outcome: KernelLaunchOutcome::Failed,
            source: KernelLaunchSource::Auto,
            finished: false,
            cancel_rx,
        })
    }

    /// Complete a cancelled generation after its owner has finished async
    /// kernel/agent cleanup.
    pub(crate) fn finish_cancelled(mut self) {
        self.room.finish_cancelled_launch(self.generation);
        self.finished = true;
    }
}

impl Drop for KernelLaunchAttempt {
    fn drop(&mut self) {
        if self.finished {
            return;
        }
        if self.is_cancelled() || matches!(self.outcome, KernelLaunchOutcome::Failed) {
            // A request worker can be aborted at any await when its peer
            // disconnects, including after agent provenance, a subprocess, or
            // connect channels have been installed. Keep the generation
            // fenced and clear those room-owned resources before recording
            // either cancellation or failure. Terminal projections are left
            // alone: Shutdown and agent-disconnect Error were already
            // committed by the authority that cancelled the generation.
            self.finished = true;
            let room = Arc::clone(&self.room);
            let generation = self.generation;
            let source = self.source;
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    room.cleanup_abandoned_launch(generation, source).await;
                });
                return;
            }
            // Launch attempts are runtime-owned in production. Preserve gate
            // liveness in the defensive no-runtime case; no async-installed
            // Tokio resources can be live here.
            self.room
                .finish_abandoned_launch(self.generation, self.source);
            return;
        }
        let mut st = self.room.kernel_launch_gate.lock_state();
        let completion = match self.outcome {
            KernelLaunchOutcome::Failed => KernelLaunchCompletion::Failed,
            KernelLaunchOutcome::Succeeded => KernelLaunchCompletion::Succeeded,
            KernelLaunchOutcome::Released => KernelLaunchCompletion::Released,
        };
        st.completed_outcomes.insert(self.generation, completion);
        // Waiters time out after 60 seconds and failed attempts have a
        // five-second cooldown. Retaining a generous fixed window keeps exact
        // generation results available without growing with room lifetime.
        if self.generation > 1024 {
            st.completed_outcomes.remove(&(self.generation - 1024));
        }
        if st.in_flight_generation == Some(self.generation) {
            st.in_flight_generation = None;
            st.in_flight_cancel_tx = None;
            st.in_flight_abort_handle = None;
        }
        if completion == KernelLaunchCompletion::Failed
            && matches!(self.source, KernelLaunchSource::Auto)
        {
            st.cooldown_until = Some(tokio::time::Instant::now() + AUTO_LAUNCH_FAILURE_COOLDOWN);
        }
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
    /// Local hold state for the cross-channel file claim on this room's
    /// path. Meaningless (and untouched) for rooms with no file binding.
    pub file_claim_hold: FileClaimHold,
    /// Notebook identity: persist_path and working_dir.
    pub identity: RoomIdentity,
    /// Per-connection accounting: active_peers + had_peers.
    pub connections: RoomConnections,
    /// Hosted rooms are cloud-authoritative and must not auto-launch local kernels.
    /// Read via `is_hosted()`; set once via `mark_hosted()` before peers attach.
    pub(crate) hosted: AtomicBool,
    /// Latched by eviction (reaper or ShutdownNotebook) after the final
    /// autosave flush, right before the autosave owner marker and file
    /// claim release hand the path to other daemon processes. Once set,
    /// primary-path saves refuse and late disconnect-teardown work
    /// aborts, so no straggler task can re-claim the marker or rewrite
    /// the file after the handoff. Monotonic: an evicted room Arc is
    /// never re-registered (reconnects mint a fresh room instance).
    pub(crate) evicted: AtomicBool,
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
    /// Daemon-local authority for idempotent `LaunchKernel` responses.
    pub(crate) active_kernel_launch: std::sync::Mutex<Option<ActiveKernelLaunch>>,
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
    /// Single-flight authority shared by reconnect-driven and explicit kernel
    /// launches, plus shutdown cancellation.
    pub(crate) kernel_launch_gate: KernelLaunchGate,
}

impl NotebookRoom {
    /// Linearize a client-facing launch projection with shutdown and agent
    /// disconnect cancellation. The launch token remains owned by the caller,
    /// so a different generation cannot legitimately publish from that task;
    /// this guard prevents the current cancelled generation from regressing a
    /// terminal Shutdown/Error state after an await.
    pub(crate) fn commit_unless_launch_cancelled<R>(
        &self,
        commit: impl FnOnce() -> R,
    ) -> Option<R> {
        let state = self.kernel_launch_gate.lock_state();
        if state
            .in_flight_generation
            .is_some_and(|generation| state.cancelled_generations.contains(&generation))
        {
            return None;
        }
        Some(commit())
    }

    pub(crate) fn register_launch_abort_handle(
        &self,
        generation: u64,
        abort_handle: tokio::task::AbortHandle,
    ) -> bool {
        let mut state = self.kernel_launch_gate.lock_state();
        if state.in_flight_generation != Some(generation) {
            return false;
        }
        state.in_flight_abort_handle = Some(abort_handle);
        true
    }

    pub(crate) fn abort_launch_owner(&self, generation: u64) -> bool {
        let abort_handle = {
            let state = self.kernel_launch_gate.lock_state();
            if state.in_flight_generation != Some(generation) {
                return false;
            }
            state.in_flight_abort_handle.clone()
        };
        if let Some(abort_handle) = abort_handle {
            abort_handle.abort();
            true
        } else {
            false
        }
    }

    pub(crate) fn current_launch_cancellation_receiver(
        &self,
    ) -> Option<tokio::sync::watch::Receiver<bool>> {
        self.kernel_launch_gate
            .lock_state()
            .in_flight_cancel_tx
            .as_ref()
            .map(tokio::sync::watch::Sender::subscribe)
    }

    async fn cleanup_abandoned_launch(&self, generation: u64, source: KernelLaunchSource) {
        {
            let mut state = self.kernel_launch_gate.lock_state();
            if state.in_flight_generation != Some(generation) {
                return;
            }
            state.expected_runtime_agent_id = None;
            state.connected_runtime_agent_id = None;
        }
        *self.current_runtime_agent_id.write().await = None;
        self.clear_active_kernel_launch();
        *self.runtime_agent_handle.lock().await = None;
        *self.runtime_agent_request_tx.lock().await = None;
        *self.pending_runtime_agent_connect_tx.lock().await = None;
        self.finish_abandoned_launch(generation, source);
    }

    fn finish_abandoned_launch(&self, generation: u64, source: KernelLaunchSource) {
        let mut state = self.kernel_launch_gate.lock_state();
        if state.in_flight_generation != Some(generation) {
            return;
        }
        let cancelled = state.cancelled_generations.remove(&generation);
        let completion = if cancelled {
            KernelLaunchCompletion::Cancelled
        } else {
            KernelLaunchCompletion::Failed
        };

        // Only an unprojected abrupt failure gets a generic Error. Normal
        // failure paths have already moved to Error or NotStarted; cancelled
        // paths have already committed Shutdown or disconnect Error.
        if !cancelled {
            if let Err(error) = self.state.with_doc(|doc| {
                if matches!(
                    doc.read_state().kernel.lifecycle,
                    runtime_doc::RuntimeLifecycle::Resolving
                        | runtime_doc::RuntimeLifecycle::PreparingEnv
                        | runtime_doc::RuntimeLifecycle::Launching
                        | runtime_doc::RuntimeLifecycle::Connecting
                ) {
                    doc.set_lifecycle_with_error_details(
                        &runtime_doc::RuntimeLifecycle::Error,
                        None,
                        Some("Kernel launch stopped before completion"),
                    )?;
                }
                Ok(())
            }) {
                tracing::warn!("[runtime-state] {error}");
            }
        }

        state.completed_outcomes.insert(generation, completion);
        if generation > 1024 {
            state.completed_outcomes.remove(&(generation - 1024));
        }
        state.in_flight_generation = None;
        state.in_flight_cancel_tx = None;
        state.in_flight_abort_handle = None;
        if completion == KernelLaunchCompletion::Failed
            && matches!(source, KernelLaunchSource::Auto)
        {
            state.cooldown_until = Some(tokio::time::Instant::now() + AUTO_LAUNCH_FAILURE_COOLDOWN);
        }
    }

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
        if !self.hosted.swap(true, Ordering::Relaxed) {
            self.broadcasts
                .hosted_bridge_status_tx
                .send_replace(notebook_wire::HostedBridgeStatusWire::Connecting);
        }
    }

    /// True once an eviction path has finished this room's final save and
    /// is handing (or has handed) the path to other daemon processes.
    pub fn is_evicted(&self) -> bool {
        self.evicted.load(Ordering::Acquire)
    }

    /// Latch eviction. Call after the eviction path's final autosave
    /// flush and before releasing the autosave owner marker; see the
    /// `evicted` field docs for what the latch suppresses.
    pub fn mark_evicted(&self) {
        self.evicted.store(true, Ordering::Release);
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
                None => TrustState::no_dependencies(),
            },
            Some(_) if recovered_record.is_some() => match doc.get_metadata_snapshot() {
                Some(snapshot) => verify_trust_from_snapshot(&snapshot, &trusted_packages),
                None => TrustState::no_dependencies(),
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
                        durability.mark_degraded(
                            super::durability::DegradationKind::DurabilityBoundary,
                            reason.clone(),
                        );
                        startup_durability_degraded = Some(reason);
                    }
                }
            }
        }
        if startup_durability_degraded.is_none() {
            startup_durability_degraded = durability.status().degraded_reason();
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
                        if manifest.peer_change_count > 0 =>
                    {
                        let reason = format!(
                            "source_degraded: recovery contains {} peer changes but no durably staged source generation",
                            manifest.peer_change_count
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
            file_claim_hold: FileClaimHold::default(),
            identity: RoomIdentity::new(persist_path),
            connections: RoomConnections::default(),
            hosted: AtomicBool::new(false),
            evicted: AtomicBool::new(false),
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
            active_kernel_launch: std::sync::Mutex::new(None),
            runtime_agent_request_tx: Arc::new(Mutex::new(None)),
            pending_runtime_agent_connect_tx: Arc::new(Mutex::new(None)),
            runtime_agent_generation: Arc::new(AtomicU64::new(0)),
            next_queue_seq: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            current_runtime_agent_id: Arc::new(RwLock::new(None)),
            kernel_launch_gate: KernelLaunchGate::default(),
        })
    }

    /// Ask the auto-launch gate for permission to start an attempt.
    ///
    /// Returns `Admitted` with an owned token when no attempt is in flight
    /// and no failure cooldown is active. The token must accompany the
    /// attempt end to end: dropping it without calling
    /// [`KernelLaunchAttempt::succeed`] or
    /// [`KernelLaunchAttempt::release_without_cooldown`] counts as a failure
    /// and arms [`AUTO_LAUNCH_FAILURE_COOLDOWN`].
    pub(crate) fn try_begin_auto_launch(self: &Arc<Self>) -> AutoLaunchAdmission {
        let now = tokio::time::Instant::now();
        let mut st = self.kernel_launch_gate.lock_state();
        if let Some(generation) = st.in_flight_generation {
            return AutoLaunchAdmission::InFlight { generation };
        }
        if let Some(until) = st.cooldown_until {
            if now < until {
                return AutoLaunchAdmission::CoolingDown {
                    remaining: until - now,
                };
            }
        }
        st.cooldown_until = None;
        st.admitted_count = st.admitted_count.saturating_add(1);
        let generation = st.admitted_count;
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        st.in_flight_generation = Some(generation);
        st.in_flight_cancel_tx = Some(cancel_tx);
        st.in_flight_abort_handle = None;
        AutoLaunchAdmission::Admitted(KernelLaunchAttempt {
            room: Arc::clone(self),
            generation,
            outcome: KernelLaunchOutcome::Failed,
            source: KernelLaunchSource::Auto,
            finished: false,
            cancel_rx,
        })
    }

    pub(crate) fn try_begin_manual_launch(self: &Arc<Self>) -> ManualLaunchAdmission {
        let mut state = self.kernel_launch_gate.lock_state();
        if let Some(generation) = state.in_flight_generation {
            let cancel_rx = state
                .in_flight_cancel_tx
                .as_ref()
                .expect("in-flight launch must own a cancellation sender")
                .subscribe();
            return ManualLaunchAdmission::InFlight {
                generation,
                cancel_rx,
            };
        }
        // Explicit user requests may retry immediately after an auto-launch
        // failure, but do not erase the reconnect-only cooldown. A successful
        // manual launch makes it irrelevant while the kernel is present; if
        // that request also fails, reconnects remain throttled for the
        // original auto-launch window.
        state.admitted_count = state.admitted_count.saturating_add(1);
        let generation = state.admitted_count;
        let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
        state.in_flight_generation = Some(generation);
        state.in_flight_cancel_tx = Some(cancel_tx);
        state.in_flight_abort_handle = None;
        ManualLaunchAdmission::Admitted(KernelLaunchAttempt {
            room: Arc::clone(self),
            generation,
            outcome: KernelLaunchOutcome::Failed,
            source: KernelLaunchSource::Manual,
            finished: false,
            cancel_rx,
        })
    }

    /// Cancel the currently admitted generation, if any. The owner retains
    /// the gate until it has stopped any subprocess or kernel it started, so
    /// a successor cannot race the cleanup.
    #[cfg(test)]
    pub(crate) fn cancel_in_flight_launch(&self) -> Option<u64> {
        let mut state = self.kernel_launch_gate.lock_state();
        let generation = state.in_flight_generation?;
        state.cancelled_generations.insert(generation);
        if let Some(cancel_tx) = state.in_flight_cancel_tx.as_ref() {
            let _ = cancel_tx.send(true);
        }
        Some(generation)
    }

    /// Atomically cancel the admitted generation and publish the terminal
    /// RuntimeStateDoc projection. Reset paths take the same gate lock before
    /// mutating that projection, so an accepted shutdown cannot be overwritten
    /// by a late launch error or abort.
    pub(crate) fn cancel_launch_and_mark_shutdown_with(
        &self,
        commit_presence: impl FnOnce(),
    ) -> Option<u64> {
        self.cancel_launch_and_commit_terminal(false, commit_presence, |sd| {
            sd.set_lifecycle(&runtime_doc::RuntimeLifecycle::Shutdown)
        })
    }

    /// Last-peer teardown owns the runtime-agent generation as well as the
    /// kernel. Revoke the agent identity in the same gate transaction as the
    /// Shutdown projection so its socket cleanup cannot replace Shutdown with
    /// Error in between two otherwise-correct commits.
    pub(crate) fn cancel_launch_and_mark_teardown_with(
        &self,
        commit_presence: impl FnOnce(),
    ) -> Option<u64> {
        self.cancel_launch_and_commit_terminal(true, commit_presence, |sd| {
            sd.set_lifecycle(&runtime_doc::RuntimeLifecycle::Shutdown)
        })
    }

    pub(crate) fn cancel_launch_and_commit_terminal(
        &self,
        invalidate_runtime_agent: bool,
        commit_presence: impl FnOnce(),
        commit_state: impl FnOnce(
            &mut runtime_doc::RuntimeStateDoc,
        ) -> Result<(), runtime_doc::RuntimeStateError>,
    ) -> Option<u64> {
        let mut state = self.kernel_launch_gate.lock_state();
        let cancelled = state.in_flight_generation.inspect(|generation| {
            state.cancelled_generations.insert(*generation);
            if let Some(cancel_tx) = state.in_flight_cancel_tx.as_ref() {
                let _ = cancel_tx.send(true);
            }
        });
        if invalidate_runtime_agent {
            state.expected_runtime_agent_id = None;
            state.connected_runtime_agent_id = None;
        }
        self.clear_active_kernel_launch();
        commit_presence();
        if let Err(e) = self.state.with_doc(|sd| {
            commit_state(sd)?;
            sd.clear_env_progress()?;
            sd.abort_inflight_executions()?;
            sd.set_queue(None, &[])?;
            Ok(())
        }) {
            tracing::warn!("[runtime-state] {}", e);
        }
        cancelled
    }

    #[cfg(test)]
    pub(crate) fn expect_runtime_agent(&self, runtime_agent_id: &str) {
        let mut state = self.kernel_launch_gate.lock_state();
        state.expected_runtime_agent_id = Some(runtime_agent_id.to_string());
        state.connected_runtime_agent_id = None;
    }

    pub(crate) fn mark_runtime_agent_connected(&self, runtime_agent_id: &str) -> bool {
        let mut state = self.kernel_launch_gate.lock_state();
        if state.expected_runtime_agent_id.as_deref() != Some(runtime_agent_id) {
            return false;
        }
        state.connected_runtime_agent_id = Some(runtime_agent_id.to_string());
        true
    }

    pub(crate) fn invalidate_runtime_agent_connection(&self) {
        let mut state = self.kernel_launch_gate.lock_state();
        state.expected_runtime_agent_id = None;
        state.connected_runtime_agent_id = None;
    }

    pub(crate) fn disconnect_runtime_agent_and_commit_terminal(
        &self,
        runtime_agent_id: &str,
        commit_presence: impl FnOnce(),
        commit_state: impl FnOnce(
            &mut runtime_doc::RuntimeStateDoc,
        ) -> Result<(), runtime_doc::RuntimeStateError>,
    ) -> bool {
        let mut state = self.kernel_launch_gate.lock_state();
        if state.connected_runtime_agent_id.as_deref() != Some(runtime_agent_id) {
            return false;
        }
        state.expected_runtime_agent_id = None;
        state.connected_runtime_agent_id = None;
        if let Some(generation) = state.in_flight_generation {
            state.cancelled_generations.insert(generation);
            if let Some(cancel_tx) = state.in_flight_cancel_tx.as_ref() {
                let _ = cancel_tx.send(true);
            }
        }
        self.clear_active_kernel_launch();
        commit_presence();
        if let Err(e) = self.state.with_doc(|sd| {
            commit_state(sd)?;
            sd.clear_env_progress()?;
            sd.abort_inflight_executions()?;
            sd.set_queue(None, &[])?;
            Ok(())
        }) {
            tracing::warn!("[runtime-state] {}", e);
        }
        true
    }

    fn finish_cancelled_launch(&self, generation: u64) {
        let mut state = self.kernel_launch_gate.lock_state();
        state.cancelled_generations.remove(&generation);
        state
            .completed_outcomes
            .insert(generation, KernelLaunchCompletion::Cancelled);
        if generation > 1024 {
            state.completed_outcomes.remove(&(generation - 1024));
        }
        if state.in_flight_generation == Some(generation) {
            state.in_flight_generation = None;
            state.in_flight_cancel_tx = None;
            state.in_flight_abort_handle = None;
        }
    }

    /// Whether the requested auto-launch attempt launched a kernel.
    /// Completion is generation-scoped so a later attempt cannot overwrite
    /// the result a manual launch request is joining.
    pub(crate) fn launch_completion(&self, generation: u64) -> Option<KernelLaunchCompletion> {
        self.kernel_launch_gate
            .lock_state()
            .completed_outcomes
            .get(&generation)
            .copied()
    }

    pub(crate) fn launch_successor_generation(&self, generation: u64) -> Option<u64> {
        let state = self.kernel_launch_gate.lock_state();
        (state.admitted_count > generation).then_some(generation.saturating_add(1))
    }

    #[cfg(test)]
    pub(crate) async fn record_active_kernel_launch_if_current(
        &self,
        runtime_agent_id: String,
        kernel_type: String,
        env_source: notebook_protocol::connection::EnvSource,
    ) -> bool {
        let current = self.current_runtime_agent_id.read().await;
        if current.as_deref() != Some(runtime_agent_id.as_str()) {
            return false;
        }
        let mut active = self
            .active_kernel_launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active = Some(ActiveKernelLaunch {
            runtime_agent_id,
            kernel_type,
            env_source,
        });
        true
    }

    pub(crate) async fn is_current_runtime_agent(&self, runtime_agent_id: &str) -> bool {
        self.current_runtime_agent_id.read().await.as_deref() == Some(runtime_agent_id)
    }

    pub(crate) fn active_kernel_launch(&self) -> Option<ActiveKernelLaunch> {
        self.active_kernel_launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn clear_active_kernel_launch(&self) {
        let mut active = self
            .active_kernel_launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active = None;
    }

    pub(crate) fn set_active_kernel_launch(
        &self,
        runtime_agent_id: String,
        kernel_type: String,
        env_source: notebook_protocol::connection::EnvSource,
    ) {
        let mut active = self
            .active_kernel_launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active = Some(ActiveKernelLaunch {
            runtime_agent_id,
            kernel_type,
            env_source,
        });
    }

    pub(crate) fn clear_active_kernel_launch_if_agent(&self, runtime_agent_id: &str) {
        let mut active = self
            .active_kernel_launch
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if active
            .as_ref()
            .is_some_and(|launch| launch.runtime_agent_id == runtime_agent_id)
        {
            *active = None;
        }
    }

    /// Test helper for integration coverage of the connection path.
    #[doc(hidden)]
    pub fn test_auto_launch_admissions(&self) -> u64 {
        self.kernel_launch_gate.lock_state().admitted_count
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
            self.initial_load.begin(),
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
