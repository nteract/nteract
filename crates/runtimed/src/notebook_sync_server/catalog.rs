use super::registry::{InsertOutcome, RoomRegistry};
use super::*;

/// Daemon-wide handle to the resident-room registry.
///
/// `RoomRegistry` owns both the UUID map and the path -> UUID secondary index
/// under one tokio mutex.
pub type NotebookRooms = Arc<RoomRegistry>;

pub(crate) struct RoomCreationOptions<'a> {
    pub path: Option<PathBuf>,
    /// Execution-store root for a room-owned initial file import.
    ///
    /// `Some` means an existing `.ipynb` must be loaded. Room creation claims
    /// that source generation before registry publication and transfers the
    /// claim into the task before any subsequent await. Attach/create paths
    /// that seed or sync their own document leave this `None`.
    pub initial_load_execution_store_dir: Option<&'a Path>,
    pub docs_dir: &'a Path,
    pub blob_store: Arc<BlobStore>,
    pub ephemeral: bool,
    pub trusted_packages: crate::trusted_packages::TrustedPackageStore,
}

/// Look up an open room by its canonical .ipynb path.
///
/// Returns `None` if no room is currently serving that path. O(1)
/// lookup through the combined registry. On hit, the caller receives
/// the `Arc<NotebookRoom>` plus a fresh `ReservationGuard` that holds
/// the room against the reaper until the handshake commits or aborts.
pub async fn find_room_by_path(
    rooms: &NotebookRooms,
    path: &Path,
) -> Option<(Arc<NotebookRoom>, ReservationGuard)> {
    rooms.lookup_path(path).await
}

/// Get or create a room for a notebook.
///
/// Creates a new fresh room if one for the given UUID doesn't already
/// exist. The `.ipynb` file is the source of truth: the first client
/// to connect populates the Automerge doc from their local file.
///
/// For `.ipynb` files, a file watcher is spawned. The UUID-keyed
/// room map and path → UUID index are updated together under one
/// lock.
#[cfg(test)]
pub async fn get_or_create_room(
    rooms: &NotebookRooms,
    uuid: uuid::Uuid,
    options: RoomCreationOptions<'_>,
) -> (Arc<NotebookRoom>, ReservationGuard) {
    get_or_create_room_result(rooms, uuid, options)
        .await
        .unwrap_or_else(|err| panic!("create notebook room runtime state: {err}"))
}

pub async fn get_or_create_room_result(
    rooms: &NotebookRooms,
    uuid: uuid::Uuid,
    options: RoomCreationOptions<'_>,
) -> anyhow::Result<(Arc<NotebookRoom>, ReservationGuard)> {
    enum InitialSourceTask {
        Import(RoomInitialLoadClaim, PathBuf),
        FinalizeRecovery(RoomInitialLoadClaim, Option<PathBuf>),
    }
    // Fast path: room already exists. The registry hands back the
    // existing Arc plus a fresh reservation guard without minting a
    // new room.
    if let Some(found) = rooms.lookup_uuid(uuid).await {
        return Ok(found);
    }

    info!("[notebook-sync] Creating room for {}", uuid);
    let mut path_for_room = options.path.clone();
    let room = Arc::new(NotebookRoom::new_fresh_with_trusted_packages(
        uuid,
        path_for_room.clone(),
        options.docs_dir,
        options.blob_store,
        options.ephemeral,
        options.trusted_packages,
    )?);
    if path_for_room.is_none() {
        path_for_room = room.file_binding.path().await;
    }
    let durability = room.durability.status();
    let mut initial_source_task = if room.initial_load.is_loading()
        && matches!(
            durability.source_phase,
            super::recovery::RecoverySourcePhase::DurablyStaged
                | super::recovery::RecoverySourcePhase::Ready
        ) {
        let Some(load_path) = path_for_room.clone() else {
            anyhow::bail!("recovered file source requires a notebook path");
        };
        let Some(claim) = claim_room_initial_load(&room, load_path) else {
            anyhow::bail!("recovered source generation was already claimed");
        };
        Some(InitialSourceTask::FinalizeRecovery(
            claim,
            options
                .initial_load_execution_store_dir
                .map(Path::to_path_buf),
        ))
    } else if matches!(
        room.initial_load.state(),
        RoomInitialLoadState::Failed { .. }
    ) {
        // Source conflicts and peer-only pre-source recovery require an
        // explicit reconciliation decision. Never regenerate over them.
        None
    } else if path_for_room.is_none() {
        // Untitled rooms have no file source task. A recovered journal is
        // already their canonical active document; a fresh room remains in
        // the NotNeeded lifecycle until it is explicitly saved to a path.
        None
    } else if let Some(execution_store_dir) = options.initial_load_execution_store_dir {
        if durability.has_durable_record
            && durability.source_phase != super::recovery::RecoverySourcePhase::Pending
        {
            None
        } else {
            let Some(load_path) = path_for_room.clone() else {
                anyhow::bail!("initial file load requires a notebook path");
            };
            room.initial_load.mark_required();
            let Some(claim) = claim_room_initial_load(&room, load_path) else {
                anyhow::bail!("fresh room initial load generation was already claimed");
            };
            // If the handshake aborts before a peer joins, the room must still
            // enter the ordinary peerless-room lifecycle once loading settles.
            // A successful join clears this timestamp before the reaper can act,
            // and the reservation guard protects concurrent handshakes.
            room.connections.stamp_kernel_torn_down_now();
            Some(InitialSourceTask::Import(
                claim,
                execution_store_dir.to_path_buf(),
            ))
        }
    } else {
        None
    };

    // Atomic insert across the registry's UUID map and path index.
    // If we lose a race to a concurrent caller (same UUID or same
    // path), the registry returns the existing room and our `room`
    // is dropped. The only `Err` is registry inconsistency (path
    // indexes a UUID that has no room) — propagate it so the caller
    // sees the broken state.
    let outcome = match rooms
        .insert_or_get(uuid, room, path_for_room.as_deref())
        .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            error!(
                "[notebook-sync] registry inconsistency on insert for {} at {:?}: {}",
                uuid, path_for_room, e
            );
            return Err(anyhow::anyhow!(e));
        }
    };

    let inserted_new = matches!(outcome, InsertOutcome::Inserted(_, _));
    let (room, guard) = outcome.into_parts();

    // Side-effects only happen when we actually inserted a fresh room.
    // If we lost the race, the racing caller already ran them.
    if inserted_new {
        // Transfer the pre-publication ownership claim into the source task
        // synchronously, before the first post-publication await below. If
        // room creation were cancelled before this transfer, dropping the
        // claim terminalizes the visible generation instead of stranding it.
        if let Some(task) = initial_source_task.take() {
            match task {
                InitialSourceTask::Import(claim, execution_store_dir) => {
                    spawn_claimed_room_initial_load(claim, execution_store_dir);
                }
                InitialSourceTask::FinalizeRecovery(claim, execution_store_dir) => {
                    spawn_claimed_room_recovery_finalize(claim, execution_store_dir);
                }
            }
        }

        // Record the notebook's project-file context on the runtime-state
        // doc. Single-writer invariant: only the daemon writes this key.
        // Also re-runs after untitled promotion and save-as rename; see
        // `project_context::refresh_project_context` callers.
        super::project_context::refresh_project_context_async(&room, path_for_room.as_deref())
            .await;

        if let Some(ref notebook_path) = path_for_room {
            NotebookFileBinding::bind_existing(&room, notebook_path).await;
        }
    }

    Ok((room, guard))
}
