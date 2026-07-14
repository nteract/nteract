//! Centralized path helpers for the `runtimed` crate — socket, cache, env, and
//! notebook-doc paths live here so callers have one module to look at instead
//! of a scatter across `daemon.rs` and `notebook_sync_server.rs`.
//!
//! Most entries are re-exports of helpers that live in upstream crates
//! (`runt-workspace`, `runtimed-client`, `notebook-doc`) — the point is
//! discoverability, not duplication. Genuinely local helpers
//! (e.g. [`normalize_save_target`]) live here in
//! full.
//!
//! Keep this module behaviour-preserving. New path logic is fine; silently
//! drifting from the upstream helpers is not.

use std::path::{Path, PathBuf};

// ---------------------------------------------------------------------------
// Re-exports from upstream crates — single entry point for runtimed callers.
// ---------------------------------------------------------------------------

/// Default daemon socket path (honours `RUNTIMED_SOCKET_PATH`).
///
/// Re-exported from `runt_workspace`.
pub use runt_workspace::default_socket_path;

/// Default cache directory for environments (`<daemon_base_dir>/envs`).
///
/// Re-exported from `runtimed_client` (originally defined there because
/// `runtimed-client` owns daemon-path conventions shared with the CLI and
/// Python bindings).
pub use runtimed_client::default_cache_dir;

/// Walk up from a pool env's `venv_path` to the top-level
/// `runtimed-{uv,conda,pixi}-*` directory.
///
/// Re-exported from `runtimed_client`.
pub use runtimed_client::pool_env_root;

/// Deterministic filename for a notebook's persisted Automerge doc.
///
/// Re-exported from `notebook_doc` (behind the `persistence` feature).
pub use notebook_doc::notebook_doc_filename;

// ---------------------------------------------------------------------------
// Local helpers — moved from daemon.rs / notebook_sync_server.rs.
// ---------------------------------------------------------------------------

/// Normalize a user-supplied save target: append `.ipynb` if missing, reject
/// relative paths, and return the path that `save_notebook_to_disk` will use.
pub(crate) fn normalize_save_target(target: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(target);
    if path.is_relative() {
        return Err(format!(
            "Relative paths are not supported for save: '{}'. Please provide an absolute path.",
            target
        ));
    }
    Ok(if target.ends_with(".ipynb") {
        path
    } else {
        PathBuf::from(format!("{}.ipynb", target))
    })
}

/// Returns true if `path` looks like a bare UUID with no extension and no
/// parent components — the shape daemon-side code produces for untitled
/// notebooks. Used as a guard before treating a path string as a real file.
pub(crate) fn looks_like_untitled_notebook_path(path: &str) -> bool {
    let candidate = Path::new(path);
    candidate.components().count() == 1
        && candidate.extension().is_none()
        && uuid::Uuid::parse_str(path).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_uuid_looks_untitled() {
        assert!(looks_like_untitled_notebook_path(
            "550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(!looks_like_untitled_notebook_path(
            "/tmp/550e8400-e29b-41d4-a716-446655440000"
        ));
        assert!(!looks_like_untitled_notebook_path(
            "550e8400-e29b-41d4-a716-446655440000.ipynb"
        ));
    }

    #[test]
    fn normalize_save_target_appends_extension() {
        let path = std::env::temp_dir().join("foo");
        let target = path.to_string_lossy();

        let result = normalize_save_target(&target).unwrap();

        assert_eq!(result, PathBuf::from(format!("{target}.ipynb")));
    }

    #[test]
    fn normalize_save_target_preserves_extension() {
        let path = std::env::temp_dir().join("foo.ipynb");
        let target = path.to_string_lossy();

        let result = normalize_save_target(&target).unwrap();

        assert_eq!(result, path);
    }

    #[test]
    fn normalize_save_target_rejects_relative() {
        assert!(normalize_save_target("foo.ipynb").is_err());
    }
}
