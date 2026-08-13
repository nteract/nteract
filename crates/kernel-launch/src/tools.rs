//! Tool bootstrapping via direct GitHub downloads.
//!
//! This module provides a way to automatically install CLI tools (like `ruff`, `deno`, `uv`, `pixi`)
//! on demand. Tools are downloaded from GitHub releases and cached in `~/.cache/runt/tools/`.

use anyhow::{anyhow, Result};
use log::info;
use sha2::{Digest, Sha256};
use std::fs::{File, OpenOptions};
use std::future::Future;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};
use tokio::sync::OnceCell;
use zip::ZipArchive;

/// Target Deno version for GitHub download.
pub const DENO_TARGET_VERSION: &str = "2.7.1";

/// Target UV version for GitHub download.
pub const UV_TARGET_VERSION: &str = "0.10.8";

/// Target ruff version for GitHub download.
pub const RUFF_TARGET_VERSION: &str = "0.15.11";

/// Target pixi version for GitHub download.
/// Pinned to ensure stable `pixi info --json` and `pixi shell-hook --json` output.
pub const PIXI_TARGET_VERSION: &str = "0.67.1";

/// Minimum acceptable Deno major version for system deno.
/// If system deno is below this version, we download a newer one.
pub const DENO_MIN_MAJOR_VERSION: u32 = 2;

/// Platform information for GitHub release assets (shared by Deno, UV, and ruff).
struct GithubPlatform {
    arch: &'static str,
    platform: &'static str,
}

/// Cache directory for bootstrapped tools.
///
/// Channel-aware via [`runt_workspace::daemon_base_dir`]: stable uses
/// `runt/tools/`, nightly uses `runt-nightly/tools/`, dev worktrees nest
/// under `worktrees/{hash}/tools/`. This keeps a nightly install from
/// sharing a bootstrapped deno/uv/ruff with stable, same rationale as
/// #2244 for envs.
fn tools_cache_dir() -> PathBuf {
    runt_workspace::daemon_base_dir().join("tools")
}

/// Compute a hash for tool caching.
fn compute_tool_hash(tool_name: &str, version: Option<&str>) -> String {
    let mut hasher = Sha256::new();
    hasher.update(tool_name.as_bytes());
    if let Some(v) = version {
        hasher.update(b"=");
        hasher.update(v.as_bytes());
    }
    // Include platform in hash since binaries are platform-specific
    let platform_string = format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS);
    hasher.update(platform_string.as_bytes());
    let hash = hasher.finalize();
    hex::encode(hash)[..12].to_string()
}

/// Compute the binary path for a tool inside a given environment directory.
fn binary_path_for_env(env_path: &Path, tool_name: &str) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        env_path.join("Scripts").join(format!("{}.exe", tool_name))
    }
    #[cfg(not(target_os = "windows"))]
    {
        env_path.join("bin").join(tool_name)
    }
}

/// Return the expected cached binary path for a tool/version without bootstrapping.
pub fn cached_tool_binary_path(tool_name: &str, version: Option<&str>) -> PathBuf {
    let hash = compute_tool_hash(tool_name, version);
    let env_path = tools_cache_dir().join(format!("{}-{}", tool_name, hash));
    binary_path_for_env(&env_path, tool_name)
}

/// Information about a bootstrapped tool.
#[derive(Debug, Clone)]
pub struct BootstrappedTool {
    /// Path to the tool binary
    pub binary_path: PathBuf,
    /// Path to the environment containing the tool
    pub env_path: PathBuf,
}

struct ToolCachePaths {
    env_path: PathBuf,
    binary_path: PathBuf,
    lock_path: PathBuf,
    staging_prefix: String,
}

struct ToolInstallLease {
    lock_file: File,
    staging_env: PathBuf,
    published: AtomicBool,
}

impl Drop for ToolInstallLease {
    fn drop(&mut self) {
        if !self.published.load(Ordering::Acquire) {
            let _ = std::fs::remove_dir_all(&self.staging_env);
        }
        let _ = self.lock_file.unlock();
    }
}

fn tool_cache_paths(cache_dir: &Path, tool_name: &str, version: &str) -> ToolCachePaths {
    let hash = compute_tool_hash(tool_name, Some(version));
    let env_name = format!("{tool_name}-{hash}");
    let env_path = cache_dir.join(&env_name);
    ToolCachePaths {
        binary_path: binary_path_for_env(&env_path, tool_name),
        lock_path: cache_dir.join(".locks").join(format!("{env_name}.lock")),
        staging_prefix: format!(".{env_name}.stage-"),
        env_path,
    }
}

async fn acquire_tool_install_lock(lock_path: PathBuf) -> Result<File> {
    tokio::task::spawn_blocking(move || -> Result<File> {
        if let Some(parent) = lock_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let lock_file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        match lock_file.try_lock() {
            Ok(()) => {}
            Err(std::fs::TryLockError::WouldBlock) => {
                info!("Waiting for tool install lock at {:?}", lock_path);
                lock_file.lock()?;
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error.into()),
        }
        Ok(lock_file)
    })
    .await
    .map_err(|error| anyhow!("tool install lock task panicked: {error}"))?
}

async fn remove_stale_tool_staging(cache_dir: &Path, prefix: &str) -> Result<()> {
    let mut entries = match tokio::fs::read_dir(cache_dir).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        if entry.file_name().to_string_lossy().starts_with(prefix) {
            let path = entry.path();
            let file_type = entry.file_type().await?;
            if file_type.is_dir() {
                tokio::fs::remove_dir_all(path).await?;
            } else {
                tokio::fs::remove_file(path).await?;
            }
        }
    }
    Ok(())
}

/// Install one pinned tool release exactly once across daemon processes.
///
/// The persistent sibling lock makes the download single-flight across the
/// daemon and runtime-agent processes. The installer only writes into a unique
/// same-filesystem staging directory; the final cache path appears in one
/// atomic rename after extraction and validation succeed.
async fn install_tool_atomically<F, Fut>(
    cache_dir: &Path,
    tool_name: &str,
    version: &str,
    installer: F,
) -> Result<BootstrappedTool>
where
    F: FnOnce(PathBuf, PathBuf, Arc<ToolInstallLease>) -> Fut,
    Fut: Future<Output = Result<()>>,
{
    let paths = tool_cache_paths(cache_dir, tool_name, version);
    if is_executable_file(&paths.binary_path) {
        info!("Using cached {tool_name} at {:?}", paths.binary_path);
        return Ok(BootstrappedTool {
            binary_path: paths.binary_path,
            env_path: paths.env_path,
        });
    }

    tokio::fs::create_dir_all(cache_dir).await?;
    let lock_file = acquire_tool_install_lock(paths.lock_path.clone()).await?;

    // A different process may have completed the install while we waited.
    if is_executable_file(&paths.binary_path) {
        info!("Using cached {tool_name} at {:?}", paths.binary_path);
        return Ok(BootstrappedTool {
            binary_path: paths.binary_path,
            env_path: paths.env_path,
        });
    }

    if paths.env_path.exists() {
        tokio::fs::remove_dir_all(&paths.env_path).await?;
    }
    remove_stale_tool_staging(cache_dir, &paths.staging_prefix).await?;

    let staging = tempfile::Builder::new()
        .prefix(&paths.staging_prefix)
        .tempdir_in(cache_dir)?;
    let staging_env = staging.keep();
    let staging_binary = binary_path_for_env(&staging_env, tool_name);
    let lease = Arc::new(ToolInstallLease {
        lock_file,
        staging_env: staging_env.clone(),
        published: AtomicBool::new(false),
    });
    installer(
        staging_env.clone(),
        staging_binary.clone(),
        Arc::clone(&lease),
    )
    .await?;
    if !is_executable_file(&staging_binary) {
        return Err(anyhow!(
            "{tool_name} binary missing or not executable after extraction at {:?}",
            staging_binary
        ));
    }

    tokio::fs::rename(&staging_env, &paths.env_path).await?;
    lease.published.store(true, Ordering::Release);

    Ok(BootstrappedTool {
        binary_path: paths.binary_path,
        env_path: paths.env_path,
    })
}

// ── GitHub platform helpers ──────────────────────────────────────────

/// Get the GitHub release asset platform string for the current system.
/// Uses glibc on Linux (matches deno, uv, ruff release naming).
fn get_github_platform() -> Result<GithubPlatform> {
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        other => return Err(anyhow!("Unsupported architecture: {}", other)),
    };

    let platform = match std::env::consts::OS {
        "macos" => "apple-darwin",
        "linux" => "unknown-linux-gnu",
        "windows" => "pc-windows-msvc",
        other => return Err(anyhow!("Unsupported platform: {}", other)),
    };

    Ok(GithubPlatform { arch, platform })
}

/// Platform info for pixi GitHub releases (uses musl on Linux, not glibc).
fn get_pixi_github_platform() -> Result<GithubPlatform> {
    let arch = match std::env::consts::ARCH {
        "aarch64" => "aarch64",
        "x86_64" => "x86_64",
        other => return Err(anyhow!("Unsupported architecture: {}", other)),
    };

    let platform = match std::env::consts::OS {
        "macos" => "apple-darwin",
        "linux" => "unknown-linux-musl",
        "windows" => "pc-windows-msvc",
        other => return Err(anyhow!("Unsupported platform: {}", other)),
    };

    Ok(GithubPlatform { arch, platform })
}

// ── Ruff ─────────────────────────────────────────────────────────────

/// Global cache for the ruff binary path.
/// This avoids repeated lookups once ruff is bootstrapped.
static RUFF_PATH: OnceCell<Arc<Result<PathBuf, String>>> = OnceCell::const_new();

/// Extract a named tool binary from a tar.gz archive.
///
/// Searches all entries for a file whose name matches `binary_name`
/// (may be at the root or inside a subdirectory like `tool-arch-platform/`).
fn extract_tool_tarball(tarball_bytes: &[u8], dest_dir: &Path, tool_name: &str) -> Result<PathBuf> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    // Create destination directory structure
    let bin_dir = if cfg!(windows) {
        dest_dir.join("Scripts")
    } else {
        dest_dir.join("bin")
    };
    std::fs::create_dir_all(&bin_dir)?;

    // Decompress and extract
    let decoder = GzDecoder::new(Cursor::new(tarball_bytes));
    let mut archive = Archive::new(decoder);

    let binary_name = if cfg!(windows) {
        format!("{}.exe", tool_name)
    } else {
        tool_name.to_string()
    };
    let dest_path = bin_dir.join(&binary_name);

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;

        // Look for the binary (may be at root or in a subdirectory)
        if let Some(file_name) = path.file_name() {
            if file_name == binary_name.as_str() {
                let mut dest_file = std::fs::File::create(&dest_path)?;
                std::io::copy(&mut entry, &mut dest_file)?;

                // Set executable permission on Unix
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let perms = std::fs::Permissions::from_mode(0o755);
                    std::fs::set_permissions(&dest_path, perms)?;
                }

                return Ok(dest_path);
            }
        }
    }

    Err(anyhow!("{} binary not found in tarball", tool_name))
}

#[cfg(windows)]
fn extract_tool_zip(zip_bytes: &[u8], dest_dir: &Path, tool_name: &str) -> Result<PathBuf> {
    let bin_dir = dest_dir.join("Scripts");
    std::fs::create_dir_all(&bin_dir)?;
    let binary_name = format!("{tool_name}.exe");
    let dest_path = bin_dir.join(&binary_name);
    let mut archive = ZipArchive::new(Cursor::new(zip_bytes))?;
    for index in 0..archive.len() {
        let mut file = archive.by_index(index)?;
        if file.name().ends_with(&binary_name) {
            let mut dest_file = std::fs::File::create(&dest_path)?;
            std::io::copy(&mut file, &mut dest_file)?;
            return Ok(dest_path);
        }
    }
    Err(anyhow!("{binary_name} not found in zip archive"))
}

fn verify_checksum(bytes: &[u8], expected_hash: &str, tool_name: &str) -> Result<()> {
    info!("Verifying checksum...");
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let actual_hash = hex::encode(hasher.finalize());
    if actual_hash != expected_hash {
        return Err(anyhow!(
            "Checksum mismatch for {tool_name}: expected {expected_hash}, got {actual_hash}"
        ));
    }
    Ok(())
}

/// Download and verify the ruff binary from GitHub releases.
///
/// Ruff tags have NO `v` prefix: `https://github.com/astral-sh/ruff/releases/download/{version}/...`
async fn download_ruff_from_github(version: &str) -> Result<BootstrappedTool> {
    let platform = get_github_platform()?;

    // Ruff uses tar.gz on Unix, zip on Windows
    let (asset_name, is_zip) = if cfg!(windows) {
        (
            format!("ruff-{}-{}.zip", platform.arch, platform.platform),
            true,
        )
    } else {
        (
            format!("ruff-{}-{}.tar.gz", platform.arch, platform.platform),
            false,
        )
    };

    // Build URLs — ruff tags have NO `v` prefix
    let download_url = format!(
        "https://github.com/astral-sh/ruff/releases/download/{}/{}",
        version, asset_name
    );
    let checksum_url = format!("{}.sha256", download_url);

    let cache_dir = tools_cache_dir();
    let tool = install_tool_atomically(
        &cache_dir,
        "ruff",
        version,
        move |staging_env, staging_binary, lease| async move {
            info!("Downloading ruff {} from GitHub...", version);
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()?;
            info!("Fetching checksum from {}...", checksum_url);
            let checksum_response = client.get(&checksum_url).send().await?;
            if !checksum_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download checksum: {}",
                    checksum_response.status()
                ));
            }
            let checksum_text = checksum_response.text().await?;
            let expected_hash = checksum_text
                .split_whitespace()
                .next()
                .ok_or_else(|| anyhow!("Invalid checksum format"))?
                .to_lowercase();

            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download ruff: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, &expected_hash, "ruff")?;

            info!("Extracting ruff to {:?}...", staging_env);
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _lease = lease;
                if is_zip {
                    #[cfg(target_os = "windows")]
                    extract_tool_zip(&archive_bytes, &staging_env, "ruff")?;
                    #[cfg(not(target_os = "windows"))]
                    return Err(anyhow!("Unexpected zip archive on non-Windows platform"));
                } else {
                    extract_tool_tarball(&archive_bytes, &staging_env, "ruff")?;
                }
                if !staging_binary.exists() {
                    return Err(anyhow!(
                        "ruff binary not found after extraction at {:?}",
                        staging_binary
                    ));
                }
                Ok(())
            })
            .await
            .map_err(|error| anyhow!("Extraction task panicked: {error}"))??;
            Ok(())
        },
    )
    .await?;

    info!(
        "Successfully installed ruff {} at {:?}",
        version, tool.binary_path
    );
    Ok(tool)
}

/// Get the path to ruff, downloading from GitHub if necessary.
///
/// This function:
/// 1. First checks if ruff is available on PATH (fast path)
/// 2. If not, downloads from GitHub releases
/// 3. Caches the result for subsequent calls
///
/// Returns the path to the ruff binary, or an error if it can't be obtained.
pub async fn get_ruff_path() -> Result<PathBuf> {
    let result = RUFF_PATH
        .get_or_init(|| async {
            // First, check if ruff is on PATH
            if let Ok(output) = tokio::process::Command::new("ruff")
                .arg("--version")
                .output()
                .await
            {
                if output.status.success() {
                    info!("Using system ruff");
                    return Arc::new(Ok(PathBuf::from("ruff")));
                }
            }

            // Not on PATH, download from GitHub
            info!(
                "ruff not found on PATH, resolving pinned version {}",
                RUFF_TARGET_VERSION
            );
            match download_ruff_from_github(RUFF_TARGET_VERSION).await {
                Ok(tool) => Arc::new(Ok(tool.binary_path)),
                Err(e) => Arc::new(Err(e.to_string())),
            }
        })
        .await;

    match result.as_ref() {
        Ok(path) => Ok(path.clone()),
        Err(e) => Err(anyhow!("{}", e)),
    }
}

// ── Deno ─────────────────────────────────────────────────────────────

/// Global cache for the deno binary path.
/// This avoids repeated lookups once deno is bootstrapped.
static DENO_PATH: OnceCell<Arc<Result<PathBuf, String>>> = OnceCell::const_new();

/// Check if a usable Deno is available without triggering a bootstrap.
///
/// Returns true if:
/// - System deno exists and is version 2.x+, OR
/// - A cached deno binary exists from a GitHub download
///
/// This is intended for UI availability checks where we don't want to
/// trigger a full download during initialization.
pub async fn check_deno_available_without_bootstrap() -> bool {
    // Check for acceptable system deno (2.x+)
    if let Ok(output) = tokio::process::Command::new("deno")
        .arg("--version")
        .output()
        .await
    {
        if output.status.success() {
            let version_str = String::from_utf8_lossy(&output.stdout);
            if let Some(major) = parse_deno_major_version(&version_str) {
                if major >= DENO_MIN_MAJOR_VERSION {
                    return true;
                }
            }
        }
    }

    // Check for cached GitHub download (versioned path)
    cached_tool_binary_path("deno", Some(DENO_TARGET_VERSION)).exists()
}

/// Parse a version string and return the major version number.
/// Handles both "2.7.1" and "deno 2.7.1 (release, ...)" formats.
fn parse_deno_major_version(version_output: &str) -> Option<u32> {
    let line = version_output.lines().next()?;
    // Find the first token that starts with a digit (the version number)
    let version_str = line.split_whitespace().find(|s| {
        s.chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
    })?;
    version_str.split('.').next()?.parse().ok()
}

/// Check if system deno is acceptable (major version >= 2).
/// Returns Some(path) if acceptable, None otherwise.
async fn check_system_deno_acceptable() -> Option<PathBuf> {
    let output = tokio::process::Command::new("deno")
        .arg("--version")
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let version_str = String::from_utf8_lossy(&output.stdout);
    let major = parse_deno_major_version(&version_str)?;

    if major >= DENO_MIN_MAJOR_VERSION {
        let version_line = version_str.lines().next().unwrap_or("unknown");
        info!("Using system deno ({})", version_line);
        Some(PathBuf::from("deno"))
    } else {
        info!(
            "System deno version {}.x is below minimum {}.x, will download newer version",
            major, DENO_MIN_MAJOR_VERSION
        );
        None
    }
}

/// Extract the deno binary from a zip archive.
fn extract_deno_zip(zip_bytes: &[u8], dest_dir: &Path) -> Result<PathBuf> {
    // Create destination directory structure
    let bin_dir = if cfg!(windows) {
        dest_dir.join("Scripts")
    } else {
        dest_dir.join("bin")
    };
    std::fs::create_dir_all(&bin_dir)?;

    // Open zip archive
    let cursor = Cursor::new(zip_bytes);
    let mut archive = ZipArchive::new(cursor)?;

    // The deno zip contains a single "deno" (or "deno.exe") file at the root
    let binary_name = if cfg!(windows) { "deno.exe" } else { "deno" };
    let mut extracted_path = None;

    for i in 0..archive.len() {
        let mut file = archive.by_index(i)?;
        let name = file.name().to_string();

        // Only extract the deno binary
        if name == "deno" || name == "deno.exe" {
            let dest_path = bin_dir.join(binary_name);
            let mut dest_file = std::fs::File::create(&dest_path)?;
            std::io::copy(&mut file, &mut dest_file)?;
            extracted_path = Some(dest_path);
            break;
        }
    }

    extracted_path.ok_or_else(|| anyhow!("Deno binary not found in zip archive"))
}

/// Download and verify the deno binary from GitHub releases.
async fn download_deno_from_github(version: &str) -> Result<BootstrappedTool> {
    let platform = get_github_platform()?;
    let asset_name = format!("deno-{}-{}.zip", platform.arch, platform.platform);

    // Build URLs
    let zip_url = format!(
        "https://github.com/denoland/deno/releases/download/v{}/{}",
        version, asset_name
    );
    let checksum_url = format!("{}.sha256sum", zip_url);

    let cache_dir = tools_cache_dir();
    let tool = install_tool_atomically(
        &cache_dir,
        "deno",
        version,
        move |staging_env, staging_binary, lease| async move {
            info!("Downloading deno {} from GitHub...", version);
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()?;

            info!("Fetching checksum from {}...", checksum_url);
            let checksum_response = client.get(&checksum_url).send().await?;
            if !checksum_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download checksum: {}",
                    checksum_response.status()
                ));
            }
            let checksum_text = checksum_response.text().await?;
            let expected_hash = checksum_text
                .split_whitespace()
                .next()
                .ok_or_else(|| anyhow!("Invalid checksum format"))?
                .to_lowercase();

            info!("Downloading {}...", asset_name);
            let zip_response = client.get(&zip_url).send().await?;
            if !zip_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download deno: {}",
                    zip_response.status()
                ));
            }
            let zip_bytes = zip_response.bytes().await?;

            info!("Verifying checksum...");
            let mut hasher = Sha256::new();
            hasher.update(&zip_bytes);
            let actual_hash = hex::encode(hasher.finalize());
            if actual_hash != expected_hash {
                return Err(anyhow!(
                    "Checksum mismatch: expected {}, got {}",
                    expected_hash,
                    actual_hash
                ));
            }

            info!("Extracting deno to {:?}...", staging_env);
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _lease = lease;
                let extracted_binary = extract_deno_zip(&zip_bytes, &staging_env)?;

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let perms = std::fs::Permissions::from_mode(0o755);
                    std::fs::set_permissions(&extracted_binary, perms)?;
                }

                if !staging_binary.exists() {
                    return Err(anyhow!(
                        "Deno binary not found after extraction at {:?}",
                        staging_binary
                    ));
                }
                Ok(())
            })
            .await
            .map_err(|error| anyhow!("Extraction task panicked: {error}"))??;
            Ok(())
        },
    )
    .await?;

    info!(
        "Successfully installed deno {} at {:?}",
        version, tool.binary_path
    );
    Ok(tool)
}

/// Get the path to deno, with the following priority:
///
/// 1. System deno if version >= 2.x (fast path, respects user's installation)
/// 2. Download from GitHub releases (v2.7.1) - most reliable source
///
/// Results are cached for subsequent calls.
pub async fn get_deno_path() -> Result<PathBuf> {
    let result = DENO_PATH
        .get_or_init(|| async {
            // 1. Check for acceptable system deno (2.x+)
            if let Some(path) = check_system_deno_acceptable().await {
                return Arc::new(Ok(path));
            }

            // 2. Download from GitHub releases
            info!("Resolving pinned deno version {}", DENO_TARGET_VERSION);
            match download_deno_from_github(DENO_TARGET_VERSION).await {
                Ok(tool) => Arc::new(Ok(tool.binary_path)),
                Err(e) => Arc::new(Err(e.to_string())),
            }
        })
        .await;

    match result.as_ref() {
        Ok(path) => Ok(path.clone()),
        Err(e) => Err(anyhow!("{}", e)),
    }
}

// ── UV ───────────────────────────────────────────────────────────────

/// Extract the uv binary from a tar.gz archive.
fn extract_uv_tarball(tarball_bytes: &[u8], dest_dir: &Path) -> Result<PathBuf> {
    use flate2::read::GzDecoder;
    use tar::Archive;

    // Create destination directory structure
    let bin_dir = if cfg!(windows) {
        dest_dir.join("Scripts")
    } else {
        dest_dir.join("bin")
    };
    std::fs::create_dir_all(&bin_dir)?;

    // Decompress and extract
    let decoder = GzDecoder::new(Cursor::new(tarball_bytes));
    let mut archive = Archive::new(decoder);

    // The uv tarball contains files in a directory like "uv-aarch64-apple-darwin/"
    // We need to find the uv binary and extract it
    let binary_name = if cfg!(windows) { "uv.exe" } else { "uv" };
    let dest_path = bin_dir.join(binary_name);

    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?;

        // Look for the uv binary (may be at root or in a subdirectory)
        if let Some(file_name) = path.file_name() {
            if file_name == binary_name {
                let mut dest_file = std::fs::File::create(&dest_path)?;
                std::io::copy(&mut entry, &mut dest_file)?;

                // Set executable permission on Unix
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let perms = std::fs::Permissions::from_mode(0o755);
                    std::fs::set_permissions(&dest_path, perms)?;
                }

                return Ok(dest_path);
            }
        }
    }

    Err(anyhow!("uv binary not found in tarball"))
}

/// Download and verify the uv binary from GitHub releases.
async fn download_uv_from_github(version: &str) -> Result<BootstrappedTool> {
    let platform = get_github_platform()?;

    // UV uses tar.gz on Unix, zip on Windows
    let (asset_name, is_zip) = if cfg!(windows) {
        (
            format!("uv-{}-{}.zip", platform.arch, platform.platform),
            true,
        )
    } else {
        (
            format!("uv-{}-{}.tar.gz", platform.arch, platform.platform),
            false,
        )
    };

    // Build URLs
    let download_url = format!(
        "https://github.com/astral-sh/uv/releases/download/{}/{}",
        version, asset_name
    );
    let checksum_url = format!("{}.sha256", download_url);

    let cache_dir = tools_cache_dir();
    let tool = install_tool_atomically(
        &cache_dir,
        "uv",
        version,
        move |staging_env, staging_binary, lease| async move {
            info!("Downloading uv {} from GitHub...", version);
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()?;
            info!("Fetching checksum from {}...", checksum_url);
            let checksum_response = client.get(&checksum_url).send().await?;
            if !checksum_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download checksum: {}",
                    checksum_response.status()
                ));
            }
            let checksum_text = checksum_response.text().await?;
            let expected_hash = checksum_text
                .split_whitespace()
                .next()
                .ok_or_else(|| anyhow!("Invalid checksum format"))?
                .to_lowercase();

            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download uv: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, &expected_hash, "uv")?;

            info!("Extracting uv to {:?}...", staging_env);
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _lease = lease;
                if is_zip {
                    #[cfg(target_os = "windows")]
                    extract_tool_zip(&archive_bytes, &staging_env, "uv")?;
                    #[cfg(not(target_os = "windows"))]
                    return Err(anyhow!("Unexpected zip archive on non-Windows platform"));
                } else {
                    extract_uv_tarball(&archive_bytes, &staging_env)?;
                }
                if !staging_binary.exists() {
                    return Err(anyhow!(
                        "uv binary not found after extraction at {:?}",
                        staging_binary
                    ));
                }
                Ok(())
            })
            .await
            .map_err(|error| anyhow!("Extraction task panicked: {error}"))??;
            Ok(())
        },
    )
    .await?;

    info!(
        "Successfully installed uv {} at {:?}",
        version, tool.binary_path
    );
    Ok(tool)
}

/// Global cache for the uv binary path.
/// This avoids repeated lookups once uv is bootstrapped.
static UV_PATH: OnceCell<Arc<Result<PathBuf, String>>> = OnceCell::const_new();

/// Walk the current process's `PATH` for a binary by name. Returns the first
/// candidate that exists AND has execute permission (on Unix) or the right
/// extension (on Windows). The exec check matters because PATH can contain
/// non-executable files named `uv` (rare but possible — config files,
/// leftover artifacts) ahead of the real binary; spawning a cached
/// non-executable path would later fail with PermissionDenied.
fn find_in_path(binary: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(binary);
        if is_executable_file(&candidate) {
            return Some(candidate);
        }
        #[cfg(windows)]
        {
            let exe = dir.join(format!("{binary}.exe"));
            if is_executable_file(&exe) {
                return Some(exe);
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable_file(path: &std::path::Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::metadata(path) {
        Ok(meta) if meta.is_file() => meta.permissions().mode() & 0o111 != 0,
        _ => false,
    }
}

#[cfg(windows)]
fn is_executable_file(path: &std::path::Path) -> bool {
    path.is_file()
}

/// Get the path to uv, with the following priority:
///
/// 1. System uv if available on PATH (fast path, respects user's installation)
/// 2. Download from GitHub releases (v0.10.8) - most reliable source
///
/// Results are cached for subsequent calls.
pub async fn get_uv_path() -> Result<PathBuf> {
    let result = UV_PATH
        .get_or_init(|| async {
            // 1. Check for system uv on PATH. Resolve to an absolute path so
            //    spawned commands don't depend on the child process's PATH
            //    (which may be overridden by per-launch env_vars).
            if let Ok(output) = tokio::process::Command::new("uv")
                .arg("--version")
                .output()
                .await
            {
                if output.status.success() {
                    if let Some(abs) = find_in_path("uv") {
                        info!("Using system uv at {}", abs.display());
                        return Arc::new(Ok(abs));
                    }
                    // Extremely unlikely: uv ran but isn't findable via PATH
                    // walk. Fall back to the bare name so the daemon still
                    // works (e.g. in test rigs that wrap the spawn).
                    info!("Using system uv (could not resolve absolute path)");
                    return Arc::new(Ok(PathBuf::from("uv")));
                }
            }

            // 2. Download from GitHub releases
            info!("Resolving pinned uv version {}", UV_TARGET_VERSION);
            match download_uv_from_github(UV_TARGET_VERSION).await {
                Ok(tool) => Arc::new(Ok(tool.binary_path)),
                Err(e) => Arc::new(Err(e.to_string())),
            }
        })
        .await;

    match result.as_ref() {
        Ok(path) => Ok(path.clone()),
        Err(e) => Err(anyhow!("{}", e)),
    }
}

// ── Pixi ─────────────────────────────────────────────────────────────

/// Global cache for the pixi binary path.
static PIXI_PATH: OnceCell<Arc<Result<PathBuf, String>>> = OnceCell::const_new();

/// Download and verify the pixi binary from GitHub releases.
///
/// Pixi tags have a `v` prefix: `https://github.com/prefix-dev/pixi/releases/download/v{version}/...`
/// Pixi uses musl on Linux (not glibc), hence `get_pixi_github_platform()`.
async fn download_pixi_from_github(version: &str) -> Result<BootstrappedTool> {
    let platform = get_pixi_github_platform()?;

    // Pixi uses tar.gz on Unix, zip on Windows
    let (asset_name, is_zip) = if cfg!(windows) {
        (
            format!("pixi-{}-{}.zip", platform.arch, platform.platform),
            true,
        )
    } else {
        (
            format!("pixi-{}-{}.tar.gz", platform.arch, platform.platform),
            false,
        )
    };

    // Build URLs — pixi tags have a `v` prefix
    let download_url = format!(
        "https://github.com/prefix-dev/pixi/releases/download/v{}/{}",
        version, asset_name
    );
    let checksum_url = format!("{}.sha256", download_url);

    let cache_dir = tools_cache_dir();
    let tool = install_tool_atomically(
        &cache_dir,
        "pixi",
        version,
        move |staging_env, staging_binary, lease| async move {
            info!("Downloading pixi {} from GitHub...", version);
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()?;
            info!("Fetching checksum from {}...", checksum_url);
            let checksum_response = client.get(&checksum_url).send().await?;
            if !checksum_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download checksum: {}",
                    checksum_response.status()
                ));
            }
            let checksum_text = checksum_response.text().await?;
            let expected_hash = checksum_text
                .split_whitespace()
                .next()
                .ok_or_else(|| anyhow!("Invalid checksum format"))?
                .to_lowercase();

            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download pixi: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, &expected_hash, "pixi")?;

            info!("Extracting pixi to {:?}...", staging_env);
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _lease = lease;
                if is_zip {
                    #[cfg(target_os = "windows")]
                    extract_tool_zip(&archive_bytes, &staging_env, "pixi")?;
                    #[cfg(not(target_os = "windows"))]
                    return Err(anyhow!("Unexpected zip archive on non-Windows platform"));
                } else {
                    extract_tool_tarball(&archive_bytes, &staging_env, "pixi")?;
                }
                if !staging_binary.exists() {
                    return Err(anyhow!(
                        "pixi binary not found after extraction at {:?}",
                        staging_binary
                    ));
                }
                Ok(())
            })
            .await
            .map_err(|error| anyhow!("Extraction task panicked: {error}"))??;
            Ok(())
        },
    )
    .await?;

    info!(
        "Successfully installed pixi {} at {:?}",
        version, tool.binary_path
    );
    Ok(tool)
}

/// Get the path to the pixi binary, checking system PATH first then downloading from GitHub.
///
/// Results are cached for subsequent calls.
pub async fn get_pixi_path() -> Result<PathBuf> {
    let result = PIXI_PATH
        .get_or_init(|| async {
            // 1. Check for system pixi on PATH. Resolve to an absolute path
            //    so spawned commands don't depend on the child process's
            //    PATH (see `get_uv_path` for rationale).
            if let Ok(output) = tokio::process::Command::new("pixi")
                .arg("--version")
                .output()
                .await
            {
                if output.status.success() {
                    if let Some(abs) = find_in_path("pixi") {
                        info!("Using system pixi at {}", abs.display());
                        return Arc::new(Ok(abs));
                    }
                    info!("Using system pixi (could not resolve absolute path)");
                    return Arc::new(Ok(PathBuf::from("pixi")));
                }
            }

            // 2. Download from GitHub releases (pinned version)
            info!("Resolving pinned pixi version {}", PIXI_TARGET_VERSION);
            match download_pixi_from_github(PIXI_TARGET_VERSION).await {
                Ok(tool) => Arc::new(Ok(tool.binary_path)),
                Err(e) => Arc::new(Err(e.to_string())),
            }
        })
        .await;

    match result.as_ref() {
        Ok(path) => Ok(path.clone()),
        Err(e) => Err(anyhow!("{}", e)),
    }
}

// ── Nono (Unix only) ─────────────────────────────────────────────────

/// Target nono version for GitHub download.
///
/// nono only supports Unix (macOS and Linux). There is no Windows native build.
/// The `#[cfg(unix)]` gate on all nono code below enforces this at compile time;
/// when the Windows gate is eventually removed this constant and the functions
/// below remain unchanged.
#[cfg(unix)]
pub const NONO_TARGET_VERSION: &str = "0.63.0";

/// Global cache for the nono binary path (Unix only).
#[cfg(unix)]
static NONO_PATH: OnceCell<Arc<Result<PathBuf, String>>> = OnceCell::const_new();

/// Download and verify the nono binary from GitHub releases (Unix only).
///
/// Asset naming: `nono-v{version}-{arch}-{platform}.tar.gz`
/// Checksums:    single `SHA256SUMS.txt` (BSD-style: `<hash>  <filename>`)
/// Tag format:   `v{version}` (the `v` also appears in the asset filename).
///
/// Integrity is verified against the per-archive SHA-256 digest published in
/// SHA256SUMS.txt, matching the same pattern used for uv, ruff, and pixi.
#[cfg(unix)]
async fn download_nono_from_github(version: &str) -> Result<BootstrappedTool> {
    let platform = get_github_platform()?;

    let asset_name = format!(
        "nono-v{}-{}-{}.tar.gz",
        version, platform.arch, platform.platform
    );

    let download_url = format!(
        "https://github.com/always-further/nono/releases/download/v{}/{}",
        version, asset_name
    );
    let checksum_url = format!(
        "https://github.com/always-further/nono/releases/download/v{}/SHA256SUMS.txt",
        version
    );

    let cache_dir = tools_cache_dir();
    let tool = install_tool_atomically(
        &cache_dir,
        "nono",
        version,
        move |staging_env, staging_binary, lease| async move {
            info!("Downloading nono {} from GitHub...", version);
            let client = reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::limited(10))
                .build()?;

            info!("Fetching checksums from {}...", checksum_url);
            let checksum_response = client.get(&checksum_url).send().await?;
            if !checksum_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download SHA256SUMS.txt: {}",
                    checksum_response.status()
                ));
            }
            let checksum_text = checksum_response.text().await?;
            let expected_hash = checksum_text
                .lines()
                .find_map(|line| {
                    let mut parts = line.splitn(2, "  ");
                    let hash = parts.next()?.trim();
                    let name = parts.next()?.trim();
                    if name == asset_name {
                        Some(hash.to_lowercase())
                    } else {
                        None
                    }
                })
                .ok_or_else(|| {
                    anyhow!("Checksum for {} not found in SHA256SUMS.txt", asset_name)
                })?;

            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download nono: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, &expected_hash, "nono")?;

            info!("Extracting nono to {:?}...", staging_env);
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _lease = lease;
                extract_tool_tarball(&archive_bytes, &staging_env, "nono")?;
                if !staging_binary.exists() {
                    return Err(anyhow!(
                        "nono binary not found after extraction at {:?}",
                        staging_binary
                    ));
                }
                Ok(())
            })
            .await
            .map_err(|error| anyhow!("Extraction task panicked: {error}"))??;
            Ok(())
        },
    )
    .await?;

    info!(
        "Successfully installed nono {} at {:?}",
        version, tool.binary_path
    );
    Ok(tool)
}

/// Get the path to the nono binary (Unix only), checking system PATH first
/// then downloading a pinned release from GitHub.
///
/// Results are cached for subsequent calls within the same daemon process.
#[cfg(unix)]
pub async fn get_nono_path() -> Result<PathBuf> {
    let result = NONO_PATH
        .get_or_init(|| async {
            if let Ok(output) = tokio::process::Command::new("nono")
                .arg("--version")
                .output()
                .await
            {
                if output.status.success() {
                    if let Some(abs) = find_in_path("nono") {
                        info!("Using system nono at {}", abs.display());
                        return Arc::new(Ok(abs));
                    }
                    info!("Using system nono (could not resolve absolute path)");
                    return Arc::new(Ok(PathBuf::from("nono")));
                }
            }

            info!("Resolving pinned nono version {}", NONO_TARGET_VERSION);
            match download_nono_from_github(NONO_TARGET_VERSION).await {
                Ok(tool) => Arc::new(Ok(tool.binary_path)),
                Err(e) => Arc::new(Err(e.to_string())),
            }
        })
        .await;

    match result.as_ref() {
        Ok(path) => Ok(path.clone()),
        Err(e) => Err(anyhow!("{}", e)),
    }
}

// ── Pixi project info via `pixi info --json` ────────────────────────

/// Environment info from `pixi info --json`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PixiEnvironmentInfo {
    pub name: String,
    #[serde(default)]
    pub features: Vec<String>,
    #[serde(default)]
    pub dependencies: Vec<String>,
    #[serde(default)]
    pub pypi_dependencies: Vec<String>,
    #[serde(default)]
    pub channels: Vec<String>,
    #[serde(default)]
    pub prefix: Option<String>,
}

/// Project info from `pixi info --json`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PixiProjectInfo {
    pub name: Option<String>,
    pub manifest_path: Option<String>,
    pub version: Option<String>,
}

/// Parsed result from `pixi info --json`.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct PixiInfoResult {
    pub version: Option<String>,
    pub project_info: Option<PixiProjectInfo>,
    #[serde(default)]
    pub environments_info: Vec<PixiEnvironmentInfo>,
}

impl PixiInfoResult {
    /// Check if ipykernel is declared in the default environment's dependencies.
    pub fn has_ipykernel(&self) -> bool {
        self.environments_info.iter().any(|env| {
            env.name == "default"
                && (env.dependencies.iter().any(|d| d == "ipykernel")
                    || env.pypi_dependencies.iter().any(|d| d == "ipykernel"))
        })
    }

    /// Get the default environment's prefix path.
    pub fn default_prefix(&self) -> Option<&str> {
        self.environments_info
            .iter()
            .find(|e| e.name == "default")
            .and_then(|e| e.prefix.as_deref())
    }

    /// Get all dependency names from the default environment (sorted, for drift detection).
    pub fn default_deps_snapshot(&self) -> Vec<String> {
        let Some(env) = self.environments_info.iter().find(|e| e.name == "default") else {
            return Vec::new();
        };
        let mut deps: Vec<String> = env
            .dependencies
            .iter()
            .chain(env.pypi_dependencies.iter())
            .cloned()
            .collect();
        deps.sort();
        deps
    }
}

/// Run `pixi info --json` for a manifest path and parse the result.
///
/// The manifest can be either a `pixi.toml` or a `pyproject.toml` with `[tool.pixi]`.
pub async fn pixi_info(manifest_path: &std::path::Path) -> Result<PixiInfoResult> {
    let pixi_path = get_pixi_path().await?;
    let output = tokio::process::Command::new(&pixi_path)
        .args(["info", "--json", "--manifest-path"])
        .arg(manifest_path)
        .output()
        .await
        .map_err(|e| anyhow!("failed to run pixi info: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("pixi info failed: {}", stderr.trim()));
    }

    let result: PixiInfoResult = serde_json::from_slice(&output.stdout)
        .map_err(|e| anyhow!("failed to parse pixi info JSON: {}", e))?;
    Ok(result)
}

/// Run `pixi shell-hook --json` and return the environment variables.
///
/// These env vars can be applied to a `Command` with `cmd.envs()` for
/// direct Python launch without the `pixi run` wrapper.
///
/// `extra_env` is applied to the spawned `pixi` subprocess (not to the
/// returned activation vars). Use this to set `PIXI_FROZEN=true` when offline
/// so pixi does not try to refresh the lockfile from the network.
pub async fn pixi_shell_hook(
    manifest_path: &std::path::Path,
    environment: Option<&str>,
    extra_env: &std::collections::HashMap<String, String>,
) -> Result<std::collections::HashMap<String, String>> {
    let pixi_path = get_pixi_path().await?;
    let mut cmd = tokio::process::Command::new(&pixi_path);
    cmd.args(["shell-hook", "--json", "--manifest-path"]);
    cmd.arg(manifest_path);
    if let Some(env_name) = environment {
        cmd.args(["--environment", env_name]);
    }
    for (key, value) in extra_env {
        cmd.env(key, value);
    }

    let output = cmd
        .output()
        .await
        .map_err(|e| anyhow!("failed to run pixi shell-hook: {}", e))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("pixi shell-hook failed: {}", stderr.trim()));
    }

    #[derive(serde::Deserialize)]
    struct ShellHookResult {
        environment_variables: std::collections::HashMap<String, String>,
    }

    let result: ShellHookResult = serde_json::from_slice(&output.stdout)
        .map_err(|e| anyhow!("failed to parse pixi shell-hook JSON: {}", e))?;
    Ok(result.environment_variables)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    async fn write_test_executable(path: &Path, contents: &[u8]) -> Result<()> {
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent).await?;
        }
        tokio::fs::write(path, contents).await?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))?;
        }
        Ok(())
    }

    fn staging_paths(cache_dir: &Path, prefix: &str) -> Vec<PathBuf> {
        std::fs::read_dir(cache_dir)
            .into_iter()
            .flatten()
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().starts_with(prefix))
            .map(|entry| entry.path())
            .collect()
    }

    #[tokio::test]
    async fn concurrent_install_is_single_flight_and_atomically_published() {
        let cache = tempfile::tempdir().unwrap();
        let cache_dir = cache.path().to_path_buf();
        let paths = tool_cache_paths(&cache_dir, "test-tool", "1.0.0");
        let installs = Arc::new(AtomicUsize::new(0));
        let (staged_tx, staged_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = tokio::sync::oneshot::channel();

        let first_cache = cache_dir.clone();
        let first_installs = Arc::clone(&installs);
        let first = tokio::spawn(async move {
            install_tool_atomically(
                &first_cache,
                "test-tool",
                "1.0.0",
                move |_staging_env, staging_binary, _lease| async move {
                    first_installs.fetch_add(1, Ordering::SeqCst);
                    write_test_executable(&staging_binary, b"complete").await?;
                    let _ = staged_tx.send(());
                    let _ = release_rx.await;
                    Ok(())
                },
            )
            .await
        });

        staged_rx.await.unwrap();
        assert!(
            !paths.env_path.exists(),
            "the final directory must remain invisible while staging"
        );

        let second_cache = cache_dir.clone();
        let second_installs = Arc::clone(&installs);
        let second = tokio::spawn(async move {
            install_tool_atomically(
                &second_cache,
                "test-tool",
                "1.0.0",
                move |_staging_env, staging_binary, _lease| async move {
                    second_installs.fetch_add(1, Ordering::SeqCst);
                    write_test_executable(&staging_binary, b"duplicate").await?;
                    Ok(())
                },
            )
            .await
        });

        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(installs.load(Ordering::SeqCst), 1);
        assert!(!paths.env_path.exists());
        let _ = release_tx.send(());

        let first_tool = first.await.unwrap().unwrap();
        let second_tool = second.await.unwrap().unwrap();
        assert_eq!(first_tool.binary_path, second_tool.binary_path);
        assert_eq!(
            tokio::fs::read(&paths.binary_path).await.unwrap(),
            b"complete"
        );
        assert_eq!(installs.load(Ordering::SeqCst), 1);
        assert!(staging_paths(&cache_dir, &paths.staging_prefix).is_empty());
    }

    #[test]
    fn tool_install_process_helper() {
        let Ok(cache_dir) = std::env::var("NTERACT_TOOL_INSTALL_TEST_CACHE") else {
            return;
        };
        let ready_path =
            PathBuf::from(std::env::var("NTERACT_TOOL_INSTALL_TEST_READY").expect("ready path"));
        let release_path = PathBuf::from(
            std::env::var("NTERACT_TOOL_INSTALL_TEST_RELEASE").expect("release path"),
        );
        let count_path =
            PathBuf::from(std::env::var("NTERACT_TOOL_INSTALL_TEST_COUNT").expect("count path"));
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime
            .block_on(install_tool_atomically(
                Path::new(&cache_dir),
                "process-tool",
                "1.0.0",
                move |_staging_env, staging_binary, _lease| async move {
                    use std::io::Write;
                    let mut count = OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(&count_path)?;
                    writeln!(count, "{}", std::process::id())?;
                    write_test_executable(&staging_binary, b"complete").await?;
                    tokio::fs::write(&ready_path, b"ready").await?;
                    while !release_path.exists() {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Ok(())
                },
            ))
            .unwrap();
    }

    #[tokio::test]
    async fn cross_process_install_downloads_once_and_publishes_atomically() {
        let cache = tempfile::tempdir().unwrap();
        let cache_dir = cache.path().join("tools");
        let ready_path = cache.path().join("ready");
        let release_path = cache.path().join("release");
        let count_path = cache.path().join("count");
        let paths = tool_cache_paths(&cache_dir, "process-tool", "1.0.0");
        let test_binary = std::env::current_exe().unwrap();

        let spawn_helper = || {
            std::process::Command::new(&test_binary)
                .args([
                    "--exact",
                    "tools::tests::tool_install_process_helper",
                    "--nocapture",
                ])
                .env("NTERACT_TOOL_INSTALL_TEST_CACHE", &cache_dir)
                .env("NTERACT_TOOL_INSTALL_TEST_READY", &ready_path)
                .env("NTERACT_TOOL_INSTALL_TEST_RELEASE", &release_path)
                .env("NTERACT_TOOL_INSTALL_TEST_COUNT", &count_path)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap()
        };

        let first = spawn_helper();
        tokio::time::timeout(Duration::from_secs(5), async {
            while !ready_path.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("first installer did not reach the staging gate");
        assert!(!paths.env_path.exists());

        let second = spawn_helper();
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert!(!paths.env_path.exists());
        assert_eq!(
            std::fs::read_to_string(&count_path)
                .unwrap()
                .lines()
                .count(),
            1
        );

        tokio::fs::write(&release_path, b"release").await.unwrap();
        let first_output = first.wait_with_output().unwrap();
        let second_output = second.wait_with_output().unwrap();
        assert!(
            first_output.status.success(),
            "first helper failed:\n{}\n{}",
            String::from_utf8_lossy(&first_output.stdout),
            String::from_utf8_lossy(&first_output.stderr)
        );
        assert!(
            second_output.status.success(),
            "second helper failed:\n{}\n{}",
            String::from_utf8_lossy(&second_output.stdout),
            String::from_utf8_lossy(&second_output.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(&count_path)
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(std::fs::read(&paths.binary_path).unwrap(), b"complete");
        assert!(staging_paths(&cache_dir, &paths.staging_prefix).is_empty());
    }

    #[tokio::test]
    async fn failed_install_is_not_published_and_retry_replaces_legacy_partial() {
        let cache = tempfile::tempdir().unwrap();
        let cache_dir = cache.path().to_path_buf();
        let paths = tool_cache_paths(&cache_dir, "test-tool", "2.0.0");
        tokio::fs::create_dir_all(&paths.env_path).await.unwrap();
        tokio::fs::write(paths.env_path.join("partial"), b"legacy")
            .await
            .unwrap();

        let result = install_tool_atomically(
            &cache_dir,
            "test-tool",
            "2.0.0",
            |_staging_env, staging_binary, _lease| async move {
                write_test_executable(&staging_binary, b"partial").await?;
                Err(anyhow!("synthetic extraction failure"))
            },
        )
        .await;
        assert!(result.is_err());
        assert!(!paths.env_path.exists());
        assert!(staging_paths(&cache_dir, &paths.staging_prefix).is_empty());

        let tool = install_tool_atomically(
            &cache_dir,
            "test-tool",
            "2.0.0",
            |_staging_env, staging_binary, _lease| async move {
                write_test_executable(&staging_binary, b"complete").await
            },
        )
        .await
        .unwrap();
        assert_eq!(
            tokio::fs::read(tool.binary_path).await.unwrap(),
            b"complete"
        );
    }

    #[tokio::test]
    async fn cached_install_skips_installer() {
        let cache = tempfile::tempdir().unwrap();
        let cache_dir = cache.path().to_path_buf();
        let paths = tool_cache_paths(&cache_dir, "test-tool", "3.0.0");
        write_test_executable(&paths.binary_path, b"cached")
            .await
            .unwrap();

        let tool = install_tool_atomically(
            &cache_dir,
            "test-tool",
            "3.0.0",
            |_staging_env, _staging_binary, _lease| async move {
                Err(anyhow!("cached install unexpectedly invoked installer"))
            },
        )
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(tool.binary_path).await.unwrap(), b"cached");
    }

    #[test]
    fn checksum_mismatch_is_rejected() {
        let expected = hex::encode(Sha256::digest(b"expected"));
        let error = verify_checksum(b"actual", &expected, "test-tool").unwrap_err();
        assert!(error
            .to_string()
            .contains("Checksum mismatch for test-tool"));
    }

    #[test]
    fn test_compute_tool_hash() {
        let hash1 = compute_tool_hash("ruff", None);
        let hash2 = compute_tool_hash("ruff", Some("0.8"));
        let hash3 = compute_tool_hash("black", None);

        // Same tool/version should produce same hash
        assert_eq!(hash1, compute_tool_hash("ruff", None));

        // Different versions should produce different hashes
        assert_ne!(hash1, hash2);

        // Different tools should produce different hashes
        assert_ne!(hash1, hash3);
    }

    #[test]
    fn test_tools_cache_dir() {
        let dir = tools_cache_dir();
        let s = dir.to_string_lossy();
        // Channel-namespaced: stable is "runt", nightly is "runt-nightly".
        // Either is fine — what matters is the dir ends at `.../tools`.
        assert!(s.contains("runt"));
        assert!(s.ends_with("tools"));
    }

    #[test]
    fn test_compute_tool_hash_deno() {
        let hash1 = compute_tool_hash("deno", None);
        let hash2 = compute_tool_hash("deno", Some("2.0"));
        let hash_ruff = compute_tool_hash("ruff", None);

        // Same tool/version should produce same hash
        assert_eq!(hash1, compute_tool_hash("deno", None));

        // Different versions should produce different hashes
        assert_ne!(hash1, hash2);

        // Different tools should produce different hashes
        assert_ne!(hash1, hash_ruff);
    }

    #[test]
    fn test_compute_tool_hash_uv() {
        let hash1 = compute_tool_hash("uv", None);
        let hash2 = compute_tool_hash("uv", Some("0.10"));
        let hash_ruff = compute_tool_hash("ruff", None);

        // Same tool/version should produce same hash
        assert_eq!(hash1, compute_tool_hash("uv", None));

        // Different versions should produce different hashes
        assert_ne!(hash1, hash2);

        // Different tools should produce different hashes
        assert_ne!(hash1, hash_ruff);
    }

    #[test]
    fn test_parse_deno_major_version() {
        // Full version output format from `deno --version`
        assert_eq!(
            parse_deno_major_version("deno 2.7.1 (release, aarch64-apple-darwin)"),
            Some(2)
        );
        assert_eq!(
            parse_deno_major_version("deno 1.45.2 (release, x86_64-unknown-linux-gnu)"),
            Some(1)
        );
        assert_eq!(
            parse_deno_major_version("deno 2.0.0 (release, x86_64-pc-windows-msvc)"),
            Some(2)
        );

        // Simple version format
        assert_eq!(parse_deno_major_version("2.7.1"), Some(2));
        assert_eq!(parse_deno_major_version("1.0.0"), Some(1));
        assert_eq!(parse_deno_major_version("10.2.3"), Some(10));

        // Edge cases
        assert_eq!(parse_deno_major_version(""), None);
        assert_eq!(parse_deno_major_version("not a version"), None);
        assert_eq!(parse_deno_major_version("deno"), None);
    }

    #[test]
    fn test_get_github_platform() {
        let result = get_github_platform();
        // Should succeed on supported platforms (macOS, Linux, Windows on x86_64 or aarch64)
        #[cfg(any(
            all(target_arch = "aarch64", target_os = "macos"),
            all(target_arch = "x86_64", target_os = "macos"),
            all(target_arch = "aarch64", target_os = "linux"),
            all(target_arch = "x86_64", target_os = "linux"),
            all(target_arch = "x86_64", target_os = "windows"),
            all(target_arch = "aarch64", target_os = "windows"),
        ))]
        {
            assert!(result.is_ok());
            let platform = result.unwrap();
            assert!(!platform.arch.is_empty());
            assert!(!platform.platform.is_empty());
        }
    }

    #[test]
    fn test_get_pixi_github_platform() {
        let result = get_pixi_github_platform();
        #[cfg(any(
            all(target_arch = "aarch64", target_os = "macos"),
            all(target_arch = "x86_64", target_os = "macos"),
            all(target_arch = "aarch64", target_os = "linux"),
            all(target_arch = "x86_64", target_os = "linux"),
            all(target_arch = "x86_64", target_os = "windows"),
            all(target_arch = "aarch64", target_os = "windows"),
        ))]
        {
            assert!(result.is_ok());
            let platform = result.unwrap();
            assert!(!platform.arch.is_empty());
            assert!(!platform.platform.is_empty());
        }

        // Pixi uses musl on Linux, not glibc
        #[cfg(target_os = "linux")]
        {
            let p = get_pixi_github_platform().unwrap();
            assert_eq!(p.platform, "unknown-linux-musl");
            // Contrast with get_github_platform which uses glibc
            let glibc_p = get_github_platform().unwrap();
            assert_eq!(glibc_p.platform, "unknown-linux-gnu");
        }
    }

    #[test]
    fn test_deno_platform_mapping() {
        // Verify platform strings match GitHub release asset naming
        #[cfg(all(target_arch = "aarch64", target_os = "macos"))]
        {
            let p = get_github_platform().unwrap();
            assert_eq!(p.arch, "aarch64");
            assert_eq!(p.platform, "apple-darwin");
        }

        #[cfg(all(target_arch = "x86_64", target_os = "macos"))]
        {
            let p = get_github_platform().unwrap();
            assert_eq!(p.arch, "x86_64");
            assert_eq!(p.platform, "apple-darwin");
        }

        #[cfg(all(target_arch = "x86_64", target_os = "linux"))]
        {
            let p = get_github_platform().unwrap();
            assert_eq!(p.arch, "x86_64");
            assert_eq!(p.platform, "unknown-linux-gnu");
        }

        #[cfg(all(target_arch = "aarch64", target_os = "linux"))]
        {
            let p = get_github_platform().unwrap();
            assert_eq!(p.arch, "aarch64");
            assert_eq!(p.platform, "unknown-linux-gnu");
        }

        #[cfg(all(target_arch = "x86_64", target_os = "windows"))]
        {
            let p = get_github_platform().unwrap();
            assert_eq!(p.arch, "x86_64");
            assert_eq!(p.platform, "pc-windows-msvc");
        }
    }

    #[test]
    fn test_version_constants() {
        // Ensure constants are sensible - version strings contain dots
        assert!(DENO_TARGET_VERSION.contains('.'));
        assert!(UV_TARGET_VERSION.contains('.'));
        assert!(RUFF_TARGET_VERSION.contains('.'));
        assert!(PIXI_TARGET_VERSION.contains('.'));
    }

    // ── Nono unit tests (no network) ────────────────────────────────

    #[cfg(unix)]
    #[test]
    fn test_nono_version_constant() {
        // Version string must be semver-shaped: at least two dots.
        assert!(
            NONO_TARGET_VERSION.contains('.'),
            "NONO_TARGET_VERSION should be a semver string, got {NONO_TARGET_VERSION}"
        );
        let parts: Vec<&str> = NONO_TARGET_VERSION.split('.').collect();
        assert!(
            parts.len() >= 2,
            "NONO_TARGET_VERSION should have at least major.minor, got {NONO_TARGET_VERSION}"
        );
        // Each part must parse as a non-negative integer.
        for part in &parts {
            part.parse::<u32>().unwrap_or_else(|_| {
                panic!("NONO_TARGET_VERSION component '{part}' is not a valid integer")
            });
        }
    }

    #[cfg(unix)]
    #[test]
    fn test_nono_tool_hash_stable() {
        // Same version → same hash (deterministic cache key).
        let h1 = compute_tool_hash("nono", Some(NONO_TARGET_VERSION));
        let h2 = compute_tool_hash("nono", Some(NONO_TARGET_VERSION));
        assert_eq!(h1, h2);
    }

    #[cfg(unix)]
    #[test]
    fn test_nono_tool_hash_differs_from_other_tools() {
        // nono must not collide with uv or pixi at the same version string.
        let nono_hash = compute_tool_hash("nono", Some(NONO_TARGET_VERSION));
        let uv_hash = compute_tool_hash("uv", Some(NONO_TARGET_VERSION));
        let pixi_hash = compute_tool_hash("pixi", Some(NONO_TARGET_VERSION));
        assert_ne!(nono_hash, uv_hash);
        assert_ne!(nono_hash, pixi_hash);
    }

    #[cfg(unix)]
    #[test]
    fn test_nono_tool_hash_differs_across_versions() {
        let h1 = compute_tool_hash("nono", Some("0.62.0"));
        let h2 = compute_tool_hash("nono", Some("0.63.0"));
        assert_ne!(h1, h2);
    }

    #[cfg(unix)]
    #[test]
    fn test_nono_cached_binary_path_is_under_tools_dir() {
        let path = cached_tool_binary_path("nono", Some(NONO_TARGET_VERSION));
        let tools = tools_cache_dir();
        assert!(
            path.starts_with(&tools),
            "nono cache path {path:?} should be under tools dir {tools:?}"
        );
        // Must end with the binary name (no .exe on Unix).
        assert_eq!(path.file_name().unwrap(), "nono");
    }

    #[cfg(unix)]
    #[test]
    fn test_nono_asset_name_format() {
        // Verify the asset name we'd construct matches the real GitHub release
        // naming convention: nono-v{version}-{arch}-{platform}.tar.gz
        let platform = get_github_platform().unwrap();
        let asset = format!(
            "nono-v{}-{}-{}.tar.gz",
            NONO_TARGET_VERSION, platform.arch, platform.platform
        );
        assert!(asset.starts_with("nono-v"));
        assert!(asset.ends_with(".tar.gz"));
        assert!(asset.contains(NONO_TARGET_VERSION));
        assert!(asset.contains(platform.arch));
        assert!(asset.contains(platform.platform));
        // The v-prefix must be present in the asset name (unlike uv/ruff which have no v).
        assert!(
            asset.contains(&format!("nono-v{}", NONO_TARGET_VERSION)),
            "asset name should embed 'nono-v{{version}}', got {asset}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn test_nono_checksum_url_format() {
        // SHA256SUMS.txt is served as a release asset alongside the archives,
        // matching the same CDN path used by all other tools.
        let version = NONO_TARGET_VERSION;
        let url = format!(
            "https://github.com/always-further/nono/releases/download/v{}/SHA256SUMS.txt",
            version
        );
        assert!(url.contains("/always-further/nono/"));
        assert!(url.contains(&format!("/v{}/", version)));
        assert!(url.ends_with("SHA256SUMS.txt"));
    }

    // ── Nono network integration test ───────────────────────────────
    //
    // Marked #[ignore] so `cargo test` is hermetic. CI runs it explicitly
    // with `cargo test -p kernel-launch -- --ignored nono`, matching the
    // pattern used in notebook-sync for daemon-dependent tests.

    #[cfg(unix)]
    #[tokio::test]
    #[ignore = "makes real network calls to GitHub and Sigstore; run with --ignored"]
    async fn test_get_nono_path_downloads_and_verifies() {
        // This test exercises the full download + Sigstore attestation path.
        // It downloads the real nono binary from GitHub, verifies the bundle,
        // and checks that the resulting binary is executable.
        //
        // Uses a temp dir so it does not pollute the real tools cache and
        // can be re-run cleanly even if a previous run left a partial download.
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("tempdir");
        let result = download_nono_from_github(NONO_TARGET_VERSION).await;

        match result {
            Ok(tool) => {
                assert!(
                    tool.binary_path.exists(),
                    "nono binary should exist at {:?}",
                    tool.binary_path
                );
                let meta = std::fs::metadata(&tool.binary_path)
                    .expect("should be able to stat nono binary");
                assert!(meta.is_file(), "nono path should be a regular file");
                // Must be executable.
                let mode = meta.permissions().mode();
                assert!(
                    mode & 0o111 != 0,
                    "nono binary should be executable, mode={mode:o}"
                );
                // Sanity: running `nono --version` should succeed.
                let output = tokio::process::Command::new(&tool.binary_path)
                    .arg("--version")
                    .output()
                    .await
                    .expect("should be able to run nono --version");
                assert!(
                    output.status.success(),
                    "nono --version exited with {:?}",
                    output.status
                );
                let stdout = String::from_utf8_lossy(&output.stdout);
                assert!(
                    stdout.contains(NONO_TARGET_VERSION),
                    "nono --version output '{stdout}' should contain version {NONO_TARGET_VERSION}"
                );
            }
            Err(e) => panic!("download_nono_from_github failed: {e}"),
        }

        drop(tmp);
    }
}
