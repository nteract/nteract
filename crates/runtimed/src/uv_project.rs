//! Helpers for `uv:pyproject` launches.
//!
//! Project-backed UV kernels use `uv run` directly instead of a daemon-owned
//! cached environment. Keep the command construction here so the daemon-side
//! prepare probe and the runtime-agent kernel launch cannot drift.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Instant;

use anyhow::{Context, Result};
use kernel_env::{EnvProgressPhase, ProgressHandler};
use tokio::process::Command;
use tracing::{info, warn};

use crate::terminal_size::{TERMINAL_COLUMNS_STR, TERMINAL_LINES_STR};

pub(crate) fn notebook_working_dir(notebook_path: Option<&Path>) -> PathBuf {
    if let Some(path) = notebook_path {
        if path.is_dir() {
            path.to_path_buf()
        } else {
            path.parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(std::env::temp_dir)
        }
    } else {
        runt_workspace::default_notebooks_dir().unwrap_or_else(|_| std::env::temp_dir())
    }
}

fn uv_run_base_args(offline: bool) -> Vec<OsString> {
    let mut args = vec!["run".into()];
    if offline {
        args.push("--offline".into());
    }
    args.extend([
        OsString::from("--with"),
        OsString::from("ipykernel"),
        OsString::from("--with"),
        OsString::from("uv"),
    ]);
    args
}

pub(crate) fn uv_pyproject_prepare_args(offline: bool) -> Vec<OsString> {
    let mut args = uv_run_base_args(offline);
    args.extend([
        OsString::from("python"),
        OsString::from("-Xfrozen_modules=off"),
        OsString::from("-c"),
        OsString::from("import ipykernel"),
    ]);
    args
}

pub(crate) fn uv_pyproject_kernel_args(
    bootstrap_dx: bool,
    connection_file: &Path,
) -> Vec<OsString> {
    let mut args = uv_run_base_args(false);
    let launcher_module = if bootstrap_dx {
        "nteract_kernel_launcher"
    } else {
        "ipykernel_launcher"
    };
    args.extend([
        OsString::from("python"),
        OsString::from("-Xfrozen_modules=off"),
        OsString::from("-m"),
        OsString::from(launcher_module),
        OsString::from("-f"),
        connection_file.as_os_str().to_owned(),
    ]);
    args
}

pub(crate) async fn apply_bootstrap_pythonpath(cmd: &mut Command) -> Result<()> {
    let dir = crate::launcher_cache::launcher_cache_dir().await?;
    cmd.env("PYTHONPATH", &dir);
    Ok(())
}

fn display_output(output: &[u8]) -> String {
    String::from_utf8_lossy(output).trim().to_string()
}

/// Returns true when uv stderr looks like a transient network or DNS failure
/// that can be retried with `--offline` against the local cache.
pub(crate) fn is_network_failure(stderr: &str) -> bool {
    let lower = stderr.to_ascii_lowercase();
    [
        "failed to fetch",
        "error sending request",
        "client error (connect)",
        "dns error",
        "failed to lookup address",
        "network is unreachable",
        "temporary failure in name resolution",
        "no address associated with hostname",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn command_failure_message(
    status: std::process::ExitStatus,
    output: std::process::Output,
) -> String {
    let stderr = display_output(&output.stderr);
    let stdout = display_output(&output.stdout);
    let detail = if stderr.is_empty() {
        stdout
    } else if stdout.is_empty() {
        stderr
    } else {
        format!("{stderr}\n{stdout}")
    };

    if detail.is_empty() {
        format!("uv project environment preparation failed with {status}")
    } else {
        format!("uv project environment preparation failed with {status}: {detail}")
    }
}

/// Env vars that switch `uv run` into offline mode for the kernel launch.
/// Returned alongside the prepare outcome so callers can pass them through
/// the `LaunchKernel`/`RestartKernel` RPC's `env_vars` map without losing
/// the offline decision between daemon and runtime agent.
pub(crate) fn uv_offline_env_vars(offline: bool) -> std::collections::HashMap<String, String> {
    let mut env = std::collections::HashMap::new();
    if offline {
        env.insert("UV_OFFLINE".to_string(), "1".to_string());
    }
    env
}

/// Returns `Ok(true)` when the probe required the `--offline` retry to
/// succeed, signaling the caller that the kernel launch must also run with
/// `UV_OFFLINE=1` so `uv run` does not re-resolve against the index.
pub(crate) async fn prepare_uv_pyproject_environment(
    notebook_path: Option<&Path>,
    bootstrap_dx: bool,
    progress_handler: Arc<dyn ProgressHandler>,
) -> Result<bool> {
    let cwd = notebook_working_dir(notebook_path);
    let project_path = notebook_path
        .and_then(|path| {
            crate::project_file::find_nearest_project_file(
                path,
                &[crate::project_file::ProjectFileKind::PyprojectToml],
            )
        })
        .map(|detected| detected.path)
        .unwrap_or_else(|| cwd.join("pyproject.toml"));
    let project_path_label = project_path.display().to_string();

    progress_handler.on_progress(
        "uv",
        EnvProgressPhase::ProjectPreparing {
            source: "uv:pyproject".to_string(),
            project_path: project_path_label.clone(),
        },
    );

    let uv_path = kernel_launch::tools::get_uv_path()
        .await
        .context("failed to locate uv executable")?;

    info!(
        "[uv-project] Preparing UV project environment: project={} cwd={} bootstrap_dx={}",
        project_path_label,
        cwd.display(),
        bootstrap_dx
    );
    let started = Instant::now();
    let output = run_prepare_probe(&uv_path, &cwd, bootstrap_dx, false).await?;

    if output.status.success() {
        info!(
            "[uv-project] UV project environment ready: project={} elapsed_ms={}",
            project_path_label,
            started.elapsed().as_millis()
        );
        return Ok(false);
    }

    let stderr = String::from_utf8_lossy(&output.stderr);
    if is_network_failure(&stderr) {
        warn!(
            "[uv-project] uv prepare hit network failure; retrying offline: project={} stderr={}",
            project_path_label,
            stderr.trim()
        );
        let retry = run_prepare_probe(&uv_path, &cwd, bootstrap_dx, true).await?;
        if retry.status.success() {
            info!(
                "[uv-project] UV project environment ready from local cache (offline): project={} elapsed_ms={}",
                project_path_label,
                started.elapsed().as_millis()
            );
            return Ok(true);
        }
        // Offline retry failed too. Surface the original network error: it
        // points at the actual cause (no internet) rather than a misleading
        // "package not in cache" miss from the retry.
    }

    Err(anyhow::anyhow!(command_failure_message(
        output.status,
        output
    )))
}

async fn run_prepare_probe(
    uv_path: &Path,
    cwd: &Path,
    bootstrap_dx: bool,
    offline: bool,
) -> Result<std::process::Output> {
    let mut cmd = Command::new(uv_path);
    cmd.args(uv_pyproject_prepare_args(offline));
    cmd.current_dir(cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.env("COLUMNS", TERMINAL_COLUMNS_STR);
    cmd.env("LINES", TERMINAL_LINES_STR);
    if bootstrap_dx {
        apply_bootstrap_pythonpath(&mut cmd).await?;
    }
    cmd.output().await.with_context(|| {
        format!(
            "failed to run uv project prepare probe in {}",
            cwd.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_to_strings(args: Vec<OsString>) -> Vec<String> {
        args.into_iter()
            .map(|arg| arg.to_string_lossy().into_owned())
            .collect()
    }

    #[test]
    fn prepare_args_include_base_uv_packages() {
        assert_eq!(
            args_to_strings(uv_pyproject_prepare_args(false)),
            vec![
                "run",
                "--with",
                "ipykernel",
                "--with",
                "uv",
                "python",
                "-Xfrozen_modules=off",
                "-c",
                "import ipykernel",
            ]
        );
    }

    #[test]
    fn prepare_args_with_offline_inserts_flag_after_run() {
        assert_eq!(
            args_to_strings(uv_pyproject_prepare_args(true)),
            vec![
                "run",
                "--offline",
                "--with",
                "ipykernel",
                "--with",
                "uv",
                "python",
                "-Xfrozen_modules=off",
                "-c",
                "import ipykernel",
            ]
        );
    }

    #[test]
    fn is_network_failure_matches_screenshot_dns_error() {
        let stderr = r"Failed to prepare UV project environment: uv project environment preparation failed with exit status: 2: error: Request failed after 3 retries
  Caused by: Failed to fetch: `https://pypi.org/simple/ipykernel/`
  Caused by: error sending request for url (https://pypi.org/simple/ipykernel/)
  Caused by: client error (Connect)
  Caused by: dns error
  Caused by: failed to lookup address information: nodename nor servname provided, or not known";
        assert!(is_network_failure(stderr));
    }

    #[test]
    fn uv_offline_env_vars_set_uv_offline_when_true() {
        let on = uv_offline_env_vars(true);
        assert_eq!(on.get("UV_OFFLINE"), Some(&"1".to_string()));
        assert_eq!(on.len(), 1);
        assert!(uv_offline_env_vars(false).is_empty());
    }

    #[test]
    fn is_network_failure_ignores_unrelated_errors() {
        assert!(!is_network_failure(
            "error: Failed to parse `pyproject.toml`\n  Caused by: TOML parse error"
        ));
        assert!(!is_network_failure(
            "error: Distribution `ipykernel` was not found in the package registry"
        ));
        assert!(!is_network_failure(""));
    }

    #[test]
    fn kernel_args_match_prepare_prefix_and_launch_ipykernel() {
        let args = args_to_strings(uv_pyproject_kernel_args(
            false,
            Path::new("/tmp/kernel.json"),
        ));
        assert_eq!(
            args,
            vec![
                "run",
                "--with",
                "ipykernel",
                "--with",
                "uv",
                "python",
                "-Xfrozen_modules=off",
                "-m",
                "ipykernel_launcher",
                "-f",
                "/tmp/kernel.json",
            ]
        );
    }

    #[test]
    fn kernel_args_use_nteract_launcher_with_bootstrap_dx() {
        let args = args_to_strings(uv_pyproject_kernel_args(
            true,
            Path::new("/tmp/kernel.json"),
        ));
        assert_eq!(
            args,
            vec![
                "run",
                "--with",
                "ipykernel",
                "--with",
                "uv",
                "python",
                "-Xfrozen_modules=off",
                "-m",
                "nteract_kernel_launcher",
                "-f",
                "/tmp/kernel.json",
            ]
        );
    }
}
