//! Singleton management for the pool daemon.
//!
//! Ensures only one daemon instance runs per user using file-based locking.
//! Read-only daemon discovery lives in `runtimed_client::singleton` and queries
//! the daemon socket directly.

use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::PathBuf;

use tracing::{info, warn};

// Re-export all client-side singleton items so `runtimed::singleton::*` still works.
use runtimed_client::singleton as client_singleton;
pub use runtimed_client::singleton::{daemon_lock_path, query_daemon_info, DaemonInfo};

/// A lock that ensures only one daemon instance runs.
pub struct DaemonLock {
    _lock_file: File,
    _lock_path: PathBuf,
}

impl DaemonLock {
    /// Attempt to acquire the daemon lock.
    ///
    /// Returns `Ok(lock)` if we acquired the lock (we are the singleton).
    /// Returns `Err(info)` if another daemon is running (with its info).
    ///
    /// If `custom_lock_dir` is provided, uses that directory for lock files
    /// instead of the default. This is primarily for testing.
    pub fn try_acquire(
        custom_lock_dir: Option<&PathBuf>,
    ) -> Result<Self, Box<client_singleton::DaemonInfo>> {
        let lock_path = if let Some(dir) = custom_lock_dir {
            dir.join("daemon.lock")
        } else {
            client_singleton::daemon_lock_path()
        };

        // Ensure parent directory exists
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent).ok();
        }

        // Try to open/create the lock file
        let lock_file = match OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&lock_path)
        {
            Ok(f) => f,
            Err(e) => {
                warn!("[singleton] Failed to open lock file: {}", e);
                return Err(Box::new(placeholder_daemon_info(custom_lock_dir)));
            }
        };

        // Try to acquire exclusive lock (non-blocking)
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let fd = lock_file.as_raw_fd();
            let result = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                // Another process holds the lock
                info!("[singleton] Another daemon is already running");
                return Err(Box::new(placeholder_daemon_info(custom_lock_dir)));
            }
        }

        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::HANDLE;
            use windows_sys::Win32::Storage::FileSystem::{
                LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
            };

            let handle = lock_file.as_raw_handle() as HANDLE;
            // SAFETY: zeroed is valid for OVERLAPPED struct
            let mut overlapped = unsafe { std::mem::zeroed() };
            let result = unsafe {
                LockFileEx(
                    handle,
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    0,
                    1,
                    0,
                    &mut overlapped,
                )
            };
            if result == 0 {
                info!("[singleton] Another daemon is already running");
                return Err(Box::new(placeholder_daemon_info(custom_lock_dir)));
            }
        }

        info!("[singleton] Acquired daemon lock");

        Ok(Self {
            _lock_file: lock_file,
            _lock_path: lock_path,
        })
    }
}

impl Drop for DaemonLock {
    fn drop(&mut self) {
        // Release the advisory lock explicitly before returning from Drop.
        // Relying only on File's field drop is usually enough, but macOS CI has
        // observed an immediate re-acquire in the same process racing the close.
        #[cfg(unix)]
        unsafe {
            libc::flock(self._lock_file.as_raw_fd(), libc::LOCK_UN);
        }
        info!("[singleton] Released daemon lock");
    }
}

fn placeholder_daemon_info(custom_lock_dir: Option<&PathBuf>) -> client_singleton::DaemonInfo {
    let endpoint = custom_lock_dir
        .map(|dir| dir.join("runtimed.sock"))
        .unwrap_or_else(runt_workspace::default_socket_path);
    client_singleton::DaemonInfo {
        endpoint: endpoint.to_string_lossy().to_string(),
        pid: 0,
        version: "unknown".to_string(),
        started_at: chrono::Utc::now(),
        blob_port: None,
        execution_store_dir: None,
        worktree_path: None,
        workspace_description: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    type TestResult = Result<(), Box<dyn std::error::Error>>;

    #[test]
    fn try_acquire_succeeds_in_empty_dir() -> TestResult {
        // Fresh directory with no existing daemon → we should be the singleton.
        let tmp = TempDir::new()?;
        let dir = tmp.path().to_path_buf();
        let _lock = DaemonLock::try_acquire(Some(&dir)).map_err(|_| "should acquire empty dir")?;
        Ok(())
    }

    #[test]
    fn try_acquire_conflicts_when_lock_held() -> TestResult {
        // Second acquire on the same directory must fail while the first
        // lock is alive. This is the whole point of the singleton —
        // regressing it would allow concurrent daemons stomping on each
        // other's sockets.
        let tmp = TempDir::new()?;
        let dir = tmp.path().to_path_buf();
        let first = DaemonLock::try_acquire(Some(&dir)).map_err(|_| "first acquire")?;

        let Err(info) = DaemonLock::try_acquire(Some(&dir)) else {
            return Err("second acquire should have failed".into());
        };
        assert_eq!(
            info.endpoint,
            dir.join("runtimed.sock").to_string_lossy().as_ref()
        );
        assert_eq!(info.pid, 0);
        assert_eq!(info.version, "unknown");
        drop(first);
        Ok(())
    }

    #[test]
    fn drop_releases_lock() -> TestResult {
        // After the first lock drops, a second acquire must succeed.
        let tmp = TempDir::new()?;
        let dir = tmp.path().to_path_buf();
        {
            let _lock = DaemonLock::try_acquire(Some(&dir)).map_err(|_| "first acquire")?;
        }
        let _second = DaemonLock::try_acquire(Some(&dir)).map_err(|_| "re-acquire after drop")?;
        Ok(())
    }

    #[test]
    fn try_acquire_creates_parent_dir() -> TestResult {
        // The daemon base dir may not exist yet on first run. Acquire
        // must create it rather than failing with ENOENT.
        let tmp = TempDir::new()?;
        let nested = tmp.path().join("deep/nested/dir");
        assert!(!nested.exists());
        let _lock =
            DaemonLock::try_acquire(Some(&nested)).map_err(|_| "acquire in nonexistent dir")?;
        assert!(nested.exists());
        assert!(nested.join("daemon.lock").exists());
        Ok(())
    }
}
