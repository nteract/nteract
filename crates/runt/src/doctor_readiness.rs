//! Readiness wait for `daemon doctor --fix`.
//!
//! Some repairs launch the daemon through the service manager: an upgrade
//! that restarts the service, launchd re-registration of a `RunAtLoad`
//! plist, and an explicit service start. The service manager brings the
//! daemon up on its own schedule, so the socket can stay silent for a few
//! seconds after the repair call returns. Doctor then polls the socket for
//! daemon metadata before it writes the final report.
//!
//! A fresh install does not launch anything by itself: on Linux it enables
//! the systemd unit without `--now`, on Windows it writes a Startup script,
//! and on macOS it writes the plist. Only the explicit start that follows it
//! counts as a launch.
//!
//! Doctor waits only for a socket that belongs to the service it launched.
//! In a dev worktree the probed socket is the worktree daemon's, which the
//! channel service never binds.
//!
//! The interval matches the post-repair check in `runtimed::service_repair`.

use std::future::Future;
use std::path::{Path, PathBuf};
use std::time::Duration;

use runtimed_client::singleton::{query_daemon_info, DaemonInfo};

const READY_INTERVAL: Duration = Duration::from_millis(250);
/// Wall-clock bound on the whole wait, probes included. Each probe runs to
/// the client's own timeout; this deadline is the only one doctor adds.
const READY_BUDGET: Duration = Duration::from_secs(10);

/// A doctor repair that touches the service registration or process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ServiceRepair {
    /// Writes the service definition and binary. Launches nothing.
    Install,
    /// Stops the service, replaces its definition, and starts it again
    /// unless `--no-start` staged it instead.
    Upgrade,
    /// Re-registers the launchd job; `RunAtLoad` launches the daemon.
    /// Doctor runs this repair on macOS only.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    LaunchdRegister,
    /// Asks the service manager to start the daemon.
    Start,
}

impl ServiceRepair {
    fn launches_daemon(self, no_start: bool) -> bool {
        match self {
            ServiceRepair::Install => false,
            ServiceRepair::Upgrade => !no_start,
            ServiceRepair::LaunchdRegister | ServiceRepair::Start => true,
        }
    }
}

/// Records whether any successful repair launched the daemon.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LaunchTracker {
    no_start: bool,
    launched: bool,
}

impl LaunchTracker {
    pub(crate) fn new(no_start: bool) -> Self {
        Self {
            no_start,
            launched: false,
        }
    }

    /// Record a repair outcome. Failed repairs never count as a launch.
    pub(crate) fn record(&mut self, repair: ServiceRepair, succeeded: bool) {
        if succeeded && repair.launches_daemon(self.no_start) {
            self.launched = true;
        }
    }

    pub(crate) fn launched(&self) -> bool {
        self.launched
    }
}

/// Outcome of the post-repair wait, carried into the doctor report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartReadiness {
    /// No repair launched the daemon behind the probed socket.
    NotAwaited,
    /// The daemon answered on its socket within the budget.
    Ready,
    /// A repair launched the service, but the daemon never answered.
    TimedOut,
}

/// The socket the installed channel service binds. The service runs without
/// the dev or socket-override environment, so it uses the channel default.
pub(crate) fn service_socket_path() -> PathBuf {
    runt_workspace::socket_path_for_context(runt_workspace::build_channel(), None)
}

/// Whether doctor should wait on `probed` before writing the report.
pub(crate) fn should_await_launch(launches: LaunchTracker, probed: &Path, service: &Path) -> bool {
    launches.launched() && probed == service
}

/// Call `probe` every `READY_INTERVAL` until it returns a value or
/// `READY_BUDGET` runs out.
async fn wait_for_ready<T, P, PF>(mut probe: P) -> Option<T>
where
    P: FnMut() -> PF,
    PF: Future<Output = Option<T>>,
{
    let poll = async {
        loop {
            if let Some(value) = probe().await {
                return value;
            }
            tokio::time::sleep(READY_INTERVAL).await;
        }
    };
    tokio::time::timeout(READY_BUDGET, poll).await.ok()
}

/// Wait for the daemon on `socket_path` to answer `GetDaemonInfo` after a
/// repair launched the service.
pub(crate) async fn await_launched_daemon(
    socket_path: PathBuf,
) -> (Option<DaemonInfo>, StartReadiness) {
    let info = wait_for_ready(|| query_daemon_info(socket_path.clone())).await;
    readiness_from(info)
}

fn readiness_from<T>(info: Option<T>) -> (Option<T>, StartReadiness) {
    match info {
        Some(info) => (Some(info), StartReadiness::Ready),
        None => (None, StartReadiness::TimedOut),
    }
}

/// Diagnosis for an installed service whose daemon does not answer.
pub(crate) fn installed_not_running_diagnosis(
    command_name: &str,
    readiness: StartReadiness,
) -> String {
    match readiness {
        StartReadiness::TimedOut => format!(
            "Daemon service was started but did not answer within {} seconds. Check '{command_name} daemon logs', then rerun '{command_name} daemon doctor'.",
            READY_BUDGET.as_secs()
        ),
        StartReadiness::NotAwaited | StartReadiness::Ready => {
            format!("Daemon installed but not running. Try '{command_name} daemon start'.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn tracker(no_start: bool, outcomes: &[(ServiceRepair, bool)]) -> LaunchTracker {
        let mut launches = LaunchTracker::new(no_start);
        for &(repair, ok) in outcomes {
            launches.record(repair, ok);
        }
        launches
    }

    #[test]
    fn install_alone_is_not_a_launch() {
        use ServiceRepair::*;
        assert!(!tracker(false, &[(Install, true)]).launched());
        assert!(
            !tracker(false, &[(Install, true), (Start, false)]).launched(),
            "a failed start after install does not wait"
        );
        assert!(tracker(false, &[(Install, true), (Start, true)]).launched());
    }

    #[test]
    fn upgrade_launches_only_when_it_restarts_the_service() {
        use ServiceRepair::*;
        assert!(tracker(false, &[(Upgrade, true)]).launched());
        assert!(!tracker(false, &[(Upgrade, false)]).launched());
        assert!(
            !tracker(true, &[(Upgrade, true)]).launched(),
            "--no-start stages the upgrade"
        );
    }

    #[test]
    fn launchd_registration_launches_the_daemon() {
        use ServiceRepair::*;
        assert!(tracker(false, &[(LaunchdRegister, true)]).launched());
        assert!(!tracker(false, &[(LaunchdRegister, false)]).launched());
    }

    #[test]
    fn waits_only_on_the_launched_service_socket() {
        let service = Path::new("/cache/runt-nightly/runtimed.sock");
        let worktree = Path::new("/cache/runt-nightly/worktrees/abc/runtimed.sock");
        let launched = tracker(false, &[(ServiceRepair::Start, true)]);
        let idle = tracker(false, &[(ServiceRepair::Install, true)]);

        assert!(should_await_launch(launched, service, service));
        assert!(
            !should_await_launch(launched, worktree, service),
            "dev worktree socket is not the channel service's"
        );
        assert!(!should_await_launch(idle, service, service));
    }

    #[tokio::test(start_paused = true)]
    async fn wait_returns_once_the_daemon_answers() {
        let calls = Cell::new(0u32);
        let started = tokio::time::Instant::now();
        let result = wait_for_ready(|| {
            calls.set(calls.get() + 1);
            let n = calls.get();
            async move { (n == 3).then_some("ready") }
        })
        .await;

        assert_eq!(
            readiness_from(result),
            (Some("ready"), StartReadiness::Ready)
        );
        assert_eq!(calls.get(), 3);
        assert_eq!(started.elapsed(), READY_INTERVAL * 2);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_gives_up_at_the_budget_when_probes_never_finish() {
        let started = tokio::time::Instant::now();
        let result: Option<()> = wait_for_ready(std::future::pending).await;

        assert_eq!(readiness_from(result), (None, StartReadiness::TimedOut));
        assert_eq!(started.elapsed(), READY_BUDGET);
    }

    #[tokio::test(start_paused = true)]
    async fn wait_gives_up_at_the_budget_when_probes_keep_failing() {
        let calls = Cell::new(0u32);
        let started = tokio::time::Instant::now();
        let result: Option<()> = wait_for_ready(|| {
            calls.set(calls.get() + 1);
            async { None }
        })
        .await;

        assert_eq!(result, None);
        assert_eq!(started.elapsed(), READY_BUDGET);
        // One probe per 250 ms; the probe due at the deadline may run before
        // the timeout fires.
        assert!((40..=41).contains(&calls.get()), "probes: {}", calls.get());
    }

    #[test]
    fn timed_out_start_points_at_logs_instead_of_daemon_start() {
        let timed_out = installed_not_running_diagnosis("runt", StartReadiness::TimedOut);
        assert!(timed_out.contains("did not answer within 10 seconds"));
        assert!(timed_out.contains("'runt daemon logs'"));
        assert!(!timed_out.contains("daemon start"));

        for readiness in [StartReadiness::NotAwaited, StartReadiness::Ready] {
            assert_eq!(
                installed_not_running_diagnosis("nteract", readiness),
                "Daemon installed but not running. Try 'nteract daemon start'."
            );
        }
    }
}
