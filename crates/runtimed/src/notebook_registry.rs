//! Daemon-local persistent path -> notebook id registry.
//!
//! A `notebook_id` is otherwise a fresh UUID minted per daemon process for each
//! file open (`daemon.rs`, `Uuid::new_v4()` at the open-by-path sites). The same
//! `.ipynb` therefore gets a different id every daemon lifetime, which churns the
//! id-keyed Automerge doc in `docs_dir`, the room identity, and any by-id
//! reference. This store records `canonical path -> id` in a daemon-local sqlite
//! file (mirroring `trusted-packages.sqlite`) so opening the same file always
//! resolves to the same id, across restarts and upgrades.
//!
//! It is best-effort: any sqlite failure degrades to today's mint-a-fresh-UUID
//! behavior. A notebook open never fails because the registry is unavailable.
//!
//! See `docs/adr/notebook-identity-and-path-binding.md` (NIP-1).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension};
use tracing::warn;
use uuid::Uuid;

#[derive(Debug)]
enum Inner {
    Sqlite { conn: Mutex<Connection> },
    Unavailable { reason: String },
}

/// Persistent canonical-path -> notebook-id registry. Cheap to clone (an `Arc`
/// inside); shared across the daemon.
#[derive(Debug, Clone)]
pub struct NotebookRegistry {
    inner: Arc<Inner>,
}

impl Default for NotebookRegistry {
    fn default() -> Self {
        Self::unavailable("not configured")
    }
}

impl NotebookRegistry {
    /// Open (creating if needed) the registry at `path`.
    pub fn open(path: PathBuf) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("create notebook registry dir {}", parent.display()))?;
        }
        let conn = Connection::open(&path)
            .with_context(|| format!("open notebook registry {}", path.display()))?;
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS notebook_paths (
                canonical_path TEXT PRIMARY KEY,
                notebook_id    TEXT NOT NULL,
                recorded_at    TEXT NOT NULL
            );
            "#,
        )
        .with_context(|| format!("initialize notebook registry {}", path.display()))?;

        Ok(Self {
            inner: Arc::new(Inner::Sqlite {
                conn: Mutex::new(conn),
            }),
        })
    }

    /// A no-op registry that always mints fresh ids. Used when the sqlite file
    /// cannot be opened, and as the default for `RoomRegistry` in tests.
    pub fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            inner: Arc::new(Inner::Unavailable {
                reason: reason.into(),
            }),
        }
    }

    /// `Some(reason)` when the store is not backed by sqlite.
    pub fn unavailable_reason(&self) -> Option<&str> {
        match self.inner.as_ref() {
            Inner::Sqlite { .. } => None,
            Inner::Unavailable { reason } => Some(reason.as_str()),
        }
    }

    /// Return the id already bound to `canonical`, or `None` if unknown /
    /// unavailable.
    pub fn lookup(&self, canonical: &Path) -> Option<Uuid> {
        let conn = match self.inner.as_ref() {
            Inner::Sqlite { conn } => conn,
            Inner::Unavailable { .. } => return None,
        };
        let key = path_key(canonical)?;
        let guard = conn.lock().unwrap_or_else(|e| e.into_inner());
        let stored: Option<String> = guard
            .query_row(
                "SELECT notebook_id FROM notebook_paths WHERE canonical_path = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or_else(|e| {
                warn!("[notebook-registry] lookup({key}) failed: {e}");
                None
            });
        stored.and_then(|s| Uuid::parse_str(&s).ok())
    }

    /// Resolve `canonical` to its stable id, assigning and recording a fresh one
    /// on first sight. Concurrency-safe: a racing assign for the same path
    /// resolves to a single winner via `INSERT OR IGNORE` + re-select.
    ///
    /// When the store is unavailable this is just `Uuid::new_v4()`, i.e. the
    /// pre-registry behavior.
    pub fn resolve_or_assign(&self, canonical: &Path, recorded_at: &str) -> Uuid {
        // Common case: the file is already known. Read first so reopening does
        // not write on every open.
        if let Some(existing) = self.lookup(canonical) {
            return existing;
        }
        let conn = match self.inner.as_ref() {
            Inner::Sqlite { conn } => conn,
            Inner::Unavailable { .. } => return Uuid::new_v4(),
        };
        let Some(key) = path_key(canonical) else {
            return Uuid::new_v4();
        };
        let candidate = Uuid::new_v4();
        let guard = conn.lock().unwrap_or_else(|e| e.into_inner());

        if let Err(e) = guard.execute(
            "INSERT OR IGNORE INTO notebook_paths (canonical_path, notebook_id, recorded_at) \
             VALUES (?1, ?2, ?3)",
            params![key, candidate.to_string(), recorded_at],
        ) {
            warn!("[notebook-registry] assign({key}) failed: {e}; using fresh id");
            return candidate;
        }

        let stored: Option<String> = guard
            .query_row(
                "SELECT notebook_id FROM notebook_paths WHERE canonical_path = ?1",
                params![key],
                |row| row.get(0),
            )
            .optional()
            .unwrap_or(None);

        match stored.and_then(|s| Uuid::parse_str(&s).ok()) {
            Some(id) => id,
            // The row vanished or is corrupt between insert and select; fall back
            // to the candidate rather than failing the open.
            None => candidate,
        }
    }

    /// Bind `canonical` to `id`, overwriting any prior binding. Used when a save
    /// claims a path for a room (untitled->save, save-as): the file at that path
    /// is now this room, so the registry must reflect it. Best-effort.
    pub fn record(&self, canonical: &Path, id: Uuid, recorded_at: &str) {
        let conn = match self.inner.as_ref() {
            Inner::Sqlite { conn } => conn,
            Inner::Unavailable { .. } => return,
        };
        let Some(key) = path_key(canonical) else {
            return;
        };
        let guard = conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = guard.execute(
            "INSERT INTO notebook_paths (canonical_path, notebook_id, recorded_at) \
             VALUES (?1, ?2, ?3) \
             ON CONFLICT(canonical_path) DO UPDATE SET \
                 notebook_id = excluded.notebook_id, recorded_at = excluded.recorded_at",
            params![key, id.to_string(), recorded_at],
        ) {
            warn!("[notebook-registry] record({key}) failed: {e}");
        }
    }

    /// Drop the binding for `canonical`. Used on save-as so the old path no
    /// longer resolves to the moved room's id (a future file at that path is a
    /// new notebook). Best-effort.
    pub fn forget(&self, canonical: &Path) {
        let conn = match self.inner.as_ref() {
            Inner::Sqlite { conn } => conn,
            Inner::Unavailable { .. } => return,
        };
        let Some(key) = path_key(canonical) else {
            return;
        };
        let guard = conn.lock().unwrap_or_else(|e| e.into_inner());
        if let Err(e) = guard.execute(
            "DELETE FROM notebook_paths WHERE canonical_path = ?1",
            params![key],
        ) {
            warn!("[notebook-registry] forget({key}) failed: {e}");
        }
    }
}

/// The sqlite key for a path: its UTF-8 form. Non-UTF8 paths return `None` and
/// degrade to mint-fresh / no-op, rather than risk two distinct paths colliding
/// on the same lossy `U+FFFD` key.
fn path_key(canonical: &Path) -> Option<&str> {
    canonical.to_str()
}

#[cfg(test)]
mod tests {
    use super::*;

    const TS: &str = "2026-06-24T00:00:00Z";

    #[test]
    fn same_path_resolves_to_same_id_across_reopen() {
        // Simulates a daemon restart: a new store over the same sqlite file must
        // hand back the id assigned in the previous "run".
        let tmp = tempfile::TempDir::new().unwrap();
        let db = tmp.path().join("notebook-registry.sqlite");
        let path = Path::new("/Users/me/fasty.ipynb");

        let first = {
            let store = NotebookRegistry::open(db.clone()).unwrap();
            store.resolve_or_assign(path, TS)
        };
        let second = {
            let store = NotebookRegistry::open(db.clone()).unwrap();
            store.resolve_or_assign(path, TS)
        };
        assert_eq!(first, second, "same file must keep its id across restarts");

        let looked_up = NotebookRegistry::open(db).unwrap().lookup(path);
        assert_eq!(looked_up, Some(first));
    }

    #[test]
    fn distinct_paths_get_distinct_ids() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = NotebookRegistry::open(tmp.path().join("r.sqlite")).unwrap();
        let a = store.resolve_or_assign(Path::new("/a.ipynb"), TS);
        let b = store.resolve_or_assign(Path::new("/b.ipynb"), TS);
        assert_ne!(a, b);
    }

    #[test]
    fn repeated_resolve_is_idempotent_within_a_run() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = NotebookRegistry::open(tmp.path().join("r.sqlite")).unwrap();
        let p = Path::new("/a.ipynb");
        assert_eq!(
            store.resolve_or_assign(p, TS),
            store.resolve_or_assign(p, TS)
        );
    }

    #[test]
    fn lookup_unknown_path_is_none() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = NotebookRegistry::open(tmp.path().join("r.sqlite")).unwrap();
        assert_eq!(store.lookup(Path::new("/never-seen.ipynb")), None);
    }

    #[test]
    fn record_binds_and_overwrites_then_survives_reopen() {
        let tmp = tempfile::TempDir::new().unwrap();
        let db = tmp.path().join("r.sqlite");
        let p = Path::new("/Users/me/saved.ipynb");
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();

        {
            let store = NotebookRegistry::open(db.clone()).unwrap();
            store.record(p, first, TS);
            assert_eq!(store.lookup(p), Some(first));
            // A later save of a different room to the same path wins.
            store.record(p, second, TS);
            assert_eq!(store.lookup(p), Some(second));
        }
        // Survives a "restart".
        let reopened = NotebookRegistry::open(db).unwrap();
        assert_eq!(reopened.lookup(p), Some(second));
        // And a recorded id is what a subsequent open-by-path resolves to.
        assert_eq!(reopened.resolve_or_assign(p, TS), second);
    }

    #[test]
    fn save_as_forgets_old_path_and_binds_new() {
        let tmp = tempfile::TempDir::new().unwrap();
        let store = NotebookRegistry::open(tmp.path().join("r.sqlite")).unwrap();
        let old = Path::new("/old.ipynb");
        let new = Path::new("/new.ipynb");
        let id = store.resolve_or_assign(old, TS);

        // Save-as: move the binding to the new path.
        store.forget(old);
        store.record(new, id, TS);

        assert_eq!(store.lookup(new), Some(id));
        // The old path is free: a new file there gets a fresh id, not the moved one.
        let reused = store.resolve_or_assign(old, TS);
        assert_ne!(reused, id);
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_path_degrades_to_fresh_and_never_persists() {
        use std::os::unix::ffi::OsStrExt;
        let tmp = tempfile::TempDir::new().unwrap();
        let store = NotebookRegistry::open(tmp.path().join("r.sqlite")).unwrap();
        // A path with an invalid UTF-8 byte must not be keyed by its lossy form
        // (which could collide with another bad path); it degrades to fresh.
        let bad = PathBuf::from(std::ffi::OsStr::from_bytes(b"/tmp/\xff.ipynb"));
        let a = store.resolve_or_assign(&bad, TS);
        let b = store.resolve_or_assign(&bad, TS);
        assert_ne!(
            a, b,
            "non-UTF8 paths are not persisted; each open mints fresh"
        );
        assert_eq!(store.lookup(&bad), None);
    }

    #[test]
    fn unavailable_store_mints_fresh_and_never_persists() {
        // Degraded mode must not fail and must not pretend to remember anything.
        let store = NotebookRegistry::unavailable("test");
        assert!(store.unavailable_reason().is_some());
        let p = Path::new("/a.ipynb");
        let a = store.resolve_or_assign(p, TS);
        let b = store.resolve_or_assign(p, TS);
        assert_ne!(a, b, "no sqlite backing, so no stable id");
        assert_eq!(store.lookup(p), None);
    }
}
