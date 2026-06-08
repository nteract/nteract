# nteract Network & Process Architecture

> Research snapshot — June 2026. No code was changed; this is purely
> descriptive. Sources: AGENTS.md files, `crates/runtimed/src/`,
> `crates/notebook-wire/AGENTS.md`, `crates/kernel-env/AGENTS.md`,
> `apps/notebook/src/AGENTS.md`.

---

## 1. Process Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│  macOS / Linux user session                                          │
│                                                                      │
│  ┌──────────────┐        Unix socket                                 │
│  │  Tauri app   │  ←── ~/.cache/runt[-nightly]/runtimed.sock ───┐   │
│  │  (WebView)   │        mode 0600, owner-private 0700          │   │
│  │              │                                                │   │
│  │  WASM peer   │     length-prefixed typed frames              │   │
│  │  (Automerge) │     (preamble 0xC0DE01AC + protocol v4)       │   │
│  └──────────────┘                                                │   │
│         ↕  Tauri IPC (invoke / frame channel)                    │   │
│  ┌──────────────┐                                                │   │
│  │  Tauri relay │ ←── transparent byte pipe ──────────────────► │   │
│  │  (crates/    │                                                │   │
│  │   notebook/) │                                                │   │
│  └──────────────┘                                                │   │
│                                                                   │   │
│            ┌──────────────────────────────────────────────────── ┘   │
│            │                                                          │
│  ┌─────────▼───────┐    Unix socket (same sock, RuntimeAgent         │
│  │  runtimed daemon│    handshake)                                    │
│  │  (runtimed)     │ ◄──────────────────────────────────────┐        │
│  │                 │                                         │        │
│  │  blob HTTP      │    IPC ZMQ sockets (5 channels)        │        │
│  │  127.0.0.1:N    │ ◄──────────────────────────────────┐   │        │
│  └─────────────────┘                                    │   │        │
│                                                          │   │        │
│  ┌─────────────────────────────────────┐                │   │        │
│  │  runtimed runtime-agent             │                │   │        │
│  │  (subprocess of daemon, same binary)│ ───────────────┘   │        │
│  │  own process group                  │                     │        │
│  │                                     │ ────────────────────┘        │
│  └───────────────┬─────────────────────┘                              │
│                  │  tokio::process::Command::spawn()                  │
│                  │  SIGKILL on drop (killpg)                          │
│                  ▼                                                     │
│  ┌─────────────────────────────────────┐                              │
│  │  Python / Deno kernel process       │                              │
│  │  (ipykernel / deno jupyter)         │                              │
│  │                                     │                              │
│  │  Inherits daemon process env        │                              │
│  │  + shell overlay (filtered)         │                              │
│  │  + VIRTUAL_ENV / PATH overlay       │                              │
│  │                                     │                              │
│  │  No network sandbox                 │                              │
│  │  Outbound HTTP → direct to internet │                              │
│  └─────────────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Process Inventory

| Process | Binary | Spawner | Lifetime | Notes |
|---------|--------|---------|----------|-------|
| **Tauri app** | `nteract` (Tauri desktop) | User / OS login item | Until window closed | Hosts WebView + Tauri relay |
| **runtimed daemon** | `runtimed` | launchd (macOS) / systemd (Linux) / Startup folder (Windows) | Persistent per-user login session | Single instance, locked via `daemon.lock` |
| **runtime-agent** | `runtimed runtime-agent` (same binary, subcommand) | Daemon, one per open notebook | Notebook room lifetime (evicted 30s after all peers disconnect) | Own process group; re-exec of daemon binary |
| **Python/Deno kernel** | `python -m ipykernel_launcher` or `deno jupyter` | runtime-agent via `JupyterKernel::launch()` | Notebook room lifetime | Killed via `killpg` on runtime-agent drop |
| **runt-mcp-proxy** | `nteract-mcp` / `runt-mcp-proxy` | MCP client (Claude, etc.) or app | Session lifetime | Resilient proxy for `runt mcp`; not involved in kernel networking |

**Daemon singleton:** `~/.cache/runt[-nightly]/daemon.lock` (via `flock`). One daemon per UID per channel (stable/nightly/worktree).

---

## 3. IPC / Communication Matrix

### 3a. Frontend ↔ Daemon

**Transport:** Unix domain socket at `~/.cache/<namespace>/runtimed.sock` (mode `0600`).

**Framing:**
```
5-byte preamble: 0xC0DE01AC + protocol_version_byte
then length-prefixed frames:
  [4-byte big-endian u32 length][1-byte type][N-byte payload]
```

**Frame types (steady-state):**

| Frame | Byte | Direction | Payload |
|-------|------|-----------|---------|
| AutomergeSync | `0x00` | bidirectional | Raw Automerge binary (NotebookDoc) |
| NotebookRequest | `0x01` | frontend → daemon | JSON |
| NotebookResponse | `0x02` | daemon → frontend | JSON |
| NotebookBroadcast | `0x03` | daemon → frontend | JSON |
| Presence | `0x04` | bidirectional | CBOR |
| RuntimeStateSync | `0x05` | bidirectional | Automerge binary (RuntimeStateDoc) |
| PoolStateSync | `0x06` | bidirectional | Automerge binary (PoolDoc) |
| SessionControl | `0x07` | daemon → frontend | JSON |
| PutBlob | `0x08` | frontend → daemon | Binary (framed blob upload) |
| CommsDocSync | `0x09` | bidirectional | Automerge binary (CommsDoc) |

**Actual relay path:**
```
WebView JS → Tauri invoke() → Tauri relay (crates/notebook/src/lib.rs)
           → transparent byte pipe → Unix socket → daemon
```
The Tauri relay holds **no document state** — it is a pure byte pipe.

**Connection handshake:**
```json
{ "channel": "notebook_sync", "notebook_id": "...", "protocol": "v4" }
```
Daemon responds with `NotebookConnectionInfo`, then Automerge sync begins.

**Settings** sync over the same socket with a `SettingsSync` handshake channel (length-prefixed JSON, no typed-frame enum).

**Blob HTTP server:** Separate from the socket. Daemon binds `127.0.0.1:<dynamic-port>` (tries a preferred stable port first, falls back to OS-assigned). Frontend uses `host.blobs.port()` to get the port. Serves `GET /blob/{sha256-hash}` with `Cache-Control: immutable`. Read-only, content-addressed.

### 3b. Daemon ↔ Runtime-Agent

**Transport:** **Same Unix socket**, different handshake channel:
```json
{ "channel": "runtime_agent", "notebook_id": "...", "runtime_agent_id": "..." }
```

The runtime-agent subprocess connects back to the daemon like any other peer. It runs the same typed-frame protocol but uses `RuntimeAgentRequestEnvelope` / `RuntimeAgentResponseEnvelope` inside frames `0x01`/`0x02`.

**Lifecycle RPCs** (daemon → runtime-agent):
- `LaunchKernel` — start a kernel with env config
- `RestartKernel` — restart running kernel
- `ShutdownKernel` — stop kernel
- `InterruptExecution` — SIGINT kernel
- `SyncEnvironment` — hot-install packages
- `Complete`, `GetHistory` — query-style operations
- `SendComm` — widget comm messages

**Execution is CRDT-driven**, not RPC-driven: the daemon coordinator writes execution entries (source + seq number) into `RuntimeStateDoc`; the runtime-agent discovers them via `0x05` (RuntimeStateSync) frames and executes in order. This means the execution source of truth is always the synced document.

### 3c. Runtime-Agent ↔ Kernel

**Transport: ZeroMQ** (Jupyter wire protocol).

On **Unix** (non-Deno): IPC transport — kernel and runtime-agent share **Unix domain socket files** in `~/.cache/<ns>/ipc-sockets/`. The connection file specifies `"transport": "ipc"` and a path prefix; the 5 Jupyter channels (shell, iopub, stdin, control, hb) become `{prefix}-{1..5}`.

On **Windows** or **Deno**: TCP transport — `127.0.0.1`, daemon pre-binds 5 random ports, writes connection file, then releases listeners before kernel spawn.

**Connection file:** Written by daemon to `~/.cache/<ns>/connections/{kernel-id}.json`. Contains transport, ip/path, 5 port numbers (or IPC path prefix), HMAC key, signature scheme. The kernel process reads this file on startup.

**5 ZMQ channels per kernel:**
- **Shell** (DEALER/ROUTER): execution requests, completion, history
- **IOPub** (SUB): kernel → runtime-agent output stream (stdout, display_data, execution status, etc.)
- **Stdin** (ROUTER/DEALER): kernel input prompts
- **Control** (DEALER/ROUTER): interrupt/shutdown (separate from shell to avoid head-of-line blocking)
- **Heartbeat** (REQ/REP): liveness check

The runtime-agent owns all 5 ZMQ connections. The kernel process **never** talks to the daemon directly.

---

## 4. Kernel Lifecycle

### 4a. Spawn sequence

1. **User opens notebook** → Tauri relay sends `OpenNotebook` handshake to daemon.
2. **Daemon detects runtime** (kernelspec → Python or Deno).
3. **Daemon resolves environment** (walk-up project file → notebook inline deps → pool).
4. **Trust check** — if notebook has dependencies not in `trusted-packages.sqlite`, blocks with `NeedsTrustApproval`.
5. **Daemon spawns runtime-agent** subprocess (`runtimed runtime-agent --notebook-id ... --socket ...`).
6. **Runtime-agent connects** back to daemon socket as a `RuntimeAgent` peer.
7. **Coordinator → runtime-agent**: `LaunchKernel` RPC with `LaunchedEnvConfig` (env type, venv path, python path, prewarmed packages, feature flags, env_vars).
8. **Runtime-agent calls `JupyterKernel::launch()`**:
   - Builds kernel command (see §4b)
   - Writes connection file
   - `tokio::process::Command::spawn()`
   - Waits up to 3s for early exit
   - Opens 5 ZMQ connections (waits for IPC socket files on Unix)
   - Starts background tasks: IOPub listener, shell reader, heartbeat, process watcher, stderr drain
9. **Kernel sends `kernel_info_reply`** → runtime-agent writes `RuntimeLifecycle::Running` to RuntimeStateDoc → synced to daemon → synced to frontend → UI shows "running".

### 4b. Kernel command examples

**uv:inline (most common):**
```
{python_path} -Xfrozen_modules=off -m ipykernel_launcher -f {connection_file}
env: VIRTUAL_ENV={venv_path}, PATH={uv_dir}:{inherited}
cwd: notebook directory (or ~/Documents for untitled)
```

**uv:pyproject:**
```
{uv_path} run --project {project_dir} python -Xfrozen_modules=off -m ipykernel_launcher -f {connection_file}
cwd: project directory
```

**conda:inline:**
```
{python_path} -Xfrozen_modules=off -m ipykernel_launcher -f {connection_file}
env: (no VIRTUAL_ENV; relies on sys.prefix being correct)
```

**pixi:toml (via shell-hook):**
```
{pixi_conda_prefix}/bin/python -Xfrozen_modules=off -m ipykernel_launcher -f {connection_file}
env: pixi shell-hook output (CONDA_PREFIX, etc.)
cwd: pixi manifest directory
```

**deno:**
```
{deno_path} jupyter --kernel --conn {connection_file}
```

**bootstrap_dx variant** (when `nteract_kernel_launcher` feature is on):  
Replaces `ipykernel_launcher` with `nteract_kernel_launcher` and injects `PYTHONPATH={launcher_cache_dir}`.

### 4c. Environment variables set on kernel process

The kernel process inherits from the runtime-agent process (which is the daemon), filtered and augmented:

**Always set:**
- `COLUMNS`, `LINES` — terminal size constants (80×24)
- `NTERACT_REDACT_ENV_VALUES_IN_OUTPUTS` — 0 or 1

**Set per env-type:**
- `VIRTUAL_ENV` — for uv:inline, uv:prewarmed
- `PATH` — prepend uv install dir for uv envs; pixi shell-hook entries for pixi
- `CONDA_PREFIX` — for conda:env_yml
- `PYTHONPATH` — injected launcher cache dir for bootstrap_dx

**Shell overlay** (when `import_shell_environment` setting is on, default):
- The daemon captures the user's login shell env at startup (`$SHELL -l -c "env -0"`)
- Non-activation variables are merged into kernel env
- **Filtered out** from overlay (not passed to kernel): `PYTHONPATH`, `PYTHONHOME`, `VIRTUAL_ENV`, `CONDA_*`, `PIXI_*`, `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `PWD`, `OLDPWD`, `UV`, `UV_RUN_RECURSION_DEPTH`
- **Explicitly removed** ("secret scrub"): `RUNT_CLOUD_TOKEN`, `NTERACT_API_KEY`, `NOTEBOOK_CLOUD_PUBLISH_BEARER_TOKEN`
- Everything else from the shell env flows to the kernel (e.g. `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `AWS_*`, `MPLBACKEND`)

**No proxy variables are set by nteract.** If the user's shell env contains `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, those will flow through the shell overlay to the kernel (since they are not in the denylist). If not set in the shell env, the kernel gets none.

---

## 5. Python Kernel Outbound Networking

When a Python kernel executes `requests.get("https://example.com")`:

1. `requests` calls `urllib3` → Python `http.client` → OS socket APIs.
2. No proxy middleware is injected by nteract.
3. The OS network stack handles the connection directly.
4. **Result: direct TCP connection to the internet from the kernel process.**

**Environment variable proxy inspection:**
- Standard tools (`requests`, `httpx`, `aiohttp`, `urllib`) honor `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` if present in the kernel's environment.
- nteract does **not** set these variables.
- If the user's shell sets these (e.g. corporate proxy, `nono.sh`), they will flow through the shell overlay to the kernel.
- Otherwise: completely unmediated.

**`uv` package manager networking (install-time, not kernel):**
- `uv` runs at env creation / `SyncEnvironment` time, not inside the kernel.
- `uv` honors `UV_CACHE_DIR`, `UV_PYTHON_INSTALL_DIR`, and standard proxy vars.
- `UV_FROZEN=true` / `PIXI_FROZEN=true` can be set to force offline mode (no network calls during install).

---

## 6. Trust Model

| Boundary | Trust level | Mechanism |
|----------|------------|-----------|
| Daemon ↔ Frontend/MCP | Same-UID trusted | Unix socket mode `0600`; any process with the socket path and matching UID can connect |
| Daemon ↔ Runtime-agent | Same-UID trusted | Same socket; `RuntimeAgent` handshake is a powerful attach operation |
| Kernel ↔ Runtime-agent | IPC transport | Kernel reads connection file with HMAC key; all messages are HMAC-signed |
| Kernel outbound network | **Untrusted / unmediated** | No sandbox, no proxy, no namespace |
| Dependency install trust | User-approved allowlist | SQLite `trusted-packages.sqlite` per machine; fail-closed on store unavailability |
| Blob HTTP server | Read-only, localhost | Binds `127.0.0.1` only; content-addressed; no auth |

**The OS account is the security boundary.** Same-UID processes that discover `RUNTIMED_SOCKET_PATH` get full daemon access. The capability is by intent (for MCP agents, Python bindings, etc.) but should be treated as a bearer token.

---

## 7. Existing Proxy / Intercept Code

**None for kernel network traffic.** Searching for `HTTP_PROXY`, `HTTPS_PROXY`, `proxy`, `mitm`, `intercept` in Rust and TypeScript sources yields:

- `runt-mcp-proxy/` — MCP protocol proxy (wraps `runt mcp` child process for resilient restart). Entirely unrelated to HTTP/network proxying.
- `blob-resolver.ts` comment: "through the host, including any auth/proxy policy" — this is a placeholder comment in the `BlobResolver` interface; no HTTP proxy is actually implemented.
- Widget-related "proxy" references — `AFMModelProxy`, `comm-bridge-manager.ts` — JavaScript object proxies, not network proxies.
- `iframe_shell/` — Tauri window for running shell commands, not network-related.

**No HTTP proxy, MITM, or network interception exists in the nteract codebase for kernel traffic.**

---

## 8. Where a Proxy (e.g. nono.sh) Could Be Inserted

The minimal-invasiveness insertion point depends on the goal:

### Option A: Shell environment variable (zero code change)

If the user configures their login shell with:
```bash
export HTTPS_PROXY=http://localhost:8080
export HTTP_PROXY=http://localhost:8080
export NO_PROXY=localhost,127.0.0.1
```
...then nteract's shell overlay captures these at daemon startup and injects them into every kernel's environment. `requests`, `httpx`, `aiohttp`, `urllib` all honor these variables natively.

**Pros:** No code change. Works immediately.  
**Cons:** Applies to all kernels, not per-notebook. Requires user to set shell vars before starting daemon. Daemon must be restarted to pick up changes (shell overlay is captured once at startup).

### Option B: Daemon settings → kernel env injection (small code change)

Add a `proxy_url` field to daemon settings. When present, inject `HTTPS_PROXY` / `HTTP_PROXY` into the `env_vars` map at kernel launch time (`requests/launch_kernel.rs:overlay_env_vars()` or `shell_env_overlay.rs:build_kernel_env_vars()`).

**Insertion point:** `crates/runtimed/src/requests/launch_kernel.rs` ~line 1692 or `crates/runtimed/src/notebook_sync_server/metadata.rs` ~line 4132 — where `launch_env_vars` is built before the `LaunchKernel` RPC.

**Pros:** Per-session configurable via settings. No shell restart needed.  
**Cons:** Requires daemon code change + settings schema change.

### Option C: Kernel launcher injection (per-kernel code change)

In `jupyter_kernel.rs::launch()`, after building `cmd` and before `cmd.spawn()`, insert:
```rust
if let Some(proxy) = &config.proxy_url {
    cmd.env("HTTPS_PROXY", proxy);
    cmd.env("HTTP_PROXY", proxy);
}
```

**Pros:** Minimal, surgical change. Easy to gate with a feature flag.  
**Cons:** Requires plumbing `proxy_url` through `KernelLaunchConfig` → `LaunchKernel` RPC → runtime-agent.

### Option D: nteract_kernel_launcher bootstrap_dx (most powerful)

The `nteract_kernel_launcher` Python module (injected via `PYTHONPATH` when `bootstrap_dx` is on) runs before `ipykernel_launcher`. It can:
- Patch `sys.path`
- Install a custom `requests` session with proxy
- Register import hooks

**Pros:** Python-level control; can do selective proxying, certificate pinning, traffic logging.  
**Cons:** Requires changes to the launcher Python package. Only applies when `bootstrap_dx` feature is enabled.

### Option E: Process-level network namespace (most invasive, Linux only)

Use Linux network namespaces or `unshare(1)` to isolate the kernel process's network stack, then route through a proxy inside the namespace.

**Pros:** Hard sandbox; kernel cannot bypass proxy.  
**Cons:** Linux only. Requires significant infra. Not feasible on macOS without kernel extensions.

---

## 9. Key File Reference

| File | What it does |
|------|-------------|
| `crates/runtimed/src/jupyter_kernel.rs` | Kernel process spawn, ZMQ connections, IOPub routing, env var assembly |
| `crates/runtimed/src/shell_env_overlay.rs` | Shell env capture at daemon startup; `build_kernel_env_vars()` |
| `crates/runtimed/src/runtime_agent.rs` | Runtime-agent main loop; handles kernel lifecycle RPCs |
| `crates/runtimed/src/runtime_agent_handle.rs` | Coordinator-side: spawns `runtimed runtime-agent`, SIGKILL on drop |
| `crates/runtimed/src/requests/launch_kernel.rs` | Coordinator request handler for `LaunchKernel`; builds `env_vars` |
| `crates/runtimed/src/notebook_sync_server/metadata.rs` | Auto-launch on notebook open; builds env_vars for auto-launch |
| `crates/runtimed/src/daemon.rs` | Daemon state, pool management, Unix socket listener |
| `crates/runtimed/src/kernel_connection.rs` | `KernelLaunchConfig` struct (env_vars field) |
| `crates/notebook-wire/AGENTS.md` | Wire protocol specification |
| `crates/kernel-env/AGENTS.md` | Environment resolution, trust, pool |
| `crates/runtimed/src/blob_server.rs` | HTTP blob server (hyper 1.x, localhost only) |
| `crates/notebook/src/lib.rs` | Tauri relay (transparent byte pipe) |

---

## 10. Open Questions

1. **`nteract_kernel_launcher` status**: The `bootstrap_dx` flag gates use of `nteract_kernel_launcher` instead of `ipykernel_launcher`. Is this feature enabled by default in production? If so, the launcher's Python code is the ideal injection site for nono.sh proxy logic.

2. **Shell overlay timing**: The shell overlay is captured once at daemon startup. Does restarting the daemon (e.g. `runt daemon stop && runt daemon start`) re-capture the shell env? This affects whether Option A (shell env vars) is usable without a full session restart.

3. **`import_shell_environment` default**: The setting defaults to enabled. Is there a user-facing toggle in the UI? If users can disable it, proxy injection via shell vars (Option A) is fragile.

4. **Cloud rooms**: `run_cloud_runtime_agent()` exists for a cloud-hosted room scenario where the runtime-agent connects over WebSocket to a cloud room. Are proxy env vars plumbed through for cloud kernels? The `env_vars` field in `RuntimeAgentRequest::LaunchKernel` is present but the cloud launch path (`launch_on_attach.rs`) would need explicit handling.

5. **Windows named pipe transport**: On Windows the daemon socket is a named pipe, not a Unix socket. The IPC model for kernel↔agent is TCP, not Unix IPC sockets. Proxy insertion via `HTTPS_PROXY` env var still works on Windows since it's an OS-level convention.

6. **Certificate trust for MITM proxies**: nono.sh or any MITM proxy requires installing a CA certificate that Python's `certifi` or the OS trust store trusts. None of this is managed by nteract — the user must install the cert separately (or set `REQUESTS_CA_BUNDLE` in their shell env, which would flow through the overlay).
