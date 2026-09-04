#![cfg(unix)]
#![allow(clippy::unwrap_used, clippy::expect_used)]

use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::time::timeout;

#[tokio::test]
async fn rejected_first_request_does_not_start_notebook_recovery() {
    for (method, version, expected_code) in [
        ("tools/list", "2026-07-28", -32022),
        ("tools/list", "2025-11-25", -32600),
        ("server/discover", "2025-11-25", -32601),
    ] {
        let dir = tempfile::tempdir().expect("isolated runt MCP directory");
        let notebook = dir.path().join("rejoin.ipynb");
        let source = r#"{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}"#;
        std::fs::write(&notebook, source).expect("write rejoin fixture");
        let socket = dir.path().join("s");
        let listener = tokio::net::UnixListener::bind(&socket).expect("bind isolated daemon probe");
        let (connections, mut observed) = tokio::sync::mpsc::unbounded_channel();
        let probe = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                if connections.send(()).is_err() {
                    break;
                }
                drop(stream);
            }
        });
        let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_runt"))
            .arg("mcp")
            .env_clear()
            .env("HOME", dir.path())
            .env("USERPROFILE", dir.path())
            .env("XDG_CONFIG_HOME", dir.path().join("config"))
            .env("XDG_CACHE_HOME", dir.path().join("cache"))
            .env("XDG_DATA_HOME", dir.path().join("data"))
            .env("RUNTIMED_DEV", "1")
            .env("RUNTIMED_WORKSPACE_PATH", dir.path())
            .env("RUNTIMED_SOCKET_PATH", &socket)
            .env("NTERACT_MCP_REJOIN_NOTEBOOK", &notebook)
            .current_dir(dir.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn actual runt mcp entrypoint");
        let mut stdin = child.stdin.take().expect("child stdin");
        let mut stdout = BufReader::new(child.stdout.take().expect("child stdout"));
        stdin
            .write_all(b"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"ping\"}\n")
            .await
            .expect("write pre-init ping");
        let mut ping = String::new();
        timeout(Duration::from_secs(10), stdout.read_line(&mut ping))
            .await
            .expect("ping timed out")
            .expect("read ping response");
        assert_eq!(
            serde_json::from_str::<Value>(&ping).expect("ping JSON")["result"],
            json!({})
        );
        let mut startup_queries = 0;
        while observed.try_recv().is_ok() {
            startup_queries += 1;
        }
        assert_eq!(
            startup_queries, 2,
            "blob metadata and daemon version queries"
        );
        let request = json!({
            "jsonrpc": "2.0", "id": 1, "method": method,
            "params": {"_meta": {
                "io.modelcontextprotocol/protocolVersion": version,
                "io.modelcontextprotocol/clientCapabilities": {}
            }}
        });
        let mut encoded = serde_json::to_vec(&request).expect("encode request");
        encoded.push(b'\n');
        stdin
            .write_all(&encoded)
            .await
            .expect("write first application request");
        let mut response = String::new();
        timeout(Duration::from_secs(10), stdout.read_line(&mut response))
            .await
            .expect("first response timed out")
            .expect("read first response");
        let response: Value = serde_json::from_str(&response).expect("JSON-RPC error response");
        assert_eq!(response["id"], 1);
        assert_eq!(response["error"]["code"], expected_code, "{response}");
        assert!(response.get("result").is_none());
        assert!(
            timeout(Duration::from_millis(500), observed.recv())
                .await
                .is_err(),
            "rejected request started daemon recovery traffic"
        );
        stdin.shutdown().await.expect("close client stdin");
        drop(stdin);
        let status = timeout(Duration::from_secs(10), child.wait())
            .await
            .expect("uninitialized runt mcp did not stop after EOF")
            .expect("reap runt mcp");
        assert!(status.success(), "{status}");
        let mut remaining = String::new();
        assert_eq!(stdout.read_line(&mut remaining).await.expect("read EOF"), 0);
        assert_eq!(
            std::fs::read_to_string(&notebook).expect("rejoin fixture remains"),
            source
        );
        probe.abort();
        let _ = probe.await;
    }
}
