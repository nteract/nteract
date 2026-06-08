# Task 08: Error enrichment pipeline

## Framing

Convert raw nono events (from task 06) into user-facing `CellAnnotation`s (defined in task 02), correlating sandbox signals with the executing cell. This is the heart of the error UX: it turns "kernel got HTTP 403" into "the domain `api.example.com` is not in this notebook's allowlist."

Depends on tasks 02, 06, and 07. Blocks tasks 09, 11 (consumers of annotations), and 12.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-7 (error storage)**
- `docs/sandbox/error-routing-design.md` — the entire document, especially the four scenarios and the enrichment architecture section
- `docs/sandbox/nono-error-signals.md` — the signal taxonomy
- `docs/sandbox/ux-credential-sandbox-design.md` — the user-facing error messages section

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

The four scenarios from `error-routing-design.md`:

1. **Missing credential at startup** — `Supervisor::spawn` returns `StartupFailure`. No correlation needed; this is a runtime-wide failure that must be surfaced before any cell executes. Task 07 already returns this as `SandboxLaunchError`. This task may emit an additional annotation on the *next* execution explaining the error in cell context, if/when a user attempts to run a cell with the sandbox in `StartupFailed` state.

2. **Domain blocked at runtime** — stderr emits `DENY CONNECT <host> reason=host_not_allowed`. Python sees HTTP 403 on the request. Correlate with the executing cell by **time proximity** (the DENY happened during this execution's wall-clock window). Emit annotation: `kind = "sandbox_domain_blocked"`, `message = "Network call to <host> was blocked. Add it to the notebook's allowed_domains."`.

3. **Upstream rejects credential** — stderr emits `ALLOW REVERSE <name> ... -> 401`. Python sees HTTP 401. The `ALLOW` confirms nono processed the request; the 401 came from upstream. Emit annotation: `kind = "sandbox_credential_rejected"`, `message = "Credential <name> was rejected by <host>. Verify the secret in your keychain."`.

4. **Proxy dies mid-session** — Supervisor reports `SupervisorExit::ProxyDied`. All subsequent network calls fail with connection-refused. Mark `SandboxState::Degraded` (task 07 already does this); this task adds a global runtime-level annotation, not a per-cell one. Surface via the same `cell_annotations` field by attaching to the currently-executing cell; if no cell is executing, hold the annotation and apply it to the next execution attempt.

Annotations are stored in `RuntimeStateDoc.cell_annotations` keyed by `execution_id`.

## Technical steps

### 1. Module skeleton

Add `crates/runtimed/src/nono/enrichment.rs` (re-export from `crates/runtimed/src/nono/mod.rs`).

```rust
pub struct EnrichmentPipeline {
    // private — owns receivers, holds correlation state
}

impl EnrichmentPipeline {
    /// Spawns a background task. Consumes the EventStream from task 06 and an execution
    /// observer that reports start/end of each execution_id.
    pub fn start(
        events: EventStream,
        executions: ExecutionObserver,
        runtime_state: RuntimeStateHandle,
    );
}
```

`ExecutionObserver` is a thin abstraction over the daemon's existing knowledge of "what execution is running right now":
- `current_execution_id() -> Option<String>` — what's executing right now
- `subscribe() -> mpsc::Receiver<ExecutionTransition>` where `ExecutionTransition = { Started(execution_id), Finished(execution_id) }`

The observer wraps existing daemon machinery; do **not** invent a new state store. Use whatever the runtime-agent uses to track the current execution.

`RuntimeStateHandle` is an existing daemon abstraction over `RuntimeStateDoc` writes (task 02 provides the setter `set_cell_annotation`). If a clean handle does not yet exist, this task may add a thin one — but it must follow the AGENTS.md tokio-mutex invariant (no awaits while holding `RuntimeStateDoc` locks).

### 2. Correlation strategy

Use **time-window correlation**:

- When an execution starts, record its start `Instant`
- When a `NonoEvent` arrives with timestamp `t`, attribute it to the execution if `start <= t <= end_or_now`
- If no execution is currently running and the event arrives, hold it for up to ~500ms in case an execution is about to start (e.g. queued); after the window expires, drop or attach to the next execution

Edge cases:
- Multiple events during one execution → emit a single annotation summarizing all events (do not write a new annotation per event; that creates flicker). Use `details: Some(json!({ "events": [...] }))` to attach the structured list.
- Event arrives after the execution has finished but before the next started → attach to the just-finished execution if within ~500ms.

Document the chosen window in the source.

### 3. Event → annotation mapping

| Source event | Annotation kind | Message template |
|---|---|---|
| `RequestDenied { kind: Connect, host, reason: "host_not_allowed" }` | `sandbox_domain_blocked` | `"Network call to {host} was blocked by sandbox. Add it to allowed_domains in this notebook's sandbox profile to permit it."` |
| `RequestAllowed { kind: Reverse, credential: Some(name), status: Some(401) }` | `sandbox_credential_rejected` | `"Credential '{name}' was rejected by {host}. Verify the value in your keychain — sandbox passed it through correctly."` |
| `RequestDenied { reason: "credential_missing" }` | `sandbox_credential_missing` | `"Credential '{name}' is referenced but not available. Add it via the credential manager."` |
| Supervisor reports `SupervisorExit::ProxyDied` | `sandbox_proxy_degraded` | `"The sandbox proxy stopped. The runtime has lost network access; restart the kernel to recover."` |
| `SupervisorExit::StartupFailure` (deferred-emit on next execution) | `sandbox_startup_failed` | `"Sandbox could not start: {reason}. The kernel was not launched."` |

`details` field is the structured event JSON for debugging.

### 4. Defer-emit for startup failure

If task 07 surfaced `StartupFailed` and a user attempts to execute a cell in that state, the daemon should already block the execution (the kernel is not running). This task should ensure that when *any* execution attempt occurs against a sandboxed runtime in `StartupFailed` state, an annotation is written to that execution_id. The daemon's existing "kernel not ready" path is the natural insertion point.

### 5. Backpressure and shutdown

The pipeline runs as a tokio task. It exits cleanly when:
- The `EventStream` events receiver returns `None` (supervisor exited)
- A shutdown signal is received via cancellation token

It must never block the daemon's main loops.

### 6. Tests

- Unit test each event → annotation mapping
- Correlation: synthetic execution stream + synthetic event stream produce expected annotations
- Multiple events in one execution coalesce into a single annotation with `details.events` array
- Out-of-window events are dropped or held appropriately
- ProxyDied during an execution writes `sandbox_proxy_degraded` to that execution's annotation
- `RuntimeStateDoc` writes go through the proper API (no direct doc manipulation that bypasses task 02's setters)

## Interfaces produced

- Annotations written to `RuntimeStateDoc.cell_annotations` for sandbox events
- The `ExecutionObserver` adapter (if not pre-existing)
- The `EnrichmentPipeline::start(...)` entry point

Consumed by tasks 09 (reads annotations via MCP) and 11 (reads annotations via Automerge sync).

## Success criteria

- All four scenarios in `error-routing-design.md` produce the documented `kind`/`message`
- Correlation does not misattribute events to unrelated executions
- `cargo xtask lint --fix` passes
- No new tokio mutex held across awaits
- Tests cover all mappings and edge cases

## In scope

- Event → CellAnnotation mapping logic
- Time-window correlation between executions and events
- ProxyDied handling
- Deferred startup-failure annotation emission
- Tests

## Out of scope

- Adding new annotation kinds beyond the five above (extend by writing a new task)
- Running enrichment without nono `-vv` (per **D-13**, `-vv` is always on)
- Modifying cell output — annotations live in `cell_annotations`, never in outputs
- UI rendering — task 11
- MCP exposure — task 09
- Audit log Merkle integrity — deferred
- Runtime sandbox-policy expansion (no live "add this domain" interaction in MVP per **D-10**)
