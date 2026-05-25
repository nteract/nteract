# Captured Environment Lifecycle

**Status:** Draft, 2026-05-24.

## Related ADRs

- `docs/architecture/kernel-env-trust.md` - dependency trust decides whether the daemon may install or launch declared packages. This ADR starts after that gate: how a captured environment is identified, reused, repaired, and manually reset.
- `docs/architecture/execution-pipeline.md` - launch retry must preserve the lifecycle ordering guarantees around kernel startup and terminal error publication.
- `docs/architecture/three-document-split.md` - NotebookDoc carries dependency declarations; RuntimeStateDoc carries launch/progress/error state.
- `docs/architecture/cleanup-punchlist.md` - follow-up lifecycle/API work.

## Context

Captured environments make notebooks self-describing. On first launch from a prewarmed UV or Conda pool, the daemon strips base packages, records the user's dependency intent in `metadata.runt.{uv,conda}`, assigns `metadata.runt.env_id`, and renames the claimed environment into the unified content-addressed cache. Later launches recompute the unified hash from metadata and `env_id` and try to reuse the same interpreter.

That gives users fast reopen and per-notebook isolation, but it also creates a lifecycle responsibility. If the on-disk environment is incomplete or later becomes unable to launch, users should not need to edit `metadata.runt.env_id`, know the unified hash, or delete cache directories by hand. The daemon owns those lifecycle mutations.

Issues #1969 and #1968 are two layers of the same design:

- #1969: automatic repair when a captured environment is incomplete or fails during the kernel launch handshake.
- #1968: manual controls for rebuilding a captured environment or refreshing captured dependencies from current workspace defaults.

This ADR covers the invariants both features must share.

## Decision 1: Captured identity is metadata intent plus `env_id`

A captured environment's identity is not the cache path. It is:

1. the runtime family (UV or Conda),
2. the full resolver-affecting dependency intent stored in notebook metadata, and
3. `metadata.runt.env_id`.

The full dependency intent matters. For UV, `dependencies`, `requires-python`, and `prerelease` all feed the unified hash. For Conda, `dependencies`, `channels`, `python`, and the conditional GIL-enforcement ABI marker all feed the unified hash. `compute_unified_env_hash()` is authoritative for the exact field list. Dropping resolver fields would silently point a notebook at a different cache path after metadata edits.

Cache paths are derived from this identity:

```text
hash = hex(sha256(sorted_deps + resolver_fields + env_id))[..16] // 16 hex chars
env_path = backend_cache_dir / hash
```

The path is not authoritative state. Any daemon action that deletes, repairs, or rebuilds a captured environment must derive the expected path from the current captured identity and backend cache root.

Automatic repair keeps `env_id` stable. A stable `env_id` means the daemon repairs the notebook's existing captured identity instead of silently assigning a new one. Manual rebuilds may later choose to rotate `env_id`, but that is a separate API decision that must shut down the active kernel and mutate metadata under a guard.

## Decision 2: Disk state is typed, not boolean

The old question was "does `unified_env_on_disk()` return a Python path?" That boolean loses important information. Captured disk state has three states:

| State | Meaning | Routing |
|---|---|---|
| `Missing` | Expected unified env dir is absent. | Do not route as captured. Missing can mean GC, cache cleanup, or a fresh inline-dep notebook with metadata but no captured env yet. |
| `Partial` | Env dir exists but the expected Python executable is absent. | Route to captured repair. The directory's presence proves the notebook once owned this derived hash. |
| `Usable` | Env dir exists and expected Python executable exists. | Route as captured cache-hit candidate. |

This distinction is load-bearing. A missing dir is ambiguous and must preserve the existing fallback behavior. A partial dir is not ambiguous: it is a broken on-disk realization of this notebook's captured identity and should be rebuilt through the captured path.

The resolution helper must therefore be typed. A plan that detects `Partial` only inside `acquire_prewarmed_env_with_capture()` is insufficient if the source-resolution layer never routes partial dirs to `uv:prewarmed` or `conda:prewarmed`.

## Decision 3: The happy path stays cheap

Cached launch is the hot path. It should not spawn Python just to prove the environment is healthy. The daemon should not run `diagnose_ipykernel()` or similar subprocess probes on every captured cache hit.

The cheap disk predicate is Python path existence. That does not prove every package is importable, but it distinguishes the common interrupted-install shape without paying subprocess cost on every reopen. If Python exists but `site-packages` is corrupt, the launch handshake is the stronger health signal and the one-shot retry path handles it.

Captured repair also does not require a new `.captured-ok` marker in the first pass. The repository already has several environment sidecars (`.warmed`, `.last-used`, `.runt-pool-packages.sha256`, Conda `.lock.json`). Adding another marker creates another coherence surface during capture, eviction, dependency sync, rebuild, and manual reset. The current first pass uses existing signals:

- missing Python executable means `Partial`;
- `prepare_environment_unified()` handles partial dirs and rebuilds;
- launch handshake failure on a captured env can trigger one controlled rebuild/relaunch.

UV currently removes a partial unified env dir before rebuilding. Conda has an extra lock-file path and may attempt a lock-based rebuild before a full remove/recreate. The lifecycle decision is not "always delete first"; it is "route partial captured dirs into the backend's existing unified-env repair path."

Revisit a captured health marker only if telemetry or repeated bug reports show that "Python exists but env cannot launch" is common enough that the first failed launch/retry delay is unacceptable.

## Decision 4: Repair is daemon-owned and scoped

The frontend must not delete cache directories, rotate `env_id`, or rewrite captured dependency metadata directly. It can request lifecycle actions and show previews; the daemon owns the final mutation.

For automatic repair:

- `Partial` dirs rebuild through `prepare_environment_unified()`, using the backend's existing partial-dir handling.
- Post-launch failure invalidation is allowed only after a captured env fails during an infrastructure launch phase.
- Invalidation may remove only the derived unified-hash path under the expected backend cache root.
- The daemon must not delete arbitrary `runtime_agent` paths or caller-supplied paths.

The cache root is user-owned local state, but path safety still matters. Implementations should canonicalize the cache root when practical, compare against the derived hash path, reject paths outside the expected root, and avoid following arbitrary user-controlled path input. The derived path should come from `CapturedEnv`, not from frontend payloads.

`env_id` makes captured hashes per notebook. That invariant prevents one notebook's repair from deleting another notebook's captured env. If a future feature intentionally shares captured envs across notebooks, it must revisit this ADR.

## Decision 5: Launch retry is one-shot and internal

Automatic retry exists to recover infrastructure failures in the captured environment, not user-code failures.

The retry is internal to a single launch request:

1. The launch request passes the normal trust gate.
2. Source resolution chooses a captured UV/Conda environment.
3. The daemon resolves a concrete `CapturedEnv` snapshot and launch config.
4. The runtime agent attempts kernel launch.
5. If launch fails with a retryable infrastructure hint, the coordinator repairs the already-resolved captured env and launches once more.
6. If the second launch fails, the daemon surfaces the original failure with a note that automatic rebuild was attempted.

The retry must not publish an intermediate `Error` lifecycle before it retries. RuntimeStateDoc should remain in a progressing state until the retry succeeds or the final error is known. Otherwise the UI can see `Launching -> Error -> Launching -> Error`, and a concurrent launch request can mistake the intermediate error as permission to start a second repair.

The retry uses the dependency snapshot from the original resolution. It must not re-read mutable NotebookDoc metadata between first failure and repair. If another peer edits dependencies during the handshake window, that edit is handled by a later trust/resolution cycle; it does not change the in-flight repair.

The retry also relies on the existing launch lifecycle gate: a launch request claims the room while resolving/launching, and the automatic retry must remain inside that same claim. If that gate changes, this ADR's concurrency assumptions need to be revisited.

## Decision 6: Launch failure hints cross the runtime-agent boundary

The runtime agent sees the raw `anyhow::Error` from `JupyterKernel::launch()`. The coordinator currently sees a string wrapped as `Failed to launch kernel: ...`. Classifying retryable failures after this wrapping is brittle.

Classification should happen inside `runtime_agent.rs` before formatting the user-facing error string. The response to the coordinator should carry the original error string plus a structured retry hint. The hint can remain internal to the runtime-agent/coordinator protocol; it does not need to become frontend UX.

Because the runtime agent and coordinator communicate through `notebook-protocol`, the hint type may need to live in that shared crate. If so, mark it as protocol-internal with a doc comment or `#[doc(hidden)]`; it is serialized infrastructure state, not a stable client-facing UX contract.

One compatible shape is:

```rust
RuntimeAgentResponse::Error {
    error: String,
    launch_failure_hint: Option<RuntimeAgentLaunchFailureHint>,
}
```

Every non-launch error can omit the hint. If enum-match churn makes an optional field awkward, a launch-specific failure variant is also acceptable. The important decision is that retry policy should not parse double-wrapped display strings.

Retryable hints are infrastructure failures such as:

- kernel process exits before `kernel_info_reply`;
- kernel info request times out;
- kernel info request send fails;
- Python executable cannot start;
- `ipykernel` is missing.

## Decision 7: Manual controls are a later lifecycle API

#1968 should build on #1969's daemon-owned lifecycle primitives. It should not be implemented as frontend metadata editing plus filesystem deletion.

The likely request shape is:

```rust
ResetNotebookEnvironment {
    strategy: RebuildSame | RefreshDefaults,
    guard: Option<DependencyGuard>,
}
```

`RebuildSame` keeps the notebook's declared dependency intent and invalidates/rebuilds only the matching captured env identity. The final choice between stable `env_id` and rotated `env_id` belongs to the request design. If it rotates `env_id`, it must shut down the active kernel and mutate NotebookDoc under a guard.

`RefreshDefaults` is a metadata rewrite. The daemon must snapshot current default packages at apply time, because frontend settings can drift while a dialog is open. After the rewrite, normal trust derivation decides whether the new dependency declaration is trusted. New default dependencies should not bypass the trust model just because the user clicked a reset button.

Frontend placement should be an "Environment actions" menu or compact secondary row in the dependency panel, gated to captured UV/Conda notebooks. The product language should avoid internal fields:

- Automatic repair: "The notebook environment looked broken, so nteract rebuilt it from this notebook's declared dependencies."
- Manual rebuild: "Rebuild this notebook's environment from its declared dependencies."
- Refresh defaults: "Replace this notebook's declared dependencies with your current workspace defaults."

Use "declared dependencies", not "saved dependencies"; saved can mean either the `.ipynb` on disk or the live Automerge document.

## Worked Examples

### Partial captured UV dir

1. Notebook metadata declares `metadata.runt.env_id = "abc"` and `metadata.runt.uv.dependencies = ["pandas"]`.
2. The derived unified env dir exists, but `{hash}/bin/python` does not.
3. Disk state is `Partial`.
4. Source resolution routes to the captured repair path, not the pool path.
5. `prepare_environment_unified()` removes the partial dir and rebuilds the same hash.
6. Launch proceeds against the repaired env.

### GC'd captured dir

1. Notebook metadata still has `env_id` and declared UV deps.
2. The derived unified env dir does not exist.
3. Disk state is `Missing`.
4. Source resolution does not route as captured, preserving the existing fallback behavior.
5. The daemon may rebuild through the normal inline/pool path according to the surrounding environment-resolution rules.
6. That fallback does not preserve per-notebook `env_id` cache isolation for the rebuild; it may share an inline cache entry with another notebook that declares identical deps. This is the tradeoff for not treating every deps-plus-`env_id` metadata snapshot as captured when no derived env exists on disk.

### Corrupt but Python-present env

1. Disk state is `Usable` because Python exists.
2. The first launch attempt fails before `kernel_info_reply` due to missing `ipykernel` or broken packages.
3. Runtime agent classifies the failure before wrapping the error string and returns a retry hint.
4. Coordinator repairs the already-resolved captured env once and relaunches.
5. If relaunch fails, the final user-visible error includes that automatic rebuild was attempted.

### Refresh defaults

1. User opens the dependency panel for a captured notebook.
2. The frontend previews "current declared deps" versus "current workspace defaults".
3. User confirms.
4. The daemon snapshots defaults, rewrites dependency metadata under a guard, and invalidates the old captured env identity.
5. RuntimeStateDoc trust updates through the normal dependency-trust flow.
6. The next launch installs only after trust allows it.

## Deferred Decisions

1. **Captured health marker.** Revisit `.captured-ok` only with evidence that the current disk-state plus launch-handshake signals are not enough.
2. **Retry suppression window.** The first implementation can retry once per launch request. If users repeatedly click run during network/package-index failures, add a short per-room suppression window.
3. **Full typed launch-error model.** If optional retry hints are too weak or leak into other protocol surfaces, introduce a richer internal launch-error type.
4. **Manual rebuild `env_id` policy.** Automatic repair keeps `env_id` stable. Manual rebuild can revisit stable versus rotated `env_id` with UI and concurrency constraints in view.

## Implementation Notes

The #1969 implementation plan should be updated before coding:

- merge typed disk-state and partial repair into one implementation unit;
- replace the boolean `is_captured()` gate with typed captured-resolution semantics;
- prove `Missing` does not route as captured and `Partial` does;
- classify launch failures in `runtime_agent.rs` before wrapping;
- keep retry lifecycle in a progressing state until final success/error;
- add focused tests for UV and Conda disk states, including broken symlink behavior when feasible.
