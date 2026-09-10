//! Binary admission must not initialize runtime state or start a service.

#![allow(clippy::expect_used)]

use std::process::Command;

#[test]
fn identity_reports_compiled_versions_without_creating_runtime_state() {
    let state = tempfile::tempdir().expect("temporary state directory");
    let output = Command::new(env!("CARGO_BIN_EXE_runtimed"))
        .arg("runtime-identity")
        .env_clear()
        .env("HOME", state.path())
        .env("USERPROFILE", state.path())
        .env("XDG_CACHE_HOME", state.path())
        .env("XDG_CONFIG_HOME", state.path())
        .env("RUNTIMED_DEV", "1")
        .env("RUNTIMED_WORKSPACE_PATH", state.path())
        .env("RUNTIMED_SOCKET_PATH", state.path().join("unused.sock"))
        .output()
        .expect("query runtime identity");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.stderr.is_empty());
    let identity: serde_json::Value =
        serde_json::from_slice(&output.stdout).expect("JSON identity");
    assert_eq!(
        identity["channel"],
        runt_workspace::cli::channel_name(runt_workspace::build_channel())
    );
    assert_eq!(
        identity["protocol_version"],
        notebook_protocol::connection::PROTOCOL_VERSION
    );
    assert_eq!(
        identity["daemon_api_version"],
        runtimed_client::protocol::DAEMON_API_VERSION
    );
    assert_eq!(
        std::fs::read_dir(state.path())
            .expect("read state directory")
            .count(),
        0
    );
}
