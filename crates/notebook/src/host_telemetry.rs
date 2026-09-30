//! App-lifetime ownership for the first-party notebook surface, independent of execution.

use std::{collections::HashSet, future::Future, path::PathBuf, time::Duration};

use runtimed_client::telemetry::{
    HostTelemetryOptions, HostTelemetrySource, TelemetryRegistration,
};
use tokio::sync::watch;

const RETRY_INTERVAL: Duration = Duration::from_secs(30);
const IO_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
struct Activity {
    notebooks: HashSet<String>,
    started: bool,
    legacy_startup: bool,
    // Preserve the last-window boundary when watch coalesces a close and reopen.
    closed_epoch: u64,
}

/// Only successful notebook window builds enter this set. Reservations, duplicate
/// opens, onboarding, and settings windows do not establish an active surface.
pub(crate) struct AppHostTelemetry(watch::Sender<Activity>);

impl Default for AppHostTelemetry {
    fn default() -> Self {
        Self(watch::channel(Activity::default()).0)
    }
}

impl AppHostTelemetry {
    pub(crate) fn spawn(&self) {
        let activity = self.0.subscribe();
        tauri::async_runtime::spawn(run(
            RuntimeClient(runt_workspace::default_socket_path()),
            activity,
        ));
    }

    pub(crate) fn startup_finished(&self, daemon_available: bool) {
        self.0.send_modify(|activity| {
            activity.started = true;
            activity.legacy_startup = daemon_available;
        });
    }

    pub(crate) fn notebook_opened(&self, label: &str) {
        self.0
            .send_if_modified(|activity| activity.notebooks.insert(label.to_owned()));
    }

    pub(crate) fn window_destroyed(&self, label: &str) {
        self.0.send_if_modified(|activity| {
            if !activity.notebooks.remove(label) {
                return false;
            }
            if activity.notebooks.is_empty() {
                activity.closed_epoch = activity.closed_epoch.wrapping_add(1);
            }
            true
        });
    }
}

trait Registration: Send + Sync {
    fn emission_enabled(&self) -> bool;
    fn update_permission(&self, allowed: bool) -> impl Future<Output = Result<(), ()>> + Send;
    fn close(&self) -> impl Future<Output = Result<(), ()>> + Send;
}

trait Client: Send + Sync {
    type Owner: Registration;
    fn enabled(&self) -> impl Future<Output = Result<bool, ()>> + Send;
    fn open(&self) -> impl Future<Output = Result<Option<Self::Owner>, ()>> + Send;
    fn legacy(&self) -> impl Future<Output = ()> + Send;
}

struct RuntimeClient(PathBuf);

impl Client for RuntimeClient {
    type Owner = TelemetryRegistration;

    async fn enabled(&self) -> Result<bool, ()> {
        let info = runtimed_client::client::PoolClient::new(self.0.clone())
            .daemon_info()
            .await
            .map_err(|_| ())?;
        Ok(info.host_telemetry && info.host_telemetry_enabled)
    }

    async fn open(&self) -> Result<Option<Self::Owner>, ()> {
        TelemetryRegistration::open(
            &self.0,
            HostTelemetryOptions {
                host_id: "nteract".into(),
                source: HostTelemetrySource::App,
                // The daemon applies live onboarding, consent, and global permission.
                // Start denied so a window closed during negotiation cannot grant.
                allowed: false,
            },
        )
        .await
        .map_err(|_| ())
    }

    async fn legacy(&self) {
        nteract_telemetry::telemetry_once("app", "telemetry_last_app_ping_at").await;
    }
}

impl Registration for TelemetryRegistration {
    fn emission_enabled(&self) -> bool {
        self.emission_enabled()
    }

    async fn update_permission(&self, allowed: bool) -> Result<(), ()> {
        self.update_permission(allowed).await.map_err(|_| ())
    }

    async fn close(&self) -> Result<(), ()> {
        self.close().await.map_err(|_| ())
    }
}

#[derive(Default, PartialEq, Debug)]
enum Mode {
    #[default]
    Undecided,
    Legacy,
    Attributed,
}

#[derive(Default)]
struct Coordinator<O> {
    mode: Mode,
    owner: Option<O>,
    closed_epoch: u64,
}

async fn bounded<T>(operation: impl Future<Output = Result<T, ()>>) -> Result<T, ()> {
    tokio::time::timeout(IO_TIMEOUT, operation)
        .await
        .map_err(|_| ())?
}

async fn wait_for_last_close(mut activity: watch::Receiver<Activity>, closed_epoch: u64) {
    loop {
        if activity.borrow().notebooks.is_empty() || activity.borrow().closed_epoch != closed_epoch
        {
            return;
        }
        if activity.changed().await.is_err() {
            return;
        }
    }
}

impl<O: Registration> Coordinator<O> {
    async fn close(&mut self) {
        if let Some(owner) = self.owner.take() {
            // Drop also terminates the transport on timeout or disconnect. Remote
            // revocation then depends on EOF or the daemon's bounded lease expiry.
            if bounded(owner.close()).await.is_err() {
                log::debug!("[host-telemetry] Owner close was not acknowledged");
            }
        }
    }

    async fn reconcile(
        &mut self,
        client: &impl Client<Owner = O>,
        activity: &watch::Receiver<Activity>,
    ) {
        if !activity.borrow().started {
            return;
        }
        if self.mode == Mode::Undecided {
            let Ok(enabled) = bounded(client.enabled()).await else {
                return;
            };
            // Mode is sticky for this process: a daemon upgrade must not add an
            // attributed heartbeat after this app already chose the legacy path.
            self.mode = if enabled {
                Mode::Attributed
            } else {
                Mode::Legacy
            };
            if self.mode == Mode::Legacy && activity.borrow().legacy_startup {
                client.legacy().await;
            }
        }
        if self.mode == Mode::Legacy {
            return;
        }
        let closed_epoch = activity.borrow().closed_epoch;
        if self.closed_epoch != closed_epoch {
            self.close().await;
            self.closed_epoch = closed_epoch;
        }
        if activity.borrow().notebooks.is_empty()
            || activity.borrow().closed_epoch != self.closed_epoch
        {
            self.close().await;
            return;
        }
        if self.owner.is_none() {
            // Conflicts are failures, never a request to replace another owner.
            self.owner = bounded(client.open()).await.ok().flatten();
        }
        if activity.borrow().notebooks.is_empty()
            || activity.borrow().closed_epoch != self.closed_epoch
        {
            self.close().await;
            return;
        }
        if let Some(owner) = &self.owner {
            if !owner.emission_enabled() {
                self.close().await;
                return;
            }
            // Renewing permission also detects a lost connection. A replacement
            // is opened only on a later reconciliation using current activity.
            let result = tokio::select! {
                biased;
                _ = wait_for_last_close(activity.clone(), self.closed_epoch) => None,
                result = bounded(owner.update_permission(true)) => Some(result),
            };
            if result.is_none() {
                // Canceling the caller future alone leaves a queued grant alive.
                // Drop aborts the socket task rather than queuing close behind
                // the grant. The daemon fences the owner on EOF/lease expiry.
                self.owner = None;
                return;
            }
            if result == Some(Err(())) {
                self.close().await;
                return;
            }
        }
        if activity.borrow().notebooks.is_empty()
            || activity.borrow().closed_epoch != self.closed_epoch
        {
            self.close().await;
        }
    }
}

async fn run(client: impl Client, mut activity: watch::Receiver<Activity>) {
    let mut coordinator = Coordinator {
        mode: Mode::Undecided,
        owner: None,
        closed_epoch: 0,
    };
    let mut retry = tokio::time::interval(RETRY_INTERVAL);
    retry.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {
            biased;
            changed = activity.changed() => {
                if changed.is_err() {
                    coordinator.close().await;
                    return;
                }
            }
            _ = retry.tick() => {}
        }
        coordinator.reconcile(&client, &activity).await;
        if coordinator.mode == Mode::Legacy {
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    struct FakeState {
        enabled: bool,
        conflict: bool,
        disconnected: bool,
        close_during_open: Option<watch::Sender<Activity>>,
        pending_grant: Option<Arc<tokio::sync::Notify>>,
        calls: Vec<&'static str>,
    }

    #[derive(Clone)]
    struct FakeClient(Arc<Mutex<FakeState>>);

    struct FakeOwner(FakeClient);

    impl Client for FakeClient {
        type Owner = FakeOwner;

        async fn enabled(&self) -> Result<bool, ()> {
            Ok(self.0.lock().unwrap().enabled)
        }

        async fn open(&self) -> Result<Option<FakeOwner>, ()> {
            let mut state = self.0.lock().unwrap();
            state.calls.push("open-denied");
            if state.conflict {
                return Err(());
            }
            if let Some(activity) = state.close_during_open.take() {
                activity.send_modify(|value| value.notebooks.clear());
            }
            Ok(Some(FakeOwner(self.clone())))
        }

        async fn legacy(&self) {
            self.0.lock().unwrap().calls.push("legacy");
        }
    }

    impl Registration for FakeOwner {
        fn emission_enabled(&self) -> bool {
            self.0 .0.lock().unwrap().enabled
        }

        async fn update_permission(&self, allowed: bool) -> Result<(), ()> {
            assert!(allowed);
            let pending = { self.0 .0.lock().unwrap().pending_grant.clone() };
            if let Some(started) = pending {
                started.notify_one();
                std::future::pending::<()>().await;
            }
            let mut state = self.0 .0.lock().unwrap();
            if state.disconnected {
                state.calls.push("disconnected");
                Err(())
            } else {
                state.calls.push("grant");
                Ok(())
            }
        }

        async fn close(&self) -> Result<(), ()> {
            self.0 .0.lock().unwrap().calls.push("close");
            Ok(())
        }
    }

    impl Drop for FakeOwner {
        fn drop(&mut self) {
            let mut state = self.0 .0.lock().unwrap();
            if state.pending_grant.is_some() {
                state.calls.push("abort-transport");
            }
        }
    }

    fn fixture() -> (
        AppHostTelemetry,
        watch::Receiver<Activity>,
        FakeClient,
        Coordinator<FakeOwner>,
    ) {
        let app = AppHostTelemetry::default();
        app.startup_finished(true);
        let receiver = app.0.subscribe();
        let client = FakeClient(Arc::new(Mutex::new(FakeState {
            enabled: true,
            conflict: false,
            disconnected: false,
            close_during_open: None,
            pending_grant: None,
            calls: vec![],
        })));
        (
            app,
            receiver,
            client,
            Coordinator {
                mode: Mode::Undecided,
                owner: None,
                closed_epoch: 0,
            },
        )
    }

    fn calls(client: &FakeClient) -> Vec<&'static str> {
        client.0.lock().unwrap().calls.clone()
    }

    #[tokio::test]
    async fn duplicate_opens_and_multiple_windows_share_one_owner() {
        let (app, activity, client, mut coordinator) = fixture();
        app.notebook_opened("notebook-a");
        app.notebook_opened("notebook-a");
        app.notebook_opened("notebook-b");
        coordinator.reconcile(&client, &activity).await;
        app.window_destroyed("notebook-a");
        app.window_destroyed("notebook-a");
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(calls(&client), ["open-denied", "grant", "grant"]);
        app.window_destroyed("notebook-b");
        coordinator.reconcile(&client, &activity).await;
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(calls(&client), ["open-denied", "grant", "grant", "close"]);
        app.notebook_opened("notebook-c");
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(&calls(&client)[4..], ["open-denied", "grant"]);
    }

    #[tokio::test]
    async fn no_notebooks_never_registers_including_auxiliary_window_events() {
        let (app, activity, client, mut coordinator) = fixture();
        coordinator.reconcile(&client, &activity).await;
        for label in ["onboarding", "settings", "diagnostics"] {
            app.window_destroyed(label);
            coordinator.reconcile(&client, &activity).await;
        }
        assert!(calls(&client).is_empty());
    }

    #[tokio::test]
    async fn closing_during_registration_never_grants_stale_activity() {
        let (app, activity, client, mut coordinator) = fixture();
        app.notebook_opened("notebook-a");
        client.0.lock().unwrap().close_during_open = Some(app.0.clone());
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(calls(&client), ["open-denied", "close"]);
        assert!(coordinator.owner.is_none());
    }

    #[tokio::test]
    async fn reconnect_rechecks_current_activity_and_conflicts_never_take_over() {
        let (app, activity, client, mut coordinator) = fixture();
        app.notebook_opened("notebook-a");
        client.0.lock().unwrap().conflict = true;
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(calls(&client), ["open-denied"]);
        client.0.lock().unwrap().conflict = false;
        coordinator.reconcile(&client, &activity).await;
        client.0.lock().unwrap().disconnected = true;
        coordinator.reconcile(&client, &activity).await;
        app.window_destroyed("notebook-a");
        client.0.lock().unwrap().disconnected = false;
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(
            calls(&client),
            [
                "open-denied",
                "open-denied",
                "grant",
                "disconnected",
                "close"
            ]
        );
        app.notebook_opened("notebook-b");
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(&calls(&client)[5..], ["open-denied", "grant"]);
    }

    #[tokio::test]
    async fn disabled_capability_keeps_legacy_once_without_later_attribution() {
        let (app, activity, client, mut coordinator) = fixture();
        client.0.lock().unwrap().enabled = false;
        // The legacy startup attempt is preserved even without notebook windows.
        coordinator.reconcile(&client, &activity).await;
        client.0.lock().unwrap().enabled = true;
        app.notebook_opened("notebook-a");
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(calls(&client), ["legacy"]);
    }

    #[tokio::test]
    async fn attributed_mode_never_falls_back_to_legacy_after_restart() {
        let (app, activity, client, mut coordinator) = fixture();
        app.notebook_opened("notebook-a");
        coordinator.reconcile(&client, &activity).await;
        client.0.lock().unwrap().disconnected = true;
        coordinator.reconcile(&client, &activity).await;
        {
            let mut state = client.0.lock().unwrap();
            state.enabled = false;
            state.disconnected = false;
        }
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(
            calls(&client),
            [
                "open-denied",
                "grant",
                "disconnected",
                "close",
                "open-denied",
                "close"
            ]
        );
    }

    #[tokio::test]
    async fn failed_startup_does_not_add_a_late_legacy_ping() {
        let (app, activity, client, mut coordinator) = fixture();
        app.startup_finished(false);
        client.0.lock().unwrap().enabled = false;
        coordinator.reconcile(&client, &activity).await;
        assert!(calls(&client).is_empty());
    }

    #[tokio::test]
    async fn coalesced_last_close_and_reopen_replaces_the_owner() {
        let (app, activity, client, mut coordinator) = fixture();
        app.notebook_opened("notebook-a");
        coordinator.reconcile(&client, &activity).await;
        app.window_destroyed("notebook-a");
        app.notebook_opened("notebook-a");
        coordinator.reconcile(&client, &activity).await;
        assert_eq!(
            calls(&client),
            ["open-denied", "grant", "close", "open-denied", "grant"]
        );
    }

    #[tokio::test]
    async fn last_close_aborts_a_pending_grant_without_waiting_for_ack() {
        let (app, activity, client, mut coordinator) = fixture();
        app.notebook_opened("notebook-a");
        let started = Arc::new(tokio::sync::Notify::new());
        client.0.lock().unwrap().pending_grant = Some(started.clone());
        let close_window = async {
            started.notified().await;
            app.window_destroyed("notebook-a");
            app.notebook_opened("notebook-b");
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            tokio::join!(coordinator.reconcile(&client, &activity), close_window);
        })
        .await
        .expect("last close must interrupt the pending grant");
        assert_eq!(calls(&client), ["open-denied", "abort-transport"]);
        assert!(coordinator.owner.is_none());
    }
}
