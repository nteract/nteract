#![allow(dead_code)]

use std::time::Duration;

use rmcp::{ServerHandler, ServiceExt};
use serde_json::{json, Value};
use tokio::io::{
    AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream, Lines, ReadHalf, WriteHalf,
};
use tokio::task::JoinHandle;
use tokio::time::timeout;

pub const LEGACY_VERSIONS: [&str; 4] = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];
pub const DEADLINE: Duration = Duration::from_secs(10);

pub struct Wire {
    reader: Lines<BufReader<ReadHalf<DuplexStream>>>,
    writer: WriteHalf<DuplexStream>,
    task: JoinHandle<Result<bool, String>>,
    pub notifications: Vec<Value>,
}

impl Wire {
    pub fn start<S: ServerHandler + Send + Sync + 'static>(handler: S) -> Self {
        let (server, client) = tokio::io::duplex(64 * 1024);
        let task = tokio::spawn(async move {
            match handler.serve(server).await {
                Ok(service) => service
                    .waiting()
                    .await
                    .map(|_| true)
                    .map_err(|e| e.to_string()),
                Err(_) => Ok(false),
            }
        });
        let (reader, writer) = tokio::io::split(client);
        Self {
            reader: BufReader::new(reader).lines(),
            writer,
            task,
            notifications: Vec::new(),
        }
    }

    pub async fn send(&mut self, message: Value) {
        let mut bytes = serde_json::to_vec(&message).expect("serialize JSON-RPC message");
        bytes.push(b'\n');
        timeout(DEADLINE, self.writer.write_all(&bytes))
            .await
            .expect("wire write timed out")
            .expect("write newline-delimited JSON");
    }

    pub async fn receive(&mut self) -> Value {
        let line = timeout(DEADLINE, self.reader.next_line())
            .await
            .expect("wire response timed out")
            .expect("read JSON-RPC line")
            .expect("unexpected EOF before JSON-RPC response");
        let message: Value = serde_json::from_str(&line).expect("response must be a JSON line");
        assert_eq!(message["jsonrpc"], "2.0");
        message
    }

    pub async fn request(&mut self, id: u64, method: &str, params: Option<Value>) -> Value {
        let mut message = json!({"jsonrpc": "2.0", "id": id, "method": method});
        if let Some(params) = params {
            message["params"] = params;
        }
        self.send(message).await;
        loop {
            let response = self.receive().await;
            if response.get("id").is_none() {
                assert!(response["method"].is_string());
                self.notifications.push(response);
                continue;
            }
            assert_eq!(response["id"], id, "response IDs must be preserved");
            assert_ne!(
                response.get("result").is_some(),
                response.get("error").is_some()
            );
            return response;
        }
    }

    pub async fn initialize(&mut self, version: &str) -> Value {
        self.request(
            1,
            "initialize",
            Some(json!({
                "protocolVersion": version,
                "capabilities": {},
                "clientInfo": {"name": "compatibility-client", "version": "1.0", "title": "Compatibility Client"}
            })),
        )
        .await
    }

    pub async fn initialized(&mut self) {
        self.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
            .await;
    }

    pub async fn notification(&mut self, method: &str) {
        timeout(DEADLINE, async {
            loop {
                if self
                    .notifications
                    .iter()
                    .any(|message| message["method"] == method)
                {
                    return;
                }
                let message = self.receive().await;
                assert!(
                    message.get("id").is_none(),
                    "unexpected response: {message}"
                );
                self.notifications.push(message);
            }
        })
        .await
        .expect("expected initialized notification did not arrive");
    }

    pub async fn finish(mut self) -> bool {
        self.writer.shutdown().await.expect("close client writer");
        timeout(DEADLINE, &mut self.task)
            .await
            .expect("server did not stop after EOF")
            .expect("server task panicked")
            .expect("server service failed")
    }
}

impl Drop for Wire {
    fn drop(&mut self) {
        self.task.abort();
    }
}

pub async fn assert_reinitialize_preserves_legacy_peer(wire: &mut Wire, version: &str) {
    let original = json!({
        "protocolVersion": version,
        "capabilities": {},
        "clientInfo": {"name": "compatibility-client", "version": "1.0", "title": "Compatibility Client"}
    });
    let mut changes = Vec::new();
    for new_version in [
        "2026-07-28",
        if version == "2024-11-05" {
            "2025-11-25"
        } else {
            "2024-11-05"
        },
    ] {
        let mut changed = original.clone();
        changed["protocolVersion"] = json!(new_version);
        changes.push(changed);
    }
    let mut changed = original.clone();
    changed["clientInfo"]["name"] = json!("replacement-client");
    changes.push(changed);
    let mut changed = original.clone();
    changed["clientInfo"]["title"] = json!("Replacement Client");
    changes.push(changed);
    let mut changed = original.clone();
    changed["capabilities"] = json!({"roots": {"listChanged": true}});
    changes.push(changed);
    for (index, params) in changes.into_iter().enumerate() {
        let id = 100 + index as u64 * 2;
        let response = wire.request(id, "initialize", Some(params)).await;
        assert_eq!(response["error"]["code"], -32600, "{response}");
        let response = wire.request(id + 1, "tools/list", None).await;
        assert!(legacy_result(&response)["tools"].is_array());
    }
    let response = wire.request(120, "initialize", Some(original)).await;
    assert_eq!(legacy_result(&response)["protocolVersion"], version);
}

pub fn legacy_result(response: &Value) -> &Value {
    assert!(
        response.get("error").is_none(),
        "unexpected error: {response}"
    );
    let result = response.get("result").expect("JSON-RPC result");
    assert!(result.is_object());
    for modern_field in ["resultType", "requestState", "inputRequests"] {
        assert!(
            result.get(modern_field).is_none(),
            "modern field in legacy result: {response}"
        );
    }
    result
}

pub fn assert_initialize(response: &Value, version: &str, server_name: &str) {
    let result = legacy_result(response);
    assert_eq!(result["protocolVersion"], version);
    assert_eq!(result["serverInfo"]["name"], server_name);
    assert!(result["serverInfo"]["version"].is_string());
    assert!(result["capabilities"]["tools"].is_object());
    assert!(result["capabilities"]["resources"].is_object());
    assert_eq!(
        result["capabilities"]["extensions"]["io.modelcontextprotocol/ui"],
        json!({})
    );
    assert!(result["capabilities"].get("tasks").is_none());
}

pub fn modern_meta(version: &str, anonymous: bool) -> Value {
    let mut meta = json!({
        "io.modelcontextprotocol/protocolVersion": version,
        "io.modelcontextprotocol/clientCapabilities": {}
    });
    if !anonymous {
        meta["io.modelcontextprotocol/clientInfo"] =
            json!({"name": "modern-client", "version": "3.2"});
    }
    meta
}

pub fn modern_requests() -> Vec<(&'static str, Value)> {
    vec![
        ("server/discover", json!({})),
        ("tools/list", json!({})),
        ("resources/list", json!({})),
        ("resources/templates/list", json!({})),
        ("resources/read", json!({"uri": "ui://nteract/output.html"})),
        (
            "tools/call",
            json!({"name": "create_notebook", "arguments": {"ephemeral": true}}),
        ),
        (
            "tools/call",
            json!({"name": "disconnect_notebook", "arguments": {}}),
        ),
        ("tools/call", json!({"name": "reconnect", "arguments": {}})),
        (
            "subscriptions/listen",
            json!({"notifications": {"toolsListChanged": true}}),
        ),
    ]
}

pub fn assert_unsupported(response: &Value, version: &str) {
    assert!(
        response.get("result").is_none(),
        "modern request unexpectedly succeeded: {response}"
    );
    assert_eq!(response["error"]["code"], -32022, "{response}");
    assert_eq!(response["error"]["data"]["requested"], version);
    let mut supported: Vec<_> = response["error"]["data"]["supported"]
        .as_array()
        .expect("supported versions in error")
        .iter()
        .map(|value| value.as_str().expect("protocol version string"))
        .collect();
    supported.sort_unstable();
    assert_eq!(supported, LEGACY_VERSIONS);
}
