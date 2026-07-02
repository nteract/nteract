//! Hosted notebook target parsing and hosted-room connection for MCP sessions.
//!
//! The machine-local cloud domain registry lives in
//! `notebook_cloud_transport::registry` (shared with the daemon's hosted-room
//! bridge); this module re-exports it and adds the MCP-facing pieces: connect
//! target parsing and the direct hosted-room connector.

use notebook_cloud_transport::{CloudAuth, CloudWsConfig, CloudWsFrameTransport};
use notebook_protocol::connection::FrameTransport;
use notebook_sync::connect::ConnectResult;

pub use notebook_cloud_transport::registry::{
    hosted_notebook_url, normalize_domain, registry_path, CloudDomainConfig, CloudRegistry,
    CredentialRef, ResolvedCloudDomain,
};

/// Default operator suffix when the registry entry does not configure one.
pub const DEFAULT_MCP_OPERATOR: &str = "agent:nteract-mcp";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NotebookTarget {
    LocalPath(String),
    LocalNotebookId(String),
    Hosted {
        domain: String,
        notebook_id: String,
        source: HostedTargetSource,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostedTargetSource {
    Url,
    NotebookIdWithDomain,
}

impl NotebookTarget {
    pub fn notebook_id(&self) -> Option<&str> {
        match self {
            Self::LocalPath(_) => None,
            Self::LocalNotebookId(id) => Some(id),
            Self::Hosted { notebook_id, .. } => Some(notebook_id),
        }
    }

    pub fn rejoin_target(&self) -> String {
        match self {
            Self::LocalPath(path) | Self::LocalNotebookId(path) => path.clone(),
            Self::Hosted {
                domain,
                notebook_id,
                ..
            } => hosted_notebook_url(domain, notebook_id),
        }
    }
}

pub async fn connect_hosted_notebook(
    domain: &ResolvedCloudDomain,
    notebook_id: &str,
) -> Result<ConnectResult, String> {
    let transport = CloudWsFrameTransport::new(CloudWsConfig {
        cloud_url: domain.base_url.clone(),
        notebook_id: notebook_id.to_string(),
        scope: "editor".to_string(),
        auth: domain.resolve_auth()?,
        workstation: None,
    });
    let (source, sink) = transport
        .connect()
        .await
        .map_err(|e| format!("Failed to connect hosted notebook: {e}"))?;
    let principal = transport
        .principal()
        .ok_or_else(|| "Hosted room did not provide an authenticated principal".to_string())?;
    let actor_label = domain.actor_label(principal, DEFAULT_MCP_OPERATOR);
    notebook_sync::connect::connect_frame_io(notebook_id.to_string(), &actor_label, source, sink)
        .await
        .map_err(|e| format!("Failed to start hosted notebook sync: {e}"))
}

pub async fn list_hosted_notebooks(
    domain: &ResolvedCloudDomain,
    limit: Option<u16>,
) -> Result<serde_json::Value, String> {
    let limit = limit.unwrap_or(100);
    let url = format!(
        "{}/api/n?limit={limit}",
        domain.base_url.trim_end_matches('/')
    );
    let client = reqwest::Client::new();
    let request = apply_reqwest_auth(client.get(url), &domain.resolve_auth()?, "viewer")
        .header(reqwest::header::ACCEPT, "application/json");
    let response = request
        .send()
        .await
        .map_err(|e| format!("Failed to list hosted notebooks: {e}"))?;
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read hosted notebook list response: {e}"))?;
    if !status.is_success() {
        return Err(format!(
            "Hosted notebook list failed with HTTP {status}: {body}"
        ));
    }
    serde_json::from_str(&body)
        .map_err(|e| format!("Hosted notebook list response was not valid JSON: {e}"))
}

fn apply_reqwest_auth(
    request: reqwest::RequestBuilder,
    auth: &CloudAuth,
    scope: &str,
) -> reqwest::RequestBuilder {
    let request = request.header("X-Scope", scope);
    match auth {
        CloudAuth::OidcBearer { token } | CloudAuth::WorkstationCredential { token } => {
            request.bearer_auth(token)
        }
        CloudAuth::AnacondaApiKey { token } => request
            .bearer_auth(token)
            .header("X-Notebook-Cloud-Auth-Provider", "anaconda-api-key"),
        CloudAuth::Dev { token, user } => request
            .header("X-Notebook-Cloud-Dev-Token", token)
            .header("X-User", user),
    }
}

pub fn parse_connect_target(
    target: Option<&str>,
    path: Option<&str>,
    notebook_id: Option<&str>,
    domain: Option<&str>,
) -> Result<NotebookTarget, String> {
    let provided = [target.is_some(), path.is_some(), notebook_id.is_some()]
        .into_iter()
        .filter(|v| *v)
        .count();

    if provided != 1 {
        return Err(
            "Provide exactly one of target, path, or notebook_id. Use domain only with notebook_id."
                .to_string(),
        );
    }

    if domain.is_some() && notebook_id.is_none() {
        return Err("domain is only valid with notebook_id".to_string());
    }

    if let Some(path) = path {
        return Ok(NotebookTarget::LocalPath(path.to_string()));
    }

    if let Some(id) = notebook_id {
        if let Some(domain) = domain {
            if is_local_domain_alias(domain) {
                return parse_local_notebook_id(id);
            }
            return Ok(NotebookTarget::Hosted {
                domain: normalize_domain(domain)?,
                notebook_id: id.to_string(),
                source: HostedTargetSource::NotebookIdWithDomain,
            });
        }
        return parse_local_notebook_id(id);
    }

    let Some(target) = target else {
        return Err(
            "Provide exactly one of target, path, or notebook_id. Use domain only with notebook_id."
                .to_string(),
        );
    };
    if target.starts_with("nteract://") {
        return Err("nteract:// resource URIs are not connect targets".to_string());
    }
    if target.starts_with("http://") || target.starts_with("https://") {
        return parse_hosted_url_target(target);
    }
    if looks_like_uuid(target) {
        return parse_local_notebook_id(target);
    }
    if looks_like_ulid(target) {
        return Err(format!(
            "Invalid target '{target}': bare hosted ULIDs are not default remote targets. \
             Pass a hosted URL or pass notebook_id with domain."
        ));
    }
    Ok(NotebookTarget::LocalPath(target.to_string()))
}

fn parse_local_notebook_id(id: &str) -> Result<NotebookTarget, String> {
    if looks_like_uuid(id) {
        Ok(NotebookTarget::LocalNotebookId(id.to_string()))
    } else {
        Err(format!(
            "Invalid local notebook_id '{id}': bare notebook_id targets must be local UUIDs. \
             For hosted notebooks, pass target as a hosted URL or pass notebook_id with domain."
        ))
    }
}

fn parse_hosted_url_target(target: &str) -> Result<NotebookTarget, String> {
    let (domain, notebook_id) = notebook_cloud_transport::registry::parse_hosted_url(target)?;
    Ok(NotebookTarget::Hosted {
        domain,
        notebook_id,
        source: HostedTargetSource::Url,
    })
}

fn looks_like_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok()
}

pub fn is_local_domain_alias(domain: &str) -> bool {
    matches!(
        domain.trim().to_ascii_lowercase().as_str(),
        "local" | "desktop"
    )
}

fn looks_like_ulid(value: &str) -> bool {
    value.len() == 26
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'T' | b'V'..=b'Z'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use futures_util::{SinkExt, StreamExt};
    use notebook_protocol::connection::NotebookFrameType;
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio::time;
    use tokio_tungstenite::accept_hdr_async;
    use tokio_tungstenite::tungstenite::handshake::server::{Request, Response};
    use tokio_tungstenite::tungstenite::Message;

    #[test]
    fn parses_local_path_target() {
        assert_eq!(
            parse_connect_target(Some("./notebooks/demo.ipynb"), None, None, None).unwrap(),
            NotebookTarget::LocalPath("./notebooks/demo.ipynb".to_string())
        );
    }

    #[test]
    fn parses_local_notebook_id_target() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            parse_connect_target(Some(id), None, None, None).unwrap(),
            NotebookTarget::LocalNotebookId(id.to_string())
        );
    }

    #[test]
    fn parses_hosted_url_target() {
        let target =
            "https://preview.runt.run/n/01KTZA152886TK1WAHYA48G7HJ/view-only-quill?mode=edit";
        assert_eq!(
            parse_connect_target(Some(target), None, None, None).unwrap(),
            NotebookTarget::Hosted {
                domain: "https://preview.runt.run".to_string(),
                notebook_id: "01KTZA152886TK1WAHYA48G7HJ".to_string(),
                source: HostedTargetSource::Url,
            }
        );
    }

    #[test]
    fn parses_notebook_id_with_hosted_domain() {
        assert_eq!(
            parse_connect_target(
                None,
                None,
                Some("01KTZA152886TK1WAHYA48G7HJ"),
                Some("https://preview.runt.run")
            )
            .unwrap(),
            NotebookTarget::Hosted {
                domain: "https://preview.runt.run".to_string(),
                notebook_id: "01KTZA152886TK1WAHYA48G7HJ".to_string(),
                source: HostedTargetSource::NotebookIdWithDomain,
            }
        );
    }

    #[test]
    fn parses_local_notebook_id_with_local_domain_aliases() {
        let id = "550e8400-e29b-41d4-a716-446655440000";
        assert_eq!(
            parse_connect_target(None, None, Some(id), Some("local")).unwrap(),
            NotebookTarget::LocalNotebookId(id.to_string())
        );
        assert_eq!(
            parse_connect_target(None, None, Some(id), Some(" desktop ")).unwrap(),
            NotebookTarget::LocalNotebookId(id.to_string())
        );
    }

    #[test]
    fn rejects_bare_hosted_ulid_as_local_id() {
        let err = parse_connect_target(Some("01KTZA152886TK1WAHYA48G7HJ"), None, None, None)
            .expect_err("bare hosted id is not default remote");
        assert!(err.contains("bare hosted ULIDs are not default remote targets"));
    }

    #[test]
    fn rejects_nteract_resource_uri() {
        let err = parse_connect_target(
            Some("nteract://notebooks/550e8400-e29b-41d4-a716-446655440000/cells"),
            None,
            None,
            None,
        )
        .expect_err("resource URI is not a connect target");
        assert!(err.contains("not connect targets"));
    }

    #[test]
    fn enforces_exactly_one_primary_target() {
        assert!(parse_connect_target(None, None, None, None).is_err());
        assert!(parse_connect_target(Some("a.ipynb"), Some("b.ipynb"), None, None).is_err());
    }

    #[test]
    fn registry_validates_default_domain() {
        let registry: CloudRegistry = toml::from_str(
            r#"
default_domain = "https://preview.runt.run/"

[[domains]]
url = "https://preview.runt.run"
operator = "agent:codex"
credential = { kind = "anaconda-api-key-env", env = "NTERACT_TEST_TOKEN" }
"#,
        )
        .unwrap();

        registry.validate().unwrap();
        assert_eq!(
            registry.default_domain().unwrap(),
            Some("https://preview.runt.run".to_string())
        );
        assert!(registry
            .domain("https://preview.runt.run/n/abc")
            .unwrap()
            .is_some());
    }

    #[test]
    fn loads_registry_toml_with_credential_reference_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("cloud-domains.toml");
        std::fs::write(
            &path,
            r#"
default_domain = "https://preview.runt.run"

[[domains]]
url = "https://preview.runt.run/"
operator = "agent:codex"
credential = { kind = "anaconda-api-key-env", env = "NTERACT_TEST_ANACONDA_KEY" }
"#,
        )
        .unwrap();

        let registry = CloudRegistry::load_from_path(&path).unwrap().unwrap();
        let domain = registry
            .domain("https://preview.runt.run/n/demo")
            .unwrap()
            .unwrap();
        assert_eq!(domain.base_url, "https://preview.runt.run");
        assert_eq!(domain.operator.as_deref(), Some("agent:codex"));
    }

    #[tokio::test]
    #[allow(clippy::result_large_err)] // tokio-tungstenite's handshake callback requires this error shape.
    async fn connect_hosted_notebook_uses_local_room_and_sends_sync_frame() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let (frame_tx, frame_rx) = oneshot::channel::<usize>();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let callback = |req: &Request, response: Response| {
                assert_eq!(req.uri().path(), "/n/hosted-test/sync");
                assert_eq!(
                    req.headers()
                        .get("authorization")
                        .and_then(|value| value.to_str().ok()),
                    Some("Bearer secret-key")
                );
                assert_eq!(
                    req.headers()
                        .get("x-notebook-cloud-auth-provider")
                        .and_then(|value| value.to_str().ok()),
                    Some("anaconda-api-key")
                );
                assert_eq!(
                    req.headers()
                        .get("x-scope")
                        .and_then(|value| value.to_str().ok()),
                    Some("editor")
                );
                Ok(response)
            };
            let mut ws = accept_hdr_async(stream, callback).await.unwrap();

            let ready_payload = serde_json::to_vec(&serde_json::json!({
                "type": "cloud_room_ready",
                "actor_label": "anaconda:alice/agent:room:ready",
                "connection_scope": "editor",
            }))
            .unwrap();
            ws.send(Message::Binary(
                encode_ws_frame(NotebookFrameType::SessionControl, &ready_payload).into(),
            ))
            .await
            .unwrap();

            let mut frame_tx = Some(frame_tx);
            loop {
                let msg = time::timeout(Duration::from_secs(5), ws.next())
                    .await
                    .expect("timed out waiting for a client frame")
                    .expect("client closed before sending a sync frame")
                    .expect("websocket read failed");

                let Message::Binary(data) = msg else {
                    continue;
                };
                if data.first().copied() == Some(NotebookFrameType::AutomergeSync as u8) {
                    let tx = frame_tx.take().unwrap();
                    let _ = tx.send(data.len());
                    break;
                }
            }
        });

        let domain = ResolvedCloudDomain::with_auth_override(
            format!("http://{addr}"),
            Some("agent:test".to_string()),
            CloudAuth::AnacondaApiKey {
                token: "secret-key".to_string(),
            },
        );

        let result = connect_hosted_notebook(&domain, "hosted-test")
            .await
            .unwrap();
        assert_eq!(result.handle.notebook_id(), "hosted-test");

        result
            .handle
            .add_cell_with_source("cell-a", "markdown", None, "hello from local agent")
            .unwrap();
        let frame_len = time::timeout(Duration::from_secs(5), frame_rx)
            .await
            .expect("timed out waiting for sync frame")
            .expect("server did not observe sync frame");
        assert!(frame_len > 1);

        drop(result);
        server.await.unwrap();
    }

    fn encode_ws_frame(frame_type: NotebookFrameType, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::with_capacity(1 + payload.len());
        frame.push(frame_type as u8);
        frame.extend_from_slice(payload);
        frame
    }
}
