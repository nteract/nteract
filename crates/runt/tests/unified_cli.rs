#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::Stdio;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::time::timeout;

const DEADLINE: Duration = Duration::from_secs(20);

async fn send(stdin: &mut ChildStdin, value: Value) {
    let mut bytes = serde_json::to_vec(&value).unwrap();
    bytes.push(b'\n');
    timeout(DEADLINE, stdin.write_all(&bytes))
        .await
        .unwrap()
        .unwrap();
}

async fn response(stdout: &mut BufReader<ChildStdout>, id: u64) -> Value {
    timeout(DEADLINE, async {
        loop {
            let mut line = String::new();
            assert_ne!(
                stdout.read_line(&mut line).await.unwrap(),
                0,
                "unexpected MCP EOF"
            );
            let value: Value =
                serde_json::from_str(&line).expect("stdout must contain only JSON-RPC");
            if value.get("id") == Some(&json!(id)) {
                return value;
            }
            assert!(
                value.get("method").is_some(),
                "unexpected response: {value}"
            );
        }
    })
    .await
    .expect("MCP response timed out")
}

async fn exercise_supervised_mcp(native: bool) {
    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("s");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let probes = Arc::new(AtomicUsize::new(0));
    let observed = probes.clone();
    let fake_endpoint = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            observed.fetch_add(1, Ordering::SeqCst);
            drop(stream);
        }
    });
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_nteract-cli"))
        .args(["mcp", "--no-show", "--socket"])
        .arg(&socket)
        .env_clear()
        .env("HOME", dir.path())
        .env("USERPROFILE", dir.path())
        .env("XDG_CONFIG_HOME", dir.path().join("config"))
        .env("XDG_CACHE_HOME", dir.path().join("cache"))
        .env("XDG_DATA_HOME", dir.path().join("data"))
        .env("RUNTIMED_DEV", "1")
        .env("RUNTIMED_WORKSPACE_PATH", dir.path())
        .env("RUNTIMED_SOCKET_PATH", dir.path().join("wrong.sock"))
        .current_dir(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = BufReader::new(child.stdout.take().unwrap());
    let meta = json!({
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {"name":"unified-cli-test","version":"1"}
    });
    if !native {
        send(
            &mut stdin,
            json!({"jsonrpc":"2.0","id":0,"method":"initialize","params":{
                "protocolVersion":"2025-11-25", "capabilities":{},
                "clientInfo":{"name":"unified-cli-test","version":"1"}
            }}),
        )
        .await;
        let initialized = response(&mut stdout, 0).await;
        assert_eq!(initialized["result"]["protocolVersion"], "2025-11-25");
        send(
            &mut stdin,
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .await;
    }
    let params = if native {
        json!({"_meta":meta.clone()})
    } else {
        json!({})
    };
    send(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":1,"method":"tools/list","params":params}),
    )
    .await;
    let listed = response(&mut stdout, 1).await;
    let tools = listed["result"]["tools"].as_array().expect("tool catalog");
    assert!(tools.iter().any(|tool| tool["name"] == "create_notebook"));
    assert!(
        tools.iter().any(|tool| tool["name"] == "reconnect"),
        "public entrypoint must include proxy recovery"
    );
    assert!(
        !tools.iter().any(|tool| tool["name"] == "show_notebook"),
        "--no-show must reach the worker"
    );
    // Legacy tools/list may legitimately return the initial cached catalog.
    // A session-free worker call waits for actual child startup without
    // opening a notebook or starting a runtime.
    let mut call = json!({"name":"disconnect_notebook", "arguments":{}});
    if native {
        call["_meta"] = meta;
        // Native notebook-scoped calls need a handle. Use list_notebooks with
        // a deliberately unknown hosted domain to reach the worker read-only.
        call["name"] = json!("list_notebooks");
        call["arguments"] = json!({"domain":"https://unconfigured.invalid"});
    }
    send(
        &mut stdin,
        json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":call}),
    )
    .await;
    let called = response(&mut stdout, 2).await;
    assert_eq!(called["result"]["isError"], true, "{called}");
    assert!(
        probes.load(Ordering::SeqCst) >= 2,
        "worker metadata queries must use explicit --socket"
    );
    stdin.shutdown().await.unwrap();
    drop(stdin);
    let status = timeout(DEADLINE, child.wait()).await.unwrap().unwrap();
    assert!(status.success(), "supervisor shutdown failed: {status}");
    fake_endpoint.abort();
    let _ = fake_endpoint.await;
}

#[tokio::test]
async fn canonical_mcp_preserves_legacy_protocol_and_worker_options() {
    exercise_supervised_mcp(false).await;
}

#[tokio::test]
async fn canonical_mcp_preserves_native_protocol_and_worker_options() {
    exercise_supervised_mcp(true).await;
}

#[test]
fn canonical_and_legacy_binaries_keep_their_public_names() {
    for (binary, name) in [
        (env!("CARGO_BIN_EXE_nteract-cli"), "nteract"),
        (env!("CARGO_BIN_EXE_runt"), "runt"),
    ] {
        let output = std::process::Command::new(binary)
            .arg("--help")
            .output()
            .unwrap();
        assert!(output.status.success());
        let help = String::from_utf8(output.stdout).unwrap();
        assert!(help.contains(&format!("Usage: {name}")), "{help}");
        assert!(!help.contains("mcp-worker"));
    }
}

#[test]
fn notebook_tool_help_keeps_the_selected_public_command() {
    for (binary, name) in [
        (env!("CARGO_BIN_EXE_nteract-cli"), "nteract"),
        (env!("CARGO_BIN_EXE_runt"), "runt"),
    ] {
        let output = std::process::Command::new(binary)
            .args(["nb", "tools"])
            .output()
            .unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8(output.stdout)
            .unwrap()
            .contains(&format!("`{name} nb tools --all`")));
    }
}

#[tokio::test]
async fn canonical_open_refuses_uninspectable_runtime_before_desktop_launch() {
    use std::os::unix::fs::PermissionsExt;

    let dir = tempfile::tempdir().unwrap();
    let socket = dir.path().join("s");
    let listener = tokio::net::UnixListener::bind(&socket).unwrap();
    let probes = Arc::new(AtomicUsize::new(0));
    let observed = probes.clone();
    let fake_endpoint = tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            observed.fetch_add(1, Ordering::SeqCst);
            // A live endpoint with no readable metadata must never count as absent.
            drop(stream);
        }
    });
    let launchers = dir.path().join("bin");
    std::fs::create_dir(&launchers).unwrap();
    let marker = dir.path().join("desktop-launched");
    for name in ["open", "nteract", "nteract-nightly", "nteract Nightly"] {
        let launcher = launchers.join(name);
        std::fs::write(
            &launcher,
            "#!/bin/sh\nprintf launched > \"$NTERACT_TEST_DESKTOP_MARKER\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let output = timeout(
        DEADLINE,
        tokio::process::Command::new(env!("CARGO_BIN_EXE_nteract-cli"))
            .arg("open")
            .env_clear()
            .env("HOME", dir.path())
            .env("USERPROFILE", dir.path())
            .env("XDG_CONFIG_HOME", dir.path().join("config"))
            .env("XDG_CACHE_HOME", dir.path().join("cache"))
            .env("XDG_DATA_HOME", dir.path().join("data"))
            .env("RUNTIMED_SOCKET_PATH", &socket)
            .env("PATH", &launchers)
            .env("NTERACT_TEST_DESKTOP_MARKER", &marker)
            .current_dir(dir.path())
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .expect("canonical open timed out")
    .unwrap();
    fake_endpoint.abort();
    let _ = fake_endpoint.await;

    let error = String::from_utf8(output.stderr).unwrap();
    assert!(!output.status.success(), "{error}");
    assert!(
        error.contains("Could not inspect the runtime at"),
        "{error}"
    );
    assert!(error.contains(socket.to_str().unwrap()), "{error}");
    assert!(probes.load(Ordering::SeqCst) >= 1);
    assert!(
        !marker.exists(),
        "Desktop launched before runtime admission"
    );
}
