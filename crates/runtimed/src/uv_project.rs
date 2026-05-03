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
use tracing::info;

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

fn uv_run_base_args(bootstrap_dx: bool) -> Vec<OsString> {
    let mut args = vec![
        "run".into(),
        "--with".into(),
        "ipykernel".into(),
        "--with".into(),
        "uv".into(),
    ];
    if bootstrap_dx {
        args.push("--with".into());
        args.push("dx".into());
    }
    args
}

pub(crate) fn uv_pyproject_prepare_args(bootstrap_dx: bool) -> Vec<OsString> {
    let mut args = uv_run_base_args(bootstrap_dx);
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
    let mut args = uv_run_base_args(bootstrap_dx);
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

pub(crate) async fn prepare_uv_pyproject_environment(
    notebook_path: Option<&Path>,
    bootstrap_dx: bool,
    progress_handler: Arc<dyn ProgressHandler>,
) -> Result<()> {
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
    let mut cmd = Command::new(&uv_path);
    cmd.args(uv_pyproject_prepare_args(bootstrap_dx));
    cmd.current_dir(&cwd);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.env("COLUMNS", TERMINAL_COLUMNS_STR);
    cmd.env("LINES", TERMINAL_LINES_STR);
    if bootstrap_dx {
        apply_bootstrap_pythonpath(&mut cmd).await?;
        cmd.env("RUNT_BOOTSTRAP_DX", "1");
    }

    info!(
        "[uv-project] Preparing UV project environment: project={} cwd={} bootstrap_dx={}",
        project_path_label,
        cwd.display(),
        bootstrap_dx
    );
    let started = Instant::now();
    let output = cmd.output().await.with_context(|| {
        format!(
            "failed to run uv project prepare probe in {}",
            cwd.display()
        )
    })?;

    if output.status.success() {
        info!(
            "[uv-project] UV project environment ready: project={} elapsed_ms={}",
            project_path_label,
            started.elapsed().as_millis()
        );
        Ok(())
    } else {
        Err(anyhow::anyhow!(command_failure_message(
            output.status,
            output
        )))
    }
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
    fn prepare_args_include_dx_when_bootstrap_is_enabled() {
        assert_eq!(
            args_to_strings(uv_pyproject_prepare_args(true)),
            vec![
                "run",
                "--with",
                "ipykernel",
                "--with",
                "uv",
                "--with",
                "dx",
                "python",
                "-Xfrozen_modules=off",
                "-c",
                "import ipykernel",
            ]
        );
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
                "--with",
                "dx",
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
