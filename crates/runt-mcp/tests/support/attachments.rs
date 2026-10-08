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

pub struct Fixture {
    // Stop the child before TempDir drops, including startup failure paths.
    child: DaemonProcess,
    pub root: tempfile::TempDir,
    pub server: Arc<NteractMcp>,
    relay: JoinHandle<()>,
    gates: Gates,
    sync_gates: Gates,
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
        let relay = tokio::spawn(async move {
            let mut connections = tokio::task::JoinSet::new();
            loop {
                tokio::select! {
                    accepted = listener.accept() => {
                        let (mut client, _) = accepted.unwrap();
                        let daemon_path = daemon_path.clone();
                        let gates = relay_gates.clone();
                        let sync_gates = relay_sync_gates.clone();
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
                                }
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
            NteractMcp::new_no_show(relay_path, None, Some(root.path().join("blobs")))
                .with_execution_store_path(Some(root.path().join("executions"))),
        );
        Self {
            root,
            server,
            child,
            relay,
            gates,
            sync_gates,
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

    pub async fn stop(mut self, wire: Wire) {
        self.server.shutdown().await;
        assert!(wire.finish().await);
        runtimed_client::client::PoolClient::new(self.root.path().join("daemon.sock"))
            .shutdown()
            .await
            .unwrap();
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
        .expect("daemon must stop cleanly");
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
pub fn explicit_tool_params(name: &str, arguments: Value) -> Value {
    json!({"name":name,"arguments":arguments,"_meta":{"io.nteract/attachmentMode":"explicit"}})
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
