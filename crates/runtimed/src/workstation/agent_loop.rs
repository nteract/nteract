//! `runtimed workstation-agent` — the long-running workstation service loop.
//!
//! Rust port of `apps/notebook-cloud/scripts/hosted-workstation-agent.mjs`:
//! registers/heartbeats this machine against the hosted workstation surface
//! (`POST /api/workstations`), keeps a workstation event WebSocket open,
//! and falls back to polling the attach-job queue
//! (`GET /api/workstations/{id}/attach-jobs`). It serves each pending job by
//! spawning a `runtimed cloud-runtime-agent` runtime peer (the agent *is*
//! `runtimed`, so it spawns `std::env::current_exe()`).
//!
//! Lifecycle per job: `pending` → PATCH `accepted` → spawn runtime peer →
//! PATCH `running` once the peer logs [`READINESS_LINE`] → PATCH
//! `completed`/`failed` on exit. The peer's stdout/stderr go to a per-job log
//! file (not a pipe) so an orphaned peer can never block on a dead reader, and
//! a restarted agent can adopt it: the agent writes a pid file per job and on
//! restart re-attaches to `accepted`/`running` jobs whose pid is still alive,
//! failing the ones whose peer is gone (the server's stale-job sweep is the
//! backstop for anything this misses).
//!
//! Security: the workstation credential is read from [`CLOUD_TOKEN_ENV`]
//! (`RUNT_CLOUD_TOKEN`) and forwarded to runtime peers through the
//! environment, never argv, so it cannot leak into `ps` output.
//!
//! Concurrency: one owned-state loop, mirroring the single-threaded `.mjs`
//! agent — no shared mutexes, so nothing can hold a lock across an await.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::fd::AsRawFd;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::header::{HeaderValue, AUTHORIZATION};
use tokio_tungstenite::tungstenite::Message as WsMessage;
use tracing::{error, info, warn};

pub use super::cloud_agent_cli::CLOUD_TOKEN_ENV;

/// Line the runtime peer prints when its kernel-facing infrastructure is up;
/// the agent promotes the attach job to `running` when this appears in the
/// peer's log. Must match `run_cloud_runtime_agent`'s startup logging (the
/// `.mjs` agent keys on the same string).
pub const READINESS_LINE: &str = "Infrastructure ready, entering main loop";

/// Default attach-job fallback poll interval. The fast path is the workstation
/// event socket; polling is recovery for missed events or older servers.
pub const DEFAULT_POLL_MS: u64 = 60_000;
/// Default workstation heartbeat interval. The event socket is the fast wakeup
/// path, but registration heartbeat remains the durable online-presence
/// fallback for missed or wedged sockets.
pub const DEFAULT_HEARTBEAT_MS: u64 = 60_000;

/// Cooldown applied to 429/503 responses without a usable `Retry-After`.
const DEFAULT_RETRY_AFTER_MS: u64 = 60_000;
/// Missing/deleted workstation rows mean this agent is stale. Back off hard
/// instead of steadily polling a registry entry the cloud no longer accepts.
const DEFAULT_MISSING_WORKSTATION_RETRY_AFTER_MS: u64 = 15 * 60_000;
/// Upper bound for rate-limit cooldowns (15 minutes, like the `.mjs` agent).
const MAX_RETRY_AFTER_MS: u64 = 15 * 60_000;
/// Idle workstation event sockets should reconnect rather than pinning an
/// agent to a half-open network path forever.
const WORKSTATION_EVENTS_IDLE_TIMEOUT_MS: u64 = 90_000;
/// After an idle socket is probed, a missing response means the path is stale.
const WORKSTATION_EVENTS_PING_TIMEOUT_MS: u64 = 10_000;
const WORKSTATION_EVENTS_PING: &str = "nteract.workstation_events.ping.v1";
const WORKSTATION_EVENTS_PONG: &str = "nteract.workstation_events.pong.v1";
/// How often active children are checked for exit/readiness between polls
/// (the `.mjs` agent's `readyPoll` interval).
const CHILD_TICK_MS: u64 = 250;
/// Configuration for [`run_workstation_agent`]. All fields are non-secret;
/// the credential travels separately.
#[derive(Debug, Clone)]
pub struct WorkstationAgentOptions {
    /// Base URL of the notebook cloud (e.g. `https://app.runt.run`).
    pub cloud_url: String,
    /// Stable workstation id presented to the cloud (`ws-<hostname slug>`).
    pub workstation_id: String,
    /// Human-readable workstation name for the workstation panel.
    pub display_name: String,
    /// Default working directory for runtime peers (jobs may override).
    pub working_dir: PathBuf,
    /// Python interpreter used for launch-on-attach kernels.
    pub python_path: PathBuf,
    /// How often to poll the attach-job queue.
    pub poll_interval: Duration,
    /// How often to re-register (heartbeat) and re-patch active job status.
    pub heartbeat_interval: Duration,
    /// Root directory for per-job state (logs, pid files, blob roots).
    pub agent_root: PathBuf,
}

/// One attach job from `GET /api/workstations/{id}/attach-jobs`.
#[derive(Debug, Clone, Deserialize)]
pub struct AttachJob {
    pub job_id: String,
    pub notebook_id: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub working_directory: Option<String>,
    #[serde(default)]
    pub notebook_path: Option<String>,
}

/// Filesystem + argv plan for spawning one runtime peer. Pure data so the
/// argv/env contract is unit-testable without spawning anything.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachJobSpawnPlan {
    /// `runtimed` argv (subcommand + flags). Never contains the credential.
    pub args: Vec<String>,
    /// Working directory for the peer (job override or the workstation cwd).
    pub cwd: PathBuf,
    /// Per-job state directory: `<agent_root>/<safe job id>`.
    pub run_root: PathBuf,
    /// Blob store root handed to the peer.
    pub blob_root: PathBuf,
    /// Log file receiving the peer's stdout+stderr.
    pub log_path: PathBuf,
    /// Pid file enabling adoption after an agent restart.
    pub pid_path: PathBuf,
}

/// Build the registration/heartbeat payload for `POST /api/workstations`.
/// Field set mirrors `buildWorkstationRegistrationPayload` in
/// `hosted-workstation-agent-core.mjs`; `cpu_count`/`memory_bytes` are
/// omitted (the route treats them as optional) where the platform cannot
/// report them.
pub fn registration_payload(
    workstation_id: &str,
    display_name: &str,
    working_directory: &str,
    python_path: &str,
    cpu_count: Option<u64>,
    memory_bytes: Option<u64>,
) -> Value {
    let mut payload = json!({
        "workstation_id": workstation_id,
        "display_name": display_name,
        "provider": "runtime_peer",
        "default_environment_label": "Current Python",
        "environment_policy": "current_python",
        "working_directory": working_directory,
        "capabilities": {
            "launch_current_python": true,
        },
        "runtime": {
            "binary": "runtimed",
            "python_path": python_path,
        },
    });
    if let Some(cpu) = cpu_count {
        payload["cpu_count"] = cpu.into();
    }
    if let Some(mem) = memory_bytes {
        payload["memory_bytes"] = mem.into();
    }
    payload
}

/// Logical CPU count for the registration payload.
pub fn cpu_count() -> Option<u64> {
    std::thread::available_parallelism()
        .ok()
        .map(|n| n.get() as u64)
}

/// Total physical memory, when the platform exposes it cheaply
/// (Linux `/proc/meminfo`; elsewhere the field is omitted).
#[cfg(target_os = "linux")]
pub fn total_memory_bytes() -> Option<u64> {
    parse_meminfo_total_bytes(&std::fs::read_to_string("/proc/meminfo").ok()?)
}

/// Total physical memory, when the platform exposes it cheaply
/// (Linux `/proc/meminfo`; elsewhere the field is omitted).
#[cfg(not(target_os = "linux"))]
pub fn total_memory_bytes() -> Option<u64> {
    None
}

/// Parse `MemTotal: <n> kB` out of `/proc/meminfo` content.
// Only the linux total_memory_bytes calls this; left un-cfg'd so the pure
// parser stays compiled and unit-tested on every host.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn parse_meminfo_total_bytes(meminfo: &str) -> Option<u64> {
    let line = meminfo.lines().find(|line| line.starts_with("MemTotal:"))?;
    let kb: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024)
}

/// Resolve the default Python interpreter: first `python3`, then `python`,
/// searched across `path_var` (the `PATH` environment value).
pub fn resolve_python_on_path(path_var: Option<&str>) -> Option<PathBuf> {
    let path_var = path_var?;
    let names: &[&str] = if cfg!(windows) {
        &["python3.exe", "python.exe", "python3", "python"]
    } else {
        &["python3", "python"]
    };
    for name in names {
        for dir in std::env::split_paths(path_var) {
            if dir.as_os_str().is_empty() {
                continue;
            }
            let candidate = dir.join(name);
            if is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn is_executable_file(path: &Path) -> bool {
    path.is_file()
}

/// Build the spawn plan for one attach job. Mirrors `buildAttachJobSpawnPlan`
/// in `hosted-workstation-agent-core.mjs`, with `--auth-kind workstation`
/// because the agent holds a pairing-flow workstation credential.
pub fn build_attach_job_spawn_plan(
    job: &AttachJob,
    opts: &WorkstationAgentOptions,
) -> Result<AttachJobSpawnPlan> {
    anyhow::ensure!(!job.job_id.is_empty(), "attach job missing id");
    anyhow::ensure!(
        !job.notebook_id.is_empty(),
        "attach job {} missing notebook_id",
        job.job_id
    );

    let run_root = opts
        .agent_root
        .join(runt_workspace::safe_path_part(&job.job_id));
    let blob_root = run_root.join("blobs");
    let log_path = run_root.join("runtime-peer.log");
    let pid_path = run_root.join("runtime-peer.pid");
    let cwd = job
        .working_directory
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or_else(|| opts.working_dir.clone());

    let mut args = vec![
        "cloud-runtime-agent".to_string(),
        "--auth-kind".to_string(),
        "workstation".to_string(),
        "--cloud-url".to_string(),
        opts.cloud_url.clone(),
        "--notebook-id".to_string(),
        job.notebook_id.clone(),
        "--scope".to_string(),
        "runtime_peer".to_string(),
        "--python-path".to_string(),
        opts.python_path.to_string_lossy().into_owned(),
        "--blob-root".to_string(),
        blob_root.to_string_lossy().into_owned(),
        "--working-dir".to_string(),
        cwd.to_string_lossy().into_owned(),
        "--workstation-id".to_string(),
        opts.workstation_id.clone(),
        "--runtime-session-id".to_string(),
        job.job_id.clone(),
        "--workstation-display-name".to_string(),
        opts.display_name.clone(),
    ];
    if let Some(notebook_path) = job.notebook_path.as_deref().filter(|path| !path.is_empty()) {
        args.push("--notebook-path".to_string());
        args.push(notebook_path.to_string());
    }

    Ok(AttachJobSpawnPlan {
        args,
        cwd,
        run_root,
        blob_root,
        log_path,
        pid_path,
    })
}

/// Environment for the runtime peer: a minimal allowlist from the parent
/// environment plus the credential under [`CLOUD_TOKEN_ENV`]. Mirrors
/// `buildRuntimeAgentEnv` in `hosted-workstation-agent-core.mjs` — the
/// credential never appears in argv, and no other secret-bearing parent
/// variables leak through.
pub fn build_runtime_agent_env(
    parent: impl Fn(&str) -> Option<String>,
    token: &str,
) -> Vec<(String, String)> {
    let mut env = Vec::new();
    for key in [
        "HOME",
        "PATH",
        "LANG",
        "LC_ALL",
        "SSL_CERT_FILE",
        "SSL_CERT_DIR",
        "RUST_BACKTRACE",
    ] {
        if let Some(value) = parent(key).filter(|value| !value.is_empty()) {
            env.push((key.to_string(), value));
        }
    }
    let rust_log = parent("RUST_LOG")
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "info".to_string());
    env.push(("RUST_LOG".to_string(), rust_log));
    env.push((CLOUD_TOKEN_ENV.to_string(), token.to_string()));
    env
}

/// Does the peer's accumulated log output indicate it reached its main loop?
pub fn log_indicates_ready(log_content: &str) -> bool {
    log_content.contains(READINESS_LINE)
}

/// Extract jobs from the attach-jobs response body: a bare array, `jobs`,
/// or `attach_jobs` (mirrors `normalizeJobs` in the `.mjs` agent).
pub fn normalize_jobs(body: &Value) -> Vec<AttachJob> {
    let list = if body.is_array() {
        Some(body)
    } else {
        body.get("jobs")
            .filter(|v| v.is_array())
            .or_else(|| body.get("attach_jobs").filter(|v| v.is_array()))
    };
    let Some(Value::Array(items)) = list else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| serde_json::from_value(item.clone()).ok())
        .collect()
}

fn workstation_event_name_from_ws_text(text: &str) -> Option<String> {
    serde_json::from_str::<Value>(text)
        .ok()?
        .get("event")?
        .as_str()
        .map(str::to_string)
}

async fn handle_workstation_event_ws_message(
    message: WsMessage,
    tx: &mpsc::Sender<WorkstationControlEvent>,
) -> Result<bool, AgentHttpError> {
    match message {
        WsMessage::Text(text) => {
            if text.as_str() == WORKSTATION_EVENTS_PONG {
                return Ok(true);
            }
            if workstation_event_name_from_ws_text(text.as_str()).as_deref() == Some("attach_jobs")
                && tx.send(WorkstationControlEvent::AttachJobs).await.is_err()
            {
                return Ok(false);
            }
        }
        WsMessage::Binary(bytes) => {
            if let Ok(text) = std::str::from_utf8(&bytes) {
                if workstation_event_name_from_ws_text(text).as_deref() == Some("attach_jobs")
                    && tx.send(WorkstationControlEvent::AttachJobs).await.is_err()
                {
                    return Ok(false);
                }
            }
        }
        WsMessage::Close(_) => {
            return Ok(false);
        }
        WsMessage::Ping(_) | WsMessage::Pong(_) | WsMessage::Frame(_) => {}
    }
    Ok(true)
}

fn workstation_events_ws_url(http_url: &str) -> Result<String, AgentHttpError> {
    if let Some(rest) = http_url.strip_prefix("https://") {
        return Ok(format!("wss://{rest}"));
    }
    if let Some(rest) = http_url.strip_prefix("http://") {
        return Ok(format!("ws://{rest}"));
    }
    Err(AgentHttpError::local(format!(
        "workstation event URL must be http(s): {http_url}"
    )))
}

/// Cooldown hint from a response: nonzero only for 429/503. `Retry-After`
/// may be delta-seconds or an HTTP date; absent/unparseable falls back to
/// [`DEFAULT_RETRY_AFTER_MS`]. Mirrors `retryAfterMs` in the `.mjs` agent.
pub fn retry_after_ms(status: u16, retry_after_header: Option<&str>) -> u64 {
    retry_after_ms_for_statuses(status, retry_after_header, &[429, 503])
}

fn retry_after_ms_for_statuses(
    status: u16,
    retry_after_header: Option<&str>,
    retry_statuses: &[u16],
) -> u64 {
    if !retry_statuses.contains(&status) {
        return 0;
    }
    let Some(header) = retry_after_header.map(str::trim).filter(|h| !h.is_empty()) else {
        return default_retry_after_ms(status);
    };
    if let Ok(seconds) = header.parse::<f64>() {
        if seconds.is_finite() && seconds >= 0.0 {
            return (((seconds * 1000.0).ceil()) as u64).max(1_000);
        }
        return default_retry_after_ms(status);
    }
    if let Ok(date) = chrono::DateTime::parse_from_rfc2822(header) {
        let delta = date.timestamp_millis() - chrono::Utc::now().timestamp_millis();
        return delta.max(1_000) as u64;
    }
    default_retry_after_ms(status)
}

fn default_retry_after_ms(status: u16) -> u64 {
    match status {
        404 | 410 => DEFAULT_MISSING_WORKSTATION_RETRY_AFTER_MS,
        _ => DEFAULT_RETRY_AFTER_MS,
    }
}

/// Exponential cooldown for repeated retryable failures, capped at
/// [`MAX_RETRY_AFTER_MS`] with up to 20% jitter. `jitter_unit` is a value in
/// `[0, 1)` (injected so tests are deterministic). Mirrors `retryCooldownMs`
/// in the `.mjs` agent.
pub fn retry_cooldown_ms(retry_after_ms: u64, failure_count: u32, jitter_unit: f64) -> u64 {
    let retry_after = retry_after_ms.max(1_000);
    let failures = failure_count.max(1);
    let max_delay = retry_after.max(MAX_RETRY_AFTER_MS);
    let exponent = (failures - 1).min(6);
    let base_delay = retry_after.saturating_mul(1u64 << exponent).min(max_delay);
    let jitter = (base_delay as f64 * 0.2 * jitter_unit.clamp(0.0, 1.0)).max(0.0);
    base_delay
        .saturating_add(jitter.ceil() as u64)
        .min(max_delay)
}

/// Pseudo-random unit value for cooldown jitter. `RandomState` keys are
/// random per construction; this is jitter, not cryptography.
fn jitter_unit() -> f64 {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let hash = RandomState::new().build_hasher().finish();
    (hash % 1_000_000) as f64 / 1_000_000.0
}

/// Percent-encode a value for use as one URL path segment
/// (`encodeURIComponent` for the characters that matter in ids).
fn encode_path_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push_str(&format!("{byte:02X}"));
            }
        }
    }
    out
}

/// Parse an HTTP response body the way the `.mjs` agent does: empty → `{}`,
/// JSON → the value, anything else → `{"error": <first 500 chars>}` so HTML
/// error pages stay diagnosable.
pub fn parse_response_body(text: &str) -> Value {
    if text.trim().is_empty() {
        return json!({});
    }
    match serde_json::from_str(text) {
        Ok(value) => value,
        Err(_) => json!({ "error": text.chars().take(500).collect::<String>() }),
    }
}

/// Error from one cloud call, carrying the rate-limit cooldown hint.
#[derive(Debug)]
pub struct AgentHttpError {
    pub message: String,
    pub retry_after_ms: u64,
    status: Option<u16>,
    body: Value,
}

impl AgentHttpError {
    fn local(message: String) -> Self {
        Self {
            message,
            retry_after_ms: 0,
            status: None,
            body: Value::Null,
        }
    }
}

impl std::fmt::Display for AgentHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AgentHttpError {}

/// Thin client for the three workstation-surface endpoints. All calls carry
/// `Authorization: Bearer <workstation credential>`.
#[derive(Clone)]
struct CloudApi {
    client: reqwest::Client,
    base: String,
    token: String,
}

impl CloudApi {
    fn new(cloud_url: &str, token: String) -> Result<Self> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(30))
            .build()
            .context("build HTTP client")?;
        Ok(Self {
            client,
            base: cloud_url.trim_end_matches('/').to_string(),
            token,
        })
    }

    async fn register_workstation(&self, payload: &Value) -> Result<(), AgentHttpError> {
        let url = format!("{}/api/workstations", self.base);
        self.execute(
            "register workstation",
            self.client.post(&url).json(payload),
            &[200, 201],
        )
        .await?;
        Ok(())
    }

    async fn poll_attach_jobs(
        &self,
        workstation_id: &str,
    ) -> Result<Vec<AttachJob>, AgentHttpError> {
        let url = format!(
            "{}/api/workstations/{}/attach-jobs",
            self.base,
            encode_path_segment(workstation_id)
        );
        let body = self
            .execute_with_retry_statuses(
                "poll attach jobs",
                self.client.get(&url),
                &[200],
                &[404, 410, 429, 503],
            )
            .await?;
        Ok(normalize_jobs(&body))
    }

    async fn connect_workstation_events(
        &self,
        workstation_id: &str,
        tx: mpsc::Sender<WorkstationControlEvent>,
    ) -> Result<(), AgentHttpError> {
        let http_url = format!(
            "{}/api/workstations/{}/events",
            self.base,
            encode_path_segment(workstation_id)
        );
        let ws_url = workstation_events_ws_url(&http_url)?;
        let mut request = ws_url.as_str().into_client_request().map_err(|e| {
            AgentHttpError::local(format!("build workstation event websocket: {e}"))
        })?;
        let auth = HeaderValue::from_str(&format!("Bearer {}", self.token)).map_err(|e| {
            AgentHttpError::local(format!("build workstation event auth header: {e}"))
        })?;
        request.headers_mut().insert(AUTHORIZATION, auth);

        let (ws, _response) = match connect_async(request).await {
            Ok(ok) => ok,
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                let status = response.status().as_u16();
                let retry_after_header = response
                    .headers()
                    .get("retry-after")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string);
                let body = response
                    .into_body()
                    .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
                    .map(|text| parse_response_body(&text))
                    .unwrap_or_else(|| json!({}));
                let snippet: String = serde_json::to_string(&body)
                    .unwrap_or_default()
                    .chars()
                    .take(500)
                    .collect();
                return Err(AgentHttpError {
                    message: format!("connect workstation events failed: HTTP {status} {snippet}"),
                    retry_after_ms: retry_after_ms_for_statuses(
                        status,
                        retry_after_header.as_deref(),
                        &[404, 410, 429, 503],
                    ),
                    status: Some(status),
                    body,
                });
            }
            Err(error) => {
                return Err(AgentHttpError::local(format!(
                    "connect workstation events failed: {error}"
                )));
            }
        };

        let (mut write, mut read) = ws.split();
        loop {
            let message = match tokio::time::timeout(
                Duration::from_millis(WORKSTATION_EVENTS_IDLE_TIMEOUT_MS),
                read.next(),
            )
            .await
            {
                Ok(Some(message)) => message.map_err(|e| {
                    AgentHttpError::local(format!("read workstation event websocket: {e}"))
                })?,
                Ok(None) => return Ok(()),
                Err(_) => {
                    write
                        .send(WsMessage::Text(WORKSTATION_EVENTS_PING.into()))
                        .await
                        .map_err(|e| {
                            AgentHttpError::local(format!("ping workstation event websocket: {e}"))
                        })?;
                    match tokio::time::timeout(
                        Duration::from_millis(WORKSTATION_EVENTS_PING_TIMEOUT_MS),
                        read.next(),
                    )
                    .await
                    {
                        Ok(Some(message)) => message.map_err(|e| {
                            AgentHttpError::local(format!(
                                "read workstation event websocket after ping: {e}"
                            ))
                        })?,
                        Ok(None) => return Ok(()),
                        Err(_) => {
                            return Err(AgentHttpError::local(
                                "workstation event websocket idle timeout".to_string(),
                            ));
                        }
                    }
                }
            };
            if !handle_workstation_event_ws_message(message, &tx).await? {
                return Ok(());
            }
        }
    }

    async fn patch_attach_job(
        &self,
        workstation_id: &str,
        job_id: &str,
        status: &str,
        error_message: Option<&str>,
    ) -> Result<(), AgentHttpError> {
        let url = format!(
            "{}/api/workstations/{}/attach-jobs/{}",
            self.base,
            encode_path_segment(workstation_id),
            encode_path_segment(job_id)
        );
        let mut payload = json!({ "status": status });
        if let Some(message) = error_message {
            payload["error_message"] = message.into();
        }
        self.execute(
            &format!("patch attach job {job_id}"),
            self.client.patch(&url).json(&payload),
            &[200, 204],
        )
        .await?;
        Ok(())
    }

    async fn execute(
        &self,
        label: &str,
        request: reqwest::RequestBuilder,
        expected_statuses: &[u16],
    ) -> Result<Value, AgentHttpError> {
        self.execute_with_retry_statuses(label, request, expected_statuses, &[429, 503])
            .await
    }

    async fn execute_with_retry_statuses(
        &self,
        label: &str,
        request: reqwest::RequestBuilder,
        expected_statuses: &[u16],
        retry_statuses: &[u16],
    ) -> Result<Value, AgentHttpError> {
        let response = request
            .timeout(Duration::from_secs(30))
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|e| AgentHttpError::local(format!("{label} failed: {e}")))?;
        let status = response.status().as_u16();
        let retry_after_header = response
            .headers()
            .get("retry-after")
            .and_then(|value| value.to_str().ok())
            .map(str::to_string);
        let text = response.text().await.unwrap_or_default();
        let body = parse_response_body(&text);
        if expected_statuses.contains(&status) {
            return Ok(body);
        }
        let snippet: String = serde_json::to_string(&body)
            .unwrap_or_default()
            .chars()
            .take(500)
            .collect();
        Err(AgentHttpError {
            message: format!("{label} failed: HTTP {status} {snippet}"),
            retry_after_ms: retry_after_ms_for_statuses(
                status,
                retry_after_header.as_deref(),
                retry_statuses,
            ),
            status: Some(status),
            body,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkstationControlEvent {
    AttachJobs,
}

async fn run_workstation_event_listener(
    api: CloudApi,
    workstation_id: String,
    tx: mpsc::Sender<WorkstationControlEvent>,
) {
    let mut reconnect_delay = Duration::from_secs(1);
    loop {
        if tx.is_closed() {
            return;
        }
        match api
            .connect_workstation_events(&workstation_id, tx.clone())
            .await
        {
            Ok(()) => {
                warn!("[workstation-agent] workstation event socket closed; reconnecting");
                reconnect_delay = Duration::from_secs(1);
            }
            Err(error) => {
                if error.status == Some(404) || error.status == Some(503) {
                    warn!(
                        "[workstation-agent] workstation event socket unavailable; using fallback polling: {}",
                        error.message
                    );
                } else {
                    warn!(
                        "[workstation-agent] workstation event socket failed; reconnecting: {}",
                        error.message
                    );
                }
                reconnect_delay = retry_event_socket_delay(reconnect_delay, error.retry_after_ms);
            }
        }
        tokio::time::sleep(reconnect_delay).await;
    }
}

fn retry_event_socket_delay(previous: Duration, retry_after_ms: u64) -> Duration {
    if retry_after_ms > 0 {
        return Duration::from_millis(retry_after_ms).min(Duration::from_secs(60));
    }
    previous.saturating_mul(2).min(Duration::from_secs(60))
}

/// One job this agent is responsible for. `child` is `Some` for peers this
/// process spawned and `None` for peers adopted after an agent restart
/// (tracked by pid + log file instead).
struct ActiveJob {
    child: Option<tokio::process::Child>,
    pid: Option<u32>,
    log_path: PathBuf,
    pid_path: PathBuf,
    ready: bool,
    status: &'static str,
    started_at: Instant,
    last_status_patch_at: Instant,
}

enum JobTick {
    None,
    BecameReady,
    Exited {
        success: bool,
        error_message: Option<String>,
    },
}

/// Tracks per-step retryable failures and the shared cooldown window
/// (port of the `.mjs` `runAgentStep` bookkeeping).
#[derive(Default)]
struct StepTracker {
    failure_counts: HashMap<&'static str, u32>,
    cooldown_until: Option<Instant>,
}

impl StepTracker {
    fn cooldown_remaining(&mut self) -> Option<Duration> {
        let until = self.cooldown_until?;
        let now = Instant::now();
        if until <= now {
            self.cooldown_until = None;
            return None;
        }
        Some(until - now)
    }

    /// `Ok(true)` means the step completed a cloud round-trip, which resets
    /// its failure streak. Retryable errors (rate limits) extend the shared
    /// cooldown with exponential backoff.
    fn record(&mut self, step: &'static str, result: Result<bool, AgentHttpError>) {
        match result {
            Ok(made_cloud_request) => {
                if made_cloud_request {
                    self.failure_counts.remove(step);
                }
            }
            Err(err) => {
                if err.retry_after_ms > 0 {
                    let count = self.failure_counts.entry(step).or_insert(0);
                    *count += 1;
                    let cooldown_ms = retry_cooldown_ms(err.retry_after_ms, *count, jitter_unit());
                    let until = Instant::now() + Duration::from_millis(cooldown_ms);
                    self.cooldown_until =
                        Some(self.cooldown_until.map_or(until, |cur| cur.max(until)));
                    warn!(
                        "[workstation-agent] cooling down step={step} retry_after_ms={} cooldown_ms={cooldown_ms} retryable_failures={count}",
                        err.retry_after_ms
                    );
                }
                error!(
                    "[workstation-agent] step failed step={step}: {}",
                    err.message
                );
            }
        }
    }
}

/// Run the workstation agent loop until the process is terminated.
pub async fn run_workstation_agent(opts: WorkstationAgentOptions, token: String) -> Result<()> {
    let api = CloudApi::new(&opts.cloud_url, token.clone())?;
    std::fs::create_dir_all(&opts.agent_root).with_context(|| {
        format!(
            "create workstation agent root {}",
            opts.agent_root.display()
        )
    })?;
    let _agent_lock = WorkstationAgentLock::try_acquire(&opts.agent_root, &opts.workstation_id)?;

    info!(
        "[workstation-agent] starting cloud_url={} workstation_id={} display_name={:?} working_dir={} python_path={} poll_ms={} heartbeat_ms={} agent_root={}",
        opts.cloud_url,
        opts.workstation_id,
        opts.display_name,
        opts.working_dir.display(),
        opts.python_path.display(),
        opts.poll_interval.as_millis(),
        opts.heartbeat_interval.as_millis(),
        opts.agent_root.display(),
    );

    let mut active: HashMap<String, ActiveJob> = HashMap::new();
    let mut last_registration: Option<Instant> = None;
    let mut last_poll: Option<Instant> = None;
    let mut poll_requested = true;
    let mut event_socket_closed = false;
    let mut tracker = StepTracker::default();
    let (event_tx, mut event_rx) = mpsc::channel(16);
    let _event_listener = tokio::spawn(run_workstation_event_listener(
        api.clone(),
        opts.workstation_id.clone(),
        event_tx,
    ));

    loop {
        if let Some(remaining) = tracker.cooldown_remaining() {
            tokio::time::sleep(remaining.min(opts.poll_interval)).await;
            continue;
        }

        // Register on startup and refresh workstation metadata periodically.
        // The event socket is the fast attach-job wakeup path; this heartbeat is
        // the durable fallback that keeps a locally-running workstation visible
        // if that socket is missed, half-open, or blocked by an intermediary.
        if should_register_workstation(last_registration, opts.heartbeat_interval) {
            let result = heartbeat(&api, &opts).await;
            if result.is_ok() {
                last_registration = Some(Instant::now());
            }
            tracker.record("heartbeat", result.map(|()| true));
        }
        if tracker.cooldown_remaining().is_some() {
            continue;
        }

        if !event_socket_closed {
            while let Ok(WorkstationControlEvent::AttachJobs) = event_rx.try_recv() {
                poll_requested = true;
            }
        }

        // Accept/adopt attach jobs. The event socket is the fast wakeup path; this fallback
        // poll catches missed events, server versions without /events, and
        // jobs that existed before this agent started.
        if poll_requested || last_poll.is_none_or(|at| at.elapsed() >= opts.poll_interval) {
            let result = poll_attach_jobs(&api, &opts, &token, &mut active).await;
            last_poll = Some(Instant::now());
            poll_requested = false;
            tracker.record("poll_attach_jobs", result);
        }

        // Periodic status re-patch so the cloud sees active jobs as live.
        let result = heartbeat_active_jobs(&api, &opts, &mut active).await;
        tracker.record("heartbeat_active_jobs", result);

        // Watch children at a finer tick than the fallback poll interval so
        // readiness and exits land promptly (the `.mjs` agent's 250ms
        // readyPoll), but sleep cheaply while idle.
        let next_poll_at = last_poll.map_or_else(Instant::now, |at| at + opts.poll_interval);
        let deadline = next_registration_deadline(last_registration, opts.heartbeat_interval)
            .map_or(next_poll_at, |next_registration_at| {
                next_poll_at.min(next_registration_at)
            });
        loop {
            tick_active_jobs(&api, &opts, &mut active).await;
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let sleep_for = if active.is_empty() {
                deadline - now
            } else {
                Duration::from_millis(CHILD_TICK_MS).min(deadline - now)
            };
            tokio::select! {
                event = event_rx.recv(), if !event_socket_closed => {
                    match event {
                        Some(WorkstationControlEvent::AttachJobs) => {
                            poll_requested = true;
                            break;
                        }
                        None => {
                            event_socket_closed = true;
                        }
                    }
                }
                _ = tokio::time::sleep(sleep_for) => {}
            }
        }
    }
}

struct WorkstationAgentLock {
    _lock_file: File,
    lock_path: PathBuf,
}

impl WorkstationAgentLock {
    fn try_acquire(agent_root: &Path, workstation_id: &str) -> Result<Self> {
        let lock_dir = workstation_agent_lock_dir(agent_root);
        std::fs::create_dir_all(lock_dir)
            .with_context(|| format!("create workstation agent lock dir {}", lock_dir.display()))?;
        let lock_path = workstation_agent_lock_path(agent_root, workstation_id);
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)
            .with_context(|| format!("open workstation agent lock {}", lock_path.display()))?;

        #[cfg(unix)]
        {
            let result =
                unsafe { libc::flock(lock_file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
            anyhow::ensure!(
                result == 0,
                "another workstation agent is already running for {workstation_id} (lock {})",
                lock_path.display()
            );
        }

        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            use windows_sys::Win32::Foundation::HANDLE;
            use windows_sys::Win32::Storage::FileSystem::{
                LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
            };

            let handle = lock_file.as_raw_handle() as HANDLE;
            let mut overlapped = unsafe { std::mem::zeroed() };
            let result = unsafe {
                LockFileEx(
                    handle,
                    LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
                    0,
                    1,
                    0,
                    &mut overlapped,
                )
            };
            anyhow::ensure!(
                result != 0,
                "another workstation agent is already running for {workstation_id} (lock {})",
                lock_path.display()
            );
        }

        info!(
            "[workstation-agent] acquired local singleton lock path={}",
            lock_path.display()
        );
        Ok(Self {
            _lock_file: lock_file,
            lock_path,
        })
    }
}

impl Drop for WorkstationAgentLock {
    fn drop(&mut self) {
        #[cfg(unix)]
        unsafe {
            let _ = libc::flock(self._lock_file.as_raw_fd(), libc::LOCK_UN);
        }
        info!(
            "[workstation-agent] released local singleton lock path={}",
            self.lock_path.display()
        );
    }
}

fn workstation_agent_lock_path(agent_root: &Path, workstation_id: &str) -> PathBuf {
    workstation_agent_lock_dir(agent_root).join(format!(
        "workstation-{}.lock",
        runt_workspace::safe_path_part(workstation_id)
    ))
}

fn workstation_agent_lock_dir(agent_root: &Path) -> &Path {
    if agent_root
        .file_name()
        .is_some_and(|name| name == "workstation-agent")
    {
        return agent_root.parent().unwrap_or(agent_root);
    }
    agent_root
}

async fn heartbeat(api: &CloudApi, opts: &WorkstationAgentOptions) -> Result<(), AgentHttpError> {
    let payload = registration_payload(
        &opts.workstation_id,
        &opts.display_name,
        &opts.working_dir.to_string_lossy(),
        &opts.python_path.to_string_lossy(),
        cpu_count(),
        total_memory_bytes(),
    );
    api.register_workstation(&payload).await
}

fn should_register_workstation(
    last_registration: Option<Instant>,
    heartbeat_interval: Duration,
) -> bool {
    if last_registration.is_none() {
        return true;
    }
    last_registration.is_some_and(|at| at.elapsed() >= heartbeat_interval)
}

fn next_registration_deadline(
    last_registration: Option<Instant>,
    heartbeat_interval: Duration,
) -> Option<Instant> {
    match last_registration {
        None => Some(Instant::now()),
        Some(at) => Some(at + heartbeat_interval),
    }
}

async fn poll_attach_jobs(
    api: &CloudApi,
    opts: &WorkstationAgentOptions,
    token: &str,
    active: &mut HashMap<String, ActiveJob>,
) -> Result<bool, AgentHttpError> {
    let poll_started = Instant::now();
    let jobs = api.poll_attach_jobs(&opts.workstation_id).await?;
    let actionable_job_count = jobs
        .iter()
        .filter(|job| !active.contains_key(&job.job_id))
        .count();
    if actionable_job_count > 0 {
        info!(
            "[workstation-agent] attach jobs polled count={} elapsed_ms={}",
            actionable_job_count,
            poll_started.elapsed().as_millis()
        );
    }
    for job in jobs {
        if active.contains_key(&job.job_id) {
            continue;
        }
        if job.status == "pending" {
            start_attach_job(api, opts, token, active, &job).await?;
        } else {
            reconcile_active_attach_job(api, opts, active, &job).await?;
        }
    }
    Ok(true)
}

async fn start_attach_job(
    api: &CloudApi,
    opts: &WorkstationAgentOptions,
    token: &str,
    active: &mut HashMap<String, ActiveJob>,
    job: &AttachJob,
) -> Result<(), AgentHttpError> {
    let attach_started = Instant::now();
    let plan = build_attach_job_spawn_plan(job, opts)
        .map_err(|e| AgentHttpError::local(format!("plan attach job: {e}")))?;
    std::fs::create_dir_all(&plan.blob_root).map_err(|e| {
        AgentHttpError::local(format!(
            "create blob root {}: {e}",
            plan.blob_root.display()
        ))
    })?;

    let accept_started = Instant::now();
    api.patch_attach_job(&opts.workstation_id, &job.job_id, "accepted", None)
        .await?;
    info!(
        "[workstation-agent] attach job accepted job_id={} notebook_id={} accept_elapsed_ms={} elapsed_ms={}",
        job.job_id,
        job.notebook_id,
        accept_started.elapsed().as_millis(),
        attach_started.elapsed().as_millis()
    );

    let spawn_started = Instant::now();
    match spawn_runtime_peer(&plan, token) {
        Ok((child, pid)) => {
            if let Some(pid) = pid {
                write_pid_file(&plan.pid_path, pid);
            }
            info!(
                "[workstation-agent] attach job spawned job_id={} notebook_id={} pid={:?} spawn_elapsed_ms={} elapsed_ms={} log={}",
                job.job_id,
                job.notebook_id,
                pid,
                spawn_started.elapsed().as_millis(),
                attach_started.elapsed().as_millis(),
                plan.log_path.display()
            );
            let now = Instant::now();
            active.insert(
                job.job_id.clone(),
                ActiveJob {
                    child: Some(child),
                    pid,
                    log_path: plan.log_path,
                    pid_path: plan.pid_path,
                    ready: false,
                    status: "accepted",
                    started_at: now,
                    last_status_patch_at: now,
                },
            );
        }
        Err(e) => {
            error!(
                "[workstation-agent] attach job spawn failed job_id={}: {e}",
                job.job_id
            );
            if let Err(patch_err) = api
                .patch_attach_job(
                    &opts.workstation_id,
                    &job.job_id,
                    "failed",
                    Some(&format!("Failed to spawn runtime peer: {e}")),
                )
                .await
            {
                error!(
                    "[workstation-agent] spawn-failure patch failed job_id={}: {}",
                    job.job_id, patch_err.message
                );
            }
        }
    }
    Ok(())
}

/// A job the cloud believes is `accepted`/`running` but this agent does not
/// own — typically after an agent restart. Adopt it when its recorded pid is
/// still alive; otherwise report the peer gone (the `.mjs` recovery path).
async fn reconcile_active_attach_job(
    api: &CloudApi,
    opts: &WorkstationAgentOptions,
    active: &mut HashMap<String, ActiveJob>,
    job: &AttachJob,
) -> Result<(), AgentHttpError> {
    let plan = build_attach_job_spawn_plan(job, opts)
        .map_err(|e| AgentHttpError::local(format!("plan attach job: {e}")))?;
    let pid = read_pid_file(&plan.pid_path);
    if let Some(pid) = pid.filter(|&pid| process_exists(pid)) {
        let ready = job.status == "running";
        info!(
            "[workstation-agent] attach job adopted job_id={} notebook_id={} pid={pid} status={}",
            job.job_id,
            job.notebook_id,
            if ready { "running" } else { "accepted" }
        );
        // Backdate the patch clock so the next heartbeat re-patches the
        // status promptly (`lastStatusPatchAt: 0` in the `.mjs` agent).
        let backdated = Instant::now()
            .checked_sub(opts.heartbeat_interval)
            .unwrap_or_else(Instant::now);
        active.insert(
            job.job_id.clone(),
            ActiveJob {
                child: None,
                pid: Some(pid),
                log_path: plan.log_path,
                pid_path: plan.pid_path,
                ready,
                status: if ready { "running" } else { "accepted" },
                started_at: backdated,
                last_status_patch_at: backdated,
            },
        );
        return Ok(());
    }

    warn!(
        "[workstation-agent] attach job recovery failed job_id={} notebook_id={} status={} pid_path={}",
        job.job_id,
        job.notebook_id,
        job.status,
        plan.pid_path.display()
    );
    let failure_message = format!(
        "Runtime peer for {} attach job was not running after workstation agent restart",
        job.status
    );
    match api
        .patch_attach_job(
            &opts.workstation_id,
            &job.job_id,
            "failed",
            Some(&failure_message),
        )
        .await
    {
        Ok(()) => {
            remove_stale_pid_file(&plan.pid_path);
            Ok(())
        }
        Err(error) if attach_job_patch_no_longer_active(&error) => {
            remove_stale_pid_file(&plan.pid_path);
            info!(
                "[workstation-agent] recovery patch ignored for inactive job job_id={}",
                job.job_id
            );
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn remove_stale_pid_file(path: &Path) {
    match std::fs::remove_file(path) {
        Ok(()) => {
            info!(
                "[workstation-agent] removed stale runtime peer pid file path={}",
                path.display()
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            warn!(
                "[workstation-agent] stale pid file cleanup failed path={}: {error}",
                path.display()
            );
        }
    }
}

async fn heartbeat_active_jobs(
    api: &CloudApi,
    opts: &WorkstationAgentOptions,
    active: &mut HashMap<String, ActiveJob>,
) -> Result<bool, AgentHttpError> {
    let due: Vec<String> = active
        .iter()
        .filter(|(_, job)| job.last_status_patch_at.elapsed() >= opts.heartbeat_interval)
        .map(|(job_id, _)| job_id.clone())
        .collect();
    for job_id in &due {
        let status = match active.get(job_id) {
            Some(job) => job.status,
            None => continue,
        };
        if let Err(error) = api
            .patch_attach_job(&opts.workstation_id, job_id, status, None)
            .await
        {
            if drop_terminal_attach_job(active, job_id, "heartbeat", &error).await {
                continue;
            }
            return Err(error);
        }
        if let Some(job) = active.get_mut(job_id) {
            job.last_status_patch_at = Instant::now();
        }
    }
    Ok(!due.is_empty())
}

async fn tick_active_jobs(
    api: &CloudApi,
    opts: &WorkstationAgentOptions,
    active: &mut HashMap<String, ActiveJob>,
) {
    let job_ids: Vec<String> = active.keys().cloned().collect();
    for job_id in job_ids {
        let outcome = match active.get_mut(&job_id) {
            Some(job) => poll_job_once(&job_id, job),
            None => continue,
        };
        match outcome {
            JobTick::None => {}
            JobTick::BecameReady => {
                let ready_elapsed_ms = active
                    .get(&job_id)
                    .map(|job| job.started_at.elapsed().as_millis())
                    .unwrap_or_default();
                // Mark ready before patching: if the patch fails, the periodic
                // status heartbeat re-sends "running" (same healing path as
                // the `.mjs` agent).
                if let Some(job) = active.get_mut(&job_id) {
                    job.ready = true;
                    job.status = "running";
                    job.last_status_patch_at = Instant::now();
                }
                info!(
                    "[workstation-agent] attach job ready job_id={job_id} elapsed_ms={ready_elapsed_ms}"
                );
                if let Err(e) = api
                    .patch_attach_job(&opts.workstation_id, &job_id, "running", None)
                    .await
                {
                    if drop_terminal_attach_job(active, &job_id, "ready patch", &e).await {
                        continue;
                    }
                    error!(
                        "[workstation-agent] ready patch failed job_id={job_id}: {}",
                        e.message
                    );
                }
            }
            JobTick::Exited {
                success,
                error_message,
            } => {
                if let Some(job) = active.remove(&job_id) {
                    remove_stale_pid_file(&job.pid_path);
                }
                info!(
                    "[workstation-agent] attach job exited job_id={job_id} success={success} error={:?}",
                    error_message
                );
                let status = if success { "completed" } else { "failed" };
                if let Err(e) = api
                    .patch_attach_job(
                        &opts.workstation_id,
                        &job_id,
                        status,
                        error_message.as_deref(),
                    )
                    .await
                {
                    // Job already dropped from the active set; the server's
                    // stale-job sweep finishes it if this patch never lands.
                    if attach_job_patch_no_longer_active(&e) {
                        info!(
                            "[workstation-agent] exit patch ignored for inactive job job_id={job_id}"
                        );
                    } else {
                        error!(
                            "[workstation-agent] exit patch failed job_id={job_id}: {}",
                            e.message
                        );
                    }
                }
            }
        }
    }
}

async fn drop_terminal_attach_job(
    active: &mut HashMap<String, ActiveJob>,
    job_id: &str,
    context: &str,
    error: &AgentHttpError,
) -> bool {
    if !attach_job_patch_no_longer_active(error) {
        return false;
    }
    let job = active.remove(job_id);
    if let Some(job) = job {
        remove_stale_pid_file(&job.pid_path);
        terminate_active_job(job).await;
    }
    info!(
        "[workstation-agent] attach job no longer active; dropped local peer job_id={job_id} context={context}"
    );
    true
}

fn attach_job_patch_no_longer_active(error: &AgentHttpError) -> bool {
    if error.status != Some(409) {
        return false;
    }
    let error_message = error
        .body
        .get("error")
        .and_then(Value::as_str)
        .unwrap_or("");
    if error_message.contains("workstation attach job is no longer active") {
        return true;
    }
    matches!(
        error.body.pointer("/job/status").and_then(Value::as_str),
        Some("cancelled" | "completed" | "failed")
    )
}

async fn terminate_active_job(mut job: ActiveJob) {
    if let Some(child) = job.child.as_mut() {
        if let Err(error) = request_child_shutdown(child) {
            warn!("[workstation-agent] failed to request inactive child shutdown: {error}");
        }
        match tokio::time::timeout(Duration::from_secs(5), child.wait()).await {
            Ok(Ok(_status)) => {}
            Ok(Err(error)) => {
                warn!("[workstation-agent] failed to reap inactive child job: {error}");
            }
            Err(_) => {
                warn!("[workstation-agent] timed out waiting for inactive child shutdown; killing");
                if let Err(error) = child.start_kill() {
                    warn!("[workstation-agent] failed to kill inactive child job: {error}");
                    return;
                }
                match tokio::time::timeout(Duration::from_secs(2), child.wait()).await {
                    Ok(Ok(_status)) => {}
                    Ok(Err(error)) => {
                        warn!(
                            "[workstation-agent] failed to reap killed inactive child job: {error}"
                        );
                    }
                    Err(_) => {
                        warn!("[workstation-agent] timed out reaping killed inactive child job");
                    }
                }
            }
        }
        return;
    }
    if let Some(pid) = job.pid {
        terminate_pid(pid);
    }
}

#[cfg(unix)]
fn request_child_shutdown(child: &mut tokio::process::Child) -> std::result::Result<(), String> {
    let Some(pid) = child.id() else {
        return Ok(());
    };
    let pid = i32::try_from(pid).map_err(|error| format!("invalid child pid {pid}: {error}"))?;
    nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid),
        Some(nix::sys::signal::Signal::SIGTERM),
    )
    .map_err(|error| format!("SIGTERM pid={pid}: {error}"))
}

#[cfg(not(unix))]
fn request_child_shutdown(child: &mut tokio::process::Child) -> std::result::Result<(), String> {
    child.start_kill().map_err(|error| error.to_string())
}

#[cfg(unix)]
fn terminate_pid(pid: u32) {
    let Ok(pid) = i32::try_from(pid) else {
        return;
    };
    if let Err(error) = nix::sys::signal::kill(
        nix::unistd::Pid::from_raw(pid),
        Some(nix::sys::signal::Signal::SIGTERM),
    ) {
        warn!("[workstation-agent] failed to terminate inactive pid={pid}: {error}");
    }
}

#[cfg(not(unix))]
fn terminate_pid(_pid: u32) {}

fn poll_job_once(job_id: &str, job: &mut ActiveJob) -> JobTick {
    if let Some(child) = job.child.as_mut() {
        match child.try_wait() {
            Ok(Some(status)) => {
                return if status.success() {
                    JobTick::Exited {
                        success: true,
                        error_message: None,
                    }
                } else {
                    JobTick::Exited {
                        success: false,
                        error_message: Some(exit_status_message(&status)),
                    }
                };
            }
            Ok(None) => {}
            Err(e) => {
                warn!("[workstation-agent] try_wait failed job_id={job_id}: {e}");
            }
        }
    } else if let Some(pid) = job.pid {
        if !process_exists(pid) {
            let message = if job.ready {
                "Runtime peer exited before the workstation agent could observe it"
            } else {
                "Runtime peer exited before completing workstation agent recovery"
            };
            return JobTick::Exited {
                success: false,
                error_message: Some(message.to_string()),
            };
        }
    }

    if !job.ready {
        let log_content = std::fs::read_to_string(&job.log_path).unwrap_or_default();
        if log_indicates_ready(&log_content) {
            return JobTick::BecameReady;
        }
    }
    JobTick::None
}

fn exit_status_message(status: &std::process::ExitStatus) -> String {
    #[cfg(unix)]
    let signal = {
        use std::os::unix::process::ExitStatusExt;
        status.signal()
    };
    #[cfg(not(unix))]
    let signal = None;
    format_runtime_peer_exit_message(status.code(), signal)
}

fn format_runtime_peer_exit_message(code: Option<i32>, signal: Option<i32>) -> String {
    match (code, signal) {
        (Some(code), Some(signal)) => {
            format!("Runtime peer exited with code={code}, signal={signal}")
        }
        (Some(code), None) => format!("Runtime peer exited with code={code}"),
        (None, Some(signal)) => format!("Runtime peer exited with signal={signal}"),
        (None, None) => "Runtime peer exited".to_string(),
    }
}

fn spawn_runtime_peer(
    plan: &AttachJobSpawnPlan,
    token: &str,
) -> Result<(tokio::process::Child, Option<u32>)> {
    // The workstation agent IS runtimed: spawn our own binary as the peer.
    let exe = std::env::current_exe().context("resolve current runtimed binary")?;
    // The peer writes straight to the log file (no pipe): an orphaned peer
    // can never block on a dead pipe reader, and a restarted agent can read
    // the same file to adopt the job.
    let log = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&plan.log_path)
        .with_context(|| format!("open runtime peer log {}", plan.log_path.display()))?;
    let log_for_stderr = log
        .try_clone()
        .context("clone runtime peer log handle for stderr")?;

    let mut command = tokio::process::Command::new(exe);
    command
        .args(&plan.args)
        .current_dir(&plan.cwd)
        .env_clear()
        .envs(build_runtime_agent_env(
            |key| std::env::var(key).ok(),
            token,
        ))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::from(log))
        .stderr(std::process::Stdio::from(log_for_stderr));
    // Default kill_on_drop=false: the peer (and its kernel) outlives an agent
    // crash/restart, which is what makes adoption possible.
    let child = command
        .spawn()
        .with_context(|| format!("spawn runtime peer in {}", plan.cwd.display()))?;
    let pid = child.id();
    Ok((child, pid))
}

fn write_pid_file(path: &Path, pid: u32) {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    match options.open(path) {
        Ok(mut file) => {
            if let Err(e) = writeln!(file, "{pid}") {
                warn!(
                    "[workstation-agent] pid file write failed path={}: {e}",
                    path.display()
                );
            }
        }
        Err(e) => {
            warn!(
                "[workstation-agent] pid file open failed path={}: {e}",
                path.display()
            );
        }
    }
}

fn read_pid_file(path: &Path) -> Option<u32> {
    let raw = std::fs::read_to_string(path).ok()?;
    let pid: u32 = raw.trim().parse().ok()?;
    (pid > 0).then_some(pid)
}

#[cfg(unix)]
fn process_exists(pid: u32) -> bool {
    let Ok(pid) = i32::try_from(pid) else {
        return false;
    };
    // Signal 0: existence check without delivering anything.
    nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_ok()
}

#[cfg(not(unix))]
fn process_exists(_pid: u32) -> bool {
    // No cheap existence probe on this platform; adopted jobs are treated as
    // gone and re-dispatched (the server sweep also covers them).
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> WorkstationAgentOptions {
        WorkstationAgentOptions {
            cloud_url: "https://preview.runt.run".to_string(),
            workstation_id: "ws-lab2".to_string(),
            display_name: "lab2 workstation".to_string(),
            working_dir: PathBuf::from("/home/ubuntu/project"),
            python_path: PathBuf::from("/opt/k/bin/python"),
            poll_interval: Duration::from_millis(DEFAULT_POLL_MS),
            heartbeat_interval: Duration::from_millis(DEFAULT_HEARTBEAT_MS),
            agent_root: PathBuf::from("/tmp/agent"),
        }
    }

    fn job(job_id: &str, notebook_id: &str) -> AttachJob {
        AttachJob {
            job_id: job_id.to_string(),
            notebook_id: notebook_id.to_string(),
            status: "pending".to_string(),
            working_directory: None,
            notebook_path: None,
        }
    }

    fn http_error(status: u16, body: Value) -> AgentHttpError {
        AgentHttpError {
            message: format!("HTTP {status} {body}"),
            retry_after_ms: retry_after_ms(status, None),
            status: Some(status),
            body,
        }
    }

    fn active_job() -> ActiveJob {
        ActiveJob {
            child: None,
            pid: None,
            log_path: PathBuf::from("/tmp/runtime-peer.log"),
            pid_path: PathBuf::from("/tmp/runtime-peer.pid"),
            ready: true,
            status: "running",
            started_at: Instant::now(),
            last_status_patch_at: Instant::now(),
        }
    }

    #[test]
    fn workstation_agent_lock_prevents_duplicate_runner() -> Result<()> {
        let tmp = tempfile::TempDir::new()?;
        let root = tmp.path();
        let first = WorkstationAgentLock::try_acquire(root, "ws-lab2")?;

        let Err(error) = WorkstationAgentLock::try_acquire(root, "ws-lab2") else {
            anyhow::bail!("second workstation agent lock should fail while first is held");
        };
        assert!(error
            .to_string()
            .contains("another workstation agent is already running"));

        drop(first);
        let _second = WorkstationAgentLock::try_acquire(root, "ws-lab2")?;
        Ok(())
    }

    #[test]
    fn workstation_agent_lock_uses_daemon_base_dir_for_standard_agent_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let agent_root = tmp.path().join("workstation-agent");

        assert_eq!(
            workstation_agent_lock_path(&agent_root, "ws-lab2"),
            tmp.path().join("workstation-ws-lab2.lock")
        );
    }

    #[test]
    fn runtime_peer_exit_messages_omit_empty_details() {
        assert_eq!(
            format_runtime_peer_exit_message(Some(1), None),
            "Runtime peer exited with code=1"
        );
        assert_eq!(
            format_runtime_peer_exit_message(None, Some(15)),
            "Runtime peer exited with signal=15"
        );
        assert_eq!(
            format_runtime_peer_exit_message(Some(1), Some(15)),
            "Runtime peer exited with code=1, signal=15"
        );
        assert_eq!(
            format_runtime_peer_exit_message(None, None),
            "Runtime peer exited"
        );
    }

    /// (c) Heartbeat payload field set matches the `.mjs` agent exactly.
    #[test]
    fn registration_payload_matches_mjs_field_set() {
        let payload = registration_payload(
            "ws-lab2",
            "lab2 workstation",
            "/home/ubuntu/project",
            "/opt/k/bin/python",
            Some(8),
            Some(16_000_000_000),
        );
        assert_eq!(
            payload,
            serde_json::json!({
                "workstation_id": "ws-lab2",
                "display_name": "lab2 workstation",
                "provider": "runtime_peer",
                "default_environment_label": "Current Python",
                "environment_policy": "current_python",
                "working_directory": "/home/ubuntu/project",
                "cpu_count": 8,
                "memory_bytes": 16_000_000_000u64,
                "capabilities": {
                    "launch_current_python": true,
                },
                "runtime": {
                    "binary": "runtimed",
                    "python_path": "/opt/k/bin/python",
                },
            })
        );
    }

    #[test]
    fn registration_payload_omits_unknown_hardware_facts() {
        let payload = registration_payload("ws", "ws", "/w", "/usr/bin/python3", None, None);
        assert!(payload.get("cpu_count").is_none());
        assert!(payload.get("memory_bytes").is_none());
    }

    #[test]
    fn workstation_registration_is_startup_and_periodic() {
        let heartbeat_interval = Duration::from_secs(60);
        let stale_registration = Instant::now() - Duration::from_secs(120);
        let fresh_registration = Instant::now();

        assert!(!should_register_workstation(
            Some(fresh_registration),
            heartbeat_interval
        ));
        assert!(should_register_workstation(
            Some(stale_registration),
            heartbeat_interval
        ));
        assert!(should_register_workstation(None, heartbeat_interval));
    }

    #[test]
    fn workstation_registration_has_periodic_wakeup_deadline() {
        let heartbeat_interval = Duration::from_secs(60);
        let registered = Instant::now();

        assert!(next_registration_deadline(None, heartbeat_interval).is_some());
        assert_eq!(
            next_registration_deadline(Some(registered), heartbeat_interval),
            Some(registered + heartbeat_interval)
        );
    }

    #[test]
    fn workstation_event_name_reads_json_messages() {
        assert_eq!(
            workstation_event_name_from_ws_text(r#"{"event":"attach_jobs","data":{"job_id":"j"}}"#),
            Some("attach_jobs".to_string())
        );
        assert_eq!(
            workstation_event_name_from_ws_text(r#"{"event":"ready","data":{"ok":true}}"#),
            Some("ready".to_string())
        );
        assert_eq!(workstation_event_name_from_ws_text("not json"), None);
        assert_eq!(
            workstation_event_name_from_ws_text(WORKSTATION_EVENTS_PONG),
            None
        );
        assert_eq!(workstation_event_name_from_ws_text(r#"{"data":{}}"#), None);
    }

    #[tokio::test]
    async fn workstation_event_ws_message_ignores_pong_and_forwards_attach_jobs() {
        let (tx, mut rx) = mpsc::channel(1);

        assert!(handle_workstation_event_ws_message(
            WsMessage::Text(WORKSTATION_EVENTS_PONG.into()),
            &tx,
        )
        .await
        .unwrap());
        assert!(rx.try_recv().is_err());

        assert!(handle_workstation_event_ws_message(
            WsMessage::Text(r#"{"event":"attach_jobs","data":{"job_id":"j"}}"#.into()),
            &tx,
        )
        .await
        .unwrap());
        assert_eq!(rx.recv().await, Some(WorkstationControlEvent::AttachJobs));
    }

    #[test]
    fn workstation_event_url_uses_websocket_scheme() {
        assert_eq!(
            workstation_events_ws_url("https://preview.runt.run/api/workstations/ws/events")
                .unwrap(),
            "wss://preview.runt.run/api/workstations/ws/events"
        );
        assert_eq!(
            workstation_events_ws_url("http://localhost:8787/api/workstations/ws/events").unwrap(),
            "ws://localhost:8787/api/workstations/ws/events"
        );
        assert!(workstation_events_ws_url("file:///tmp/socket").is_err());
    }

    #[test]
    fn event_socket_retry_delay_uses_retry_after_and_caps_backoff() {
        assert_eq!(
            retry_event_socket_delay(Duration::from_secs(1), 42_000),
            Duration::from_secs(42)
        );
        assert_eq!(
            retry_event_socket_delay(Duration::from_secs(45), 0),
            Duration::from_secs(60)
        );
    }

    #[test]
    fn inactive_attach_job_patch_is_terminal_only_for_server_409() {
        assert!(attach_job_patch_no_longer_active(&http_error(
            409,
            json!({ "error": "workstation attach job is no longer active" })
        )));
        assert!(attach_job_patch_no_longer_active(&http_error(
            409,
            json!({ "job": { "status": "cancelled" } })
        )));
        assert!(!attach_job_patch_no_longer_active(&http_error(
            500,
            json!({ "error": "workstation attach job is no longer active" })
        )));
        assert!(!attach_job_patch_no_longer_active(&http_error(
            409,
            json!({ "error": "database busy" })
        )));
    }

    #[tokio::test]
    async fn terminal_attach_job_patch_drops_local_active_job() {
        let mut active = HashMap::from([("job-1".to_string(), active_job())]);
        let error = http_error(
            409,
            json!({ "error": "workstation attach job is no longer active" }),
        );

        assert!(drop_terminal_attach_job(&mut active, "job-1", "heartbeat", &error).await);
        assert!(!active.contains_key("job-1"));
    }

    #[tokio::test]
    async fn terminal_attach_job_patch_removes_local_pid_file() -> Result<()> {
        let tmp = tempfile::TempDir::new()?;
        let pid_path = tmp.path().join("runtime-peer.pid");
        std::fs::write(&pid_path, "123\n")?;
        let mut job = active_job();
        job.pid_path = pid_path.clone();
        let mut active = HashMap::from([("job-1".to_string(), job)]);
        let error = http_error(
            409,
            json!({ "error": "workstation attach job is no longer active" }),
        );

        assert!(drop_terminal_attach_job(&mut active, "job-1", "heartbeat", &error).await);
        assert!(!pid_path.exists());
        Ok(())
    }

    #[tokio::test]
    async fn non_terminal_attach_job_patch_keeps_local_active_job() {
        let mut active = HashMap::from([("job-1".to_string(), active_job())]);
        let error = http_error(503, json!({ "error": "temporarily unavailable" }));

        assert!(!drop_terminal_attach_job(&mut active, "job-1", "heartbeat", &error).await);
        assert!(active.contains_key("job-1"));
    }

    #[test]
    fn stale_pid_file_cleanup_removes_existing_file_and_ignores_missing() -> Result<()> {
        let tmp = tempfile::TempDir::new()?;
        let pid_path = tmp.path().join("runtime-peer.pid");
        std::fs::write(&pid_path, "123\n")?;

        remove_stale_pid_file(&pid_path);
        assert!(!pid_path.exists());

        remove_stale_pid_file(&pid_path);
        assert!(!pid_path.exists());
        Ok(())
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn inactive_child_job_gets_graceful_shutdown_before_kill() -> Result<()> {
        let tmp = tempfile::TempDir::new()?;
        let marker_path = tmp.path().join("sigterm-marker");
        let ready_path = tmp.path().join("ready-marker");
        let child = tokio::process::Command::new("sh")
            .env("SIGTERM_MARKER", &marker_path)
            .env("READY_MARKER", &ready_path)
            .arg("-c")
            .arg(
                "trap 'printf term > \"$SIGTERM_MARKER\"; exit 0' TERM; \
                 printf ready > \"$READY_MARKER\"; \
                 while :; do sleep 1; done",
            )
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()?;

        let ready_deadline = Instant::now() + Duration::from_secs(2);
        while !ready_path.exists() {
            if Instant::now() >= ready_deadline {
                anyhow::bail!("child did not install SIGTERM trap before test timeout");
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        terminate_active_job(ActiveJob {
            child: Some(child),
            pid: None,
            log_path: tmp.path().join("runtime-peer.log"),
            pid_path: tmp.path().join("runtime-peer.pid"),
            ready: true,
            status: "running",
            started_at: Instant::now(),
            last_status_patch_at: Instant::now(),
        })
        .await;

        assert_eq!(std::fs::read_to_string(marker_path)?, "term");
        Ok(())
    }

    /// (d) Attach-job → spawn argv mapping mirrors the `.mjs` plan, with the
    /// workstation auth kind. The credential never appears in argv.
    #[test]
    fn spawn_plan_matches_mjs_contract() {
        let opts = options();
        let plan = build_attach_job_spawn_plan(&job("Job 123", "nb-1"), &opts).unwrap();
        let expected_run_root = opts.agent_root.join("job-123");
        let expected_blob_root = expected_run_root.join("blobs");
        let expected_log_path = expected_run_root.join("runtime-peer.log");
        let expected_pid_path = expected_run_root.join("runtime-peer.pid");

        assert_eq!(plan.cwd, opts.working_dir);
        assert_eq!(plan.run_root, expected_run_root);
        assert_eq!(plan.blob_root, expected_blob_root);
        assert_eq!(plan.log_path, expected_log_path);
        assert_eq!(plan.pid_path, expected_pid_path);
        assert_eq!(
            plan.args,
            vec![
                "cloud-runtime-agent".to_string(),
                "--auth-kind".to_string(),
                "workstation".to_string(),
                "--cloud-url".to_string(),
                "https://preview.runt.run".to_string(),
                "--notebook-id".to_string(),
                "nb-1".to_string(),
                "--scope".to_string(),
                "runtime_peer".to_string(),
                "--python-path".to_string(),
                opts.python_path.to_string_lossy().into_owned(),
                "--blob-root".to_string(),
                plan.blob_root.to_string_lossy().into_owned(),
                "--working-dir".to_string(),
                plan.cwd.to_string_lossy().into_owned(),
                "--workstation-id".to_string(),
                "ws-lab2".to_string(),
                "--runtime-session-id".to_string(),
                "Job 123".to_string(),
                "--workstation-display-name".to_string(),
                "lab2 workstation".to_string(),
            ]
        );
    }

    #[test]
    fn spawn_plan_honors_job_cwd_and_notebook_path_overrides() {
        let mut overridden = job("job-2", "nb-2");
        overridden.working_directory = Some("/srv/notebook-project".to_string());
        overridden.notebook_path = Some("/srv/notebook-project/report.ipynb".to_string());
        let plan = build_attach_job_spawn_plan(&overridden, &options()).unwrap();

        assert_eq!(plan.cwd, PathBuf::from("/srv/notebook-project"));
        assert_eq!(
            &plan.args[plan.args.len() - 2..],
            ["--notebook-path", "/srv/notebook-project/report.ipynb"]
        );
    }

    #[test]
    fn spawn_plan_rejects_jobs_missing_ids() {
        assert!(build_attach_job_spawn_plan(&job("", "nb"), &options()).is_err());
        assert!(build_attach_job_spawn_plan(&job("job", ""), &options()).is_err());
    }

    /// (d) The credential rides only the child environment, never argv, and
    /// secret-bearing parent variables do not leak through.
    #[test]
    fn runtime_agent_env_passes_token_only_through_env() {
        let parent: HashMap<&str, &str> = [
            ("HOME", "/home/ubuntu"),
            ("PATH", "/usr/bin"),
            ("NTERACT_API_KEY", "caller-secret"),
            ("NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN", "fallback-secret"),
        ]
        .into_iter()
        .collect();
        let env = build_runtime_agent_env(
            |key| parent.get(key).map(|v| v.to_string()),
            "runtime-peer-secret",
        );
        let env: HashMap<String, String> = env.into_iter().collect();

        assert_eq!(
            env.get(CLOUD_TOKEN_ENV).map(String::as_str),
            Some("runtime-peer-secret")
        );
        assert!(!env.contains_key("NTERACT_API_KEY"));
        assert!(!env.contains_key("NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN"));
        assert_eq!(env.get("HOME").map(String::as_str), Some("/home/ubuntu"));
        assert_eq!(env.get("PATH").map(String::as_str), Some("/usr/bin"));
        assert_eq!(env.get("RUST_LOG").map(String::as_str), Some("info"));

        // And the argv side of the same contract: no token anywhere.
        let plan = build_attach_job_spawn_plan(&job("job-x", "nb-x"), &options()).unwrap();
        assert!(!plan
            .args
            .iter()
            .any(|arg| arg.contains("runtime-peer-secret")));
    }

    /// (e) Readiness-line detection.
    #[test]
    fn readiness_line_detection() {
        assert!(!log_indicates_ready(""));
        assert!(!log_indicates_ready("[cloud-runtime-agent] connecting..."));
        assert!(log_indicates_ready(
            "2026-06-12 [info] Infrastructure ready, entering main loop\n"
        ));
        // Embedded mid-stream still counts (the `.mjs` agent greps the file).
        assert!(log_indicates_ready(&format!(
            "noise\n{READINESS_LINE}\nmore noise"
        )));
    }

    #[test]
    fn normalize_jobs_accepts_all_known_shapes() {
        let raw = serde_json::json!([{ "job_id": "a", "notebook_id": "n" }]);
        assert_eq!(normalize_jobs(&raw).len(), 1);
        let wrapped = serde_json::json!({ "jobs": [{ "job_id": "a", "notebook_id": "n" }] });
        assert_eq!(normalize_jobs(&wrapped).len(), 1);
        let alt = serde_json::json!({ "attach_jobs": [{ "job_id": "a", "notebook_id": "n" }] });
        assert_eq!(normalize_jobs(&alt).len(), 1);
        assert!(normalize_jobs(&serde_json::json!({ "ok": true })).is_empty());
    }

    #[test]
    fn parse_response_body_preserves_non_json_error_pages() {
        assert_eq!(parse_response_body(""), serde_json::json!({}));
        assert_eq!(
            parse_response_body("{\"jobs\":[]}"),
            serde_json::json!({ "jobs": [] })
        );
        let body = parse_response_body("<html><title>Error 1027</title>Please check back</html>");
        assert!(body["error"]
            .as_str()
            .is_some_and(|text| text.contains("Error 1027")));
    }

    #[test]
    fn retry_after_only_applies_to_rate_limit_statuses() {
        assert_eq!(retry_after_ms(200, None), 0);
        assert_eq!(retry_after_ms(429, Some("7")), 7_000);
        assert_eq!(retry_after_ms(503, None), 60_000);
        assert_eq!(retry_after_ms(404, Some("900")), 0);
        // Sub-second hints are floored to 1s.
        assert_eq!(retry_after_ms(429, Some("0")), 1_000);
        // Unparseable headers fall back to the default.
        assert_eq!(retry_after_ms(429, Some("soon")), 60_000);
        // An HTTP-date in the past still cools down for at least a second.
        assert_eq!(
            retry_after_ms(429, Some("Tue, 15 Nov 1994 08:12:31 GMT")),
            1_000
        );
    }

    #[test]
    fn stale_workstation_statuses_can_back_off_selected_paths() {
        assert_eq!(
            retry_after_ms_for_statuses(404, Some("900"), &[404, 410, 429, 503]),
            900_000
        );
        assert_eq!(
            retry_after_ms_for_statuses(410, None, &[404, 410, 429, 503]),
            DEFAULT_MISSING_WORKSTATION_RETRY_AFTER_MS
        );
        assert_eq!(retry_after_ms_for_statuses(404, None, &[429, 503]), 0);
    }

    #[test]
    fn retry_cooldown_expands_with_failures_and_caps() {
        assert_eq!(retry_cooldown_ms(60_000, 1, 0.0), 60_000);
        assert_eq!(retry_cooldown_ms(60_000, 2, 0.0), 120_000);
        assert_eq!(retry_cooldown_ms(60_000, 8, 0.0), 900_000);
        // 20% jitter at jitter_unit=0.5 adds 10% of the base delay.
        assert_eq!(retry_cooldown_ms(10_000, 1, 0.5), 11_000);
    }

    #[test]
    fn meminfo_parsing() {
        let meminfo = "MemTotal:       16384256 kB\nMemFree:         1234 kB\n";
        assert_eq!(parse_meminfo_total_bytes(meminfo), Some(16_384_256 * 1024));
        assert_eq!(parse_meminfo_total_bytes("MemFree: 1 kB"), None);
    }

    #[test]
    fn path_segment_encoding() {
        assert_eq!(encode_path_segment("ws-lab2"), "ws-lab2");
        assert_eq!(encode_path_segment("a b/c"), "a%20b%2Fc");
    }

    #[test]
    fn resolve_python_prefers_python3() {
        let dir = tempfile::tempdir().unwrap();
        let bin = dir.path();
        for name in ["python", "python3"] {
            let path = bin.join(name);
            std::fs::write(&path, "#!/bin/sh\n").unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        let path_var = bin.to_string_lossy().into_owned();
        let resolved = resolve_python_on_path(Some(&path_var)).unwrap();
        assert!(resolved
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with("python3")));
        assert!(resolve_python_on_path(None).is_none());
    }
}
