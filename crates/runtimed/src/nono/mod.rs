//! nono binary discovery and startup smoke-check.
//!
//! nono.sh is a network proxy and credential injector for sandboxed kernel
//! processes. The daemon ships a vendored nono binary so users do not need to
//! install it separately.
//!
//! ## Distribution model (D-1)
//!
//! nono is bundled inside the nteract distribution. A known-good version is
//! always available alongside the runtimed binary, and the daemon locates it
//! deterministically without depending on `brew install nono` or any other
//! user-visible setup step.
//!
//! ## Version pinning
//!
//! The CLI surface is pre-1.0 and may have breaking changes between minor
//! releases. [`NONO_VERSION`] records the exact version against which the
//! empirical tests in `docs/sandbox/nono-empirical-tests.md` were validated.
//! Track upstream releases manually and re-validate when updating.
//!
//! Empirical truths validated against this version (see decisions.md):
//! - `--session-id` flag does not exist.
//! - `--credential <unknown>` → fatal exit 1.
//! - `--env-credential <missing>` → fatal exit 1: "Secret not found in keystore".
//! - `--credential <known>` with missing key → non-fatal WARN, process continues.
//! - Session ID appears on stdout (not stderr) at -vv only, as a DEBUG line.
//! - nono does NOT create a new process group; kernel child survives SIGKILL on nono.
//! - Profiles must be JSON (not YAML).
//! - Always use `-vv` to get per-request audit log entries (D-13).
//!
//! ## Binary discovery (resolution order)
//!
//! 1. `NONO_BIN` environment variable — developer override for testing newer builds.
//! 2. Bundled binary next to the runtimed executable.
//! 3. PATH lookup as a last-resort fallback.
//!
//! ## Acquiring the binary
//!
//! **Development (Option A):** `cargo xtask dev-daemon` runs
//! `cargo install nono-cli --version <NONO_VERSION> --root target/nono-bin`
//! before starting the daemon, placing the binary at
//! `target/nono-bin/bin/nono` alongside the compiled runtimed binary.
//!
//! **Release packaging:** TODO — download prebuilt binaries from
//! `github.com/always-further/nono/releases` for each supported target triple
//! (`aarch64-apple-darwin`, `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`)
//! and vendor them in `vendor/nono/<version>/<target>/nono`. Bundle the
//! platform-appropriate binary in the Tauri app alongside runtimed.
//!
//! ## NONO_BIN override
//!
//! Set `NONO_BIN=/path/to/nono` to override the bundled binary entirely.
//! This is useful for:
//! - Testing a newer nono build before it's officially vendored.
//! - CI runs that install nono separately.
//! - Debugging with a patched nono binary.
//!
//! ## Sandbox is opt-in (D-3)
//!
//! Notebooks without a sandbox profile launch kernels with the existing
//! direct-network behavior. The nono binary is only required when a sandbox
//! profile is active. Daemon startup logs a warning when nono is absent but
//! does NOT fail startup — sandbox is a per-notebook opt-in feature.

pub mod events;
pub mod profile;
pub mod supervisor;

pub use supervisor::{
    StderrLine, StdoutLine, Supervisor, SupervisorConfig, SupervisorError, SupervisorExit,
    SupervisorHandle, NONE_PID,
};

use std::path::PathBuf;
use std::time::Duration;

use tracing::{info, warn};

/// The nono-cli version this daemon was built and tested against.
///
/// The empirical tests in `docs/sandbox/nono-empirical-tests.md` were
/// validated against this exact version. Breaking CLI changes between minor
/// releases are known to occur (the CLI surface is pre-1.0). Update this
/// constant together with the test results when bumping.
pub const NONO_VERSION: &str = "0.62.0";

/// Error returned when the nono binary cannot be located.
#[derive(Debug, thiserror::Error)]
#[error("nono binary not found (tried NONO_BIN env, bundled alongside runtimed, then PATH)")]
pub struct NonoUnavailable;

/// Returns the path to the bundled nono binary.
///
/// ## Resolution order
///
/// 1. `NONO_BIN` environment variable (developer override — useful for testing
///    newer nono builds or running from a custom install location).
/// 2. Bundled location next to the runtimed binary:
///    - In the Tauri app bundle: `Resources/nono` (or platform equivalent).
///    - In a headless install: sibling of `runtimed` in the same directory.
///    - In `cargo xtask dev-daemon`: `target/nono-bin/bin/nono` relative to
///      the workspace root (installed by `cargo install nono-cli`).
/// 3. PATH lookup as a last-resort fallback.
///
/// Returns [`NonoUnavailable`] if no binary is found at any of these locations.
pub fn binary_path() -> Result<PathBuf, NonoUnavailable> {
    // 1. Explicit override via environment variable.
    if let Ok(env_path) = std::env::var("NONO_BIN") {
        let path = PathBuf::from(env_path);
        if path.is_file() {
            return Ok(path);
        }
        warn!(
            "[nono] NONO_BIN is set to '{}' but the file does not exist",
            path.display()
        );
        return Err(NonoUnavailable);
    }

    // 2. Bundled alongside the runtimed binary.
    if let Some(bundled) = bundled_path() {
        if bundled.is_file() {
            return Ok(bundled);
        }
    }

    // 3. PATH fallback.
    if let Some(from_path) = path_lookup("nono") {
        return Ok(from_path);
    }

    Err(NonoUnavailable)
}

/// Returns the expected bundled nono path relative to the runtimed executable,
/// or `None` if the current executable path cannot be resolved.
///
/// In a Tauri app bundle on macOS the runtimed binary sits inside
/// `<App>.app/Contents/MacOS/` while the vendored nono lives in the same
/// directory (Tauri places all `externalBin` sidecars there). In a headless
/// install both binaries are in the same directory.
fn bundled_path() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    Some(dir.join("nono"))
}

/// Look up `name` via the `PATH` environment variable.
///
/// Returns the first existing executable found on PATH, or `None`.
fn path_lookup(name: &str) -> Option<PathBuf> {
    let path_var = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path_var) {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

/// Run `nono --version` and return the reported version string.
///
/// Times out after `timeout`. Returns an error if nono is not found,
/// fails to execute, or does not exit successfully within the timeout.
async fn run_nono_version(
    nono_path: &std::path::Path,
    timeout: Duration,
) -> anyhow::Result<String> {
    let output = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(nono_path)
            .arg("--version")
            .output(),
    )
    .await
    .map_err(|_| anyhow::anyhow!("nono --version timed out after {:?}", timeout))??;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow::anyhow!(
            "nono --version exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    // nono --version prints "nono vX.Y.Z" on stdout.
    let stdout = String::from_utf8_lossy(&output.stdout);
    Ok(stdout.trim().to_string())
}

/// One-shot daemon startup smoke-check for the nono binary.
///
/// This is intentionally **non-fatal** — sandbox is opt-in per D-3, so
/// a missing nono binary must not prevent the daemon from starting.
///
/// The check:
/// - Resolves the binary via [`binary_path()`].
/// - Runs `nono --version` with a 5-second timeout.
/// - Logs the version at INFO level on success.
/// - Compares the reported version against [`NONO_VERSION`] and logs a WARNING
///   on mismatch (the daemon continues; the warning is actionable for operators).
/// - Logs a WARNING if the binary is not found or the check fails (also
///   non-fatal; sandbox features simply won't work until nono is available).
pub async fn startup_check() {
    match binary_path() {
        Ok(path) => {
            info!(
                "[nono] Binary found at '{}'; running version check",
                path.display()
            );
            match run_nono_version(&path, Duration::from_secs(5)).await {
                Ok(version_line) => {
                    info!("[nono] {}", version_line);
                    // nono prints "nono vX.Y.Z" — extract the version after "nono v" or "nono ".
                    let reported = version_line
                        .strip_prefix("nono v")
                        .or_else(|| version_line.strip_prefix("nono "))
                        .unwrap_or(version_line.as_str())
                        .trim();
                    if reported != NONO_VERSION {
                        warn!(
                            "[nono] Version mismatch: bundled expects {} but binary reports {}. \
                             Sandbox behavior may differ from tested expectations. \
                             Update NONO_VERSION or re-vendor the binary.",
                            NONO_VERSION, reported
                        );
                    }
                }
                Err(e) => {
                    warn!(
                        "[nono] Version check failed: {}. Sandbox features may not work.",
                        e
                    );
                }
            }
        }
        Err(_) => {
            warn!(
                "[nono] Binary not found (tried NONO_BIN env, bundled path, and PATH). \
                 Sandbox features will be unavailable. \
                 Set NONO_BIN=/path/to/nono or run `cargo install nono-cli` to enable."
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Verify that binary_path() returns the NONO_BIN path when the env var
    /// is set to an existing file.
    #[test]
    fn binary_path_respects_nono_bin_env() {
        // Create a temporary file to act as a fake nono binary.
        let tmp = tempfile::NamedTempFile::new().expect("create tempfile");
        let tmp_path = tmp.path().to_path_buf();

        // Scope the env var so parallel tests are not affected.
        // Note: std::env::set_var is not thread-safe in Rust 2024+, but
        // tests in this module are isolated enough for this pattern.
        let original = std::env::var("NONO_BIN").ok();
        std::env::set_var("NONO_BIN", &tmp_path);

        let result = binary_path();

        // Restore
        match original {
            Some(val) => std::env::set_var("NONO_BIN", val),
            None => std::env::remove_var("NONO_BIN"),
        }

        assert!(
            result.is_ok(),
            "binary_path() should succeed when NONO_BIN points to an existing file"
        );
        assert_eq!(result.unwrap(), tmp_path);
    }

    /// Verify that binary_path() returns NonoUnavailable when NONO_BIN points
    /// to a non-existent file.
    #[test]
    fn binary_path_nono_bin_missing_file() {
        let original = std::env::var("NONO_BIN").ok();
        std::env::set_var("NONO_BIN", "/nonexistent/path/to/nono");

        let result = binary_path();

        match original {
            Some(val) => std::env::set_var("NONO_BIN", val),
            None => std::env::remove_var("NONO_BIN"),
        }

        assert!(
            result.is_err(),
            "binary_path() should fail when NONO_BIN points to a missing file"
        );
    }

    /// Verify the pinned version constant is non-empty and looks like a semver.
    #[test]
    fn nono_version_is_semver_like() {
        let parts: Vec<&str> = NONO_VERSION.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "NONO_VERSION '{}' should be X.Y.Z",
            NONO_VERSION
        );
        for part in &parts {
            assert!(
                part.chars().all(|c| c.is_ascii_digit()),
                "NONO_VERSION part '{}' should be numeric",
                part
            );
        }
    }
}
