//! Public CLI installation and explicit release-channel routing.
//!
//! The physical `nteract-cli` sidecar is separate from the Desktop executable.
//! Installers expose it as `nteract`. Installing another channel registers its
//! target but does not replace the user's selected command.

use crate::BuildChannel;
use std::path::{Path, PathBuf};

pub const BINARY_NAME: &str = "nteract-cli";
pub const SELECTION_FILE: &str = ".nteract-cli-target";

pub fn channel_name(channel: BuildChannel) -> &'static str {
    match channel {
        BuildChannel::Stable => "stable",
        BuildChannel::Nightly => "nightly",
    }
}

pub fn channel_record_name(channel: BuildChannel) -> String {
    format!(".nteract-cli-{}-target", channel_name(channel))
}

fn read_target(path: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(path).ok()?;
    let path = PathBuf::from(text.trim_end_matches(['\r', '\n']));
    path.is_absolute().then_some(path)
}

/// Resolve only the requested installation. There is deliberately no fallback
/// from Nightly to Stable: that would change credentials and notebook context.
pub fn resolve_channel(channel: BuildChannel) -> Result<PathBuf, String> {
    let mut bin_dirs = Vec::new();
    if let Some(argv0) = std::env::args_os().next().map(PathBuf::from) {
        if argv0.is_absolute() {
            if let Some(parent) = argv0.parent() {
                bin_dirs.push(parent.to_path_buf());
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        bin_dirs.extend(std::env::split_paths(&path));
    }
    if let Some(home) = dirs::home_dir() {
        bin_dirs.push(home.join(".local/bin"));
    }
    for dir in bin_dirs {
        if let Some(target) = read_target(&dir.join(channel_record_name(channel))) {
            if target.is_file() {
                return Ok(target);
            }
        }
    }

    let filename = format!("{BINARY_NAME}{}", std::env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|home| home.join(".local/share")));
    let prefix = data_home.map(|dir| dir.join("nteract").join(channel_name(channel)));
    if let Some(prefix) = &prefix {
        candidates.push(prefix.join("bin").join(&filename));
    }
    #[cfg(target_os = "macos")]
    {
        let app_name = match channel {
            BuildChannel::Stable => "nteract.app",
            BuildChannel::Nightly => "nteract Nightly.app",
        };
        let mut applications = vec![PathBuf::from("/Applications")];
        if let Some(home) = dirs::home_dir() {
            applications.push(home.join("Applications"));
            // Headless macOS installs retain the signed bundle in their prefix.
        }
        if let Some(prefix) = prefix {
            candidates.push(prefix.join(app_name).join("Contents/MacOS").join(&filename));
        }
        candidates.extend(
            applications
                .into_iter()
                .map(|dir| dir.join(app_name).join("Contents/MacOS").join(&filename)),
        );
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| format!(
        "The {} nteract CLI is not installed. Install that channel, or omit --channel to use this installation.", channel_name(channel)
    ))
}

#[derive(Debug, PartialEq, Eq)]
pub enum InstallOutcome {
    Selected,
    KeptSelection(PathBuf),
    CommandConflict(PathBuf),
}

#[cfg(unix)]
fn write_target(path: &Path, target: &Path) -> Result<(), String> {
    let temporary = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&temporary, format!("{}\n", target.display())).map_err(|e| e.to_string())?;
    std::fs::rename(&temporary, path).map_err(|e| e.to_string())
}

/// Register this installation and install a Unix command without taking over
/// an unrelated command or another selected release channel.
#[cfg(unix)]
pub fn install_command(
    bin_dir: &Path,
    target: &Path,
    channel: BuildChannel,
    select: bool,
    legacy_targets: &[PathBuf],
) -> Result<InstallOutcome, String> {
    use std::os::unix::fs::symlink;
    if !target.is_absolute() || !target.is_file() {
        return Err(format!(
            "CLI binary is not available at {}",
            target.display()
        ));
    }
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let command = bin_dir.join("nteract");
    let selected = read_target(&bin_dir.join(SELECTION_FILE));
    let previous_channel = read_target(&bin_dir.join(channel_record_name(channel)));
    let existing = std::fs::symlink_metadata(&command).ok();
    let linked = std::fs::read_link(&command).ok();
    let managed = linked.as_ref().is_some_and(|path| {
        selected.as_ref() == Some(path) || path == target || legacy_targets.contains(path)
    });
    // The per-channel record supports explicit selection even when the public
    // command is owned by another installation or an unrelated program.
    write_target(&bin_dir.join(channel_record_name(channel)), target)?;
    if existing.is_some() && !managed {
        return Ok(InstallOutcome::CommandConflict(command));
    }
    if !select && managed {
        if let Some(ref old) = linked {
            let same_channel = old == target
                || previous_channel.as_ref() == Some(old)
                || legacy_targets.contains(old);
            if !same_channel {
                return Ok(InstallOutcome::KeptSelection(old.clone()));
            }
        }
    }
    if existing.is_some() {
        std::fs::remove_file(&command).map_err(|e| e.to_string())?;
    }
    symlink(target, &command).map_err(|e| e.to_string())?;
    write_target(&bin_dir.join(SELECTION_FILE), target)?;
    Ok(InstallOutcome::Selected)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn installing_other_channel_preserves_selection_until_explicitly_selected() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path().join("bin");
        let stable = dir.path().join("stable-cli");
        let nightly = dir.path().join("nightly-cli");
        std::fs::write(&stable, "fixture").unwrap();
        std::fs::write(&nightly, "fixture").unwrap();
        assert_eq!(
            install_command(&bin, &stable, BuildChannel::Stable, false, &[]).unwrap(),
            InstallOutcome::Selected
        );
        assert_eq!(
            install_command(&bin, &nightly, BuildChannel::Nightly, false, &[]).unwrap(),
            InstallOutcome::KeptSelection(stable.clone())
        );
        assert_eq!(std::fs::read_link(bin.join("nteract")).unwrap(), stable);
        assert_eq!(
            install_command(&bin, &nightly, BuildChannel::Nightly, true, &[]).unwrap(),
            InstallOutcome::Selected
        );
        assert_eq!(std::fs::read_link(bin.join("nteract")).unwrap(), nightly);
    }

    #[test]
    fn never_replaces_unrelated_command_even_with_explicit_selection() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("nteract-cli");
        std::fs::write(&target, "fixture").unwrap();
        std::fs::write(dir.path().join("nteract"), "user command").unwrap();
        assert!(matches!(
            install_command(dir.path(), &target, BuildChannel::Stable, true, &[]).unwrap(),
            InstallOutcome::CommandConflict(_)
        ));
        assert_eq!(
            std::fs::read_to_string(dir.path().join("nteract")).unwrap(),
            "user command"
        );
    }

    #[test]
    fn selected_channel_upgrade_can_move_its_binary() {
        let dir = tempfile::tempdir().unwrap();
        let old = dir.path().join("old");
        let new = dir.path().join("new");
        std::fs::write(&old, "fixture").unwrap();
        std::fs::write(&new, "fixture").unwrap();
        install_command(dir.path(), &old, BuildChannel::Stable, false, &[]).unwrap();
        install_command(dir.path(), &new, BuildChannel::Stable, false, &[]).unwrap();
        assert_eq!(std::fs::read_link(dir.path().join("nteract")).unwrap(), new);
    }
}
