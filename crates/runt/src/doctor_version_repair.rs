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
//! the endpoint reports. A daemon counts as absent only when its endpoint is
//! missing or refused, no PID from the socket is alive, and the service
//! manager reports no running process for the service. An answering daemon
//! with no running kernels restarts. Running kernels ask on an interactive
//! terminal and refuse otherwise. Anything else refuses. The gate covers this
//! restart only; the `--no-start` staging path and doctor's older plist
//! repairs stop the service without it.
//!
//! `--no-start` never restarts. Dev mode never restarts either: the socket
//! belongs to the worktree daemon, while the service definition belongs to
//! the installed app. Windows never restarts: its service stop kills every
//! process with the daemon's image name, including daemons doctor never
//! checked for kernels.

use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use runtimed_client::versions_match_ignoring_dirty;

/// How long doctor waits for `<target> install`. The repair's own bounds add
/// up to about six minutes in the worst case: two minutes of clean shutdown,
/// two minutes for the service to exit, and about a minute and a half of
/// readiness probes. Doctor waits seven, then reports without stopping it.
pub(crate) const SERVICE_REPAIR_TIMEOUT: Duration = Duration::from_secs(420);
/// Trailing bytes of the repair's log read back for an error.
const REPAIR_LOG_TAIL_BYTES: u64 = 16 * 1024;
/// Lines of the repair's log quoted in an error.
const REPAIR_LOG_TAIL_LINES: usize = 5;
/// Bytes of `--version` output read before giving up on a line.
const VERSION_OUTPUT_CAP: u64 = 4096;

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
    /// The service stop can be scoped to the daemon doctor checked. False on
    /// Windows, where it kills by image name.
    pub service_restart_supported: bool,
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
    /// The platform's service stop cannot be scoped to the checked daemon.
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
    if !context.service_restart_supported {
        return VersionRepair::HeldByPlatform;
    }
    VersionRepair::Restart { source }
}

/// The result of pinging the daemon endpoint before a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PingOutcome {
    /// The daemon answered. `running_kernels` is `Err` when the room list
    /// could not be read.
    Answered {
        running_kernels: Result<usize, String>,
    },
    /// The endpoint is missing or refused the connection.
    EndpointAbsent,
    /// A timeout or any other error.
    Failed { reason: String },
}

/// What doctor knows about the daemon before a restart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum DaemonPresence {
    /// The endpoint is missing or refused, no daemon PID is alive, and the
    /// service manager reports no running process.
    Absent,
    /// The daemon answered. `running_kernels` is `Err` when the room list
    /// could not be read.
    Answering {
        running_kernels: Result<usize, String>,
    },
    /// Neither an answer nor proof of absence.
    Inconclusive { reason: String },
}

/// Combine the endpoint ping with the other evidence of a running daemon.
///
/// `socket_pid` is a daemon PID still alive from the last socket metadata.
/// `service_pid` is what the service manager reports for the service; it is
/// only consulted when the endpoint looks absent, because a moved or unlinked
/// socket path hides a daemon from the ping but not from the service manager.
pub(crate) fn classify_presence(
    ping: PingOutcome,
    socket_pid: Option<u32>,
    service_pid: Result<Option<u32>, String>,
) -> DaemonPresence {
    match ping {
        PingOutcome::Answered { running_kernels } => DaemonPresence::Answering { running_kernels },
        PingOutcome::Failed { reason } => DaemonPresence::Inconclusive { reason },
        PingOutcome::EndpointAbsent => match (socket_pid, service_pid) {
            (Some(pid), _) => DaemonPresence::Inconclusive {
                reason: format!("daemon pid {pid} is alive but its endpoint refused the connection"),
            },
            (None, Ok(Some(pid))) => DaemonPresence::Inconclusive {
                reason: format!(
                    "the service manager reports daemon pid {pid} running, but the endpoint is missing; the socket path may differ from the service's"
                ),
            },
            (None, Err(error)) => DaemonPresence::Inconclusive {
                reason: format!("could not ask the service manager: {error}"),
            },
            (None, Ok(None)) => DaemonPresence::Absent,
        },
    }
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

/// Why `<source> install` did not succeed.
#[derive(Debug)]
pub(crate) enum RepairFailure {
    Spawn(String),
    Exited {
        status: String,
        tail: String,
        log: PathBuf,
    },
    /// Still running at the deadline. Doctor leaves it running: stopping it
    /// between the service stop and start would leave no daemon.
    StillRunning {
        pid: Option<u32>,
        tail: String,
        log: PathBuf,
    },
}

impl std::fmt::Display for RepairFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Spawn(error) => write!(f, "{error}"),
            Self::Exited { status, tail, log } => write!(
                f,
                "install exited with {status}: {tail} (full log: {})",
                log.display()
            ),
            Self::StillRunning { pid, tail, log } => write!(
                f,
                "install was still running at the deadline (pid {}) and was left to finish; last output: {tail} (full log: {})",
                pid.map_or_else(|| "unknown".to_string(), |pid| pid.to_string()),
                log.display()
            ),
        }
    }
}

/// Run `<source> install`, the daemon's transactional service repair, and
/// wait up to `deadline` for it.
///
/// The child inherits no endpoint override or dev namespace, so it resolves
/// the service's own endpoint. Its stdout and stderr go to a log file in
/// `log_dir` rather than a pipe, so it can outlive doctor without writing
/// into a closed pipe. The file is removed on success and kept otherwise.
pub(crate) async fn run_service_repair(
    source: &Path,
    deadline: Duration,
    log_dir: &Path,
) -> Result<(), RepairFailure> {
    let log = log_dir.join(format!(
        "runt-doctor-repair-{}-{}.log",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |elapsed| elapsed.as_nanos())
    ));
    let spawn_error = |error: std::io::Error| {
        RepairFailure::Spawn(format!(
            "could not run {} install: {error}",
            source.display()
        ))
    };
    let stdout = std::fs::File::create_new(&log).map_err(spawn_error)?;
    let stderr = stdout.try_clone().map_err(spawn_error)?;
    let mut child = tokio::process::Command::new(source)
        .arg("install")
        .env_remove("RUNTIMED_SOCKET_PATH")
        .env_remove("RUNTIMED_DEV")
        .env_remove("RUNTIMED_WORKSPACE_PATH")
        .stdin(std::process::Stdio::null())
        .stdout(stdout)
        .stderr(stderr)
        .kill_on_drop(false)
        .spawn()
        .map_err(spawn_error)?;

    match tokio::time::timeout(deadline, child.wait()).await {
        Ok(Ok(status)) if status.success() => {
            let _ = std::fs::remove_file(&log);
            Ok(())
        }
        Ok(Ok(status)) => Err(RepairFailure::Exited {
            status: status.to_string(),
            tail: read_log_tail(&log),
            log,
        }),
        Ok(Err(error)) => Err(RepairFailure::Exited {
            status: format!("an unknown status ({error})"),
            tail: read_log_tail(&log),
            log,
        }),
        Err(_) => Err(RepairFailure::StillRunning {
            pid: child.id(),
            tail: read_log_tail(&log),
            log,
        }),
    }
}

/// The last non-empty lines of a repair log, reading at most
/// `REPAIR_LOG_TAIL_BYTES` from its end.
fn read_log_tail(path: &Path) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = std::fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map_or(0, |metadata| metadata.len());
    let start = len.saturating_sub(REPAIR_LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return String::new();
    }
    let mut bytes = Vec::new();
    if (&mut file)
        .take(REPAIR_LOG_TAIL_BYTES)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return String::new();
    }
    let text = String::from_utf8_lossy(&bytes);
    let mut lines: Vec<&str> = text.lines().collect();
    if start > 0 && !lines.is_empty() {
        // The read began mid-line.
        lines.remove(0);
    }
    let lines: Vec<&str> = lines
        .into_iter()
        .filter(|line| !line.trim().is_empty())
        .collect();
    lines[lines.len().saturating_sub(REPAIR_LOG_TAIL_LINES)..].join(" | ")
}

/// Run `<path> --version` and return its first line without the binary name,
/// e.g. `"2.0.0+a1b2c3d"`. One deadline covers the exit and the read, so a
/// wedged binary, or a wrapper whose child keeps stdout open, cannot hang
/// doctor.
pub(crate) fn binary_version(path: &Path, deadline: Duration) -> Option<String> {
    use std::io::{BufRead, BufReader, Read};
    let started = Instant::now();
    let mut child = std::process::Command::new(path)
        .arg("--version")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let (line_tx, line_rx) = std::sync::mpsc::channel();
    // A reader blocked on a pipe held open by a grandchild ends when that
    // process closes it; doctor does not wait for it.
    std::thread::spawn(move || {
        let mut line = String::new();
        let read = BufReader::new(stdout.take(VERSION_OUTPUT_CAP)).read_line(&mut line);
        let _ = line_tx.send(read.map(|_| line));
    });
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if started.elapsed() < deadline => {
                std::thread::sleep(Duration::from_millis(20));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    if !status.success() {
        return None;
    }
    let line = line_rx
        .recv_timeout(deadline.saturating_sub(started.elapsed()))
        .ok()?
        .ok()?;
    let version = line.trim().trim_start_matches("runtimed ").to_string();
    (!version.is_empty()).then_some(version)
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
            service_restart_supported: true,
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
    fn windows_never_restarts() {
        let windows = RepairContext {
            service_restart_supported: false,
            ..start()
        };
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), None), windows),
            VersionRepair::HeldByPlatform
        );
        assert_eq!(
            decide_version_repair(inputs(Some(NEW), Some(OLD), Some(NEW)), windows),
            VersionRepair::HeldByPlatform
        );
        // The NSIS hook stages with --no-start, which stays available.
        assert_eq!(
            decide_version_repair(
                inputs(Some(OLD), Some(OLD), Some(NEW)),
                RepairContext {
                    no_start: true,
                    ..windows
                }
            ),
            VersionRepair::StageBundled
        );
    }

    #[test]
    fn absence_needs_every_witness_to_agree() {
        assert_eq!(
            classify_presence(PingOutcome::EndpointAbsent, None, Ok(None)),
            DaemonPresence::Absent
        );
        assert!(matches!(
            classify_presence(PingOutcome::EndpointAbsent, Some(7), Ok(None)),
            DaemonPresence::Inconclusive { reason } if reason.contains("pid 7 is alive")
        ));
        // Socket unlinked or moved: only the service manager still sees it.
        assert!(matches!(
            classify_presence(PingOutcome::EndpointAbsent, None, Ok(Some(9))),
            DaemonPresence::Inconclusive { reason } if reason.contains("reports daemon pid 9")
        ));
        assert!(matches!(
            classify_presence(PingOutcome::EndpointAbsent, None, Err("no systemd".into())),
            DaemonPresence::Inconclusive { reason } if reason.contains("no systemd")
        ));
    }

    #[test]
    fn failed_ping_is_inconclusive_and_answers_carry_kernels() {
        assert_eq!(
            classify_presence(
                PingOutcome::Failed {
                    reason: "ping timed out".into()
                },
                None,
                Ok(None)
            ),
            DaemonPresence::Inconclusive {
                reason: "ping timed out".into()
            }
        );
        assert_eq!(
            classify_presence(
                PingOutcome::Answered {
                    running_kernels: Ok(3)
                },
                None,
                Ok(None)
            ),
            answering(Ok(3))
        );
    }

    #[test]
    fn busy_daemon_cannot_reach_proceed() {
        // End to end through both functions: a timed-out ping never restarts.
        let presence = classify_presence(
            PingOutcome::Failed {
                reason: "ping timed out".into(),
            },
            None,
            Ok(None),
        );
        assert!(matches!(
            restart_gate(presence, true, "runt"),
            RestartGate::Refuse { .. }
        ));
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
    fn logs_in(dir: &Path) -> Vec<std::path::PathBuf> {
        std::fs::read_dir(dir)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "log"))
            .collect()
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_repair_passes_install_and_removes_its_log() {
        let bin = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let marker = bin.path().join("args");
        let source = script(
            &bin,
            &format!(
                "echo \"$@\" > '{}'; echo progress; exit 0",
                marker.display()
            ),
        );
        run_service_repair(&source, Duration::from_secs(10), logs.path())
            .await
            .unwrap();
        assert_eq!(std::fs::read_to_string(marker).unwrap().trim(), "install");
        assert!(logs_in(logs.path()).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_repair_failure_keeps_the_log_tail() {
        let bin = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let source = script(&bin, "echo starting; echo 'Error: socket busy' >&2; exit 3");
        let failure = run_service_repair(&source, Duration::from_secs(10), logs.path())
            .await
            .unwrap_err();
        match &failure {
            RepairFailure::Exited { tail, log, .. } => {
                assert_eq!(tail, "starting | Error: socket busy");
                assert!(log.exists());
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn service_repair_is_left_running_at_the_deadline() {
        let bin = tempfile::tempdir().unwrap();
        let logs = tempfile::tempdir().unwrap();
        let finished = bin.path().join("finished");
        let source = script(
            &bin,
            &format!(
                "echo stopping old daemon; sleep 3; echo done > '{}'",
                finished.display()
            ),
        );
        let started = std::time::Instant::now();
        let failure = run_service_repair(&source, Duration::from_secs(1), logs.path())
            .await
            .unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(3));
        match &failure {
            RepairFailure::StillRunning { pid, tail, .. } => {
                assert!(pid.is_some());
                assert_eq!(tail, "stopping old daemon");
            }
            other => panic!("unexpected {other:?}"),
        }
        // Doctor did not stop the repair; it finishes on its own.
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while !finished.exists() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(finished.exists(), "repair was stopped at the deadline");
    }

    #[test]
    fn log_tail_reads_a_bounded_suffix() {
        use std::io::Write;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("repair.log");
        let mut file = std::fs::File::create(&path).unwrap();
        // 1 MiB of noise, then the error.
        for _ in 0..10_000 {
            writeln!(file, "{}", "x".repeat(100)).unwrap();
        }
        writeln!(file, "Error: final").unwrap();
        drop(file);
        let tail = read_log_tail(&path);
        assert!(tail.ends_with("Error: final"), "{tail}");
        assert!(
            tail.len() <= REPAIR_LOG_TAIL_BYTES as usize,
            "tail was {} bytes",
            tail.len()
        );
        // The partial first line of the window is dropped.
        assert!(tail
            .split(" | ")
            .all(|line| line == "Error: final" || line.len() == 100));
    }

    #[cfg(unix)]
    #[test]
    fn binary_version_reads_the_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let source = script(&dir, "echo 'runtimed 2.11.0+abc1234'");
        assert_eq!(
            binary_version(&source, Duration::from_secs(5)).as_deref(),
            Some("2.11.0+abc1234")
        );
    }

    #[cfg(unix)]
    #[test]
    fn binary_version_gives_up_on_a_wedged_binary() {
        let dir = tempfile::tempdir().unwrap();
        let source = script(&dir, "exec sleep 30");
        let started = std::time::Instant::now();
        assert_eq!(binary_version(&source, Duration::from_millis(200)), None);
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn binary_version_is_not_held_by_a_child_keeping_stdout_open() {
        let dir = tempfile::tempdir().unwrap();
        // The wrapper prints and exits, leaving a background child that
        // still holds stdout.
        let source = script(&dir, "sleep 5 & echo 'runtimed 2.11.0+abc1234'");
        let started = std::time::Instant::now();
        assert_eq!(
            binary_version(&source, Duration::from_secs(2)).as_deref(),
            Some("2.11.0+abc1234")
        );
        assert!(started.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn binary_version_misses_a_line_that_never_arrives() {
        let dir = tempfile::tempdir().unwrap();
        // Exits zero without printing while a child keeps stdout open.
        let source = script(&dir, "sleep 5 &");
        let started = std::time::Instant::now();
        assert_eq!(binary_version(&source, Duration::from_millis(500)), None);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
}
