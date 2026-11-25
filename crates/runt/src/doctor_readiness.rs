//! Readiness wait for `daemon doctor --fix`.
//!
//! A repair that installs, upgrades, or starts the service hands the daemon to
//! the service manager. launchd, systemd, or the Windows Startup entry then
//! launches it on its own schedule, so the socket can stay silent for a few
//! seconds after the repair call returns. Doctor polls the socket for daemon
//! metadata before it writes the final report. It polls only when a repair
//! asked the service manager to start the daemon; `--no-start` runs and runs
//! with no start-capable repair go straight to the report.
//!
//! The attempt count and interval match the post-repair check in
//! `runtimed::service_repair`.

use std::future::Future;
use std::path::PathBuf;
use std::time::Duration;

use runtimed_client::singleton::{query_daemon_info, DaemonInfo};

const READY_ATTEMPTS: u32 = 40;
const READY_INTERVAL: Duration = Duration::from_millis(250);
/// Wall-clock bound on the whole wait. A socket that accepts but never
/// answers would otherwise stretch each attempt by the probe timeout.
const READY_BUDGET: Duration = Duration::from_secs(10);
const READY_PROBE_TIMEOUT: Duration = Duration::from_secs(1);

/// Outcome of the post-repair wait, carried into the doctor report.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StartReadiness {
    /// No repair asked the service manager to start the daemon.
    NotAwaited,
    /// The daemon answered on its socket within the budget.
    Ready,
    /// A repair started the service, but the daemon never answered.
    TimedOut,
}

/// Whether doctor should wait for the daemon before writing the report.
pub(crate) fn should_await_start(fix: bool, no_start: bool, start_requested: bool) -> bool {
    fix && !no_start && start_requested
}

/// Call `probe` until it returns a value, sleeping `interval` between
/// attempts. Gives up after `attempts` probes without a trailing sleep.
pub(crate) async fn poll_until_ready<T, P, PF, S, SF>(
    attempts: u32,
    interval: Duration,
    mut probe: P,
    mut sleep: S,
) -> Option<T>
where
    P: FnMut() -> PF,
    PF: Future<Output = Option<T>>,
    S: FnMut(Duration) -> SF,
    SF: Future<Output = ()>,
{
    for attempt in 0..attempts {
        if let Some(value) = probe().await {
            return Some(value);
        }
        if attempt + 1 < attempts {
            sleep(interval).await;
        }
    }
    None
}

/// Wait for the daemon on `socket_path` to answer `GetDaemonInfo` after a
/// repair started the service.
pub(crate) async fn await_started_daemon(
    socket_path: PathBuf,
) -> (Option<DaemonInfo>, StartReadiness) {
    let poll = poll_until_ready(
        READY_ATTEMPTS,
        READY_INTERVAL,
        || {
            let socket_path = socket_path.clone();
            async move {
                tokio::time::timeout(READY_PROBE_TIMEOUT, query_daemon_info(socket_path))
                    .await
                    .ok()
                    .flatten()
            }
        },
        tokio::time::sleep,
    );
    match tokio::time::timeout(READY_BUDGET, poll).await {
        Ok(Some(info)) => (Some(info), StartReadiness::Ready),
        Ok(None) | Err(_) => (None, StartReadiness::TimedOut),
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
    use std::cell::{Cell, RefCell};

    #[test]
    fn waits_only_when_a_fix_run_started_the_service() {
        assert!(should_await_start(true, false, true));
        assert!(
            !should_await_start(true, true, true),
            "--no-start never waits"
        );
        assert!(
            !should_await_start(true, false, false),
            "no start-capable repair"
        );
        assert!(!should_await_start(false, false, false), "report-only run");
    }

    #[tokio::test]
    async fn poll_returns_first_ready_value_and_sleeps_between_misses() {
        let calls = Cell::new(0u32);
        let sleeps = RefCell::new(Vec::new());
        let result = poll_until_ready(
            40,
            Duration::from_millis(250),
            || {
                calls.set(calls.get() + 1);
                let n = calls.get();
                async move { (n == 3).then_some("ready") }
            },
            |d| {
                sleeps.borrow_mut().push(d);
                async {}
            },
        )
        .await;

        assert_eq!(result, Some("ready"));
        assert_eq!(calls.get(), 3);
        assert_eq!(*sleeps.borrow(), vec![Duration::from_millis(250); 2]);
    }

    #[tokio::test]
    async fn poll_gives_up_after_the_attempt_bound() {
        let calls = Cell::new(0u32);
        let sleeps = Cell::new(0u32);
        let result: Option<()> = poll_until_ready(
            5,
            Duration::from_millis(250),
            || {
                calls.set(calls.get() + 1);
                async { None }
            },
            |_| {
                sleeps.set(sleeps.get() + 1);
                async {}
            },
        )
        .await;

        assert_eq!(result, None);
        assert_eq!(calls.get(), 5);
        assert_eq!(sleeps.get(), 4, "no sleep after the last probe");
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
