//! Singleton management for the pool daemon.
//!
//! Ensures only one daemon instance runs per user using file-based locking.
//! Read-only daemon discovery lives in `runtimed_client::singleton` and queries
//! the daemon socket directly.

use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::PathBuf;

use tracing::info;

// Re-export all client-side singleton items so `runtimed::singleton::*` still works.
use runtimed_client::singleton as client_singleton;
pub use runtimed_client::singleton::{daemon_lock_path, query_daemon_info, DaemonInfo};

/// A lock that ensures only one daemon instance runs.
pub struct DaemonLock {
    _lock_file: File,
    _lock_path: PathBuf,
}

/// Failure to claim the runtime's state directory. Contention says nothing
/// about the holder's identity or whether its socket is ready.
#[derive(Debug, thiserror::Error)]
pub enum DaemonLockError {
    #[error("Another process holds the daemon lock at {path}")]
    Contended { path: PathBuf },
    #[error("Failed to {operation} daemon lock at {path}: {source}")]
    Io {
        operation: &'static str,
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl DaemonLock {
    /// Attempt to acquire the daemon lock.
    ///
    /// Returns `Ok(lock)` if we acquired the lock (we are the singleton).
    /// Returns `Contended` if another process holds the lock, or `Io` for a
    /// filesystem/locking failure. Neither outcome fabricates daemon metadata.
    ///
    /// If `custom_lock_dir` is provided, uses that directory for lock files
    /// instead of the default. This is primarily for testing.
    pub fn try_acquire(custom_lock_dir: Option<&PathBuf>) -> Result<Self, DaemonLockError> {
        let lock_path = if let Some(dir) = custom_lock_dir {
            dir.join("daemon.lock")
        } else {
            client_singleton::daemon_lock_path()
        };

        // Ensure parent directory exists
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent).map_err(|source| DaemonLockError::Io {
                operation: "create directory for",
                path: lock_path.clone(),
                source,
            })?;
        }

        // Try to open/create the lock file
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&lock_path)
            .map_err(|source| DaemonLockError::Io {
                operation: "open",
                path: lock_path.clone(),
                source,
            })?;

        // Try to acquire exclusive lock (non-blocking)
        #[cfg(unix)]
        {
            use std::os::unix::io::AsRawFd;
            let fd = lock_file.as_raw_fd();
            let result = unsafe { libc::flock(fd, libc::LOCK_EX | libc::LOCK_NB) };
            if result != 0 {
                let source = std::io::Error::last_os_error();
                return Err(if source.kind() == std::io::ErrorKind::WouldBlock {
                    DaemonLockError::Contended { path: lock_path }
                } else {
                    DaemonLockError::Io {
                        operation: "acquire",
                        path: lock_path,
                        source,
                    }
                });
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
                let source = std::io::Error::last_os_error();
                return Err(
                    if source.raw_os_error()
                        == Some(windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION as i32)
                    {
                        DaemonLockError::Contended { path: lock_path }
                    } else {
                        DaemonLockError::Io {
                            operation: "acquire",
                            path: lock_path,
                            source,
                        }
                    },
                );
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

        let Err(DaemonLockError::Contended { path }) = DaemonLock::try_acquire(Some(&dir)) else {
            return Err("second acquire should have failed".into());
        };
        assert_eq!(path, dir.join("daemon.lock"));
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

    #[test]
    fn directory_failure_preserves_io_error() -> TestResult {
        let tmp = TempDir::new()?;
        let file = tmp.path().join("not-a-directory");
        std::fs::write(&file, "occupied")?;
        let dir = file.join("runtime");
        let Err(DaemonLockError::Io {
            operation,
            path,
            source,
        }) = DaemonLock::try_acquire(Some(&dir))
        else {
            return Err("directory failure must not be reported as contention".into());
        };
        assert_eq!(operation, "create directory for");
        assert_eq!(path, dir.join("daemon.lock"));
        assert!(source.raw_os_error().is_some());
        Ok(())
    }

    #[test]
    fn open_failure_preserves_io_error() -> TestResult {
        let tmp = TempDir::new()?;
        let dir = tmp.path().to_path_buf();
        std::fs::create_dir(dir.join("daemon.lock"))?;
        let Err(DaemonLockError::Io {
            operation,
            path,
            source,
        }) = DaemonLock::try_acquire(Some(&dir))
        else {
            return Err("open failure must not be reported as contention".into());
        };
        assert_eq!(operation, "open");
        assert_eq!(path, dir.join("daemon.lock"));
        assert!(source.raw_os_error().is_some());
        Ok(())
    }

    #[test]
    fn acquire_preserves_existing_lock_file() -> TestResult {
        let tmp = TempDir::new()?;
        let dir = tmp.path().to_path_buf();
        let path = dir.join("daemon.lock");
        std::fs::write(&path, "existing contents")?;
        let _first = DaemonLock::try_acquire(Some(&dir))?;
        assert!(matches!(
            DaemonLock::try_acquire(Some(&dir)),
            Err(DaemonLockError::Contended { .. })
        ));
        assert_eq!(std::fs::read_to_string(path)?, "existing contents");
        Ok(())
    }

    #[test]
    fn independent_directories_can_hold_locks_concurrently() -> TestResult {
        let tmp = TempDir::new()?;
        let first_dir = tmp.path().join("first");
        let second_dir = tmp.path().join("second");
        let _first = DaemonLock::try_acquire(Some(&first_dir))?;
        let _second = DaemonLock::try_acquire(Some(&second_dir))?;
        assert!(matches!(
            DaemonLock::try_acquire(Some(&first_dir)),
            Err(DaemonLockError::Contended { .. })
        ));
        Ok(())
    }

    #[test]
    fn simultaneous_starts_elect_one_owner() -> TestResult {
        let tmp = TempDir::new()?;
        let dir = tmp.path().to_path_buf();
        let barrier = std::sync::Barrier::new(8);
        let results = std::thread::scope(|scope| {
            let attempts: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        barrier.wait();
                        let result = DaemonLock::try_acquire(Some(&dir));
                        // Hold the winner until every other contender has tried.
                        barrier.wait();
                        result.map(|_lock| true).or_else(|error| match error {
                            DaemonLockError::Contended { .. } => Ok(false),
                            error => Err(error),
                        })
                    })
                })
                .collect();
            attempts
                .into_iter()
                .map(|attempt| attempt.join().expect("contender panicked"))
                .collect::<Result<Vec<_>, _>>()
        })?;
        assert_eq!(results.into_iter().filter(|won| *won).count(), 1);
        let _after_race = DaemonLock::try_acquire(Some(&dir))?;
        Ok(())
    }
}
