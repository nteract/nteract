//! Durable sidecar storage for per-notebook `CommentsDoc` documents.
//!
//! The resolver keeps the comment document identity out of `NotebookDoc` for
//! the first local implementation. File-backed notebooks resolve through a
//! canonical path entry, while untitled rooms resolve through their stable room
//! UUID. The document bytes themselves are keyed by `comments_doc_id`.

use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use anyhow::Context;
use comments_doc::{
    local_path_comments_doc_id, local_room_comments_doc_id, CommentsDoc, CommentsDocHandle,
    NotebookCommentRef, COMMENTS_DOC_DEFAULT_ACTOR,
};
use serde::{Deserialize, Serialize};
use sha2::Digest as _;
use tokio::sync::broadcast;
use uuid::Uuid;

const INDEX_FILE: &str = "index.json";
const INDEX_LOCK_FILE: &str = ".index.lock";
const INDEX_VERSION: u32 = 1;
pub(crate) const COMMENTS_DOC_ACTOR: &str = COMMENTS_DOC_DEFAULT_ACTOR;

static INDEX_LOCKS: OnceLock<Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct CommentsSidecarStore {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CommentsLocator {
    LocalPath(PathBuf),
    LocalRoom(Uuid),
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
                CommentsLocator::LocalPath(path) => (
                    &mut index.local_paths,
                    path.to_string_lossy().into_owned(),
                    local_path_comments_doc_id(path.to_string_lossy()),
                ),
                CommentsLocator::LocalRoom(uuid) => (
                    &mut index.local_rooms,
                    uuid.to_string(),
                    local_room_comments_doc_id(uuid.to_string()),
                ),
            };

            if let Some(existing) = map.get(&key) {
                return Ok(existing.clone());
            }

            map.insert(key, fallback.clone());
            Ok(fallback)
        })
    }

    pub(crate) fn bind_doc_id_to_locator(
        &self,
        locator: &CommentsLocator,
        comments_doc_id: &str,
    ) -> anyhow::Result<()> {
        self.with_index_mut(|index| {
            let (map, key) = match locator {
                CommentsLocator::LocalPath(path) => {
                    (&mut index.local_paths, path.to_string_lossy().into_owned())
                }
                CommentsLocator::LocalRoom(uuid) => (&mut index.local_rooms, uuid.to_string()),
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
        locator: &CommentsLocator,
        notebook_ref: &NotebookCommentRef,
    ) -> anyhow::Result<(String, CommentsDocHandle)> {
        let comments_doc_id = self.resolve_doc_id(locator)?;
        let path = self.doc_path(&comments_doc_id);
        let doc = match std::fs::read(&path) {
            Ok(bytes) => CommentsDoc::load_with_actor(&bytes, &comments_doc_id, COMMENTS_DOC_ACTOR)
                .with_context(|| {
                    format!(
                        "load CommentsDoc {} from {}",
                        comments_doc_id,
                        path.display()
                    )
                })?,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                CommentsDoc::try_new_with_actor(&comments_doc_id, notebook_ref, COMMENTS_DOC_ACTOR)
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
        Ok((comments_doc_id, CommentsDocHandle::new(doc, changed_tx)))
    }

    pub fn save_handle(&self, handle: &CommentsDocHandle) -> anyhow::Result<PathBuf> {
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
        self.root.join(format!(
            "{}.automerge",
            comments_doc_filename(comments_doc_id)
        ))
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

pub(crate) fn comments_locator_for_room(uuid: Uuid, path: Option<&Path>) -> CommentsLocator {
    match path {
        Some(path) => CommentsLocator::LocalPath(path.to_path_buf()),
        None => CommentsLocator::LocalRoom(uuid),
    }
}

pub(crate) fn comments_ref_for_room(uuid: Uuid, path: Option<&Path>) -> NotebookCommentRef {
    match path {
        Some(path) => NotebookCommentRef::LocalPath {
            canonical_path: path.to_string_lossy().into_owned(),
        },
        None => NotebookCommentRef::LocalRoom {
            room_id: uuid.to_string(),
        },
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

fn comments_doc_filename(comments_doc_id: &str) -> String {
    hex::encode(sha2::Sha256::digest(comments_doc_id.as_bytes()))
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
    use comments_doc::CommentAnchor;

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
        let path_locator = CommentsLocator::LocalPath(PathBuf::from("/tmp/notebook.ipynb"));
        let room_uuid = Uuid::new_v4();
        let room_locator = CommentsLocator::LocalRoom(room_uuid);

        let path_id = store.resolve_doc_id(&path_locator).unwrap();
        let room_id = store.resolve_doc_id(&room_locator).unwrap();

        assert!(path_id.starts_with("comments:local-path:"));
        assert_eq!(room_id, format!("comments:local-room:{room_uuid}"));
        assert_eq!(store.resolve_doc_id(&path_locator).unwrap(), path_id);
        assert_eq!(store.resolve_doc_id(&room_locator).unwrap(), room_id);
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
    fn resolver_can_bind_new_path_to_existing_doc_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let room_uuid = Uuid::new_v4();
        let room_locator = CommentsLocator::LocalRoom(room_uuid);
        let path_locator = CommentsLocator::LocalPath(PathBuf::from("/tmp/saved.ipynb"));

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
                        &CommentsLocator::LocalPath(PathBuf::from("/tmp/a.ipynb")),
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
                        &CommentsLocator::LocalPath(PathBuf::from("/tmp/b.ipynb")),
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
    fn comments_doc_filename_is_not_raw_id() {
        let id = "comments:local-path:abc";
        let filename = comments_doc_filename(id);
        assert!(!filename.contains(':'));
        assert_ne!(filename, id);
        assert_eq!(filename.len(), 64);
    }

    #[test]
    fn save_and_load_handle_round_trips_by_comments_doc_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let locator = CommentsLocator::LocalRoom(Uuid::new_v4());
        let notebook_ref = NotebookCommentRef::LocalRoom {
            room_id: "room".to_string(),
        };
        let (doc_id, handle) = store.load_or_create(&locator, &notebook_ref).unwrap();

        handle
            .with_doc(|doc| {
                doc.create_thread(
                    "thread-1",
                    "message-1",
                    &CommentAnchor::Notebook,
                    "persisted",
                    None,
                    "2026-06-16T00:00:00Z",
                )?;
                Ok(())
            })
            .unwrap();
        let path = store.save_handle(&handle).unwrap();
        assert_eq!(path, store.doc_path(&doc_id));

        let (_, reloaded) = store.load_or_create(&locator, &notebook_ref).unwrap();
        let projection = reloaded
            .read(|doc| doc.read_projection(&[], None))
            .unwrap()
            .unwrap();
        assert_eq!(projection.comments_doc_id, doc_id);
        assert_eq!(projection.threads.len(), 1);
        assert_eq!(projection.threads[0].messages[0].body, "persisted");
    }

    #[test]
    fn load_rejects_sidecar_with_wrong_comments_doc_id() {
        let tmp = tempfile::tempdir().unwrap();
        let store = CommentsSidecarStore::new(tmp.path().join("comments"));
        let locator = CommentsLocator::LocalRoom(Uuid::new_v4());
        let notebook_ref = NotebookCommentRef::LocalRoom {
            room_id: "room".to_string(),
        };
        let (expected_id, _) = store.load_or_create(&locator, &notebook_ref).unwrap();
        let wrong = CommentsDoc::new(
            "comments:wrong",
            &NotebookCommentRef::LocalRoom {
                room_id: "wrong".to_string(),
            },
        );
        let (tx, _) = broadcast::channel(16);
        let wrong_handle = CommentsDocHandle::new(wrong, tx);
        write_file_atomic(
            &store.doc_path(&expected_id),
            &wrong_handle.with_doc(|doc| Ok(doc.save())).unwrap(),
        )
        .unwrap();

        let err = match store.load_or_create(&locator, &notebook_ref) {
            Ok(_) => panic!("wrong comments_doc_id was accepted"),
            Err(err) => err,
        };
        assert!(
            format!("{err:#}").contains("comments_doc_id mismatch"),
            "{err:#}"
        );
    }
}
