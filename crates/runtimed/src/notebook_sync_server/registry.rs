//! Combined registry of resident notebook rooms.
//!
//! Owns both the `Uuid -> Arc<NotebookRoom>` map and the path -> UUID
//! secondary index behind one tokio `Mutex`. Joined operations
//! (insertion of a new room that also takes a path, removal of a room
//! while purging its path entry, path lookup followed by UUID
//! resolution) happen under a single lock acquisition, which closes
//! partial-publication races between those maps.
//!
//! Lookups hand callers a `ReservationGuard` alongside the `Arc`. The
//! room reaper's peer-less predicate is
//! `active_peers == 0 && reservations == 0`, so a caller that has
//! cloned the `Arc` but not yet incremented `active_peers` keeps the
//! reaper off until the handshake commits or aborts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::path_index::{PathIndex, PathIndexError};
use super::room::{NotebookRoom, ReservationGuard};

/// Outcome of `RoomRegistry::insert_or_get`.
pub enum InsertOutcome {
    /// The room was inserted; the caller now owns the canonical Arc
    /// for this UUID.
    Inserted(Arc<NotebookRoom>, ReservationGuard),
    /// Another caller raced ahead. The existing room is returned and
    /// the caller's freshly-built `Arc<NotebookRoom>` is dropped by
    /// the registry.
    Existing(Arc<NotebookRoom>, ReservationGuard),
}

impl InsertOutcome {
    pub fn into_parts(self) -> (Arc<NotebookRoom>, ReservationGuard) {
        match self {
            InsertOutcome::Inserted(room, guard) | InsertOutcome::Existing(room, guard) => {
                (room, guard)
            }
        }
    }
}

struct RegistryInner {
    rooms: HashMap<Uuid, Arc<NotebookRoom>>,
    paths: PathIndex,
    accepting_publication: bool,
}

impl Default for RegistryInner {
    fn default() -> Self {
        Self {
            rooms: HashMap::new(),
            paths: PathIndex::default(),
            accepting_publication: true,
        }
    }
}

/// Combined index of resident notebook rooms. Cheap to clone (single
/// `Arc` indirection through the tokio mutex).
#[derive(Default)]
pub struct RoomRegistry {
    inner: Mutex<RegistryInner>,
}

impl RoomRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Look up a room by canonical path. On hit, hands the caller an
    /// `Arc` plus a fresh reservation guard.
    pub async fn lookup_path(&self, path: &Path) -> Option<(Arc<NotebookRoom>, ReservationGuard)> {
        let inner = self.inner.lock().await;
        if !inner.accepting_publication {
            return None;
        }
        let uuid = inner.paths.lookup(path)?;
        let room = inner.rooms.get(&uuid)?.clone();
        let guard = ReservationGuard::new(room.clone());
        Some((room, guard))
    }

    /// Look up a room by UUID. On hit, hands the caller an `Arc` plus a
    /// fresh reservation guard.
    pub async fn lookup_uuid(&self, uuid: Uuid) -> Option<(Arc<NotebookRoom>, ReservationGuard)> {
        let inner = self.inner.lock().await;
        if !inner.accepting_publication {
            return None;
        }
        let room = inner.rooms.get(&uuid)?.clone();
        let guard = ReservationGuard::new(room.clone());
        Some((room, guard))
    }

    /// Look up a room by UUID without taking a reservation. Used by
    /// diagnostics (`runt ps`, `list_rooms`) and by tests.
    pub async fn peek_uuid(&self, uuid: Uuid) -> Option<Arc<NotebookRoom>> {
        self.inner.lock().await.rooms.get(&uuid).cloned()
    }

    /// Insert a freshly-built room. Idempotent on UUID and on path:
    /// if a room with the same UUID already exists, or if `path` is
    /// `Some` and another room already owns that path, the existing
    /// `Arc` is returned and the caller's `room` is dropped. The path
    /// coalescing case is what makes two concurrent
    /// `find_room_by_path -> get_or_create_room_result` racers join
    /// the same room instead of one of them seeing
    /// `PathAlreadyOpen`. Only returns `Err` when the path map is
    /// somehow inconsistent (path indexes a UUID that has no room).
    pub async fn insert_or_get(
        &self,
        uuid: Uuid,
        room: Arc<NotebookRoom>,
        path: Option<&Path>,
    ) -> Result<InsertOutcome, PathIndexError> {
        let mut inner = self.inner.lock().await;

        if !inner.accepting_publication {
            return Err(PathIndexError::RegistryFrozen);
        }

        if let Some(existing) = inner.rooms.get(&uuid) {
            let existing = existing.clone();
            let guard = ReservationGuard::new(existing.clone());
            return Ok(InsertOutcome::Existing(existing, guard));
        }

        if let Some(p) = path {
            match inner.paths.insert(p.to_path_buf(), uuid) {
                Ok(()) => {}
                Err(PathIndexError::PathAlreadyOpen {
                    uuid: existing_uuid,
                    ..
                }) => {
                    // Two racers both missed the path lookup; the
                    // winner is already in. Coalesce on the existing
                    // room rather than failing the loser.
                    if let Some(existing) = inner.rooms.get(&existing_uuid) {
                        let existing = existing.clone();
                        let guard = ReservationGuard::new(existing.clone());
                        return Ok(InsertOutcome::Existing(existing, guard));
                    }
                    // Path index points at a UUID with no room: the
                    // registry is inconsistent. Propagate the error so
                    // the caller logs it.
                    return Err(PathIndexError::PathAlreadyOpen {
                        uuid: existing_uuid,
                        path: p.to_path_buf(),
                    });
                }
                Err(error) => return Err(error),
            }
        }
        inner.rooms.insert(uuid, room.clone());
        let guard = ReservationGuard::new(room.clone());
        Ok(InsertOutcome::Inserted(room, guard))
    }

    /// Bind an additional path mapping to an already-registered UUID.
    /// Used by the untitled-promotion path that learns a saved location
    /// after the room was first inserted.
    pub async fn bind_path(&self, uuid: Uuid, path: PathBuf) -> Result<(), PathIndexError> {
        let mut inner = self.inner.lock().await;
        if !inner.accepting_publication {
            return Err(PathIndexError::RegistryFrozen);
        }
        inner.paths.insert(path, uuid)
    }

    /// Release a path binding. No-op if absent.
    pub async fn unbind_path(&self, path: &Path) {
        let mut inner = self.inner.lock().await;
        inner.paths.remove(path);
    }

    /// Conditionally release a path binding only when it still maps to
    /// the given UUID. Returns `true` if the entry was removed. Used by
    /// the ghost reaper so a concurrent save-as that repointed the path
    /// is not stripped.
    pub async fn unbind_path_if_uuid(&self, path: &Path, uuid: Uuid) -> bool {
        let mut inner = self.inner.lock().await;
        if inner.paths.lookup(path) == Some(uuid) {
            inner.paths.remove(path);
            true
        } else {
            false
        }
    }

    /// Atomically replace an old path binding with a new one for save-as.
    /// The old key is removed unconditionally; the new key is inserted and
    /// may fail with `PathAlreadyOpen` if another room holds it.
    pub async fn replace_path(
        &self,
        old: &Path,
        new: PathBuf,
        uuid: Uuid,
    ) -> Result<(), PathIndexError> {
        let mut inner = self.inner.lock().await;
        if !inner.accepting_publication {
            return Err(PathIndexError::RegistryFrozen);
        }
        inner.paths.remove(old);
        inner.paths.insert(new, uuid)
    }

    /// Drain every room out of the registry. Used by shutdown to take
    /// ownership of every room for orderly teardown. Leaves both maps
    /// empty under one lock acquisition.
    pub async fn drain(&self) -> Vec<(Uuid, Arc<NotebookRoom>)> {
        let mut inner = self.inner.lock().await;
        inner.paths = PathIndex::default();
        inner.rooms.drain().collect()
    }

    /// Stop new attaches/publications and return the exact resident set that
    /// the clean-shutdown durability transaction must cover.
    pub async fn freeze_publication_and_snapshot(&self) -> Vec<(Uuid, Arc<NotebookRoom>)> {
        let mut inner = self.inner.lock().await;
        inner.accepting_publication = false;
        inner
            .rooms
            .iter()
            .map(|(uuid, room)| (*uuid, room.clone()))
            .collect()
    }

    /// Re-open publication after a clean shutdown was blocked by durability.
    pub async fn thaw_publication(&self) {
        self.inner.lock().await.accepting_publication = true;
    }

    /// Remove a room from both maps under one lock.
    ///
    /// The caller is responsible for verifying preconditions (no
    /// peers, no reservations, kernel torn down) before calling.
    /// Returns the removed `Arc<NotebookRoom>` so the caller can run
    /// any post-removal cleanup that needs the room.
    pub async fn remove(&self, uuid: Uuid) -> Option<Arc<NotebookRoom>> {
        let mut inner = self.inner.lock().await;
        let room = inner.rooms.remove(&uuid)?;
        inner.paths.remove_by_uuid(uuid);
        Some(room)
    }

    /// Atomically re-check a predicate and remove the room from both
    /// maps if it still holds. Used by the ghost reaper to decide
    /// "remove this room" under the same lock acquisition that any
    /// concurrent connect/save-as would contend for, so a peer
    /// reconnecting between sample and remove cannot race to a half-
    /// removed state.
    ///
    /// `predicate` runs synchronously under the registry lock; it must
    /// not `.await`. The closure receives the resident `Arc` so it can
    /// read atomic counters and the connection generation.
    pub async fn remove_if<F>(&self, uuid: Uuid, predicate: F) -> Option<Arc<NotebookRoom>>
    where
        F: FnOnce(&Arc<NotebookRoom>) -> bool,
    {
        let mut inner = self.inner.lock().await;
        let should = inner.rooms.get(&uuid).map(predicate).unwrap_or(false);
        if !should {
            return None;
        }
        let room = inner.rooms.remove(&uuid)?;
        inner.paths.remove_by_uuid(uuid);
        Some(room)
    }

    /// Snapshot `(uuid, room)` pairs. Used by the reaper and by
    /// diagnostics queries that need to walk all rooms without
    /// holding the lock across per-room async work.
    pub async fn snapshot(&self) -> Vec<(Uuid, Arc<NotebookRoom>)> {
        self.inner
            .lock()
            .await
            .rooms
            .iter()
            .map(|(uuid, room)| (*uuid, room.clone()))
            .collect()
    }

    /// Number of resident rooms.
    pub async fn len(&self) -> usize {
        self.inner.lock().await.rooms.len()
    }

    /// Number of resident path bindings. Used by tests asserting that
    /// the path index converges to one entry per file-backed room.
    #[cfg(test)]
    pub async fn path_count(&self) -> usize {
        self.inner.lock().await.paths.len()
    }

    /// Look up the UUID for a path without taking a reservation. Used
    /// by tests that want to assert on the registry's path index
    /// directly.
    #[cfg(test)]
    pub async fn peek_path_uuid(&self, path: &Path) -> Option<Uuid> {
        self.inner.lock().await.paths.lookup(path)
    }

    /// True when no rooms are resident.
    pub async fn is_empty(&self) -> bool {
        self.inner.lock().await.rooms.is_empty()
    }

    /// Hold the registry's inner lock across a synchronous closure.
    ///
    /// Used by `peer_eviction` to make the
    /// `no_peers && same_generation` check and the
    /// `kernel_teardown_destructive.store(true)` flip atomic against a
    /// racing `lookup_path` / `insert_or_get` on the connect side.
    /// The closure runs without access to the registry's interior;
    /// it borrows the lock purely for serialization.
    ///
    /// The closure is `FnOnce` and non-async; it must not `.await` so
    /// the tokio-mutex-across-await invariant holds.
    pub async fn serialize_with<F, R>(&self, f: F) -> R
    where
        F: FnOnce() -> R,
    {
        let _guard = self.inner.lock().await;
        f()
    }
}
