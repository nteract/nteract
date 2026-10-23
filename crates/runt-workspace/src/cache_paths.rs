//! Rebuildable application caches, separate from daemon state and coordination.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use crate::{cache_namespace_for, config_namespace_for, worktree_hash, BuildChannel};

/// Resolve a managed environment/tool cache under the nteract channel namespace.
///
/// Existing legacy cache entries win at first resolution, even when the new
/// location also exists. The selection stays fixed for this process/context.
/// Environments can embed absolute paths, so this does not move, copy, merge or
/// delete them. It also avoids provisioning a second copy during an upgrade.
/// A legacy entry that cannot be inspected is retained rather than silently
/// bypassing a filesystem error with a fresh cache. Development worktrees keep
/// their legacy layout so state and cache cleanup continue to share one root.
///
/// Only use this for rebuildable application caches (`envs`, `conda-envs`,
/// `pixi-envs`, `inline-envs`, `tools`). Daemon state, sockets, singleton locks
/// and shared file claims keep their existing paths so old and new clients
/// share the same ownership boundaries. Package-manager caches are owned upstream.
pub fn managed_cache_dir(name: &str) -> PathBuf {
    let cache_root = dirs::cache_dir().unwrap_or_else(|| PathBuf::from("/tmp"));
    let worktree = crate::is_dev_mode()
        .then(crate::get_workspace_path)
        .flatten();
    static PATHS: OnceLock<Mutex<CachePaths>> = OnceLock::new();
    PATHS
        .get_or_init(|| Mutex::new(CachePaths::default()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .resolve(
            &cache_root,
            crate::build_channel(),
            worktree.as_deref(),
            name,
        )
}

#[derive(Default)]
struct CachePaths {
    // The full preferred path keys both the channel and cache name. Dev paths
    // are handled separately, without consulting or mutating the filesystem.
    selected: HashMap<PathBuf, PathBuf>,
}

impl CachePaths {
    fn resolve(
        &mut self,
        cache_root: &Path,
        channel: BuildChannel,
        worktree: Option<&Path>,
        name: &str,
    ) -> PathBuf {
        let legacy_root = cache_root.join(cache_namespace_for(channel));
        if let Some(worktree) = worktree {
            return legacy_root
                .join("worktrees")
                .join(worktree_hash(worktree))
                .join(name);
        }
        let legacy = legacy_root.join(name);
        let preferred = cache_root.join(config_namespace_for(channel)).join(name);
        self.selected
            .entry(preferred.clone())
            .or_insert_with(|| match std::fs::symlink_metadata(&legacy) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => preferred,
                _ => legacy,
            })
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn new_caches_use_nteract_without_creating_directories() {
        let temp = tempfile::tempdir().unwrap();
        for (channel, namespace) in [
            (BuildChannel::Stable, "nteract"),
            (BuildChannel::Nightly, "nteract-nightly"),
        ] {
            for name in ["envs", "conda-envs", "pixi-envs", "inline-envs", "tools"] {
                assert_eq!(
                    CachePaths::default().resolve(temp.path(), channel, None, name),
                    temp.path().join(namespace).join(name)
                );
            }
        }
        assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 0);
    }

    #[test]
    fn existing_cache_is_reused_without_moving_embedded_paths() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["envs", "conda-envs", "pixi-envs", "inline-envs", "tools"] {
            let legacy = temp.path().join("runt-nightly").join(name);
            fs::create_dir_all(&legacy).unwrap();
            let embedded_path = legacy.join("python");
            fs::write(
                legacy.join("prefix"),
                embedded_path.to_string_lossy().as_bytes(),
            )
            .unwrap();
            assert_eq!(
                CachePaths::default().resolve(temp.path(), BuildChannel::Nightly, None, name),
                legacy
            );
            assert_eq!(
                fs::read_to_string(legacy.join("prefix")).unwrap(),
                embedded_path.to_string_lossy()
            );
        }
        assert!(!temp.path().join("nteract-nightly").exists());
    }

    #[test]
    fn legacy_wins_when_both_paths_exist_without_merging_or_deleting() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("runt/envs");
        let new = temp.path().join("nteract/envs");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("existing"), b"old").unwrap();
        fs::write(new.join("existing"), b"new").unwrap();
        assert_eq!(
            CachePaths::default().resolve(temp.path(), BuildChannel::Stable, None, "envs"),
            old
        );
        assert_eq!(fs::read(old.join("existing")).unwrap(), b"old");
        assert_eq!(fs::read(new.join("existing")).unwrap(), b"new");
    }

    #[test]
    fn existing_daemon_state_does_not_change_or_redirect_new_caches() {
        let temp = tempfile::tempdir().unwrap();
        let state = temp.path().join("runt-nightly");
        fs::create_dir_all(&state).unwrap();
        for name in ["daemon.lock", "notebook-docs", "executions", "blobs"] {
            fs::write(state.join(name), name).unwrap();
        }
        assert_eq!(
            CachePaths::default().resolve(temp.path(), BuildChannel::Nightly, None, "envs"),
            temp.path().join("nteract-nightly/envs")
        );
        for name in ["daemon.lock", "notebook-docs", "executions", "blobs"] {
            assert_eq!(fs::read_to_string(state.join(name)).unwrap(), name);
        }
    }

    #[test]
    fn dev_worktree_uses_legacy_worktree_layout() {
        let temp = tempfile::tempdir().unwrap();
        let workspace = temp.path().join("workspace");
        let hash = worktree_hash(&workspace);
        for (channel, namespace) in [
            (BuildChannel::Stable, "runt"),
            (BuildChannel::Nightly, "runt-nightly"),
        ] {
            let production = temp.path().join(namespace).join("envs");
            fs::create_dir_all(&production).unwrap();
            let path =
                CachePaths::default().resolve(temp.path(), channel, Some(&workspace), "envs");
            assert_eq!(
                path,
                temp.path()
                    .join(namespace)
                    .join("worktrees")
                    .join(&hash)
                    .join("envs")
            );
            assert_ne!(path, production);
            assert_ne!(
                path,
                temp.path().join(config_namespace_for(channel)).join("envs")
            );
            assert!(!path.exists());
            assert!(!temp.path().join(config_namespace_for(channel)).exists());
        }
    }

    #[test]
    fn selection_is_stable_when_legacy_cache_appears_later() {
        let temp = tempfile::tempdir().unwrap();
        let mut paths = CachePaths::default();
        let first = paths.resolve(temp.path(), BuildChannel::Nightly, None, "envs");
        assert_eq!(first, temp.path().join("nteract-nightly/envs"));
        fs::create_dir_all(temp.path().join("runt-nightly/envs")).unwrap();
        assert_eq!(
            paths.resolve(temp.path(), BuildChannel::Nightly, None, "envs"),
            first
        );
        // Another cache kind and another process still resolve their own paths.
        fs::create_dir_all(temp.path().join("runt-nightly/conda-envs")).unwrap();
        assert_eq!(
            paths.resolve(temp.path(), BuildChannel::Nightly, None, "conda-envs"),
            temp.path().join("runt-nightly/conda-envs")
        );
        assert_eq!(
            CachePaths::default().resolve(temp.path(), BuildChannel::Nightly, None, "envs"),
            temp.path().join("runt-nightly/envs")
        );
    }

    #[test]
    fn selected_legacy_cache_does_not_change_after_external_removal() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("runt/envs");
        fs::create_dir_all(&legacy).unwrap();
        let mut paths = CachePaths::default();
        assert_eq!(
            paths.resolve(temp.path(), BuildChannel::Stable, None, "envs"),
            legacy
        );
        fs::remove_dir(&legacy).unwrap();
        assert_eq!(
            paths.resolve(temp.path(), BuildChannel::Stable, None, "envs"),
            legacy
        );
        assert!(!temp.path().join("nteract").exists());
    }

    #[test]
    fn invalid_legacy_entry_is_not_silently_replaced() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("runt/envs");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::write(&legacy, b"not a directory").unwrap();
        assert_eq!(
            CachePaths::default().resolve(temp.path(), BuildChannel::Stable, None, "envs"),
            legacy
        );
        assert!(!temp.path().join("nteract").exists());
    }

    #[cfg(windows)]
    fn assert_junction_entry(path: &Path) {
        use std::os::windows::fs::MetadataExt;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        let metadata = fs::symlink_metadata(path).expect("junction entry must remain inspectable");
        assert_ne!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
    }

    #[cfg(windows)]
    fn create_junction(link: &Path, target: &Path) {
        // Junctions do not need symbolic-link privileges or Developer Mode.
        // Pass fixture paths through the child environment, not shell source.
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$ErrorActionPreference = 'Stop'; New-Item -ItemType Junction \
                 -Path $env:NTERACT_TEST_JUNCTION -Target $env:NTERACT_TEST_TARGET | Out-Null",
            ])
            .env("NTERACT_TEST_JUNCTION", link)
            .env("NTERACT_TEST_TARGET", target)
            .output()
            .expect("PowerShell must be available to create the junction fixture");
        assert!(
            output.status.success(),
            "junction fixture creation failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_junction_entry(link);
        assert_eq!(
            fs::canonicalize(link).unwrap(),
            fs::canonicalize(target).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn legacy_junction_is_reused_without_changing_either_tree() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("junction target");
        let legacy = temp.path().join("runt/envs");
        let preferred = temp.path().join("nteract/envs");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        fs::create_dir_all(&preferred).unwrap();
        fs::write(target.join("existing"), b"legacy target").unwrap();
        fs::write(preferred.join("existing"), b"preferred").unwrap();
        create_junction(&legacy, &target);

        assert_eq!(
            CachePaths::default().resolve(temp.path(), BuildChannel::Stable, None, "envs"),
            legacy
        );
        assert_junction_entry(&legacy);
        assert_eq!(fs::read(target.join("existing")).unwrap(), b"legacy target");
        assert_eq!(fs::read(legacy.join("existing")).unwrap(), b"legacy target");
        assert_eq!(fs::read(preferred.join("existing")).unwrap(), b"preferred");
    }

    #[cfg(windows)]
    #[test]
    fn dangling_legacy_junction_is_not_bypassed() {
        let temp = tempfile::tempdir().unwrap();
        let target = temp.path().join("removed target");
        let legacy = temp.path().join("runt-nightly/envs");
        fs::create_dir_all(&target).unwrap();
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        create_junction(&legacy, &target);
        fs::remove_dir(&target).unwrap();
        assert!(fs::metadata(&legacy).is_err());
        assert_junction_entry(&legacy);

        assert_eq!(
            CachePaths::default().resolve(temp.path(), BuildChannel::Nightly, None, "envs"),
            legacy
        );
        assert_junction_entry(&legacy);
        assert!(!temp.path().join("nteract-nightly").exists());
    }

    #[cfg(unix)]
    #[test]
    fn broken_legacy_symlink_is_not_bypassed() {
        let temp = tempfile::tempdir().unwrap();
        let legacy = temp.path().join("runt/envs");
        fs::create_dir_all(legacy.parent().unwrap()).unwrap();
        std::os::unix::fs::symlink(temp.path().join("missing"), &legacy).unwrap();
        assert_eq!(
            CachePaths::default().resolve(temp.path(), BuildChannel::Stable, None, "envs"),
            legacy
        );
        assert!(!temp.path().join("nteract").exists());
    }
}
