# nono.sh Error Handling and Signal Mechanisms

Research into what nono emits and returns when credentials are missing or invalid, and what
event/audit channels exist for a parent process to observe proxy events.

Sources: https://nono.sh/docs/llms.txt and all referenced sub-pages fetched 2026-06-08.

---

## 1. What the Proxy Returns to the HTTP Client

nono's proxy operates in two modes — CONNECT tunnel and reverse proxy — with different error
shapes.

### Reverse Proxy (credential injection via `--credential`)

The sandboxed child sends plain HTTP to `http://127.0.0.1:PORT/<service>/...`. The proxy
validates the session token (the `NONO_PROXY_TOKEN` phantom value placed in the child's env)
before doing anything else.

| Condition | HTTP Status | Source Quote |
|-----------|-------------|--------------|
| Missing or invalid phantom token (default header mode) | **401 Unauthorized** | "Requests without a valid phantom token are rejected with `401 Unauthorized`." (credential-injection.md) |
| Missing or invalid phantom token (url_path / query_param modes) | **401 Unauthorized** | "Invalid or missing phantom tokens result in HTTP 401 Unauthorized responses." (credential-injection.md) |
| Host not in domain allowlist (CONNECT mode) | **403 Forbidden** | "Requests to other paths on the same domain receive `403 Forbidden`." (networking.md) |
| Endpoint rule configured, request does not match | **403 Forbidden** | "requests that don't match receive `403 Forbidden` and are logged in the audit trail." (networking.md) |
| Upstream TLS failure | **502 Bad Gateway** | Proxy failure mode table: "Upstream TLS failure → Proxy returns 502" (security-model.md) |
| Invalid proxy token on CONNECT tunnel | **407 Proxy Authentication Required** | "no-credential reverse proxy routes and CONNECT tunnels use proxy auth… invalid or missing credentials are rejected with `407 Proxy Authentication Required`." (credential-injection.md) |

**No document explicitly names the status code returned when the credential value itself is
missing from the keystore at request time** (i.e., the keychain entry was deleted after startup).
Credentials are documented as being loaded once at proxy startup, so this scenario may not exist
as a runtime condition (see §5 below).

### CONNECT Tunnel (`--allow-domain` / `--network-profile`)

The tunnel uses standard HTTP proxy authentication. Denied hosts or CIDRs return 403. The
forbidden CIDR list (cloud metadata, link-local) always returns 403 regardless of allowlist.

---

## 2. What nono Emits on stdout/stderr

### Proxy audit log (stderr / tracing)

The proxy logs every decision via Rust's `tracing` framework. The format, shown verbatim in
the docs:

```
ALLOW CONNECT api.openai.com:443
DENY  CONNECT 169.254.169.254:80 reason=denied_cidr
ALLOW REVERSE openai POST /v1/chat/completions -> 200
ALLOW REVERSE anthropic POST /v1/messages -> 200
```

These lines appear on stderr when verbose logging is enabled (`-v` / `-vv` / `-vvv`):

> "Enable verbose logging to see proxy decisions: `nono run -vv --network-profile claude-code --allow-cwd -- my-agent`"
> (networking.md)

At the default log level (no `-v` flags), proxy decisions are **not** printed to stderr.

### env-credential missing at startup (stderr, hard failure)

When `--env-credential` or `--env-credential-map` is used and the keystore entry does not exist,
nono fails before the sandbox is applied:

```
nono: Secret not found in keystore: openai_api_key
```

When the keystore is locked:

```
Keystore access failed for 'openai_api_key': ...
Please unlock your keystore and press Enter to retry (or Ctrl+C to abort):
```

When there are duplicate entries:

```
nono: Failed to access system keystore: Multiple entries (2) found for 'api_key' - please resolve manually
```

These are printed to stderr and nono exits non-zero without running the child process.

### Custom credential validation failure at startup (stderr, hard failure)

From the credential injection docs:

> "Invalid configurations will fail with a clear error message before the sandbox is applied."

The validation checks are: upstream URL must be HTTPS (unless localhost), credential key must be
alphanumeric or a supported URI scheme. The exact stderr message format is not quoted.

### Diagnostic footer on non-zero exit

When the child exits with non-zero status, the supervisor prints a diagnostic footer to stderr:

> "When the child exits with a non-zero exit code, nono prints a diagnostic footer to stderr
> explaining what happened and suggesting fixes." (supervisor.md)

The exact content of the footer is not shown in the docs; it is described as "explaining what
happened and suggesting fixes."

Suppression: `--no-diagnostics` prevents the footer entirely. The footer appears in supervised
mode only (`nono run`/`nono shell`); Direct mode (`nono wrap`) has no parent process.

### Bypass-protection warning (stderr, non-fatal)

When `--bypass-protection` is used:

> "A warning is printed to stderr for each bypass applied, making security relaxations visible in
> logs." (flags.md)

---

## 3. Structured Event / Audit Log Streams

### Audit event log: `audit-events.ndjson`

Every supervised session writes an append-only NDJSON file at
`~/.nono/audit/<session-id>/audit-events.ndjson`. Recorded events include:

- `session_started`, `session_ended`
- Capability decisions (supervisor-observed)
- URL opens
- Network events (proxy decisions, drained at session end)
- Exit code

> "Every audited session writes an append-only `audit-events.ndjson` file." (audit.md)

The audit log is recorded by the trusted **parent/supervisor** process, not the child. The child
cannot tamper with it. Integrity is protected by a hash chain (Merkle root) by default.

**Network proxy events are not flushed per-request; they are drained into the audit record at
session end:**

> "Network proxy events are captured during the session, but the durable append-only audit log is
> finalized after the session ends rather than updated on every proxied request." (security-model.md)

This is an intentional tradeoff. If the supervisor is killed mid-session, recent network events
may not appear in the final audit record.

### Session metadata: `session.json`

Written at `~/.nono/sessions/<id>/session.json`. Contains: session id, name, status, child and
supervisor PIDs, start time, command, profile, workdir, network mode, and (if enabled) rollback
session id and audit attestation summary.

Machine-readable access: `nono inspect <id> --json` and `nono audit show <id> --json`.

### Audit list/show commands

```
nono audit list [--json] [--since DATE] [--command NAME]
nono audit show <session-id> [--json]
nono audit verify <session-id>
```

`nono audit show --json` exports all session metadata, network events, filesystem integrity data,
and exit status in a format suitable for log aggregators or compliance tooling.

### No real-time event subscription / streaming API

There is **no documented event subscription API, SSE stream, IPC event channel, or webhook
callback** that a parent process (e.g., our daemon) could use to receive proxy events in real
time. Proxy decisions are captured in memory during the session and flushed to the NDJSON audit
file at session end.

The supervisor-mode webhook backend is listed as **planned** (not implemented):

> "Future backends will support: Webhook: HTTP callback to an external approval service; Policy:
> Automatic decisions based on predefined rules." (supervisor.md)

---

## 4. Does nono Have a Real-Time Event API?

**No, not as of the fetched documentation.**

The only APIs are:
- CLI subcommands (`nono audit list/show/verify`, `nono ps`, `nono inspect`) — all read after-the-fact
- The OpenAPI spec linked in `llms.txt` is a placeholder plant-store demo, not a real nono API

The supervisor approval path (seccomp-notify) is internal to nono's process tree and not exposed
as an IPC interface to external processes. A parent process that wants proxy events must read the
NDJSON audit file after the session ends, or tail it live (since it is append-only NDJSON, `tail -f`
works, but there is no documented mechanism for knowing when each event is flushed).

---

## 5. Startup vs. Runtime Credential Errors

### env-credential mode (`--env-credential` / `--env-credential-map`)

Credentials are loaded from the keystore **before** the sandbox is applied and **before** the
child process is started. If loading fails, nono exits immediately with an error to stderr (see
§2 above). The child is never started.

> "1. nono loads secrets from keystore BEFORE sandbox is applied
> 2. Sandbox is applied (blocks keystore access)
> 3. Secrets injected as environment variables
> 4. Command executed with secrets available
> 5. Secrets zeroized from memory after exec()"
> (credential-injection.md)

There is no runtime credential re-fetch in env-credential mode. The credential becomes a plain
environment variable after `exec()`. If it is later revoked or rotated at the upstream service,
nono is unaware; the child just gets 401s from the upstream API.

### Proxy-credential mode (`--credential`)

Credentials are loaded **once at proxy startup**, stored in memory as `Zeroizing<String>`, and
reused for the session's lifetime.

> "Session-scoped — Credentials are loaded once at proxy startup and never written to disk or
> logged." (credential-injection.md)

| Scenario | What happens |
|----------|--------------|
| **Credential missing at startup** (keychain entry does not exist when `nono run` is invoked) | No explicit error message is documented. The validation check at startup applies to custom credential config syntax (HTTPS upstream, alphanumeric key), not to a missing keystore entry. **Likely** fails with an error before or during proxy startup, but the exact message and timing are not shown in the docs. This is a **gap** — see §7. |
| **Credential missing at request time** (deleted from keychain after proxy started) | Not possible — credentials are loaded once at startup and held in memory. The proxy holds the credential value in RAM for the session; keychain deletion has no effect mid-session. |
| **Credential present but rejected by upstream (401 from origin)** | The proxy streams the upstream 401 response back to the client. The proxy itself does not rewrite 4xx responses from the upstream. The child receives whatever the upstream returned. The event is logged to the audit trail as `ALLOW REVERSE <service> <method> <path> -> 401`. |

---

## 6. Can the Child Process Observe the Error Differently Than the Supervisor?

### What the child sees

The child (Python kernel, agent, etc.) sits behind the proxy. It communicates only with
`localhost:<port>`. It cannot:
- Access the keystore
- Read nono's audit log
- Inspect proxy configuration
- Receive signals from the supervisor about proxy state

The child observes credential and proxy errors purely as **HTTP responses**:
- Phantom token invalid → `401 Unauthorized`
- Host not allowed → `403 Forbidden` (via CONNECT) or `403` (via reverse proxy endpoint rules)
- Upstream rejection → whatever status the upstream returned (e.g., `401`, `403`, `429`)
- Proxy crash → TCP connection refused / connection reset (since only `localhost:<port>` is reachable)

The `nono why --self` introspection tool is available inside the sandbox:

```
nono why --self --host api.openai.com --json
# {"status":"allowed",...} or {"status":"denied",...}
```

But this queries the domain allowlist, not whether a credential value is valid.

### What the supervisor sees

The supervisor sees:
- Proxy decision logs via `tracing` (verbose mode only, to stderr)
- Keystore load errors at startup (to stderr, process exits)
- Session audit events (to `audit-events.ndjson`)
- Child exit code and diagnostic footer

The supervisor does **not** receive a callback when an upstream 401 is returned; it only sees
the status code in the audit log at session end (or can observe it in verbose tracing output).

### Asymmetry summary

| Signal | Child sees | Supervisor sees |
|--------|-----------|-----------------|
| Invalid phantom token | HTTP 401 | tracing log entry (if `-vv`) + audit event |
| Host blocked | HTTP 403 (CONNECT) or TCP refusal | tracing log + audit event |
| Upstream 401 | HTTP 401 (pass-through) | tracing log (if `-vv`) + audit event |
| Keystore missing at startup | Never started | stderr error, process exits |
| Proxy crash | TCP refused/reset | Supervisor exits; session ends |

---

## 7. Gaps and Unknowns in the Documentation

1. **Exact HTTP status for "credential key not found in keystore" at proxy startup**: The docs
   state credentials are "loaded once at proxy startup" and that custom credentials are validated
   at startup, but do not show the exact error message or exit behavior when a keyring lookup
   fails in proxy mode (as opposed to env-credential mode, which has explicit error text).

2. **Proxy-mode missing credential at startup**: For `--credential openai` where the macOS
   Keychain entry `nono`/`openai` is absent, the behavior is not documented. Likely: nono fails
   to start with a message similar to the env-credential error, but this is inferred, not
   confirmed.

3. **No real-time event streaming API**: A daemon wanting to subscribe to proxy events has no
   supported path besides tailing the NDJSON audit file (append-only, readable live) or polling
   `nono audit list --json`. A webhook backend is listed as a planned future feature.

4. **Audit event schema**: The NDJSON audit event format is not documented (field names, types,
   event type values). The docs describe what is recorded but do not show an example JSON event
   object.

5. **Upstream 401 passthrough confirmation**: The docs say credential values are never logged and
   that proxy decisions are logged as `ALLOW/DENY + status code`, but it is not explicitly stated
   whether the proxy passes through an upstream 401 verbatim or rewrites it. The strong implication
   from the architecture (reverse proxy, streams response back) is verbatim passthrough.

6. **`nono ps --json` and `nono inspect --json` schemas**: These machine-readable outputs are
   mentioned but their schemas are not documented. Useful for a daemon wanting to observe session
   state.

---

## 8. Raw Relevant Quotes

**Phantom token rejection (401)**
> "Requests without a valid phantom token are rejected with `401 Unauthorized`."
> — credential-injection.md, "Session Token Authentication"

**Phantom token rejection for url_path/query_param modes (401)**
> "Invalid or missing phantom tokens result in HTTP 401 Unauthorized responses."
> — credential-injection.md, "Phantom Token Validation"

**CONNECT tunnel auth (407)**
> "no-credential reverse proxy routes and CONNECT tunnels use proxy auth and invalid or missing
> credentials are rejected with `407 Proxy Authentication Required`."
> — credential-injection.md, "Session Token Authentication"

**Endpoint filter denial (403)**
> "requests that don't match receive `403 Forbidden` and are logged in the audit trail"
> — networking.md, "Endpoint Filtering"

**Domain not in allowlist (403)**
> "Requests to other paths on the same domain receive `403 Forbidden`"
> — networking.md, "CONNECT Tunnel"

**Proxy failure modes table**
> "Invalid token → Proxy returns 403 | Host not in allowlist → Proxy returns 403 |
> DNS resolves to denied CIDR → Proxy returns 403 | Upstream TLS failure → Proxy returns 502"
> — security-model.md, "Proxy Failure Modes"

**Audit log format (proxy decisions)**
> "ALLOW CONNECT api.openai.com:443
> DENY  CONNECT 169.254.169.254:80 reason=denied_cidr"
> — networking.md, "Audit Logging"

**Audit log format (credential requests)**
> "ALLOW REVERSE openai POST /v1/chat/completions -> 200
> ALLOW REVERSE anthropic POST /v1/messages -> 200"
> — credential-injection.md, "Audit Logging"

**Credential loaded once at startup**
> "Session-scoped — Credentials are loaded once at proxy startup and never written to disk or
> logged."
> — credential-injection.md, "Security Properties"

**env-credential missing message**
> "nono: Secret not found in keystore: openai_api_key"
> — credential-injection.md, "Error Handling"

**Network events not per-request durable**
> "Network proxy events are captured during the session, but the durable append-only audit log is
> finalized after the session ends rather than updated on every proxied request."
> — security-model.md, "Audit Durability Boundary"

**Webhook backend planned, not yet implemented**
> "Future backends will support: Webhook: HTTP callback to an external approval service"
> — supervisor.md, "Approval Backends"

**Diagnostic footer on non-zero exit**
> "When the child exits with a non-zero exit code, nono prints a diagnostic footer to stderr
> explaining what happened and suggesting fixes."
> — supervisor.md, "Diagnostic Footer"

**Verbose proxy logging**
> "Enable verbose logging to see proxy decisions: `nono run -vv ...`"
> — networking.md, "Audit Logging"

---

## Summary Table

| Question | Answer |
|----------|--------|
| HTTP status for invalid/missing phantom token | **401** |
| HTTP status for CONNECT tunnel auth failure | **407** |
| HTTP status for host not in allowlist | **403** |
| HTTP status for endpoint rule violation | **403** |
| HTTP status for upstream TLS error | **502** |
| HTTP status for upstream 401 (bad API key) | **401 (pass-through from upstream)** |
| Proxy log format | `ALLOW/DENY CONNECT/REVERSE <svc> <method> <path> -> <status>` via `tracing` |
| Proxy logs visible by default | No — requires `-v` / `-vv` |
| Structured event stream (real-time) | **None** — no IPC event API exists |
| Audit log location | `~/.nono/audit/<id>/audit-events.ndjson` (NDJSON, append-only) |
| Audit log flushed per-request | No — drained at session end |
| Credential load time (proxy mode) | Once at proxy startup; held in RAM for session |
| Credential load time (env mode) | Once before sandbox applied; injected as env var |
| Missing credential at startup (env mode) | stderr error + nono exits, child never runs |
| Missing credential at startup (proxy mode) | Behavior not explicitly documented (gap) |
| Missing credential at request time (proxy mode) | Not possible — held in RAM from startup |
| Upstream 401 observed by child | Yes, pass-through HTTP 401 |
| Upstream 401 observed by supervisor | Via audit log (after session) or tracing (if `-vv`) |
| Daemon subscribe to proxy events in real-time | Not supported; tail NDJSON audit file or poll `nono audit list --json` |
| Webhook callback for proxy events | Planned, not yet implemented |
