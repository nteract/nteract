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
