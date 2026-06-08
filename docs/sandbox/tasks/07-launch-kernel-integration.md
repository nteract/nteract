# Task 07: Wire sandbox into kernel launch

## Framing

The kernel launch path currently spawns a Python kernel directly. This task adds an opt-in branch: when the notebook's `metadata.runt.sandbox` is present and enabled, route the launch through `nono::Supervisor` (task 04), translating the profile via task 05. The default path (no profile) is unchanged.

Depends on tasks 04 and 05. Blocks task 08 and task 12.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-3 (opt-in)**, **D-4 (process tree)**, **D-6 (profile location)**, **D-13 (always -vv)**
- `docs/sandbox/nteract-network-architecture.md` — sections on kernel launch, runtime-agent, the `bootstrap_dx` / `nteract_kernel_launcher` switch
- `docs/sandbox/error-routing-design.md` — the launch-path decision tree and how SandboxState surfaces

The relevant existing source:
- `crates/runtimed/src/jupyter_kernel.rs` — current spawn function and process watcher
- `crates/runtimed/src/runtime_agent.rs` — runtime-agent lifecycle integration
- `crates/runtimed/src/notebook_sync_server/metadata.rs` — where `RuntMetadata` is read

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

Today the kernel spawn path takes a kernel argv plus env and calls `tokio::process::Command::spawn` (or equivalent through the Jupyter kernel manager). The `process_watcher` task tracks a single PID.

The opt-in flow:

1. At launch time, read the notebook's `SandboxProfile` via task 03's helper
2. If `None` or `enabled = false`, take the existing path (no behavior change)
3. Otherwise:
   a. Translate the profile via `nono::profile::translate(&profile)` → `TranslatedProfile`
   b. Construct `SupervisorConfig` with the kernel argv, the translated profile path, the kernel env (merged with `kernel_env_overrides`)
   c. Call `Supervisor::spawn(...)` to obtain a `SupervisorHandle`
   d. Use the **kernel PID** (from `SupervisorHandle`) for everything that previously used the kernel PID: ZeroMQ socket coordination, kernel state lookup, lifecycle reporting
   e. Use the **nono PID** for graceful shutdown ordering
   f. Hold the `Supervisor` and the `TranslatedProfile` for the kernel session lifetime — dropping `TranslatedProfile` deletes the temp YAML

The kernel argv and environment are otherwise unchanged. `bootstrap_dx` / the nteract Python launcher continues to work — nono is transparent to it.

## Technical steps

### 1. Surface the launch decision

Add a `SandboxState` enum that captures the launch outcome:

```rust
#[derive(Debug, Clone)]
pub enum SandboxState {
    /// No sandbox profile configured for this notebook
    Disabled,
    /// Sandbox launched and proxy is healthy
    Active {
        nono_pid: u32,
        kernel_pid: u32,
        session_id: Option<String>, // populated once the stdout DEBUG line lands
    },
    /// Sandbox failed to start (preferred over a silent fallback)
    StartupFailed {
        reason: String,
        stderr_capture: Vec<String>,
    },
    /// Sandbox started but later degraded (proxy died mid-session)
    Degraded { reason: String },
}
```

Surface this through whatever struct represents an active runtime in the daemon (kernel state, runtime-agent state, etc.). It should be reachable from MCP tools (task 09) and from the frontend via Automerge state — but **how** the surface gets there is a downstream concern; this task just needs to make the data available to whatever in-memory tracking already exists.

### 2. Branching the launch path

In `jupyter_kernel.rs`, factor out the existing spawn into a `spawn_direct(...)` helper. Add a parallel `spawn_with_sandbox(...)` that:

- Calls `nono::profile::translate(&profile)`
- Builds `SupervisorConfig` with merged env (`existing_env` then `translated.kernel_env_overrides`)
- Calls `Supervisor::spawn(nono_binary, config)`
- Awaits the kernel PID becoming non-zero (the supervisor handles this discovery)
- Returns a uniform handle that the rest of the launch flow can use

A common return type unifies both paths so downstream code (ZeroMQ wiring, process_watcher) does not branch on sandbox presence after this point.

### 3. Process watcher updates

The existing process_watcher tracks one PID. For sandboxed kernels, **two** must be watched:

- Kernel PID: the existing semantics (used for liveness, exit code reporting)
- nono PID: if it exits unexpectedly while kernel is alive, mark the runtime as `SandboxState::Degraded` and reuse the existing kernel-died flow to terminate the orphaned kernel

Reuse `Supervisor`'s internal watcher rather than recreating logic. The launcher can subscribe to `SupervisorHandle::exit` (oneshot from task 04) and react accordingly.

### 4. Shutdown ordering

When the daemon initiates kernel shutdown (user clicks shutdown, or notebook closes):

- For non-sandboxed kernels: existing path
- For sandboxed kernels: call `Supervisor::shutdown(grace)` from task 04, which already implements the kernel-first-then-nono ordering

Avoid duplicating the signaling logic here. The Supervisor owns it.

### 5. Failure modes

Define explicit behavior for each:

- **Sandbox profile present but `nono::binary_path()` returns `NonoUnavailable`**: do **not** silently fall back to direct launch. Emit a typed error (`SandboxLaunchError::NonoUnavailable`) and refuse to launch. The user explicitly opted in; falling back would be a security regression.
- **Profile validation fails**: refuse to launch with `SandboxLaunchError::InvalidProfile(errors)`.
- **`Supervisor::spawn` returns `StartupFailure` immediately**: refuse to launch with `SandboxLaunchError::SandboxStartFailed { stderr }`.
- **Profile is present but `enabled = false`**: take the direct path silently (this is how a user temporarily disables sandbox without removing the profile).

Surface these as user-actionable errors in whatever way the existing launch error path does (the same channel that surfaces "kernel binary not found", etc.).

### 6. Event stream wiring

Task 06 produces an `EventStream` from the supervisor's stdout/stderr. This task is responsible for **constructing** that EventStream and handing it to a downstream consumer (task 08 will be that consumer). For now, store the stream in the runtime's session state where task 08 can pick it up — do not consume the events in this task.

In other words, the wiring this task adds is:

```text
metadata.runt.sandbox -> SandboxProfile
                      -> translate() -> TranslatedProfile
                      -> Supervisor::spawn()
                      -> SupervisorHandle (PIDs, drains)
                      -> EventCollector::start(...) -> EventStream
                      -> store EventStream in runtime session state
                      -> [task 08 picks up and consumes]
```

### 7. Tests

Integration tests in `crates/runtimed/tests/` (or wherever existing kernel-launch tests live):

- A notebook with no `sandbox` field launches via the existing path; behavior unchanged
- A notebook with `sandbox.enabled = false` launches via the existing path
- A notebook with a valid sandbox profile launches a kernel as a grandchild of nono; both PIDs are tracked
- Shutdown of a sandboxed kernel signals both processes in the right order
- A nono crash mid-session triggers `SandboxState::Degraded` and the kernel is cleaned up
- A profile that references no credentials (only `allowed_domains`) still launches successfully

## Interfaces produced

- `SandboxState` reachable from runtime session state
- A unified launch path in `jupyter_kernel.rs`
- `SandboxLaunchError` types

Consumers: task 08 (reads EventStream + SandboxState; writes annotations), task 09 (reads SandboxState via MCP), task 11 (reads SandboxState via Automerge sync), task 12 (E2E tests).

## Success criteria

- Default-path notebooks (no profile) behave identically to before
- A notebook with a profile launches under nono; ps shows nono as parent of kernel
- Shutdown is clean: both PIDs gone, no orphaned `log stream` helper
- StartupFailed cases surface user-actionable errors instead of silent fallbacks
- `cargo xtask lint --fix` passes
- All existing runtimed tests pass
- New integration tests pass on macOS

## In scope

- Branching the launch path on profile presence
- Constructing `Supervisor` and `EventCollector` instances
- Tracking `SandboxState` in runtime session state
- Shutdown ordering through the Supervisor
- Failure mode handling
- Integration tests

## Out of scope

- Generating profile YAML — task 05 owns translation
- Two-PID signaling implementation details — task 04 owns this
- Parsing nono events into typed values — task 06 owns this
- Consuming events to write `CellAnnotation`s — task 08
- MCP tools — task 09
- UI — tasks 10 and 11
- Settings-level toggles (per **D-3**, sandbox is per-notebook opt-in via metadata; no global toggle)
- Changing `bootstrap_dx` / `nteract_kernel_launcher` behavior — they continue to work transparently under nono
