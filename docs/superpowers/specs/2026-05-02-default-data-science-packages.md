# Default data-science packages for pool environments

Pool environments ship with ipykernel, ipywidgets, anywidget, pyarrow, and nbformat. That covers the kernel runtime but not the packages people actually reach for. matplotlib, pandas, polars, plotly, and altair should be installed and prewarmed by default so scratch notebooks come up ready for real work.

## Design

### Curated package list

A new constant defines the default data-science set:

```rust
pub const DEFAULT_DATA_SCIENCE_PACKAGES: &[&str] = &[
    "matplotlib",
    "polars",
    "pandas",
    "plotly",
    "altair",
];
```

This lives in `runtimed-client` alongside the settings types so both the daemon and settings code can reference it. The list is not user-editable. Users control it with a toggle.

### Settings toggle

New field on `SyncedSettings`:

```rust
#[serde(default = "default_true")]
pub install_default_data_packages: bool,
```

Default: `true`. The onboarding flow does not surface this. The settings UI shows a checkbox: "Install base data science packages (matplotlib, pandas, polars, plotly, altair)".

`UvDefaults`, `CondaDefaults`, and `PixiDefaults` are unchanged. `default_packages` remains user-only extras, independent of the toggle.

### Warming loop merge

All three warming loops (UV, conda, pixi) read the toggle and merge:

```
let mut extra = synced.uv.default_packages.clone();
if synced.install_default_data_packages {
    extra.extend(DEFAULT_DATA_SCIENCE_PACKAGES.iter().map(|s| s.to_string()));
}
let pkgs = uv_prewarmed_packages(&extra);
```

Dedup is already handled by `extend_default_packages`. The merged list flows through to both `uv pip install` (or conda/pixi equivalent) and `build_warmup_command()` for import prewarming.

### Prewarming

No changes to the prewarm script. `_collect_modules()` already normalizes package names to import names and does try/except imports. All five packages have matching import names (`matplotlib`, `polars`, `pandas`, `plotly`, `altair`). The `compileall` phase pre-compiles their `.pyc` files. matplotlib's font cache init, C extension loading, and BLAS detection for numpy (transitive dep of pandas) all run during the warmup.

### Pool retirement: keep old envs claimable

Today, `retire_mismatched_packages` moves drifted envs from `available` to `retired_paths`, making them unclaimable via `take()`. During the window between retirement and replacement warming, the pool has zero available envs. A `create_notebook` during that window falls back to a fresh inline env from scratch.

With five extra packages the warming window is longer (30-90s with cold caches). An old pool env missing the data-science packages is still better than no pool env, because the kernel runtime (ipykernel, ipywidgets) works fine. The user just won't have `import pandas` prewarmed until the new env is ready.

The retirement data structure needs to change. Today `retired_paths` is a `HashSet<PathBuf>` - just paths, no `PooledEnv`. To make retired envs claimable, replace it with a `VecDeque<PoolEntry>` (call it `retired`) that preserves the full pool entry. `retire_mismatched_packages` moves entries from `available` to `retired` instead of extracting just the path.

Change `take()` to fall back to `retired` when `available` is empty:

1. `take()` checks `available` first (existing behavior).
2. If empty, pop from `retired`. Validate the env (paths exist, `.warmed` marker present). Lease it.
3. Mark the fallback as leased so it isn't deleted while in use.
4. Once new envs finish warming and enter `available`, the retired entries get cleaned up.

`retired_paths_if_available_at_target` drains `retired` (extracting paths) instead of draining a `HashSet`. Deletion still only happens when `available.len() >= target`.

All existing callers that reference `retired_paths` (orphan GC tracking, `retire_path`, `retire_path_if_fallback_needed`) switch to the new `retired: VecDeque<PoolEntry>` with equivalent semantics.

### Upgrade screen

The app can optionally block the upgrade/restart screen until the user's selected env manager has at least one warmed pool entry, using the same `get_pool_status` polling pattern the onboarding wizard uses today. This is a separate, smaller piece of work. The pool retirement fallback above is sufficient to avoid a cold gap even without the upgrade screen gate.

## Scope

Pool environments only. Project notebooks with inline deps or `pyproject.toml` use their own environments and are unaffected.

## What changes where

| File | Change |
|------|--------|
| `runtimed-client/src/settings_doc.rs` | Add `install_default_data_packages: bool` field, `DEFAULT_DATA_SCIENCE_PACKAGES` constant |
| `runtimed/src/daemon.rs` | Merge data-science defaults into `extra` before calling `*_prewarmed_packages()` in UV, conda, pixi warming loops |
| `runtimed/src/daemon.rs` | `take()` falls back to retired envs when available is empty |
| Frontend settings panel | Checkbox for the toggle |
| Frontend upgrade screen (optional, separate PR) | Poll `get_pool_status`, block until warm |

## Package hash impact

`expected_pool_package_hash` hashes the sorted package list. Adding the five packages changes the hash, causing all existing pool envs to be retired on first warming cycle after upgrade. The retirement fallback ensures they remain claimable until replacements are ready.

## Behavioral coverage

| Scenario | Before | After |
|----------|--------|-------|
| Fresh install, first notebook | ipykernel + ipywidgets warm | ipykernel + ipywidgets + matplotlib/pandas/polars/plotly/altair warm |
| Existing user, daemon restart | Old pool envs retired, gap until new ones warm | Old pool envs retired but still claimable as fallback |
| User toggles off `install_default_data_packages` | N/A | Next warming cycle retires data-science envs, builds base-only replacements. Old envs still claimable during transition |
| User adds custom `default_packages` | Custom packages in pool | Custom packages + data-science packages in pool (if toggle on) |
| Project notebook with inline deps | Uses inline env | Unchanged, uses inline env |
