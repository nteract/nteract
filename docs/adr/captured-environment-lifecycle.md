# Captured Environment Lifecycle

**Status:** Accepted, 2026-05-24. Typed disk state (`Missing`, `Partial`,
`Usable`) and captured repair routing landed. Launch retry, manual rebuild,
and workspace-default refresh remain open follow-ups.

## Related ADRs

- `docs/adr/kernel-env-trust.md`: dependency trust gates whether the daemon may install or launch declared packages. This ADR starts after that gate: identifying, reusing, repairing, and resetting captured environments.
- `docs/adr/execution-pipeline.md`: launch retry must preserve lifecycle ordering around kernel startup and terminal error publication.
- `docs/adr/document-split.md`: `NotebookDoc` carries dependency declarations; `RuntimeStateDoc` carries launch, progress, and error state.

## Context

Captured environments make notebooks self-describing. On first launch from a prewarmed UV or Conda pool, the daemon strips base packages and records dependency intent in `metadata.runt.{uv,conda}`. It then assigns `metadata.runt.env_id` and renames the claimed environment into the unified content-addressed cache. Later launches recompute the unified hash from metadata and `env_id` to reuse the same interpreter.

This gives fast reopen and per-notebook isolation, while placing lifecycle ownership on the daemon. When an on-disk environment is incomplete or fails to launch, users must not edit `metadata.runt.env_id`, compute unified hashes, or delete cache directories by hand.

This ADR defines the shared invariants for two capabilities:

- **Automatic captured-environment repair:** recover incomplete directories and kernel launch-handshake failures without manual intervention.
- **Manual rebuild and dependency-refresh controls:** let users rebuild a captured environment or replace captured dependencies with current workspace defaults.

## Decision 1: Captured identity is metadata intent plus `env_id`

A captured environment's identity is not its cache path. Identity consists of three parts:

1. The runtime family (UV or Conda).
2. The full resolver-affecting dependency intent in notebook metadata.
3. `metadata.runt.env_id`.

Every resolver-affecting field feeds the hash:

- **UV:** `dependencies`, `requires-python`, and `prerelease`.
- **Conda:** `dependencies`, `channels`, `python`, and the conditional GIL-enforcement ABI marker.

`compute_unified_env_hash()` is authoritative for the exact field list. Dropping a resolver field would silently point a notebook at a different cache path after metadata edits.

Cache paths derive from this identity:

```text
hash = hex(sha256(sorted_deps + resolver_fields + env_id))[..16] // 16 hex chars
env_path = backend_cache_dir / hash
```

The path is never authoritative state. Every daemon action that deletes, repairs, or rebuilds a captured environment derives the expected path from the current captured identity and backend cache root.

Automatic repair keeps `env_id` stable, repairing the existing captured identity rather than assigning a new one. Manual rebuilds may later rotate `env_id`, but doing so requires shutting down the active kernel and mutating metadata under a guard.

## Decision 2: Disk state is typed, not boolean

The legacy boolean check (`unified_env_on_disk()` returning a Python path) lost critical state. Captured disk state is a three-state enum:

| State | Meaning | Routing |
|---|---|---|
| `Missing` | Expected unified env dir is absent. | Do not route as captured. Absence can mean GC, cache cleanup, or a fresh inline-dep notebook with no captured env yet. |
| `Partial` | Env dir exists, but expected Python executable is absent. | Route to captured repair. Directory presence proves this notebook once owned the derived hash. |
| `Usable` | Env dir and expected Python executable both exist. | Route as captured cache-hit candidate. |

`Missing` preserves existing fallback behavior. `Partial` means the notebook's captured environment is broken and must rebuild through the captured path.

Source resolution must classify disk state before backend dispatch and route both `Partial` and `Usable` directories to `uv:prewarmed` or `conda:prewarmed`. Detecting `Partial` only inside `acquire_prewarmed_env_with_capture()` is insufficient because partial directories would never reach that layer.

**Landed:** `CapturedEnvDiskState::{Missing, Partial, Usable}` (`crates/runtimed/src/notebook_sync_server/metadata.rs`) and `captured_env_disk_state()` classify disk state per backend. Both `Partial` and `Usable` route as captured cache-hit candidates, and `prepare_environment_unified()` rebuilds partial directories before handoff.

## Decision 3: The happy path stays cheap

Cached launch is the hot path. The daemon must not spawn Python, run `diagnose_ipykernel()`, or execute subprocess probes on every captured cache hit.

Checking Python executable existence is the cheap disk predicate. It catches interrupted installs without subprocess overhead on every reopen. When Python exists but `site-packages` is corrupt, the launch handshake detects the fault and the one-shot retry path (open follow-up) handles repair.

No `.captured-ok` marker is added. The repository already maintains multiple sidecars (`.warmed`, `.last-used`, `.runt-pool-packages.sha256`, Conda `.lock.json`), and another marker would add coherence risk across capture, eviction, dependency sync, rebuild, and manual reset. Existing signals suffice:

- Missing Python executable classifies as `Partial` (landed).
- `prepare_environment_unified()` repairs partial directories (landed).
- Launch handshake failure on a captured env triggers one controlled rebuild and relaunch (open follow-up).

Repair behavior stays backend-specific. UV removes a partial unified env dir before rebuilding; Conda may try a lock-file rebuild before full removal and recreation. The invariant is routing partial captured dirs into the backend's unified-env repair path, not unconditionally deleting first.

## Decision 4: Repair is daemon-owned and scoped

The frontend never deletes cache directories, rotates `env_id`, or rewrites captured dependency metadata directly. It requests lifecycle actions and renders previews; the daemon executes every mutation.

Automatic repair enforces strict scoping:

- `Partial` dirs rebuild through `prepare_environment_unified()` using the backend's partial-dir handling (landed).
- Post-launch failure invalidation runs only after a captured env fails in an infrastructure launch phase (open follow-up).
- Invalidation deletes only the derived unified-hash path under the expected backend cache root.
- The daemon never deletes arbitrary `runtime_agent` paths or caller-supplied paths.

Even though the cache root is user-owned local state, path validation is mandatory. The daemon derives the target path from `CapturedEnv`, never from frontend payloads. It canonicalizes the cache root where practical, compares against the derived hash path, rejects paths outside that root, and ignores arbitrary user-controlled paths.

`env_id` makes captured hashes per notebook, preventing one notebook's repair from deleting another notebook's environment. Any future feature that shares captured envs across notebooks must revisit this ADR.

## Decision 5: Launch retry is one-shot and internal

*Status: Open follow-up.*

Automatic retry recovers infrastructure failures in captured environments, never user-code failures.

The retry runs internally within a single launch request:

1. The launch request passes the normal trust gate.
2. Source resolution selects a captured UV or Conda environment.
3. The daemon resolves a concrete `CapturedEnv` snapshot and launch config.
4. The runtime agent attempts kernel launch.
5. On a retryable infrastructure hint, the coordinator repairs the resolved captured env and launches once more.
6. If the second launch fails, the daemon surfaces the original failure with a note that automatic rebuild was attempted.

Invariants for the retry path:

- **No intermediate `Error` state:** `RuntimeStateDoc` stays in a progressing state until retry succeeds or final failure is known. Publishing an intermediate error would flash `Launching -> Error -> Launching -> Error` in the UI and let a concurrent launch request start a second repair.
- **Frozen dependency snapshot:** Retry uses the originally resolved snapshot and must not re-read mutable `NotebookDoc` metadata between first failure and repair. Concurrent peer edits take effect on a later trust and resolution cycle.
- **Single room claim:** Retry stays inside the launch request's existing room claim. Changing that launch lifecycle gate requires revisiting these concurrency assumptions.

## Decision 6: Launch failure hints cross the runtime-agent boundary

*Status: Open follow-up.*

The runtime agent receives the raw `anyhow::Error` from `JupyterKernel::launch()`, while the coordinator currently receives a formatted string (`Failed to launch kernel: ...`). Retry policy must not parse double-wrapped display strings.

Classification belongs inside `runtime_agent.rs` before formatting the user-facing error. The response to the coordinator carries the original error string plus a structured retry hint. The hint stays internal to the runtime-agent/coordinator protocol and does not become frontend UX.

When the hint type lives in the shared `notebook-protocol` crate, mark it protocol-internal with a doc comment or `#[doc(hidden)]`; it is serialized infrastructure state, not a client-facing contract.

Compatible wire shape:

```rust
RuntimeAgentResponse::Error {
    error: String,
    launch_failure_hint: Option<RuntimeAgentLaunchFailureHint>,
}
```

Non-launch errors omit the hint. A dedicated launch-failure variant is also acceptable if an optional field creates excessive enum-match churn.

Retryable hints cover infrastructure failures only:

- Kernel process exits before `kernel_info_reply`.
- Kernel info request times out.
- Kernel info request send fails.
- Python executable cannot start.
- `ipykernel` is missing.

## Decision 7: Manual controls build on daemon-owned lifecycle primitives

*Status: Open follow-up.*

Manual rebuild and dependency-refresh controls build on the same daemon-owned lifecycle primitives as automatic repair. Do not implement them as frontend metadata edits plus filesystem deletion.

Target request shape:

```rust
ResetNotebookEnvironment {
    strategy: RebuildSame | RefreshDefaults,
    guard: Option<DependencyGuard>,
}
```

- **`RebuildSame`:** keeps declared dependency intent and invalidates/rebuilds only the matching captured env identity. If the API design chooses rotated `env_id` over stable `env_id`, it must shut down the active kernel and mutate `NotebookDoc` under a guard.
- **`RefreshDefaults`:** rewrites dependency metadata using workspace defaults snapshotted by the daemon at apply time (frontend settings can drift while a confirmation dialog is open). Normal trust derivation governs the rewritten declaration; resetting never bypasses the trust model.

Frontend placement uses an "Environment actions" menu or compact secondary row in the dependency panel, shown only for captured UV or Conda notebooks. Copy avoids internal field names and uses "declared dependencies" rather than "saved dependencies" (which is ambiguous between `.ipynb` on disk and live Automerge state):

- **Automatic repair:** "The notebook environment looked broken, so nteract rebuilt it from this notebook's declared dependencies."
- **Manual rebuild:** "Rebuild this notebook's environment from its declared dependencies."
- **Refresh defaults:** "Replace this notebook's declared dependencies with your current workspace defaults."

## Worked Examples

### Partial captured UV dir *(landed)*

1. Notebook metadata declares `metadata.runt.env_id = "abc"` and `metadata.runt.uv.dependencies = ["pandas"]`.
2. The derived unified env dir exists, but `{hash}/bin/python` does not.
3. Disk state is `Partial`.
4. Source resolution routes to the captured repair path, not the pool path.
5. `prepare_environment_unified()` removes the partial dir and rebuilds the same hash.
6. Launch proceeds against the repaired env.

### GC'd captured dir *(landed)*

1. Notebook metadata still declares `env_id` and UV deps.
2. The derived unified env dir does not exist.
3. Disk state is `Missing`.
4. Source resolution skips captured routing and preserves existing fallback behavior.
5. The daemon rebuilds through the normal inline/pool path per surrounding environment-resolution rules.
6. Fallback trades away per-notebook `env_id` cache isolation and may share an inline cache entry with another notebook declaring identical deps. That is the deliberate tradeoff for not treating every metadata snapshot with `env_id` as captured when no env exists on disk.

### Corrupt but Python-present env *(open follow-up)*

1. Disk state is `Usable` because Python exists.
2. First launch fails before `kernel_info_reply` due to missing `ipykernel` or broken packages.
3. Runtime agent classifies the failure before wrapping the error string and returns a retry hint.
4. Coordinator repairs the resolved captured env once and relaunches.
5. If relaunch fails, the user-visible error notes that automatic rebuild was attempted.

### Refresh defaults *(open follow-up)*

1. User opens the dependency panel for a captured notebook.
2. Frontend previews current declared dependencies against current workspace defaults.
3. User confirms.
4. Daemon snapshots defaults, rewrites dependency metadata under a guard, and invalidates the old captured env identity.
5. `RuntimeStateDoc` trust updates through normal dependency-trust derivation.
6. Next launch installs only after trust permits it.

## Open Follow-ups

1. **Launch retry on captured-env handshake failure.** Implement one-shot internal repair using structured runtime-agent retry hints (`RuntimeAgentLaunchFailureHint`). Upgrade to a fuller internal launch-error type only if optional hints prove too weak or leak into other protocol surfaces.
2. **Manual rebuild API (`RebuildSame`).** Add explicit user-triggered captured-environment rebuild without mutating dependency metadata. Settle stable vs. rotated `env_id` policy against UI and concurrency constraints.
3. **Refresh workspace defaults (`RefreshDefaults`).** Add daemon-owned metadata rewrite from snapshotted workspace defaults, invalidating the prior captured identity and re-running trust derivation.
4. **Retry suppression window.** Add a short per-room suppression window if repeated manual Run clicks during network or package-index outages make one-shot retry too noisy.
5. **Captured health marker.** Revisit a `.captured-ok` sidecar only if telemetry or bug reports show Python-present corrupt environments occur often enough that the first-launch retry delay is unacceptable.
