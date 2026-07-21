//! Assistant chat proxy.
//!
//! A deliberately small, hacky bridge that lets the notebook app's assistant
//! side panel talk to Claude through Anaconda's hosted OpenAI-protocol gateway
//! without shipping the full bundled Python assistant runtime that
//! anaconda-desktop uses.
//!
//! Two moving parts:
//!   1. Auth — we shell out to the `anaconda` CLI (`anaconda auth api-key`) to
//!      obtain the signed-in user's API key. This mirrors how anaconda-desktop
//!      hands `ANACONDA_AI_API_KEY` to its sidecar, minus the OAuth/connector
//!      plumbing. The CLI is assumed to already be installed and logged in.
//!   2. Proxy — we forward the browser's OpenAI-style chat completion request
//!      to `https://anaconda.com/api/assistant/v3/bedrock/chat/completions`
//!      with the bearer token + required client headers, and stream the SSE
//!      response straight back to the browser.
//!
//! This is intentionally NOT wired through the Automerge notebook document or
//! the framed socket protocol — the assistant panel is a standalone chat that
//! does not touch notebook state.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::Command;
use tracing::{debug, warn};

/// Upstream Anaconda-hosted, OpenAI-protocol gateway (Bedrock-backed Claude).
const ASSISTANT_API_BASE: &str = "https://anaconda.com/api/assistant/v3/bedrock";
/// Default model id served by the gateway.
pub const ASSISTANT_MODEL: &str = "us.anthropic.claude-sonnet-4-6";
/// Required client headers — the gateway 400s without them.
const CLIENT_SOURCE: &str = "anaconda-labs-prod";
const CLIENT_VERSION: &str = "0.0.1";

/// Error obtaining the Anaconda API key from the CLI.
#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("failed to run `anaconda auth api-key`: {0}")]
    Spawn(#[from] std::io::Error),
    #[error("`anaconda auth api-key` exited with status {status}: {stderr}")]
    NonZero { status: String, stderr: String },
    #[error("`anaconda auth api-key` returned an empty key (not logged in?)")]
    Empty,
}

/// Locate the `anaconda` CLI binary.
///
/// Order: `ANACONDA_CLI_BIN` env override, then `anaconda` on `PATH`, then a
/// few common install locations (Homebrew, system, user miniconda/anaconda).
/// The daemon does not necessarily inherit the interactive shell's `PATH`, so
/// the fallbacks matter.
fn resolve_anaconda_bin() -> PathBuf {
    if let Ok(explicit) = std::env::var("ANACONDA_CLI_BIN") {
        if !explicit.is_empty() {
            return PathBuf::from(explicit);
        }
    }

    let mut candidates: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin/anaconda"),
        PathBuf::from("/usr/local/bin/anaconda"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        for rel in [
            "miniconda3/bin/anaconda",
            "anaconda3/bin/anaconda",
            ".anaconda-desktop-itest/miniconda3/bin/anaconda",
        ] {
            candidates.push(home.join(rel));
        }
    }
    if let Some(found) = candidates.into_iter().find(|p| p.exists()) {
        return found;
    }

    // Last resort: rely on PATH resolution.
    PathBuf::from("anaconda")
}

/// Resolve the Anaconda API key by invoking the `anaconda` CLI.
///
/// Hacky by design: assumes the `anaconda` CLI is installed and the user is
/// logged in (`anaconda login`). Returns the trimmed key string.
pub async fn fetch_api_key() -> Result<String, AuthError> {
    let bin = resolve_anaconda_bin();
    debug!("[assistant-chat] resolving api key via {}", bin.display());
    let output = Command::new(&bin)
        .args(["auth", "api-key"])
        .stdin(Stdio::null())
        .output()
        .await?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AuthError::NonZero {
            status: output.status.to_string(),
            stderr,
        });
    }

    // The CLI prints the key (and possibly a trailing newline). Take the last
    // non-empty line to be resilient to any leading banner noise.
    let stdout = String::from_utf8_lossy(&output.stdout);
    let key = stdout
        .lines()
        .map(str::trim)
        .rev()
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .to_string();

    if key.is_empty() {
        return Err(AuthError::Empty);
    }
    Ok(key)
}

/// Forward a chat completion request to the Anaconda gateway.
///
/// `body` is the raw JSON body the browser sent (OpenAI chat-completions
/// shape). We inject the model if absent and always request streaming. Returns
/// the upstream `reqwest::Response` so the caller can stream the SSE body back
/// to the browser verbatim.
pub async fn forward_chat_completion(
    api_key: &str,
    mut body: serde_json::Value,
) -> Result<reqwest::Response, reqwest::Error> {
    if let Some(obj) = body.as_object_mut() {
        obj.entry("model")
            .or_insert_with(|| serde_json::Value::String(ASSISTANT_MODEL.to_string()));
        // Force streaming — the panel renders tokens as they arrive.
        obj.insert("stream".to_string(), serde_json::Value::Bool(true));
    }

    let url = format!("{ASSISTANT_API_BASE}/chat/completions");
    debug!("[assistant-chat] forwarding chat completion to {url}");

    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .bearer_auth(api_key)
        .header("Content-Type", "application/json")
        .header("Accept", "text/event-stream")
        .header("X-Client-Source", CLIENT_SOURCE)
        .header("X-Client-Version", CLIENT_VERSION)
        .json(&body)
        .send()
        .await?;

    if !response.status().is_success() {
        warn!(
            "[assistant-chat] upstream returned status {}",
            response.status()
        );
    }
    Ok(response)
}
