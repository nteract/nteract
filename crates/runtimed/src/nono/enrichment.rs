//! Error enrichment pipeline — converts raw nono events into user-facing
//! [`CellAnnotation`]s and writes them to [`RuntimeStateDoc`].
//!
//! This is task 08. It bridges the daemon's knowledge of nono proxy decisions
//! (task 06: `EventStream`) with the execution context (which cell is running
//! right now) and the Automerge document (task 02: `cell_annotations` map).
//!
//! ## Four scenarios (from `error-routing-design.md`)
//!
//! 1. **Missing credential at startup** — emits `sandbox_startup_failed` on
//!    the *next* execution attempted against a `StartupFailed` sandbox.
//!    Task 07 already surfaces this as a hard error; this module defers the
//!    annotation until a cell execution is attempted.
//!
//! 2. **Domain blocked at runtime** — a `RequestDenied` event with
//!    `reason` containing `"host_not_allowed"` correlates with the executing
//!    cell by time proximity. Emits `sandbox_domain_blocked`.
//!
//! 3. **Upstream rejects credential** — a `RequestAllowed` event with an HTTP
//!    401 in the reason string correlates with the executing cell.
//!    Emits `sandbox_credential_rejected`. (The `ALLOW` here means nono forwarded
//!    the request; the upstream rejected the key.)
//!
//! 4. **Proxy dies mid-session** — the supervisor reports `ProxyDied`.
//!    Emits `sandbox_proxy_degraded` on the currently-executing cell (or holds
//!    it for the next execution attempt if no cell is running).
//!
//! ## Time-window correlation
//!
//! The chosen window is `CORRELATION_WINDOW` (500 ms). Events that arrive:
//! - *During* an execution → attributed to that execution.
//! - *After* an execution ended but within 500 ms → attributed to the
//!   just-finished execution (nono may log slightly after the HTTP response
//!   is returned to the kernel).
//! - *Before* an execution starts but within 500 ms → held briefly and
//!   attributed to the next execution that starts (proxy latency).
//! - *Outside* the window → dropped.
//!
//! ## Multiple events coalesce
//!
//! If multiple nono events arrive during one execution, they are accumulated.
//! A single annotation is written when the execution ends (or when a 500 ms
//! quiet window elapses without new events), with `details.events` carrying
//! the full list.
//!
//! ## Tokio mutex invariant
//!
//! No `tokio::sync::Mutex` or `RwLock` guard is held across an `.await` in
//! this module. All `RuntimeStateHandle` writes go through
//! `handle.with_doc(|sd| …)` which uses `std::sync::Mutex` internally.

use std::time::{Duration, Instant};

use serde_json::json;
use tokio::sync::mpsc;
use tracing::{debug, warn};

use runtime_doc::{CellAnnotation, RuntimeStateHandle};

use crate::nono::events::{EventStream, NonoEvent, ProxyMode, Source};

// ── Constants ──────────────────────────────────────────────────────────────

/// Time window used for correlating nono events with executions.
///
/// Events that arrive within this window of an execution's start/end boundary
/// are attributed to that execution. 500 ms is chosen because:
/// - nono logs proxy decisions synchronously in the proxy path, so latency
///   relative to the Python kernel's HTTP request is typically <50 ms.
/// - A 500 ms window gives generous margin for scheduling jitter and kernel
///   startup without risk of misattributing events from adjacent executions
///   (which are separated by user think time in practice).
/// - Held events (pre-execution buffering) are also bounded by this window to
///   avoid indefinitely accumulating unattributed events.
const CORRELATION_WINDOW: Duration = Duration::from_millis(500);

/// Maximum number of event details to include in the `details.events` JSON array.
///
/// Prevents unbounded memory use in pathological high-rate scenarios.
const MAX_EVENTS_IN_DETAILS: usize = 50;

/// Capacity of the internal `ExecutionTransition` channel.
const EXEC_CHANNEL_CAPACITY: usize = 256;

// ── ExecutionTransition ───────────────────────────────────────────────────

/// A lifecycle event for one execution.
///
/// Produced by callers that observe the daemon's execution queue and consumed
/// by [`ExecutionObserver`] to track the current execution window.
#[derive(Debug, Clone)]
pub enum ExecutionTransition {
    /// An execution has started (kernel sent `execute_input`).
    Started {
        /// The execution ID that is now running.
        execution_id: String,
    },
    /// An execution has finished (kernel is idle again).
    Finished {
        /// The execution ID that just completed.
        execution_id: String,
    },
}

// ── ExecutionObserver ─────────────────────────────────────────────────────

/// Thin abstraction over the daemon's knowledge of "what execution is running".
///
/// Created once per sandbox session and handed to [`EnrichmentPipeline::start`].
/// The `tx` half lives with the runtime agent / kernel state machinery; the
/// `rx` half is consumed by the pipeline.
///
/// The sender is cloneable so multiple sites (kernel IOPub handler, lifecycle
/// state machine) can emit transitions without coordination.
pub struct ExecutionObserver {
    rx: mpsc::Receiver<ExecutionTransition>,
}

/// Sender half of an [`ExecutionObserver`] pair.
///
/// Clone this to give multiple callers a write endpoint.
#[derive(Clone)]
pub struct ExecutionObserverTx {
    tx: mpsc::Sender<ExecutionTransition>,
}

impl ExecutionObserver {
    /// Create an observer pair.
    ///
    /// The returned `(observer, tx)` tuple: hand `observer` to
    /// [`EnrichmentPipeline::start`] and `tx` to every site that transitions
    /// execution state.
    pub fn new() -> (Self, ExecutionObserverTx) {
        let (tx, rx) = mpsc::channel(EXEC_CHANNEL_CAPACITY);
        (Self { rx }, ExecutionObserverTx { tx })
    }
}

impl ExecutionObserverTx {
    /// Notify the pipeline that an execution has started.
    ///
    /// Non-blocking: if the channel is full the notification is dropped with a
    /// warning. This is the same back-pressure strategy used in `events.rs`.
    pub fn notify_started(&self, execution_id: String) {
        if let Err(e) = self
            .tx
            .try_send(ExecutionTransition::Started { execution_id })
        {
            warn!(
                "[nono::enrichment] ExecutionTransition channel full (Started): {}",
                e
            );
        }
    }

    /// Notify the pipeline that an execution has finished.
    pub fn notify_finished(&self, execution_id: String) {
        if let Err(e) = self
            .tx
            .try_send(ExecutionTransition::Finished { execution_id })
        {
            warn!(
                "[nono::enrichment] ExecutionTransition channel full (Finished): {}",
                e
            );
        }
    }
}

// ── Accumulated events per execution ──────────────────────────────────────

/// Buffered events for one execution, accumulated before a single annotation
/// is written. This prevents annotation flicker from multiple nono events
/// during a single cell run.
#[derive(Debug)]
struct AccumulatedEvents {
    execution_id: String,
    /// All events seen during the execution window.
    events: Vec<ClassifiedEvent>,
    /// The most recent event time (used for the 500 ms coalesce window).
    last_at: Instant,
}

/// A nono event classified into the annotation kind it will produce.
#[derive(Debug, Clone)]
enum ClassifiedEvent {
    DomainBlocked {
        host: String,
    },
    CredentialRejected {
        name: Option<String>,
        host: Option<String>,
    },
    CredentialMissing {
        name: Option<String>,
    },
    ProxyDegraded,
    StartupFailed {
        reason: String,
    },
}

impl AccumulatedEvents {
    fn new(execution_id: &str, event: ClassifiedEvent, at: Instant) -> Self {
        Self {
            execution_id: execution_id.to_string(),
            events: vec![event],
            last_at: at,
        }
    }

    fn push(&mut self, event: ClassifiedEvent, at: Instant) {
        if self.events.len() < MAX_EVENTS_IN_DETAILS {
            self.events.push(event);
        }
        self.last_at = at;
    }

    /// Choose the dominant annotation kind from accumulated events.
    ///
    /// Priority order (most severe first):
    ///   ProxyDegraded > StartupFailed > CredentialMissing >
    ///   CredentialRejected > DomainBlocked
    fn dominant_kind(&self) -> &ClassifiedEvent {
        for ev in &self.events {
            if matches!(ev, ClassifiedEvent::ProxyDegraded) {
                return ev;
            }
        }
        for ev in &self.events {
            if matches!(ev, ClassifiedEvent::StartupFailed { .. }) {
                return ev;
            }
        }
        for ev in &self.events {
            if matches!(ev, ClassifiedEvent::CredentialMissing { .. }) {
                return ev;
            }
        }
        for ev in &self.events {
            if matches!(ev, ClassifiedEvent::CredentialRejected { .. }) {
                return ev;
            }
        }
        &self.events[0]
    }

    /// Produce the `CellAnnotation` to write.
    fn into_annotation(&self) -> CellAnnotation {
        let details_events: Vec<serde_json::Value> = self
            .events
            .iter()
            .map(|e| json!({ "kind": e.kind_str() }))
            .collect();

        let details = Some(json!({ "events": details_events }));

        match self.dominant_kind() {
            ClassifiedEvent::DomainBlocked { host } => CellAnnotation {
                kind: "sandbox_domain_blocked".to_string(),
                message: format!(
                    "Network call to {host} was blocked by sandbox. \
                     Add it to allowed_domains in this notebook's sandbox profile to permit it."
                ),
                details,
            },
            ClassifiedEvent::CredentialRejected { name, host } => {
                let name_str = name.as_deref().unwrap_or("<unknown>");
                let host_str = host.as_deref().unwrap_or("<unknown>");
                CellAnnotation {
                    kind: "sandbox_credential_rejected".to_string(),
                    message: format!(
                        "Credential '{name_str}' was rejected by {host_str}. \
                         Verify the value in your keychain \u{2014} sandbox passed it through correctly."
                    ),
                    details,
                }
            }
            ClassifiedEvent::CredentialMissing { name } => {
                let name_str = name.as_deref().unwrap_or("<unknown>");
                CellAnnotation {
                    kind: "sandbox_credential_missing".to_string(),
                    message: format!(
                        "Credential '{name_str}' is referenced but not available. \
                         Add it via the credential manager."
                    ),
                    details,
                }
            }
            ClassifiedEvent::ProxyDegraded => CellAnnotation {
                kind: "sandbox_proxy_degraded".to_string(),
                message: "The sandbox proxy stopped. \
                          The runtime has lost network access; restart the kernel to recover."
                    .to_string(),
                details,
            },
            ClassifiedEvent::StartupFailed { reason } => CellAnnotation {
                kind: "sandbox_startup_failed".to_string(),
                message: format!("Sandbox could not start: {reason}. The kernel was not launched."),
                details,
            },
        }
    }
}

impl ClassifiedEvent {
    fn kind_str(&self) -> &'static str {
        match self {
            Self::DomainBlocked { .. } => "domain_blocked",
            Self::CredentialRejected { .. } => "credential_rejected",
            Self::CredentialMissing { .. } => "credential_missing",
            Self::ProxyDegraded => "proxy_degraded",
            Self::StartupFailed { .. } => "startup_failed",
        }
    }
}

// ── EnrichmentPipeline ────────────────────────────────────────────────────

/// The enrichment pipeline for one sandbox session.
///
/// Spawns a background tokio task that:
/// 1. Receives nono events from [`EventStream`].
/// 2. Receives execution transitions from [`ExecutionObserver`].
/// 3. Correlates events with executions by time proximity.
/// 4. Coalesces multiple events per execution into a single [`CellAnnotation`].
/// 5. Writes the annotation to `RuntimeStateDoc.cell_annotations` via
///    `RuntimeStateHandle::with_doc`.
///
/// The task exits when the `EventStream` events receiver returns `None`
/// (supervisor exited) or when the cancellation token fires.
pub struct EnrichmentPipeline;

impl EnrichmentPipeline {
    /// Spawn the background enrichment task.
    ///
    /// - `events`: the `EventStream` produced by task 06's `EventCollector`.
    /// - `observer`: the `ExecutionObserver` wired to the daemon's execution
    ///   lifecycle machinery.
    /// - `runtime_state`: the `RuntimeStateHandle` for annotation writes.
    /// - `startup_failed_reason`: if the sandbox failed to start (task 07
    ///   returned `StartupFailed`), pass the human-readable reason here. The
    ///   pipeline will emit a `sandbox_startup_failed` annotation on the next
    ///   execution attempt.
    /// - `cancel`: a `tokio_util::sync::CancellationToken` that triggers a
    ///   clean shutdown (replaces the `EventStream` EOF path).
    pub fn start(
        events: EventStream,
        observer: ExecutionObserver,
        runtime_state: RuntimeStateHandle,
        startup_failed_reason: Option<String>,
        cancel: tokio_util::sync::CancellationToken,
    ) {
        tokio::spawn(run_pipeline(
            events,
            observer,
            runtime_state,
            startup_failed_reason,
            cancel,
        ));
    }
}

// ── Pipeline main loop ─────────────────────────────────────────────────────

/// State tracked inside the pipeline loop.
struct PipelineState {
    /// The execution currently running, if any.
    current_execution: Option<ExecutionWindow>,
    /// Events that arrived before any execution started or just after one
    /// ended, held for up to `CORRELATION_WINDOW`.
    pending_events: Vec<(ClassifiedEvent, Instant)>,
    /// Accumulated events for the current execution (flushed on ExecutionDone).
    accumulated: Option<AccumulatedEvents>,
    /// If the sandbox failed to start, this is the reason to emit on the next
    /// execution attempt.
    startup_failed_reason: Option<String>,
    /// The last execution that finished (id + end time), for post-window
    /// attribution.
    last_finished: Option<(String, Instant)>,
}

struct ExecutionWindow {
    execution_id: String,
}

impl PipelineState {
    fn new(startup_failed_reason: Option<String>) -> Self {
        Self {
            current_execution: None,
            pending_events: Vec::new(),
            accumulated: None,
            startup_failed_reason,
            last_finished: None,
        }
    }

    /// Record execution start.
    fn on_execution_started(&mut self, execution_id: String, at: Instant) {
        debug!("[nono::enrichment] Execution started: {}", execution_id);

        // Flush any pending events that arrived just before this execution.
        // Attribution: events within CORRELATION_WINDOW before start are
        // considered part of this execution (proxy latency / pre-flight).
        let cutoff = at.checked_sub(CORRELATION_WINDOW).unwrap_or(at);
        let pre_events: Vec<(ClassifiedEvent, Instant)> = self
            .pending_events
            .drain(..)
            .filter(|(_, t)| *t >= cutoff)
            .collect();

        self.current_execution = Some(ExecutionWindow {
            execution_id: execution_id.clone(),
        });

        // Seed the accumulated buffer with any pre-start events.
        if !pre_events.is_empty() {
            let mut acc = None;
            for (ev, ev_at) in pre_events {
                match &mut acc {
                    None => {
                        acc = Some(AccumulatedEvents::new(&execution_id, ev, ev_at));
                    }
                    Some(a) => a.push(ev, ev_at),
                }
            }
            self.accumulated = acc;
        }

        // Emit startup-failure annotation if the sandbox never started.
        if let Some(reason) = self.startup_failed_reason.take() {
            let event = ClassifiedEvent::StartupFailed {
                reason: reason.clone(),
            };
            let at_now = Instant::now();
            match &mut self.accumulated {
                None => {
                    self.accumulated = Some(AccumulatedEvents::new(&execution_id, event, at_now));
                }
                Some(a) => a.push(event, at_now),
            }
        }
    }

    /// Record execution end; returns any annotation that should be written.
    fn on_execution_finished(
        &mut self,
        execution_id: &str,
        at: Instant,
    ) -> Option<(String, CellAnnotation)> {
        debug!("[nono::enrichment] Execution finished: {}", execution_id);

        // Only handle the current execution.
        let is_current = self
            .current_execution
            .as_ref()
            .map(|w| w.execution_id == execution_id)
            .unwrap_or(false);

        if !is_current {
            return None;
        }

        self.current_execution = None;
        self.last_finished = Some((execution_id.to_string(), at));

        // Flush accumulated events into an annotation.
        if let Some(acc) = self.accumulated.take() {
            if acc.execution_id == execution_id {
                return Some((execution_id.to_string(), acc.into_annotation()));
            } else {
                // Put it back (shouldn't normally happen).
                self.accumulated = Some(acc);
            }
        }
        None
    }

    /// Classify and route an incoming nono event.
    ///
    /// Returns `Some((execution_id, annotation))` if the event should be
    /// written immediately (e.g., proxy degraded with no running execution).
    fn on_nono_event(&mut self, event: NonoEvent, at: Instant) -> Option<(String, CellAnnotation)> {
        let classified = classify_event(&event);
        let classified = match classified {
            Some(c) => c,
            None => return None, // Not an actionable event.
        };

        // ProxyDied is special: write immediately to whatever is executing,
        // or hold for the next execution if nothing is running.
        if matches!(classified, ClassifiedEvent::ProxyDegraded) {
            return self.handle_proxy_degraded(at);
        }

        // All other events: attribute to the current execution window.
        match &self.current_execution {
            Some(window) => {
                let eid = window.execution_id.clone();
                match &mut self.accumulated {
                    None => {
                        self.accumulated = Some(AccumulatedEvents::new(&eid, classified, at));
                    }
                    Some(acc) if acc.execution_id == eid => {
                        acc.push(classified, at);
                    }
                    _ => {
                        // New execution started since the last flush — reset.
                        self.accumulated = Some(AccumulatedEvents::new(&eid, classified, at));
                    }
                }
                None // Will be flushed on ExecutionFinished.
            }
            None => {
                // No execution running. Check if we can attribute to the
                // just-finished execution (post-window).
                if let Some((ref last_eid, last_at)) = self.last_finished {
                    if at.duration_since(last_at) <= CORRELATION_WINDOW {
                        let eid = last_eid.clone();
                        let acc = AccumulatedEvents::new(&eid, classified, at);
                        return Some((eid, acc.into_annotation()));
                    }
                }
                // Hold for a future execution (pre-window buffer).
                if self.pending_events.len() < MAX_EVENTS_IN_DETAILS {
                    self.pending_events.push((classified, at));
                }
                None
            }
        }
    }

    /// Handle `ProxyDied`: write `sandbox_proxy_degraded` immediately.
    ///
    /// Attaches to the currently-executing cell. If no cell is executing,
    /// holds the annotation for the next execution (via `startup_failed_reason`
    /// reuse — we use a dedicated field for held proxy degradation).
    fn handle_proxy_degraded(&mut self, at: Instant) -> Option<(String, CellAnnotation)> {
        let annotation = CellAnnotation {
            kind: "sandbox_proxy_degraded".to_string(),
            message: "The sandbox proxy stopped. \
                      The runtime has lost network access; restart the kernel to recover."
                .to_string(),
            details: Some(json!({ "events": [{ "kind": "proxy_degraded" }] })),
        };

        if let Some(window) = &self.current_execution {
            let eid = window.execution_id.clone();
            // Also push to accumulated so it's in the details if the execution
            // finishes and triggers a flush.
            match &mut self.accumulated {
                None => {
                    self.accumulated = Some(AccumulatedEvents::new(
                        &eid,
                        ClassifiedEvent::ProxyDegraded,
                        at,
                    ));
                }
                Some(acc) => acc.push(ClassifiedEvent::ProxyDegraded, at),
            }
            return Some((eid, annotation));
        }

        // No current execution — hold as a startup-like failure for the next attempt.
        // Reuse the startup_failed_reason slot (only one global failure at a time).
        self.startup_failed_reason = Some(
            "The sandbox proxy stopped. \
             The runtime has lost network access; restart the kernel to recover."
                .to_string(),
        );
        None
    }

    /// Sweep pending events older than `CORRELATION_WINDOW` — drop them.
    ///
    /// Call periodically to avoid indefinite accumulation of pre-execution
    /// buffered events when no execution ever starts.
    fn sweep_stale_pending(&mut self, now: Instant) {
        let cutoff = now.checked_sub(CORRELATION_WINDOW).unwrap_or(now);
        self.pending_events.retain(|(_, t)| *t >= cutoff);
    }

    /// Check whether accumulated events should be flushed due to a quiet
    /// window elapsing (no new events for `CORRELATION_WINDOW` after the last
    /// event while an execution is still running).
    ///
    /// Returns `Some(annotation)` if the quiet-window flush fires.
    fn check_quiet_window_flush(&mut self, now: Instant) -> Option<(String, CellAnnotation)> {
        let acc = self.accumulated.as_ref()?;
        if now.duration_since(acc.last_at) >= CORRELATION_WINDOW {
            let acc = self.accumulated.take()?;
            let eid = acc.execution_id.clone();
            Some((eid, acc.into_annotation()))
        } else {
            None
        }
    }
}

// ── Event classification ──────────────────────────────────────────────────

/// Map a raw `NonoEvent` to a `ClassifiedEvent`, or return `None` for events
/// that are not actionable (session lifecycle, debug noise, etc.).
fn classify_event(event: &NonoEvent) -> Option<ClassifiedEvent> {
    match event {
        // DENY CONNECT … reason contains "host_not_allowed" → domain blocked
        NonoEvent::RequestDenied {
            mode: ProxyMode::Connect | ProxyMode::ConnectIntercept,
            host,
            reason,
            ..
        } if reason_contains(reason, "host_not_allowed") => Some(ClassifiedEvent::DomainBlocked {
            host: host.clone().unwrap_or_else(|| "<unknown>".to_string()),
        }),

        // DENY CONNECT … reason contains "credential_missing" → missing credential
        NonoEvent::RequestDenied {
            mode: ProxyMode::Connect | ProxyMode::ConnectIntercept,
            reason,
            ..
        } if reason_contains(reason, "credential_missing")
            || reason_contains(reason, "managed credential unavailable") =>
        {
            Some(ClassifiedEvent::CredentialMissing {
                name: extract_credential_name_from_reason(reason),
            })
        }

        // ALLOW REVERSE … with 401 in the reason or raw → credential rejected by upstream
        NonoEvent::RequestAllowed {
            mode: ProxyMode::Reverse,
            raw,
            host,
            ..
        } if raw.contains("401") || raw.contains("-> 401") => {
            Some(ClassifiedEvent::CredentialRejected {
                name: extract_credential_name_from_raw(raw),
                host: host.clone(),
            })
        }

        // DENY for any reason in reverse mode → could be credential missing
        NonoEvent::RequestDenied {
            mode: ProxyMode::Reverse,
            reason,
            ..
        } if reason_contains(reason, "credential_missing")
            || reason_contains(reason, "managed credential unavailable") =>
        {
            Some(ClassifiedEvent::CredentialMissing {
                name: extract_credential_name_from_reason(reason),
            })
        }

        // Stderr line that looks like a credential-not-found startup error.
        // nono writes: "nono: Secret not found in keystore: <name>"
        NonoEvent::Unparsed {
            source: Source::Stderr,
            line,
            ..
        } if line.contains("Secret not found in keystore")
            || line.contains("Keystore access failed") =>
        {
            Some(ClassifiedEvent::CredentialMissing {
                name: extract_credential_name_from_stderr(line),
            })
        }

        // Not an actionable event.
        _ => None,
    }
}

fn reason_contains(reason: &str, needle: &str) -> bool {
    reason.to_lowercase().contains(needle)
}

/// Extract a credential name from the `reason` field.
///
/// Handles patterns like:
/// - `"managed credential unavailable for route 'analytics_api': …"`
fn extract_credential_name_from_reason(reason: &str) -> Option<String> {
    // Pattern: "for route '<name>'"
    if let Some(after_route) = reason.find("for route '") {
        let rest = &reason[after_route + "for route '".len()..];
        if let Some(end) = rest.find('\'') {
            return Some(rest[..end].to_string());
        }
    }
    None
}

/// Extract a credential name from a raw log line.
///
/// The raw line for a reverse proxy decision looks like:
/// `… proxy request allowed mode=reverse … service="analytics_api" …`
fn extract_credential_name_from_raw(raw: &str) -> Option<String> {
    // Look for service="<name>"
    if let Some(after_service) = raw.find("service=\"") {
        let rest = &raw[after_service + "service=\"".len()..];
        if let Some(end) = rest.find('"') {
            return Some(rest[..end].to_string());
        }
    }
    None
}

/// Extract credential name from a nono startup stderr line.
///
/// Pattern: `"nono: Secret not found in keystore: <name>"`
fn extract_credential_name_from_stderr(line: &str) -> Option<String> {
    if let Some(after_colon) = line.rfind(": ") {
        let name = line[after_colon + 2..].trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    None
}

// ── Main loop ─────────────────────────────────────────────────────────────

async fn run_pipeline(
    mut events: EventStream,
    mut observer: ExecutionObserver,
    runtime_state: RuntimeStateHandle,
    startup_failed_reason: Option<String>,
    cancel: tokio_util::sync::CancellationToken,
) {
    debug!("[nono::enrichment] Pipeline started");
    let mut state = PipelineState::new(startup_failed_reason);

    // Quiet-window sweep timer: check every 100ms whether the accumulated
    // events should be flushed due to inactivity.
    let mut sweep_interval = tokio::time::interval(Duration::from_millis(100));
    sweep_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        tokio::select! {
            // ── Cancellation ─────────────────────────────────────────────
            _ = cancel.cancelled() => {
                debug!("[nono::enrichment] Pipeline cancelled");
                break;
            }

            // ── Nono events ───────────────────────────────────────────────
            event = events.events.recv() => {
                match event {
                    Some(ev) => {
                        let at = Instant::now();
                        if let Some((eid, annotation)) = state.on_nono_event(ev, at) {
                            write_annotation(&runtime_state, &eid, &annotation);
                        }
                    }
                    None => {
                        // EventStream closed (supervisor exited).
                        debug!("[nono::enrichment] Event stream closed; flushing and exiting");
                        flush_accumulated(&mut state, &runtime_state);
                        break;
                    }
                }
            }

            // ── Execution transitions ─────────────────────────────────────
            transition = observer.rx.recv() => {
                match transition {
                    Some(ExecutionTransition::Started { execution_id }) => {
                        let at = Instant::now();
                        state.on_execution_started(execution_id, at);
                    }
                    Some(ExecutionTransition::Finished { execution_id }) => {
                        let at = Instant::now();
                        if let Some((eid, annotation)) =
                            state.on_execution_finished(&execution_id, at)
                        {
                            write_annotation(&runtime_state, &eid, &annotation);
                        }
                    }
                    None => {
                        // Observer channel closed — pipeline is done.
                        debug!("[nono::enrichment] Execution observer closed; exiting");
                        flush_accumulated(&mut state, &runtime_state);
                        break;
                    }
                }
            }

            // ── Quiet-window sweep ────────────────────────────────────────
            _ = sweep_interval.tick() => {
                let now = Instant::now();
                state.sweep_stale_pending(now);
                if let Some((eid, annotation)) = state.check_quiet_window_flush(now) {
                    write_annotation(&runtime_state, &eid, &annotation);
                }
            }
        }
    }

    debug!("[nono::enrichment] Pipeline stopped");
}

/// Write a `CellAnnotation` to `RuntimeStateDoc.cell_annotations`.
///
/// Uses `RuntimeStateHandle::with_doc` (std::sync::Mutex) — never holds the
/// guard across an `.await`. Logs a warning on write failure but never panics.
fn write_annotation(
    runtime_state: &RuntimeStateHandle,
    execution_id: &str,
    annotation: &CellAnnotation,
) {
    debug!(
        "[nono::enrichment] Writing annotation kind={} for execution={}",
        annotation.kind, execution_id
    );
    if let Err(e) = runtime_state.with_doc(|sd| sd.set_cell_annotation(execution_id, annotation)) {
        warn!(
            "[nono::enrichment] Failed to write annotation for {}: {}",
            execution_id, e
        );
    }
}

/// Flush any accumulated events when the pipeline is shutting down.
fn flush_accumulated(state: &mut PipelineState, runtime_state: &RuntimeStateHandle) {
    if let Some(acc) = state.accumulated.take() {
        let eid = acc.execution_id.clone();
        let annotation = acc.into_annotation();
        write_annotation(runtime_state, &eid, &annotation);
    }
}

// ── Startup failure deferred emit ─────────────────────────────────────────

/// Create an [`EnrichmentPipeline`] pre-seeded with a startup failure reason.
///
/// When the sandbox fails to start (task 07 returns `StartupFailed`), pass the
/// failure reason here. The pipeline will emit a `sandbox_startup_failed`
/// annotation on the next execution attempt.
///
/// This is the entry point called by the daemon's "kernel not ready" path when
/// an execute request arrives and `SandboxState::StartupFailed` is set.
pub fn emit_startup_failure_annotation(
    runtime_state: &RuntimeStateHandle,
    execution_id: &str,
    reason: &str,
) {
    let annotation = CellAnnotation {
        kind: "sandbox_startup_failed".to_string(),
        message: format!("Sandbox could not start: {reason}. The kernel was not launched."),
        details: Some(json!({ "events": [{ "kind": "startup_failed", "reason": reason }] })),
    };
    write_annotation(runtime_state, execution_id, &annotation);
}

// ── Tests ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::time::Instant;

    use runtime_doc::{CellAnnotation, RuntimeStateDoc};
    use tokio::sync::broadcast;

    use crate::nono::events::{EventStream, NonoEvent, ProxyMode, Source};

    use super::*;

    // ── Helpers ────────────────────────────────────────────────────────

    fn make_runtime_state() -> RuntimeStateHandle {
        let doc = RuntimeStateDoc::new();
        let (tx, _) = broadcast::channel(16);
        RuntimeStateHandle::new(doc, tx)
    }

    fn make_event_stream_pair() -> (mpsc::Sender<NonoEvent>, EventStream) {
        let (ev_tx, ev_rx) = mpsc::channel(256);
        let (_sid_tx, sid_rx) = tokio::sync::watch::channel(None);
        let stream = EventStream {
            events: ev_rx,
            session_id: sid_rx,
        };
        (ev_tx, stream)
    }

    fn denied_event(host: &str, reason: &str) -> NonoEvent {
        NonoEvent::RequestDenied {
            mode: ProxyMode::ConnectIntercept,
            host: Some(host.to_string()),
            port: Some(443),
            reason: reason.to_string(),
            at: Instant::now(),
            raw: format!("proxy request denied host=\"{host}\" reason=\"{reason}\""),
        }
    }

    fn allowed_event_401(host: &str, service: &str) -> NonoEvent {
        NonoEvent::RequestAllowed {
            mode: ProxyMode::Reverse,
            host: Some(host.to_string()),
            port: Some(443),
            method: Some("GET".to_string()),
            at: Instant::now(),
            raw: format!(
                "proxy request allowed mode=reverse host=\"{host}\" service=\"{service}\" -> 401"
            ),
        }
    }

    fn stderr_event(line: &str) -> NonoEvent {
        NonoEvent::Unparsed {
            source: Source::Stderr,
            line: line.to_string(),
            at: Instant::now(),
        }
    }

    fn get_annotations(handle: &RuntimeStateHandle) -> HashMap<String, CellAnnotation> {
        handle
            .read(|sd| sd.read_state().cell_annotations.clone())
            .unwrap()
    }

    // ── Unit tests: event classification ─────────────────────────────

    #[test]
    fn classify_host_not_allowed_connect() {
        let ev = denied_event("api.example.com", "host_not_allowed");
        let classified = classify_event(&ev);
        assert!(
            matches!(classified, Some(ClassifiedEvent::DomainBlocked { .. })),
            "host_not_allowed should become DomainBlocked, got: {:?}",
            classified
        );
    }

    #[test]
    fn classify_credential_missing_connect() {
        let ev = denied_event(
            "api.example.com",
            "managed credential unavailable for route 'analytics_api': not loaded",
        );
        let classified = classify_event(&ev);
        assert!(
            matches!(classified, Some(ClassifiedEvent::CredentialMissing { .. })),
            "credential unavailable should become CredentialMissing"
        );
    }

    #[test]
    fn classify_credential_rejected_reverse_401() {
        let ev = allowed_event_401("analytics.example.com", "analytics_api");
        let classified = classify_event(&ev);
        assert!(
            matches!(classified, Some(ClassifiedEvent::CredentialRejected { .. })),
            "ALLOW REVERSE -> 401 should become CredentialRejected"
        );
    }

    #[test]
    fn classify_stderr_credential_missing() {
        let ev = stderr_event("nono: Secret not found in keystore: my_api_key");
        let classified = classify_event(&ev);
        assert!(
            matches!(classified, Some(ClassifiedEvent::CredentialMissing { .. })),
            "stderr credential missing should become CredentialMissing"
        );
    }

    #[test]
    fn classify_unrelated_unparsed_is_none() {
        let ev = NonoEvent::Unparsed {
            source: Source::Stdout,
            line: "some debug line".to_string(),
            at: Instant::now(),
        };
        assert!(
            classify_event(&ev).is_none(),
            "debug lines should not produce events"
        );
    }

    #[test]
    fn classify_session_started_is_none() {
        let ev = NonoEvent::SessionStarted {
            session_id: "abc".to_string(),
            at: std::time::SystemTime::now(),
        };
        assert!(classify_event(&ev).is_none());
    }

    // ── Unit tests: annotation mapping ────────────────────────────────

    #[test]
    fn domain_blocked_annotation_message() {
        let ev = AccumulatedEvents::new(
            "exec-1",
            ClassifiedEvent::DomainBlocked {
                host: "api.example.com".to_string(),
            },
            Instant::now(),
        );
        let ann = ev.into_annotation();
        assert_eq!(ann.kind, "sandbox_domain_blocked");
        assert!(
            ann.message.contains("api.example.com"),
            "message should include the host"
        );
        assert!(ann.message.contains("allowed_domains"));
    }

    #[test]
    fn credential_rejected_annotation_message() {
        let ev = AccumulatedEvents::new(
            "exec-1",
            ClassifiedEvent::CredentialRejected {
                name: Some("analytics_api".to_string()),
                host: Some("analytics.example.com".to_string()),
            },
            Instant::now(),
        );
        let ann = ev.into_annotation();
        assert_eq!(ann.kind, "sandbox_credential_rejected");
        assert!(ann.message.contains("analytics_api"));
        assert!(ann.message.contains("analytics.example.com"));
        assert!(ann.message.contains("keychain"));
    }

    #[test]
    fn credential_missing_annotation_message() {
        let ev = AccumulatedEvents::new(
            "exec-1",
            ClassifiedEvent::CredentialMissing {
                name: Some("my_key".to_string()),
            },
            Instant::now(),
        );
        let ann = ev.into_annotation();
        assert_eq!(ann.kind, "sandbox_credential_missing");
        assert!(ann.message.contains("my_key"));
        assert!(ann.message.contains("credential manager"));
    }

    #[test]
    fn proxy_degraded_annotation_message() {
        let ev = AccumulatedEvents::new("exec-1", ClassifiedEvent::ProxyDegraded, Instant::now());
        let ann = ev.into_annotation();
        assert_eq!(ann.kind, "sandbox_proxy_degraded");
        assert!(ann.message.contains("restart"));
    }

    #[test]
    fn startup_failed_annotation_message() {
        let ev = AccumulatedEvents::new(
            "exec-1",
            ClassifiedEvent::StartupFailed {
                reason: "credential 'api_key' not found".to_string(),
            },
            Instant::now(),
        );
        let ann = ev.into_annotation();
        assert_eq!(ann.kind, "sandbox_startup_failed");
        assert!(ann.message.contains("api_key"));
    }

    // ── Unit tests: coalescing ─────────────────────────────────────────

    #[test]
    fn multiple_events_coalesce_into_one_annotation() {
        let now = Instant::now();
        let mut acc = AccumulatedEvents::new(
            "exec-1",
            ClassifiedEvent::DomainBlocked {
                host: "a.example.com".to_string(),
            },
            now,
        );
        acc.push(
            ClassifiedEvent::DomainBlocked {
                host: "b.example.com".to_string(),
            },
            now,
        );
        acc.push(
            ClassifiedEvent::DomainBlocked {
                host: "c.example.com".to_string(),
            },
            now,
        );
        assert_eq!(acc.events.len(), 3);
        let ann = acc.into_annotation();
        // One annotation, with details listing all 3 events.
        assert_eq!(ann.kind, "sandbox_domain_blocked");
        let details = ann.details.unwrap();
        let events = details["events"].as_array().unwrap();
        assert_eq!(events.len(), 3);
    }

    #[test]
    fn proxy_degraded_dominates_domain_blocked() {
        let now = Instant::now();
        let mut acc = AccumulatedEvents::new(
            "exec-1",
            ClassifiedEvent::DomainBlocked {
                host: "a.example.com".to_string(),
            },
            now,
        );
        acc.push(ClassifiedEvent::ProxyDegraded, now);
        let ann = acc.into_annotation();
        assert_eq!(
            ann.kind, "sandbox_proxy_degraded",
            "ProxyDegraded should dominate DomainBlocked"
        );
    }

    // ── Integration tests: pipeline state machine ─────────────────────

    #[test]
    fn event_during_execution_attributed_to_execution() {
        let mut state = PipelineState::new(None);
        let t0 = Instant::now();

        state.on_execution_started("exec-1".to_string(), t0);

        // Nono event arrives during the execution.
        let ev = denied_event("api.example.com", "host_not_allowed");
        let result = state.on_nono_event(ev, t0);
        // Should not write immediately; will flush on Finished.
        assert!(
            result.is_none(),
            "event during execution should be accumulated, not written"
        );

        // Execution ends.
        let result = state.on_execution_finished("exec-1", Instant::now());
        assert!(
            result.is_some(),
            "annotation should be produced on execution finish"
        );
        let (eid, ann) = result.unwrap();
        assert_eq!(eid, "exec-1");
        assert_eq!(ann.kind, "sandbox_domain_blocked");
    }

    #[test]
    fn event_after_execution_within_window_attributed_to_last_execution() {
        let mut state = PipelineState::new(None);
        let t0 = Instant::now();

        state.on_execution_started("exec-1".to_string(), t0);
        let _finish_result = state.on_execution_finished("exec-1", t0);

        // Event arrives just after execution ended (within CORRELATION_WINDOW).
        let ev = denied_event("api.example.com", "host_not_allowed");
        let result = state.on_nono_event(ev, t0 + Duration::from_millis(100));
        // Should be attributed to the just-finished execution immediately.
        assert!(
            result.is_some(),
            "post-execution event within window should be attributed"
        );
        let (eid, ann) = result.unwrap();
        assert_eq!(eid, "exec-1");
        assert_eq!(ann.kind, "sandbox_domain_blocked");
    }

    #[test]
    fn event_outside_window_is_dropped() {
        let mut state = PipelineState::new(None);
        let t0 = Instant::now();

        state.on_execution_started("exec-1".to_string(), t0);
        let _finish_result = state.on_execution_finished("exec-1", t0);

        // Simulate an event far outside the correlation window.
        // We do this by manipulating last_finished's timestamp.
        let old_time = t0
            .checked_sub(CORRELATION_WINDOW + Duration::from_millis(100))
            .unwrap_or(t0);
        state.last_finished = Some(("exec-1".to_string(), old_time));

        let ev = denied_event("api.example.com", "host_not_allowed");
        let result = state.on_nono_event(ev, Instant::now());
        // Should not be attributed — goes to pending and will be swept.
        assert!(
            result.is_none(),
            "out-of-window event should not be attributed immediately"
        );
    }

    #[test]
    fn proxy_died_during_execution_writes_annotation() {
        let mut state = PipelineState::new(None);
        let t0 = Instant::now();

        state.on_execution_started("exec-1".to_string(), t0);

        let result = state.handle_proxy_degraded(t0);
        assert!(
            result.is_some(),
            "ProxyDied during execution should produce annotation"
        );
        let (eid, ann) = result.unwrap();
        assert_eq!(eid, "exec-1");
        assert_eq!(ann.kind, "sandbox_proxy_degraded");
    }

    #[test]
    fn proxy_died_no_execution_held_for_next() {
        let mut state = PipelineState::new(None);
        let t0 = Instant::now();

        let result = state.handle_proxy_degraded(t0);
        assert!(
            result.is_none(),
            "ProxyDied with no execution should be held, not written"
        );
        // Should be stored as startup_failed_reason for next execution.
        assert!(
            state.startup_failed_reason.is_some(),
            "startup_failed_reason should be set as fallback"
        );

        // Next execution should pick it up.
        state.on_execution_started("exec-1".to_string(), Instant::now());
        assert!(
            state.accumulated.is_some(),
            "accumulated should be seeded from startup_failed_reason"
        );
    }

    #[test]
    fn startup_failure_emitted_on_next_execution() {
        let mut state = PipelineState::new(Some("credential 'api_key' not found".to_string()));

        state.on_execution_started("exec-1".to_string(), Instant::now());

        // The startup failure should have been seeded into accumulated.
        assert!(
            state.accumulated.is_some(),
            "startup failure should seed the accumulated buffer"
        );

        let result = state.on_execution_finished("exec-1", Instant::now());
        assert!(result.is_some(), "annotation should be produced on finish");
        let (eid, ann) = result.unwrap();
        assert_eq!(eid, "exec-1");
        assert_eq!(ann.kind, "sandbox_startup_failed");
    }

    #[test]
    fn sweep_removes_old_pending_events() {
        let mut state = PipelineState::new(None);

        // Add an event to pending (no execution running).
        let old_time = Instant::now()
            .checked_sub(CORRELATION_WINDOW + Duration::from_millis(200))
            .unwrap_or(Instant::now());
        state.pending_events.push((
            ClassifiedEvent::DomainBlocked {
                host: "x.com".to_string(),
            },
            old_time,
        ));

        assert_eq!(state.pending_events.len(), 1);
        state.sweep_stale_pending(Instant::now());
        assert_eq!(
            state.pending_events.len(),
            0,
            "old pending events should be swept"
        );
    }

    // ── Integration: pipeline writes to RuntimeStateHandle ─────────────

    #[tokio::test]
    async fn pipeline_writes_annotation_on_execution_finish() {
        let runtime_state = make_runtime_state();
        let (ev_tx, ev_stream) = make_event_stream_pair();
        let (observer, obs_tx) = ExecutionObserver::new();
        let cancel = tokio_util::sync::CancellationToken::new();

        // First create the execution entry in the doc.
        runtime_state
            .with_doc(|sd| sd.create_execution("exec-integration"))
            .unwrap();

        EnrichmentPipeline::start(
            ev_stream,
            observer,
            runtime_state.clone(),
            None,
            cancel.clone(),
        );

        // Signal execution started.
        obs_tx.notify_started("exec-integration".to_string());

        // Send a nono event.
        ev_tx
            .send(denied_event("api.example.com", "host_not_allowed"))
            .await
            .unwrap();

        // Signal execution finished.
        obs_tx.notify_finished("exec-integration".to_string());

        // Give the pipeline a moment to flush.
        tokio::time::sleep(Duration::from_millis(200)).await;

        cancel.cancel();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let annotations = get_annotations(&runtime_state);
        assert!(
            annotations.contains_key("exec-integration"),
            "annotation should be written for the execution"
        );
        let ann = &annotations["exec-integration"];
        assert_eq!(ann.kind, "sandbox_domain_blocked");
        assert!(ann.message.contains("api.example.com"));
    }

    #[tokio::test]
    async fn pipeline_coalesces_multiple_events() {
        let runtime_state = make_runtime_state();
        let (ev_tx, ev_stream) = make_event_stream_pair();
        let (observer, obs_tx) = ExecutionObserver::new();
        let cancel = tokio_util::sync::CancellationToken::new();

        runtime_state
            .with_doc(|sd| sd.create_execution("exec-coalesce"))
            .unwrap();

        EnrichmentPipeline::start(
            ev_stream,
            observer,
            runtime_state.clone(),
            None,
            cancel.clone(),
        );

        obs_tx.notify_started("exec-coalesce".to_string());

        // Send three events.
        for host in ["a.example.com", "b.example.com", "c.example.com"] {
            ev_tx
                .send(denied_event(host, "host_not_allowed"))
                .await
                .unwrap();
        }

        // Yield to give the pipeline a chance to consume the events before
        // processing the Finished transition.
        tokio::time::sleep(Duration::from_millis(50)).await;

        obs_tx.notify_finished("exec-coalesce".to_string());
        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel();
        tokio::time::sleep(Duration::from_millis(50)).await;

        let annotations = get_annotations(&runtime_state);
        assert!(annotations.contains_key("exec-coalesce"));
        let ann = &annotations["exec-coalesce"];
        // One annotation with 3 events in details.
        let details = ann.details.as_ref().unwrap();
        let events = details["events"].as_array().unwrap();
        assert_eq!(events.len(), 3, "all 3 events should be in details");
    }

    #[tokio::test]
    async fn pipeline_startup_failure_on_next_execution() {
        let runtime_state = make_runtime_state();
        let (ev_tx, ev_stream) = make_event_stream_pair();
        let (observer, obs_tx) = ExecutionObserver::new();
        let cancel = tokio_util::sync::CancellationToken::new();

        runtime_state
            .with_doc(|sd| sd.create_execution("exec-startup"))
            .unwrap();

        EnrichmentPipeline::start(
            ev_stream,
            observer,
            runtime_state.clone(),
            Some("credential 'api_key' not found".to_string()),
            cancel.clone(),
        );

        obs_tx.notify_started("exec-startup".to_string());
        obs_tx.notify_finished("exec-startup".to_string());

        tokio::time::sleep(Duration::from_millis(200)).await;
        cancel.cancel();
        tokio::time::sleep(Duration::from_millis(50)).await;

        // ev_tx is held alive here, but we can drop it.
        drop(ev_tx);

        let annotations = get_annotations(&runtime_state);
        assert!(annotations.contains_key("exec-startup"));
        let ann = &annotations["exec-startup"];
        assert_eq!(ann.kind, "sandbox_startup_failed");
        assert!(ann.message.contains("api_key"));
    }

    // ── emit_startup_failure_annotation ───────────────────────────────

    #[test]
    fn emit_startup_failure_writes_annotation() {
        let runtime_state = make_runtime_state();
        runtime_state
            .with_doc(|sd| sd.create_execution("exec-sf"))
            .unwrap();

        emit_startup_failure_annotation(
            &runtime_state,
            "exec-sf",
            "credential 'openai_api' not found in keychain",
        );

        let annotations = get_annotations(&runtime_state);
        assert!(annotations.contains_key("exec-sf"));
        let ann = &annotations["exec-sf"];
        assert_eq!(ann.kind, "sandbox_startup_failed");
        assert!(ann.message.contains("openai_api"));
    }

    // ── Extract helpers ────────────────────────────────────────────────

    #[test]
    fn extract_credential_name_from_route_reason() {
        let reason = "managed credential unavailable for route 'analytics_api': not loaded";
        assert_eq!(
            extract_credential_name_from_reason(reason),
            Some("analytics_api".to_string())
        );
    }

    #[test]
    fn extract_credential_name_from_raw_service_field() {
        let raw = r#"proxy request allowed mode=reverse host="x.com" service="my_cred" -> 401"#;
        assert_eq!(
            extract_credential_name_from_raw(raw),
            Some("my_cred".to_string())
        );
    }

    #[test]
    fn extract_credential_name_from_stderr_line() {
        let line = "nono: Secret not found in keystore: openai_key";
        assert_eq!(
            extract_credential_name_from_stderr(line),
            Some("openai_key".to_string())
        );
    }

    #[test]
    fn runtime_doc_writes_go_through_set_cell_annotation() {
        // Verify that set_cell_annotation is the only write path — no direct
        // doc manipulation happens in this module.
        let runtime_state = make_runtime_state();
        runtime_state
            .with_doc(|sd| sd.create_execution("exec-api"))
            .unwrap();

        let annotation = CellAnnotation {
            kind: "sandbox_domain_blocked".to_string(),
            message: "test".to_string(),
            details: None,
        };
        write_annotation(&runtime_state, "exec-api", &annotation);

        let state = runtime_state.read(|sd| sd.read_state()).unwrap();
        assert!(state.cell_annotations.contains_key("exec-api"));
    }
}
