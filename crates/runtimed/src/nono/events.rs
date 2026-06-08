//! Signal-extraction layer for nono stdout, stderr, and audit log.
//!
//! Converts the raw text streams from the nono supervisor into typed
//! [`NonoEvent`] values that downstream consumers (task 08) can
//! pattern-match against.  This module does **not** interpret events
//! into user-facing messages — that is task 08's job.
//!
//! ## Three signal sources (from `error-routing-design.md` §3)
//!
//! 1. **stdout (all tracing log lines)** — nono's `tracing` framework
//!    writes structured log lines to **stdout**.  At `-vv` this includes:
//!    - `proxy request allowed/denied` lines with key=value fields
//!    - `Session file created:` debug line carrying the session ID
//!    - Many other DEBUG/INFO/WARN lines (startup, TLS intercept, etc.)
//!
//!    With `NO_COLOR=1` set in the child environment, ANSI escape codes
//!    are suppressed and lines arrive in a clean, parseable form.
//!    The daemon **must** launch nono with `NO_COLOR=1`.
//!
//! 2. **stderr (human-readable summary only)** — nono writes a
//!    capabilities table, warnings, and a post-run diagnostic footer
//!    to stderr.  This stream carries no structured proxy-decision data.
//!    All stderr lines are emitted as [`NonoEvent::Unparsed`] so
//!    downstream consumers can inspect startup failures.
//!
//! 3. **Audit log NDJSON** —
//!    `~/.nono/audit/<YYYYMMDD-HHMMSS-PID>/audit-events.ndjson`.
//!    Polled every 100 ms.  Network events may be flushed only at
//!    session end (see `nono-error-signals.md` §3).
//!
//! ## Empirical facts honoured (nono 0.62.0, captured 2026-06-08)
//!
//! - **NO_COLOR=1** suppresses all ANSI escape codes — always set it.
//! - **All structured tracing output goes to stdout**, not stderr.
//!   stderr carries only the human-readable capabilities table.
//! - **Session ID** is on stdout as:
//!   `<timestamp> DEBUG Session file created: /…/sessions/<hex>.json`
//! - **Proxy decision lines** appear on stdout at `-vv` when credentials
//!   or TLS interception are active:
//!   ```text
//!   2026-06-08T19:01:35.427364Z  INFO proxy request allowed \
//!     mode=connect_intercept host="api.anthropic.com" port=443 \
//!     method="CONNECT" decision="allow"
//!   2026-06-08T19:01:35.427405Z  INFO proxy request denied \
//!     mode=connect_intercept host="api.anthropic.com" port=443 \
//!     decision="deny" reason="managed credential unavailable…"
//!   ```
//!   These lines do **not** appear for plain outbound-allowed sessions
//!   with no credential or profile — only for intercepted routes.
//! - Audit directory name format: `YYYYMMDD-HHMMSS-<pid>`
//!   (never printed — discovered via filesystem scan, D-12).
//! - Audit NDJSON line schema: `{sequence, prev_chain, leaf_hash,
//!   chain_hash, event_json, event}` where `event` has a `type` field.
//! - Only `session_started` and `session_ended` are observed at default
//!   verbosity; network events appear with `-vv` (OQ-7).
//!
//! ## Backpressure
//!
//! The outbound [`mpsc`] channel is bounded at [`EVENT_CHANNEL_CAPACITY`].
//! When the channel is full the event is silently dropped (a counter is
//! logged at WARN once per second) so the parsers never block on a slow
//! consumer.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use serde::Deserialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::sync::{mpsc, watch};
use tracing::{debug, warn};

use crate::nono::NONO_VERSION;

// ── Constants ─────────────────────────────────────────────────────────

/// Bounded capacity for the outgoing event channel.  On overflow the
/// event is silently dropped so parsers never block.
const EVENT_CHANNEL_CAPACITY: usize = 2048;

/// Settle period before the first audit-directory scan.
const AUDIT_SETTLE_DELAY: Duration = Duration::from_millis(250);

/// Poll interval between audit-directory scan retries.
const AUDIT_SCAN_RETRY_INTERVAL: Duration = Duration::from_millis(250);

/// Maximum time to wait for the audit directory to appear.
const AUDIT_SCAN_TIMEOUT: Duration = Duration::from_secs(5);

/// Audit log polling interval (check for new bytes).
const AUDIT_POLL_INTERVAL: Duration = Duration::from_millis(100);

// ── Public types ──────────────────────────────────────────────────────

/// A line from the nono supervisor's stdout.
///
/// nono writes all structured `tracing` log output to stdout.
/// Launch nono with `NO_COLOR=1` to suppress ANSI escape codes.
///
/// Defined here so `EventCollector::start` has a concrete input type.
/// Task 04 (the process supervisor) will produce these once implemented.
#[derive(Debug, Clone)]
pub struct StdoutLine(pub String);

/// A line from the nono supervisor's stderr.
///
/// nono writes a human-readable capabilities table and diagnostic footer
/// to stderr.  There is no structured proxy-decision data on stderr.
///
/// Defined here so `EventCollector::start` has a concrete input type.
/// Task 04 (the process supervisor) will produce these once implemented.
#[derive(Debug, Clone)]
pub struct StderrLine(pub String);

/// Normalised events extracted from nono's signal surface.
///
/// All three sources (stdout tracing lines, stderr diagnostics, audit
/// log) feed into this single enum.  Variants carry exactly what nono
/// emits, without user-facing interpretation.
#[derive(Debug, Clone)]
pub enum NonoEvent {
    /// First audit-log event: session started.
    SessionStarted {
        /// The audit-directory session ID (`YYYYMMDD-HHMMSS-PID`).
        session_id: String,
        /// When the session started, per the audit log.
        at: SystemTime,
    },

    /// Last audit-log event: session ended.
    SessionEnded {
        /// When the session ended, per the audit log.
        at: SystemTime,
    },

    /// Per-request ALLOW from a stdout `proxy request allowed` line.
    ///
    /// `ALLOW` means nono permitted the request — not that the upstream
    /// accepted it.  `status` is not present in the log line itself;
    /// upstream status appears in the audit log at session end.
    RequestAllowed {
        /// Whether this is a `connect` or `connect_intercept` tunnel or
        /// a `reverse` proxy request.
        mode: ProxyMode,
        /// The target host.
        host: Option<String>,
        /// Target port.
        port: Option<u16>,
        /// HTTP method (e.g. `"CONNECT"`).
        method: Option<String>,
        /// When the line was received.
        at: Instant,
        /// Original unmodified line (for diagnostics).
        raw: String,
    },

    /// Per-request DENY from a stdout `proxy request denied` line.
    RequestDenied {
        /// Whether this is a `connect`, `connect_intercept`, or `reverse`
        /// request.
        mode: ProxyMode,
        /// The target host.
        host: Option<String>,
        /// Target port.
        port: Option<u16>,
        /// Deny reason as reported by nono (e.g.
        /// `"managed credential unavailable for route 'anthropic': …"`).
        reason: String,
        /// When the line was received.
        at: Instant,
        /// Original unmodified line (for diagnostics).
        raw: String,
    },

    /// A line that did not match any known pattern.
    ///
    /// Kept verbatim so downstream consumers can inspect what nono emitted
    /// and help diagnose future format changes.
    Unparsed {
        /// Which stream the line came from.
        source: Source,
        /// Original unmodified line.
        line: String,
        /// When the line was received.
        at: Instant,
    },
}

/// Proxy mode extracted from the `mode=` field of nono's log lines.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProxyMode {
    /// Plain CONNECT tunnel (domain allowlist enforcement).
    Connect,
    /// CONNECT tunnel with TLS interception (credential injection).
    ConnectIntercept,
    /// Reverse proxy (credential injection without TLS interception).
    Reverse,
    /// Any other mode value not yet recognised.
    Other(String),
}

impl ProxyMode {
    fn from_str(s: &str) -> Self {
        match s {
            "connect" => Self::Connect,
            "connect_intercept" => Self::ConnectIntercept,
            "reverse" => Self::Reverse,
            other => Self::Other(other.to_string()),
        }
    }
}

/// Which signal source produced a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// nono's stdout (structured tracing log lines).
    Stdout,
    /// nono's stderr (human-readable capabilities table and diagnostics).
    Stderr,
    /// The NDJSON audit log file.
    Audit,
}

/// Returned by [`EventCollector::start`].  Owns the receiver ends of the
/// channels that carry events and the session ID watch.
pub struct EventStream {
    /// Receive typed events from all three signal sources.
    pub events: mpsc::Receiver<NonoEvent>,
    /// Watch receiver for the supervisor session ID (the 16-hex-char ID
    /// extracted from the stdout `DEBUG Session file created: …` line).
    ///
    /// Starts as `None`; set once when the line is seen.
    /// Consumers can `.await` via `watch::Receiver::changed()`.
    pub session_id: watch::Receiver<Option<String>>,
}

/// Spawns parser tasks for all three nono signal sources and wires them
/// into a single [`EventStream`].
pub struct EventCollector;

impl EventCollector {
    /// Spawn parser tasks.  Owns the supervisor's stdout/stderr receivers.
    ///
    /// `nono_pid` and `spawn_time` are used to locate the audit log
    /// directory (D-12).  They come from the process supervisor (task 04).
    ///
    /// **The daemon must launch nono with `NO_COLOR=1`** so that stdout
    /// log lines arrive without ANSI escape codes.
    pub fn start(
        nono_pid: u32,
        spawn_time: SystemTime,
        stdout: mpsc::Receiver<StdoutLine>,
        stderr: mpsc::Receiver<StderrLine>,
    ) -> EventStream {
        let (event_tx, event_rx) = mpsc::channel::<NonoEvent>(EVENT_CHANNEL_CAPACITY);
        let (session_id_tx, session_id_rx) = watch::channel::<Option<String>>(None);
        let overflow_counter: Arc<AtomicU64> = Arc::new(AtomicU64::new(0));

        // stdout — structured tracing lines; carries proxy decisions + session ID
        {
            let tx = BoundedSender::new(event_tx.clone(), Arc::clone(&overflow_counter));
            tokio::spawn(parse_stdout(stdout, tx, session_id_tx));
        }

        // stderr — human-readable diagnostics only; emit all as Unparsed
        {
            let tx = BoundedSender::new(event_tx.clone(), Arc::clone(&overflow_counter));
            tokio::spawn(drain_stderr(stderr, tx));
        }

        // audit log tailer
        {
            let tx = BoundedSender::new(event_tx, overflow_counter);
            tokio::spawn(audit_log_task(nono_pid, spawn_time, tx));
        }

        EventStream {
            events: event_rx,
            session_id: session_id_rx,
        }
    }
}

// ── BoundedSender ─────────────────────────────────────────────────────

/// Wraps [`mpsc::Sender<NonoEvent>`] with a drop-on-full strategy.
///
/// When the bounded channel is full the event is dropped and an atomic
/// counter incremented.  A background task logs the count at WARN every
/// second so operators can detect a slow consumer.
#[derive(Clone)]
struct BoundedSender {
    tx: mpsc::Sender<NonoEvent>,
    overflow: Arc<AtomicU64>,
}

impl BoundedSender {
    fn new(tx: mpsc::Sender<NonoEvent>, overflow: Arc<AtomicU64>) -> Self {
        let ov = Arc::clone(&overflow);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            loop {
                interval.tick().await;
                let n = ov.swap(0, Ordering::Relaxed);
                if n > 0 {
                    warn!(
                        "[nono::events] Event channel full — dropped {} event(s) in the last second",
                        n
                    );
                }
            }
        });
        Self { tx, overflow }
    }

    async fn send(&self, event: NonoEvent) {
        if self.tx.try_send(event).is_err() {
            self.overflow.fetch_add(1, Ordering::Relaxed);
        }
    }
}

// ── stdout parser ─────────────────────────────────────────────────────

/// Parse all stdout lines.
///
/// Each line is a `tracing`-formatted log entry:
/// ```text
/// 2026-06-08T19:01:35.427364Z  INFO proxy request allowed mode=connect_intercept host="api.anthropic.com" port=443 method="CONNECT" decision="allow"
/// 2026-06-08T19:01:35.296623Z DEBUG Session file created: /Users/anil/.nono/sessions/8b01ab0bd7861ee9.json
/// ```
///
/// Requires `NO_COLOR=1` — lines must arrive without ANSI escape codes.
///
/// This function never returns an error; unrecognised lines become
/// [`NonoEvent::Unparsed`].
///
/// Nono version pinned against [`NONO_VERSION`] — update and re-validate
/// fixtures when bumping.
async fn parse_stdout(
    mut rx: mpsc::Receiver<StdoutLine>,
    tx: BoundedSender,
    session_id_tx: watch::Sender<Option<String>>,
) {
    debug!(
        "[nono::events] stdout parser active (nono version pinned: {})",
        NONO_VERSION
    );
    let mut session_id_found = false;

    while let Some(StdoutLine(line)) = rx.recv().await {
        let at = Instant::now();
        let event = parse_stdout_line(&line, at, &mut session_id_found, &session_id_tx);
        tx.send(event).await;
    }
}

/// Parse a single stdout line.  Never panics; unrecognised → `Unparsed`.
pub(crate) fn parse_stdout_line(
    line: &str,
    at: Instant,
    session_id_found: &mut bool,
    session_id_tx: &watch::Sender<Option<String>>,
) -> NonoEvent {
    // All structured lines have format:
    //   <RFC3339-timestamp>  <LEVEL> <message> [key=value ...]
    // Strip the timestamp+level prefix, leaving the message body.
    let body = strip_tracing_prefix(line);

    // Session ID (first occurrence only)
    if !*session_id_found {
        if let Some(hex_id) = extract_session_id_from_body(body) {
            debug!("[nono::events] Supervisor session ID: {}", hex_id);
            let _ = session_id_tx.send(Some(hex_id));
            *session_id_found = true;
            // Still emit as Unparsed — the session ID line has no NonoEvent
            // variant of its own; consumers watch `session_id` directly.
            return NonoEvent::Unparsed {
                source: Source::Stdout,
                line: line.to_string(),
                at,
            };
        }
    }

    // Proxy request decisions
    if body.starts_with("proxy request allowed") || body.starts_with("proxy request denied") {
        return parse_proxy_request_line(body, line, at);
    }

    NonoEvent::Unparsed {
        source: Source::Stdout,
        line: line.to_string(),
        at,
    }
}

/// Strip the `<timestamp>  <LEVEL> ` prefix from a tracing log line and
/// return the remaining message body.
///
/// Format (with `NO_COLOR=1`):
/// ```text
/// 2026-06-08T19:01:35.427364Z  INFO proxy request allowed …
/// 2026-06-08T19:01:35.296623Z DEBUG Session file created: …
/// ```
///
/// If the prefix cannot be stripped (e.g. the line is not a tracing log
/// line), the original line is returned unchanged.
fn strip_tracing_prefix(line: &str) -> &str {
    // Find the first space after the timestamp (ends with 'Z').
    let after_ts = match line.find("Z ") {
        Some(pos) => &line[pos + 1..],
        None => return line,
    };
    // Skip the level token (DEBUG / INFO / WARN / ERROR) and trailing spaces.
    let after_level = after_ts.trim_start();
    let after_level = match after_level.find(' ') {
        Some(pos) => after_level[pos..].trim_start(),
        None => return line,
    };
    after_level
}

/// Extract the 16-hex-char session ID from the body of a
/// `Session file created:` line.
///
/// Expected body (after prefix stripped):
/// ```text
/// Session file created: /Users/anil/.nono/sessions/8b01ab0bd7861ee9.json
/// ```
fn extract_session_id_from_body(body: &str) -> Option<String> {
    let stem = body
        .strip_prefix("Session file created: ")
        .and_then(|path_str| Path::new(path_str.trim()).file_stem())
        .and_then(|s| s.to_str())?;

    // Validate: hex chars only, reasonable length.
    if stem.len() >= 4 && stem.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(stem.to_string())
    } else {
        None
    }
}

/// Parse a `proxy request allowed` or `proxy request denied` line body.
///
/// Real format (nono 0.62.0, NO_COLOR=1):
/// ```text
/// proxy request allowed mode=connect_intercept host="api.anthropic.com" port=443 method="CONNECT" decision="allow"
/// proxy request denied  mode=connect_intercept host="api.anthropic.com" port=443 decision="deny" reason="managed credential unavailable for route 'anthropic': …"
/// ```
fn parse_proxy_request_line(body: &str, raw: &str, at: Instant) -> NonoEvent {
    let allowed = body.starts_with("proxy request allowed");
    let kv = parse_kv_fields(body);

    let mode = kv
        .get("mode")
        .map(|s| ProxyMode::from_str(s))
        .unwrap_or(ProxyMode::Other(String::new()));

    let host = kv.get("host").cloned();
    let port = kv.get("port").and_then(|s| s.parse::<u16>().ok());
    let method = kv.get("method").cloned();

    if allowed {
        NonoEvent::RequestAllowed {
            mode,
            host,
            port,
            method,
            at,
            raw: raw.to_string(),
        }
    } else {
        let reason = kv
            .get("reason")
            .cloned()
            .unwrap_or_else(|| "unknown".to_string());
        NonoEvent::RequestDenied {
            mode,
            host,
            port,
            reason,
            at,
            raw: raw.to_string(),
        }
    }
}

/// Parse `key=value` and `key="quoted value"` fields from a tracing line body.
///
/// The parser is liberal: it scans left-to-right for `word=` patterns and
/// handles both bare and double-quoted values.  Unknown or malformed tokens
/// are silently skipped.
fn parse_kv_fields(s: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut rest = s;
    while let Some(eq_pos) = rest.find('=') {
        // The key is the last whitespace-delimited token before `=`.
        let before_eq = &rest[..eq_pos];
        let key = before_eq.split_whitespace().next_back().unwrap_or("");
        if key.is_empty() {
            rest = &rest[eq_pos + 1..];
            continue;
        }
        let after_eq = &rest[eq_pos + 1..];
        let (value, consumed) = if after_eq.starts_with('"') {
            // Quoted value — find the closing quote (not preceded by backslash).
            let inner = &after_eq[1..];
            match inner.find('"') {
                Some(close) => (inner[..close].to_string(), close + 2), // +2 for both quotes
                None => (inner.to_string(), after_eq.len()),
            }
        } else {
            // Bare value — up to the next whitespace.
            let end = after_eq.find(' ').unwrap_or(after_eq.len());
            (after_eq[..end].to_string(), end)
        };
        map.insert(key.to_string(), value);
        // Advance past `key=value`; skip the key part before `=` as well.
        let key_start = before_eq
            .rfind(|c: char| c.is_whitespace())
            .map(|p| p + 1)
            .unwrap_or(0);
        rest = &rest[eq_pos + 1 + consumed..];
        let _ = key_start; // key was read from before_eq; rest already advanced
    }
    map
}

// ── stderr drain ──────────────────────────────────────────────────────

/// Drain stderr, emitting every line as [`NonoEvent::Unparsed`].
///
/// stderr carries nono's human-readable capabilities table and the
/// post-run diagnostic footer.  There is no structured proxy-decision
/// data here.  Emitting as Unparsed lets task 08 inspect startup failure
/// messages (e.g. `nono: Secret not found in keystore: …`).
async fn drain_stderr(mut rx: mpsc::Receiver<StderrLine>, tx: BoundedSender) {
    while let Some(StderrLine(line)) = rx.recv().await {
        tx.send(NonoEvent::Unparsed {
            source: Source::Stderr,
            line,
            at: Instant::now(),
        })
        .await;
    }
}

// ── Audit log tasks ───────────────────────────────────────────────────

/// Top-level audit log task: discover the directory then tail the file.
async fn audit_log_task(nono_pid: u32, spawn_time: SystemTime, tx: BoundedSender) {
    tokio::time::sleep(AUDIT_SETTLE_DELAY).await;

    match discover_audit_dir(nono_pid, spawn_time).await {
        Some(dir) => {
            let ndjson_path = dir.join("audit-events.ndjson");
            debug!("[nono::events] Audit log found: {}", ndjson_path.display());
            tail_audit_log(ndjson_path, tx).await;
        }
        None => {
            warn!(
                "[nono::events] Audit directory for nono PID {} not found within {:?}. \
                 Audit log stream inactive.",
                nono_pid, AUDIT_SCAN_TIMEOUT
            );
        }
    }
}

/// Scan `~/.nono/audit/` for a directory whose name ends with `-<pid>`.
///
/// Directory naming convention (empirically confirmed, OQ-7/OQ-8):
/// `YYYYMMDD-HHMMSS-<pid>` (e.g. `20260608-083710-45245`).
async fn discover_audit_dir(nono_pid: u32, spawn_time: SystemTime) -> Option<PathBuf> {
    let audit_root = audit_root_dir()?;
    let pid_suffix = format!("-{}", nono_pid);
    let deadline = Instant::now() + AUDIT_SCAN_TIMEOUT;

    loop {
        if let Ok(entries) = std::fs::read_dir(&audit_root) {
            let mut candidates: Vec<(SystemTime, PathBuf)> = entries
                .filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().into_string().ok()?;
                    if !name.ends_with(&pid_suffix) {
                        return None;
                    }
                    let prefix = name.strip_suffix(&pid_suffix)?;
                    if !is_audit_dir_timestamp_prefix(prefix) {
                        return None;
                    }
                    let path = e.path();
                    let mtime = path.metadata().ok()?.modified().ok()?;
                    Some((mtime, path))
                })
                .collect();

            if !candidates.is_empty() {
                candidates.sort_by_key(|(mtime, _)| mtime_distance(*mtime, spawn_time));
                return Some(candidates.remove(0).1);
            }
        }

        if Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(AUDIT_SCAN_RETRY_INTERVAL).await;
    }
}

fn audit_root_dir() -> Option<PathBuf> {
    Some(dirs::home_dir()?.join(".nono").join("audit"))
}

/// Validate the `YYYYMMDD-HHMMSS` (or similar `DIGITS-DIGITS`) prefix.
fn is_audit_dir_timestamp_prefix(prefix: &str) -> bool {
    let parts: Vec<&str> = prefix.splitn(2, '-').collect();
    if parts.len() != 2 {
        return false;
    }
    parts[0].chars().all(|c| c.is_ascii_digit()) && parts[1].chars().all(|c| c.is_ascii_digit())
}

fn mtime_distance(a: SystemTime, b: SystemTime) -> Duration {
    match a.duration_since(b) {
        Ok(d) => d,
        Err(e) => e.duration(),
    }
}

// ── Audit log tailer ──────────────────────────────────────────────────

/// Poll an NDJSON audit file for new lines.
async fn tail_audit_log(path: PathBuf, tx: BoundedSender) {
    use tokio::io::AsyncSeekExt;
    let mut offset: u64 = 0;
    let mut interval = tokio::time::interval(AUDIT_POLL_INTERVAL);

    loop {
        interval.tick().await;

        let mut file = match tokio::fs::File::open(&path).await {
            Ok(f) => f,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                warn!(
                    "[nono::events] Cannot open audit log {}: {}",
                    path.display(),
                    e
                );
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            }
        };

        if let Err(e) = file.seek(std::io::SeekFrom::Start(offset)).await {
            warn!("[nono::events] Seek error in audit log: {}", e);
            continue;
        }

        let mut reader = BufReader::new(file);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) => break,
                Ok(n) => {
                    offset += n as u64;
                    let trimmed = line.trim();
                    if !trimmed.is_empty() {
                        tx.send(parse_audit_line(trimmed)).await;
                    }
                }
                Err(e) => {
                    warn!("[nono::events] Read error in audit log: {}", e);
                    break;
                }
            }
        }
    }
}

// ── NDJSON audit line parser ──────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct AuditLineOuter {
    pub event: AuditEventValue,
}

#[derive(Debug, Deserialize)]
struct AuditEventValue {
    #[serde(rename = "type")]
    pub kind: String,
    pub started: Option<String>,
    pub ended: Option<String>,
}

fn parse_audit_line(line: &str) -> NonoEvent {
    let at = Instant::now();
    let outer: AuditLineOuter = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(_) => {
            return NonoEvent::Unparsed {
                source: Source::Audit,
                line: line.to_string(),
                at,
            }
        }
    };

    match outer.event.kind.as_str() {
        "session_started" => NonoEvent::SessionStarted {
            // The audit-directory name is the session_id for our purposes;
            // `session_started` events don't embed it in the JSON.
            // Task 08 populates the real id from the discovery path.
            session_id: String::new(),
            at: outer
                .event
                .started
                .as_deref()
                .and_then(parse_iso8601)
                .unwrap_or(SystemTime::now()),
        },
        "session_ended" => NonoEvent::SessionEnded {
            at: outer
                .event
                .ended
                .as_deref()
                .and_then(parse_iso8601)
                .unwrap_or(SystemTime::now()),
        },
        _ => NonoEvent::Unparsed {
            source: Source::Audit,
            line: line.to_string(),
            at,
        },
    }
}

fn parse_iso8601(s: &str) -> Option<SystemTime> {
    use std::time::UNIX_EPOCH;
    let dt = chrono::DateTime::parse_from_rfc3339(s).ok()?;
    let secs = dt.timestamp();
    let nanos = dt.timestamp_subsec_nanos();
    if secs >= 0 {
        UNIX_EPOCH
            .checked_add(Duration::from_secs(secs as u64))
            .and_then(|t| t.checked_add(Duration::from_nanos(nanos as u64)))
    } else {
        UNIX_EPOCH.checked_sub(Duration::from_secs((-secs) as u64))
    }
}

// ── Tests ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicU64;
    use std::time::Instant;

    use tokio::sync::{mpsc, watch};

    use super::*;

    // Helper: a no-op session_id sender for tests that don't care about it.
    fn dummy_sid() -> (watch::Sender<Option<String>>, bool) {
        let (tx, _rx) = watch::channel(None);
        (tx, false)
    }

    // ── strip_tracing_prefix ──────────────────────────────────────────

    #[test]
    fn strips_timestamp_and_level() {
        let line = "2026-06-08T19:01:35.427364Z  INFO proxy request allowed mode=connect_intercept";
        assert_eq!(
            strip_tracing_prefix(line),
            "proxy request allowed mode=connect_intercept"
        );
    }

    #[test]
    fn strips_debug_level() {
        let line =
            "2026-06-08T19:01:35.296623Z DEBUG Session file created: /a/b/8b01ab0bd7861ee9.json";
        assert_eq!(
            strip_tracing_prefix(line),
            "Session file created: /a/b/8b01ab0bd7861ee9.json"
        );
    }

    #[test]
    fn non_tracing_line_returned_unchanged() {
        let line = "  nono v0.62.0";
        assert_eq!(strip_tracing_prefix(line), line);
    }

    // ── session ID extraction ─────────────────────────────────────────

    #[test]
    fn extracts_session_id_from_body() {
        assert_eq!(
            extract_session_id_from_body(
                "Session file created: /Users/anil/.nono/sessions/8b01ab0bd7861ee9.json"
            ),
            Some("8b01ab0bd7861ee9".to_string())
        );
    }

    #[test]
    fn session_id_rejected_for_non_hex_stem() {
        assert_eq!(
            extract_session_id_from_body(
                "Session file created: /tmp/intercept-65632-067231000/intercept-ca.pem"
            ),
            None
        );
    }

    #[test]
    fn session_id_not_extracted_from_unrelated_body() {
        assert_eq!(
            extract_session_id_from_body("proxy request allowed …"),
            None
        );
    }

    // ── parse_stdout_line: proxy request allowed ──────────────────────

    #[test]
    fn parse_allowed_connect_intercept() {
        let line = "2026-06-08T19:01:35.427364Z  INFO proxy request allowed mode=connect_intercept host=\"api.anthropic.com\" port=443 method=\"CONNECT\" decision=\"allow\"";
        let (sid_tx, mut found) = dummy_sid();
        let event = parse_stdout_line(line, Instant::now(), &mut found, &sid_tx);
        match event {
            NonoEvent::RequestAllowed {
                mode,
                host,
                port,
                method,
                ..
            } => {
                assert_eq!(mode, ProxyMode::ConnectIntercept);
                assert_eq!(host.as_deref(), Some("api.anthropic.com"));
                assert_eq!(port, Some(443));
                assert_eq!(method.as_deref(), Some("CONNECT"));
            }
            other => panic!("expected RequestAllowed, got {other:?}"),
        }
    }

    // ── parse_stdout_line: proxy request denied ───────────────────────

    #[test]
    fn parse_denied_connect_intercept() {
        let line = "2026-06-08T19:01:35.427405Z  INFO proxy request denied mode=connect_intercept host=\"api.anthropic.com\" port=443 decision=\"deny\" reason=\"managed credential unavailable for route 'anthropic': intercepted request requires proxy-supplied auth\"";
        let (sid_tx, mut found) = dummy_sid();
        let event = parse_stdout_line(line, Instant::now(), &mut found, &sid_tx);
        match event {
            NonoEvent::RequestDenied {
                mode,
                host,
                port,
                reason,
                ..
            } => {
                assert_eq!(mode, ProxyMode::ConnectIntercept);
                assert_eq!(host.as_deref(), Some("api.anthropic.com"));
                assert_eq!(port, Some(443));
                assert!(
                    reason.contains("managed credential unavailable"),
                    "reason: {reason}"
                );
            }
            other => panic!("expected RequestDenied, got {other:?}"),
        }
    }

    // ── parse_stdout_line: session ID extracted and watch set ─────────

    #[test]
    fn session_id_sets_watch() {
        let line = "2026-06-08T19:01:35.296623Z DEBUG Session file created: /Users/anil/.nono/sessions/8b01ab0bd7861ee9.json";
        let (sid_tx, mut found) = dummy_sid();
        let sid_rx = sid_tx.subscribe();
        parse_stdout_line(line, Instant::now(), &mut found, &sid_tx);
        assert_eq!(*sid_rx.borrow(), Some("8b01ab0bd7861ee9".to_string()));
        assert!(found, "session_id_found should be true");
    }

    #[test]
    fn session_id_only_set_once() {
        let line = "2026-06-08T19:01:35.296623Z DEBUG Session file created: /Users/anil/.nono/sessions/8b01ab0bd7861ee9.json";
        let line2 = "2026-06-08T19:01:36.000000Z DEBUG Session file created: /Users/anil/.nono/sessions/aabbccddeeff0011.json";
        let (sid_tx, mut found) = dummy_sid();
        let sid_rx = sid_tx.subscribe();
        parse_stdout_line(line, Instant::now(), &mut found, &sid_tx);
        parse_stdout_line(line2, Instant::now(), &mut found, &sid_tx);
        // Second line should NOT overwrite the first.
        assert_eq!(*sid_rx.borrow(), Some("8b01ab0bd7861ee9".to_string()));
    }

    // ── parse_stdout_line: unrecognised lines become Unparsed ─────────

    #[test]
    fn unrecognised_stdout_line_becomes_unparsed() {
        let line = "2026-06-08T19:01:35.051368Z DEBUG theme: mocha";
        let (sid_tx, mut found) = dummy_sid();
        let event = parse_stdout_line(line, Instant::now(), &mut found, &sid_tx);
        assert!(matches!(
            event,
            NonoEvent::Unparsed {
                source: Source::Stdout,
                ..
            }
        ));
    }

    #[test]
    fn unparsed_line_preserves_original_text() {
        let raw = "2026-06-08T19:01:35.051368Z  WARN Some unexpected message here";
        let (sid_tx, mut found) = dummy_sid();
        let event = parse_stdout_line(raw, Instant::now(), &mut found, &sid_tx);
        match event {
            NonoEvent::Unparsed { line, .. } => assert_eq!(line, raw),
            other => panic!("expected Unparsed, got {other:?}"),
        }
    }

    // ── kv field parsing ──────────────────────────────────────────────

    #[test]
    fn kv_parses_quoted_and_bare_values() {
        let s = r#"proxy request allowed mode=connect_intercept host="api.anthropic.com" port=443 method="CONNECT" decision="allow""#;
        let kv = parse_kv_fields(s);
        assert_eq!(
            kv.get("mode").map(String::as_str),
            Some("connect_intercept")
        );
        assert_eq!(
            kv.get("host").map(String::as_str),
            Some("api.anthropic.com")
        );
        assert_eq!(kv.get("port").map(String::as_str), Some("443"));
        assert_eq!(kv.get("method").map(String::as_str), Some("CONNECT"));
        assert_eq!(kv.get("decision").map(String::as_str), Some("allow"));
    }

    // ── Audit directory discovery helpers ─────────────────────────────

    #[test]
    fn timestamp_prefix_valid() {
        assert!(is_audit_dir_timestamp_prefix("20260608-083710"));
        assert!(is_audit_dir_timestamp_prefix("20260101-000000"));
    }

    #[test]
    fn timestamp_prefix_invalid() {
        assert!(!is_audit_dir_timestamp_prefix("abcdef-ghijkl"));
        assert!(!is_audit_dir_timestamp_prefix("20260608"));
        assert!(!is_audit_dir_timestamp_prefix(""));
    }

    #[test]
    fn audit_dir_discovery_finds_matching_dir() {
        use std::fs;
        let tmp = tempfile::TempDir::new().unwrap();
        let audit_root = tmp.path().join(".nono").join("audit");
        fs::create_dir_all(&audit_root).unwrap();

        let pid: u32 = 99999;
        let matching_dir = audit_root.join(format!("20260608-120000-{}", pid));
        fs::create_dir_all(&matching_dir).unwrap();

        let wrong_dir = audit_root.join("20260608-120000-11111");
        fs::create_dir_all(&wrong_dir).unwrap();

        let pid_suffix = format!("-{}", pid);
        let entries: Vec<PathBuf> = fs::read_dir(&audit_root)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().into_string().ok()?;
                if !name.ends_with(&pid_suffix) {
                    return None;
                }
                let prefix = name.strip_suffix(&pid_suffix)?;
                if !is_audit_dir_timestamp_prefix(prefix) {
                    return None;
                }
                Some(e.path())
            })
            .collect();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0], matching_dir);
    }

    // ── NDJSON audit log parser ────────────────────────────────────────

    #[test]
    fn parse_session_started_line() {
        let line = r#"{"sequence":0,"prev_chain":null,"leaf_hash":"abc","chain_hash":"def","event_json":"{}","event":{"type":"session_started","started":"2026-06-08T08:37:10.888371-07:00","command":["curl","-s","https://httpbin.org/get"]}}"#;
        assert!(matches!(
            parse_audit_line(line),
            NonoEvent::SessionStarted { .. }
        ));
    }

    #[test]
    fn parse_session_ended_line() {
        let line = r#"{"sequence":1,"prev_chain":"abc","leaf_hash":"def","chain_hash":"ghi","event_json":"{}","event":{"type":"session_ended","ended":"2026-06-08T08:37:11.754569-07:00","exit_code":0}}"#;
        assert!(matches!(
            parse_audit_line(line),
            NonoEvent::SessionEnded { .. }
        ));
    }

    #[test]
    fn unknown_audit_event_type_becomes_unparsed() {
        let line = r#"{"sequence":2,"prev_chain":"x","leaf_hash":"y","chain_hash":"z","event_json":"{}","event":{"type":"future_unknown_event"}}"#;
        assert!(matches!(
            parse_audit_line(line),
            NonoEvent::Unparsed {
                source: Source::Audit,
                ..
            }
        ));
    }

    #[test]
    fn malformed_json_becomes_unparsed() {
        assert!(matches!(
            parse_audit_line("not valid json {{{"),
            NonoEvent::Unparsed {
                source: Source::Audit,
                ..
            }
        ));
    }

    // ── Fixture-based tests ───────────────────────────────────────────

    /// Parse every line in the real stdout fixture and confirm that:
    /// - The session ID line sets the watch.
    /// - Proxy request lines produce RequestAllowed / RequestDenied.
    /// - No line panics.
    #[test]
    fn parse_real_stdout_fixture() {
        let fixture = include_str!("../../test_fixtures/nono/stdout_with_proxy_decisions.txt");
        let (sid_tx, mut found) = dummy_sid();
        let sid_rx = sid_tx.subscribe();

        let mut allowed = 0u32;
        let mut denied = 0u32;

        for line in fixture.lines() {
            let line: &str = line;
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let event = parse_stdout_line(line, Instant::now(), &mut found, &sid_tx);
            match event {
                NonoEvent::RequestAllowed { .. } => allowed += 1,
                NonoEvent::RequestDenied { .. } => denied += 1,
                _ => {}
            }
        }

        assert!(found, "session ID should have been found in fixture");
        assert!(sid_rx.borrow().is_some(), "watch should be set");
        assert!(allowed >= 1, "expected at least one RequestAllowed");
        assert!(denied >= 1, "expected at least one RequestDenied");
    }

    /// Parse every line in the audit fixture.
    #[test]
    fn parse_real_audit_fixture() {
        let fixture = include_str!("../../test_fixtures/nono/audit_events.ndjson");
        let mut started = 0u32;
        let mut ended = 0u32;
        for line in fixture.lines() {
            let line: &str = line;
            if line.is_empty() {
                continue;
            }
            match parse_audit_line(line) {
                NonoEvent::SessionStarted { .. } => started += 1,
                NonoEvent::SessionEnded { .. } => ended += 1,
                _ => {}
            }
        }
        assert_eq!(started, 1);
        assert_eq!(ended, 1);
    }

    // ── Backpressure ──────────────────────────────────────────────────

    #[tokio::test]
    async fn overflow_does_not_block() {
        let (tx, _rx) = mpsc::channel::<NonoEvent>(4);
        let overflow = Arc::new(AtomicU64::new(0));
        let bounded = BoundedSender { tx, overflow };
        for _ in 0..20 {
            bounded
                .send(NonoEvent::Unparsed {
                    source: Source::Stdout,
                    line: "test".to_string(),
                    at: Instant::now(),
                })
                .await;
        }
        // Test passes if it does not hang.
    }

    // ── Session ID set before RequestAllowed events ───────────────────

    #[tokio::test]
    async fn session_id_set_before_request_allowed() {
        let (stdout_tx, stdout_rx) = mpsc::channel::<StdoutLine>(16);
        let (stderr_tx, stderr_rx) = mpsc::channel::<StderrLine>(16);

        let stream = EventCollector::start(12345, SystemTime::now(), stdout_rx, stderr_rx);
        let mut sid_rx = stream.session_id;

        stdout_tx
            .send(StdoutLine(
                "2026-06-08T19:01:35.296623Z DEBUG Session file created: /tmp/.nono/sessions/aabbccddeeff0011.json".to_string(),
            ))
            .await
            .unwrap();

        tokio::time::timeout(Duration::from_secs(2), sid_rx.changed())
            .await
            .expect("timed out waiting for session_id")
            .expect("watch error");

        assert_eq!(*sid_rx.borrow(), Some("aabbccddeeff0011".to_string()));

        drop(stdout_tx);
        drop(stderr_tx);
    }
}
