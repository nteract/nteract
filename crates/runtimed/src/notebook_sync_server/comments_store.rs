//! Durable sidecar storage for per-notebook `CommentsDoc` documents.
//!
//! File-backed notebooks resolve through a canonical path entry, while
//! untitled rooms resolve through their stable room UUID. Document bytes are
//! keyed by `comments_doc_id`.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Context;
use comments_doc::{
    local_path_comments_doc_id, local_path_comments_identity, local_room_comments_doc_id,
    local_room_comments_identity, CommentsDoc, CommentsDocHandle, NotebookCommentRef,
};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use tokio::sync::broadcast;
use uuid::Uuid;

const INDEX_FILE: &str = "index.json";
const INDEX_LOCK_FILE: &str = ".index.lock";
const INDEX_VERSION: u32 = 1;
pub(crate) const COMMENTS_DOC_ACTOR: &str = "runtimed:comments";

static INDEX_LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub(crate) struct CommentsSidecarStore {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommentsLocator {
    LocalPath { canonical_path: PathBuf },
    LocalRoom { room_id: Uuid },
}

#[derive(Debug, Serialize, Deserialize)]
struct CommentsIndex {
    version: u32,
    #[serde(default)]
    local_paths: BTreeMap<String, String>,
    #[serde(default)]
    local_rooms: BTreeMap<String, String>,
}

impl Default for CommentsIndex {
    fn default() -> Self {
        Self {
            version: INDEX_VERSION,
            local_paths: BTreeMap::new(),
            local_rooms: BTreeMap::new(),
        }
    }
}

impl CommentsSidecarStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn for_notebook_docs_dir(docs_dir: &Path) -> Self {
        Self::new(comments_dir_for_notebook_docs_dir(docs_dir))
    }

    #[cfg(test)]
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    pub(crate) fn resolve_doc_id(&self, locator: &CommentsLocator) -> anyhow::Result<String> {
        self.with_index_mut(|index| {
            let (map, key, fallback) = match locator {
                CommentsLocator::LocalPath { canonical_path } => (
                    &mut index.local_paths,
                    canonical_path.to_string_lossy().into_owned(),
                    local_path_comments_doc_id(canonical_path.to_string_lossy()),
                ),
                CommentsLocator::LocalRoom { room_id } => (
                    &mut index.local_rooms,
                    room_id.to_string(),
                    local_room_comments_doc_id(room_id.to_string()),
                ),
            };

            if let Some(existing) = map.get(&key) {
                return Ok(existing.clone());
            }

            map.insert(key, fallback.clone());
            Ok(fallback)
        })
    }

    #[allow(dead_code)]
    pub(crate) fn bind_doc_id_to_locator(
        &self,
        locator: &CommentsLocator,
        comments_doc_id: &str,
    ) -> anyhow::Result<()> {
        self.with_index_mut(|index| {
            let (map, key) = match locator {
                CommentsLocator::LocalPath { canonical_path } => (
                    &mut index.local_paths,
                    canonical_path.to_string_lossy().into_owned(),
                ),
                CommentsLocator::LocalRoom { room_id } => {
                    (&mut index.local_rooms, room_id.to_string())
                }
            };

            if map
                .get(&key)
                .is_some_and(|existing| existing == comments_doc_id)
            {
                return Ok(());
            }

            map.insert(key, comments_doc_id.to_string());
            Ok(())
        })
    }

    pub(crate) fn load_or_create(
        &self,
        comments_doc_id: &str,
        notebook_ref: &NotebookCommentRef,
    ) -> anyhow::Result<CommentsDocHandle> {
        let path = self.doc_path(comments_doc_id);
        let doc = match std::fs::read(&path) {
            Ok(bytes) => {
                let (mut doc, repaired) = CommentsDoc::load_with_actor_repairing_identity(
                    &bytes,
                    comments_doc_id,
                    notebook_ref,
                    COMMENTS_DOC_ACTOR,
                )
                .with_context(|| {
                    format!(
                        "load CommentsDoc {} from {}",
                        comments_doc_id,
                        path.display()
                    )
                })?;
                if repaired {
                    tracing::warn!(
                        "[comments-store] repaired CommentsDoc identity for {} at {}",
                        comments_doc_id,
                        path.display()
                    );
                    let bytes = doc.save();
                    write_file_atomic(&path, &bytes).with_context(|| {
                        format!(
                            "repair CommentsDoc {} at {}",
                            comments_doc_id,
                            path.display()
                        )
                    })?;
                }
                doc
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                CommentsDoc::try_new_with_actor(comments_doc_id, notebook_ref, COMMENTS_DOC_ACTOR)
                    .with_context(|| format!("create CommentsDoc {comments_doc_id}"))?
            }
            Err(err) => {
                return Err(err).with_context(|| {
                    format!(
                        "read CommentsDoc {} from {}",
                        comments_doc_id,
                        path.display()
                    )
                });
            }
        };

        let (changed_tx, _) = broadcast::channel(16);
        Ok(CommentsDocHandle::new(doc, changed_tx))
    }

    pub(crate) fn save_handle(&self, handle: &CommentsDocHandle) -> anyhow::Result<PathBuf> {
        let (comments_doc_id, bytes) = handle.with_doc(|doc| {
            let comments_doc_id = doc
                .comments_doc_id()
                .ok_or(comments_doc::CommentsDocError::MissingCommentsDocId)?;
            Ok((comments_doc_id, doc.save()))
        })?;
        let path = self.doc_path(&comments_doc_id);
        write_file_atomic(&path, &bytes).with_context(|| {
            format!(
                "write CommentsDoc {} to {}",
                comments_doc_id,
                path.display()
            )
        })?;
        Ok(path)
    }

    pub(crate) fn doc_path(&self, comments_doc_id: &str) -> PathBuf {
        self.root.join(comments_doc_filename(comments_doc_id))
    }

    fn index_path(&self) -> PathBuf {
        self.root.join(INDEX_FILE)
    }

    fn with_index_mut<T>(
        &self,
        f: impl FnOnce(&mut CommentsIndex) -> anyhow::Result<T>,
    ) -> anyhow::Result<T> {
        let lock = index_lock_for_root(&self.root)?;
        let _guard = lock.lock().map_err(|_| {
            anyhow::anyhow!("comments index lock poisoned for {}", self.root.display())
        })?;
        let _file_lock = IndexFileLock::acquire(&self.root)?;
        let mut index = self.load_index()?;
        let result = f(&mut index)?;
        self.save_index(&index)?;
        Ok(result)
    }

    fn load_index(&self) -> anyhow::Result<CommentsIndex> {
        let path = self.index_path();
        match std::fs::read(&path) {
            Ok(bytes) => {
                let index: CommentsIndex = serde_json::from_slice(&bytes)
                    .with_context(|| format!("parse comments index {}", path.display()))?;
                if index.version != INDEX_VERSION {
                    anyhow::bail!(
                        "unsupported comments index version {} at {}",
                        index.version,
                        path.display()
                    );
                }
                Ok(index)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(CommentsIndex::default()),
            Err(err) => Err(err).with_context(|| format!("read comments index {}", path.display())),
        }
    }

    fn save_index(&self, index: &CommentsIndex) -> anyhow::Result<()> {
        let path = self.index_path();
        let bytes = serde_json::to_vec_pretty(index)?;
        write_file_atomic(&path, &bytes)
            .with_context(|| format!("write comments index {}", path.display()))
    }
}

fn index_lock_for_root(root: &Path) -> anyhow::Result<Arc<Mutex<()>>> {
    std::fs::create_dir_all(root)
        .with_context(|| format!("create comments index root {}", root.display()))?;
    let key = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let locks = INDEX_LOCKS.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut locks = locks
        .lock()
        .map_err(|_| anyhow::anyhow!("comments index lock registry poisoned"))?;
    Ok(locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

struct IndexFileLock {
    file: File,
    lock_path: PathBuf,
}

impl IndexFileLock {
    fn acquire(root: &Path) -> anyhow::Result<Self> {
        std::fs::create_dir_all(root)
            .with_context(|| format!("create comments index root {}", root.display()))?;
        let lock_path = root.join(INDEX_LOCK_FILE);
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("open comments index lock {}", lock_path.display()))?;

        lock_index_file(&file, &lock_path)?;

        Ok(Self { file, lock_path })
    }
}

impl Drop for IndexFileLock {
    fn drop(&mut self) {
        unlock_index_file(&self.file, &self.lock_path);
    }
}

#[cfg(unix)]
fn lock_index_file(file: &File, lock_path: &Path) -> anyhow::Result<()> {
    use std::os::fd::AsRawFd;

    loop {
        let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
        if result == 0 {
            return Ok(());
        }
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        return Err(err)
            .with_context(|| format!("acquire comments index lock {}", lock_path.display()));
    }
}

#[cfg(unix)]
fn unlock_index_file(file: &File, _lock_path: &Path) {
    use std::os::fd::AsRawFd;

    unsafe {
        let _ = libc::flock(file.as_raw_fd(), libc::LOCK_UN);
    }
}

#[cfg(windows)]
fn lock_index_file(file: &File, lock_path: &Path) -> anyhow::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::{LockFileEx, LOCKFILE_EXCLUSIVE_LOCK};
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let handle = file.as_raw_handle() as HANDLE;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    let result = unsafe { LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, &mut overlapped) };
    if result == 0 {
        return Err(std::io::Error::last_os_error())
            .with_context(|| format!("acquire comments index lock {}", lock_path.display()));
    }
    Ok(())
}

#[cfg(windows)]
fn unlock_index_file(file: &File, _lock_path: &Path) {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let handle = file.as_raw_handle() as HANDLE;
    let mut overlapped: OVERLAPPED = unsafe { std::mem::zeroed() };
    unsafe {
        let _ = UnlockFileEx(handle, 0, 1, 0, &mut overlapped);
    }
}

pub(crate) fn comments_locator_for_room(
    room_id: Uuid,
    canonical_path: Option<&Path>,
) -> CommentsLocator {
    match canonical_path {
        Some(canonical_path) => CommentsLocator::LocalPath {
            canonical_path: canonical_path.to_path_buf(),
        },
        None => CommentsLocator::LocalRoom { room_id },
    }
}

pub(crate) fn comments_ref_for_room(
    room_id: Uuid,
    canonical_path: Option<&Path>,
) -> NotebookCommentRef {
    match canonical_path {
        Some(canonical_path) => {
            local_path_comments_identity(canonical_path.to_string_lossy().into_owned()).notebook_ref
        }
        None => local_room_comments_identity(room_id.to_string()).notebook_ref,
    }
}

pub(crate) fn comments_dir_for_notebook_docs_dir(docs_dir: &Path) -> PathBuf {
    if docs_dir
        .file_name()
        .is_some_and(|name| name == "notebook-docs")
    {
        if let Some(parent) = docs_dir.parent() {
            return parent.join("comments");
        }
    }
    docs_dir.join("comments")
}

pub(crate) fn comments_doc_filename(comments_doc_id: &str) -> String {
    format!(
        "{}.automerge",
        hex::encode(sha2::Sha256::digest(comments_doc_id.as_bytes()))
    )
}

fn write_file_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = sibling_temp_path(path);
    std::fs::write(&tmp, bytes)?;
    if let Ok(meta) = std::fs::metadata(path) {
        let _ = std::fs::set_permissions(&tmp, meta.permissions());
    }
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(err) => {
            let _ = std::fs::remove_file(&tmp);
            Err(err)
        }
    }
}

fn sibling_temp_path(path: &Path) -> PathBuf {
    static TEMP_COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = TEMP_COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "comments".to_string());
    path.with_file_name(format!(".{file_name}.{}-{n}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use automerge::{sync::SyncDoc, transaction::Transactable, ActorId, ROOT};
    use comments_doc::CommentAnchor;

    fn sync_pair_without_projection_check(a: &mut CommentsDoc, b: &mut CommentsDoc) {
        let mut a_state = automerge::sync::State::new();
        let mut b_state = automerge::sync::State::new();
        for _ in 0..8 {
            if let Some(message) = a.generate_sync_message(&mut a_state) {
                b.doc_mut()
                    .sync()
                    .receive_sync_message(&mut b_state, message)
                    .unwrap();
            }
            if let Some(reply) = b.generate_sync_message(&mut b_state) {
                a.doc_mut()
                    .sync()
                    .receive_sync_message(&mut a_state, reply)
                    .unwrap();
            }
        }
    }

    #[test]
    fn comments_dir_is_sibling_of_notebook_docs_dir() {
        let base = PathBuf::from("/tmp/runt-test");
        assert_eq!(
            comments_dir_for_notebook_docs_dir(&base.join("notebook-docs")),
            base.join("comments")
        );
        assert_eq!(
            comments_dir_for_notebook_docs_dir(&base.join("custom-docs")),
            base.join("custom-docs").join("comments")
        );
    }

    #[test]
    fn resolver_persists_path_and_room_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let path_locator = CommentsLocator::LocalPath {
            canonical_path: PathBuf::from("/tmp/notebook.ipynb"),
        };
        let room_id = Uuid::new_v4();
        let room_locator = CommentsLocator::LocalRoom { room_id };

        let path_id = store.resolve_doc_id(&path_locator).unwrap();
        let room_doc_id = store.resolve_doc_id(&room_locator).unwrap();

        assert!(path_id.starts_with("comments:local-path:"));
        assert_eq!(room_doc_id, format!("comments:local-room:{room_id}"));
        assert_eq!(store.resolve_doc_id(&path_locator).unwrap(), path_id);
        assert_eq!(store.resolve_doc_id(&room_locator).unwrap(), room_doc_id);
        assert!(store.root().join(INDEX_FILE).exists());
        assert!(store.root().join(INDEX_LOCK_FILE).exists());
    }

    #[test]
    fn index_lock_for_root_normalizes_equivalent_paths() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("comments");
        let dotted = root.join(".");

        let root_lock = index_lock_for_root(&root).unwrap();
        let dotted_lock = index_lock_for_root(&dotted).unwrap();

        assert!(Arc::ptr_eq(&root_lock, &dotted_lock));
    }

    #[test]
    fn resolve_doc_id_and_bind_doc_id_to_locator_round_trip() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let room_id = Uuid::new_v4();
        let room_locator = CommentsLocator::LocalRoom { room_id };
        let path_locator = CommentsLocator::LocalPath {
            canonical_path: PathBuf::from("/tmp/saved.ipynb"),
        };

        let comments_doc_id = store.resolve_doc_id(&room_locator).unwrap();
        store
            .bind_doc_id_to_locator(&path_locator, &comments_doc_id)
            .unwrap();

        assert_eq!(
            store.resolve_doc_id(&path_locator).unwrap(),
            comments_doc_id
        );
        let index = store.load_index().unwrap();
        assert_eq!(
            index.local_paths.get("/tmp/saved.ipynb"),
            Some(&comments_doc_id)
        );
    }

    #[test]
    fn concurrent_index_bindings_from_distinct_stores_preserve_aliases() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("comments");
        let store_a = CommentsSidecarStore::new(root.clone());
        let store_b = CommentsSidecarStore::new(root.clone());
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));

        let thread_a = {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store_a
                    .bind_doc_id_to_locator(
                        &CommentsLocator::LocalPath {
                            canonical_path: PathBuf::from("/tmp/a.ipynb"),
                        },
                        "comments:doc-a",
                    )
                    .unwrap();
            })
        };
        let thread_b = {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                store_b
                    .bind_doc_id_to_locator(
                        &CommentsLocator::LocalPath {
                            canonical_path: PathBuf::from("/tmp/b.ipynb"),
                        },
                        "comments:doc-b",
                    )
                    .unwrap();
            })
        };

        thread_a.join().unwrap();
        thread_b.join().unwrap();

        let store = CommentsSidecarStore::new(root);
        let index = store.load_index().unwrap();
        assert_eq!(
            index.local_paths.get("/tmp/a.ipynb"),
            Some(&"comments:doc-a".to_string())
        );
        assert_eq!(
            index.local_paths.get("/tmp/b.ipynb"),
            Some(&"comments:doc-b".to_string())
        );
    }

    #[test]
    fn comments_doc_filename_hashes_raw_id_and_adds_extension() {
        let id = "comments:local-path:abc";
        let filename = comments_doc_filename(id);
        assert!(!filename.contains(':'));
        assert_ne!(filename, id);
        assert_eq!(filename.len(), 74);
        assert!(filename.ends_with(".automerge"));
    }

    #[test]
    fn comments_locator_and_ref_for_room_use_path_when_present() {
        let room_id = Uuid::new_v4();
        let path = PathBuf::from("/tmp/notebook.ipynb");

        assert_eq!(
            comments_locator_for_room(room_id, Some(&path)),
            CommentsLocator::LocalPath {
                canonical_path: path.clone()
            }
        );
        assert_eq!(
            comments_ref_for_room(room_id, Some(&path)),
            NotebookCommentRef::LocalPath {
                canonical_path: "/tmp/notebook.ipynb".to_string()
            }
        );
        assert_eq!(
            comments_locator_for_room(room_id, None),
            CommentsLocator::LocalRoom { room_id }
        );
        assert_eq!(
            comments_ref_for_room(room_id, None),
            NotebookCommentRef::LocalRoom {
                room_id: room_id.to_string()
            }
        );
    }

    #[test]
    fn save_and_load_handle_round_trips_by_comments_doc_id() {
        const AUTHOR: &str = "client:alice";

        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let comments_doc_id = "comments:local-room:room";
        let notebook_ref = NotebookCommentRef::LocalRoom {
            room_id: "room".to_string(),
        };
        let handle = store
            .load_or_create(comments_doc_id, &notebook_ref)
            .unwrap();

        handle
            .with_doc(|doc| {
                doc.doc_mut().set_actor(ActorId::from(AUTHOR.as_bytes()));
                doc.create_thread(
                    "thread-1",
                    "message-1",
                    &CommentAnchor::Notebook,
                    "persisted",
                    None,
                    "2026-06-16T00:00:00Z",
                )?;
                doc.reply(
                    "thread-1",
                    "message-2",
                    "reply persisted",
                    Some("message-1"),
                    "2026-06-16T00:01:00Z",
                )?;
                Ok(())
            })
            .unwrap();
        let path = store.save_handle(&handle).unwrap();
        assert_eq!(path, store.doc_path(comments_doc_id));

        let reloaded = store
            .load_or_create(comments_doc_id, &notebook_ref)
            .unwrap();
        let projection = reloaded
            .read(|doc| doc.read_projection(None))
            .unwrap()
            .unwrap();
        assert_eq!(projection.comments_doc_id, comments_doc_id);
        assert_eq!(projection.threads.len(), 1);
        let thread = &projection.threads[0];
        assert_eq!(thread.created_by_actor_label.as_deref(), Some(AUTHOR));
        assert_eq!(thread.messages.len(), 2);
        assert_eq!(thread.messages[0].body, "persisted");
        assert_eq!(
            thread.messages[0].created_by_actor_label.as_deref(),
            Some(AUTHOR)
        );
        assert_eq!(thread.messages[1].body, "reply persisted");
        assert_eq!(
            thread.messages[1].created_by_actor_label.as_deref(),
            Some(AUTHOR)
        );
    }

    #[test]
    fn load_rejects_sidecar_with_wrong_comments_doc_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let expected_id = "comments:local-room:room";
        let notebook_ref = NotebookCommentRef::LocalRoom {
            room_id: "room".to_string(),
        };
        let wrong = CommentsDoc::new(
            "comments:wrong",
            &NotebookCommentRef::LocalRoom {
                room_id: "wrong".to_string(),
            },
        );
        let (tx, _) = broadcast::channel(16);
        let wrong_handle = CommentsDocHandle::new(wrong, tx);
        write_file_atomic(
            &store.doc_path(expected_id),
            &wrong_handle.with_doc(|doc| Ok(doc.save())).unwrap(),
        )
        .unwrap();

        let err = match store.load_or_create(expected_id, &notebook_ref) {
            Ok(_) => panic!("wrong comments_doc_id was accepted"),
            Err(err) => err,
        };
        assert!(
            format!("{err:#}").contains("comments_doc_id mismatch"),
            "{err:#}"
        );
    }

    #[test]
    fn load_repairs_conflicting_sidecar_identity() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let expected_id = "comments:local-room:room";
        let expected_ref = NotebookCommentRef::LocalRoom {
            room_id: "room".to_string(),
        };
        let stale_ref = NotebookCommentRef::HostedRoom {
            room_locator: "room".to_string(),
        };
        let mut base = CommentsDoc::new_with_actor(expected_id, &stale_ref, "client:base");
        base.create_thread(
            "thread-1",
            "message-1",
            &CommentAnchor::Notebook,
            "survives repair",
            None,
            "2026-06-16T00:00:00Z",
        )
        .unwrap();
        let bytes = base.save();
        let mut base = CommentsDoc::load_with_actor(&bytes, expected_id, "client:base").unwrap();
        let mut other = CommentsDoc::load_with_actor(&bytes, expected_id, "client:other").unwrap();
        base.doc_mut()
            .put(&ROOT, "comments_doc_id", "comments:stale")
            .unwrap();
        other
            .doc_mut()
            .put(&ROOT, "comments_doc_id", "comments:other")
            .unwrap();
        sync_pair_without_projection_check(&mut other, &mut base);

        let path = store.doc_path(expected_id);
        write_file_atomic(&path, &base.save()).unwrap();

        let repaired = store.load_or_create(expected_id, &expected_ref).unwrap();
        repaired
            .read(|doc| {
                assert_eq!(doc.comments_doc_id().as_deref(), Some(expected_id));
                assert_eq!(doc.raw_comments_doc_id().as_deref(), Some(expected_id));
                assert_eq!(doc.notebook_ref(), Some(expected_ref.clone()));
                let projection = doc.read_projection(None).unwrap();
                assert_eq!(projection.comments_doc_id, expected_id);
                assert_eq!(projection.threads.len(), 1);
                assert_eq!(projection.threads[0].messages[0].body, "survives repair");
            })
            .unwrap();

        let persisted = std::fs::read(&path).unwrap();
        let persisted = CommentsDoc::load_with_actor(&persisted, expected_id, "strict").unwrap();
        assert_eq!(
            persisted.raw_comments_doc_id().as_deref(),
            Some(expected_id)
        );
        assert_eq!(persisted.notebook_ref(), Some(expected_ref));
    }
}
