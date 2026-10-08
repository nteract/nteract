//! Real daemon fixtures run in a separate process: startup sweeps and settings
//! schema generation must use a temporary HOME/cache, not the developer's.
#![allow(dead_code)] // Each integration suite uses a different fixture subset.

use std::collections::{HashMap, VecDeque};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

use notebook_protocol::connection::{self, Handshake};
use runt_mcp::NteractMcp;
use runtimed::daemon::{Daemon, DaemonConfig};
use serde_json::{json, Value};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tokio::time::timeout;

use crate::support::{modern_meta, Wire, DEADLINE};

const CHILD_ROOT: &str = "NTERACT_ATTACHMENT_TEST_ROOT";

/// Opt-in daemon diagnostics for isolated stress probes; no logging dependency
/// or developer-wide tracing configuration is needed by the fixture.
struct FixtureTrace(std::sync::atomic::AtomicU64);
impl tracing::Subscriber for FixtureTrace {
    fn enabled(&self, metadata: &tracing::Metadata<'_>) -> bool {
        *metadata.level() <= tracing::Level::WARN
            || (metadata
                .target()
                .starts_with("runtimed::notebook_sync_server")
                && *metadata.level() <= tracing::Level::DEBUG)
    }
    fn new_span(&self, _: &tracing::span::Attributes<'_>) -> tracing::span::Id {
        tracing::span::Id::from_u64(self.0.fetch_add(1, std::sync::atomic::Ordering::Relaxed))
    }
    fn record(&self, _: &tracing::span::Id, _: &tracing::span::Record<'_>) {}
    fn record_follows_from(&self, _: &tracing::span::Id, _: &tracing::span::Id) {}
    fn event(&self, event: &tracing::Event<'_>) {
        eprintln!("{event:?}");
    }
    fn enter(&self, _: &tracing::span::Id) {}
    fn exit(&self, _: &tracing::span::Id) {}
}

/// Re-executed by Fixture with a fully isolated process environment. In a normal
/// test run this helper does nothing; it never starts a developer daemon.
#[test]
fn daemon_fixture_process() {
    let Some(root) = std::env::var_os(CHILD_ROOT).map(PathBuf::from) else {
        return;
    };
    assert_eq!(
        std::env::var_os("HOME"),
        Some(root.join("home").into_os_string())
    );
    if std::env::var("NTERACT_ATTACHMENT_TRACE").as_deref() == Ok("1") {
        tracing::subscriber::set_global_default(FixtureTrace(std::sync::atomic::AtomicU64::new(1)))
            .unwrap();
    }
    tokio::runtime::Runtime::new().unwrap().block_on(async {
        let config = DaemonConfig {
            socket_path: root.join("daemon.sock"),
            cache_dir: root.join("envs"),
            blob_store_dir: root.join("blobs"),
            execution_store_dir: root.join("executions"),
            notebook_docs_dir: root.join("notebook-docs"),
            trusted_packages_db_path: root.join("trusted.sqlite"),
            notebook_registry_db_path: root.join("registry.sqlite"),
            settings_json_path: Some(root.join("settings.json")),
            lock_dir: Some(root.join("locks")),
            file_claims_dir: Some(root.join("file-claims")),
            uv_pool_size: 0,
            conda_pool_size: 0,
            pixi_pool_size: 0,
            use_preferred_blob_port: false,
            // Opening untrusted fixtures must not launch a runtime. Even if
            // that contract regresses, never execute this test harness as one.
            runtime_agent_exe: Some(root.join("runtime-agent-must-not-launch")),
            ..Default::default()
        };
        Daemon::new_for_test(config).unwrap().run().await.unwrap();
    });
}

struct PendingOpen {
    reached: oneshot::Sender<()>,
    release: oneshot::Receiver<()>,
}
type Gates = Arc<Mutex<HashMap<String, VecDeque<PendingOpen>>>>;

struct SyncPeerClose {
    close: oneshot::Sender<()>,
    closed: oneshot::Receiver<()>,
}
type SyncPeers = Arc<Mutex<HashMap<String, VecDeque<SyncPeerClose>>>>;

pub struct OpenGate {
    reached: oneshot::Receiver<()>,
    release: oneshot::Sender<()>,
}
impl OpenGate {
    pub async fn reached(&mut self) {
        timeout(DEADLINE, &mut self.reached).await.unwrap().unwrap();
    }
    pub fn release(self) {
        self.release.send(()).expect("open still awaits its gate");
    }
}

/// Faults injected only into an isolated fixture shutdown.
#[derive(Clone, Copy)]
pub enum ShutdownFault {
    LostReply,
    Refusal,
    Disconnect,
    FailedChild,
}

pub struct Fixture {
    // Stop the child before TempDir drops, including startup failure paths.
    child: DaemonProcess,
    pub root: tempfile::TempDir,
    pub server: Arc<NteractMcp>,
    relay: JoinHandle<()>,
    gates: Gates,
    sync_gates: Gates,
    sync_peers: SyncPeers,
}
struct DaemonProcess(Child);
impl Drop for DaemonProcess {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
impl Fixture {
    pub async fn start() -> Self {
        Self::start_inner(false, true).await
    }
    pub async fn start_with_trace() -> Self {
        Self::start_inner(true, true).await
    }
    pub async fn start_direct_with_trace() -> Self {
        Self::start_inner(true, false).await
    }
    async fn start_inner(trace: bool, use_relay: bool) -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("home")).unwrap();
        // The UV warmer probes the tool before checking its disabled pool.
        // Satisfy that probe locally so it cannot download a tool on startup.
        std::fs::create_dir(root.path().join("bin")).unwrap();
        let uv = root.path().join("bin/uv");
        std::fs::write(&uv, "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then printf 'uv 0.10.8\\n'; exit 0; fi\nprintf '%s\\n' \"$*\" >> \"$NTERACT_TEST_TOOL_VIOLATIONS\"\nexit 1\n").unwrap();
        std::fs::set_permissions(&uv, std::fs::Permissions::from_mode(0o755)).unwrap();
        let log = std::fs::File::create(root.path().join("daemon.log")).unwrap();
        let child = DaemonProcess(
            Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "attachments::daemon_fixture_process",
                    "--nocapture",
                ])
                .env_clear()
                .env(
                    "PATH",
                    format!("{}:/usr/bin:/bin", root.path().join("bin").display()),
                )
                .env(
                    "NTERACT_TEST_TOOL_VIOLATIONS",
                    root.path().join("tool-violations"),
                )
                .env("HOME", root.path().join("home"))
                .env("XDG_CONFIG_HOME", root.path().join("home/config"))
                .env("XDG_CACHE_HOME", root.path().join("home/cache"))
                .env("XDG_DATA_HOME", root.path().join("home/data"))
                .env("TMPDIR", root.path())
                .env("RUNTIMED_DEV", "1")
                .env("RUNTIMED_WORKSPACE_PATH", root.path())
                .env(CHILD_ROOT, root.path())
                .env("NTERACT_ATTACHMENT_TRACE", if trace { "1" } else { "0" })
                .stdin(Stdio::null())
                .stdout(log.try_clone().unwrap())
                .stderr(log)
                .spawn()
                .unwrap(),
        );
        let daemon_path = root.path().join("daemon.sock");
        let pool = runtimed_client::client::PoolClient::new(daemon_path.clone());
        timeout(DEADLINE, async {
            while pool.ping().await.is_err() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "daemon startup failed: {}",
                std::fs::read_to_string(root.path().join("daemon.log")).unwrap()
            )
        });
        let relay_path = root.path().join("relay.sock");
        let listener = UnixListener::bind(&relay_path).unwrap();
        let gates: Gates = Arc::default();
        let relay_gates = gates.clone();
        let sync_gates: Gates = Arc::default();
        let relay_sync_gates = sync_gates.clone();
        let sync_peers: SyncPeers = Arc::default();
        let relay_sync_peers = sync_peers.clone();
        let relay = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut client, _) = accepted.unwrap();
                        let daemon_path = daemon_path.clone();
                        let gates = relay_gates.clone();
                        let sync_gates = relay_sync_gates.clone();
                        let sync_peers = relay_sync_peers.clone();
                        connections.spawn(async move {
                            // Clients send one preamble/handshake then receive
                            // bootstrap frames. Pool traffic never takes a gate.
                            if connection::recv_preamble(&mut client).await.is_err() { return; }
                            let Ok(Some(handshake)) = connection::recv_json_frame::<_, Handshake>(&mut client).await else { return; };
                            let gate = if let Handshake::OpenNotebook { path, .. } = &handshake {
                                gates.lock().unwrap().get_mut(path).and_then(VecDeque::pop_front)
                            } else { None };
                            if let Some(gate) = gate {
                                let _ = gate.reached.send(());
                                if gate.release.await.is_err() { return; }
                            }
                            let mut daemon = UnixStream::connect(daemon_path).await.unwrap();
                            connection::send_preamble(&mut daemon).await.unwrap();
                            connection::send_json_frame(&mut daemon, &handshake).await.unwrap();
                            if let Handshake::OpenNotebook { path, .. } = handshake {
                                let (close, mut requested) = oneshot::channel();
                                let (closed, stopped) = oneshot::channel();
                                sync_peers.lock().unwrap().entry(path.clone()).or_default()
                                    .push_back(SyncPeerClose { close, closed: stopped });
                                {
                                let (mut client_read, mut client_write) = client.split();
                                let (mut daemon_read, mut daemon_write) = daemon.split();
                                let outbound = async {
                                    while let Some(frame) = connection::recv_frame(&mut client_read).await? {
                                        if frame.first() == Some(&(connection::NotebookFrameType::AutomergeSync as u8)) {
                                            let gate = { sync_gates.lock().unwrap().get_mut(&path).and_then(VecDeque::pop_front) };
                                            if let Some(gate) = gate {
                                                let _ = gate.reached.send(());
                                                if gate.release.await.is_err() { return Ok::<(), std::io::Error>(()); }
                                            }
                                        }
                                        connection::send_frame(&mut daemon_write, &frame).await?;
                                    }
                                    Ok::<(), std::io::Error>(())
                                };
                                tokio::select! {
                                    _ = outbound => {},
                                    _ = tokio::io::copy(&mut daemon_read, &mut client_write) => {},
                                    _ = &mut requested => {},
                                }
                                }
                                // Only this path's notebook sync socket pair
                                // closes; PoolClient/metadata relays remain live.
                                drop(client);
                                drop(daemon);
                                let _ = closed.send(());
                            } else {
                                let _ = tokio::io::copy_bidirectional(&mut client, &mut daemon).await;
                            }
                        });
                    }
                    result = connections.join_next(), if !connections.is_empty() => {
                        result.unwrap().expect("relay connection panicked");
                    }
                }
            }
        });
        let server = Arc::new(
            NteractMcp::new_no_show(
                if use_relay {
                    relay_path
                } else {
                    root.path().join("daemon.sock")
                },
                None,
                Some(root.path().join("blobs")),
            )
            .with_execution_store_path(Some(root.path().join("executions"))),
        );
        Self {
            root,
            server,
            child,
            relay,
            gates,
            sync_gates,
            sync_peers,
        }
    }

    pub fn notebook(&self, name: &str, source: &str) -> PathBuf {
        let path = self.root.path().join(format!("{name}.ipynb"));
        // Unapproved dependency metadata blocks automatic kernel/environment
        // startup. All behavior here is notebook/sync behavior, not execution.
        let doc = json!({"nbformat":4,"nbformat_minor":5,"metadata":{
            "kernelspec":{"name":"python3","language":"python","display_name":"Python"},
            "runt":{"uv":{"dependencies":["nteract-attachment-test-unapproved"]}}
        },"cells":[{"id":"sentinel","cell_type":"markdown","source":source,"metadata":{}}]});
        std::fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
        path.canonicalize().unwrap()
    }

    pub fn gate(&self, path: &Path) -> OpenGate {
        Self::register_gate(&self.gates, path)
    }

    /// Hold the next real outbound NotebookDoc sync frame on this path.
    /// Register after a strict baseline receipt before issuing the mutation.
    pub fn sync_gate(&self, path: &Path) -> OpenGate {
        Self::register_gate(&self.sync_gates, path)
    }

    /// Close one currently live OpenNotebook relay connection for this path.
    /// Shared logical owners of that backing peer observe the same socket loss.
    pub async fn close_sync_peer(&self, path: &Path) {
        loop {
            let peer = {
                self.sync_peers
                    .lock()
                    .unwrap()
                    .get_mut(path.to_string_lossy().as_ref())
                    .and_then(VecDeque::pop_front)
            }
            .expect("a live sync peer must exist for the selected notebook path");
            if peer.close.send(()).is_ok() {
                timeout(DEADLINE, peer.closed).await.unwrap().unwrap();
                return;
            }
        }
    }

    fn register_gate(gates: &Gates, path: &Path) -> OpenGate {
        let (reached, rx) = oneshot::channel();
        let (tx, release) = oneshot::channel();
        gates
            .lock()
            .unwrap()
            .entry(path.to_string_lossy().into_owned())
            .or_default()
            .push_back(PendingOpen { reached, release });
        OpenGate {
            reached: rx,
            release: tx,
        }
    }

    pub async fn synced(&self, attachment: &str) {
        let handle = {
            let entries = self.server.attachments().read_entries();
            entries.get(attachment).unwrap().session.handle.clone()
        };
        timeout(DEADLINE, handle.confirm_notebook_sync())
            .await
            .unwrap()
            .unwrap();
    }

    pub fn wire(&self) -> Wire {
        Wire::start(self.server.clone())
    }

    /// Leave exactly `opens` admission slots free, including existing owners.
    /// Used with the default current-thread tokio test runtime to observe
    /// concurrent request admission without requiring another physical peer.
    pub fn reserve_all_but(
        &self,
        opens: usize,
    ) -> Vec<runt_mcp::attachments::AttachmentReservation> {
        let retained = self.server.attachments().read_entries().len();
        (0..runt_mcp::attachments::MAX_ATTACHMENTS - retained - opens)
            .map(|_| self.server.attachments().reserve().unwrap())
            .collect()
    }

    pub async fn wait_for_reserved_capacity(&self) {
        timeout(DEADLINE, async {
            loop {
                let remaining = self.server.attachments().reserve();
                if remaining.is_err() {
                    break;
                }
                // The probe must release the free slot before yielding to the
                // follower request on this current-thread runtime.
                drop(remaining);
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("both requests must reserve their admission slots");
    }

    pub async fn ready(&self, attachment: &str) {
        let handle = {
            let entries = self.server.attachments().read_entries();
            entries
                .get(attachment)
                .expect("acquired attachment")
                .session
                .handle
                .clone()
        };
        handle
            .await_session_ready_timeout(DEADLINE)
            .await
            .unwrap_or_else(|error| {
                panic!(
                    "attachment {attachment} not ready: {error}; {:?}; daemon: {}",
                    handle.status(),
                    std::fs::read_to_string(self.root.path().join("daemon.log")).unwrap()
                )
            });
    }

    pub async fn stop(self, wire: Wire) {
        let socket = self.root.path().join("daemon.sock");
        self.stop_on_socket(wire, socket).await;
    }

    /// Exercise shutdown failure handling against the actual owned process.
    pub async fn stop_with_shutdown_fault(mut self, wire: Wire, fault: ShutdownFault) {
        if matches!(fault, ShutdownFault::FailedChild) {
            self.child.0.kill().unwrap();
        }
        let socket = self.root.path().join("shutdown-relay.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        let daemon_socket = self.root.path().join("daemon.sock");
        let relay = tokio::spawn(async move {
            let (mut caller, _) = listener.accept().await.unwrap();
            connection::recv_preamble(&mut caller).await.unwrap();
            let handshake = connection::recv_json_frame::<_, Handshake>(&mut caller)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(handshake, Handshake::Pool));
            let request =
                connection::recv_json_frame::<_, runtimed_client::protocol::Request>(&mut caller)
                    .await
                    .unwrap()
                    .unwrap();
            assert!(matches!(
                request,
                runtimed_client::protocol::Request::Shutdown
            ));
            match fault {
                ShutdownFault::LostReply => {
                    let mut daemon = UnixStream::connect(daemon_socket).await.unwrap();
                    connection::send_preamble(&mut daemon).await.unwrap();
                    connection::send_json_frame(&mut daemon, &handshake)
                        .await
                        .unwrap();
                    connection::send_json_frame(&mut daemon, &request)
                        .await
                        .unwrap();
                    let reply =
                        connection::recv_json_frame::<_, runtimed_client::protocol::Response>(
                            &mut daemon,
                        )
                        .await
                        .unwrap();
                    if let Some(reply) = reply {
                        if !matches!(reply, runtimed_client::protocol::Response::ShuttingDown) {
                            // Preserve a real refusal instead of disguising it as EOF.
                            connection::send_json_frame(&mut caller, &reply)
                                .await
                                .unwrap();
                        }
                    }
                    // Discard only the successful acknowledgment; closing caller
                    // reproduces EOF during the daemon's actual shutdown.
                }
                ShutdownFault::Refusal => {
                    connection::send_json_frame(
                        &mut caller,
                        &runtimed_client::protocol::Response::Error {
                            message: "injected clean shutdown refusal".into(),
                        },
                    )
                    .await
                    .unwrap();
                }
                ShutdownFault::Disconnect | ShutdownFault::FailedChild => {
                    // No shutdown is forwarded: EOF must not count as a clean
                    // exit for either a still-running or a killed owned child.
                }
            }
        });
        self.stop_on_socket(wire, socket).await;
        timeout(DEADLINE, relay).await.unwrap().unwrap();
    }

    async fn stop_on_socket(mut self, wire: Wire, socket: PathBuf) {
        self.server.shutdown().await;
        assert!(wire.finish().await);
        let shutdown_reply = runtimed_client::client::PoolClient::new(socket)
            .shutdown()
            .await;
        if let Err(error) = &shutdown_reply {
            // Daemon::run can finish and drop the child runtime before the
            // shutdown handler writes its final reply. Only this EOF is
            // admissible, and only with the clean owned-process exit below.
            assert!(
                matches!(error, runtimed_client::client::ClientError::ProtocolError(message) if message == "connection closed"),
                "daemon shutdown request failed: {error}"
            );
        }
        timeout(DEADLINE, async {
            loop {
                if let Some(status) = self.child.0.try_wait().unwrap() {
                    assert!(
                        status.success(),
                        "daemon failed: {}",
                        std::fs::read_to_string(self.root.path().join("daemon.log")).unwrap()
                    );
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "daemon must stop cleanly after shutdown reply {shutdown_reply:?}; daemon: {}",
                std::fs::read_to_string(self.root.path().join("daemon.log")).unwrap()
            )
        });
        assert!(
            !self.root.path().join("tool-violations").exists(),
            "fixture tried to install/use an environment"
        );
        self.relay.abort();
        let _ = (&mut self.relay).await;
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.relay.abort();
    }
}

pub fn native_params(mut params: Value) -> Value {
    params["_meta"] = modern_meta("2026-07-28", false);
    params
}
pub fn tool_params(name: &str, arguments: Value, native: bool) -> Value {
    let params = json!({"name":name,"arguments":arguments});
    if native {
        native_params(params)
    } else {
        params
    }
}
pub fn result(response: &Value) -> &Value {
    assert!(response.get("error").is_none(), "{response}");
    let result = &response["result"];
    assert_ne!(result["isError"], true, "{response}");
    result
}
pub fn payload(response: &Value) -> Value {
    let result = result(response);
    result.get("structuredContent").cloned().unwrap_or_else(|| {
        serde_json::from_str(result["content"][0]["text"].as_str().unwrap()).unwrap()
    })
}
pub async fn open(wire: &mut Wire, id: u64, path: &Path, native: bool) -> String {
    let response = wire
        .request(
            id,
            "tools/call",
            Some(tool_params(
                "connect_notebook",
                json!({"path":path}),
                native,
            )),
        )
        .await;
    payload(&response)["notebook_handle"]
        .as_str()
        .unwrap()
        .into()
}
pub async fn read(wire: &mut Wire, id: u64, handle: &str, native: bool) -> Value {
    let uri = format!("nteract://sessions/{handle}/cells");
    let params = json!({"uri":uri});
    let response = wire
        .request(
            id,
            "resources/read",
            Some(if native {
                native_params(params)
            } else {
                params
            }),
        )
        .await;
    assert_eq!(result(&response)["contents"][0]["uri"], uri);
    serde_json::from_str(result(&response)["contents"][0]["text"].as_str().unwrap()).unwrap()
}
pub async fn mutate(wire: &mut Wire, id: u64, handle: &str, source: &str, native: bool) -> Value {
    wire.request(
        id,
        "tools/call",
        Some(tool_params(
            "set_cell",
            json!({"notebook_handle":handle,"cell_id":"sentinel","source":source}),
            native,
        )),
    )
    .await
}
pub async fn release(wire: &mut Wire, id: u64, handle: &str, native: bool) {
    let response = wire
        .request(
            id,
            "tools/call",
            Some(tool_params(
                "disconnect_notebook",
                json!({"notebook_handle":handle}),
                native,
            )),
        )
        .await;
    result(&response);
}
