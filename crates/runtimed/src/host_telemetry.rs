//! Daemon-owned permission leases and durable, installation-scoped throttles.

use nteract_telemetry::TelemetryPayload;
use runtimed_client::{
    protocol::{Request, Response},
    settings_doc::SyncedSettings,
    telemetry::{valid_host_id, HostTelemetrySource},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Weak,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::{mpsc, oneshot, Notify};

const MAX_REGISTRATIONS: usize = 64;
const MAX_THROTTLES: usize = 256;
const THROTTLE: u64 = 20 * 60 * 60;
const LEASE: Duration = Duration::from_secs(120);
type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

pub(crate) fn emission_enabled() -> bool {
    std::env::var("NTERACT_HOST_TELEMETRY_ENABLE").as_deref() == Ok("1")
        && !nteract_telemetry::is_telemetry_suppressed()
}

fn eligible(settings: &SyncedSettings, host: &str) -> bool {
    settings.telemetry_enabled
        && (host != "nteract"
            || (settings.onboarding_completed && settings.telemetry_consent_recorded))
}

trait Backend: Send + Sync + 'static {
    fn settings(&self, host: String) -> BoxFuture<Option<SyncedSettings>>;
    fn send(&self, payload: TelemetryPayload) -> BoxFuture<()>;
    fn enabled(&self) -> bool;
    fn now(&self) -> u64;
}

struct DaemonBackend(Weak<crate::daemon::Daemon>);
impl Backend for DaemonBackend {
    fn settings(&self, host: String) -> BoxFuture<Option<SyncedSettings>> {
        let daemon = self.0.clone();
        Box::pin(async move {
            let daemon = daemon.upgrade()?;
            // Canonical disk settings and the live projection both veto emission.
            let live = { daemon.settings.read().await.get_all() };
            let result = daemon
                .update_settings_json(|settings| {
                    if !host.is_empty()
                        && eligible(&live, &host)
                        && eligible(settings, &host)
                        && settings.install_id.is_empty()
                    {
                        settings.install_id = uuid::Uuid::new_v4().to_string();
                    }
                })
                .await
                .ok()?;
            let mut settings = result.settings;
            let live = { daemon.settings.read().await.get_all() };
            settings.telemetry_enabled &= live.telemetry_enabled;
            settings.onboarding_completed &= live.onboarding_completed;
            settings.telemetry_consent_recorded &= live.telemetry_consent_recorded;
            Some(settings)
        })
    }
    fn send(&self, payload: TelemetryPayload) -> BoxFuture<()> {
        Box::pin(async move {
            if let Ok(client) = reqwest::Client::builder()
                .timeout(Duration::from_secs(3))
                .build()
            {
                if let Err(error) = nteract_telemetry::send_telemetry(&client, &payload).await {
                    tracing::debug!("[host-telemetry] send failed: {error}");
                }
            }
        })
    }
    fn enabled(&self) -> bool {
        emission_enabled()
    }
    fn now(&self) -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
    }
}

#[derive(Default, Serialize, Deserialize)]
struct Throttles {
    install_id: String,
    entries: HashMap<String, u64>,
}

impl Throttles {
    fn load(path: &Path) -> std::io::Result<Self> {
        match std::fs::read(path) {
            Ok(bytes) if bytes.len() <= 65536 => {
                let state: Self = serde_json::from_slice(&bytes)?;
                if state.entries.len() > MAX_THROTTLES {
                    return Err(std::io::Error::other("too many host throttle entries"));
                }
                Ok(state)
            }
            Ok(_) => Err(std::io::Error::other("host throttle file too large")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(error) => Err(error),
        }
    }
    fn save(&self, path: &Path) -> std::io::Result<()> {
        // Replace the whole current epoch. Never preserve an old ID in a backup.
        let temporary = path.with_extension("json.tmp");
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temporary)?;
        use std::io::Write;
        file.write_all(&serde_json::to_vec(self)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, path)?;
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            std::fs::File::open(parent)?.sync_all()?;
        }
        Ok(())
    }
}

struct Registration {
    owner: uuid::Uuid,
    host: String,
    source: HostTelemetrySource,
    allowed: bool,
    alive: Arc<AtomicBool>,
    expires: tokio::time::Instant,
}
struct Command {
    owner: uuid::Uuid,
    alive: Arc<AtomicBool>,
    request: Request,
    reply: oneshot::Sender<Response>,
}

pub(crate) struct HostTelemetry {
    commands: mpsc::Sender<Command>,
    changed: Arc<Notify>,
}

impl HostTelemetry {
    pub(crate) fn start(daemon: Weak<crate::daemon::Daemon>, settings_path: PathBuf) -> Self {
        Self::spawn(
            Arc::new(DaemonBackend(daemon)),
            settings_path.with_file_name("host-telemetry.json"),
        )
    }
    fn spawn(backend: Arc<dyn Backend>, path: PathBuf) -> Self {
        let (commands, rx) = mpsc::channel(64);
        let changed = Arc::new(Notify::new());
        tokio::spawn(run(backend, path, rx, changed.clone()));
        Self { commands, changed }
    }
    pub(crate) fn connection(&self) -> HostConnection {
        HostConnection {
            owner: uuid::Uuid::new_v4(),
            alive: Arc::new(AtomicBool::new(true)),
            commands: self.commands.clone(),
            changed: self.changed.clone(),
            registered: false,
        }
    }
}

pub(crate) struct HostConnection {
    owner: uuid::Uuid,
    alive: Arc<AtomicBool>,
    commands: mpsc::Sender<Command>,
    changed: Arc<Notify>,
    registered: bool,
}

impl HostConnection {
    pub(crate) async fn request(&mut self, request: Request) -> Response {
        if matches!(request, Request::RegisterHostTelemetry { .. }) {
            if self.registered {
                return error("connection already registered; open a new connection");
            }
            self.registered = true;
        }
        let (reply, result) = oneshot::channel();
        if self
            .commands
            .send(Command {
                owner: self.owner,
                alive: self.alive.clone(),
                request,
                reply,
            })
            .await
            .is_err()
        {
            return error("host telemetry coordinator unavailable");
        }
        result
            .await
            .unwrap_or_else(|_| error("host telemetry coordinator unavailable"))
    }
}
impl Drop for HostConnection {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.changed.notify_one();
    }
}
fn error(message: &str) -> Response {
    Response::Error {
        message: message.into(),
    }
}

async fn run(
    backend: Arc<dyn Backend>,
    path: PathBuf,
    mut commands: mpsc::Receiver<Command>,
    changed: Arc<Notify>,
) {
    let mut registrations: HashMap<String, Registration> = HashMap::new();
    let mut throttles = Throttles::load(&path).ok();
    let mut pending: Option<(uuid::Uuid, BoxFuture<()>)> = None;
    let mut preparing: Option<(Option<uuid::Uuid>, BoxFuture<Option<SyncedSettings>>)> = None;
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        registrations.retain(|_, r| {
            r.alive.load(Ordering::Acquire) && r.expires > tokio::time::Instant::now()
        });
        if pending.as_ref().is_some_and(|(owner, _)| {
            !registrations
                .values()
                .any(|r| r.owner == *owner && r.allowed)
        }) {
            pending = None;
        }
        if preparing.as_ref().is_some_and(|(owner, _)| {
            owner.is_some_and(|owner| {
                !registrations
                    .values()
                    .any(|r| r.owner == owner && r.allowed)
            })
        }) {
            preparing = None;
        }
        tokio::select! {
            biased;
            command = commands.recv() => {
                let Some(command) = command else { break; };
                registrations.retain(|_, r| r.alive.load(Ordering::Acquire) && r.expires > tokio::time::Instant::now());
                let response = match command.request {
                    Request::RegisterHostTelemetry { host_id, source, allowed } => {
                        let key = format!("{host_id}/{}", source.as_str());
                        if !valid_host_id(&host_id) { error("invalid host_id") }
                        else if registrations.contains_key(&key) { error("host/source already has an active owner") }
                        else if registrations.len() >= MAX_REGISTRATIONS { error("host registration limit reached") }
                        else {
                            registrations.insert(key, Registration { owner: command.owner, host: host_id, source, allowed,
                                alive: command.alive, expires: tokio::time::Instant::now() + LEASE });
                            Response::HostTelemetryAck
                        }
                    }
                    request => {
                        if let Some(key) = registrations.iter().find(|(_, r)| r.owner == command.owner).map(|(key, _)| key.clone()) {
                            match request {
                                Request::CloseHostTelemetry => { registrations.remove(&key); }
                                Request::UpdateHostTelemetryPermission { allowed } => {
                                    if let Some(r) = registrations.get_mut(&key) { r.allowed = allowed; r.expires = tokio::time::Instant::now() + LEASE; }
                                }
                                Request::RenewHostTelemetry => { if let Some(r) = registrations.get_mut(&key) { r.expires = tokio::time::Instant::now() + LEASE; } }
                                _ => {}
                            }
                            Response::HostTelemetryAck
                        } else { error("host telemetry owner is absent or expired; register on a new connection") }
                    }
                };
                // Dropping the unspawned send future fences queued work before ACK.
                if pending.as_ref().is_some_and(|(owner, _)| !registrations.values().any(|r| r.owner == *owner && r.allowed)) { pending = None; }
                if preparing.as_ref().is_some_and(|(owner, _)| owner.is_some_and(|owner| !registrations.values().any(|r| r.owner == owner && r.allowed))) { preparing = None; }
                let _ = command.reply.send(response);
            }
            _ = changed.notified() => {}
            _ = tick.tick() => {
                // Suppressed dev daemons share the settings namespace but never write throttles.
                if !backend.enabled() { pending = None; preparing = None; continue; }
                if preparing.is_none() && throttles.is_some() {
                    preparing = Some((None, backend.settings(String::new())));
                }
            }
            result = async {
                if let Some((owner, future)) = preparing.as_mut() { (*owner, future.await) }
                else { std::future::pending().await }
            } => {
                preparing = None;
                if !backend.enabled() { pending = None; continue; }
                let (owner, Some(settings)) = result else { pending = None; continue; };
                let Some(state) = throttles.as_mut() else { continue; };
                if state.install_id != settings.install_id {
                    pending = None;
                    state.install_id = settings.install_id.clone();
                    state.entries.clear();
                    if state.save(&path).is_err() { throttles = None; continue; }
                }
                if !settings.telemetry_enabled { pending = None; continue; }
                if pending.is_some() { continue; }
                let now = backend.now();
                state.entries.retain(|_, last| now.saturating_sub(*last) < THROTTLE);
                if state.entries.len() >= MAX_THROTTLES { continue; }
                let candidate = registrations.iter().find(|(key, r)| {
                    r.allowed && r.alive.load(Ordering::Acquire) && r.expires > tokio::time::Instant::now()
                        && eligible(&settings, &r.host) && !state.entries.contains_key(*key)
                        && owner.is_none_or(|owner| r.owner == owner)
                });
                if let Some((key, registration)) = candidate {
                    if owner.is_none() {
                        preparing = Some((Some(registration.owner), backend.settings(registration.host.clone())));
                        continue;
                    }
                    if settings.install_id.is_empty() { continue; }
                    let (Some(platform), Some(arch)) = (nteract_telemetry::detect_platform(), nteract_telemetry::detect_arch()) else { continue; };
                    state.entries.insert(key.clone(), now);
                    if state.save(&path).is_err() { throttles = None; continue; }
                    let payload = TelemetryPayload { host_id: Some(registration.host.clone()), install_id: settings.install_id,
                        source: registration.source.as_str().into(), version: env!("CARGO_PKG_VERSION").into(),
                        channel: nteract_telemetry::detect_channel().into(), platform: platform.into(), arch: arch.into() };
                    let backend = backend.clone();
                    let host = registration.host.clone();
                    let alive = registration.alive.clone();
                    let expires = registration.expires;
                    pending = Some((registration.owner, Box::pin(async move {
                        // Re-read after persistence and before starting HTTP; rotated IDs never replay.
                        if let Some(current) = backend.settings(host.clone()).await {
                            if alive.load(Ordering::Acquire) && tokio::time::Instant::now() < expires && backend.enabled() && eligible(&current, &host) && current.install_id == payload.install_id {
                                backend.send(payload).await;
                            }
                        }
                    })));
                }
            }
            _ = async { if let Some((_, future)) = pending.as_mut() { future.await; } else { std::future::pending::<()>().await; } } => { pending = None; }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicU64, Mutex};

    struct Fake {
        settings: Mutex<SyncedSettings>,
        sent: Arc<Mutex<Vec<TelemetryPayload>>>,
        now: AtomicU64,
        enabled: AtomicBool,
        block: bool,
        block_settings: AtomicBool,
        settings_started: Arc<AtomicBool>,
        started: Arc<AtomicBool>,
        cancelled: Arc<AtomicBool>,
    }
    impl Fake {
        fn new(block: bool) -> Arc<Self> {
            Arc::new(Self {
                settings: Mutex::new(SyncedSettings {
                    install_id: "epoch-one".into(),
                    ..Default::default()
                }),
                sent: Arc::new(Mutex::new(vec![])),
                now: AtomicU64::new(100_000),
                enabled: AtomicBool::new(true),
                block,
                block_settings: AtomicBool::new(false),
                settings_started: Arc::new(AtomicBool::new(false)),
                started: Arc::new(AtomicBool::new(false)),
                cancelled: Arc::new(AtomicBool::new(false)),
            })
        }
    }
    impl Backend for Fake {
        fn settings(&self, host: String) -> BoxFuture<Option<SyncedSettings>> {
            let settings = self.settings.lock().unwrap().clone();
            let blocked = !host.is_empty() && self.block_settings.load(Ordering::SeqCst);
            let started = self.settings_started.clone();
            Box::pin(async move {
                if blocked {
                    started.store(true, Ordering::SeqCst);
                    std::future::pending::<()>().await;
                }
                Some(settings)
            })
        }
        fn enabled(&self) -> bool {
            self.enabled.load(Ordering::SeqCst)
        }
        fn now(&self) -> u64 {
            self.now.load(Ordering::SeqCst)
        }
        fn send(&self, payload: TelemetryPayload) -> BoxFuture<()> {
            let (sent, started, cancelled, block) = (
                self.sent.clone(),
                self.started.clone(),
                self.cancelled.clone(),
                self.block,
            );
            Box::pin(async move {
                struct Cancelled(Arc<AtomicBool>);
                impl Drop for Cancelled {
                    fn drop(&mut self) {
                        self.0.store(true, Ordering::SeqCst);
                    }
                }
                let _guard = Cancelled(cancelled);
                started.store(true, Ordering::SeqCst);
                if block {
                    std::future::pending::<()>().await;
                }
                sent.lock().unwrap().push(payload);
            })
        }
    }
    fn register(host: &str, allowed: bool) -> Request {
        Request::RegisterHostTelemetry {
            host_id: host.into(),
            source: HostTelemetrySource::App,
            allowed,
        }
    }
    fn ack(response: Response) {
        assert!(
            matches!(response, Response::HostTelemetryAck),
            "{response:?}"
        );
    }
    async fn tick() {
        tokio::time::advance(Duration::from_secs(1)).await;
        for _ in 0..8 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(start_paused = true)]
    async fn permissions_hosts_sources_rotation_and_restart_throttle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let fake = Fake::new(false);
        let actor = HostTelemetry::spawn(fake.clone(), path.clone());
        let mut denied = actor.connection();
        ack(denied.request(register("editor", false)).await);
        tick().await;
        assert!(fake.sent.lock().unwrap().is_empty());
        ack(denied
            .request(Request::UpdateHostTelemetryPermission { allowed: true })
            .await);
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
        let saved = Throttles::load(&path).unwrap();
        assert_eq!(saved.entries.len(), 1);
        assert!(!fake.settings.lock().unwrap().onboarding_completed);
        assert!(!fake.settings.lock().unwrap().telemetry_consent_recorded);
        let mut first_party = actor.connection();
        ack(first_party.request(register("nteract", true)).await);
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
        let mut mcp = actor.connection();
        ack(mcp
            .request(Request::RegisterHostTelemetry {
                host_id: "editor".into(),
                source: HostTelemetrySource::Mcp,
                allowed: true,
            })
            .await);
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 2);
        let mut other = actor.connection();
        ack(other.request(register("another-editor", true)).await);
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 3);
        drop(denied);
        drop(first_party);
        drop(mcp);
        drop(other);
        drop(actor);
        tokio::task::yield_now().await;
        let actor = HostTelemetry::spawn(fake.clone(), path.clone());
        let mut owner = actor.connection();
        ack(owner.request(register("editor", true)).await);
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 3);
        fake.settings.lock().unwrap().install_id = "epoch-two".into();
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 4);
        let saved = std::fs::read_to_string(&path).unwrap();
        assert!(!saved.contains("epoch-one"));
        assert!(saved.contains("epoch-two"));
        assert_eq!(Throttles::load(&path).unwrap().entries.len(), 1);
        ack(owner
            .request(Request::UpdateHostTelemetryPermission { allowed: false })
            .await);
        fake.settings.lock().unwrap().install_id = "epoch-three".into();
        tick().await;
        assert!(Throttles::load(&path).unwrap().entries.is_empty());
        assert_eq!(Throttles::load(&path).unwrap().install_id, "epoch-three");
    }

    #[tokio::test(start_paused = true)]
    async fn withdrawal_cancels_blocked_send_before_ack_and_fences_successor() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(true);
        let actor = HostTelemetry::spawn(fake.clone(), dir.path().join("host.json"));
        let mut owner = actor.connection();
        ack(owner.request(register("editor", true)).await);
        tick().await;
        assert!(fake.started.load(Ordering::SeqCst));
        let mut conflict = actor.connection();
        assert!(matches!(
            conflict.request(register("editor", true)).await,
            Response::Error { .. }
        ));
        ack(owner
            .request(Request::UpdateHostTelemetryPermission { allowed: false })
            .await);
        assert!(fake.cancelled.load(Ordering::SeqCst));
        assert!(fake.sent.lock().unwrap().is_empty());
        let mut denied_conflict = actor.connection();
        assert!(matches!(
            denied_conflict.request(register("editor", true)).await,
            Response::Error { .. }
        ));
        ack(owner.request(Request::CloseHostTelemetry).await);
        let mut successor = actor.connection();
        ack(successor.request(register("editor", false)).await);
        assert!(matches!(
            owner
                .request(Request::UpdateHostTelemetryPermission { allowed: true })
                .await,
            Response::Error { .. }
        ));
        assert!(matches!(
            owner.request(register("editor", true)).await,
            Response::Error { .. }
        ));
        ack(successor.request(Request::RenewHostTelemetry).await);
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_and_drop_remove_owner_and_never_auto_regrant() {
        let dir = tempfile::tempdir().unwrap();
        let actor = HostTelemetry::spawn(Fake::new(true), dir.path().join("host.json"));
        let mut old = actor.connection();
        ack(old.request(register("editor", false)).await);
        tokio::time::advance(LEASE).await;
        assert!(matches!(
            old.request(Request::RenewHostTelemetry).await,
            Response::Error { .. }
        ));
        let mut next = actor.connection();
        ack(next.request(register("editor", false)).await);
        drop(old);
        ack(next.request(Request::RenewHostTelemetry).await);
        drop(next);
        let mut last = actor.connection();
        ack(last.request(register("editor", false)).await);
    }

    #[tokio::test(start_paused = true)]
    async fn global_veto_rollout_and_persistence_failure_are_fail_closed() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(false);
        fake.enabled.store(false, Ordering::SeqCst);
        let actor = HostTelemetry::spawn(fake.clone(), dir.path().join("host.json"));
        let mut owner = actor.connection();
        ack(owner.request(register("editor", true)).await);
        tick().await;
        assert!(fake.sent.lock().unwrap().is_empty());
        fake.settings.lock().unwrap().telemetry_enabled = false;
        fake.enabled.store(true, Ordering::SeqCst);
        tick().await;
        assert!(fake.sent.lock().unwrap().is_empty());
        fake.settings.lock().unwrap().telemetry_enabled = true;
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
        let bad = HostTelemetry::spawn(fake.clone(), dir.path().join("absent").join("host.json"));
        let mut bad_owner = bad.connection();
        ack(bad_owner.request(register("different", true)).await);
        tick().await;
        assert_eq!(fake.sent.lock().unwrap().len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn registration_bound_and_invalid_hosts() {
        let dir = tempfile::tempdir().unwrap();
        let actor = HostTelemetry::spawn(Fake::new(false), dir.path().join("host.json"));
        let mut invalid = actor.connection();
        assert!(matches!(
            invalid.request(register("unknown", true)).await,
            Response::Error { .. }
        ));
        let mut owners = vec![];
        for index in 0..MAX_REGISTRATIONS {
            let mut owner = actor.connection();
            ack(owner
                .request(register(&format!("host-{index}"), false))
                .await);
            owners.push(owner);
        }
        let mut extra = actor.connection();
        assert!(matches!(
            extra.request(register("extra", false)).await,
            Response::Error { .. }
        ));
    }

    #[tokio::test(start_paused = true)]
    async fn slow_settings_never_block_withdrawal_or_reserve_throttle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let fake = Fake::new(false);
        fake.block_settings.store(true, Ordering::SeqCst);
        let actor = HostTelemetry::spawn(fake.clone(), path.clone());
        let mut owner = actor.connection();
        ack(owner.request(register("editor", true)).await);
        tick().await;
        assert!(fake.settings_started.load(Ordering::SeqCst));
        ack(tokio::time::timeout(
            Duration::from_millis(10),
            owner.request(Request::UpdateHostTelemetryPermission { allowed: false }),
        )
        .await
        .unwrap());
        assert!(Throttles::load(&path).unwrap().entries.is_empty());
        fake.block_settings.store(false, Ordering::SeqCst);
        tick().await;
        assert!(fake.sent.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn suppressed_actor_never_overwrites_shared_throttle() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        let state = Throttles {
            install_id: "epoch-old".into(),
            entries: HashMap::from([("editor/app".into(), 100_000)]),
        };
        state.save(&path).unwrap();
        let fake = Fake::new(false);
        fake.enabled.store(false, Ordering::SeqCst);
        let actor = HostTelemetry::spawn(fake.clone(), path.clone());
        let mut owner = actor.connection();
        ack(owner.request(register("editor", true)).await);
        tick().await;
        assert_eq!(Throttles::load(&path).unwrap().install_id, "epoch-old");
        assert_eq!(Throttles::load(&path).unwrap().entries.len(), 1);
    }

    #[test]
    fn first_party_consent_matrix_and_corrupt_throttle() {
        for enabled in [false, true] {
            for onboarding in [false, true] {
                for consent in [false, true] {
                    let settings = SyncedSettings {
                        telemetry_enabled: enabled,
                        onboarding_completed: onboarding,
                        telemetry_consent_recorded: consent,
                        ..Default::default()
                    };
                    assert_eq!(
                        eligible(&settings, "nteract"),
                        enabled && onboarding && consent
                    );
                    assert_eq!(eligible(&settings, "editor"), enabled);
                }
            }
        }
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("host.json");
        std::fs::write(&path, b"broken").unwrap();
        assert!(Throttles::load(&path).is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn throttle_future_timestamp_exact_boundary_and_failed_attempt() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(true);
        let path = dir.path().join("host.json");
        Throttles {
            install_id: "epoch-one".into(),
            entries: HashMap::from([("editor/app".into(), 100_010)]),
        }
        .save(&path)
        .unwrap();
        let actor = HostTelemetry::spawn(fake.clone(), path.clone());
        let mut owner = actor.connection();
        ack(owner.request(register("editor", true)).await);
        tick().await;
        assert!(!fake.started.load(Ordering::SeqCst));
        fake.now.store(100_010 + THROTTLE - 1, Ordering::SeqCst);
        tick().await;
        assert!(!fake.started.load(Ordering::SeqCst));
        fake.now.store(100_010 + THROTTLE, Ordering::SeqCst);
        tick().await;
        assert!(fake.started.load(Ordering::SeqCst));
        assert_eq!(
            Throttles::load(&path).unwrap().entries["editor/app"],
            100_010 + THROTTLE
        );
        ack(owner
            .request(Request::UpdateHostTelemetryPermission { allowed: false })
            .await);
        assert!(fake.cancelled.load(Ordering::SeqCst));
        fake.started.store(false, Ordering::SeqCst);
        ack(owner
            .request(Request::UpdateHostTelemetryPermission { allowed: true })
            .await);
        tick().await;
        assert!(!fake.started.load(Ordering::SeqCst));
    }
}
