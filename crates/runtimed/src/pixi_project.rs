//! Helpers for `pixi:toml` launches.
//!
//! Project-backed pixi kernels activate the user's pixi environment via
//! `pixi shell-hook`. That call can hit the network when pixi decides the
//! lockfile needs to refresh, so this module mirrors `uv_project` and adds
//! an offline-tolerant prepare probe: if `pixi shell-hook` fails with
//! network or DNS markers, retry with `PIXI_FROZEN=true` so pixi uses the
//! lockfile as-is. When the retry succeeds, callers propagate the frozen
//! signal through the kernel launch so the runtime-agent-side
//! `pixi shell-hook` and the fallback `pixi run` also stay offline.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use kernel_env::{EnvProgressPhase, ProgressHandler};
use tracing::{info, warn};

use crate::uv_project::is_network_failure;

/// Result of probing a `pixi:toml` environment before kernel launch.
pub(crate) enum PixiPrepareOutcome {
    /// No pixi manifest under the notebook tree, or `pixi shell-hook`
    /// succeeded without `PIXI_FROZEN`, or the probe failed for a
    /// non-network reason (the caller should let the downstream launch
    /// surface its own error rather than treat this as a hard fail).
    SkipOrOnline,
    /// `pixi shell-hook` hit a network failure and the frozen retry
    /// succeeded. Propagate `PIXI_FROZEN=true` through the LaunchKernel
    /// RPC so the runtime-agent-side calls also stay offline.
    Frozen,
    /// `pixi shell-hook` hit a network failure AND the frozen retry also
    /// failed: we are offline and the lockfile/env isn't materialized
    /// enough to launch. Caller should surface this as a hard error
    /// rather than letting the launch fail deeper in the stack.
    OfflineUnrecoverable(anyhow::Error),
}

/// Env vars that switch `pixi` into frozen mode (lockfile-only, no network
/// refresh). Returned alongside the prepare outcome so callers can attach
/// it to the LaunchKernel RPC's `env_vars` map without losing the offline
/// decision between daemon and runtime agent.
pub(crate) fn pixi_frozen_env_vars(frozen: bool) -> HashMap<String, String> {
    let mut env = HashMap::new();
    if frozen {
        // `PIXI_FROZEN` parses as a bool (`true`/`false`), not `1`. Pixi
        // rejects `PIXI_FROZEN=1` with `invalid value '1' for '--frozen'`.
        env.insert("PIXI_FROZEN".to_string(), "true".to_string());
    }
    env
}

/// Probe the `pixi:toml` environment before kernel launch.
///
/// - If `pixi shell-hook` succeeds online, returns `SkipOrOnline`.
/// - If it hits a network failure but a `PIXI_FROZEN=true` retry succeeds,
///   returns `Frozen` so the caller propagates the flag to the kernel
///   launch.
/// - If both attempts fail with a network error, returns
///   `OfflineUnrecoverable` so the caller can publish an actionable error
///   instead of falling through to a launch that re-hits the network.
/// - Non-network probe failures (e.g. malformed pixi.toml) also return
///   `SkipOrOnline`: the existing launch path produces a better-typed
///   error than this probe can.
pub(crate) async fn prepare_pixi_toml_environment(
    notebook_path: Option<&Path>,
    progress_handler: Arc<dyn ProgressHandler>,
) -> PixiPrepareOutcome {
    let Some(manifest_path) = locate_pixi_manifest(notebook_path) else {
        return PixiPrepareOutcome::SkipOrOnline;
    };
    let project_path_label = manifest_path.display().to_string();

    progress_handler.on_progress(
        "pixi",
        EnvProgressPhase::ProjectPreparing {
            source: "pixi:toml".to_string(),
            project_path: project_path_label.clone(),
        },
    );

    info!(
        "[pixi-project] Preparing pixi:toml environment via shell-hook: project={}",
        project_path_label
    );
    let started = Instant::now();
    let empty: HashMap<String, String> = HashMap::new();
    let initial_err =
        match kernel_launch::tools::pixi_shell_hook(&manifest_path, None, &empty).await {
            Ok(_) => {
                info!(
                    "[pixi-project] pixi:toml environment ready: project={} elapsed_ms={}",
                    project_path_label,
                    started.elapsed().as_millis()
                );
                return PixiPrepareOutcome::SkipOrOnline;
            }
            Err(e) => e,
        };

    let initial_stderr = format!("{initial_err}");
    if !is_network_failure(&initial_stderr) {
        // Non-network probe failure. Let the downstream launch produce its
        // own (typed) error rather than synthesizing one here.
        warn!(
            "[pixi-project] pixi shell-hook probe failed for non-network reason; continuing to launch: project={} err={}",
            project_path_label,
            initial_stderr.trim()
        );
        return PixiPrepareOutcome::SkipOrOnline;
    }

    warn!(
        "[pixi-project] pixi shell-hook hit network failure; retrying frozen: project={} stderr={}",
        project_path_label,
        initial_stderr.trim()
    );

    let frozen = pixi_frozen_env_vars(true);
    match kernel_launch::tools::pixi_shell_hook(&manifest_path, None, &frozen).await {
        Ok(_) => {
            info!(
                "[pixi-project] pixi:toml environment ready from lockfile (frozen): project={} elapsed_ms={}",
                project_path_label,
                started.elapsed().as_millis()
            );
            PixiPrepareOutcome::Frozen
        }
        Err(_) => {
            // Frozen retry failed too. Surface the ORIGINAL network error:
            // it names the actual cause (no internet), whereas the frozen
            // retry failure typically just says the env can't be activated.
            PixiPrepareOutcome::OfflineUnrecoverable(initial_err)
        }
    }
}

fn locate_pixi_manifest(notebook_path: Option<&Path>) -> Option<std::path::PathBuf> {
    locate_pixi_manifest_with_home(notebook_path?, dirs::home_dir())
}

/// Walks up from the notebook directory and picks the closest pixi
/// manifest. At each directory level `pyproject.toml` with `[tool.pixi]`
/// wins over sibling `pixi.toml`, and a bare `pyproject.toml` without
/// `[tool.pixi]` is skipped when no sibling `pixi.toml` exists. Mirrors
/// the boundaries of
/// `crate::project_file::find_nearest_project_file` (stops at `.git` or
/// the home directory) so the probe targets the same project the launch
/// path will end up activating.
///
/// The `home_dir` parameter is plumbed through for tests; production
/// callers should pass `dirs::home_dir()`.
fn locate_pixi_manifest_with_home(
    notebook_path: &Path,
    home_dir: Option<std::path::PathBuf>,
) -> Option<std::path::PathBuf> {
    let start_dir = if notebook_path.is_file() {
        notebook_path.parent()?
    } else {
        notebook_path
    };
    let mut current = start_dir.to_path_buf();
    loop {
        if let Some(ref home) = home_dir {
            if current == *home {
                return None;
            }
        }

        // Match the launch path: `find_nearest_project_file` checks
        // pyproject.toml before pixi.toml in its tiebreaker, and treats
        // pyproject.toml-with-[tool.pixi] as a pixi manifest. So at the
        // same level pyproject-with-[tool.pixi] wins over pixi.toml; a
        // bare pyproject.toml drops out of the launch's PixiToml filter,
        // but the fallback `pixi run` ends up auto-detecting a sibling
        // pixi.toml from the cwd, so we still return pixi.toml here when
        // one is present.
        let pyproject = current.join("pyproject.toml");
        if pyproject.exists() && crate::project_file::pyproject_has_pixi_section(&pyproject) {
            return Some(pyproject);
        }
        let pixi = current.join("pixi.toml");
        if pixi.exists() {
            return Some(pixi);
        }
        if pyproject.exists() {
            // Bare pyproject (no [tool.pixi]) without a sibling pixi.toml:
            // the launch's PixiToml filter drops it and `pixi run`
            // auto-detection from this cwd has nothing to grab onto. Stop
            // walking so the probe doesn't target an unrelated ancestor.
            return None;
        }

        if current.join(".git").exists() {
            return None;
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => return None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixi_frozen_env_vars_set_pixi_frozen_when_true() {
        let on = pixi_frozen_env_vars(true);
        // Pixi parses PIXI_FROZEN as a bool; the literal "1" is rejected.
        assert_eq!(on.get("PIXI_FROZEN"), Some(&"true".to_string()));
        assert_eq!(on.len(), 1);
        assert!(pixi_frozen_env_vars(false).is_empty());
    }

    #[test]
    fn locate_pixi_manifest_finds_pixi_toml() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest = tmp.path().join("pixi.toml");
        std::fs::write(&manifest, "[project]\nname=\"x\"\n").unwrap();
        let notebook = tmp.path().join("nb.ipynb");
        std::fs::write(&notebook, "{}").unwrap();
        assert_eq!(
            locate_pixi_manifest_with_home(&notebook, None),
            Some(manifest)
        );
    }

    #[test]
    fn locate_pixi_manifest_finds_pyproject_with_tool_pixi() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest = tmp.path().join("pyproject.toml");
        std::fs::write(
            &manifest,
            "[project]\nname=\"x\"\nversion=\"0.0.1\"\n\n[tool.pixi]\nchannels=[\"conda-forge\"]\n",
        )
        .unwrap();
        let notebook = tmp.path().join("nb.ipynb");
        std::fs::write(&notebook, "{}").unwrap();
        assert_eq!(
            locate_pixi_manifest_with_home(&notebook, None),
            Some(manifest)
        );
    }

    #[test]
    fn locate_pixi_manifest_prefers_pixi_toml_over_bare_pyproject() {
        // A directory with both a bare `pyproject.toml` (no [tool.pixi])
        // and a `pixi.toml` should resolve to the pixi.toml.
        let tmp = tempfile::tempdir().unwrap();
        let pyproject = tmp.path().join("pyproject.toml");
        std::fs::write(&pyproject, "[project]\nname=\"x\"\nversion=\"0.0.1\"\n").unwrap();
        let pixi_toml = tmp.path().join("pixi.toml");
        std::fs::write(&pixi_toml, "[project]\nname=\"y\"\n").unwrap();
        let notebook = tmp.path().join("nb.ipynb");
        std::fs::write(&notebook, "{}").unwrap();
        assert_eq!(
            locate_pixi_manifest_with_home(&notebook, None),
            Some(pixi_toml)
        );
    }

    #[test]
    fn locate_pixi_manifest_skips_bare_pyproject() {
        let tmp = tempfile::tempdir().unwrap();
        let manifest = tmp.path().join("pyproject.toml");
        std::fs::write(&manifest, "[project]\nname=\"x\"\nversion=\"0.0.1\"\n").unwrap();
        let notebook = tmp.path().join("nb.ipynb");
        std::fs::write(&notebook, "{}").unwrap();
        assert_eq!(locate_pixi_manifest_with_home(&notebook, None), None);
    }

    #[test]
    fn locate_pixi_manifest_prefers_pyproject_with_tool_pixi_over_sibling_pixi_toml() {
        // Matches the launch path: `find_nearest_project_file` returns
        // pyproject (with [tool.pixi]) before pixi.toml at the same level,
        // and the launch activates THAT pyproject as the pixi project.
        // The probe must target the same manifest, or the frozen decision
        // applies to the wrong env.
        let tmp = tempfile::tempdir().unwrap();
        let pyproject = tmp.path().join("pyproject.toml");
        std::fs::write(
            &pyproject,
            "[project]\nname=\"x\"\nversion=\"0.0.1\"\n\n[tool.pixi]\nchannels=[\"conda-forge\"]\n",
        )
        .unwrap();
        let pixi_toml = tmp.path().join("pixi.toml");
        std::fs::write(&pixi_toml, "[project]\nname=\"y\"\n").unwrap();
        let notebook = tmp.path().join("nb.ipynb");
        std::fs::write(&notebook, "{}").unwrap();
        assert_eq!(
            locate_pixi_manifest_with_home(&notebook, None),
            Some(pyproject)
        );
    }

    #[test]
    fn locate_pixi_manifest_prefers_closer_pyproject_over_ancestor_pixi_toml() {
        // Nested layout: ancestor has pixi.toml, nested dir has
        // pyproject.toml with [tool.pixi]. The launch path activates the
        // nested project (closer wins), so the probe must too.
        let tmp = tempfile::tempdir().unwrap();
        let ancestor_pixi = tmp.path().join("pixi.toml");
        std::fs::write(&ancestor_pixi, "[project]\nname=\"outer\"\n").unwrap();
        let nested_dir = tmp.path().join("nested");
        std::fs::create_dir_all(&nested_dir).unwrap();
        let nested_pyproject = nested_dir.join("pyproject.toml");
        std::fs::write(
            &nested_pyproject,
            "[project]\nname=\"inner\"\nversion=\"0.0.1\"\n\n[tool.pixi]\nchannels=[\"conda-forge\"]\n",
        )
        .unwrap();
        let notebook = nested_dir.join("nb.ipynb");
        std::fs::write(&notebook, "{}").unwrap();
        assert_eq!(
            locate_pixi_manifest_with_home(&notebook, None),
            Some(nested_pyproject)
        );
    }

    #[test]
    fn pixi_network_failure_format_trips_is_network_failure() {
        // Captured from `pixi shell-hook` against an unresolvable channel
        // host. rattler bubbles up reqwest's error chain, so the markers
        // overlap with uv's despite the different surface tooling.
        let stderr = "Error:   × failed to solve requirements of environment 'default'
  ├─▶   × Request failed after 3 retries
  ├─▶ error sending request for url (https://no-such-host.invalid/conda)
  ├─▶ client error (Connect)
  ├─▶ dns error
  ├─▶ failed to lookup address information: nodename nor servname provided";
        assert!(is_network_failure(stderr));
    }
}
