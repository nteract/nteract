use super::*;
use crate::async_outcome::{recv_oneshot_with_timeout, TimedOneShot};

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
    ) -> Result<(), notebook_protocol::protocol::SaveErrorKind> {
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
    /// widget traffic). Env progress moved to RuntimeStateDoc and no longer
    /// flows here.
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
    /// Debouncer channels — present only when the room writes to a
    /// persisted Automerge doc (`notebook-docs/*.automerge`). Ephemeral
    /// rooms keep this `None`, and so do rooms promoted via Save (the
    /// `.automerge` stream isn't restarted post-promotion — see comment
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
    /// Previous visible execution_id per cell, captured just before a new
    /// execution pointer replaces it. This is intentionally daemon-local
    /// persistence bookkeeping, not RuntimeStateDoc schema: it lets Save keep
    /// the last visible outputs on disk while a re-execution is still queued
    /// or running with no outputs yet.
    previous_visible_executions: std::sync::Mutex<HashMap<String, String>>,
    /// Timestamp (ms since epoch) of last self-write to the .ipynb file.
    /// Used to skip file watcher events triggered by our own saves.
    pub last_self_write: AtomicU64,
    /// Whether a streaming load is in progress for this room.
    /// Prevents two connections from both attempting to load from disk.
    is_loading: AtomicBool,
    /// Hazard flag set only when a FAILED streaming load empties this room.
    /// Set true at the one production point that zeroes a room out from under a
    /// possibly-non-empty file: the streaming-load Err branch in peer_session,
    /// co-located with `doc.clear_all_cells()`. Cleared on a fresh load attempt
    /// (`try_start_loading` winning the claim) since a retry supersedes any
    /// prior failure. The zeroing guard in `save_notebook_to_disk` reads this:
    /// a room emptied by a failed load (flag true) must not autosave its empty
    /// state over a non-empty/corrupt file, while a legitimately-empty room from
    /// ANY init path (flag false) always saves.
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
            debouncer: std::sync::Mutex::new(None),
            last_save_sources: RwLock::new(HashMap::new()),
            previous_visible_executions: std::sync::Mutex::new(HashMap::new()),
            last_self_write: AtomicU64::new(0),
            is_loading: AtomicBool::new(false),
            load_failed: AtomicBool::new(false),
        }
    }

    /// Build a persistence struct with an active .automerge debouncer.
    pub fn with_debouncer(
        persist_tx: watch::Sender<Option<Vec<u8>>>,
        flush_request_tx: mpsc::UnboundedSender<FlushRequest>,
    ) -> Self {
        Self {
            debouncer: std::sync::Mutex::new(Some(PersistDebouncer {
                persist_tx,
                flush_request_tx,
            })),
            last_save_sources: RwLock::new(HashMap::new()),
            previous_visible_executions: std::sync::Mutex::new(HashMap::new()),
            last_self_write: AtomicU64::new(0),
            is_loading: AtomicBool::new(false),
            load_failed: AtomicBool::new(false),
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
    #[allow(dead_code)]
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

    /// Atomically claim the loading role. Returns `true` if this caller won
    /// the race and should perform the streaming load.
    pub fn try_start_loading(&self) -> bool {
        // Note: load_failed is deliberately NOT cleared here. Clearing at the
        // START of a retry opens a race — an in-flight autosave that already
        // passed its is_loading() check could then see load_failed == false with
        // the room still empty mid-retry and zero the file. The flag is cleared
        // only on recovery COMPLETION (a successful load in peer_session, a
        // watcher reconcile, or a successful save).
        self.is_loading
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_ok()
    }

    /// Mark loading complete (success or failure).
    pub fn finish_loading(&self) {
        self.is_loading.store(false, Ordering::Release);
    }

    /// True if a streaming load is currently in progress.
    pub fn is_loading(&self) -> bool {
        self.is_loading.load(Ordering::Acquire)
    }

    /// Flag the room as emptied by a failed streaming load. Set at the one
    /// production point that zeroes the room (peer_session Err branch); the
    /// zeroing guard then refuses to autosave this empty doc over a file.
    pub fn mark_load_failed(&self) {
        self.load_failed.store(true, Ordering::Release);
    }

    /// True if the room was emptied by a failed streaming load and not yet
    /// retried. See `mark_load_failed` and the zeroing guard in
    /// `save_notebook_to_disk`.
    pub fn load_failed(&self) -> bool {
        self.load_failed.load(Ordering::Acquire)
    }

    /// Clear the failed-load hazard flag. Called when a fresh load attempt
    /// wins the loading claim, since the retry supersedes the prior failure.
    pub fn clear_load_failed(&self) {
        self.load_failed.store(false, Ordering::Release);
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

    /// The room this guard is reserving.
    #[allow(dead_code)]
    pub fn room(&self) -> &Arc<NotebookRoom> {
        &self.room
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
    /// File binding owner: canonical .ipynb path, file watcher, autosave.
    pub file_binding: NotebookFileBinding,
    /// Notebook identity: persist_path and working_dir.
    pub identity: RoomIdentity,
    /// Per-connection accounting: active_peers + had_peers.
    pub connections: RoomConnections,
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
        path: Option<PathBuf>,
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

        // For untitled notebooks (path is None), the persisted Automerge doc is their
        // only content record — there's no .ipynb on disk. Load it if it exists
        // so content survives daemon restarts, preserving even legacy pre-seed history.
        // For saved notebooks (path is Some), .ipynb is the source of truth, so
        // delete stale persisted docs and start fresh from the canonical schema seed
        // before the daemon imports file contents from disk.
        let runtimed_actor = "runtimed";
        let mut doc = if !ephemeral && path.is_none() && persist_path.exists() {
            info!(
                "[notebook-sync] Loading persisted doc for untitled notebook: {:?}",
                persist_path
            );
            NotebookDoc::load_or_create_with_actor(&persist_path, &notebook_id_str, runtimed_actor)
        } else {
            if !ephemeral && persist_path.exists() {
                if crate::paths::snapshot_before_delete(&persist_path, docs_dir) {
                    let _ = std::fs::remove_file(&persist_path);
                } else {
                    warn!(
                        "[notebook-sync] Keeping persisted doc (snapshot failed): {:?}",
                        persist_path
                    );
                }
            }
            // TODO(phase-6): tighten NotebookDoc to accept Uuid directly
            NotebookDoc::new_with_actor(&notebook_id_str, runtimed_actor)
        };
        // Spawn debounced persistence task (watch channel keeps latest value only)
        // Ephemeral rooms skip persistence entirely.
        // Store ephemeral flag in doc metadata so the GUI can show a banner
        if ephemeral {
            let _ = doc.set_metadata("ephemeral", "true");
        }
        let runtime_state_doc_id = doc.ensure_runtime_state_doc_id(&notebook_id_str)?;

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

        // Seed path on the runtime-state doc so connecting peers see it via sync.
        if let Some(p) = path.as_ref() {
            let path_str = p.to_string_lossy().into_owned();
            let _ = state.with_doc(|sd| sd.set_path(Some(&path_str)));
        }

        let persistence = match persist_tx.zip(flush_request_tx) {
            Some((p, f)) => RoomPersistence::with_debouncer(p, f),
            None => RoomPersistence::ephemeral(),
        };

        Ok(Self {
            id,
            doc: Arc::new(RwLock::new(doc)),
            broadcasts: RoomBroadcasts::default(),
            persistence,
            file_binding: NotebookFileBinding::new(path, ephemeral),
            identity: RoomIdentity::new(persist_path),
            connections: RoomConnections::default(),
            blob_store,
            trust_state: Arc::new(RwLock::new(trust_state)),
            trusted_packages,
            state,
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
        if let Some(p) = path.as_ref() {
            let path_str = p.to_string_lossy().into_owned();
            let _ = state.with_doc(|sd| sd.set_path(Some(&path_str)));
        }
        Self {
            id,
            doc: Arc::new(RwLock::new(doc)),
            broadcasts: RoomBroadcasts::default(),
            persistence: RoomPersistence::with_debouncer(persist_tx, flush_request_tx),
            file_binding: NotebookFileBinding::new(path, false),
            identity: RoomIdentity::new(persist_path),
            connections: RoomConnections::default(),
            blob_store,
            trust_state: Arc::new(RwLock::new(trust_state)),
            trusted_packages,
            state,
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
        self.persistence.is_loading()
    }

    /// Atomically claim the streaming-load role. Returns `true` if the
    /// caller won the race and should perform the load.
    pub fn try_start_loading(&self) -> bool {
        self.persistence.try_start_loading()
    }

    /// Mark the streaming load complete.
    pub fn finish_loading(&self) {
        self.persistence.finish_loading();
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
