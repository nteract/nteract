//! Platform connection helpers shared by runtimed clients.

#[cfg(windows)]
use std::io;
#[cfg(windows)]
use std::path::Path;
#[cfg(windows)]
use std::time::{Duration, Instant};

#[cfg(windows)]
use tokio::net::windows::named_pipe::{ClientOptions, NamedPipeClient};

/// Windows ERROR_PIPE_BUSY.
///
/// Named-pipe clients can observe this while the daemon is accepting other
/// connections. Treat it as transient the same way a not-yet-created pipe is
/// transient during daemon startup.
#[cfg(windows)]
pub const ERROR_PIPE_BUSY: i32 = 231;

#[cfg(windows)]
pub fn is_retryable_named_pipe_connect_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(ERROR_PIPE_BUSY)
}

#[cfg(windows)]
pub async fn connect_named_pipe_client(
    socket_path: &Path,
    timeout: Duration,
) -> io::Result<NamedPipeClient> {
    let pipe_name = socket_path.to_string_lossy().to_string();
    let deadline = Instant::now() + timeout;

    loop {
        match ClientOptions::new().open(&pipe_name) {
            Ok(client) => return Ok(client),
            Err(error) if is_retryable_named_pipe_connect_error(&error) => {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err(error);
                }
                tokio::time::sleep(remaining.min(Duration::from_millis(50))).await;
            }
            Err(error) => return Err(error),
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn retryable_named_pipe_connect_error_includes_pipe_busy() {
        let error = io::Error::from_raw_os_error(ERROR_PIPE_BUSY);
        assert!(is_retryable_named_pipe_connect_error(&error));
    }

    #[test]
    fn retryable_named_pipe_connect_error_includes_not_found() {
        let error = io::Error::new(io::ErrorKind::NotFound, "missing pipe");
        assert!(is_retryable_named_pipe_connect_error(&error));
    }

    #[test]
    fn retryable_named_pipe_connect_error_excludes_permission_denied() {
        let error = io::Error::new(io::ErrorKind::PermissionDenied, "denied");
        assert!(!is_retryable_named_pipe_connect_error(&error));
    }
}
