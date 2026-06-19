//! Subprocess entry point for pool environment warming.
//!
//! The `warm-env` subcommand runs as a short-lived child process spawned by the
//! daemon's warming loops. It creates one environment (UV, Conda, or Pixi),
//! writes structured JSON events to stdout, and exits. All of rattler's
//! in-process memory is reclaimed by the OS when the process exits.

use std::io;
use std::path::{Path, PathBuf};
use std::process::{Output, Stdio};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tracing::{error, info, warn};

use crate::async_outcome::TimedResult;
use crate::EnvType;

// -- IPC protocol --------------------------------------------------------
//
// stdin:  single JSON object (WarmEnvConfig) - all arguments for the run
// stdout: newline-delimited JSON events (WarmEnvEvent) - progress + result

#[derive(Debug, Serialize, Deserialize)]
pub struct WarmEnvConfig {
    pub env_type: EnvType,
    pub env_dir: PathBuf,
    pub packages: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
}

// -- stdout events -------------------------------------------------------

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum WarmEnvEvent {
    Progress { phase: String, detail: String },
    Result(WarmEnvResult),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WarmEnvResult {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub python_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub venv_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_kind: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failed_package: Option<String>,
}

// -- helpers --------------------------------------------------------------

fn emit(event: &WarmEnvEvent) {
    if let Ok(json) = serde_json::to_string(event) {
        let mut stdout = std::io::stdout();
        let _ = std::io::Write::write_all(&mut stdout, json.as_bytes());
        let _ = std::io::Write::write_all(&mut stdout, b"\n");
        let _ = std::io::Write::flush(&mut stdout);
    }
}

fn progress(phase: &str, detail: &str) {
    emit(&WarmEnvEvent::Progress {
        phase: phase.into(),
        detail: detail.into(),
    });
}

fn success_result(python_path: PathBuf, venv_path: PathBuf) -> WarmEnvResult {
    WarmEnvResult {
        success: true,
        python_path: Some(python_path),
        venv_path: Some(venv_path),
        error: None,
        error_kind: None,
        failed_package: None,
    }
}

fn failure_result(
    error: String,
    error_kind: &str,
    failed_package: Option<String>,
) -> WarmEnvResult {
    WarmEnvResult {
        success: false,
        python_path: None,
        venv_path: None,
        error: Some(error),
        error_kind: Some(error_kind.into()),
        failed_package,
    }
}

fn emit_success(python_path: PathBuf, venv_path: PathBuf) {
    emit(&WarmEnvEvent::Result(success_result(
        python_path,
        venv_path,
    )));
}

fn emit_failure(error: String, error_kind: &str, failed_package: Option<String>) {
    emit(&WarmEnvEvent::Result(failure_result(
        error,
        error_kind,
        failed_package,
    )));
}

// -- package hash (shared with daemon's find_existing_environments) -------

const POOL_PACKAGE_HASH_FILE: &str = ".runt-pool-packages.sha256";
const POOL_PACKAGE_HASH_VERSION: &str = "v1";
const POOL_READY_MARKER_FILE: &str = ".runt-pool-ready";

fn expected_pool_package_hash(env_type: EnvType, packages: &[String]) -> String {
    use sha2::{Digest, Sha256};
    let mut sorted = packages.to_vec();
    sorted.sort();

    let mut hasher = Sha256::new();
    hasher.update(POOL_PACKAGE_HASH_VERSION.as_bytes());
    hasher.update(b"\n");
    hasher.update(env_type.to_string().as_bytes());
    hasher.update(b"\n");
    hasher.update(std::env::consts::OS.as_bytes());
    hasher.update(b"\n");
    hasher.update(std::env::consts::ARCH.as_bytes());
    hasher.update(b"\n");
    for package in sorted {
        hasher.update(package.as_bytes());
        hasher.update(b"\n");
    }
    hex::encode(hasher.finalize())
}

async fn write_pool_package_hash(
    env_root: &Path,
    env_type: EnvType,
    packages: &[String],
) -> std::io::Result<()> {
    tokio::fs::write(
        env_root.join(POOL_PACKAGE_HASH_FILE),
        expected_pool_package_hash(env_type, packages),
    )
    .await
}

async fn write_pool_ready_marker(env_root: &Path) -> std::io::Result<()> {
    tokio::fs::write(env_root.join(POOL_READY_MARKER_FILE), "").await
}

// -- site-packages discovery ----------------------------------------------

fn find_site_packages(env_path: &Path) -> Option<String> {
    let lib_dir = env_path.join("lib");
    std::fs::read_dir(&lib_dir).ok().and_then(|entries| {
        entries.flatten().find_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?;
            if name.starts_with("python") {
                let sp = path.join("site-packages");
                sp.is_dir().then(|| sp.to_string_lossy().into_owned())
            } else {
                None
            }
        })
    })
}

// -- UV env creation ------------------------------------------------------

const UV_OFFLINE_INSTALL_TIMEOUT: Duration = Duration::from_secs(30);
const UV_ONLINE_INSTALL_TIMEOUT: Duration = Duration::from_secs(180);
const UV_VENV_TIMEOUT: Duration = Duration::from_secs(60);
const PYTHON_RUNTIME_VALIDATION_TIMEOUT: Duration = Duration::from_secs(60);
// Keep optional warming below the daemon's 120s pool-take wait. Long compileall
// runs should not keep a validated environment out of the pool.
const PYTHON_WARMUP_TIMEOUT: Duration = Duration::from_secs(30);

fn uv_pip_install_args(python_path: &Path, packages: &[String], offline: bool) -> Vec<String> {
    let mut args = vec![
        "pip".to_string(),
        "install".to_string(),
        "--link-mode".to_string(),
        "hardlink".to_string(),
        "--python".to_string(),
        python_path.to_string_lossy().to_string(),
    ];
    if offline {
        args.push("--offline".to_string());
    }
    args.extend(packages.iter().cloned());
    args
}

enum UvInstallAttempt {
    Completed(std::process::Output),
    SpawnError(std::io::Error),
    Timeout,
}

async fn run_uv_pip_install(
    uv_path: &Path,
    install_args: &[String],
    timeout: Duration,
) -> UvInstallAttempt {
    let mut command = tokio::process::Command::new(uv_path);
    command.args(install_args);

    match run_output_with_timeout(command, timeout).await {
        TimedResult::Completed(output) => UvInstallAttempt::Completed(output),
        TimedResult::Failed(e) => UvInstallAttempt::SpawnError(e),
        TimedResult::TimedOut => UvInstallAttempt::Timeout,
    }
}

async fn read_pipe_to_end<R>(mut reader: R) -> io::Result<Vec<u8>>
where
    R: tokio::io::AsyncRead + Unpin,
{
    use tokio::io::AsyncReadExt;

    let mut output = Vec::new();
    reader.read_to_end(&mut output).await?;
    Ok(output)
}

async fn collect_reader(
    handle: tokio::task::JoinHandle<io::Result<Vec<u8>>>,
) -> io::Result<Vec<u8>> {
    handle.await.map_err(|error| {
        io::Error::new(
            io::ErrorKind::Other,
            format!("failed to join child output reader: {error}"),
        )
    })?
}

async fn run_output_with_timeout(
    mut command: tokio::process::Command,
    timeout: Duration,
) -> TimedResult<Output, io::Error> {
    command
        .kill_on_drop(true)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => return TimedResult::Failed(error),
    };

    let stdout = child
        .stdout
        .take()
        .map(|pipe| tokio::spawn(read_pipe_to_end(pipe)));
    let stderr = child
        .stderr
        .take()
        .map(|pipe| tokio::spawn(read_pipe_to_end(pipe)));

    let status = match tokio::time::timeout(timeout, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => return TimedResult::Failed(error),
        Err(_) => {
            // Dropping `Command::output()` on timeout can leave the spawned
            // process running. Keep ownership of the child handle and kill it
            // before reporting the timeout so warmup retries do not accumulate
            // orphaned Python processes.
            let _ = child.kill().await;
            let _ = child.wait().await;
            if let Some(stdout) = stdout {
                let _ = collect_reader(stdout).await;
            }
            if let Some(stderr) = stderr {
                let _ = collect_reader(stderr).await;
            }
            return TimedResult::TimedOut;
        }
    };

    let stdout = match stdout {
        Some(stdout) => match collect_reader(stdout).await {
            Ok(output) => output,
            Err(error) => return TimedResult::Failed(error),
        },
        None => Vec::new(),
    };
    let stderr = match stderr {
        Some(stderr) => match collect_reader(stderr).await {
            Ok(output) => output,
            Err(error) => return TimedResult::Failed(error),
        },
        None => Vec::new(),
    };

    TimedResult::Completed(Output {
        status,
        stdout,
        stderr,
    })
}

fn stderr_excerpt(output: &Output) -> String {
    String::from_utf8_lossy(&output.stderr)
        .chars()
        .take(200)
        .collect::<String>()
}

async fn run_python_script(
    python_path: &Path,
    script: &str,
    timeout: Duration,
) -> TimedResult<Output, io::Error> {
    let mut command = tokio::process::Command::new(python_path);
    command.args(["-c", script]);
    run_output_with_timeout(command, timeout).await
}

async fn validate_python_runtime(
    python_path: &Path,
    env_label: &str,
) -> Result<(), (String, &'static str)> {
    let validation_script = kernel_env::warmup::build_warmup_command(&[], false, None);

    match run_python_script(
        python_path,
        &validation_script,
        PYTHON_RUNTIME_VALIDATION_TIMEOUT,
    )
    .await
    {
        TimedResult::Completed(output) if output.status.success() => Ok(()),
        TimedResult::Completed(output) => Err((
            format!(
                "{env_label} runtime validation failed: {}",
                stderr_excerpt(&output)
            ),
            "import_error",
        )),
        TimedResult::Failed(error) => Err((
            format!("{env_label} runtime validation failed: {error}"),
            "import_error",
        )),
        TimedResult::TimedOut => Err((
            format!(
                "{env_label} runtime validation timed out after {} seconds",
                PYTHON_RUNTIME_VALIDATION_TIMEOUT.as_secs()
            ),
            "timeout",
        )),
    }
}

async fn run_best_effort_python_warmup(
    env_dir: &Path,
    python_path: &Path,
    packages: &[String],
    include_conda: bool,
    env_label: &str,
) {
    let site_packages = find_site_packages(env_dir);
    let warmup_script =
        kernel_env::warmup::build_warmup_command(packages, include_conda, site_packages.as_deref());

    match run_python_script(python_path, &warmup_script, PYTHON_WARMUP_TIMEOUT).await {
        TimedResult::Completed(output) if output.status.success() => {
            tokio::fs::write(env_dir.join(".warmed"), "").await.ok();
        }
        TimedResult::Completed(output) => {
            warn!(
                "[warm-env] {env_label} warmup failed; keeping validated environment usable without .warmed marker: {}",
                stderr_excerpt(&output)
            );
        }
        TimedResult::Failed(error) => {
            warn!(
                "[warm-env] {env_label} warmup failed; keeping validated environment usable without .warmed marker: {error}"
            );
        }
        TimedResult::TimedOut => {
            // The pool warmer is already a background optimization. Detaching
            // compileall/import work after this point would race with env
            // claims, eviction, and cleanup, so keep it bounded and admit the
            // validated env without the warmed marker when it runs long.
            warn!(
                "[warm-env] {env_label} warmup timed out after {} seconds; keeping validated environment usable without .warmed marker",
                PYTHON_WARMUP_TIMEOUT.as_secs()
            );
        }
    }
}

fn parse_uv_error(stderr: &str) -> Option<(String, String, Option<String>)> {
    let stderr_lower = stderr.to_lowercase();
    let pkg_patterns = [
        (r"package `([^`]+)`", '`'),
        (r"package '([^']+)'", '\''),
        (r"because ([a-z0-9_-]+) was not found", ' '),
        (r"no matching distribution found for ([a-z0-9_-]+)", ' '),
        (r"failed to download `([^`]+)`", '`'),
        (r"failed to download '([^']+)'", '\''),
    ];

    for (pattern, _) in &pkg_patterns {
        if let Ok(re) = regex::Regex::new(pattern) {
            if let Some(caps) = re.captures(&stderr_lower) {
                if let Some(pkg) = caps.get(1) {
                    let package_name = pkg.as_str().to_string();
                    if package_name != "ipykernel"
                        && package_name != "ipywidgets"
                        && package_name != "anywidget"
                    {
                        return Some((
                            stderr.to_string(),
                            "invalid_package".to_string(),
                            Some(package_name),
                        ));
                    }
                }
            }
        }
    }

    if stderr.contains("error") || stderr.contains("failed") || stderr.contains("not found") {
        return Some((stderr.to_string(), "setup_failed".to_string(), None));
    }

    None
}

async fn create_uv(env_dir: &Path, packages: &[String]) {
    progress("bootstrap", "getting uv path");
    let uv_path = match kernel_launch::tools::get_uv_path().await {
        Ok(path) => path,
        Err(e) => {
            emit_failure(format!("Failed to get uv path: {e}"), "setup_failed", None);
            return;
        }
    };

    #[cfg(target_os = "windows")]
    let python_path = env_dir.join("Scripts").join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python_path = env_dir.join("bin").join("python");

    if let Some(parent) = env_dir.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            emit_failure(
                format!("Failed to create cache dir: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    }

    // Create venv
    progress("venv", "creating virtual environment");
    let mut venv_command = tokio::process::Command::new(&uv_path);
    venv_command
        .arg("venv")
        .arg(env_dir)
        .arg("--python")
        .arg("3.13");
    let venv_result = run_output_with_timeout(venv_command, UV_VENV_TIMEOUT).await;

    match venv_result {
        TimedResult::Completed(output) if output.status.success() => {}
        TimedResult::Completed(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            emit_failure(
                format!("Failed to create venv: {stderr}"),
                "setup_failed",
                None,
            );
            return;
        }
        TimedResult::Failed(e) => {
            emit_failure(format!("Failed to create venv: {e}"), "setup_failed", None);
            return;
        }
        TimedResult::TimedOut => {
            emit_failure(
                "Timeout creating venv after 60 seconds".into(),
                "timeout",
                None,
            );
            return;
        }
    }

    // Install packages (offline-first, fallback to network)
    progress("installing", &format!("{} packages", packages.len()));
    let offline_args = uv_pip_install_args(&python_path, packages, true);
    let install_result =
        match run_uv_pip_install(&uv_path, &offline_args, UV_OFFLINE_INSTALL_TIMEOUT).await {
            UvInstallAttempt::Completed(output) if output.status.success() => {
                info!("[warm-env] UV packages installed from local cache (offline mode)");
                UvInstallAttempt::Completed(output)
            }
            UvInstallAttempt::Completed(_)
            | UvInstallAttempt::SpawnError(_)
            | UvInstallAttempt::Timeout => {
                let args = uv_pip_install_args(&python_path, packages, false);
                run_uv_pip_install(&uv_path, &args, UV_ONLINE_INSTALL_TIMEOUT).await
            }
        };

    match install_result {
        UvInstallAttempt::Completed(output) if output.status.success() => {}
        UvInstallAttempt::Completed(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some((error, kind, pkg)) = parse_uv_error(&stderr) {
                cleanup_and_fail(env_dir, error, &kind, pkg).await;
            } else {
                cleanup_and_fail(env_dir, stderr.to_string(), "setup_failed", None).await;
            }
            return;
        }
        UvInstallAttempt::SpawnError(e) => {
            cleanup_and_fail(env_dir, e.to_string(), "setup_failed", None).await;
            return;
        }
        UvInstallAttempt::Timeout => {
            cleanup_and_fail(env_dir, "Timeout after 180 seconds".into(), "timeout", None).await;
            return;
        }
    }

    // Vendor kernel launcher
    progress("vendor", "vendoring kernel launcher");
    if let Err(e) = kernel_env::launcher::vendor_into_venv(&python_path).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to vendor nteract_kernel_launcher: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Required runtime validation comes before the expensive best-effort
    // warmup. The env should not enter the pool if core kernel imports hang or
    // fail, but compileall/import warming is only a performance optimization.
    progress("validating", "checking kernel imports");
    if let Err((error, kind)) = validate_python_runtime(&python_path, "UV").await {
        cleanup_and_fail(env_dir, error, kind, None).await;
        return;
    }
    if let Err(e) = write_pool_ready_marker(env_dir).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to write pool readiness marker: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Warmup (.pyc compilation)
    progress("warming", "compiling .pyc files");
    run_best_effort_python_warmup(env_dir, &python_path, packages, false, "UV").await;

    // Write package hash marker
    if let Err(e) = write_pool_package_hash(env_dir, EnvType::Uv, packages).await {
        warn!("[warm-env] Failed to write UV pool package marker: {e}");
    }
    emit_success(python_path, env_dir.to_path_buf());
}

// -- Conda env creation ---------------------------------------------------

async fn create_conda(env_dir: &Path, packages: &[String], channels: &[String]) {
    use rattler::install::Installer;
    use rattler_conda_types::{
        Channel, ChannelConfig, GenericVirtualPackage, MatchSpec, ParseMatchSpecOptions, Platform,
    };
    use rattler_solve::{resolvo, SolverImpl, SolverTask};

    #[cfg(target_os = "windows")]
    let python_path = env_dir.join("python.exe");
    #[cfg(not(target_os = "windows"))]
    let python_path = env_dir.join("bin").join("python");

    if let Some(parent) = env_dir.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            emit_failure(
                format!("Failed to create cache dir: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    }

    // Setup channel configuration
    let cache_dir = env_dir.parent().unwrap_or(env_dir).to_path_buf();
    let channel_config = ChannelConfig::default_with_root_dir(cache_dir);

    progress("channels", "parsing channels");
    let channel_names = if channels.is_empty() {
        vec!["conda-forge".to_string()]
    } else {
        channels.to_vec()
    };
    let channels = match channel_names
        .iter()
        .map(|channel| Channel::from_str(channel, &channel_config))
        .collect::<Result<Vec<_>, _>>()
    {
        Ok(channels) => channels,
        Err(e) => {
            emit_failure(
                format!("Failed to parse conda channel: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    // Build specs
    progress("specs", "building dependency specs");
    let match_spec_options = ParseMatchSpecOptions::strict();
    let specs: Vec<MatchSpec> = match (|| -> anyhow::Result<Vec<MatchSpec>> {
        let mut specs = vec![MatchSpec::from_str("python>=3.13", match_spec_options)?];
        specs.push(MatchSpec::from_str("python-gil", match_spec_options)?);
        for pkg in packages {
            specs.push(MatchSpec::from_str(pkg, match_spec_options)?);
        }
        Ok(specs)
    })() {
        Ok(s) => s,
        Err(e) => {
            emit_failure(
                format!("Failed to parse match specs: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    // Rattler cache
    let rattler_cache_dir = match rattler::default_cache_dir() {
        Ok(dir) => dir,
        Err(e) => {
            emit_failure(
                format!("Could not determine rattler cache directory: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };
    if let Err(e) = rattler_cache::ensure_cache_dir(&rattler_cache_dir) {
        emit_failure(
            format!("Could not create rattler cache directory: {e}"),
            "setup_failed",
            None,
        );
        return;
    }

    // HTTP client
    let download_client = match reqwest::Client::builder().build() {
        Ok(c) => reqwest_middleware::ClientBuilder::new(c).build(),
        Err(e) => {
            emit_failure(
                format!("Failed to create HTTP client: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    let install_platform = Platform::current();
    let platforms = vec![install_platform, Platform::NoArch];
    let progress_handler = std::sync::Arc::new(kernel_env::LogHandler);

    // Fetch repodata
    progress("resolving", "fetching repodata from cache or conda-forge");
    let repo_data = match kernel_env::repodata::query_repodata_offline_first(
        channels,
        platforms,
        specs.clone(),
        &rattler_cache_dir,
        download_client.clone(),
        progress_handler,
        "conda",
    )
    .await
    {
        Ok(data) => data,
        Err(e) => {
            emit_failure(
                format!("Failed to fetch repodata: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    // Detect virtual packages
    let virtual_packages = match rattler_virtual_packages::VirtualPackage::detect(
        &rattler_virtual_packages::VirtualPackageOverrides::default(),
    ) {
        Ok(vps) => vps
            .iter()
            .map(|vpkg| GenericVirtualPackage::from(vpkg.clone()))
            .collect::<Vec<_>>(),
        Err(e) => {
            emit_failure(
                format!("Failed to detect virtual packages: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    // Solve
    progress("resolving", "solving dependencies");
    let solver_task = SolverTask {
        virtual_packages,
        specs,
        ..SolverTask::from_iter(&repo_data)
    };
    let required_packages = match resolvo::Solver.solve(solver_task) {
        Ok(result) => result.records,
        Err(e) => {
            emit_failure(
                format!("Failed to solve dependencies: {e}"),
                "invalid_package",
                None,
            );
            return;
        }
    };

    // Install
    progress(
        "installing",
        &format!("{} packages", required_packages.len()),
    );
    if let Err(e) = Installer::new()
        .with_download_client(download_client)
        .with_target_platform(install_platform)
        .install(env_dir, required_packages)
        .await
    {
        cleanup_and_fail(
            env_dir,
            format!("Failed to install packages: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Verify python
    if !python_path.exists() {
        cleanup_and_fail(
            env_dir,
            format!("Python not found at {python_path:?} after install"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Vendor kernel launcher
    progress("vendor", "vendoring kernel launcher");
    if let Err(e) = kernel_env::launcher::vendor_into_venv(&python_path).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to vendor nteract_kernel_launcher: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    progress("validating", "checking kernel imports");
    if let Err((error, kind)) = validate_python_runtime(&python_path, "Conda").await {
        cleanup_and_fail(env_dir, error, kind, None).await;
        return;
    }
    if let Err(e) = write_pool_ready_marker(env_dir).await {
        cleanup_and_fail(
            env_dir,
            format!("Failed to write pool readiness marker: {e}"),
            "setup_failed",
            None,
        )
        .await;
        return;
    }

    // Warmup
    progress("warming", "compiling .pyc files");
    run_best_effort_python_warmup(env_dir, &python_path, packages, true, "Conda").await;

    if let Err(e) = write_pool_package_hash(env_dir, EnvType::Conda, packages).await {
        warn!("[warm-env] Failed to write Conda pool package marker: {e}");
    }
    emit_success(python_path, env_dir.to_path_buf());
}

// -- Pixi env creation ----------------------------------------------------

async fn create_pixi(project_dir: &Path, packages: &[String], channels: &[String]) {
    if let Some(parent) = project_dir.parent() {
        if let Err(e) = tokio::fs::create_dir_all(parent).await {
            emit_failure(
                format!("Failed to create cache dir: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    }

    progress("creating", "creating pixi environment");
    let handler = std::sync::Arc::new(kernel_env::LogHandler);
    let channel_list: Vec<String> = if channels.is_empty() {
        vec!["conda-forge".to_string()]
    } else {
        channels.to_vec()
    };

    match kernel_env::pixi::create_pixi_environment(project_dir, packages, &channel_list, handler)
        .await
    {
        Ok(env) => {
            progress("warming", "compiling .pyc files");
            if let Err(e) = kernel_env::pixi::warmup_environment(&env, packages).await {
                warn!("[warm-env] Pixi warmup failed (non-fatal): {e}");
            }

            if let Err(e) = write_pool_package_hash(project_dir, EnvType::Pixi, packages).await {
                warn!("[warm-env] Failed to write Pixi pool package marker: {e}");
            }
            emit_success(env.python_path, env.venv_path);
        }
        Err(e) => {
            cleanup_and_fail(
                project_dir,
                format!("Pixi environment creation failed: {e}"),
                "setup_failed",
                None,
            )
            .await;
        }
    }
}

// -- cleanup helper -------------------------------------------------------

async fn cleanup_and_fail(
    env_dir: &Path,
    error: String,
    error_kind: &str,
    failed_package: Option<String>,
) {
    error!("[warm-env] {error}");
    let _ = tokio::fs::remove_dir_all(env_dir).await;
    emit_failure(error, error_kind, failed_package);
}

// -- entry point ----------------------------------------------------------

pub async fn run() {
    use tokio::io::AsyncReadExt;

    let mut input = String::new();
    if let Err(e) = tokio::io::stdin().read_to_string(&mut input).await {
        emit_failure(
            format!("Failed to read config from stdin: {e}"),
            "setup_failed",
            None,
        );
        return;
    }

    let config: WarmEnvConfig = match serde_json::from_str(&input) {
        Ok(c) => c,
        Err(e) => {
            emit_failure(
                format!("Invalid config JSON on stdin: {e}"),
                "setup_failed",
                None,
            );
            return;
        }
    };

    match config.env_type {
        EnvType::Uv => create_uv(&config.env_dir, &config.packages).await,
        EnvType::Conda => create_conda(&config.env_dir, &config.packages, &config.channels).await,
        EnvType::Pixi => create_pixi(&config.env_dir, &config.packages, &config.channels).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn warm_env_result_success_roundtrip() {
        let result = WarmEnvResult {
            success: true,
            python_path: Some(PathBuf::from("/env/bin/python")),
            venv_path: Some(PathBuf::from("/env")),
            error: None,
            error_kind: None,
            failed_package: None,
        };
        let event = WarmEnvEvent::Result(result);
        let json = serde_json::to_string(&event).unwrap();
        let parsed: WarmEnvEvent = serde_json::from_str(&json).unwrap();
        match parsed {
            WarmEnvEvent::Result(r) => {
                assert!(r.success);
                assert_eq!(r.python_path.unwrap(), PathBuf::from("/env/bin/python"));
            }
            _ => panic!("expected Result variant"),
        }
    }

    #[test]
    fn warm_env_result_failure_roundtrip() {
        let result = WarmEnvResult {
            success: false,
            python_path: None,
            venv_path: None,
            error: Some("bad package".into()),
            error_kind: Some("invalid_package".into()),
            failed_package: Some("bogus-pkg".into()),
        };
        let event = WarmEnvEvent::Result(result);
        let json = serde_json::to_string(&event).unwrap();
        let parsed: WarmEnvEvent = serde_json::from_str(&json).unwrap();
        match parsed {
            WarmEnvEvent::Result(r) => {
                assert!(!r.success);
                assert_eq!(r.failed_package.unwrap(), "bogus-pkg");
            }
            _ => panic!("expected Result variant"),
        }
    }

    #[test]
    fn warm_env_config_roundtrip() {
        let config = WarmEnvConfig {
            env_type: EnvType::Conda,
            env_dir: PathBuf::from("/cache/pool-conda-abc"),
            packages: vec!["numpy>=1.20,<2".into(), "pandas".into()],
            channels: vec!["conda-forge".into()],
        };
        let json = serde_json::to_string(&config).unwrap();
        let parsed: WarmEnvConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.packages, config.packages);
        assert_eq!(parsed.channels, config.channels);
    }

    #[test]
    fn package_hash_deterministic() {
        let h1 = expected_pool_package_hash(EnvType::Uv, &["b".into(), "a".into()]);
        let h2 = expected_pool_package_hash(EnvType::Uv, &["a".into(), "b".into()]);
        assert_eq!(h1, h2, "hash should be order-independent");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_output_with_timeout_captures_stdout_and_stderr() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "printf ok; printf err >&2"]);

        let result = run_output_with_timeout(command, Duration::from_secs(5)).await;

        match result {
            TimedResult::Completed(output) => {
                assert!(output.status.success());
                assert_eq!(output.stdout, b"ok");
                assert_eq!(output.stderr, b"err");
            }
            other => panic!("expected completed output, got {other:?}"),
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn run_output_with_timeout_kills_slow_child() {
        let mut command = tokio::process::Command::new("sh");
        command.args(["-c", "sleep 30"]);

        let result = run_output_with_timeout(command, Duration::from_millis(25)).await;

        assert!(matches!(result, TimedResult::TimedOut));
    }

    #[test]
    fn parse_uv_error_package_not_found() {
        let stderr = r#"error: No solution found when resolving dependencies:
  Because Because scitkit-learn was not found in the package registry and you require scitkit-learn, we can conclude that your requirements are unsatisfiable."#;

        let result = parse_uv_error(stderr).expect("expected package parse error");
        assert_eq!(result.1, "invalid_package");
        assert_eq!(result.2, Some("scitkit-learn".to_string()));
    }

    #[test]
    fn parse_uv_error_backtick_format() {
        let result = parse_uv_error("error: Package `nonexistent-pkg` not found in registry")
            .expect("expected package parse error");
        assert_eq!(result.1, "invalid_package");
        assert_eq!(result.2, Some("nonexistent-pkg".to_string()));
    }

    #[test]
    fn parse_uv_error_no_matching_distribution() {
        let result = parse_uv_error("error: No matching distribution found for bad-package-name")
            .expect("expected package parse error");
        assert_eq!(result.1, "invalid_package");
        assert_eq!(result.2, Some("bad-package-name".to_string()));
    }

    #[test]
    fn parse_uv_error_generic_error() {
        let result = parse_uv_error("error: Failed to resolve dependencies")
            .expect("expected generic error");
        assert_eq!(result.1, "setup_failed");
        assert_eq!(result.2, None);
        assert!(result.0.contains("error"));
    }

    #[test]
    fn parse_uv_error_no_error() {
        assert!(parse_uv_error("Successfully installed packages").is_none());
    }

    #[test]
    fn uv_pip_install_args_offline_first_shape() {
        let args = uv_pip_install_args(
            Path::new("/tmp/env/bin/python"),
            &["ipykernel".into(), "numpy>=2".into()],
            true,
        );

        assert_eq!(args[0], "pip");
        assert_eq!(args[1], "install");
        assert!(args.contains(&"--link-mode".to_string()));
        assert!(args.contains(&"hardlink".to_string()));
        assert!(args.contains(&"--python".to_string()));
        assert!(args.contains(&"/tmp/env/bin/python".to_string()));
        assert!(args.contains(&"--offline".to_string()));
        assert!(args.ends_with(&["ipykernel".to_string(), "numpy>=2".to_string()]));
    }

    #[test]
    fn uv_pip_install_args_online_fallback_shape() {
        let args = uv_pip_install_args(Path::new("/tmp/env/bin/python"), &["pandas".into()], false);

        assert!(!args.contains(&"--offline".to_string()));
        assert!(args.contains(&"--link-mode".to_string()));
        assert!(args.contains(&"hardlink".to_string()));
        assert!(args.ends_with(&["pandas".to_string()]));
    }

    #[test]
    fn uv_offline_probe_has_shorter_timeout_than_online_fallback() {
        assert!(UV_OFFLINE_INSTALL_TIMEOUT < UV_ONLINE_INSTALL_TIMEOUT);
    }
}
