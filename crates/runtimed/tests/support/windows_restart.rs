use std::path::Path;
use std::time::Duration;

// No overlapped I/O or runtime owns these handles: OwnedHandle::drop calls
// CloseHandle directly, providing a deterministic kernel-object baseline.
fn create_native_pipe(
    name: &Path,
    first: bool,
) -> std::io::Result<std::os::windows::io::OwnedHandle> {
    use std::os::windows::ffi::OsStrExt;
    use std::os::windows::io::{FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_FIRST_PIPE_INSTANCE, PIPE_ACCESS_DUPLEX,
    };
    use windows_sys::Win32::System::Pipes::{
        CreateNamedPipeW, PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
    };
    let name: Vec<_> = name.as_os_str().encode_wide().chain(Some(0)).collect();
    let flags = PIPE_ACCESS_DUPLEX
        | if first {
            FILE_FLAG_FIRST_PIPE_INSTANCE
        } else {
            0
        };
    // SAFETY: NUL-terminated name is alive for the call; default security is
    // requested, and a successful newly-owned handle is transferred exactly once.
    let handle = unsafe {
        CreateNamedPipeW(
            name.as_ptr(),
            flags,
            PIPE_TYPE_BYTE | PIPE_WAIT,
            PIPE_UNLIMITED_INSTANCES,
            1024,
            1024,
            0,
            std::ptr::null(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: CreateNamedPipeW returned a valid, uniquely owned handle.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle as _) })
}

// Claiming FIRST_PIPE_INSTANCE is the kernel's proof that every previous pipe
// instance has been released. The probe owns no asynchronous I/O; dropping its
// handle synchronously leaves the name free for the actual replacement.
pub(super) async fn wait_for_pipe_release(name: &Path) -> std::io::Result<()> {
    loop {
        match create_native_pipe(name, true) {
            Ok(probe) => {
                drop(probe);
                return Ok(());
            }
            Err(error) if error.raw_os_error() == Some(5) => {
                // Allow detached connection teardown and IOCP cancellation to
                // progress. The caller's existing shutdown deadline bounds this.
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
            Err(error) => return Err(error),
        }
    }
}

#[tokio::test]
async fn pipe_release_barrier_requires_all_native_instances_to_close() {
    let temp = tempfile::TempDir::new().unwrap();
    let name = super::test_config(&temp).socket_path;
    let first = create_native_pipe(&name, true).unwrap();
    let retained = create_native_pipe(&name, false).unwrap();
    drop(first);
    let barrier = wait_for_pipe_release(&name);
    tokio::pin!(barrier);
    assert!(matches!(
        futures::poll!(&mut barrier),
        std::task::Poll::Pending
    ));
    drop(retained);
    tokio::time::timeout(Duration::from_secs(2), &mut barrier)
        .await
        .unwrap()
        .unwrap();
    assert!(create_native_pipe(&name, true).is_ok());
}

#[tokio::test]
async fn pipe_release_barrier_propagates_non_lifetime_errors() {
    let error = wait_for_pipe_release(Path::new("not-a-named-pipe"))
        .await
        .unwrap_err();
    assert_ne!(error.raw_os_error(), Some(5));
}

// Write evidence directly to stderr so passing-test observations survive normal
// libtest capture in the existing Build workflow.
fn process_restart_evidence(message: std::fmt::Arguments<'_>) {
    use std::io::Write as _;
    let _ = writeln!(std::io::stderr(), "[process-restart] {message}");
}

fn start_product_daemon(root: &Path, socket: &Path) -> tokio::process::Child {
    tokio::process::Command::new(
        super::test_runtime_agent_exe().expect("Cargo-built runtimed executable"),
    )
    .arg("run")
    .arg("--socket")
    .arg(socket)
    .arg("--cache-dir")
    .arg(root.join("envs"))
    .arg("--blob-store-dir")
    .arg(root.join("blobs"))
    .arg("--settings-json")
    .arg(root.join("settings.json"))
    .args([
        "--uv-pool-size",
        "0",
        "--conda-pool-size",
        "0",
        "--pixi-pool-size",
        "0",
    ])
    .env("RUNTIMED_DEV", "1")
    .env("RUNTIMED_WORKSPACE_PATH", root)
    .env("RUST_LOG", "runtimed=info")
    .current_dir(root)
    .kill_on_drop(true)
    .spawn()
    .expect("start product daemon in unique test namespace")
}

async fn stop_product_daemon(
    pool: &runtimed::client::PoolClient,
    child: &mut tokio::process::Child,
) {
    let status = tokio::time::timeout(Duration::from_secs(15), async {
        pool.shutdown().await.expect("product shutdown accepted");
        child.wait().await.expect("wait for product process")
    })
    .await
    .expect("product shutdown and process exit finish within 15 seconds");
    process_restart_evidence(format_args!("confirmed process exit: {status}"));
    assert!(status.success(), "product process must exit cleanly");
}

#[tokio::test]
async fn process_restart_recovers_journal_only_untitled_notebook() {
    use super::{assert_session_ready, create_spec, test_config, wait_for_daemon};
    use notebook_sync::connect;
    use runtimed::client::PoolClient;
    use runtimed::daemon::Daemon;
    use runtimed::protocol::{NotebookRequest, NotebookResponse};
    use sha2::{Digest, Sha256};

    let root = tempfile::TempDir::new().unwrap();
    let socket = test_config(&root).socket_path;
    // Match daemon_base_dir() for the child-only dev workspace environment.
    // Product journals and locks are outside root, in this unique cache path;
    // do not substitute the in-process fixture's directories or mutate the
    // parent process environment while other integration tests may be running.
    let daemon_dir = dirs::cache_dir()
        .expect("Windows cache directory")
        .join(runt_workspace::cache_namespace())
        .join("worktrees")
        .join(runt_workspace::worktree_hash(root.path()));
    assert!(
        !daemon_dir.exists(),
        "process test requires a fresh namespace"
    );
    let pool = PoolClient::new(socket.clone());
    let mut first = start_product_daemon(root.path(), &socket);
    process_restart_evidence(format_args!(
        "first PID={:?}, endpoint={socket:?}, state={daemon_dir:?}",
        first.id()
    ));
    assert!(
        wait_for_daemon(&pool).await,
        "first product daemon becomes ready"
    );
    let owner = connect::connect_create(socket.clone(), create_spec("process-owner"))
        .await
        .unwrap();
    let id = owner.info.notebook_id.clone();
    let peer = connect::connect(socket.clone(), id.clone(), "process-peer")
        .await
        .unwrap();
    assert_session_ready(&owner.handle, "process owner").await;
    assert_session_ready(&peer.handle, "process peer").await;
    owner
        .handle
        .add_cell_with_source("receipt", "code", None, "accepted = True")
        .unwrap();
    let heads = owner.handle.confirm_notebook_sync().await.unwrap();
    let mut changed = peer.handle.subscribe();
    tokio::time::timeout(Duration::from_secs(3), async {
        while !peer.handle.contains_notebook_heads(&heads).unwrap() {
            changed.changed().await.unwrap();
        }
    })
    .await
    .expect("independent peer observes acknowledged heads");
    peer.handle
        .add_cell_with_source("other-peer", "markdown", None, "also accepted")
        .unwrap();
    owner
        .handle
        .update_source("receipt", "accepted = 2")
        .unwrap();
    let peer_heads = peer.handle.confirm_notebook_sync().await.unwrap();
    let latest = owner.handle.confirm_notebook_sync().await.unwrap();
    assert_ne!(heads, latest);
    let response = owner
        .handle
        .send_request_after_heads(NotebookRequest::AcknowledgeNotebookSync {}, heads.clone())
        .await
        .unwrap();
    assert!(matches!(response,
        NotebookResponse::NotebookSyncAcknowledged { heads: accepted } if accepted == heads
    ));

    // Real clients can outlive the daemon. Require OS process exit before
    // touching this test's state, with no SaveNotebook/export or lock change.
    stop_product_daemon(&pool, &mut first).await;
    drop(changed);
    drop(peer);
    drop(owner);

    let snapshot = daemon_dir
        .join("notebook-docs")
        .join(notebook_doc::notebook_doc_filename(&id));
    let journal = snapshot.with_extension("recovery");
    let journal_before = std::fs::read(&journal).expect("acknowledged work has a journal");
    let facts = Daemon::test_recovery_manifest_facts(&journal)
        .expect("product wrote a recoverable journal record");
    assert_eq!(facts.notebook_id, uuid::Uuid::parse_str(&id).unwrap());
    assert_eq!(
        facts.canonical_path, None,
        "journal belongs to an untitled notebook"
    );
    assert!(facts.durable_head_count > 0);
    assert_eq!(
        facts.file_save_sequence, None,
        "no file checkpoint was exported"
    );
    // Deterministically exercise journal-only admission even if the legacy
    // debouncer happened to finish before process exit. Preserve its bytes as
    // evidence; only this fresh test namespace is touched.
    let quarantined = snapshot.exists();
    if quarantined {
        std::fs::rename(
            &snapshot,
            snapshot.with_extension("automerge.test-quarantine"),
        )
        .expect("quarantine test-owned legacy snapshot after process exit");
    }
    assert!(
        !snapshot.exists(),
        "replacement must not have a legacy snapshot"
    );
    assert_eq!(
        std::fs::read(&journal).unwrap(),
        journal_before,
        "journal remains unchanged"
    );
    process_restart_evidence(format_args!(
        "validated journal={journal:?}, UUID={}, durable_heads={}, bytes={}, sha256={:x}, legacy_snapshot_quarantined={quarantined}",
        facts.notebook_id, facts.durable_head_count, journal_before.len(), Sha256::digest(&journal_before)
    ));

    let mut second = start_product_daemon(root.path(), &socket);
    process_restart_evidence(format_args!(
        "second PID={:?}, same endpoint={socket:?}",
        second.id()
    ));
    assert!(
        wait_for_daemon(&pool).await,
        "replacement product daemon becomes ready"
    );
    let recovered = connect::connect(socket, id, "process-recovered")
        .await
        .expect("UUID reconnect restores the journal-only notebook");
    assert_session_ready(&recovered.handle, "process recovered").await;
    assert!(recovered.handle.contains_notebook_heads(&latest).unwrap());
    assert!(recovered
        .handle
        .contains_notebook_heads(&peer_heads)
        .unwrap());
    let cells = recovered.handle.get_cells();
    assert_eq!(
        cells
            .iter()
            .find(|cell| cell.id == "receipt")
            .unwrap()
            .source,
        "accepted = 2"
    );
    assert_eq!(
        cells
            .iter()
            .find(|cell| cell.id == "other-peer")
            .unwrap()
            .source,
        "also accepted"
    );
    process_restart_evidence(format_args!(
        "recovered owner and peer heads plus both cell sources"
    ));
    drop(recovered);
    stop_product_daemon(&pool, &mut second).await;
}
