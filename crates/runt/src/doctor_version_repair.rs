//! Version repair for `daemon doctor --fix`.
//!
//! Three versions decide the repair: the binary the service definition points
//! at (`installed`), the daemon answering on the socket (`running`), and the
//! binary shipped beside this CLI in the app (`bundled`). The bundled binary is
//! the target when it exists; otherwise the installed binary is.
//!
//! An installer that replaces the app in place changes `installed` and
//! `bundled` together, so the two still match while the old daemon keeps
//! serving. Doctor therefore compares the running daemon with the target as
//! well as the installed binary with the bundled one.
//!
//! A restart goes through `<target> install`, the transactional service repair
//! in `runtimed::service_repair`. It asks the daemon for a clean shutdown,
//! keeps recovery state, refuses to kill a daemon that stays responsive, and
//! verifies the replacement's version before it exits zero. Doctor never stops
//! a live daemon itself on this path.
//!
//! A clean shutdown still ends every kernel. Doctor lists rooms first: with no
//! running kernels it restarts; with running kernels it asks on an interactive
//! terminal and refuses otherwise. `--no-start` never restarts. Dev mode never
//! restarts either: the socket belongs to the worktree daemon, while the
//! service definition belongs to the installed app.

use runtimed_client::versions_match_ignoring_dirty;

/// Versions read by doctor before it repairs anything.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct VersionInputs<'a> {
    pub installed: Option<&'a str>,
    /// Only set when the daemon's PID is confirmed alive.
    pub running: Option<&'a str>,
    /// Only set when the bundled binary exists and reported a version.
    pub bundled: Option<&'a str>,
}

/// Binary that `<binary> install` runs from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RepairSource {
    Bundled,
    Installed,
}

/// What `--fix` does about versions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VersionRepair {
    /// Versions agree, or too little is known to act.
    None,
    /// `--no-start`: write the bundled binary into the service definition and
    /// leave the daemon down until the service manager starts it.
    StageBundled,
    /// Run the transactional repair from `source`.
    Restart { source: RepairSource },
    /// The running daemon is stale, but `--no-start` forbids a restart.
    HeldByNoStart,
    /// The running daemon or installed binary is stale, but dev mode keeps
    /// doctor away from the worktree daemon and the installed service.
    HeldByDevMode,
}

pub(crate) fn decide_version_repair(
    versions: VersionInputs<'_>,
    no_start: bool,
    dev_mode: bool,
) -> VersionRepair {
    let differs = |a: &str, b: &str| !versions_match_ignoring_dirty(a, b);

    let (target, source) = match (versions.bundled, versions.installed) {
        (Some(bundled), _) => (bundled, RepairSource::Bundled),
        (None, Some(installed)) => (installed, RepairSource::Installed),
        (None, None) => return VersionRepair::None,
    };
    let binary_stale = versions
        .installed
        .zip(versions.bundled)
        .is_some_and(|(installed, bundled)| differs(installed, bundled));
    let running_stale = versions
        .running
        .is_some_and(|running| differs(running, target));

    if !binary_stale && !running_stale {
        return VersionRepair::None;
    }
    if dev_mode {
        return VersionRepair::HeldByDevMode;
    }
    if no_start {
        return if binary_stale {
            VersionRepair::StageBundled
        } else {
            VersionRepair::HeldByNoStart
        };
    }
    VersionRepair::Restart { source }
}

/// Whether a restart may proceed given the kernels the daemon reports.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestartGate {
    Proceed,
    /// Ask the person at the terminal before ending this many kernels.
    Ask {
        running_kernels: usize,
    },
    Refuse {
        reason: String,
    },
}

/// `running_kernels` is `Err` when the room list could not be read. A daemon
/// that is not running has no kernels to protect; pass `Ok(0)`.
pub(crate) fn restart_gate(
    running_kernels: Result<usize, String>,
    interactive: bool,
    command_name: &str,
) -> RestartGate {
    match running_kernels {
        Ok(0) => RestartGate::Proceed,
        Ok(count) if interactive => RestartGate::Ask {
            running_kernels: count,
        },
        Ok(count) => RestartGate::Refuse {
            reason: format!(
                "{count} kernel(s) are running. Restarting the daemon would stop them. \
                 Close those notebooks or restart the app, then rerun '{command_name} daemon doctor --fix'."
            ),
        },
        Err(error) => RestartGate::Refuse {
            reason: format!(
                "could not list open notebooks before restarting the daemon ({error}). \
                 Restart the app, or rerun '{command_name} daemon doctor --fix'."
            ),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "2.10.0+aaaaaaa";
    const NEW: &str = "2.10.1+bbbbbbb";

    fn inputs<'a>(
        installed: Option<&'a str>,
        running: Option<&'a str>,
        bundled: Option<&'a str>,
    ) -> VersionInputs<'a> {
        VersionInputs {
            installed,
            running,
            bundled,
        }
    }

    fn decide(versions: VersionInputs<'_>) -> VersionRepair {
        decide_version_repair(versions, false, false)
    }

    #[test]
    fn all_versions_agree() {
        assert_eq!(
            decide(inputs(Some(NEW), Some(NEW), Some(NEW))),
            VersionRepair::None
        );
    }

    #[test]
    fn in_place_app_replacement_restarts_from_bundle() {
        // The installer swapped the app: installed and bundled read the new
        // file, and the old daemon still serves.
        assert_eq!(
            decide(inputs(Some(NEW), Some(OLD), Some(NEW))),
            VersionRepair::Restart {
                source: RepairSource::Bundled
            }
        );
    }

    #[test]
    fn running_stale_without_bundle_restarts_from_installed() {
        assert_eq!(
            decide(inputs(Some(NEW), Some(OLD), None)),
            VersionRepair::Restart {
                source: RepairSource::Installed
            }
        );
    }

    #[test]
    fn installed_stale_restarts_from_bundle() {
        assert_eq!(
            decide(inputs(Some(OLD), Some(OLD), Some(NEW))),
            VersionRepair::Restart {
                source: RepairSource::Bundled
            }
        );
        // Daemon down: the repair installs and starts the bundled binary.
        assert_eq!(
            decide(inputs(Some(OLD), None, Some(NEW))),
            VersionRepair::Restart {
                source: RepairSource::Bundled
            }
        );
    }

    #[test]
    fn running_daemon_matching_bundle_still_repairs_stale_installed_binary() {
        assert_eq!(
            decide(inputs(Some(OLD), Some(NEW), Some(NEW))),
            VersionRepair::Restart {
                source: RepairSource::Bundled
            }
        );
    }

    #[test]
    fn dirty_marker_is_not_a_mismatch() {
        assert_eq!(
            decide(inputs(
                Some("2.10.1+bbbbbbb"),
                Some("2.10.1+bbbbbbb+dirty"),
                Some("2.10.1+bbbbbbb+dirty"),
            )),
            VersionRepair::None
        );
    }

    #[test]
    fn unknown_versions_take_no_action() {
        assert_eq!(decide(inputs(None, Some(OLD), None)), VersionRepair::None);
        assert_eq!(decide(inputs(Some(NEW), None, None)), VersionRepair::None);
        assert_eq!(decide(inputs(None, None, None)), VersionRepair::None);
    }

    #[test]
    fn no_start_never_restarts() {
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), Some(NEW)), true, false),
            VersionRepair::HeldByNoStart
        );
        assert_eq!(
            decide_version_repair(inputs(Some(OLD), Some(OLD), Some(NEW)), true, false),
            VersionRepair::StageBundled
        );
        assert_eq!(
            decide_version_repair(inputs(Some(OLD), None, Some(NEW)), true, false),
            VersionRepair::StageBundled
        );
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(NEW), Some(NEW)), true, false),
            VersionRepair::None
        );
    }

    #[test]
    fn dev_mode_never_touches_the_service() {
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), Some(NEW)), false, true),
            VersionRepair::HeldByDevMode
        );
        assert_eq!(
            decide_version_repair(inputs(Some(OLD), Some(OLD), Some(NEW)), true, true),
            VersionRepair::HeldByDevMode
        );
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(NEW), Some(NEW)), false, true),
            VersionRepair::None
        );
    }

    #[test]
    fn restart_gate_protects_running_kernels() {
        assert_eq!(restart_gate(Ok(0), false, "runt"), RestartGate::Proceed);
        assert_eq!(restart_gate(Ok(0), true, "runt"), RestartGate::Proceed);
        assert_eq!(
            restart_gate(Ok(2), true, "runt"),
            RestartGate::Ask { running_kernels: 2 }
        );
        assert!(matches!(
            restart_gate(Ok(2), false, "runt"),
            RestartGate::Refuse { reason } if reason.starts_with("2 kernel(s) are running")
        ));
        assert!(matches!(
            restart_gate(Err("timed out".into()), true, "runt"),
            RestartGate::Refuse { reason } if reason.contains("timed out")
        ));
    }
}
