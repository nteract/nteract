//! Temporary Windows controls for the diagnostic branch, not a production fix.
use super::*;
use tokio::net::windows::named_pipe::{ClientOptions, ServerOptions};

#[tokio::test]
async fn diagnostic_named_pipe_ownership_control() {
    let temp = TempDir::new().unwrap();
    let name = test_config(&temp).socket_path;
    let control_name = name.clone();
    // Observe runtime teardown separately from Rust-owner drops. Neither is
    // asserted to drain every native IOCP completion; the synchronous native
    // control below supplies the deterministic ownership baseline.
    tokio::task::spawn_blocking(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async move {
            let name = control_name;
            let accepted = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&name)
                .unwrap();
            let client = ClientOptions::new().open(&name).unwrap();
            accepted.connect().await.unwrap();
            let listener = ServerOptions::new().create(&name).unwrap();
            drop(listener);

            // Deterministic: keep one accepted server alive after listener shutdown.
            let error = ServerOptions::new()
                .first_pipe_instance(true)
                .create(&name)
                .unwrap_err();
            diagnostic!("[pipe-control] retained server: {error:?}");
            assert_eq!(error.raw_os_error(), Some(5));
            drop(accepted);

            // Observe separately whether a surviving CLIENT alone also keeps the name.
            // Do not assume that closing server instances proves full pipe destruction.
            let client_only = ServerOptions::new().first_pipe_instance(true).create(&name);
            diagnostic!("[pipe-control] retained client only: {client_only:?}");
            drop(client_only);
            drop(client);
            let immediate = ServerOptions::new().first_pipe_instance(true).create(&name);
            diagnostic!("[pipe-control] all Rust owners dropped, before IOCP drain: {immediate:?}");
            drop(immediate);
        });
        drop(runtime);
    })
    .await
    .unwrap();
    let replacement = ServerOptions::new().first_pipe_instance(true).create(&name);
    diagnostic!("[pipe-control] after control runtime teardown: {replacement:?}");
    drop(replacement);
}

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

#[test]
fn diagnostic_native_pipe_ownership_control() {
    let temp = TempDir::new().unwrap();
    let name = test_config(&temp).socket_path;
    let first = create_native_pipe(&name, true).unwrap();
    let retained = create_native_pipe(&name, false).unwrap();
    drop(first);
    let error = create_native_pipe(&name, true).unwrap_err();
    diagnostic!("[native-pipe-control] retained instance: {error:?}");
    assert_eq!(error.raw_os_error(), Some(5));
    drop(retained);
    let replacement = create_native_pipe(&name, true);
    diagnostic!("[native-pipe-control] all native handles closed: {replacement:?}");
    assert!(replacement.is_ok());
}

fn start_product_daemon(root: &Path, socket: &Path) -> tokio::process::Child {
    // The product stores journals/locks under the unique dev-worktree cache
    // namespace, outside root. Keep that product behavior for this hosted-CI
    // control; do not substitute the in-process fixture's lock directories.
    let executable = test_runtime_agent_exe().expect("Cargo-built runtimed executable");
    tokio::process::Command::new(executable)
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
        .env("RUNTIMED_PIPE_DIAGNOSTICS", "1")
        .env("RUST_LOG", "runtimed=info")
        .current_dir(root)
        .kill_on_drop(true)
        .spawn()
        .expect("start isolated product daemon")
}

async fn stop_product_daemon(pool: &PoolClient, child: &mut tokio::process::Child) {
    pool.shutdown().await.expect("product shutdown accepted");
    let status = tokio::time::timeout(Duration::from_secs(15), child.wait())
        .await
        .expect("product process exits after shutdown")
        .unwrap();
    diagnostic!("[process-control] confirmed process exit: {status}");
    assert!(status.success());
}

#[tokio::test]
async fn diagnostic_product_process_restart_preserves_receipt_heads() {
    let root = TempDir::new().unwrap();
    let config = test_config(&root);
    let socket = config.socket_path;
    let pool = PoolClient::new(socket.clone());
    let mut first = start_product_daemon(root.path(), &socket);
    diagnostic!(
        "[process-control] first PID={:?}, endpoint={socket:?}",
        first.id()
    );
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
    .expect("independent process-control peer observes accepted heads");
    peer.handle
        .add_cell_with_source("other-peer", "markdown", None, "also accepted")
        .unwrap();
    owner
        .handle
        .update_source("receipt", "accepted = 2")
        .unwrap();
    peer.handle.confirm_notebook_sync().await.unwrap();
    let latest = owner.handle.confirm_notebook_sync().await.unwrap();
    assert_ne!(heads, latest);
    let response = owner
        .handle
        .send_request_after_heads(NotebookRequest::AcknowledgeNotebookSync {}, heads.clone())
        .await
        .unwrap();
    assert!(
        matches!(response, NotebookResponse::NotebookSyncAcknowledged { heads: accepted } if accepted == heads)
    );

    // Keep clients alive until actual process exit, as real app clients can be.
    // No SaveNotebook, endpoint change, fresh lock namespace, or exported file.
    stop_product_daemon(&pool, &mut first).await;
    drop(changed);
    drop(peer);
    drop(owner);
    let mut second = start_product_daemon(root.path(), &socket);
    diagnostic!(
        "[process-control] second PID={:?}, endpoint={socket:?}",
        second.id()
    );
    assert!(
        wait_for_daemon(&pool).await,
        "replacement product daemon becomes ready"
    );
    let recovered = connect::connect(socket, id, "process-recovered")
        .await
        .unwrap();
    assert_session_ready(&recovered.handle, "process recovered").await;
    assert!(recovered.handle.contains_notebook_heads(&latest).unwrap());
    assert_eq!(
        recovered
            .handle
            .get_cells()
            .iter()
            .find(|cell| cell.id == "receipt")
            .unwrap()
            .source,
        "accepted = 2"
    );
    drop(recovered);
    stop_product_daemon(&pool, &mut second).await;
}
