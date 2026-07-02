// Tests can use unwrap/expect freely - panics are acceptable in test code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use automerge::sync;
use futures::{SinkExt, StreamExt};
use notebook_doc::{NotebookDoc, TextEncoding};
use notebook_sync::connect::connect_open_hosted;
use notebook_wire::NotebookFrameType;
use runtime_doc::RuntimeStateDoc;
use runtimed::client::PoolClient;
use runtimed::daemon::{Daemon, DaemonConfig};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::time::sleep;
use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
use tokio_tungstenite::tungstenite::Message;

const DAEMON_READY_TIMEOUT: Duration = Duration::from_secs(20);
const SYNC_TIMEOUT: Duration = Duration::from_secs(10);
const CLOUD_ROOM_ACTOR: &str = "user:anaconda:kyle/host:room:1";

fn test_config(temp_dir: &TempDir) -> DaemonConfig {
    #[cfg(windows)]
    let socket_path = {
        let unique = temp_dir
            .path()
            .file_name()
            .unwrap_or_default()
            .to_string_lossy();
        PathBuf::from(format!(r"\\.\pipe\runtimed-test-{}", unique))
    };
    #[cfg(not(windows))]
    let socket_path = temp_dir.path().join("test-runtimed.sock");

    DaemonConfig {
        socket_path,
        cache_dir: temp_dir.path().join("envs"),
        blob_store_dir: temp_dir.path().join("blobs"),
        execution_store_dir: temp_dir.path().join("executions"),
        notebook_docs_dir: temp_dir.path().join("notebook-docs"),
        trusted_packages_db_path: temp_dir.path().join("trusted-packages.sqlite"),
        notebook_registry_db_path: temp_dir.path().join("notebook-registry.sqlite"),
        uv_pool_size: 0,
        conda_pool_size: 0,
        max_age_secs: 3600,
        lock_dir: Some(temp_dir.path().to_path_buf()),
        room_eviction_delay_ms: Some(50),
        use_preferred_blob_port: false,
        settings_json_path: Some(temp_dir.path().join("settings.json")),
        runtime_agent_exe: option_env!("CARGO_BIN_EXE_runtimed").map(PathBuf::from),
        ..Default::default()
    }
}

async fn wait_for_daemon(client: &PoolClient) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < DAEMON_READY_TIMEOUT {
        if client.ping().await.is_ok() {
            return true;
        }
        sleep(Duration::from_millis(50)).await;
    }
    false
}

async fn wait_for_handle_cell(
    handle: &notebook_sync::DocHandle,
    cell_id: &str,
    timeout: Duration,
) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        if handle.get_cells().iter().any(|cell| cell.id == cell_id) {
            return true;
        }
        sleep(Duration::from_millis(25)).await;
    }
    false
}

async fn wait_for_fake_room_cell(
    cells_rx: &mut watch::Receiver<Vec<String>>,
    cell_id: &str,
    timeout: Duration,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if cells_rx.borrow().iter().any(|id| id == cell_id) {
            return true;
        }
        let now = tokio::time::Instant::now();
        if now >= deadline {
            return false;
        }
        let remaining = deadline.saturating_duration_since(now);
        let _ = tokio::time::timeout(
            remaining.min(Duration::from_millis(100)),
            cells_rx.changed(),
        )
        .await;
    }
}

fn encode_ws_frame(frame_type: NotebookFrameType, payload: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(1 + payload.len());
    frame.push(frame_type as u8);
    frame.extend_from_slice(payload);
    frame
}

struct FakeCloudRoom {
    nb: NotebookDoc,
    rt: RuntimeStateDoc,
    nb_peer: sync::State,
    rt_peer: sync::State,
}

impl FakeCloudRoom {
    fn new() -> Self {
        let mut nb = NotebookDoc::bootstrap(TextEncoding::UnicodeCodePoint, CLOUD_ROOM_ACTOR);
        nb.add_cell(0, "remote-1", "code").unwrap();
        nb.update_source("remote-1", "print('from cloud')").unwrap();
        let rt = RuntimeStateDoc::try_new_with_actor(CLOUD_ROOM_ACTOR).unwrap();
        Self {
            nb,
            rt,
            nb_peer: sync::State::new(),
            rt_peer: sync::State::new(),
        }
    }
}

#[derive(Debug)]
struct HandshakeSeen {
    path: String,
    scope: Option<String>,
    token: Option<String>,
    user: Option<String>,
}

async fn serve_fake_cloud_room(
    listener: TcpListener,
    mut room: FakeCloudRoom,
    observed_cells: watch::Sender<Vec<String>>,
) {
    let (stream, _) = listener.accept().await.unwrap();
    let handshake_seen = Arc::new(Mutex::new(None));
    let callback_seen = handshake_seen.clone();
    let mut ws = tokio_tungstenite::accept_hdr_async(
        stream,
        move |request: &Request, response: Response| {
            let seen = HandshakeSeen {
                path: request.uri().path().to_string(),
                scope: request
                    .headers()
                    .get("x-scope")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                token: request
                    .headers()
                    .get("x-notebook-cloud-dev-token")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                user: request
                    .headers()
                    .get("x-user")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
            };
            *callback_seen.lock().unwrap() = Some(seen);
            Ok(response)
        },
    )
    .await
    .unwrap();

    let handshake = {
        let mut seen = handshake_seen.lock().unwrap();
        seen.take().expect("fake room should observe WS handshake")
    };
    assert_eq!(handshake.path, "/n/e2e-test/sync");
    assert_eq!(handshake.scope.as_deref(), Some("editor"));
    assert_eq!(handshake.token.as_deref(), Some("dev-secret"));
    assert_eq!(handshake.user.as_deref(), Some("kyle"));

    let ready = serde_json::to_vec(&serde_json::json!({
        "type": "cloud_room_ready",
        "actor_label": CLOUD_ROOM_ACTOR,
        "connection_scope": "editor",
    }))
    .unwrap();
    ws.send(Message::Binary(
        encode_ws_frame(NotebookFrameType::SessionControl, &ready).into(),
    ))
    .await
    .unwrap();

    if let Some(message) = room.nb.generate_sync_message(&mut room.nb_peer) {
        ws.send(Message::Binary(
            encode_ws_frame(NotebookFrameType::AutomergeSync, &message.encode()).into(),
        ))
        .await
        .unwrap();
    }
    if let Some(message) = room.rt.generate_sync_message(&mut room.rt_peer) {
        ws.send(Message::Binary(
            encode_ws_frame(NotebookFrameType::RuntimeStateSync, &message.encode()).into(),
        ))
        .await
        .unwrap();
    }

    while let Some(Ok(message)) = ws.next().await {
        let Message::Binary(data) = message else {
            continue;
        };
        let Some((&frame_type, payload)) = data.split_first() else {
            continue;
        };

        let mut replies = Vec::new();
        if frame_type == NotebookFrameType::AutomergeSync as u8 {
            let incoming = sync::Message::decode(payload).unwrap();
            room.nb
                .receive_sync_message(&mut room.nb_peer, incoming)
                .unwrap();
            let _ = observed_cells.send(room.nb.get_cell_ids());
            if let Some(message) = room.nb.generate_sync_message(&mut room.nb_peer) {
                replies.push(encode_ws_frame(
                    NotebookFrameType::AutomergeSync,
                    &message.encode(),
                ));
            }
        } else if frame_type == NotebookFrameType::RuntimeStateSync as u8 {
            let incoming = sync::Message::decode(payload).unwrap();
            room.rt
                .receive_sync_message_with_changes(&mut room.rt_peer, incoming)
                .unwrap();
            if let Some(message) = room.rt.generate_sync_message(&mut room.rt_peer) {
                replies.push(encode_ws_frame(
                    NotebookFrameType::RuntimeStateSync,
                    &message.encode(),
                ));
            }
        }

        for reply in replies {
            ws.send(Message::Binary(reply.into())).await.unwrap();
        }
    }
}

struct EnvGuard {
    key: &'static str,
    old_value: Option<std::ffi::OsString>,
}

impl EnvGuard {
    fn set(key: &'static str, value: impl AsRef<std::ffi::OsStr>) -> Self {
        let old_value = std::env::var_os(key);
        std::env::set_var(key, value);
        Self { key, old_value }
    }
}

impl Drop for EnvGuard {
    fn drop(&mut self) {
        match &self.old_value {
            Some(value) => std::env::set_var(self.key, value),
            None => std::env::remove_var(self.key),
        }
    }
}

#[tokio::test]
#[serial_test::serial]
async fn open_hosted_notebook_handshake_syncs_through_daemon_bridge() {
    let temp_dir = TempDir::new().unwrap();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let cloud_origin = format!("http://{addr}");
    let registry_path = temp_dir.path().join("cloud-domains.toml");
    std::fs::write(
        &registry_path,
        format!(
            r#"
default_domain = "{cloud_origin}"

[[domains]]
url = "{cloud_origin}"
operator = "agent:e2e"
credential = {{ kind = "dev-token-env", env = "NTERACT_E2E_HOSTED_DEV_TOKEN", user = "kyle" }}
"#
        ),
    )
    .unwrap();

    let _registry_env = EnvGuard::set("NTERACT_CLOUD_REGISTRY", &registry_path);
    let _token_env = EnvGuard::set("NTERACT_E2E_HOSTED_DEV_TOKEN", "dev-secret");

    let (cells_tx, mut cells_rx) = watch::channel(Vec::new());
    let server = tokio::spawn(serve_fake_cloud_room(
        listener,
        FakeCloudRoom::new(),
        cells_tx,
    ));

    let config = test_config(&temp_dir);
    let socket_path = config.socket_path.clone();
    let daemon = Daemon::new_for_test(config).unwrap();
    let daemon_task = tokio::spawn(async move {
        daemon.run().await.ok();
    });

    let client = PoolClient::new(socket_path.clone());
    assert!(
        wait_for_daemon(&client).await,
        "daemon did not become ready"
    );

    let result = connect_open_hosted(
        socket_path,
        &format!("{cloud_origin}/n/e2e-test"),
        Some("desktop:e2e".to_string()),
    )
    .await
    .unwrap();

    let actor_label = result
        .info
        .capabilities
        .actor_label
        .as_deref()
        .expect("hosted open should return actor label");
    assert!(
        actor_label.starts_with("user:anaconda:kyle/"),
        "actor label should use hosted principal: {actor_label}"
    );
    assert!(
        actor_label.contains("desktop:e2e"),
        "actor label should include local operator: {actor_label}"
    );
    assert!(result.info.ephemeral);

    assert!(
        wait_for_handle_cell(&result.handle, "remote-1", SYNC_TIMEOUT).await,
        "hosted cell did not reach DocHandle within {SYNC_TIMEOUT:?}: {:?}",
        result.handle.get_cells()
    );

    result
        .handle
        .add_cell_with_source("local-1", "code", Some("remote-1"), "x = 1")
        .unwrap();
    result.handle.confirm_sync().await.unwrap();

    assert!(
        wait_for_fake_room_cell(&mut cells_rx, "local-1", SYNC_TIMEOUT).await,
        "local cell did not reach fake hosted room within {SYNC_TIMEOUT:?}; observed {:?}",
        cells_rx.borrow().clone()
    );

    drop(result.handle);
    daemon_task.abort();
    server.abort();
}
