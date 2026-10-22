//! Tool bootstrapping via direct GitHub downloads.
//!
//! This module provides a way to automatically install CLI tools (like `ruff`, `deno`, `uv`, `pixi`)
//! on demand. Tools are downloaded from GitHub releases and cached in `~/.cache/runt/tools/`.

use anyhow::{anyhow, Result};
use log::{info, warn};
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

use crate::CommandOutputExt;

mod pinned_hashes;

/// Target Deno version for GitHub download.
pub const DENO_TARGET_VERSION: &str = "2.9.8";

/// Target UV version for GitHub download.
pub const UV_TARGET_VERSION: &str = "0.13.5";

/// Old system uv releases carry a CA bundle affected by the eMudhra incident.
pub const UV_MIN_VERSION: &str = "0.13.5";

/// Target ruff version for GitHub download.
pub const RUFF_TARGET_VERSION: &str = "0.15.11";

/// Target pixi version for GitHub download.
/// Pinned to ensure stable `pixi info --json` and `pixi shell-hook --json` output.
pub const PIXI_TARGET_VERSION: &str = "0.82.1";

/// First pixi release with the eMudhra certificate verification fixes.
pub const PIXI_MIN_VERSION: &str = "0.82.1";

/// First Deno release that rejects compromised eMudhra intermediate keys.
pub const DENO_MIN_VERSION: &str = "2.9.8";

/// Platform information for GitHub release assets (shared by Deno, UV, and ruff).
struct GithubPlatform {
    arch: &'static str,
    platform: &'static str,
}

impl GithubPlatform {
    fn asset_name(&self, tool: &str, zip: bool) -> String {
        let ext = if zip { "zip" } else { "tar.gz" };
        format!("{tool}-{}-{}.{ext}", self.arch, self.platform)
    }
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

fn pinned_checksum(tool: &str, version: &str, asset: &str) -> Result<&'static str> {
    pinned_hashes::ARCHIVES
        .iter()
        .find(|(t, v, a, _)| *t == tool && *v == version && *a == asset)
        .map(|(_, _, _, hash)| *hash)
        .ok_or_else(|| anyhow!("No trusted checksum for {tool} {version} asset {asset}"))
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
        (platform.asset_name("ruff", true), true)
    } else {
        (platform.asset_name("ruff", false), false)
    };

    // Build URLs — ruff tags have NO `v` prefix
    let download_url = format!(
        "https://github.com/astral-sh/ruff/releases/download/{}/{}",
        version, asset_name
    );
    let expected_hash = pinned_checksum("ruff", version, &asset_name)?;

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
            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download ruff: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, expected_hash, "ruff")?;

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
                .output_owned()
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
static DENO_PATH: OnceCell<PathBuf> = OnceCell::const_new();

/// Check for supported system Deno or the current version-keyed cache.
/// This UI probe never starts a download.
pub async fn check_deno_available_without_bootstrap() -> bool {
    if supported_system_tool("deno", DENO_MIN_VERSION)
        .await
        .is_some()
    {
        return true;
    }
    supported_tool_at_path(
        &cached_tool_binary_path("deno", Some(DENO_TARGET_VERSION)),
        "deno",
        DENO_MIN_VERSION,
    )
    .await
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
    let asset_name = platform.asset_name("deno", true);

    // Build URLs
    let zip_url = format!(
        "https://github.com/denoland/deno/releases/download/v{}/{}",
        version, asset_name
    );
    let expected_hash = pinned_checksum("deno", version, &asset_name)?;

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

            info!("Downloading {}...", asset_name);
            let zip_response = client.get(&zip_url).send().await?;
            if !zip_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download deno: {}",
                    zip_response.status()
                ));
            }
            let zip_bytes = zip_response.bytes().await?;

            verify_checksum(&zip_bytes, expected_hash, "deno")?;

            info!("Extracting deno to {:?}...", staging_env);
            tokio::task::spawn_blocking(move || -> Result<()> {
                let _lease = lease;
                let _extracted_binary = extract_deno_zip(&zip_bytes, &staging_env)?;

                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let perms = std::fs::Permissions::from_mode(0o755);
                    std::fs::set_permissions(&_extracted_binary, perms)?;
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
/// 1. System deno at or above DENO_MIN_VERSION.
/// 2. Version-keyed cache or GitHub download of DENO_TARGET_VERSION.
///
/// Successful resolutions are cached; failures can be retried.
pub async fn get_deno_path() -> Result<PathBuf> {
    cached_tool_path(&DENO_PATH, || async {
        if let Some(path) = supported_system_tool("deno", DENO_MIN_VERSION).await {
            return Ok(path);
        }
        info!("Resolving pinned deno version {}", DENO_TARGET_VERSION);
        Ok(download_deno_from_github(DENO_TARGET_VERSION)
            .await?
            .binary_path)
    })
    .await
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
        (platform.asset_name("uv", true), true)
    } else {
        (platform.asset_name("uv", false), false)
    };

    // Build URLs
    let download_url = format!(
        "https://github.com/astral-sh/uv/releases/download/{}/{}",
        version, asset_name
    );
    let expected_hash = pinned_checksum("uv", version, &asset_name)?;

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
            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download uv: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, expected_hash, "uv")?;

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
static UV_PATH: OnceCell<PathBuf> = OnceCell::const_new();

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

/// Only accept a stable numeric release. Unknown or prerelease builds do not
/// establish that the security fix is present; use the pinned fallback instead.
fn stable_tool_version(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.split('.');
    let mut next = || {
        let part = parts.next()?;
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        part.parse().ok()
    };
    let version = (next()?, next()?, next()?);
    parts.next().is_none().then_some(version)
}

fn tool_version_is_supported(tool: &str, output: &[u8], minimum: &str) -> bool {
    let Ok(output) = std::str::from_utf8(output) else {
        return false;
    };
    let mut words = output.split_whitespace();
    if words.next() != Some(tool) {
        return false;
    }
    match (
        words.next().and_then(stable_tool_version),
        stable_tool_version(minimum),
    ) {
        (Some(actual), Some(minimum)) => actual >= minimum,
        _ => false,
    }
}

async fn supported_tool_at_path(path: &Path, tool: &str, minimum: &str) -> bool {
    let mut command = tokio::process::Command::new(path);
    command.arg("--version");
    matches!(
        tokio::time::timeout(std::time::Duration::from_secs(5), command.output_owned()).await,
        Ok(Ok(output)) if output.status.success()
            && tool_version_is_supported(tool, &output.stdout, minimum)
    )
}

/// Cache successful resolutions only so an offline/bootstrap failure can be
/// retried by the next request without restarting the daemon.
async fn cached_tool_path<F, Fut>(cache: &OnceCell<PathBuf>, init: F) -> Result<PathBuf>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<PathBuf>>,
{
    cache.get_or_try_init(init).await.cloned()
}

async fn supported_system_tool(tool: &str, minimum: &str) -> Option<PathBuf> {
    // Probe the exact executable we return. Absolutize relative PATH entries
    // so a later kernel working directory cannot change what gets executed.
    let path = std::path::absolute(find_in_path(tool)?).ok()?;
    if supported_tool_at_path(&path, tool, minimum).await {
        info!("Using supported system {tool} at {}", path.display());
        Some(path)
    } else {
        warn!(
            "Ignoring system {tool} at {}: could not verify a stable version >= {minimum}; \
             using nteract's pinned fallback. The system installation is unchanged.",
            path.display()
        );
        None
    }
}

/// Get the path to uv, with the following priority:
///
/// 1. System uv on PATH at or above [`UV_MIN_VERSION`].
/// 2. Version-keyed cache or GitHub download of [`UV_TARGET_VERSION`].
///
/// Older/unknown system releases are left untouched. Successful results are cached until
/// process restart; no user Python environments are upgraded by tool selection.
pub async fn get_uv_path() -> Result<PathBuf> {
    cached_tool_path(&UV_PATH, || async {
        if let Some(path) = supported_system_tool("uv", UV_MIN_VERSION).await {
            return Ok(path);
        }
        info!("Resolving pinned uv version {}", UV_TARGET_VERSION);
        Ok(download_uv_from_github(UV_TARGET_VERSION)
            .await?
            .binary_path)
    })
    .await
}

// ── Pixi ─────────────────────────────────────────────────────────────

/// Global cache for the pixi binary path.
static PIXI_PATH: OnceCell<PathBuf> = OnceCell::const_new();

/// Download and verify the pixi binary from GitHub releases.
///
/// Pixi tags have a `v` prefix: `https://github.com/prefix-dev/pixi/releases/download/v{version}/...`
/// Pixi uses musl on Linux (not glibc), hence `get_pixi_github_platform()`.
async fn download_pixi_from_github(version: &str) -> Result<BootstrappedTool> {
    let platform = get_pixi_github_platform()?;

    // Pixi uses tar.gz on Unix, zip on Windows
    let (asset_name, is_zip) = if cfg!(windows) {
        (platform.asset_name("pixi", true), true)
    } else {
        (platform.asset_name("pixi", false), false)
    };

    // Build URLs — pixi tags have a `v` prefix
    let download_url = format!(
        "https://github.com/prefix-dev/pixi/releases/download/v{}/{}",
        version, asset_name
    );
    let expected_hash = pinned_checksum("pixi", version, &asset_name)?;

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
            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download pixi: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, expected_hash, "pixi")?;

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

/// Get system pixi at or above [`PIXI_MIN_VERSION`], otherwise the version-keyed
/// cache or GitHub download of [`PIXI_TARGET_VERSION`]. Old system installs and
/// existing project environments are left untouched by tool selection.
///
/// Successful resolutions are cached; failures can be retried.
pub async fn get_pixi_path() -> Result<PathBuf> {
    cached_tool_path(&PIXI_PATH, || async {
        if let Some(path) = supported_system_tool("pixi", PIXI_MIN_VERSION).await {
            return Ok(path);
        }
        info!("Resolving pinned pixi version {}", PIXI_TARGET_VERSION);
        Ok(download_pixi_from_github(PIXI_TARGET_VERSION)
            .await?
            .binary_path)
    })
    .await
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
/// Checksums:    independent per-archive SHA-256 digests shipped with nteract.
/// Tag format:   `v{version}` (the `v` also appears in the asset filename).
///
/// Integrity is checked before extraction against the compiled-in digest.
/// A remote checksum obtained through the same TLS connection is not trusted.
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
    let expected_hash = pinned_checksum("nono", version, &asset_name)?;

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

            info!("Downloading {}...", asset_name);
            let archive_response = client.get(&download_url).send().await?;
            if !archive_response.status().is_success() {
                return Err(anyhow!(
                    "Failed to download nono: {}",
                    archive_response.status()
                ));
            }
            let archive_bytes = archive_response.bytes().await?;
            verify_checksum(&archive_bytes, expected_hash, "nono")?;

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
                .output_owned()
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
        .output_owned()
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
        .output_owned()
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

    #[test]
    fn pinned_checksums_cover_shipped_platforms_and_reject_unpinned_assets() {
        for (tool, version) in [
            ("uv", UV_TARGET_VERSION),
            ("pixi", PIXI_TARGET_VERSION),
            ("deno", DENO_TARGET_VERSION),
            ("ruff", RUFF_TARGET_VERSION),
        ] {
            for arch in ["aarch64", "x86_64"] {
                for platform in [
                    "apple-darwin",
                    "pc-windows-msvc",
                    if tool == "pixi" {
                        "unknown-linux-musl"
                    } else {
                        "unknown-linux-gnu"
                    },
                ] {
                    let zip = tool == "deno" || platform.contains("windows");
                    let asset = GithubPlatform { arch, platform }.asset_name(tool, zip);
                    let hash = pinned_checksum(tool, version, &asset).unwrap();
                    assert_eq!(hash.len(), 64);
                    assert!(hex::decode(hash).is_ok());
                    assert!(verify_checksum(b"substituted archive", hash, tool).is_err());
                    assert!(pinned_checksum(tool, "unreviewed-version", &asset).is_err());
                }
            }
        }
        #[cfg(unix)]
        for arch in ["aarch64", "x86_64"] {
            for platform in ["apple-darwin", "unknown-linux-gnu"] {
                let asset = format!("nono-v{NONO_TARGET_VERSION}-{arch}-{platform}.tar.gz");
                assert!(pinned_checksum("nono", NONO_TARGET_VERSION, &asset).is_ok());
            }
        }
        assert!(pinned_checksum("uv", UV_TARGET_VERSION, "../unknown.tar.gz").is_err());
    }

    #[tokio::test]
    async fn tool_resolution_retries_after_failure_and_caches_success() {
        let cache = OnceCell::new();
        let failed = cached_tool_path(&cache, || async { Err(anyhow!("offline")) }).await;
        assert!(failed.is_err());
        assert!(cache.get().is_none());
        let path = PathBuf::from("patched-tool");
        assert_eq!(
            cached_tool_path(&cache, || async { Ok(path.clone()) })
                .await
                .unwrap(),
            path
        );
        assert_eq!(
            cached_tool_path(&cache, || async { Err(anyhow!("must reuse success")) })
                .await
                .unwrap(),
            path
        );
    }

    #[test]
    fn system_tool_security_version_policy() {
        for (tool, minimum, old, current) in [
            ("uv", UV_MIN_VERSION, "0.10.8", UV_TARGET_VERSION),
            ("pixi", PIXI_MIN_VERSION, "0.67.1", PIXI_TARGET_VERSION),
            ("deno", DENO_MIN_VERSION, "2.7.1", DENO_TARGET_VERSION),
        ] {
            for version in [minimum, current, "10.0.0", "20.0.0"] {
                assert!(tool_version_is_supported(
                    tool,
                    format!("{tool} {version} (build metadata)\n").as_bytes(),
                    minimum
                ));
            }
            for version in [
                old,
                "0.9.99",
                "0.0.0",
                "0.99.0-rc.1",
                "0.99.0+dev",
                "1.0",
                "1.0.0.1",
                "v1.0.0",
                "1.+0.0",
            ] {
                assert!(
                    !tool_version_is_supported(
                        tool,
                        format!("{tool} {version}\n").as_bytes(),
                        minimum
                    ),
                    "unexpectedly accepted {tool} {version}"
                );
            }
            for output in [
                b"".as_slice(),
                b"other 1.0.0",
                b"warning: uv 1.0.0",
                b"uv \xff",
            ] {
                assert!(!tool_version_is_supported(tool, output, minimum));
            }
        }
        assert!(!tool_version_is_supported(
            "uv",
            b"uv 0.13.4",
            UV_MIN_VERSION
        ));
        assert!(!tool_version_is_supported(
            "pixi",
            b"pixi 0.82.0",
            PIXI_MIN_VERSION
        ));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn system_tool_probe_requires_success_and_preserves_executable() {
        let fixture = tempfile::tempdir().unwrap();
        let path = fixture.path().join("tool with spaces");
        for (tool, minimum, version) in [
            ("uv", UV_MIN_VERSION, UV_TARGET_VERSION),
            ("pixi", PIXI_MIN_VERSION, PIXI_TARGET_VERSION),
            ("deno", DENO_MIN_VERSION, DENO_TARGET_VERSION),
        ] {
            for (reported, status, accepted) in [
                (version, 0, true),
                ("0.1.0", 0, false),
                (version, 1, false),
                ("unknown", 0, false),
            ] {
                let script = format!("#!/bin/sh\n[ \"$1\" = --version ] || exit 9\nprintf '{tool} {reported}\\n'\nexit {status}\n");
                write_test_executable(&path, script.as_bytes())
                    .await
                    .unwrap();
                assert_eq!(supported_tool_at_path(&path, tool, minimum).await, accepted);
                assert_eq!(std::fs::read(&path).unwrap(), script.as_bytes());
            }
        }
        assert!(
            !supported_tool_at_path(&fixture.path().join("missing"), "uv", UV_MIN_VERSION).await
        );
    }

    #[cfg(unix)]
    #[test]
    fn system_tool_resolution_process_helper() {
        let Ok(root) = std::env::var("NTERACT_TOOL_SELECTION_FIXTURE") else {
            return;
        };
        let root = PathBuf::from(root);
        assert!(tools_cache_dir().starts_with(&root));
        tokio::runtime::Runtime::new().unwrap().block_on(async {
            for (tool, version) in [
                ("uv", UV_TARGET_VERSION),
                ("pixi", PIXI_TARGET_VERSION),
                ("deno", DENO_TARGET_VERSION),
            ] {
                let cached = cached_tool_binary_path(tool, Some(version));
                write_test_executable(&cached, b"fixed cached executable")
                    .await
                    .unwrap();
                let selected = match tool {
                    "uv" => get_uv_path().await,
                    "pixi" => get_pixi_path().await,
                    "deno" => get_deno_path().await,
                    _ => unreachable!(),
                }
                .unwrap();
                let expected = if std::env::var("NTERACT_EXPECT_SYSTEM").unwrap() == "true" {
                    root.join("relative-bin").join(tool)
                } else {
                    cached
                };
                assert_eq!(selected, expected);
                assert!(selected.is_absolute());
            }
        });
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn system_path_selection_uses_safe_version_or_pinned_cache() {
        for safe in [false, true] {
            let directory = tempfile::tempdir().unwrap();
            let root = directory.path().canonicalize().unwrap();
            for (tool, version) in [
                ("uv", UV_MIN_VERSION),
                ("pixi", PIXI_MIN_VERSION),
                ("deno", DENO_MIN_VERSION),
            ] {
                let version = if safe { version } else { "0.1.0" };
                let script = format!("#!/bin/sh\nprintf '{tool} {version}\\n'\n");
                write_test_executable(&root.join("relative-bin").join(tool), script.as_bytes())
                    .await
                    .unwrap();
            }
            // Child-only environment isolates PATH, HOME, and both OnceCells
            // from concurrently running tests and real application caches.
            let output = tokio::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tools::tests::system_tool_resolution_process_helper",
                    "--nocapture",
                ])
                .env_clear()
                .env("HOME", &root)
                .env("XDG_CACHE_HOME", root.join("cache"))
                .env("PATH", "relative-bin")
                .env("NTERACT_TOOL_SELECTION_FIXTURE", &root)
                .env("NTERACT_EXPECT_SYSTEM", safe.to_string())
                .current_dir(&root)
                .output_owned()
                .await
                .unwrap();
            assert!(
                output.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[tokio::test]
    async fn security_pin_ignores_old_and_unversioned_caches_without_deleting_them() {
        let cache = tempfile::tempdir().unwrap();
        for (tool, old_version, version) in [
            ("uv", "0.10.8", UV_TARGET_VERSION),
            ("pixi", "0.67.1", PIXI_TARGET_VERSION),
            ("deno", "2.7.1", DENO_TARGET_VERSION),
        ] {
            let old = tool_cache_paths(cache.path(), tool, old_version);
            let legacy = binary_path_for_env(
                &cache
                    .path()
                    .join(format!("{tool}-{}", compute_tool_hash(tool, None))),
                tool,
            );
            for path in [&old.binary_path, &legacy] {
                write_test_executable(path, b"old executable")
                    .await
                    .unwrap();
            }
            // Failed fresh installation must not fall back to the unsafe cache.
            let failure = install_tool_atomically(cache.path(), tool, version, |_, _, _| async {
                Err(anyhow!("offline"))
            })
            .await;
            assert!(failure.is_err());
            let installed = install_tool_atomically(
                cache.path(),
                tool,
                version,
                |_, binary, _lease| async move {
                    write_test_executable(&binary, b"fixed executable").await
                },
            )
            .await
            .unwrap();
            assert_eq!(
                std::fs::read(&installed.binary_path).unwrap(),
                b"fixed executable"
            );
            assert_ne!(installed.binary_path, old.binary_path);
            for path in [&old.binary_path, &legacy] {
                assert_eq!(std::fs::read(path).unwrap(), b"old executable");
            }
            let reused = install_tool_atomically(cache.path(), tool, version, |_, _, _| async {
                Err(anyhow!("must reuse fixed cache"))
            })
            .await
            .unwrap();
            assert_eq!(reused.binary_path, installed.binary_path);
        }
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

        #[cfg(all(target_arch = "aarch64", target_os = "windows"))]
        {
            let p = get_github_platform().unwrap();
            assert_eq!(p.arch, "aarch64");
            assert_eq!(p.platform, "pc-windows-msvc");
        }
    }

    #[test]
    fn windows_arm64_github_asset_names() {
        let p = GithubPlatform {
            arch: "aarch64",
            platform: "pc-windows-msvc",
        };
        assert_eq!(
            p.asset_name("deno", true),
            "deno-aarch64-pc-windows-msvc.zip"
        );
        assert_eq!(p.asset_name("uv", true), "uv-aarch64-pc-windows-msvc.zip");
        assert_eq!(
            p.asset_name("ruff", true),
            "ruff-aarch64-pc-windows-msvc.zip"
        );
        assert_eq!(
            p.asset_name("pixi", true),
            "pixi-aarch64-pc-windows-msvc.zip"
        );
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
        // This test exercises the full download + pinned SHA-256 verification path.
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
                    .output_owned()
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
