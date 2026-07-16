# Environment management

Scope: `crates/kernel-env/**`, `crates/kernel-launch/**`, `crates/runt-trust/**`, and the daemon's env resolution in `crates/runtimed/src/inline_env*`, `crates/runtimed/src/project_file*`, `crates/runtimed/src/uv_project*`, `crates/runtimed/src/warm_env*`, `crates/runtimed/src/requests/launch_kernel.rs`, and `crates/runtimed/src/notebook_sync_server/metadata.rs`.

## Two-stage detection

When a notebook opens, Runt determines the kernel via two stages:

1. **Runtime detection** — Python or Deno?
2. **Environment resolution** — For Python, which environment?

### Stage 1: Runtime detection

The daemon reads the notebook's kernelspec:

| Priority | Source | Check | Result |
|----------|--------|-------|--------|
| 1 | Notebook metadata | `kernelspec.name == "deno"` | Launch Deno kernel |
| 2 | Notebook metadata | `kernelspec.name` contains "python" | Resolve Python env |
| 3 | Notebook metadata | `kernelspec.language == "typescript"` | Launch Deno kernel |
| 4 | Notebook metadata | `language_info.name == "typescript"` | Launch Deno kernel |
| 5 | User setting | `default_runtime` preference | Python or Deno |

The notebook's kernelspec takes priority over project files. A Deno notebook in a directory with `pyproject.toml` launches a Deno kernel.

### Stage 2: Python environment resolution

| Priority | Source | Backend | Environment type |
|----------|--------|---------|-----------------|
| 1 | Closest project file | Walk-up via `project_file::find_nearest_project_file` / `detect_project_file` | Project-owned env |
| 2 | Captured prewarmed metadata with cache hit | `metadata.runt.{uv,conda}` + `env_id` routed back through `*:prewarmed` | Claimed env at unified hash |
| 3 | Inline notebook metadata | UV, Conda, or Pixi from `metadata.runt.{uv,conda,pixi}` | Cached env or `pixi exec` |
| 4 | PEP 723 script block | `notebook_doc::pep723` + default/scoped package manager | Cached env or `pixi exec` |
| 5 | User preference | Prewarmed env from pool | Shared pool env |

Project files win over inline deps because inline deps are promoted into the project file at sync/launch time; the project file is the source of truth once present. Walk-up checks `pyproject.toml`, `pixi.toml`, `environment.yml`/`.yaml` at each directory level. Closest wins. Same-directory tiebreaker: pyproject > pixi > environment.yml. A `pyproject.toml` with `[tool.pixi]` is treated as a Pixi project. Stops at `.git` boundaries and user's home directory.

| Project file | Backend | Environment |
|-------------|---------|-------------|
| `pyproject.toml` | `uv run --with ipykernel` in project dir | Project `.venv/` |
| `pixi.toml` / `pyproject.toml` with `[tool.pixi]` | `pixi shell-hook` or `pixi run` in project dir | Project Pixi env |
| `environment.yml` | Parse deps, find or build named Conda env after approval | Project Conda env |

### Deno kernels

No environment pools. Get deno via `kernel_launch::tools::get_deno_path()` (PATH first with acceptable version check, then download from Deno GitHub releases). Launch: `deno jupyter --kernel --conn <connection_file>`.

## Environment source labels

The daemon returns `env_source` with `KernelLaunched`:
- Prewarmed: `"uv:prewarmed"` / `"conda:prewarmed"` / `"pixi:prewarmed"`
- Inline metadata: `"uv:inline"` / `"conda:inline"` / `"pixi:inline"`
- Project files: `"uv:pyproject"` / `"conda:env_yml"` / `"pixi:toml"`
- PEP 723: `"uv:pep723"` / `"conda:pep723"` / `"pixi:pep723"`
- Deno: `"deno"`

## Runtime lifecycle

RuntimeStateDoc's canonical runtime state is `RuntimeLifecycle`. Legacy
`kernel.status` / `kernel.starting_phase` fields remain compatibility
projections for older UI and bindings, but new code should reason from the
typed lifecycle.

Lifecycle preparation can still expose granular phase labels:

| Phase | Description |
|-------|-------------|
| `"resolving"` | Dependency resolution (reading project files, computing env hash) |
| `"preparing_env"` | Environment creation or cache lookup |
| `"launching"` | Spawning the kernel process |
| `"connecting"` | Establishing ZMQ connection |

Written by daemon to RuntimeStateDoc. Frontend displays via `useRuntimeState()`
and shared toolbar/runtime surfaces. Compatibility starting-phase fields are
cleared when the lifecycle reaches running/idle or error.

## Content-addressed caching

Environments live at `{cache}/{hash}/`. Hash rule:

```
hash = sha256(sorted_deps + resolver_fields + env_id)[..16]
```

Every notebook's env is isolated per notebook via `env_id` — no cross-notebook sharing at disk level. Hot-sync on notebook A would silently mutate a shared env under notebook B.

| Runtime | Hash function | Cache dir |
|---------|---------------|-----------|
| UV | `kernel_env::uv::compute_unified_env_hash` | `~/.cache/runt/envs/{hash}/` |
| Conda | `kernel_env::conda::compute_unified_env_hash` | `~/.cache/runt/conda-envs/{hash}/` |

Cache paths are channel-aware: stable → `runt/`, nightly → `runt-nightly/`, dev worktree → `runt/worktrees/{hash}/`.

Cache hit check: verify `{hash}/bin/python` (Unix) or `{hash}/Scripts/python.exe` (Windows).

### Base-package constants

Pool warmer and capture step strip a base set so captured metadata records only user intent:

| Constant | Value |
|----------|-------|
| `kernel_env::uv::UV_BASE_PACKAGES` | `[ipykernel, ipywidgets, anywidget, nbformat, pyarrow>=14, uv]` |
| `kernel_env::conda::CONDA_BASE_PACKAGES` | `[ipykernel, ipywidgets, anywidget, pip, nbformat, pyarrow>=14]` |

## Prewarming and daemon pool

The daemon maintains pre-created environments (base set + user's `default_packages`):
- Default pool size: from synced settings for UV, Conda, and Pixi, capped by `MAX_POOL_SIZE`
- Max age: 2 days (172800 seconds)
- Warming loops replenish as environments are consumed
- Pool entries named `runtimed-{uv,conda,pixi}-{uuid}`, content-free, claimable by any notebook

Warm-env failures must surface in pool status with a real `error_kind` so
onboarding does not spin forever waiting for `available > 0`.

### First-launch capture

On first launch from pool:

1. Take pool entry (`runtimed-uv-{uuid}`).
2. Compute `user_defaults = strip_base(prewarmed_packages, BASE_PACKAGES)`.
3. Rename env dir to `{cache}/{compute_unified_env_hash(user_defaults, env_id)}/`.
4. Write `user_defaults` into `metadata.runt.{uv,conda}.dependencies` via `doc.transact_at_heads_recovering(...)`.

After capture the notebook is indistinguishable from inline-deps. `capture_env_into_metadata` is idempotent and write-once.

### Reopen cache-hit

On subsequent launches: read metadata deps + `env_id`, recompute hash, and
resolve the typed `CapturedEnvDiskState` with
`captured_env_disk_state(...)`. `Usable` and `Partial` stay on the captured-env
route; `Missing` falls back to the inline-deps rebuild path.

### Preserve captured envs on room eviction

Room eviction fires 30s after last peer disconnects. Captured envs bound to a **saved** `.ipynb` survive eviction so reopen cache-hits. Untitled notebooks and pool dirs are deleted. Predicate: `should_preserve_env_on_eviction`.

### Hot-sync coherence at eviction

When `sync_environment` adds packages mid-session, new deps land in `LaunchedEnvConfig` but not metadata. At eviction, after runtime agent shutdown:

1. `flush_launched_deps_to_metadata` writes post-sync deps into metadata via `doc.transact_at_heads_recovering(...)`.
2. `save_notebook_to_disk` persists updated metadata.
3. `rename_env_dir_to_unified_hash` moves env from pre-flush hash to post-flush hash.

Kernel is dead at this point so rename is safe.

## Project file discovery

Unified project-file detection walks up from the notebook, stops at `.git`
boundaries and the user's home directory, and uses closest-wins semantics.
Same-directory tiebreaker: pyproject.toml > pixi.toml > environment.yml.

## Notebook metadata schema

```json
{
  "metadata": {
    "kernelspec": { "name": "python3", "display_name": "Python 3", "language": "python" },
    "runt": {
      "schema_version": "1",
      "env_id": "uuid",
      "uv": { "dependencies": ["pandas", "numpy"], "requires-python": ">=3.10" },
      "conda": { "dependencies": ["numpy", "scipy"], "channels": ["conda-forge"], "python": "3.12" },
      "deno": { "permissions": ["--allow-net"], "config": "deno.json" }
    }
  }
}
```

Runtime type is determined by `kernelspec.name`, not by a field in `runt`.

## Trust system

Dependency installation is gated on a per-machine SQLite allowlist. The
daemon only launches a kernel when every dependency name in the notebook
is present in the local trusted-package store.

- **Store:** `TrustedPackageStore` in `crates/runtimed/src/trusted_packages.rs`,
  keyed by `(ecosystem, normalized_name)` and populated by user approval
  via the trust dialog or by daemon-initiated approval flows.
- **Extraction:** `runt_trust::extract_trust_info()` pulls dep names out
  of `metadata.runt.uv` / `metadata.runt.conda` / `metadata.runt.pixi`
  (with fallback to legacy `metadata.uv` / `metadata.conda`).
- **Finalization:** `metadata::finalize_trust_status()` in `runtimed`
  asks the store whether every name is approved and returns `Trusted`,
  `Untrusted`, or `NoDependencies`. Store unavailability is fail-closed.
- **Machine-specific:** every shared notebook is untrusted on the
  recipient's machine until they approve the deps locally.

Changes to dependency metadata require updating `crates/notebook-doc/src/metadata.rs` and `crates/runt-trust/src/lib.rs`.

## Tool bootstrapping

Tools are auto-downloaded from GitHub releases if not on PATH:

```rust
use kernel_launch::tools;
let deno = tools::get_deno_path().await?;
let uv = tools::get_uv_path().await?;
let ruff = tools::get_ruff_path().await?;
```

Ensures the app works standalone without requiring users to install tooling.

## Adding a new project file format

1. Extend `crates/runtimed/src/project_file.rs` for unified closest-wins walk detection.
2. Extend `crates/notebook-doc/src/metadata.rs` if the format adds notebook dependency metadata.
3. Wire into daemon auto-launch helpers at the correct priority position.
4. Add frontend projection in `packages/runtimed/src/derived-state.ts` and the appropriate hook.
5. Add test fixture coverage in `crates/notebook/fixtures/audit-test/`.
