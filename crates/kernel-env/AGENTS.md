# Environment management

Scope: `crates/kernel-env/**`, `crates/kernel-launch/**`, `crates/runt-trust/**`, and the daemon's env resolution in `crates/runtimed/src/inline_env*`, `crates/runtimed/src/project_file*`.

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
| 1 | Inline notebook metadata | UV or Conda from `metadata.runt.uv` / `metadata.runt.conda` | Cached by dep hash |
| 2 | Closest project file | Walk-up via `project_file::find_nearest_project_file` | Depends on file type |
| 3 | User preference | Prewarmed env from pool | Shared pool env |

Walk-up checks `pyproject.toml`, `pixi.toml`, `environment.yml`/`.yaml` at each directory level. Closest wins. Same-directory tiebreaker: pyproject > pixi > environment.yml. Stops at `.git` boundaries and user's home directory.

| Project file | Backend | Environment |
|-------------|---------|-------------|
| `pyproject.toml` | `uv run --with ipykernel` in project dir | Project `.venv/` |
| `pixi.toml` | Convert deps to `CondaDependencies`, use rattler | Cached by dep hash |
| `environment.yml` | Parse deps, use rattler | Cached by dep hash |

### Deno kernels

No environment pools. Get deno via `kernel_launch::tools::get_deno_path()` (PATH first, then bootstrap from conda-forge). Launch: `deno jupyter --kernel --conn <connection_file>`.

## Environment source labels

The daemon returns `env_source` with `KernelLaunched`:
- `"uv:inline"` / `"uv:pyproject"` / `"uv:prewarmed"` / `"uv:pep723"`
- `"conda:inline"` / `"conda:env_yml"` / `"conda:prewarmed"`
- `"pixi:toml"`

## Kernel starting phases

RuntimeStateDoc tracks granular phases via `kernel.starting_phase`:

| Phase | Description |
|-------|-------------|
| `"resolving"` | Dependency resolution (reading project files, computing env hash) |
| `"preparing_env"` | Environment creation or cache lookup |
| `"launching"` | Spawning the kernel process |
| `"connecting"` | Establishing ZMQ connection |

Written by daemon to RuntimeStateDoc. Frontend displays via `useRuntimeState()`. Cleared when kernel reaches `idle` or `error`.

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
| `kernel_env::uv::UV_BASE_PACKAGES` | `[ipykernel, ipywidgets, anywidget, nbformat, uv, dx]` |
| `kernel_env::conda::CONDA_BASE_PACKAGES` | `[ipykernel, ipywidgets, anywidget, nbformat]` |

## Prewarming and daemon pool

The daemon maintains pre-created environments (base set + user's `default_packages`):
- Default pool size: 3 per type (UV and Conda)
- Max age: 2 days (172800 seconds)
- Warming loops replenish as environments are consumed
- Pool entries named `runtimed-{uv,conda}-{uuid}`, content-free, claimable by any notebook

### First-launch capture

On first launch from pool:

1. Take pool entry (`runtimed-uv-{uuid}`).
2. Compute `user_defaults = strip_base(prewarmed_packages, BASE_PACKAGES)`.
3. Rename env dir to `{cache}/{compute_unified_env_hash(user_defaults, env_id)}/`.
4. Write `user_defaults` into `metadata.runt.{uv,conda}.dependencies` via `doc.transact_at_heads_recovering(...)`.

After capture the notebook is indistinguishable from inline-deps. `capture_env_into_metadata` is idempotent and write-once.

### Reopen cache-hit

On subsequent launches: read metadata deps + `env_id`, recompute hash, check `unified_env_on_disk`. Cache hit → instant return. Cache miss → rebuild via inline-deps path.

### Preserve captured envs on room eviction

Room eviction fires 30s after last peer disconnects. Captured envs bound to a **saved** `.ipynb` survive eviction so reopen cache-hits. Untitled notebooks and pool dirs are deleted. Predicate: `should_preserve_env_on_eviction`.

### Hot-sync coherence at eviction

When `sync_environment` adds packages mid-session, new deps land in `LaunchedEnvConfig` but not metadata. At eviction, after runtime agent shutdown:

1. `flush_launched_deps_to_metadata` writes post-sync deps into metadata via `doc.transact_at_heads_recovering(...)`.
2. `save_notebook_to_disk` persists updated metadata.
3. `rename_env_dir_to_unified_hash` moves env from pre-flush hash to post-flush hash.

Kernel is dead at this point so rename is safe.

## Project file discovery

Unified detection in `crates/runtimed/src/project_file.rs`:

| Module | Purpose |
|--------|---------|
| `project_file.rs` | `find_nearest_project_file()` — single walk-up, closest wins |
| `pyproject.rs` | Parsing, Tauri commands, `find_pyproject()` |
| `pixi.rs` | Parsing, Tauri commands, `find_pixi_toml()` |
| `environment_yml.rs` | Parsing, Tauri commands, `find_environment_yml()` |
| `deno_env.rs` | `find_deno_config()` |

All walk-up functions stop at `.git` boundaries and user's home directory.

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

Dependencies are signed with HMAC-SHA256 to prevent untrusted code execution on notebook open.

- **Key:** 32 random bytes at `~/Library/Application Support/runt/trust-key` (macOS) or `~/.config/runt/trust-key` (Linux)
- **Signed content:** Canonical JSON of `metadata.runt.uv` + `metadata.runt.conda` (with fallback to legacy `metadata.uv` + `metadata.conda`)
- **Format:** `"hmac-sha256:{hex_digest}"` in notebook metadata
- **Machine-specific:** Every shared notebook is untrusted on the recipient's machine
- **Verification:** `verify_signature()` → `bool`; `verify_notebook_trust()` → `TrustInfo` with `TrustStatus`: Trusted, Untrusted, SignatureInvalid, or NoDependencies

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

## Key files

| File | Role |
|------|------|
| `crates/kernel-launch/src/lib.rs` | Public API for kernel launching |
| `crates/kernel-launch/src/tools.rs` | Tool bootstrapping (deno, uv, ruff, pixi) |
| `crates/kernel-env/src/uv.rs` | UV environment creation and caching |
| `crates/kernel-env/src/conda.rs` | Conda environment creation and caching |
| `crates/kernel-env/src/warmup.rs` | Pool warming logic |
| `crates/runtimed/src/daemon.rs` | Pool management |
| `crates/runtimed/src/notebook_sync_server/metadata.rs` | Auto-launch detection and resolution |
| `crates/runtimed/src/runtime_agent.rs` | Per-notebook event loop |
| `crates/runtimed/src/jupyter_kernel.rs` | Kernel process spawning |
| `crates/runtimed/src/inline_env.rs` | Cached inline dep environments |
| `crates/runtimed/src/project_file.rs` | Unified project file detection |
| `crates/runt-trust/src/lib.rs` | HMAC trust verification |
| `crates/notebook-doc/src/metadata.rs` | Metadata schema and accessors |
