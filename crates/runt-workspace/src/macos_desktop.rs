//! Resolve Desktop by installation before asking LaunchServices to open it.

use super::{
    desktop_app_launch_candidates_for, desktop_display_name_for, macos_open_args, BuildChannel,
};
use std::path::{Path, PathBuf};
use std::process::Command;

fn enclosing_bundle(executable: &Path) -> Option<&Path> {
    let macos = executable.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle.extension()? == "app")
        .then_some(bundle)
}

fn valid_desktop_bundle(bundle: &Path) -> bool {
    bundle.join("Contents/Info.plist").is_file() && bundle.join("Contents/MacOS/notebook").is_file()
}

fn bundle_for_executable(executable: &Path) -> Result<Option<PathBuf>, String> {
    // Resolve public CLI symlinks, including symlinked installation directories.
    // Preserve a missing bundled path so a damaged selected installation fails
    // rather than silently switching to another copy.
    let resolved = executable
        .canonicalize()
        .unwrap_or_else(|_| executable.to_path_buf());
    // This crate is also embedded in Python hosts, whose own .app is unrelated.
    if !matches!(
        resolved.file_name().and_then(|name| name.to_str()),
        Some("runt" | "runt-nightly" | "nteract-cli" | "nteract-mcp" | "notebook")
    ) {
        return Ok(None);
    }
    let Some(bundle) = enclosing_bundle(&resolved) else {
        return Ok(None);
    };
    if resolved.is_absolute() && resolved.is_file() && valid_desktop_bundle(bundle) {
        Ok(Some(bundle.to_path_buf()))
    } else {
        Err(format!("Desktop is missing or incomplete in selected bundle {}. Reinstall this installation to open notebooks.", bundle.display()))
    }
}

/// The running bundled MCP/CLI owns same-channel launches. Explicit other-channel
/// requests use that channel's registered CLI. Standalone callers then search
/// standard Applications directories in channel/name order; strict runtime joins
/// never fall back from nightly to stable. No display-name LaunchServices lookup
/// is used, and a damaged selected bundle is an error, not a fallback trigger.
pub(super) fn resolve_bundle(
    channel: BuildChannel,
    current_channel: BuildChannel,
    current_exe: Option<&Path>,
    selected_cli: impl FnOnce() -> Option<PathBuf>,
    applications: &[PathBuf],
    strict: bool,
) -> Result<PathBuf, String> {
    if channel == current_channel {
        if let Some(executable) = current_exe {
            if let Some(bundle) = bundle_for_executable(executable)? {
                return Ok(bundle);
            }
        }
    }
    if let Some(executable) = selected_cli() {
        if let Some(bundle) = bundle_for_executable(&executable)? {
            return Ok(bundle);
        }
    }
    for name in desktop_app_launch_candidates_for(channel) {
        if strict && channel == BuildChannel::Nightly && *name == "nteract" {
            continue;
        }
        for directory in applications {
            let bundle = directory.join(format!("{name}.app"));
            if valid_desktop_bundle(&bundle) {
                if let Ok(bundle) = bundle.canonicalize() {
                    return Ok(bundle);
                }
            }
        }
    }
    Err(format!("{} Desktop is not installed in a known location. Install Desktop or run the MCP/CLI from its app bundle.", desktop_display_name_for(channel)))
}

pub(super) fn open_command(
    bundle: &Path,
    path: Option<&Path>,
    extra_args: &[&str],
    open_directory: bool,
) -> Command {
    let mut command = Command::new("open");
    command.arg("-a").arg(bundle);
    command.args(macos_open_args(path, extra_args, open_directory));
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsString;

    fn fixture_bundle(bundle: &Path) -> PathBuf {
        let bin = bundle.join("Contents/MacOS");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bundle.join("Contents/Info.plist"), "fixture").unwrap();
        for name in ["notebook", "runt", "nteract-cli", "nteract-mcp"] {
            std::fs::write(bin.join(name), "fixture").unwrap();
        }
        bundle.canonicalize().unwrap()
    }

    #[test]
    fn selected_bundle_wins_over_duplicate_names_and_cli_registration() {
        let root = tempfile::tempdir().unwrap();
        let applications = root.path().join("Applications");
        let older = fixture_bundle(&applications.join("nteract Nightly.app"));
        let selected = fixture_bundle(&root.path().join("QA candidate/nteract Nightly.app"));
        for name in ["runt", "nteract-cli", "nteract-mcp"] {
            assert_eq!(
                resolve_bundle(
                    BuildChannel::Nightly,
                    BuildChannel::Nightly,
                    Some(&selected.join("Contents/MacOS").join(name)),
                    || panic!("must not resolve a different registered installation"),
                    std::slice::from_ref(&applications),
                    true
                )
                .unwrap(),
                selected
            );
        }
        let command = open_command(&selected, None, &["--attach-notebook-id", "room-id"], false);
        assert_eq!(command.get_program(), "open");
        assert_eq!(
            command.get_args().map(OsString::from).collect::<Vec<_>>(),
            vec![
                OsString::from("-a"),
                selected.into_os_string(),
                OsString::from("-n"),
                OsString::from("--args"),
                OsString::from("--attach-notebook-id"),
                OsString::from("room-id")
            ]
        );
        assert!(older.is_dir());
    }

    #[test]
    fn other_channel_and_standalone_use_selected_cli_bundle() {
        let root = tempfile::tempdir().unwrap();
        let nightly = fixture_bundle(&root.path().join("nteract Nightly.app"));
        let stable = fixture_bundle(&root.path().join("custom installation/nteract.app"));
        let stable_cli = stable.join("Contents/MacOS/nteract-cli");
        assert_eq!(
            resolve_bundle(
                BuildChannel::Stable,
                BuildChannel::Nightly,
                Some(&nightly.join("Contents/MacOS/runt")),
                || Some(stable_cli.clone()),
                &[],
                true
            )
            .unwrap(),
            stable
        );
        assert_eq!(
            resolve_bundle(
                BuildChannel::Stable,
                BuildChannel::Stable,
                Some(&root.path().join("standalone/runt")),
                || Some(stable_cli),
                &[],
                true
            )
            .unwrap(),
            stable
        );
    }

    #[test]
    fn unrelated_bundled_host_uses_nteract_fallback() {
        let root = tempfile::tempdir().unwrap();
        let python = root.path().join("Python.app/Contents/MacOS/Python");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::write(&python, "fixture").unwrap();
        let bundle = fixture_bundle(&root.path().join("nteract.app"));
        assert_eq!(
            resolve_bundle(
                BuildChannel::Stable,
                BuildChannel::Stable,
                Some(&python),
                || None,
                &[root.path().to_path_buf()],
                true
            )
            .unwrap(),
            bundle
        );
    }

    #[test]
    fn broken_selected_bundle_never_switches_to_a_duplicate() {
        let root = tempfile::tempdir().unwrap();
        let applications = root.path().join("Applications");
        fixture_bundle(&applications.join("nteract Nightly.app"));
        let selected = fixture_bundle(&root.path().join("selected/nteract Nightly.app"));
        let executable = selected.join("Contents/MacOS/runt");
        for missing in [
            "Contents/MacOS/notebook",
            "Contents/Info.plist",
            "Contents/MacOS/runt",
        ] {
            fixture_bundle(&selected);
            std::fs::remove_file(selected.join(missing)).unwrap();
            assert!(resolve_bundle(
                BuildChannel::Nightly,
                BuildChannel::Nightly,
                Some(&executable),
                || None,
                std::slice::from_ref(&applications),
                true
            )
            .is_err());
            assert!(resolve_bundle(
                BuildChannel::Nightly,
                BuildChannel::Stable,
                None,
                || Some(executable.clone()),
                std::slice::from_ref(&applications),
                true
            )
            .is_err());
        }
    }

    #[test]
    fn standalone_fallback_is_validated_and_channel_ordered() {
        let root = tempfile::tempdir().unwrap();
        let system = root.path().join("Applications");
        let user = root.path().join("home/Applications");
        let stable = fixture_bundle(&system.join("nteract.app"));
        // An empty bundle directory is not a Desktop installation.
        std::fs::create_dir_all(system.join("nteract Nightly.app")).unwrap();
        let roots = [system, user.clone()];
        assert!(resolve_bundle(
            BuildChannel::Nightly,
            BuildChannel::Nightly,
            None,
            || None,
            &roots,
            true
        )
        .is_err());
        assert_eq!(
            resolve_bundle(
                BuildChannel::Nightly,
                BuildChannel::Nightly,
                None,
                || None,
                &roots,
                false
            )
            .unwrap(),
            stable
        );
        let nightly = fixture_bundle(&user.join("nteract (Nightly).app"));
        assert_eq!(
            resolve_bundle(
                BuildChannel::Nightly,
                BuildChannel::Nightly,
                None,
                || None,
                &roots,
                true
            )
            .unwrap(),
            nightly
        );
        assert_eq!(
            resolve_bundle(
                BuildChannel::Stable,
                BuildChannel::Stable,
                None,
                || None,
                &roots,
                true
            )
            .unwrap(),
            stable
        );
        assert!(resolve_bundle(
            BuildChannel::Stable,
            BuildChannel::Stable,
            None,
            || None,
            &[user],
            false
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn public_cli_symlink_retains_bundle_and_document_arguments() {
        let root = tempfile::tempdir().unwrap();
        let bundle = fixture_bundle(&root.path().join("custom path/nteract.app"));
        let link = root.path().join("nteract");
        std::os::unix::fs::symlink(bundle.join("Contents/MacOS/nteract-cli"), &link).unwrap();
        let selected = resolve_bundle(
            BuildChannel::Stable,
            BuildChannel::Stable,
            Some(&link),
            || None,
            &[],
            true,
        )
        .unwrap();
        let document = root.path().join("notebook with spaces.ipynb");
        let command = open_command(&selected, Some(&document), &[], false);
        assert_eq!(
            command.get_args().map(OsString::from).collect::<Vec<_>>(),
            vec![
                OsString::from("-a"),
                bundle.into_os_string(),
                document.into_os_string()
            ]
        );
    }
}
