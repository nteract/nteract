# Workstation endpoint on the daemon (#16, second half)

**Status:** Draft / scoping, 2026-06-06. Branch `quod/16-workstation-endpoint`.

This is the second half of #16. The first half — making `runtime_agent`
transport-agnostic, with `run_cloud_runtime_agent` as the cloud-attach path — is
merged (#3426, Phases 1–3f). This half builds the **workstation endpoint**: the
daemon capability + small control surface that *lists the environments it has*
and, on demand, *allocates and starts a runtime in env X for room Y*, driving
`run_cloud_runtime_agent` as the attach mechanism.

Read first: `docs/adr/remote-workstation-doc-agents.md` ("Production shape"),
`docs/handoffs/16-decisions-log.md`, `docs/handoffs/16-lifecycle-analysis.md`.

## The shape the ADR asks for

> A workstation is an endpoint you pick compute from: it *lists the environments
> it has* and, on demand, *allocates and starts a runtime in env X for room Y*.
> That is a daemon capability plus a small control surface (the "receiver"),
> built on the existing env pool + launcher, not a reimplementation.
> `run_cloud_runtime_agent` is the attach mechanism the endpoint drives.

So the endpoint has two operations:

1. **list-environments** — what compute this daemon can offer.
2. **allocate-runtime-for-room** — pick env X, attach a runtime to cloud room Y.

Both must reuse, not reimplement, the existing env pool and launcher.

## Existing machinery this builds on (file:line)

### Env pool + environment listing

- `runtimed_client::PooledEnv` / `EnvType` (`crates/runtimed-client/src/lib.rs:92,112`)
  — the in-memory "an environment" representation (`Uv|Conda|Pixi`, venv path,
  python path, prewarmed packages).
- `Daemon` holds `uv_pool` / `conda_pool` / `pixi_pool: Mutex<Pool>`
  (`crates/runtimed/src/daemon.rs:1097-1099`) and a daemon-authoritative
  `pool_doc: Arc<RwLock<PoolDoc>>` (`:1110`).
- `PoolState` / `RuntimePoolState` (`crates/notebook-doc/src/pool_state.rs:42,67`)
  — per-kind snapshot (available/warming/pool_size/health), read via
  `PoolDoc::read_state()` (`:248`). This is the **already-published** "what
  environments are ready" surface, synced to peers over `PoolStateSync` (0x06).
- `Daemon::update_pool_doc` (`crates/runtimed/src/daemon.rs:5423`) recomputes it
  from each pool's `stats()`.
- Cached/captured envs on disk: enumerated by `runt env list`
  (`crates/runt/src/main.rs:4126`) over `get_env_cache_dirs()` (`:4044`) — UV,
  Conda, Pixi, inline-envs, tools. Captured-env metadata helpers live in
  `crates/runtimed/src/notebook_sync_server/metadata.rs:1594+`
  (`captured_env_for_runtime`, `captured_env_disk_state`).

**Reuse:** list-environments is a *projection* over `PoolDoc::read_state()` (the
prewarmed pools, with health) plus optionally the cache-dir enumeration (named
captured/inline envs). No new pool, no new disk walk semantics.

### The launcher / env resolution

- Entry: `requests/launch_kernel.rs::handle` (`crates/runtimed/src/requests/launch_kernel.rs:43`).
  Resolves kernel type + `env_source` (auto-detect project files → captured env →
  inline deps → PEP 723 → prewarmed pool), acquires/builds the env, then assembles
  a `LaunchedEnvConfig` (`build_launched_config`, around `:1487`) and spawns the
  agent.
- Pool acquisition: `Daemon::take_uv_env` / `take_conda_env`
  (`crates/runtimed/src/daemon.rs:3397,3488`) → `(PooledEnv, PoolLeaseGuard)`.
- Agent subprocess spawn: `RuntimeAgentHandle::spawn`
  (`crates/runtimed/src/runtime_agent_handle.rs:44`) execs
  `runtimed runtime-agent --notebook-id … --runtime-agent-id … --blob-root … --socket …`
  in its own process group, with orphan-reaping manifest.
- The agent then receives `RuntimeAgentRequest::LaunchKernel { kernel_type,
  env_source, launched_config, env_vars }` over its transport
  (`runtime_agent.rs:1082`) and launches the kernel via `KernelLaunchConfig`.

**Reuse:** "allocate a runtime in env X" is the same env-resolution +
`LaunchedEnvConfig` assembly, but the *transport* the agent attaches over is the
cloud WS (`run_cloud_runtime_agent`), not the daemon UDS.

### The cloud attach path

- `run_cloud_runtime_agent(config: CloudWsConfig, operator: String, blob_root)`
  (`crates/runtimed/src/runtime_agent.rs:150`). Builds a
  `notebook_cloud_transport::CloudWsFrameTransport` and funnels into the shared
  `run_runtime_agent_on_transport`. Resolves the doc-actor label *after* connect
  from `transport.principal()` (the room's `cloud_room_ready` principal).
- `CloudWsConfig { cloud_url, notebook_id, scope, auth: CloudAuth }`
  (`crates/notebook-cloud-transport/src/lib.rs:127`). `CloudAuth` =
  `OidcBearer | AnacondaApiKey | Dev { token, user }` (`:78`). Optional
  `TokenRefresher` for long-lived re-auth (`:117`).
- **It has no non-test caller today** (decision 31, deferred-3c): nothing on a
  CLI/daemon path invokes it. That is the first gap to close.

### Daemon control surfaces (where a new endpoint fits)

- Notebook RPC: `NotebookRequest` enum
  (`crates/notebook-protocol/src/protocol.rs:474`), dispatched in
  `requests/mod.rs::handle_notebook_request` (`crates/runtimed/src/requests/mod.rs:156`),
  per-request handler modules under `requests/`.
- Kernel RPC: `RuntimeAgentRequest` (`protocol.rs:822`).
- CLI: `runtimed` subcommands in `crates/runtimed/src/main.rs:50` (incl. the
  hidden internal `runtime-agent` at `:126`); `runt` subcommands in
  `crates/runt/src/main.rs:90`.
- Frame types incl. `SessionControl` (0x07) in `crates/notebook-wire/src/lib.rs`.

## The crux that bounds headless scope

The cloud agent attaches as a `runtime_peer` and then **waits for an inbound
`RuntimeAgentRequest::LaunchKernel`** to actually start a kernel
(`runtime_agent.rs:1082`). Over the daemon UDS that frame comes from the daemon.
Over the **cloud** transport it must come from the room — and that inbound
request channel is **req #5, Deferred** (it needs the 3d DurableObject hosted
REQUEST dispatch + a live room; decision 34). So a cloud agent spawned today
*attaches but is never told to launch a kernel*.

Two ways to make the endpoint genuinely *start* a runtime in env X:

- **(A) launch-on-attach.** The endpoint resolves env X up front (reusing the
  launcher) and hands the agent an *initial* `KernelLaunchConfig` it applies
  right after bootstrap, instead of waiting for an RPC. This makes
  "allocate and start in env X" real over the cloud transport **without** req #5,
  and it is headless-testable (config assembly + the apply-on-bootstrap branch).
- **(B) wait for req #5.** Endpoint only *attaches*; the launch trigger arrives
  later over the (not-yet-built) inbound channel.

**Decision (see log, decision 38):** design for (A) as the endpoint's
"start a runtime" semantics — the ADR says *allocate **and start***, and (A) is
the only way to honor "start" headlessly while req #5 is deferred. But land it as
a clearly-separated, gated, well-tested commit *after* the two lower-risk pieces
(CLI wiring + list-environments), because it touches the load-bearing agent loop.
Until (A) lands, the CLI subcommand attaches only (kernel launch deferred), which
is still the missing invocable caller `run_cloud_runtime_agent` needs.

## Proposed surface

A new daemon module `crates/runtimed/src/workstation/` (sibling to `requests/`),
plus one CLI subcommand. Kept additive and gated; the desktop/UDS path is
untouched.

### 1. `list_environments` (headless-buildable, unit-testable)

```rust
/// One environment a workstation can offer compute from.
pub struct WorkstationEnvironment {
    pub id: String,                 // stable selector, e.g. "pool:uv", "captured:<hash>"
    pub kind: EnvKind,              // Uv | Conda | Pixi
    pub source: EnvironmentSource,  // Prewarmed { available, warming } | Captured { path, .. }
    pub environment_policy: EnvironmentPolicy, // current_python | kernelspec | managed_project | unknown
    pub health: Option<String>,     // from RuntimePoolState.error / error_kind
}

pub fn list_environments(daemon: &Daemon) -> Vec<WorkstationEnvironment>;
```

- Prewarmed entries come straight from `daemon.pool_doc.read().read_state()`
  (`PoolState` → one `WorkstationEnvironment` per non-empty kind, carrying
  `available`/`warming`/health).
- Captured/inline entries (optional, second commit) project the cache-dir
  enumeration. Kept behind the same shape so it can later back both the
  workstation-target API and the Content-rail catalog (ADR decision 8).
- Pure read; no mutation; trivially unit-testable with a seeded `PoolDoc`.

### 2. CLI: `runtimed cloud-runtime-agent` (headless-buildable, unit-testable)

The invocable caller `run_cloud_runtime_agent` is missing (decision 31). Add a
hidden/internal subcommand mirroring `runtime-agent`:

```
runtimed cloud-runtime-agent \
  --cloud-url https://preview.runt.run \
  --notebook-id <id> \
  --scope runtime_peer \
  --operator agent:runt \
  --blob-root <path>
# auth from env: RUNT_CLOUD_TOKEN (+ RUNT_CLOUD_AUTH_KIND = oidc|anaconda-key|dev,
#   RUNT_CLOUD_DEV_USER for dev) — never on argv (ADR security constraint).
```

It builds `CloudWsConfig` + `CloudAuth` from flags/env and calls
`run_cloud_runtime_agent`. The arg→config mapping (incl. auth-kind selection and
the "token never on argv" rule) is pure and unit-tested. This is the concrete
"receiver" entry an external control plane (or the deferred live proof) drives.

### 3. `allocate_runtime_for_room` (env-selection + spawn wiring)

```rust
pub struct RoomTarget { pub cloud_url: String, pub notebook_id: String,
                        pub scope: String, pub operator: String }

/// Resolve env `env_id` via the existing launcher, then attach a cloud runtime
/// to room Y. With launch-on-attach (commit C) it also starts the kernel in
/// that env; without it, it attaches only (launch deferred to req #5).
pub async fn allocate_runtime_for_room(
    daemon: &Arc<Daemon>, env_id: &str, target: RoomTarget, auth: CloudAuth,
) -> Result<...>;
```

Env resolution reuses the `launch_kernel` env path (extract the
`env_source → LaunchedEnvConfig` step; do not duplicate pool acquisition). The
spawn reuses `run_cloud_runtime_agent`. Behind the transport gate.

## Headless-buildable vs Deferred

**Headless-buildable now (Phase B):**

- `list_environments` + `WorkstationEnvironment` (pool projection). Unit-tested.
- `runtimed cloud-runtime-agent` CLI: arg/env → `CloudWsConfig`/`CloudAuth`.
  Unit-tested. Makes `run_cloud_runtime_agent` invocable.
- launch-on-attach (commit C): the agent applies an initial `KernelLaunchConfig`
  after bootstrap on a recoverable transport. Unit-tested; gated; UDS unchanged.
- `allocate_runtime_for_room`: env selection + spawn wiring. Unit-tested with a
  seeded daemon/pool; the *attach itself* is not exercised (no live room).

**Deferred — needs us (live verification / infra we do not have):**

- **Live attach re-proof.** Spawn `runtimed cloud-runtime-agent` against a real
  preview room with the explicit `runtime_peer` ACL row (decision 9), confirm a
  cloud-submitted (or launch-on-attach) cell runs on the daemon-managed kernel and
  renders in the viewer. Requires staging creds + a deployed worker. **Do not
  attempt headlessly.** Exact steps to run: (1) deploy/choose a preview room;
  (2) `POST /api/n/:id/acl {subject_kind:"principal", subject:<principal>,
  scope:"runtime_peer"}`; (3) `RUNT_CLOUD_TOKEN=… runtimed cloud-runtime-agent
  --cloud-url … --notebook-id … --scope runtime_peer --operator agent:runt`;
  (4) run a cell, confirm output in the viewer; (5) exercise the 3b
  token-refresher against an expiring token.
- **req #5 inbound request channel** (interrupt/restart/launch over cloud) —
  needs the 3d worker + live room. If launch-on-attach (A) lands, the *first*
  launch no longer needs req #5, but interrupt/restart still do.
- **The doc-agent control channel** (`WS /api/workstations/:id/control`), the
  hosted **workstation registry** (D1 tables, `POST /api/workstations/register`),
  and **room target selection** (`/api/n/:id/workstation-target*`) — these are
  Worker/hosted-side build items (ADR implementation sequence steps 3–9), not
  daemon-side, and out of scope for this headless slice.

## Test plan (headless)

- `list_environments`: seed a `PoolDoc` with known uv/conda/pixi state → assert
  the projected `WorkstationEnvironment` list (counts, kinds, health passthrough,
  empty-kind omission).
- CLI config: each auth-kind flag/env combo → expected `CloudAuth` variant;
  missing token → error; token never appears in the built argv.
- launch-on-attach: the apply-on-bootstrap branch fires only on a recoverable
  transport and is a no-op on UDS (mirror the decision-22 gate); unit-test the
  discriminant + that the UDS path is byte-for-byte unchanged.
- Full `cargo test -p runtimed` stays green (UDS path unchanged); clippy `-D
  warnings`; `cargo xtask lint --fix`.

## PR stacking

One branch + draft PR per coherent chunk, each with a STATUS section:

1. `cloud-runtime-agent` CLI + arg/config tests (closes the missing-caller gap).
2. `list_environments` + `WorkstationEnvironment`.
3. launch-on-attach in the agent loop (gated, tested).
4. `allocate_runtime_for_room` glue.

Stacked on `main`. Keep the decision log + each STATUS current.
