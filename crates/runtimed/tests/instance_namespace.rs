// Tests can use unwrap/expect freely - panics are acceptable in test code.
#![allow(clippy::unwrap_used, clippy::expect_used)]

//! Process-level verification for host-owned daemon instances.
//!
//! This intentionally launches the real `runtimed` binary. In-process
//! `DaemonConfig` tests can inject separate lock directories without proving
//! that the production environment/path contract isolates a whole daemon.

use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use runtimed::client::PoolClient;
use runtimed_client::client::DaemonInfo;

const READY_TIMEOUT: Duration = Duration::from_secs(15);

fn runtimed_binary() -> PathBuf {
    match option_env!("CARGO_BIN_EXE_runtimed") {
        Some(path) => PathBuf::from(path),
        None => panic!("cargo must provide the runtimed binary to integration tests"),
    }
}

struct InstanceProcess {
    child: Child,
    base_dir: PathBuf,
    config_dir: PathBuf,
}

impl InstanceProcess {
    fn spawn(instance_id: &str) -> Self {
        let channel = runt_workspace::build_channel();
        let base_dir = runt_workspace::daemon_base_dir_for_instance(channel, instance_id)
            .expect("non-empty test instance id");
        let config_dir = runt_workspace::daemon_config_dir_for_instance(channel, instance_id)
            .expect("non-empty test instance id");
        let binary = runtimed_binary();
        let child = Command::new(binary)
            .args([
                "--log-level",
                "warn",
                "run",
                "--uv-pool-size",
                "0",
                "--conda-pool-size",
                "0",
                "--pixi-pool-size",
                "0",
            ])
            .env(runt_workspace::DAEMON_INSTANCE_ID_ENV, instance_id)
            .env_remove("RUNTIMED_SOCKET_PATH")
            .env_remove("RUNTIMED_DEV")
            .env_remove("RUNTIMED_WORKSPACE_PATH")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn runtimed instance");
        Self {
            child,
            base_dir,
            config_dir,
        }
    }

    fn wait_for_exit(&mut self) {
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while std::time::Instant::now() < deadline {
            match self.child.try_wait() {
                Ok(Some(_)) => return,
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(_) => break,
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Drop for InstanceProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.base_dir);
        let _ = std::fs::remove_dir_all(&self.config_dir);
    }
}

async fn wait_for_info(client: &PoolClient) -> DaemonInfo {
    let deadline = tokio::time::Instant::now() + READY_TIMEOUT;
    loop {
        if let Ok(info) = client.daemon_info().await {
            return info;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "daemon did not become ready within {READY_TIMEOUT:?}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn host_instances_coexist_and_preserve_per_instance_singletons() {
    let nonce = uuid::Uuid::new_v4();
    let first_id = format!("instance-test-{nonce}-a");
    let second_id = format!("instance-test-{nonce}-b");
    let channel = runt_workspace::build_channel();
    let first_socket = runt_workspace::socket_path_for_instance(channel, &first_id).unwrap();
    let second_socket = runt_workspace::socket_path_for_instance(channel, &second_id).unwrap();
    let normal_socket = runt_workspace::socket_path_for_channel(channel);

    assert_ne!(first_socket, second_socket);
    assert_ne!(first_socket, normal_socket);
    assert_ne!(second_socket, normal_socket);

    let mut first = InstanceProcess::spawn(&first_id);
    let first_client = PoolClient::new(first_socket.clone());
    let first_info = wait_for_info(&first_client).await;

    let mut second = InstanceProcess::spawn(&second_id);
    let second_client = PoolClient::new(second_socket.clone());
    let second_info = wait_for_info(&second_client).await;

    assert_ne!(first_info.pid, second_info.pid);
    assert_eq!(first_info.instance_id.as_deref(), Some(first_id.as_str()));
    assert_eq!(second_info.instance_id.as_deref(), Some(second_id.as_str()));
    assert_eq!(
        first_info.daemon_base_dir.as_deref(),
        Some(first.base_dir.to_string_lossy().as_ref())
    );
    assert_eq!(
        second_info.daemon_base_dir.as_deref(),
        Some(second.base_dir.to_string_lossy().as_ref())
    );
    assert_ne!(first_info.blob_port, second_info.blob_port);
    assert!(first.base_dir.join("daemon.lock").is_file());
    assert!(second.base_dir.join("daemon.lock").is_file());
    assert!(first.config_dir.join("settings.json").is_file());
    assert!(second.config_dir.join("settings.json").is_file());

    let binary = runtimed_binary();
    let duplicate = Command::new(binary)
        .args([
            "--log-level",
            "warn",
            "run",
            "--uv-pool-size",
            "0",
            "--conda-pool-size",
            "0",
            "--pixi-pool-size",
            "0",
        ])
        .env(runt_workspace::DAEMON_INSTANCE_ID_ENV, &first_id)
        .env_remove("RUNTIMED_SOCKET_PATH")
        .env_remove("RUNTIMED_DEV")
        .env_remove("RUNTIMED_WORKSPACE_PATH")
        .output()
        .expect("run duplicate instance");
    assert!(duplicate.status.success());
    assert!(String::from_utf8_lossy(&duplicate.stderr).contains("Another daemon already running"));
    assert_eq!(
        first_client.daemon_info().await.unwrap().pid,
        first_info.pid
    );
    assert!(second_client.ping().await.is_ok());

    first_client.shutdown().await.unwrap();
    second_client.shutdown().await.unwrap();
    first.wait_for_exit();
    second.wait_for_exit();
}
