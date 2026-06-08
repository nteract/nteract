# nono.sh Investigation: Proxy & Credential Injection for Notebook Kernels

**Date:** 2026-06-08  
**Scope:** Research only — no code changes. Evaluating nono.sh as a network proxy/credential injector for Python kernels in nteract.

**MVP use case:** A notebook cell executes `requests.get("https://example.com")`. nono intercepts the HTTP call, reads a secret from the macOS keychain, and injects the credential into the outbound request — without the kernel process ever seeing the real secret.

---

## 1. What nono.sh Is

nono.sh is a kernel-enforced sandbox CLI and SDK suite for running untrusted or semi-trusted processes. Its primary audience is AI coding agents, but the mechanisms are general.

**Core value propositions:**
- Capability-based isolation using macOS Seatbelt and Linux Landlock — OS kernel enforcement, not application-level controls.
- A network proxy that runs in a trusted parent process and provides domain filtering, credential injection, and audit logging.
- Secret management: reads credentials from macOS Keychain, Linux Secret Service, 1Password, Bitwarden, or environment variables, and either injects them as env vars or swaps them invisibly via HTTP proxy — the child process never sees the real key.
- Audit trail, atomic filesystem rollback (snapshots), and cryptographic attestation — useful for agent oversight, less relevant to our immediate MVP.

**Available interfaces:**
- **CLI** (`nono run`, `nono wrap`): wraps an arbitrary process invocation.
- **Python SDK** (`nono_py`): integrates into Python code to build and apply sandboxes programmatically. Can also start a standalone proxy from Python.
- **Go SDK** (`nono-go`): CGo bindings.
- **TypeScript/Node.js SDK** (`nono-ts`): Node.js bindings.
- **Rust core library** (`nono-core`): underlying implementation; other SDKs are FFI wrappers around this.

---

## 2. Architecture Overview

### Execution model: supervised vs. direct

**Supervised mode** (`nono run`) is the default:
1. nono forks.
2. The **child** is sandboxed (kernel restrictions applied, irreversible).
3. The **parent** (supervisor) remains unsandboxed and provides runtime services: network proxy, audit recording, filesystem rollback, capability expansion (Linux only), diagnostic footer.

The proxy **must** run in the unsandboxed supervisor. This is non-negotiable: the proxy holds real credentials, performs DNS resolution, and routes outbound TCP. The sandboxed child can only reach `localhost:<proxy_port>`. All other outbound TCP is blocked at the kernel level.

**Direct mode** (`nono wrap`): nono calls `exec()` directly into the target — no parent stays alive. No proxy, no audit, no rollback. Not relevant to our use case.

### Network proxy mechanics

When `--network-profile`, `--allow-domain`, or `--credential` is active:

1. nono starts an HTTP proxy (bound to `127.0.0.1:<ephemeral_port>`) in the supervisor process.
2. It sets `HTTP_PROXY` and `HTTPS_PROXY` to `http://127.0.0.1:<port>` in the child's environment.
3. All outbound TCP from the child is kernel-blocked except to that proxy port.
4. The proxy supports three modes (combinable per session):
   - **CONNECT tunnel**: domain-filtered HTTPS tunneling. The proxy validates the target hostname, then relays raw TCP. TLS is end-to-end; the proxy never sees plaintext.
   - **Reverse proxy**: credential injection. Child sends plain HTTP to `http://localhost:<port>/<service>/...`. The proxy strips the service prefix, injects the real credential as a header, and forwards to upstream over TLS.
   - **External proxy passthrough**: chains through a corporate proxy (not relevant here).

### Credential injection end-to-end (reverse proxy mode)

```
Python kernel (child, sandboxed):
  requests.get("https://example.com/api")
  → Python's requests library reads HTTPS_PROXY
  → sends HTTP CONNECT or plain POST to http://127.0.0.1:<port>/myservice/api
  → includes "Authorization: Bearer <NONO_PROXY_TOKEN>" (phantom token)

nono proxy (supervisor, unsandboxed):
  → receives request
  → validates phantom token (constant-time compare of 256-bit session token)
  → reads real secret from macOS Keychain (loaded at proxy startup, never written to disk)
  → strips inbound Authorization header
  → injects real "Authorization: Bearer sk-real-secret"
  → forwards to https://example.com/api over TLS

Response flows back:
  → proxy streams response to kernel
  → kernel sees response, never the real secret
```

The child process environment contains `NONO_PROXY_TOKEN` (the phantom token) and `MYSERVICE_BASE_URL=http://127.0.0.1:<port>/myservice`. The real secret stays only in the supervisor's memory (`Zeroizing<String>`, wiped on drop).

### macOS-specific: kernel enforcement

On macOS, nono uses Apple's Seatbelt (`sandbox_init()`). The network rule is:

```scheme
(deny network*)
(allow network-outbound (remote tcp "localhost:PORT"))
(allow system-socket ...)
```

The child cannot bypass this from userspace. `connect()` to any address other than the proxy port returns `EPERM`.

---

## 3. CLI Wrapper vs. Python SDK — Recommendation for nteract

### The question

Should nteract use:
- **CLI wrapper**: `nono run --credential myservice -- python kernel.py` — wrap the kernel process launch so all child network calls go through nono.
- **Python SDK** (`nono_py`): integrate nono into code directly, calling `start_proxy()` and `apply()` from the daemon or kernel bootstrap.

### Analysis

#### Trust boundary

The AGENTS.md invariant is critical here: **the daemon is trusted and long-running; the Python kernel/runtime is untrusted and ephemeral.**

nono's own security model is built on the same premise: the supervisor is trusted, the child is untrusted. This maps directly to nteract's architecture:

- **Daemon** = nono supervisor role (trusted, long-running, holds credentials, manages process lifecycle)
- **Python kernel** = nono child role (untrusted, ephemeral, should never see real secrets)

#### CLI wrapper

Pros:
- Zero changes to kernel launch code; wrap the process invocation in `nono run`.
- nono installs its own proxy, sets `HTTP_PROXY`/`HTTPS_PROXY`, enforces Seatbelt rules.
- The daemon does not need to understand nono internals.
- Kernel restart is trivial: re-run `nono run ... -- python -m ipykernel ...`.
- Profile system allows declarative, auditable policy stored in `~/.config/nono/profiles/`.
- No FFI/native dependency in daemon code.

Cons:
- Less programmatic control; can't dynamically adjust routes or credentials without changing the command line.
- Credential injection only works for services with pre-configured routes or custom_credentials in the profile.
- Audit events require reading nono's audit trail separately; not directly in daemon's data model.

#### Python SDK (`nono_py`)

Pros:
- The daemon (written in Rust) could embed `nono-core` directly (via the same Rust crate) rather than the Python bindings.
- Full programmatic control over `ProxyConfig`, `RouteConfig`, proxy startup/shutdown, and `drain_audit_events()`.
- `ProxyHandle.sandbox_env()` returns exactly the env vars needed to pass to the kernel process.
- Can integrate audit events directly into the daemon's runtime state.
- `start_proxy()` + `sandboxed_exec()` is the designed pattern for "supervisor orchestrates sandboxed child."

Cons:
- Requires embedding `nono_py` as a Python package dependency, or `nono-core` as a Rust crate dependency in the daemon.
- More coupling: the daemon must manage proxy lifecycle explicitly.
- `apply()` on the daemon process would sandbox the daemon itself — must only call `apply()` on the forked child, not the daemon.

#### Recommendation: **CLI wrapper for MVP, Python SDK for deeper integration**

For the MVP, use the **CLI wrapper approach**:

```bash
nono run \
  --profile nteract-kernel \
  --credential myservice \
  -- python -m ipykernel_launcher -f "{connection_file}"
```

Rationale:
1. The daemon already manages kernel process lifecycle. Inserting `nono run` into the command line is the least invasive change.
2. The profile system handles credential routing declaratively, outside of daemon code.
3. Kernel restarts are free: re-run the same command.
4. No new native dependencies in the daemon's Rust codebase.
5. nono already has a `python-dev` profile as a starting point.

The Python SDK (`nono_py` or the underlying Rust crate `nono-core`) becomes attractive if nteract needs to:
- Dynamically reconfigure credential routes at runtime (e.g., user adds a new API key via the UI without restarting the kernel).
- Integrate audit events directly into Automerge document state.
- Expose the `ProxyHandle` to other subsystems.

---

## 4. Minimal Profile for Proxy-Only Usage

The MVP goal is **only credential injection + proxy** — not filesystem sandboxing, not domain blocking, not full confinement. This is achievable.

### Key insight: network proxy does not require filesystem sandbox

nono's proxy can run without any filesystem restrictions. The `network` section is independent of filesystem policy. You can have:
- `network.credentials: ["myservice"]` — enables the reverse proxy with credential injection
- `network.allow_domain: ["example.com"]` — enables CONNECT tunnel with domain filtering
- `network.block: false` (default) — no network blocking

Without `--block-net` or a network profile, direct outbound TCP is **allowed by default**. Only when domain filtering is activated does nono force all traffic through the proxy.

### Minimal profile: proxy + credential injection, no confinement

```json
{
  "meta": {
    "name": "nteract-kernel-proxy",
    "description": "Credential injection proxy for Python kernels — no filesystem confinement",
    "version": "1.0.0"
  },
  "workdir": {
    "access": "readwrite"
  },
  "network": {
    "credentials": ["myservice"]
  }
}
```

With this profile, nono:
- Starts the reverse proxy in the supervisor.
- Sets `HTTPS_PROXY`, `HTTP_PROXY`, `NONO_PROXY_TOKEN`, and `MYSERVICE_BASE_URL` in the child env.
- Does **not** block direct outbound TCP (the kernel can still make unrestricted connections to other hosts).
- Injects the credential for requests routed through the proxy prefix.

**Caveat:** Without kernel-level network enforcement, a sophisticated Python library that bypasses the proxy env vars (e.g., using raw sockets, or explicitly ignoring `HTTPS_PROXY`) would not go through the proxy. Most Python HTTP libraries (`requests`, `httpx`, `aiohttp`, `urllib`) respect the standard proxy env vars by default. This is acceptable for MVP.

### Tighter profile: proxy + CONNECT tunnel domain filtering

If we want to also enforce that the kernel can only reach specific domains:

```json
{
  "meta": {
    "name": "nteract-kernel-strict",
    "description": "Credential injection + domain filtering for Python kernels",
    "version": "1.0.0"
  },
  "workdir": {
    "access": "readwrite"
  },
  "network": {
    "network_profile": "minimal",
    "allow_domain": ["example.com", "api.example.com"],
    "credentials": ["myservice"]
  }
}
```

This activates kernel-level enforcement: all outbound TCP is blocked except to the proxy port. The proxy allows `example.com` (CONNECT tunnel, no credential injection) and routes `/myservice/...` through credential injection. Unknown domains get `403 Forbidden`.

### Storing the credential (macOS)

```bash
# Store secret in macOS Keychain under service="nono", account="myservice"
security add-generic-password -s "nono" -a "myservice" -w "sk-actual-secret"
```

### Custom credential route

For a non-standard API (not one of nono's built-in LLM services):

```json
{
  "meta": { "name": "nteract-kernel-proxy", "version": "1.0.0" },
  "workdir": { "access": "readwrite" },
  "network": {
    "credentials": ["myservice"],
    "custom_credentials": {
      "myservice": {
        "upstream": "https://example.com",
        "credential_key": "myservice",
        "inject_header": "Authorization",
        "credential_format": "Bearer {}"
      }
    }
  }
}
```

The kernel process would see:
- `MYSERVICE_BASE_URL=http://127.0.0.1:<port>/myservice`
- `MYSERVICE_API_KEY=nono_sess_<phantom_token>` (phantom token, not real key)

And `requests.get("https://example.com/endpoint")` would need to be changed to `requests.get(os.environ["MYSERVICE_BASE_URL"] + "/endpoint")` — or the kernel code rewrites the base URL explicitly.

**Important naming constraint:** Use underscores in credential names, not hyphens. The name is used to generate env var names like `MYSERVICE_BASE_URL`.

---

## 5. How Credential Injection Works End-to-End

### Startup sequence

1. `nono run --profile nteract-kernel-proxy -- python -m ipykernel ...`
2. nono reads the profile's `network.credentials` list.
3. For each credential, nono reads the secret from the macOS Keychain at startup (one-time). Stored in `Zeroizing<String>` — wiped on drop. Never written to disk or logged.
4. Proxy binds to `127.0.0.1:<random_port>`.
5. Generates 256-bit random session token.
6. nono forks. Child inherits env vars set by supervisor:
   - `HTTP_PROXY=http://127.0.0.1:<port>`
   - `HTTPS_PROXY=http://127.0.0.1:<port>`
   - `NONO_PROXY_TOKEN=<256-bit-token>`
   - `MYSERVICE_BASE_URL=http://127.0.0.1:<port>/myservice`
   - `MYSERVICE_API_KEY=<phantom_token>` (if `env_var` is set in custom_credentials)
7. Sandbox is applied to child (Seatbelt on macOS). If domain filtering is active, all outbound TCP except proxy port is blocked.
8. Python kernel starts.

### Request flow (reverse proxy credential injection)

```
kernel code:
  import os, requests
  base = os.environ["MYSERVICE_BASE_URL"]  # "http://127.0.0.1:PORT/myservice"
  resp = requests.get(f"{base}/v1/data", headers={"Authorization": f"Bearer {os.environ['MYSERVICE_API_KEY']}"})
  # requests sees HTTPS_PROXY, routes through proxy

proxy (supervisor):
  receives: GET http://127.0.0.1:PORT/myservice/v1/data
            Authorization: Bearer nono_sess_<phantom>
  validates: phantom token == session token (constant-time)
  strips:    Authorization header
  injects:   Authorization: Bearer sk-actual-secret
  forwards:  GET https://example.com/v1/data
             Authorization: Bearer sk-actual-secret
  streams response back to kernel
```

### Header injection modes

| Mode | Use case | Example |
|------|----------|---------|
| `header` (default) | Standard Bearer/API key in header | `Authorization: Bearer sk-...` |
| `url_path` | Token in URL path (e.g., Telegram Bot API) | `/bot<token>/sendMessage` |
| `query_param` | Token as query parameter | `?api_key=<token>` |
| `basic_auth` | HTTP Basic Auth | `Authorization: Basic base64(user:pass)` |

### Environment variable injection (simpler, less secure alternative)

For secrets that don't need proxy-based protection (e.g., a database password that doesn't go over HTTP), nono can inject them directly as env vars:

```bash
nono run --env-credential db_password -- python -m ipykernel ...
```

The kernel process sees `DB_PASSWORD=<actual_secret>`. This is visible in `/proc/<pid>/environ` on Linux (same-user processes can read it), but is simpler. On macOS this is less of a concern. The docs recommend proxy injection for LLM API keys specifically.

---

## 6. Process Opt-In Mechanism

The kernel opts in by reading environment variables set by nono:

| Variable | Set by nono | Used by kernel |
|----------|------------|----------------|
| `HTTP_PROXY` / `HTTPS_PROXY` | Yes, always when proxy starts | Python `requests`, `httpx`, `aiohttp`, `urllib` read these automatically |
| `NONO_PROXY_TOKEN` | Yes | Used as the phantom credential in headers |
| `<SERVICE>_BASE_URL` | Yes, per credential route | Kernel code must use this as the API base URL |
| `<SERVICE>_API_KEY` | Yes, if `env_var` is set | Kernel code uses as the bearer token (phantom value) |

**No code changes are needed in Python code** if the library respects `HTTPS_PROXY`. The standard `requests` library does. The kernel process just makes normal HTTP calls; the proxy intercepts and injects credentials transparently.

The exception: for reverse proxy mode, the kernel must send requests to the local proxy prefix URL (`http://127.0.0.1:PORT/service/...`) rather than the real upstream URL. This requires either:
1. The kernel code uses `os.environ["SERVICE_BASE_URL"]` as the base URL (standard practice for LLM SDKs like `openai` Python package, which reads `OPENAI_BASE_URL`).
2. nono rewrites the target URL — not currently supported; only header injection is done, not URL rewriting for CONNECT-mode traffic.

For general arbitrary HTTP calls like `requests.get("https://example.com")` that don't go through a known service prefix, the CONNECT tunnel mode (domain filtering) is the right mechanism. The proxy validates the domain and relays raw TLS — no credential injection, but the call goes through the proxy for domain allowlisting.

---

## 7. macOS Keychain Integration

nono uses the system keychain (`security` command on macOS, equivalent to the macOS Keychain Access app):

```bash
# Store a secret
security add-generic-password -s "nono" -a "account_name" -w "secret_value"

# Update
security add-generic-password -s "nono" -a "account_name" -w "new_value" -U

# Delete
security delete-generic-password -s "nono" -a "account_name"
```

nono uses the `keyring` Rust crate internally. The macOS backend uses `security find-generic-password -s nono -a <account> -w`.

**First-run keychain prompt:** On first access, macOS will prompt "nono wants to use the 'nono' password in your keychain." Click "Always Allow" to avoid repeated prompts.

**Alternative credential sources (all supported by nono):**
- `keyring://<service>/<account>` — custom keychain service name
- `op://<vault>/<item>/<field>` — 1Password
- `bw://<item-id>/<field>` — Bitwarden
- `apple-password://<server>/<account>` — macOS Apple Passwords (internet passwords)
- `env://<VAR>` — host environment variable (not sandboxed child env)
- `file://<path>` — file-backed secret

---

## 8. Caveats, Limitations, and Open Questions

### Caveats

1. **Proxy-only mode requires Python library cooperation.** Libraries that explicitly disable proxy support or use raw sockets bypass the proxy. This covers `requests`, `httpx`, `aiohttp`, `urllib3` — virtually all standard Python HTTP. It does not cover code using `socket.connect()` directly.

2. **Domain filtering requires `nono run` (supervised mode).** `nono wrap` is incompatible with proxy because there's no parent process to run the proxy. Must use `nono run`.

3. **macOS only: no per-port filtering.** Seatbelt cannot filter outbound by destination port, only by remote address. The restriction is all-or-nothing for outbound TCP (allow proxy port, deny all else, or allow all). This is fine for our use case.

4. **CONNECT tunnel is HTTP/1.1.** The reverse proxy speaks HTTP/1.1 to upstream. CONNECT tunnel passes raw bytes so HTTP/2 works end-to-end. Most Python APIs are HTTP/1.1 anyway.

5. **Go CLI tools (`gh`, `terraform`) on macOS ignore `SSL_CERT_FILE`.** They only trust the system keychain (`com.apple.trustd`). For credential injection to work with these tools, `--trust-proxy-ca` must be passed (persists proxy CA in macOS Keychain). Irrelevant for Python kernels.

6. **Credential name constraint.** Custom credential names must use underscores, not hyphens. `my-api` → generates invalid env var `MY-API_BASE_URL`. Use `my_api` instead.

7. **Proxy mints its own TLS certificate for MITM scenarios.** For CONNECT tunnel mode (no MITM), TLS is end-to-end. For reverse proxy mode, the proxy itself is the TLS endpoint (it holds credentials and forwards to upstream). The kernel talks plain HTTP to the local proxy; the proxy upgrades to TLS for upstream.

8. **Phantom token requirement.** In reverse proxy mode, the child must include the session token as the credential in the configured header/path/query. For `inject_mode: header` with `inject_header: Authorization`, the client must send `Authorization: Bearer <NONO_PROXY_TOKEN>`. Python's `requests` library won't do this automatically — the kernel code must explicitly set the header using `os.environ["NONO_PROXY_TOKEN"]`. Unless the SDK reads the `<SERVICE>_API_KEY` env var automatically (as OpenAI's Python SDK reads `OPENAI_API_KEY`).

9. **No dynamic credential updates.** Credentials are loaded once at proxy startup. Adding a new credential source requires restarting nono (and therefore the kernel). Acceptable for our MVP.

10. **nono is macOS + Linux only.** No Windows support. Acceptable for nteract's target platforms.

### Open Questions

**Q1: Can nono proxy be started without sandboxing the child's filesystem?**
Yes. The filesystem sandbox is entirely optional. A profile with only `network.credentials` and no `filesystem` restrictions launches the proxy without any Seatbelt filesystem rules. Confirmed by the `python-dev` profile which has `network_profile: developer` but no explicit filesystem sandbox beyond CWD.

**Q2: Does nono work with Jupyter's ZMQ connection model?**
ZMQ sockets are UNIX domain sockets or TCP localhost sockets — not outbound HTTP. nono's proxy only intercepts HTTP (via `HTTP_PROXY`/`HTTPS_PROXY`). ZMQ connections between the kernel and Jupyter frontend are not affected. Only HTTP calls made from within kernel cells go through the proxy.

**Q3: Does `requests` automatically use `HTTPS_PROXY` for HTTPS requests?**
Yes. Python's `requests` uses the `urllib3` ProxyManager when `HTTPS_PROXY` is set. The proxy handles the `CONNECT` tunnel or reverse proxy route. The library sends `CONNECT example.com:443 HTTP/1.1` with `Proxy-Authorization: Bearer <NONO_PROXY_TOKEN>`, and nono routes it.

**Q4: What happens if the user's code explicitly sets `proxies={}` in requests?**
The proxy is bypassed. This is a known limitation — application-level proxy bypass is possible. Kernel-level enforcement (activating `network_profile`) would catch this, as it blocks all non-proxy outbound TCP at the OS level.

**Q5: Is there a Python SDK method to start just the proxy without sandboxing the current process?**
Yes. `start_proxy(config: ProxyConfig) -> ProxyHandle` starts the proxy in a background thread within the calling process. The calling process is NOT sandboxed. `apply(caps)` is a separate call that sandboxes the calling process. They are independent. This means the daemon could call `start_proxy()` from Rust (via `nono-core`) and then launch the kernel as a subprocess with the proxy env vars — without ever sandboxing itself.

**Q6: Can nteract's Rust daemon use nono-core directly?**
Potentially. nono-core is a Rust crate. If it's published on crates.io or as a git dependency, the daemon could use it directly. This would be the cleanest integration — no subprocess exec of `nono run`, just Rust-to-Rust. Needs investigation of nono-core's public API surface and license.

**Q7: What is nono's license?**
Not checked during this investigation. The GitHub repo is `always-further/nono`. Need to verify before any integration.

**Q8: What does endpoint filtering look like for generic HTTP (not LLM APIs)?**
Endpoint rules in custom_credentials restrict which HTTP method+path combos are allowed on a per-service basis. E.g., `[("GET", "/v1/data/**"), ("POST", "/v1/submit")]`. Requests outside these patterns get `403 Forbidden`. This enables least-privilege at the API level, beyond just domain allowlisting.

---

## 9. Integration Design Sketch (MVP)

### Minimal viable integration

1. Install nono: `brew install nono` or download binary.
2. Store secrets in macOS Keychain:
   ```bash
   security add-generic-password -s "nono" -a "myservice" -w "sk-actual-secret"
   ```
3. Create a nteract kernel profile at `~/.config/nono/profiles/nteract-kernel.json`:
   ```json
   {
     "meta": { "name": "nteract-kernel", "version": "1.0.0" },
     "workdir": { "access": "readwrite" },
     "network": {
       "credentials": ["myservice"],
       "custom_credentials": {
         "myservice": {
           "upstream": "https://example.com",
           "credential_key": "myservice",
           "inject_header": "Authorization",
           "credential_format": "Bearer {}"
         }
       }
     }
   }
   ```
4. Wrap the kernel launch in the daemon:
   ```
   // Before (example):
   ["python", "-m", "ipykernel_launcher", "-f", connection_file]
   
   // After:
   ["nono", "run", "--profile", "nteract-kernel", "--",
    "python", "-m", "ipykernel_launcher", "-f", connection_file]
   ```
5. In the notebook cell, the user writes:
   ```python
   import os, requests
   base = os.environ.get("MYSERVICE_BASE_URL", "https://example.com")
   resp = requests.get(f"{base}/v1/data",
                       headers={"Authorization": f"Bearer {os.environ['MYSERVICE_API_KEY']}"})
   ```
   The proxy intercepts, validates the phantom token in `MYSERVICE_API_KEY`, and substitutes the real credential.

### What the kernel process sees vs. what actually happens

| What kernel sees | What really happens |
|-----------------|---------------------|
| `MYSERVICE_BASE_URL=http://127.0.0.1:12345/myservice` | Local proxy URL |
| `MYSERVICE_API_KEY=nono_sess_abc123` | Phantom token, not real key |
| `HTTPS_PROXY=http://127.0.0.1:12345` | Proxy for all HTTPS |
| Makes request to `http://127.0.0.1:12345/myservice/endpoint` | Proxy validates phantom, injects real key, forwards to `https://example.com/endpoint` |

---

## 10. Raw Notes

### From the networking docs
- Proxy starts automatically when `--allow-domain`, `--network-profile`, or `--credential` is used.
- Node.js 26+: nono also sets `NODE_USE_ENV_PROXY=1` so built-in `fetch()` reads `HTTPS_PROXY`. Python already does this without special handling.
- `--proxy-port` to fix a known port if needed (for apps that require a known proxy port — not an issue for Python kernels).
- Always-denied destinations: `169.254.169.254` (AWS/GCP metadata), `metadata.google.internal`, `metadata.azure.internal`, link-local ranges. Cannot be overridden.

### From the credential injection docs
- Credentials are `Zeroizing<String>` — wiped from memory on drop. Session-scoped, never written to disk.
- Audit logging: `ALLOW REVERSE myservice POST /v1/data -> 200` — service name and status code only, no credential values.
- `--allow-endpoint` for further restricting which HTTP method+path combos are allowed.

### From the security model docs
- Proxy failure modes are all fail-closed. If proxy crashes, child loses all network access (only proxy port was open). If token is invalid, 403. If host not in allowlist, 403.
- 256-bit session token compared in constant time (timing attack prevention).
- DNS rebinding: proxy resolves DNS and rejects link-local IPs even if the hostname is in the allowlist.

### From the Python SDK docs
- `start_proxy(config) -> ProxyHandle` — starts proxy in calling process.
- `proxy.sandbox_env()` — returns combined list of `(key, value)` tuples ready to pass to `sandboxed_exec(env=...)`.
- `proxy.drain_audit_events()` — returns structured audit events per proxied request.
- `sandboxed_exec(caps, cmd, env=...)` — the designed pattern: supervisor calls this on the child command with proxy env vars.
- The proxy can be used without any filesystem sandbox: just don't call `apply(caps)`.

### Profile `python-dev` (relevant base)
- Groups: `python_runtime` + default groups.
- Network: `developer` profile (llm_apis, package_registries, github, sigstore, docs).
- CWD: read+write.
- Could be used as a base for a nteract kernel profile and add custom credentials on top.

### Important: proxy only in supervised mode
From execution modes docs: "No network proxy (incompatible — proxy requires a parent process)" for `nono wrap`. Must always use `nono run` for credential injection.

### Filesystem sandbox is optional
The network proxy is not tied to any filesystem restrictions. A profile can have full filesystem access (or just `workdir: readwrite`) and still use the proxy. The proxy activates based on `network.*` settings, independent of `filesystem.*`.
