//! Target-aware Conda/Pixi solve policy.
//!
//! Managed, prewarmed, and inline Conda/Pixi environments solve for
//! [`conda_solve_platform`], not necessarily the host. On Windows ARM64 that
//! is emulated `win-64` because conda-forge still lacks `win-arm64`
//! `ipykernel` / `pyzmq`. Drop the mapping once those packages exist and a
//! native ARM64 kernel launch is proven. User-owned `pixi.toml` /
//! `environment.yml` files keep their declared platforms and must not be
//! rewritten here.

use anyhow::{Context, Result};
use rattler_conda_types::{GenericVirtualPackage, Subdir};
use rattler_virtual_packages::{Override, VirtualPackage, VirtualPackageOverrides};

/// Platform used for managed/prewarmed/inline Conda and Pixi solves.
/// Returns an error when Rattler does not recognize the host platform.
pub fn conda_solve_platform() -> Result<Subdir> {
    Ok(conda_solve_platform_for(host_subdir(Subdir::current())?))
}

fn host_subdir(detected: Option<Subdir>) -> Result<Subdir> {
    detected.context("Conda environments are not supported on this host platform")
}

/// Like [`conda_solve_platform`], with an explicit host so tests can cover
/// Windows ARM64 without running on that hardware.
pub fn conda_solve_platform_for(host: Subdir) -> Subdir {
    match host {
        Subdir::WinArm64 => Subdir::Win64,
        other => other,
    }
}

/// Virtual-package overrides so a solve for `solve` is consistent on `host`.
///
/// Host detection on Windows ARM64 reports `__archspec=arm64`, which cannot
/// satisfy a `win-64` solve. Override archspec to the solve platform's arch
/// whenever host and solve differ.
pub fn virtual_package_overrides_for_solve(host: Subdir, solve: Subdir) -> VirtualPackageOverrides {
    let mut overrides = VirtualPackageOverrides::default();
    if host != solve {
        if let Some(arch) = solve.arch() {
            overrides.archspec = Some(Override::String(arch.as_str().to_string()));
        }
    }
    overrides
}

/// Detect virtual packages for [`conda_solve_platform`] on this host.
pub fn detect_solve_virtual_packages() -> Result<Vec<GenericVirtualPackage>> {
    let overrides = virtual_package_overrides_for_solve(
        host_subdir(Subdir::current())?,
        conda_solve_platform()?,
    );
    Ok(VirtualPackage::detect(&overrides, None)?
        .iter()
        .map(|vpkg| GenericVirtualPackage::from(vpkg.clone()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_arm64_host_solves_as_win64() {
        assert_eq!(conda_solve_platform_for(Subdir::WinArm64), Subdir::Win64);
        assert_eq!(conda_solve_platform_for(Subdir::Win64), Subdir::Win64);
        assert_eq!(conda_solve_platform_for(Subdir::OsxArm64), Subdir::OsxArm64);
        assert_eq!(
            conda_solve_platform_for(Subdir::LinuxAarch64),
            Subdir::LinuxAarch64
        );
    }

    #[test]
    fn current_solve_platform_matches_host_except_win_arm64() {
        let host = Subdir::current().unwrap();
        let solve = conda_solve_platform().unwrap();
        if host == Subdir::WinArm64 {
            assert_eq!(solve, Subdir::Win64);
        } else {
            assert_eq!(solve, host);
        }
    }

    #[test]
    fn unsupported_host_is_an_error_instead_of_a_noarch_solve() {
        assert!(host_subdir(None)
            .unwrap_err()
            .to_string()
            .contains("not supported"));
    }

    #[test]
    fn win_arm64_virtual_package_overrides_force_x86_64_archspec() {
        let overrides = virtual_package_overrides_for_solve(Subdir::WinArm64, Subdir::Win64);
        assert_eq!(
            overrides.archspec,
            Some(Override::String("x86_64".to_string()))
        );
        assert!(overrides.win.is_none());
        assert!(overrides.osx.is_none());
        assert!(overrides.linux.is_none());
        assert!(overrides.libc.is_none());
        assert!(overrides.cuda.is_none());
    }

    #[test]
    fn matching_host_and_solve_leave_virtual_packages_unoverridden() {
        let overrides = virtual_package_overrides_for_solve(Subdir::Win64, Subdir::Win64);
        assert!(overrides.archspec.is_none());
        assert!(overrides.win.is_none());
    }
}
