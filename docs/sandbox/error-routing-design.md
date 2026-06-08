# Error Routing Architecture: nono.sh Credential Errors in nteract

**Date:** 2026-06-08  
**Status:** Design — no code changed  
**Prerequisite reading:**
- `nono-error-signals.md` — nono's actual signal surface (HTTP codes, stderr, audit log)
- `nono-sh-investigation.md` — proxy architecture, credential injection model
- `nteract-network-architecture.md` — daemon/runtime-agent/kernel process model
- `ux-credential-sandbox-design.md` — UI and MCP tool surface design

---

## Table of Contents

1. [Ground truth: nono's actual signal surface](#1-ground-truth-nonos-actual-signal-surface)
2. [Error scenario matrix](#2-error-scenario-matrix)
3. [Daemon architecture: what it watches](#3-daemon-architecture-what-it-watches)
4. [Audit log tailing design](#4-audit-log-tailing-design)
5. [Enrichment logic: raw HTTP codes → user-facing messages](#5-enrichment-logic-raw-http-codes--user-facing-messages)
6. [Scenario A: Missing credential at startup](#6-scenario-a-missing-credential-at-startup)
7. [Scenario B: Domain not in allowlist](#7-scenario-b-domain-not-in-allowlist)
8. [Scenario C: Upstream rejects the real key](#8-scenario-c-upstream-rejects-the-real-key)
9. [Scenario D: Proxy process dies mid-session](#9-scenario-d-proxy-process-dies-mid-session)
10. [Open questions and gaps](#10-open-questions-and-gaps)

---

## 1. Ground truth: nono's actual signal surface

Before designing routing, establish exactly what signals are available. This is the
constraint set everything else must work within.

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  SIGNAL SURFACE — what the daemon can observe                                 │
│                                                                               │
│  AT STARTUP                                                                   │
│  ─────────                                                                    │
│  1. nono process exit code (0 = running, nonzero = failed before kernel)     │
│  2. nono stderr: "nono: Secret not found in keystore: <name>"                │
│     "Keystore access failed for '<name>': ..."                               │
│     "Failed to access system keystore: Multiple entries (N) found for..."    │
│     Diagnostic footer (described as present, content not documented)         │
│  3. nono stdout: silent at startup for proxy-mode credentials                │
│                                                                               │
│  DURING RUNTIME (live tailing)                                                │
│  ─────────────────────────────                                                │
│  4. nono stderr (verbose, -vv only):                                          │
│     "ALLOW CONNECT api.openai.com:443"                                        │
│     "DENY  CONNECT 169.254.169.254:80 reason=denied_cidr"                    │
│     "ALLOW REVERSE openai POST /v1/chat/completions -> 200"                  │
│     (NOT emitted at default log level)                                        │
│  5. Audit file at ~/.nono/audit/<id>/audit-events.ndjson                     │
│     (append-only NDJSON; network events NOT per-request durable — flushed   │
│     at session end; file is tailsble but flush timing is undocumented)       │
│  6. nono process liveness (still running = proxy alive)                      │
│                                                                               │
│  NOT AVAILABLE                                                                │
│  ─────────────                                                                │
│  7. No real-time event IPC / subscription API                                │
│  8. No per-request webhook (planned, not implemented)                        │
│  9. No structured runtime signal when upstream returns 401                   │
│                                                                               │
│  WHAT THE PYTHON KERNEL SEES (indirect signals the daemon can infer)         │
│  ────────────────────────────────────────────────────────────────────         │
│  10. Python exception in cell output (ConnectionError, HTTP 407/403/401)    │
│      surfaced via IOPub → runtime-agent → RuntimeStateDoc                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

**The fundamental asymmetry:** The daemon owns the nono process and can observe signals
1-6 directly. The kernel sees only the HTTP error codes (signal 10). There is no bridge
between these two views built into nono. The daemon must build that bridge.

---

## 2. Error scenario matrix

Each cell shows what signal is emitted, how the daemon processes it, and what each
delivery path ultimately presents.

| # | Scenario | nono signal | Python sees | Daemon detects via | UI Path A | MCP Path B |
|---|----------|-------------|-------------|-------------------|-----------|------------|
| A | Missing credential at startup | stderr + nonzero exit | kernel never starts | Exit code + stderr parse | Blocking dialog before kernel starts | `launch_runtime` returns structured error |
| B | Domain not in allowlist | HTTP 403 to kernel | `requests` raises `ConnectionError` or returns `403` response | Audit log (session end) or `-vv` stderr during session | Cell output shows enriched error + status panel badge | Cell execution result contains raw traceback + `get_runtime_sandbox_status` shows blocked domain |
| C | Upstream rejects real key | HTTP 401 pass-through | `requests` gets `401 Unauthorized` | Audit log (session end) or `-vv` stderr; daemon cannot distinguish from a direct 401 | Cell output shows raw traceback — daemon cannot enrich automatically | Cell execution result contains raw traceback; agent must heuristically interpret 401 |
| D | Proxy dies mid-session | nono process exits | TCP connection refused/reset on next request | Process exit event (immediate) | Error banner + kernel marked degraded | `get_runtime_sandbox_status` → `proxy_died`; next execution fails with structured error |

**Key insight from the matrix:** Scenarios A and D have clean, immediately-observable
daemon signals. Scenarios B and C are harder because the daemon's only real-time signal
is the Python traceback in cell output — and a 403 from nono looks identical to a 403
from any upstream, and a 401 from nono's pass-through looks identical to a bad API key
used directly without nono.

---

## 3. Daemon architecture: what it watches

### 3a. The nono process supervisor

When the daemon wraps a kernel launch with `nono run`, it spawns nono as an intermediate
process. The kernel is a child of nono, not a direct child of the daemon. This changes
the process tree:

```
Without nono:
  daemon / runtime-agent
    └── python -m ipykernel_launcher    (direct child, daemon can waitpid)

With nono:
  daemon / runtime-agent
    └── nono run --profile ...          (direct child — this is what daemon waitpid()s)
          └── python -m ipykernel_launcher   (grandchild — daemon cannot directly waitpid)
```

The daemon's kernel process monitor must be retargeted to watch the **nono process**
(PID of `nono run`), not the kernel process directly. The nono supervisor's PID is
what the daemon gets from `spawn()`. The kernel PID is a grandchild — visible via
`/proc/<nono-pid>/task/` on Linux or `ps` on macOS, but not directly tracked by the
daemon's existing process watcher.

**Implication for kernel lifecycle:** The runtime-agent already has a `process_watcher`
background task. For nono-wrapped kernels, this watcher monitors the nono process. When
nono exits (for any reason), the watcher fires the kernel death path. This is correct
behavior in all failure cases: if nono dies, the kernel is functionally dead (it has
no network and will timeout on any network call).

### 3b. Stderr drain

The daemon must consume nono's stderr. This is already the pattern for kernel stderr
(there is a `stderr_drain` background task in `jupyter_kernel.rs`). For nono-wrapped
kernels:

```
nono stderr drain task (runtime-agent background task):
  - Reads from nono process stderr pipe (separate from kernel stderr)
  - Parses each line for known error patterns
  - On match: emit SandboxEvent to daemon via RuntimeStateDoc or notification channel
  - On no match: log at debug level (nono diagnostic footers, bypass warnings, etc.)
  - On EOF: nono process has exited
```

The drain must be non-blocking and must not backpressure the kernel lifecycle. It runs
on a dedicated `tokio::task::spawn` and sends to an unbounded channel or directly
updates a field in `RuntimeStateDoc`.

### 3c. Nono session ID discovery

For audit log tailing (§4), the daemon needs the nono session ID. This is a UUID that
nono writes to `~/.nono/sessions/<id>/session.json`. The daemon discovers it by:

1. **Option 1 — parse nono stdout:** If nono prints the session ID at startup (not
   documented as guaranteed, but likely). Needs empirical verification.
2. **Option 2 — scan sessions directory:** After spawning nono, watch
   `~/.nono/sessions/` for a new directory with a `session.json` whose `pid` or
   `command` matches the spawned nono PID. Race-prone but workable with a short retry
   loop (poll 5× at 100ms intervals).
3. **Option 3 — pass session ID explicitly:** If nono supports `--session-id <uuid>`
   as a flag (not documented), the daemon could pre-generate a UUID and pass it. This
   is the cleanest design but requires nono to support it.

**Recommendation for MVP:** Option 2 (scan on startup) with a 500ms timeout. Log a
warning and degrade gracefully if the session ID cannot be found. Audit log tailing is
post-MVP (see §6 on Phase scope); session ID discovery can be deferred accordingly.

### 3d. What the daemon tracks per nono session

```rust
// Conceptual, not a code proposal
struct NonoSessionState {
    nono_pid: u32,
    session_id: Option<String>,      // discovered after spawn
    audit_log_path: Option<PathBuf>, // ~/.nono/audit/<id>/audit-events.ndjson
    audit_tail_offset: u64,          // bytes read so far
    startup_outcome: StartupOutcome,
    credentials: Vec<CredentialStatus>,
    proxy_events: VecDeque<ProxyEvent>, // capacity-bounded, recent N events
}

enum StartupOutcome {
    Pending,
    Running { proxy_port: u16 },
    Failed { reason: StartupFailureReason },
}

enum StartupFailureReason {
    CredentialNotFound { name: String },
    KeystoreLocked { name: String },
    DuplicateKeystoreEntry { name: String },
    NonoNotFound,
    Other { stderr: String },
}
```

---

## 4. Audit log tailing design

### 4a. The problem

nono's `audit-events.ndjson` is an append-only NDJSON file at
`~/.nono/audit/<session-id>/audit-events.ndjson`. Network proxy events are captured
in memory during the session and flushed at session end, not per-request. This means:

- **At session end:** Full, accurate record of all proxy decisions.
- **During session:** Partial or empty. The file may not have network events until
  nono terminates.

This sharply limits the value of live tailing for the use cases that matter most
(diagnosing a 403 or 401 while a cell is running). The audit log is primarily useful
for post-mortem analysis after the kernel/nono session ends.

### 4b. The `-vv` stderr approach (recommended for MVP runtime enrichment)

For live enrichment during a running session, the most viable signal is nono's verbose
stderr output. The daemon should spawn nono with `-vv` (or `-v`) to enable per-request
tracing:

```bash
nono run -vv --profile <profile> -- python -m ipykernel_launcher ...
#       ^^^
#       verbose flag: emits ALLOW/DENY log lines to stderr per request
```

The stderr drain (§3b) then parses these lines in real time:

```
"ALLOW CONNECT api.openai.com:443"
  → CredentialType::ConnectTunnel, action=Allow, host="api.openai.com"

"DENY  CONNECT 169.254.169.254:80 reason=denied_cidr"
  → CredentialType::ConnectTunnel, action=Deny, host="169.254.169.254", reason=DeniedCidr

"ALLOW REVERSE openai POST /v1/chat/completions -> 200"
  → CredentialType::ReverseProxy, action=Allow, service="openai", method=POST,
    path="/v1/chat/completions", status=200

"ALLOW REVERSE analytics_api GET /v1/data -> 401"
  → CredentialType::ReverseProxy, action=Allow, service="analytics_api", method=GET,
    path="/v1/data", status=401
    ↑ This is an upstream 401 — the credential was injected but the upstream rejected it
```

**Important:** The `ALLOW` action in the audit log means "the proxy allowed the request
through" — not "the upstream accepted it." An `ALLOW REVERSE ... -> 401` means the
proxy served its function (credential injected) but the upstream rejected the key.

**The `-vv` tradeoff:**
- Pro: Real-time per-request visibility, available immediately during the session.
- Pro: Structured enough to parse reliably (fixed prefix format).
- Con: May be verbose for high-traffic notebooks. Consider `-v` (single) for MVP.
- Con: Format is not a guaranteed stable API — it is `tracing` output, not a documented
  contract. Parsing it couples nteract to nono's internal log format. Add a version
  guard / format sanity check.

### 4c. Audit log tailing (for session-end enrichment and future real-time)

When the daemon discovers the session ID (§3c), it should start a tail task on the
audit file. Even if network events are only flushed at session end, other event types
(session lifecycle, capability decisions) may appear earlier.

```
Audit tail task (background, per nono session):
  interval: inotify/FSEvents for file change notification; fallback: poll every 2s
  on wakeup: read from current offset to EOF
  on new bytes: parse as NDJSON lines, emit AuditEvent to enrichment pipeline
  on nono process exit: do one final drain (read remaining bytes), then close
```

**Platform-specific watchers:**
- **macOS:** `kqueue` / `FSEvents` — watch the session directory for new files and
  file modification events. The `notify` Rust crate (already used in daemon code for
  file watching) supports both.
- **Linux:** `inotify` — watch the file's parent directory, filter for the audit file.
- **Fallback:** 2-second poll loop. Acceptable for session-end enrichment (low
  latency requirement); not acceptable for live enrichment (use `-vv` stderr instead).

### 4d. NDJSON event schema (inferred — confirmed fields unknown)

The nono docs describe the audit log contents but do not document the JSON schema.
The following schema is **inferred** from the documented prose. It must be validated
empirically before shipping:

```jsonc
// session_started event (inferred)
{
  "event": "session_started",
  "session_id": "uuid",
  "timestamp": "2026-06-08T12:00:00.000Z",
  "command": ["python", "-m", "ipykernel_launcher", "-f", "..."],
  "profile": "nteract-kernel-proxy",
  "supervisor_pid": 12345,
  "child_pid": 12346
}

// network_request event (inferred — may only appear at session end)
{
  "event": "network_request",
  "timestamp": "...",
  "action": "allow" | "deny",
  "mode": "connect" | "reverse",
  "service": "analytics_api",      // reverse proxy only; credential name (not value)
  "method": "GET",                 // reverse proxy only
  "host": "analytics.example.com",
  "path": "/v1/data",
  "status_code": 200,
  "reason": null | "denied_cidr" | "host_not_allowed" | "endpoint_rule" | "invalid_token"
}

// session_ended event (inferred)
{
  "event": "session_ended",
  "session_id": "uuid",
  "timestamp": "...",
  "exit_code": 0,
  "duration_ms": 45231
}
```

**Fields useful for enrichment:**
- `service` (credential name) — maps to the user's credential name; never the value
- `action` + `reason` — distinguishes nono-originated denials from upstream rejections
- `status_code` — needed to detect upstream 401 vs. nono 403
- `mode` — distinguishes CONNECT tunnel from reverse proxy errors

**Gap:** Until nono documents the schema or the daemon implements empirical discovery,
the daemon should treat unknown events as opaque and log them at debug level rather
than failing.

---

## 5. Enrichment logic: raw HTTP codes → user-facing messages

### 5a. The enrichment problem

From the Python kernel's perspective, every proxy error looks like a plain HTTP error:

| What Python sees | Could mean |
|------------------|-----------|
| `ProxyError: 407 Proxy Authentication Required` | Phantom token invalid (proxy bug) |
| `ConnectionError: 403 Forbidden` | Domain not in allowlist |
| `HTTPError: 403 Forbidden` | Endpoint rule violated |
| `HTTPError: 401 Unauthorized` | Upstream rejected the real key (nono passed it through) OR phantom token rejected (nono bug) |
| `ConnectionRefusedError` | Proxy process died |
| `ConnectionResetError` | Proxy process died mid-request |

The daemon must correlate the Python exception in cell output with its own observations
of the nono process to produce an enriched signal.

### 5b. Enrichment sources

The daemon has three sources of enrichment context, in order of reliability:

1. **Pre-flight state** (highest confidence): What the daemon knows before any request
   is made. Example: credential X was loaded successfully at startup and is currently
   active.

2. **Stderr log correlation** (medium confidence, requires `-vv`): The stderr drain
   saw `DENY CONNECT example.com:80 reason=host_not_allowed` in the same time window as
   the cell execution. Correlate by temporal proximity, not by request ID (no request ID
   is shared between kernel and daemon).

3. **Audit log events** (low latency for session end; high confidence, but delayed):
   After session end, the full audit record is available. Useful for post-mortem but
   not for in-flight error display.

### 5c. Enrichment decision tree

```
Python cell raises an exception:
  │
  ├── Is there an active nono session for this runtime?
  │     NO → not a nono error; display raw traceback
  │
  └── YES → classify the exception:
        │
        ├── ConnectionRefusedError / ConnectionResetError
        │     → Check: is nono process still running?
        │           NO  → Scenario D: proxy died → enrich with "sandbox proxy crashed"
        │           YES → not nono-related (port conflict, other local service)
        │
        ├── HTTP 407 (ProxyError)
        │     → Phantom token mismatch or CONNECT tunnel auth failure
        │     → This is a nono internal error, not a credential issue
        │     → Message: "Sandbox proxy authentication failed (internal error)"
        │     → This should not happen in normal operation
        │
        ├── HTTP 403 (Forbidden)
        │     → Domain not in allowlist OR endpoint rule violated
        │     → Correlate with stderr log (if -vv): did daemon see DENY entry?
        │         YES + reason=host_not_allowed → Scenario B: enrich with domain
        │         YES + reason=endpoint_rule    → Scenario B: enrich with path rule
        │         NO                            → may be upstream 403, not nono
        │     → Heuristic: if domain is NOT in the notebook profile, likely nono deny
        │
        └── HTTP 401 (Unauthorized)
              → Could be upstream rejection OR phantom token rejection (reverse proxy)
              → Correlate with stderr log:
                  saw "ALLOW REVERSE <svc> -> 401" → Scenario C: upstream rejected key
                  saw "DENY  REVERSE <svc>" or no entry → may be phantom token issue
              → Without -vv, cannot distinguish; display raw traceback with hint
```

### 5d. Message templates

These are the exact user-facing messages for each enriched state. Messages follow the
pattern: **what happened** + **which credential/domain** + **what to do**.

**Scenario A — credential not found at startup:**
```
Cannot start kernel: credential "{name}" is not in your Keychain.

This notebook requires the "{name}" credential to make API calls
to {upstream_url}.

[Add credential "{name}"]   [Run without sandbox]   [Cancel]
```

**Scenario B — domain blocked at runtime:**
```
[In cell output, appended after raw traceback]
──────────────────────────────────────────────────────
🔒 Sandbox: domain "{domain}" is not in this notebook's allowlist.

To allow this domain, open Network Settings and add it to
the allowed domains list, then restart the kernel.
[Open Network Settings]
──────────────────────────────────────────────────────
```

**Scenario C — upstream rejected credential:**
```
[In cell output, appended after raw traceback]
──────────────────────────────────────────────────────
🔑 Credential "{name}" was sent to {upstream_url} but was rejected
(HTTP 401). The credential value in your Keychain may be incorrect
or expired.

Possible causes:
  • The API key has been rotated or revoked upstream
  • The wrong credential is mapped to this service

[Open Credential Manager]
──────────────────────────────────────────────────────
```
*(Note: scenario C enrichment requires `-vv` stderr correlation. Without it, the daemon
cannot distinguish a nono-mediated upstream 401 from a direct upstream 401. In that
case, no enrichment is added.)*

**Scenario D — proxy died:**
```
[Toast notification + cell output annotation]

Sandbox proxy crashed — kernel has no network access.
All network calls will fail until the kernel is restarted.

[Restart kernel]
```

---

## 6. Scenario A: Missing credential at startup

### 6a. Signal path

```
Daemon spawns:  nono run -vv --profile <profile> -- python -m ipykernel_launcher ...
                │
                ├── nono reads profile, attempts to load credentials from Keychain
                │
                ├── KEYCHAIN LOOKUP FAILS
                │     nono writes to stderr:
                │     "nono: Secret not found in keystore: analytics_api"
                │     nono exits with nonzero code (before proxy starts, before kernel forks)
                │
                └── Daemon observes:
                      • stderr drain receives the error line
                      • process watcher sees nono exit (nonzero) almost immediately
                        (within ~100ms of spawn, before ZMQ connections would be made)
```

### 6b. Path A: nteract UI user

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  USER OPENS NOTEBOOK / CLICKS RUN ALL                                        │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  Daemon reads metadata.runt.sandbox — profile present
  Daemon checks credential availability (pre-flight):
    calls `nono inspect --credential analytics_api` or attempts dry-run
    OR defers check to launch time
          │
          ▼
  Daemon spawns: nono run -vv --profile ... -- python ...
          │
          ▼
  ┌───────────────────────────────────────────┐
  │  nono stderr drain (running):             │
  │  reads: "nono: Secret not found in        │
  │          keystore: analytics_api"         │
  │  → parse: CredentialNotFound("analytics_api")│
  └───────────────────────────────────────────┘
          │
          ▼
  ┌───────────────────────────────────────────┐
  │  process watcher:                         │
  │  nono exits nonzero (exit code 1)         │
  │  → kernel never started                  │
  └───────────────────────────────────────────┘
          │
          ▼
  Daemon writes to RuntimeStateDoc:
    RuntimeLifecycle::FailedToStart {
      reason: SandboxStartupFailure::CredentialNotFound { name: "analytics_api" }
    }
          │
          ▼
  RuntimeStateDoc synced → frontend receives update
          │
          ▼
  ┌───────────────────────────────────────────────────────────────────────────┐
  │  UI: blocking modal dialog (not a toast — kernel is not running at all)   │
  │                                                                           │
  │  ⚠  Cannot start kernel                                                  │
  │                                                                           │
  │  This notebook requires credential "analytics_api" but it is not         │
  │  available in your Keychain.                                              │
  │                                                                           │
  │  This notebook uses credential "analytics_api" to call:                  │
  │    https://analytics.example.com                                          │
  │                                                                           │
  │  [Add credential now]   [Run without sandbox]   [Cancel]                 │
  └───────────────────────────────────────────────────────────────────────────┘
```

**Where the enrichment happens:** In the daemon's stderr drain task. The daemon parses
the nono error line and writes a typed `SandboxStartupFailure` variant to
`RuntimeStateDoc`. The frontend renders the dialog from the structured error, not from
raw string parsing.

**Pre-flight credential check (optimization):** To avoid spawning nono only to have it
fail immediately, the daemon should attempt a pre-flight credential availability check
before constructing the nono command. This can be done by calling
`nono inspect --credential <name> --json` (if supported) or by attempting a Keychain
lookup via the `security` CLI. If the pre-flight check fails, the daemon never spawns
nono and produces the `CredentialNotFound` error synchronously. This is faster and
cleaner than waiting for nono to fail.

**Pre-flight check caveat:** The pre-flight check is a best-effort optimization. The
authoritative check is still nono's own keystore load at startup. Race conditions
(credential deleted between pre-flight and launch) are handled by the stderr drain path.

### 6c. Path B: Headless AI agent (MCP)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  AGENT CALLS: launch_runtime(notebook_id="nb-abc")                           │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  Daemon: same startup sequence as Path A
          │
          ▼
  Same stderr parse → same RuntimeStateDoc update
          │
          ▼
  launch_runtime response:
  {
    "error": {
      "type": "SandboxError::CredentialNotFound",
      "credential_name": "analytics_api",
      "upstream_url": "https://analytics.example.com",
      "message": "Credential 'analytics_api' not found in Keychain. A human must add this credential before the notebook can run.",
      "remediation": "Run: security add-generic-password -s nono -a analytics_api -w <value>"
    },
    "runtime_id": null,
    "sandbox": {
      "active": false,
      "mode": "credential_injection"
    }
  }
          │
          ▼
  Agent receives structured error — no ambiguity about cause
          │
          ▼
  Agent action (recommended):
    → Do NOT attempt to execute cells (runtime_id is null)
    → Report to human operator:
        "Cannot run notebook nb-abc: credential 'analytics_api' is missing.
         Please add it with: security add-generic-password -s nono -a analytics_api -w <key>"
    → If agent has a notification channel (Slack, email), escalate immediately
    → Record the failure in the agent's task log with the structured error
```

**What the agent must NOT do:**
- Attempt to create a credential itself (agents cannot write to the Keychain
  headlessly in a way that survives the macOS Keychain prompt)
- Retry the launch without the credential (it will fail identically)
- Execute cells with `sandbox_override: "off"` without explicit human authorization
  (this would bypass the intended security policy)

---

## 7. Scenario B: Domain not in allowlist

This scenario applies only when the notebook profile is in **strict mode** (domain
allowlist enforcement active). In credential-injection-only mode, nono does not block
unknown domains — the kernel has direct internet access for non-proxied calls.

### 7a. Signal path

```
Runtime is running (nono proxy active, strict mode, no-domain-in-allowlist)
          │
          ▼
Python cell executes:
  import requests
  requests.get("https://new-api.vendor.com/v1/data")
          │
          ▼
kernel's requests library → HTTPS_PROXY → nono proxy
          │
          ▼
nono proxy:
  "new-api.vendor.com" not in allowlist
  → returns 403 Forbidden to kernel
  → emits to stderr (if -vv): "DENY  CONNECT new-api.vendor.com:443 reason=host_not_allowed"
  → records network event in memory (will flush to audit log at session end)
          │
          ▼
kernel receives 403:
  requests raises requests.exceptions.ConnectionError or returns Response(status_code=403)
  (exact behavior depends on whether CONNECT tunnel returns 403 or if requests raises)
  → Python traceback in cell output
  → IOPub → runtime-agent → RuntimeStateDoc cell output
          │
          ▼
Daemon observes:
  A. Stderr drain sees "DENY CONNECT new-api.vendor.com:443 reason=host_not_allowed"
     → records ProxyEvent { action: Deny, mode: Connect, host: "new-api.vendor.com",
                            reason: HostNotAllowed }
     → associates with current cell execution (by timestamp proximity)
  B. RuntimeStateDoc gets cell output with Python traceback
```

### 7b. Path A: nteract UI user

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CELL EXECUTES — gets blocked by nono domain allowlist                       │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  CELL OUTPUT (in notebook cell, scrollable):                   │
  │                                                                │
  │  ConnectionError: HTTPSConnectionPool(host='new-api.vendor.com', │
  │  port=443): Max retries exceeded ... 403 Client Error: Forbidden│
  │                                                                │
  │  ── Sandbox ───────────────────────────────────────────────── │
  │  🔒 Domain "new-api.vendor.com" is not in this notebook's      │
  │     allowed domain list.                                       │
  │                                                                │
  │  To allow this domain, add it to Network Settings and          │
  │  restart the kernel.                                           │
  │                                                                │
  │  [Open Network Settings]                                       │
  │  ─────────────────────────────────────────────────────────── │
  └────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  STATUS PANEL (Runtime Sandbox Status — already open or badge) │
  │                                                                │
  │  Blocked requests:                                             │
  │    ✗  CONNECT  new-api.vendor.com:443  403  reason=host_not_allowed │
  │                                                                │
  │  [Add to allowed domains]                                      │
  └────────────────────────────────────────────────────────────────┘
```

**How the enrichment gets into cell output:** The daemon must inject the enrichment
annotation into the cell output after the raw Python traceback. This requires a new
mechanism:

- The daemon's IOPub handler (in `jupyter_kernel.rs`) processes `error` output messages
  from the kernel.
- After receiving an error output and matching it against a recent `ProxyEvent` in the
  daemon's nono session state (correlated by timestamp ± 2s window), the daemon appends
  a synthetic `stream` output or a specially-typed `sandbox_hint` output to the cell.
- The frontend renders `sandbox_hint` outputs with the enrichment UI (the box shown above).

**Alternative — annotation, not injection:** Instead of injecting into cell output
(which modifies the output stream and could break reproducibility), the daemon could
store the enrichment separately in `RuntimeStateDoc` as `cell_annotations`, keyed by
cell execution ID. The frontend queries `cell_annotations` when rendering cell output
and overlays the hint. This is cleaner architecturally and does not touch the notebook's
output data.

**Recommendation:** Use `cell_annotations` in `RuntimeStateDoc` for enrichment. Cell
output in the notebook document remains the raw kernel output; enrichment is ephemeral
runtime state, not persisted data.

### 7c. Path B: Headless AI agent (MCP)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  AGENT CALLS: execute_cell(notebook_id, cell_id)                             │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  Same execution flow as Path A — cell gets 403, Python traceback in output
          │
          ▼
  execute_cell response:
  {
    "status": "error",
    "outputs": [
      {
        "type": "error",
        "ename": "ConnectionError",
        "evalue": "... 403 Client Error: Forbidden ...",
        "traceback": [...]
      }
    ],
    "sandbox_event": {           ← new field, populated when daemon has correlation
      "type": "domain_blocked",
      "domain": "new-api.vendor.com",
      "reason": "host_not_allowed",
      "message": "Domain 'new-api.vendor.com' is not in this notebook's allowed domain list."
    }
  }
          │
          ▼
  Agent receives structured error with sandbox context
          │
          ▼
  Agent options:
    1. Update notebook profile to add domain:
         set_notebook_sandbox_profile(notebook_id, profile={
           ...existing...,
           allow_domains: [...existing, "new-api.vendor.com"]
         })
         → restart kernel (required for profile change to take effect)
         → retry cell execution

    2. Report to human: "Notebook needs access to new-api.vendor.com.
       Please review and update the sandbox profile."

    3. Fail the task: "Cell failed due to blocked domain. Cannot proceed."
```

**`sandbox_event` field availability:** The `sandbox_event` field in the `execute_cell`
response is only populated if the daemon has the nono session running with `-vv` and the
stderr drain has correlated a `DENY` event within the temporal window of the cell
execution. If correlation is unavailable (no `-vv`, or daemon lost the correlation),
the field is `null` and the agent sees only the raw Python traceback.

---

## 8. Scenario C: Upstream rejects the real key

### 8a. Signal path

```
Runtime running (nono proxy active, credential "analytics_api" loaded at startup)
          │
          ▼
Python cell executes:
  base = os.environ["ANALYTICS_API_BASE_URL"]
  resp = requests.get(f"{base}/v1/data",
                      headers={"Authorization": f"Bearer {os.environ['ANALYTICS_API_API_KEY']}"})
          │
          ▼
nono proxy:
  → validates phantom token (OK — phantom is correct)
  → strips phantom Authorization header
  → injects real Authorization: Bearer sk-rotated-or-revoked-key
  → forwards to https://analytics.example.com/v1/data
          │
          ▼
analytics.example.com returns 401 Unauthorized
("Invalid or expired API key")
          │
          ▼
nono proxy:
  → streams 401 response back to kernel verbatim (pass-through, no rewrite)
  → emits to stderr (if -vv): "ALLOW REVERSE analytics_api GET /v1/data -> 401"
  → NOTE: "ALLOW" means nono allowed the request, not that upstream accepted it
  → records network event in memory (flush to audit log at session end)
          │
          ▼
Python kernel:
  resp.status_code == 401
  → if resp.raise_for_status() called: raises HTTPError(401)
  → if not called: user gets response object with 401 status
```

### 8b. The core ambiguity

Scenario C has a fundamental enrichment problem: **a 401 from upstream looks identical
to a direct 401 from any HTTP API call without nono involved.** The daemon cannot
distinguish these two cases without the `-vv` stderr correlation:

| Source of 401 | `-vv` stderr line | Python exception |
|---------------|-------------------|-----------------|
| Upstream rejects nono-injected key | `ALLOW REVERSE analytics_api GET /v1/data -> 401` | `HTTPError: 401` |
| Direct HTTP call (no nono route) | No line (domain allowed via CONNECT, 401 from upstream directly) | `HTTPError: 401` |
| Phantom token rejected by nono | `DENY REVERSE analytics_api ...` (inferred — not confirmed in docs) | `HTTPError: 401` |

The daemon can only enrich Scenario C if:
1. The notebook is using reverse proxy mode (not CONNECT tunnel) for the failing service
2. The daemon is running nono with `-vv`
3. The stderr drain saw the `ALLOW REVERSE <name> -> 401` line in the execution window

Without all three, the daemon cannot distinguish Scenario C from a direct API call
returning 401. It must display the raw traceback without enrichment.

### 8c. Path A: nteract UI user

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CELL EXECUTES — upstream returns 401 (bad/expired key)                      │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  CASE 1: Daemon has -vv correlation
  ─────────────────────────────────
  Daemon's stderr drain saw: "ALLOW REVERSE analytics_api GET /v1/data -> 401"
          │
          ▼
  ┌────────────────────────────────────────────────────────────────┐
  │  CELL OUTPUT:                                                  │
  │                                                                │
  │  HTTPError: 401 Client Error: Unauthorized for url:           │
  │  http://127.0.0.1:54321/analytics_api/v1/data                 │
  │                                                                │
  │  ── Sandbox ───────────────────────────────────────────────── │
  │  🔑 Credential "analytics_api" was sent to                    │
  │     https://analytics.example.com but was rejected (HTTP 401).│
  │                                                                │
  │  The credential value in your Keychain may be incorrect        │
  │  or expired.                                                   │
  │                                                                │
  │  [Open Credential Manager]                                     │
  │  ─────────────────────────────────────────────────────────── │
  └────────────────────────────────────────────────────────────────┘

  CASE 2: No -vv correlation available
  ────────────────────────────────────
  ┌────────────────────────────────────────────────────────────────┐
  │  CELL OUTPUT:                                                  │
  │                                                                │
  │  HTTPError: 401 Client Error: Unauthorized for url:           │
  │  http://127.0.0.1:54321/analytics_api/v1/data                 │
  │    [raw Python traceback]                                      │
  │                                                                │
  │  ── Sandbox ───────────────────────────────────────────────── │
  │  ℹ This request was routed through the credential proxy        │
  │    for "analytics_api". If the API key has been rotated,      │
  │    update it in Credential Manager.                            │
  │                                                                │
  │  [Open Credential Manager]                                     │
  │  ─────────────────────────────────────────────────────────── │
  └────────────────────────────────────────────────────────────────┘
```

**Case 2 heuristic enrichment:** Even without `-vv` correlation, the daemon knows
the request was routed through the nono proxy for `analytics_api` (because the URL
contains the proxy prefix `http://127.0.0.1:<port>/analytics_api/`). The daemon can
parse the Python exception's URL from the traceback and match it against known proxy
routes. This gives a weaker but still useful hint.

### 8d. Path B: Headless AI agent (MCP)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  AGENT receives execute_cell response with 401                               │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  With -vv correlation:
  {
    "status": "error",
    "outputs": [{ "type": "error", "ename": "HTTPError", "evalue": "401..." }],
    "sandbox_event": {
      "type": "upstream_auth_rejected",
      "credential_name": "analytics_api",
      "upstream_url": "https://analytics.example.com",
      "method": "GET",
      "path": "/v1/data",
      "message": "Credential 'analytics_api' was sent to analytics.example.com but was rejected (HTTP 401). The credential value may be incorrect or expired."
    }
  }
          │
          ▼
  Agent action:
    → Cannot fix the credential itself (cannot write to Keychain headlessly)
    → Report to human: "Credential 'analytics_api' is being rejected by analytics.example.com.
       The API key may have been rotated. Please update it in the Keychain and restart the kernel."
    → Record the failure as a structured credential error (not a generic execution error)
    → Do NOT retry automatically — the key won't change between retries

  Without -vv correlation:
  {
    "status": "error",
    "outputs": [{ "type": "error", "ename": "HTTPError", "evalue": "401..." }],
    "sandbox_event": {
      "type": "possible_credential_rejection",
      "credential_name": "analytics_api",   ← inferred from URL, not confirmed from log
      "confidence": "low",
      "message": "Request to http://127.0.0.1:.../analytics_api/... returned 401. May indicate a rejected or expired credential."
    }
  }
```

---

## 9. Scenario D: Proxy process dies mid-session

### 9a. Signal path

```
Runtime running (nono proxy active, kernel executing or idle)
          │
          ▼
nono process exits unexpectedly:
  (OOM, SIGKILL, bug, explicit kill, macOS battery/sleep, etc.)
          │
          ▼
Daemon's process watcher (monitoring nono PID):
  waitpid() returns / tokio process watch fires
  → exit code captured (may be nonzero, or SIGKILL = no exit code)
  → IMMEDIATE signal — no polling delay
          │
          ▼
Daemon reacts (synchronously in process watcher task):
  → writes RuntimeStateDoc:
        sandbox_state = SandboxState::Degraded {
          reason: ProxyDied { exit_code: ..., at: Instant::now() }
        }
  → marks runtime as degraded (NOT killed — the kernel process may still be running)
  → does NOT kill the kernel — let it live and fail naturally on next network call
    (killing the kernel would discard any in-progress output from non-network cells)
          │
          ├── Frontend receives RuntimeStateDoc update (via RuntimeStateSync frame)
          └── MCP polling receives RuntimeStateDoc update
```

### 9b. What happens to in-flight requests

When nono dies, the kernel's proxy port (`127.0.0.1:<port>`) is no longer accepting
connections. Any in-flight HTTP request from the kernel gets a TCP RST or a connection
refused:

- `requests` raises `ConnectionError: ('Connection aborted.', ConnectionResetError(...))`
- The cell outputs this exception
- The daemon's IOPub handler sees the error output
- The daemon correlates with `SandboxState::Degraded` to enrich the error

### 9c. Path A: nteract UI user

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  NONO PROCESS DIES (during or between cell executions)                       │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  TOAST NOTIFICATION (immediate, before next cell execution)            │
  │                                                                        │
  │  ⚠  Sandbox proxy crashed — kernel has no network access              │
  │                                                                        │
  │  All network calls from this kernel will fail until you restart it.   │
  │                                                                        │
  │  [Restart kernel]   [Dismiss]                                          │
  └────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  ┌────────────────────────────────────────────────────────────────────────┐
  │  STATUS INDICATOR (in notebook header):                                │
  │                                                                        │
  │  [kernel: Python 3.12 ▼]  [⚠ Sandbox degraded]  [▶ Run All]          │
  │                             ↑                                          │
  │                             red/orange badge, was "● Proxied"          │
  └────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  If user runs a cell that makes a network call after proxy died:

  ┌────────────────────────────────────────────────────────────────────────┐
  │  CELL OUTPUT:                                                          │
  │                                                                        │
  │  ConnectionError: ('Connection aborted.', ConnectionResetError(...))  │
  │                                                                        │
  │  ── Sandbox ───────────────────────────────────────────────────────── │
  │  ⚠  The sandbox proxy is not running. Network calls will fail.        │
  │                                                                        │
  │  [Restart kernel to restore network access]                            │
  │  ─────────────────────────────────────────────────────────────────── │
  └────────────────────────────────────────────────────────────────────────┘
```

### 9d. Path B: Headless AI agent (MCP)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  AGENT is between cell executions when proxy dies                            │
└─────────────────────────────────────────────────────────────────────────────┘
          │
          ▼
  Agent calls: get_runtime_sandbox_status(runtime_id)
  {
    "active": false,
    "mode": "credential_injection",
    "proxy_state": "died",            ← was "running"
    "proxy_exit_code": -9,
    "credentials": [...],
    "degraded_at": "2026-06-08T12:34:56Z",
    "message": "The sandbox proxy process has exited. All kernel network calls will fail. Restart the kernel to restore network access."
  }
          │
          ▼
  OR agent was in the middle of execute_cell when proxy died:
  {
    "status": "error",
    "outputs": [{ "type": "error", "ename": "ConnectionError", ... }],
    "sandbox_event": {
      "type": "proxy_died",
      "message": "The sandbox proxy process exited during cell execution. This cell and all subsequent network calls will fail.",
      "remediation": "Restart the kernel."
    }
  }
          │
          ▼
  Agent action:
    → Do NOT retry the current cell (will fail identically)
    → Restart the kernel: call restart_kernel(runtime_id) or stop_runtime + launch_runtime
    → After restart, re-execute the cell that failed
    → Log the proxy death as an infrastructure event, not a user error
```

---

## 10. Open questions and gaps

### G1. Audit log NDJSON schema is undocumented

The audit event schema is inferred from prose descriptions. The actual field names, types,
and event type strings are unknown until empirically tested. The daemon's NDJSON parser
should be written defensively: parse fields it knows about, ignore unknown fields, never
panic on unexpected structure.

**Action:** Before shipping audit log tailing, run `nono run -vv -- true` with a
credential, examine the output at `~/.nono/audit/*/audit-events.ndjson`, and document
the schema.

### G2. Proxy-mode startup error for missing credential is undocumented

The investigation doc confirms the `--env-credential` startup error message
("nono: Secret not found in keystore: <name>"). It explicitly notes this message for
`--credential` (reverse proxy mode) is **not documented**. The exact message, timing,
and exit code may differ.

**Action:** Test empirically: `nono run --credential nonexistent_key -- true` on macOS.
Capture stderr and exit code. If the message format differs from env-credential mode,
update the stderr parser accordingly.

**Assumption in this design:** The proxy-mode startup error message follows the same
"nono: Secret not found in keystore: <name>" pattern. If it differs, the parser needs
an additional case.

### G3. Scenario C cannot be enriched without `-vv` stderr

Upstream 401 errors (bad/expired API key) are indistinguishable from generic HTTP 401
errors at the Python level. Without `-vv`, the daemon has no signal. Even with `-vv`,
the `ALLOW REVERSE <service> -> 401` line confirms the proxy served its role but does
not name the credential used for direct CONNECT-mode calls.

**Options:**
- **Accept the gap:** Display a weaker hint ("this request went through the proxy for
  service X") inferred from URL pattern matching, without claiming the key is rejected.
- **Always use `-vv`:** Accept the performance/verbosity tradeoff; treat `-vv` as a
  requirement for Scenario C enrichment.
- **Use nono-core integration (Phase 2):** Direct Rust integration would give the daemon
  access to proxy events without parsing unstructured log output.

**Recommendation:** Use `-vv` for MVP, document the dependency. Plan for nono-core in
Phase 2.

### G4. Temporal correlation is imprecise

The daemon correlates Python exceptions with nono stderr log lines by timestamp
proximity. This is inherently imprecise:

- The kernel's ZMQ IOPub message arrives at the runtime-agent; the stderr line was
  emitted by nono. The clocks are the same process group but the channel latencies differ.
- High-frequency cell executions (tight loops, async code) may produce multiple
  exceptions in the same time window, making correlation ambiguous.

**Mitigations:**
- Use a narrow correlation window (±500ms for same-cell attribution).
- Track `cell_execution_id` in the daemon's execution state; attribute the nono stderr
  event to the most recently-started execution.
- Accept false negatives (missed enrichment) rather than false positives (wrong
  attribution).

### G5. Nono session ID discovery race

After spawning `nono run`, the daemon needs the session ID to find the audit log. Polling
`~/.nono/sessions/` for a new directory is race-prone. If nono starts very fast (or on
a slow filesystem), the directory may not exist when the daemon first polls.

**Recommendation:** Retry up to 5 times at 200ms intervals, with a final 1s fallback.
If session ID is still not found, proceed without audit log tailing and log a warning.

### G6. Nono verbose stderr format is not a stable API

The `ALLOW CONNECT ...` and `DENY REVERSE ...` lines are `tracing` output, not a
documented contract. A nono version upgrade could change the format without warning.

**Mitigations:**
- Add a format version check at startup (if possible via `nono --version`; record in
  `NonoSessionState.nono_version`).
- Fail open: if the parser cannot match a line, log it and skip enrichment for that
  event. Never crash or surface a confusing error to the user.
- Pin nono binary version in the nteract release (if bundled — see Q1 from UX design doc).

### G7. Multiple concurrent kernels with nono

If a user has multiple notebooks open, each with a sandbox profile, there will be
multiple concurrent nono processes and audit sessions. The daemon must track each
independently, keyed by `runtime_id` / `notebook_id`.

This is architecturally straightforward (one `NonoSessionState` per runtime-agent
instance) but must be explicit in the design.

### G8. The `-vv` stderr volume concern

Running with `-vv` in a high-throughput notebook (LLM streaming, many HTTP requests)
will produce substantial stderr output. The daemon's stderr drain must be non-blocking
and must not accumulate unboundedly:

- Use a capacity-bounded channel (e.g., 512 events) for parsed proxy events.
- Drop oldest events when full (ring buffer semantics).
- Never let stderr accumulation backpressure the kernel or nono process (OS pipe buffer
  is naturally bounded; the drain must read faster than nono writes).

### G9. Keychain prompt detection for headless agents

On first nono access to a Keychain entry on macOS, the OS shows a GUI auth prompt. In
headless mode (no user at the screen), this blocks indefinitely or returns
`errSecInteractionNotAllowed`.

**Detection:** nono's startup error for this case is likely "Keystore access failed for
'<name>': ...". The daemon should match this pattern and produce
`SandboxError::KeychainInteractionRequired`, which is actionable (agent reports to
human) whereas `CredentialNotFound` is not (credentials exist but are inaccessible).

**Confirmation needed:** Test empirically on macOS whether `errSecInteractionNotAllowed`
produces the "Keystore access failed" message or a different stderr message.

### G10. Audit log integrity and the hash chain

nono uses a Merkle-root hash chain for audit log integrity. If the daemon tails and
parses the NDJSON file live, it should not attempt to verify the hash chain (that is
nono's responsibility and requires the full session to complete). The daemon should
read network events for operational purposes and treat audit log verification as a
separate, session-end operation if integrity guarantees are needed.

---

## Summary: key architectural decisions

### Decision 1: Run nono with `-vv` (verbose logging)

This is the enabler for Scenarios B and C enrichment. Without it, the daemon has
significantly degraded enrichment capability at runtime. Accept the verbosity tradeoff.

### Decision 2: stderr drain is the primary real-time signal source

The audit log (NDJSON) is primarily useful for session-end post-mortem. During a live
session, the `-vv` stderr is the only near-real-time proxy event stream. Design the
enrichment pipeline around stderr first, audit log second.

### Decision 3: Enrichment is stored as `cell_annotations` in RuntimeStateDoc, not injected into cell output

Cell output in the notebook document is the raw kernel output. Enrichment hints are
ephemeral, runtime-derived data. They belong in `RuntimeStateDoc` as an annotation
layer, not in the notebook's persistent output store. This preserves output
reproducibility and keeps the enrichment separate from the canonical execution record.

### Decision 4: Startup errors are synchronous and blocking; runtime errors are async and annotative

Startup errors (Scenario A) block kernel launch entirely and surface as a modal dialog /
structured launch error. Runtime errors (Scenarios B, C, D) are asynchronous — they
arrive as cell execution results and are annotated after the fact. These require
fundamentally different UI and MCP response patterns.

### Decision 5: Daemon monitors the nono PID, not the kernel PID

For nono-wrapped kernels, the runtime-agent's process watcher targets the nono supervisor
process. When nono exits (for any reason), the daemon marks the runtime sandbox as
degraded and triggers the appropriate error path. The kernel itself may still be running
but is effectively unusable for network operations.

### Decision 6: Scenario C (upstream rejects key) cannot be enriched with high confidence without nono-core integration

For MVP, provide weak heuristic enrichment (URL pattern matching + weak hint) and
document the limitation. Phase 2 nono-core integration is the path to strong enrichment.
Do not over-promise enrichment confidence to users or agents.

### Decision 7: Agent errors must be structured, not string messages

Every error the daemon returns to an MCP agent must be a typed enum variant
(`CredentialNotFound`, `KeychainInteractionRequired`, `ProxyDied`, etc.), not a free-form
message string. Agents cannot reliably parse error messages; they need machine-readable
error types to make programmatic decisions. The human-readable message is a secondary
field, not the primary contract.
