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
//! Versions are ordered by semver precedence, ignoring build metadata. Doctor
//! only moves forward. A target older than the installed binary or the running
//! daemon means this CLI belongs to an older copy of the app, and doctor leaves
//! both alone. Two builds of the same release cannot be ordered, and an
//! unreadable installed version is unknown; both take no action.
//!
//! A restart goes through `<target> install`, the transactional service repair
//! in `runtimed::service_repair`. It asks the daemon for a clean shutdown,
//! keeps recovery state, refuses to kill a daemon that stays responsive, and
//! verifies the replacement's version before it exits zero. Doctor never stops
//! a live daemon itself on this path.
//!
//! A clean shutdown still ends every kernel, so the restart is gated on what
//! the endpoint reports. A confirmed absent daemon restarts. An answering
//! daemon with no running kernels restarts. Running kernels ask on an
//! interactive terminal and refuse otherwise. A probe that neither answers nor
//! proves the daemon absent refuses. `--no-start` never restarts. Dev mode
//! never restarts either: the socket belongs to the worktree daemon, while the
//! service definition belongs to the installed app.

use std::cmp::Ordering;
use std::path::Path;
use std::time::Duration;

use runtimed_client::versions_match_ignoring_dirty;

/// Deadline for `<target> install`. The repair's own bounds add up to about
/// six minutes in the worst case: two minutes of clean shutdown, two minutes
/// for the service to exit, and about a minute and a half of readiness
/// probes. Doctor gives it seven.
pub(crate) const SERVICE_REPAIR_TIMEOUT: Duration = Duration::from_secs(420);
/// Trailing bytes of the repair's stderr kept for the error message. All of
/// it is read, so the child never blocks on a full pipe.
const REPAIR_STDERR_CAP: usize = 16 * 1024;
/// Lines of captured stderr quoted in an error.
const REPAIR_STDERR_LINES: usize = 5;

/// Versions read by doctor before it repairs anything.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct VersionInputs<'a> {
    pub installed: Option<&'a str>,
    /// Only set when the daemon's PID is confirmed alive.
    pub running: Option<&'a str>,
    /// Only set when the bundled binary exists and reported a version.
    pub bundled: Option<&'a str>,
}

/// Host facts that change which repairs are possible.
#[derive(Debug, Clone, Copy, Default)]
pub(crate) struct RepairContext {
    pub no_start: bool,
    pub dev_mode: bool,
    /// `<installed> install` replaces its own executable. Windows cannot
    /// replace a running image, so this is false there.
    pub can_reinstall_from_installed: bool,
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
    /// Versions agree, or the installed version is unknown.
    None,
    /// `--no-start`: write the bundled binary into the service definition and
    /// leave the daemon down until the service manager starts it.
    StageBundled,
    /// Run the transactional repair from `source`.
    Restart { source: RepairSource },
    /// The running daemon is stale, but `--no-start` forbids a restart.
    HeldByNoStart,
    /// Something is stale, but dev mode keeps doctor away from the worktree
    /// daemon and the installed service.
    HeldByDevMode,
    /// The target is older than the installed binary or the running daemon.
    HeldOlderTarget,
    /// Two versions differ but have no order: same release, different build,
    /// or a version string that does not parse.
    HeldUnordered,
    /// The restart would have to replace the running installed executable,
    /// which this platform does not allow.
    HeldByPlatform,
}

/// How moving from one version to another relates in release order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Step {
    Same,
    Forward,
    Backward,
    Unordered,
}

fn parse_release(version: &str) -> Option<semver::Version> {
    // `+dirty` follows the build hash and is not valid build metadata.
    let version = version.strip_suffix("+dirty").unwrap_or(version);
    semver::Version::parse(version).ok()
}

fn step(from: &str, to: &str) -> Step {
    if versions_match_ignoring_dirty(from, to) {
        return Step::Same;
    }
    match (parse_release(from), parse_release(to)) {
        (Some(from), Some(to)) => match from.cmp_precedence(&to) {
            Ordering::Less => Step::Forward,
            Ordering::Greater => Step::Backward,
            Ordering::Equal => Step::Unordered,
        },
        _ => Step::Unordered,
    }
}

pub(crate) fn decide_version_repair(
    versions: VersionInputs<'_>,
    context: RepairContext,
) -> VersionRepair {
    // A failed `--version` probe on the installed binary is not evidence of a
    // mismatch; report it and leave the service alone.
    let Some(installed) = versions.installed else {
        return VersionRepair::None;
    };
    let (target, source) = match versions.bundled {
        Some(bundled) => (bundled, RepairSource::Bundled),
        None => (installed, RepairSource::Installed),
    };
    let binary = step(installed, target);
    let running = versions
        .running
        .map_or(Step::Same, |running| step(running, target));
    let steps = [binary, running];

    if steps.iter().all(|step| *step == Step::Same) {
        return VersionRepair::None;
    }
    if context.dev_mode {
        return VersionRepair::HeldByDevMode;
    }
    if steps.contains(&Step::Backward) {
        return VersionRepair::HeldOlderTarget;
    }
    if steps.contains(&Step::Unordered) {
        return VersionRepair::HeldUnordered;
    }
    if context.no_start {
        return if binary == Step::Forward {
            VersionRepair::StageBundled
        } else {
            VersionRepair::HeldByNoStart
        };
    }
    if source == RepairSource::Installed && !context.can_reinstall_from_installed {
        return VersionRepair::HeldByPlatform;
    }
    VersionRepair::Restart { source }
}

/// What the daemon endpoint showed when doctor probed it before a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DaemonPresence {
    /// The endpoint is missing or refused, and no daemon PID is alive.
    Absent,
    /// The daemon answered. `running_kernels` is `Err` when the room list
    /// could not be read.
    Answering {
        running_kernels: Result<usize, String>,
    },
    /// Neither an answer nor proof of absence: a busy or wedged daemon, a
    /// probe timeout, or a live PID without a socket.
    Inconclusive { reason: String },
}

/// Whether a restart may proceed.
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

pub(crate) fn restart_gate(
    presence: DaemonPresence,
    interactive: bool,
    command_name: &str,
) -> RestartGate {
    match presence {
        DaemonPresence::Absent => RestartGate::Proceed,
        DaemonPresence::Answering {
            running_kernels: Ok(0),
        } => RestartGate::Proceed,
        DaemonPresence::Answering {
            running_kernels: Ok(count),
        } if interactive => RestartGate::Ask {
            running_kernels: count,
        },
        DaemonPresence::Answering {
            running_kernels: Ok(count),
        } => RestartGate::Refuse {
            reason: format!(
                "{count} kernel(s) are running. Restarting the daemon would stop them. \
                 Close those notebooks or restart the app, then rerun '{command_name} daemon doctor --fix'."
            ),
        },
        DaemonPresence::Answering {
            running_kernels: Err(error),
        } => RestartGate::Refuse {
            reason: format!(
                "could not list open notebooks ({error}). \
                 Restart the app, or rerun '{command_name} daemon doctor --fix'."
            ),
        },
        DaemonPresence::Inconclusive { reason } => RestartGate::Refuse {
            reason: format!(
                "could not confirm whether the daemon is running ({reason}). \
                 Restart the app, or rerun '{command_name} daemon doctor --fix'."
            ),
        },
    }
}

/// Run `<source> install`, the daemon's transactional service repair.
///
/// The child inherits no endpoint override or dev namespace, so it resolves
/// the service's own endpoint. It is killed if it outlives `deadline`; the
/// daemon may then be stopped, and the error says so.
pub(crate) async fn run_service_repair(source: &Path, deadline: Duration) -> Result<(), String> {
    use tokio::io::AsyncReadExt;

    let mut child = tokio::process::Command::new(source)
        .arg("install")
        .env_remove("RUNTIMED_SOCKET_PATH")
        .env_remove("RUNTIMED_DEV")
        .env_remove("RUNTIMED_WORKSPACE_PATH")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("could not run {} install: {error}", source.display()))?;
    let stderr = child.stderr.take();
    let run = async {
        // Keep the last REPAIR_STDERR_CAP bytes: the error is at the end.
        let mut captured = Vec::new();
        if let Some(mut stderr) = stderr {
            let mut chunk = [0u8; 8192];
            loop {
                let read = stderr.read(&mut chunk).await?;
                if read == 0 {
                    break;
                }
                captured.extend_from_slice(&chunk[..read]);
                if captured.len() > REPAIR_STDERR_CAP {
                    captured.drain(..captured.len() - REPAIR_STDERR_CAP);
                }
            }
        }
        let status = child.wait().await?;
        Ok::<_, std::io::Error>((status, captured))
    };
    let (status, captured) = match tokio::time::timeout(deadline, run).await {
        Ok(Ok(done)) => done,
        Ok(Err(error)) => {
            return Err(format!("{} install failed: {error}", source.display()));
        }
        Err(_) => {
            let _ = child.start_kill();
            return Err(format!(
                "{} install did not finish within {} seconds and was stopped; the daemon may be down. Rerun the doctor with --fix.",
                source.display(),
                deadline.as_secs()
            ));
        }
    };
    if status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&captured);
    let lines: Vec<&str> = stderr
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    let tail = &lines[lines.len().saturating_sub(REPAIR_STDERR_LINES)..];
    Err(format!(
        "{} install exited with {status}: {}",
        source.display(),
        tail.join(" | ")
    ))
}

/// Confirm the daemon answering after a repair is a new process running the
/// target version. `after` is the `(version, pid)` the endpoint reported.
pub(crate) fn confirm_restarted(
    after: Option<(&str, u32)>,
    previous_pid: Option<u32>,
    target: &str,
) -> Result<String, String> {
    let Some((version, pid)) = after else {
        return Err("the repair exited zero, but no daemon answered afterwards".to_string());
    };
    if previous_pid == Some(pid) {
        return Err(format!(
            "the repair exited zero, but daemon pid {pid} is still the one answering"
        ));
    }
    if !versions_match_ignoring_dirty(version, target) {
        return Err(format!(
            "the repair exited zero, but the daemon reports {version}, not {target}"
        ));
    }
    Ok(version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const OLD: &str = "2.10.0+aaaaaaa";
    const NEW: &str = "2.10.1+bbbbbbb";
    const NEWER: &str = "2.11.0+ccccccc";

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

    fn start() -> RepairContext {
        RepairContext {
            no_start: false,
            dev_mode: false,
            can_reinstall_from_installed: true,
        }
    }

    fn decide(versions: VersionInputs<'_>) -> VersionRepair {
        decide_version_repair(versions, start())
    }

    const RESTART_FROM_BUNDLE: VersionRepair = VersionRepair::Restart {
        source: RepairSource::Bundled,
    };

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
            RESTART_FROM_BUNDLE
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
            RESTART_FROM_BUNDLE
        );
        // Daemon down: the repair installs and starts the bundled binary.
        assert_eq!(
            decide(inputs(Some(OLD), None, Some(NEW))),
            RESTART_FROM_BUNDLE
        );
    }

    #[test]
    fn running_daemon_matching_bundle_still_repairs_stale_installed_binary() {
        assert_eq!(
            decide(inputs(Some(OLD), Some(NEW), Some(NEW))),
            RESTART_FROM_BUNDLE
        );
    }

    #[test]
    fn older_app_copy_never_downgrades() {
        // A CLI from a stale ~/Applications copy next to a newer /Applications.
        assert_eq!(
            decide(inputs(Some(NEWER), Some(NEWER), Some(NEW))),
            VersionRepair::HeldOlderTarget
        );
        // Installed matches the old bundle, but a newer daemon is serving.
        assert_eq!(
            decide(inputs(Some(NEW), Some(NEWER), Some(NEW))),
            VersionRepair::HeldOlderTarget
        );
        // Without a bundle, the installed binary is the target.
        assert_eq!(
            decide(inputs(Some(NEW), Some(NEWER), None)),
            VersionRepair::HeldOlderTarget
        );
        // Forward on one axis, backward on the other.
        assert_eq!(
            decide(inputs(Some(OLD), Some(NEWER), Some(NEW))),
            VersionRepair::HeldOlderTarget
        );
    }

    #[test]
    fn prerelease_orders_by_precedence() {
        assert_eq!(
            decide(inputs(
                Some("2.11.0-nightly.202611250+bbbbbbb"),
                Some("2.11.0-nightly.202611240+aaaaaaa"),
                Some("2.11.0-nightly.202611250+bbbbbbb"),
            )),
            RESTART_FROM_BUNDLE
        );
        assert_eq!(
            decide(inputs(
                Some("2.11.0-nightly.202611240+aaaaaaa"),
                Some("2.11.0-nightly.202611250+bbbbbbb"),
                Some("2.11.0-nightly.202611240+aaaaaaa"),
            )),
            VersionRepair::HeldOlderTarget
        );
    }

    #[test]
    fn same_release_different_build_is_unordered() {
        assert_eq!(
            decide(inputs(
                Some("2.10.1+bbbbbbb"),
                Some("2.10.1+aaaaaaa"),
                Some("2.10.1+bbbbbbb"),
            )),
            VersionRepair::HeldUnordered
        );
        assert_eq!(
            decide(inputs(Some(NEW), Some("not-a-version"), Some(NEW))),
            VersionRepair::HeldUnordered
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
        // A dirty build still orders by its release.
        assert_eq!(
            decide(inputs(Some(NEW), Some("2.10.0+aaaaaaa+dirty"), Some(NEW))),
            RESTART_FROM_BUNDLE
        );
    }

    #[test]
    fn unknown_installed_version_takes_no_action() {
        assert_eq!(
            decide(inputs(None, Some(OLD), Some(NEW))),
            VersionRepair::None
        );
        assert_eq!(decide(inputs(None, Some(OLD), None)), VersionRepair::None);
        assert_eq!(decide(inputs(None, None, None)), VersionRepair::None);
        assert_eq!(decide(inputs(Some(NEW), None, None)), VersionRepair::None);
    }

    #[test]
    fn no_start_never_restarts() {
        let no_start = RepairContext {
            no_start: true,
            ..start()
        };
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), Some(NEW)), no_start),
            VersionRepair::HeldByNoStart
        );
        assert_eq!(
            decide_version_repair(inputs(Some(OLD), Some(OLD), Some(NEW)), no_start),
            VersionRepair::StageBundled
        );
        assert_eq!(
            decide_version_repair(inputs(Some(OLD), None, Some(NEW)), no_start),
            VersionRepair::StageBundled
        );
        assert_eq!(
            decide_version_repair(inputs(Some(NEWER), None, Some(NEW)), no_start),
            VersionRepair::HeldOlderTarget
        );
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(NEW), Some(NEW)), no_start),
            VersionRepair::None
        );
    }

    #[test]
    fn dev_mode_never_touches_the_service() {
        let dev = RepairContext {
            dev_mode: true,
            ..start()
        };
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), Some(NEW)), dev),
            VersionRepair::HeldByDevMode
        );
        assert_eq!(
            decide_version_repair(
                inputs(Some(OLD), Some(OLD), Some(NEW)),
                RepairContext {
                    no_start: true,
                    ..dev
                }
            ),
            VersionRepair::HeldByDevMode
        );
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(NEW), Some(NEW)), dev),
            VersionRepair::None
        );
    }

    #[test]
    fn platform_without_self_replacement_holds_installed_source() {
        let windows = RepairContext {
            can_reinstall_from_installed: false,
            ..start()
        };
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), None), windows),
            VersionRepair::HeldByPlatform
        );
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), Some(NEW)), windows),
            RESTART_FROM_BUNDLE
        );
    }

    fn answering(kernels: Result<usize, String>) -> DaemonPresence {
        DaemonPresence::Answering {
            running_kernels: kernels,
        }
    }

    #[test]
    fn restart_gate_proceeds_only_with_proof_of_no_kernels() {
        assert_eq!(
            restart_gate(DaemonPresence::Absent, false, "runt"),
            RestartGate::Proceed
        );
        assert_eq!(
            restart_gate(answering(Ok(0)), false, "runt"),
            RestartGate::Proceed
        );
        assert_eq!(
            restart_gate(answering(Ok(0)), true, "runt"),
            RestartGate::Proceed
        );
    }

    #[test]
    fn restart_gate_protects_running_kernels() {
        assert_eq!(
            restart_gate(answering(Ok(2)), true, "runt"),
            RestartGate::Ask { running_kernels: 2 }
        );
        assert!(matches!(
            restart_gate(answering(Ok(2)), false, "runt"),
            RestartGate::Refuse { reason } if reason.starts_with("2 kernel(s) are running")
        ));
        assert!(matches!(
            restart_gate(answering(Err("timed out".into())), true, "runt"),
            RestartGate::Refuse { reason } if reason.contains("timed out")
        ));
    }

    #[test]
    fn restart_gate_refuses_an_inconclusive_probe() {
        // A busy daemon that missed the ping is not an absent daemon, even on
        // a terminal where kernels would only prompt.
        for interactive in [false, true] {
            assert!(matches!(
                restart_gate(
                    DaemonPresence::Inconclusive {
                        reason: "ping timed out".into()
                    },
                    interactive,
                    "runt",
                ),
                RestartGate::Refuse { reason } if reason.contains("ping timed out")
            ));
        }
    }

    #[test]
    fn restart_is_confirmed_by_a_new_pid_on_the_target_version() {
        assert_eq!(
            confirm_restarted(Some((NEW, 20)), Some(10), NEW),
            Ok(NEW.to_string())
        );
        assert_eq!(
            confirm_restarted(Some(("2.10.1+bbbbbbb+dirty", 20)), None, NEW),
            Ok("2.10.1+bbbbbbb+dirty".to_string())
        );
        assert!(confirm_restarted(None, Some(10), NEW)
            .is_err_and(|error| error.contains("no daemon answered")));
        assert!(confirm_restarted(Some((NEW, 10)), Some(10), NEW)
            .is_err_and(|error| error.contains("still the one answering")));
        assert!(confirm_restarted(Some((OLD, 20)), Some(10), NEW)
            .is_err_and(|error| error.contains("reports 2.10.0")));
    }

    #[cfg(unix)]
    fn script(dir: &tempfile::TempDir, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = dir.path().join("fake-runtimed");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_repair_passes_install_and_reports_success() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("args");
        let source = script(
            &dir,
            &format!("echo \"$@\" > '{}'; exit 0", marker.display()),
        );
        assert_eq!(
            run_service_repair(&source, Duration::from_secs(10)).await,
            Ok(())
        );
        assert_eq!(std::fs::read_to_string(marker).unwrap().trim(), "install");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_repair_stops_at_the_deadline() {
        let dir = tempfile::tempdir().unwrap();
        let source = script(&dir, "exec sleep 30");
        let started = std::time::Instant::now();
        let error = run_service_repair(&source, Duration::from_millis(200))
            .await
            .unwrap_err();
        assert!(error.contains("did not finish"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(10));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_repair_caps_captured_stderr() {
        let dir = tempfile::tempdir().unwrap();
        // 200 KiB of stderr, more than a pipe buffer, then a final error line.
        let source = script(
            &dir,
            "i=0; while [ $i -lt 2048 ]; do printf '%0100d\\n' 0 >&2; i=$((i+1)); done; echo 'Error: final' >&2; exit 3",
        );
        let error = run_service_repair(&source, Duration::from_secs(20))
            .await
            .unwrap_err();
        assert!(error.contains("exited with"), "{error}");
        assert!(error.contains("Error: final"), "{error}");
        assert!(error.len() < 2048, "error was {} bytes", error.len());
    }
}
