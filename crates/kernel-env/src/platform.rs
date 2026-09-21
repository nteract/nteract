//! Target-aware Conda/Pixi solve policy.
//!
//! Managed, prewarmed, and inline Conda/Pixi environments solve for
//! [`conda_solve_platform`], not necessarily the host. On Windows ARM64 that
//! is emulated `win-64` because conda-forge still lacks `win-arm64`
//! `ipykernel` / `pyzmq`. Drop the mapping once those packages exist and a
//! native ARM64 kernel launch is proven. User-owned `pixi.toml` /
//! `environment.yml` files keep their declared platforms and must not be
//! rewritten here.

use anyhow::Result;
use rattler_conda_types::{GenericVirtualPackage, Platform};
use rattler_virtual_packages::{Override, VirtualPackage, VirtualPackageOverrides};

/// Platform used for managed/prewarmed/inline Conda and Pixi solves.
pub fn conda_solve_platform() -> Platform {
    conda_solve_platform_for(Platform::current())
}

/// Like [`conda_solve_platform`], with an explicit host so tests can cover
/// Windows ARM64 without running on that hardware.
pub fn conda_solve_platform_for(host: Platform) -> Platform {
    match host {
        Platform::WinArm64 => Platform::Win64,
        other => other,
    }
}

/// Virtual-package overrides so a solve for `solve` is consistent on `host`.
///
/// Host detection on Windows ARM64 reports `__archspec=arm64`, which cannot
/// satisfy a `win-64` solve. Override archspec to the solve platform's arch
/// whenever host and solve differ.
pub fn virtual_package_overrides_for_solve(
    host: Platform,
    solve: Platform,
) -> VirtualPackageOverrides {
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
    let overrides =
        virtual_package_overrides_for_solve(Platform::current(), conda_solve_platform());
    Ok(VirtualPackage::detect(&overrides)?
        .iter()
        .map(|vpkg| GenericVirtualPackage::from(vpkg.clone()))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn win_arm64_host_solves_as_win64() {
        assert_eq!(
            conda_solve_platform_for(Platform::WinArm64),
            Platform::Win64
        );
        assert_eq!(conda_solve_platform_for(Platform::Win64), Platform::Win64);
        assert_eq!(
            conda_solve_platform_for(Platform::OsxArm64),
            Platform::OsxArm64
        );
        assert_eq!(
            conda_solve_platform_for(Platform::LinuxAarch64),
            Platform::LinuxAarch64
        );
    }

    #[test]
    fn current_solve_platform_matches_host_except_win_arm64() {
        let host = Platform::current();
        let solve = conda_solve_platform();
        if host == Platform::WinArm64 {
            assert_eq!(solve, Platform::Win64);
        } else {
            assert_eq!(solve, host);
        }
    }

    #[test]
    fn win_arm64_virtual_package_overrides_force_x86_64_archspec() {
        let overrides = virtual_package_overrides_for_solve(Platform::WinArm64, Platform::Win64);
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
        let overrides = virtual_package_overrides_for_solve(Platform::Win64, Platform::Win64);
        assert!(overrides.archspec.is_none());
        assert!(overrides.win.is_none());
    }
}
