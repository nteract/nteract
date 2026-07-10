use super::registry::{InsertOutcome, RoomRegistry};
use super::*;

/// Daemon-wide handle to the resident-room registry.
///
/// Previously `Arc<Mutex<HashMap<Uuid, Arc<NotebookRoom>>>>`. The
/// underlying type is now `RoomRegistry`, which owns both the UUID
/// map and the path → UUID secondary index under one tokio mutex.
/// Existing call sites keep the `NotebookRooms` name and only the
/// operations change.
pub type NotebookRooms = Arc<RoomRegistry>;

pub(crate) struct RoomCreationOptions<'a> {
    pub path: Option<PathBuf>,
    /// Publish a pending room-owned file load before registry insertion.
    /// OpenNotebook sets this for existing `.ipynb` files; attach/create paths
    /// that seed or sync their own document leave it false.
    pub initial_load_required: bool,
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
    // Fast path: room already exists. The registry hands back the
    // existing Arc plus a fresh reservation guard without minting a
    // new room.
    if let Some(found) = rooms.lookup_uuid(uuid).await {
        return Ok(found);
    }

    info!("[notebook-sync] Creating room for {}", uuid);
    let path_for_room = options.path.clone();
    let room = Arc::new(NotebookRoom::new_fresh_with_trusted_packages(
        uuid,
        path_for_room.clone(),
        options.docs_dir,
        options.blob_store,
        options.ephemeral,
        options.trusted_packages,
    )?);
    if options.initial_load_required {
        room.initial_load.mark_required();
    }

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
        // Record the notebook's project-file context on the runtime-state
        // doc. Single-writer invariant: only the daemon writes this key.
        // Also re-runs after untitled promotion and save-as rename; see
        // `project_context::refresh_project_context` callers.
        super::project_context::refresh_project_context_async(&room, options.path.as_deref()).await;

        if let Some(ref notebook_path) = options.path {
            NotebookFileBinding::bind_existing(&room, notebook_path).await;
        }
    }

    Ok((room, guard))
}
