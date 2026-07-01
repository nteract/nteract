//! Daemon discovery through the daemon socket.
//!
//! The daemon singleton lock lives in the `runtimed` crate since only the
//! daemon process acquires it.

use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Information about a running daemon instance.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DaemonInfo {
    /// Socket endpoint the daemon is listening on.
    pub endpoint: String,
    /// Process ID of the daemon.
    pub pid: u32,
    /// Version of the daemon.
    pub version: String,
    /// When the daemon started.
    pub started_at: DateTime<Utc>,
    /// HTTP port for the blob server (if running).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blob_port: Option<u16>,
    /// Directory for durable execution result records.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution_store_dir: Option<String>,
    /// Path to the git worktree (dev mode only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    /// Human-readable workspace description (dev mode only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_description: Option<String>,
}

/// Get the path to the daemon lock file.
pub fn daemon_lock_path() -> PathBuf {
    crate::daemon_base_dir().join("daemon.lock")
}

/// Get daemon info from the socket-based `GetDaemonInfo` request.
///
/// The socket is the source of truth: the daemon fills the response from live
/// state, so clients cannot consume stale sidecar metadata after a crash or
/// force-kill. `socket_path` pins which daemon is being queried so tests,
/// worktree isolation, and cross-channel lookups resolve the intended daemon.
pub async fn query_daemon_info(socket_path: std::path::PathBuf) -> Option<DaemonInfo> {
    let client = crate::client::PoolClient::new(socket_path.clone());
    if let Ok(info) = client.daemon_info().await {
        return Some(DaemonInfo {
            endpoint: socket_path.to_string_lossy().into_owned(),
            pid: info.pid,
            version: info.daemon_version,
            started_at: info.started_at,
            blob_port: info.blob_port,
            execution_store_dir: info.execution_store_dir,
            worktree_path: info.worktree_path,
            workspace_description: info.workspace_description,
        });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daemon_paths() {
        let lock_path = daemon_lock_path();

        assert!(lock_path.to_string_lossy().contains("runt"));
        assert!(lock_path.to_string_lossy().contains("daemon.lock"));
    }
}
