//! The one place rattler `Installer`s are constructed.
//!
//! Conda and Pixi envs hardlink files from the rattler package cache, the same
//! way runtimed runs uv with `--link-mode hardlink`. Reflinks are disabled:
//! rattler prefers them when the filesystem supports them, and on APFS a reflink
//! is a new inode. macOS XProtect scans each new inode on first load and caches
//! the verdict per inode, so a reflinked env rescans every native library the
//! first time it is imported. A hardlinked env shares inodes with the cache and
//! reuses verdicts already earned by any earlier env.
//!
//! Consequence: editing a file inside an env edits the cache copy, and every
//! other env linked to it. That matches uv's hardlink mode.
//!
//! Hardlinks and symlinks stay on rattler's auto-detection. When the env and the
//! cache are on different filesystems, rattler's probe fails and it copies, and
//! a per-file hardlink error also falls back to a copy
//! (`rattler::install::link::hardlink_to_destination`). Files with an embedded
//! prefix placeholder are always rewritten as copies.
//!
//! Every `Installer` must come from [`rattler_installer`]. A source-scanning test
//! below fails if `Installer::new()` appears anywhere else in `crates/`.

use rattler::install::{Installer, LinkOptions};

/// Link options for every rattler install: hardlink when possible, never reflink.
pub fn rattler_link_options() -> LinkOptions {
    LinkOptions {
        allow_ref_links: Some(false),
        ..LinkOptions::default()
    }
}

/// A rattler `Installer` configured with [`rattler_link_options`].
pub fn rattler_installer() -> Installer {
    Installer::new().with_link_options(rattler_link_options())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::{Path, PathBuf};

    #[test]
    fn link_options_disable_reflinks_and_keep_hardlink_autodetect() {
        let options = rattler_link_options();
        assert_eq!(options.allow_ref_links, Some(false));
        // `None` lets rattler probe hardlink/symlink support and fall back to copy.
        assert_eq!(options.allow_hard_links, None);
        assert_eq!(options.allow_symbolic_links, None);
    }

    fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                if path.file_name().is_some_and(|n| n == "target") {
                    continue;
                }
                collect_rs_files(&path, out);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                out.push(path);
            }
        }
    }

    #[test]
    fn every_rattler_installer_goes_through_the_helper() {
        let crates_dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("crates dir");
        let mut files = Vec::new();
        collect_rs_files(crates_dir, &mut files);
        assert!(
            files.iter().any(|p| p.ends_with("kernel-env/src/conda.rs")),
            "scan did not reach kernel-env sources under {}",
            crates_dir.display()
        );

        let needle = ["Installer", "::new()"].concat();
        let mut violations = Vec::new();
        for path in files {
            if path.ends_with("kernel-env/src/rattler_install.rs") {
                continue;
            }
            let Ok(source) = std::fs::read_to_string(&path) else {
                continue;
            };
            for (idx, line) in source.lines().enumerate() {
                if line.contains(&needle) {
                    violations.push(format!("{}:{}", path.display(), idx + 1));
                }
            }
        }
        assert!(
            violations.is_empty(),
            "construct rattler installers with kernel_env::rattler_install::rattler_installer() \
             so they hardlink instead of reflink:\n{}",
            violations.join("\n")
        );
    }
}
