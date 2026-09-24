//! Python defaults shared by managed Conda, Pixi, and pool environments.

use anyhow::{bail, Result};
use rattler_conda_types::{MatchSpec, ParseMatchSpecOptions, ParseStrictness, VersionSpec};

/// Default to regular CPython without requiring a channel-specific selector
/// package. This is a solver *constraint*: older Python builds which don't
/// depend on python_abi do not have to install it. Modern Anaconda and
/// conda-forge builds use e.g. `0_cp314` (GIL) or `0_cp314t` (free-threaded).
const GIL_ABI_CONSTRAINT: &str = "python_abi[build='^.*_cp[0-9]+$']";

/// Normalize channel aliases and Python shorthand for creation and sync.
pub(crate) fn parse_specs(packages: &[String]) -> Result<Vec<MatchSpec>> {
    let mut specs = packages
        .iter()
        .map(|package| crate::channels::parse_match_spec(package))
        .collect::<Result<Vec<_>, _>>()?;
    for spec in &mut specs {
        // Notebook metadata accepts bare pins such as 3.14t. Conda records
        // the version as 3.14.x and the free-threaded ABI in the build, so
        // translate that shorthand before solving. Reject operator expressions
        // with this suffix rather than interpreting them as ordinary versions.
        if spec
            .name
            .as_exact()
            .is_some_and(|name| name.as_normalized() == "python")
            && spec.build.is_none()
        {
            if let Some(version) = &spec.version {
                let version = version.to_string();
                if let Some(pin) = version
                    .strip_suffix("t.*")
                    .or_else(|| version.strip_suffix('t'))
                {
                    let parts = pin.split('.').collect::<Vec<_>>();
                    if parts.len() >= 2
                        && parts.iter().all(|part| {
                            !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())
                        })
                    {
                        spec.version = Some(VersionSpec::from_str(
                            &format!("{pin}.*"),
                            ParseStrictness::Strict,
                        )?);
                        spec.build = Some(format!("*_cp{}{}t", parts[0], parts[1]).parse()?);
                    }
                }
                if spec.version.as_ref().is_some_and(|version| {
                    version
                        .to_string()
                        .split([',', '|', '(', ')'])
                        .any(|term| term.trim().trim_end_matches(".*").ends_with('t'))
                }) {
                    bail!("Unsupported free-threaded Python version expression {version:?}; use a bare pin such as python=3.14t or a normal version with python-freethreading");
                }
            }
        }
    }
    Ok(specs)
}

/// Parse requested packages, adding a Python default only when none was given.
/// Return required specs separately from optional ABI constraints.
pub fn solve_specs(packages: &[String]) -> Result<(Vec<MatchSpec>, Vec<MatchSpec>)> {
    let mut specs = parse_specs(packages)?;
    if !specs.iter().any(|spec| {
        spec.name
            .as_exact()
            .is_some_and(|name| name.as_normalized() == "python")
    }) {
        specs.push(MatchSpec::from_str(
            "python>=3.13",
            ParseMatchSpecOptions::strict(),
        )?);
    }

    // Honor explicit selectors and build requests. A Python version range by
    // itself still defaults to the GIL build, on every channel.
    let explicit_variant = specs.iter().any(|spec| {
        spec.name
            .as_exact()
            .is_some_and(|name| match name.as_normalized() {
                "python-freethreading" => true,
                "python" | "python_abi" => spec.build.is_some(),
                _ => false,
            })
    });
    let constraints = if explicit_variant {
        Vec::new()
    } else {
        vec![MatchSpec::from_str(
            GIL_ABI_CONSTRAINT,
            ParseMatchSpecOptions::strict(),
        )?]
    };
    Ok((specs, constraints))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rattler_conda_types::{PackageRecord, RepoDataRecord};
    use rattler_solve::{resolvo, SolverImpl, SolverTask};

    #[test]
    fn operator_free_threading_expressions_fail_instead_of_selecting_gil() {
        for package in ["python>=3.14t", "python==3.14t", "python>=3.14t,<3.15"] {
            let error = solve_specs(&[package.into()]).unwrap_err();
            assert!(error.to_string().contains("use a bare pin"), "{error}");
        }
    }

    fn record(name: &str, version: &str, build: &str, depends: &[&str]) -> RepoDataRecord {
        let package_record: PackageRecord = serde_json::from_value(serde_json::json!({
            "name": name, "version": version, "build": build, "build_number": 0,
            "subdir": "noarch", "depends": depends,
        }))
        .unwrap();
        RepoDataRecord {
            package_record,
            identifier: format!("{name}-{version}-{build}.conda").parse().unwrap(),
            url: format!("https://example.invalid/{name}-{version}-{build}.conda")
                .parse()
                .unwrap(),
            channel: Some("https://example.invalid/".into()),
        }
    }

    #[test]
    fn old_python_solves_without_selector_or_abi_packages() {
        for pin in [
            "python=3.12",
            "python==3.12.9",
            "python>=3.11,<3.13",
            "python<3.13",
        ] {
            let records = vec![record("python", "3.12.9", "h123_0", &[])];
            let (specs, constraints) = solve_specs(&[pin.into()]).unwrap();
            let result = resolvo::Solver
                .solve(SolverTask {
                    specs,
                    constraints,
                    ..SolverTask::from_iter([records.as_slice()])
                })
                .unwrap();
            assert_eq!(result.records.len(), 1, "{pin}");
            assert_eq!(
                result.records[0].package_record.version.to_string(),
                "3.12.9"
            );
        }
    }

    #[test]
    fn defaults_select_gil_but_explicit_free_threading_is_honored() {
        let records = vec![
            record(
                "python",
                "3.14.1",
                "h123_100_cp314",
                &["python_abi 3.14.* *_cp314"],
            ),
            record(
                "python",
                "3.14.1",
                "h123_0_cp314t",
                &["python_abi 3.14.* *_cp314t"],
            ),
            record("python_abi", "3.14", "0_cp314", &[]),
            record("python_abi", "3.14", "0_cp314t", &[]),
            record(
                "python-freethreading",
                "3.14.1",
                "h123_0",
                &["python * *_cp314t"],
            ),
        ];
        for (packages, expected_build) in [
            (vec![], "h123_100_cp314"),
            (vec!["python=3.14"], "h123_100_cp314"),
            (vec!["python=3.14", "python-freethreading"], "h123_0_cp314t"),
            (vec!["python 3.14.* *_cp314t"], "h123_0_cp314t"),
            (vec!["python=3.14t"], "h123_0_cp314t"),
            (vec!["python 3.14t.*"], "h123_0_cp314t"),
        ] {
            let packages = packages.into_iter().map(String::from).collect::<Vec<_>>();
            let (specs, constraints) = solve_specs(&packages).unwrap();
            let result = resolvo::Solver
                .solve(SolverTask {
                    specs,
                    constraints,
                    ..SolverTask::from_iter([records.as_slice()])
                })
                .unwrap();
            let python = result
                .records
                .iter()
                .find(|r| r.package_record.name.as_normalized() == "python")
                .unwrap();
            assert_eq!(python.package_record.build, expected_build, "{packages:?}");
        }

        // A channel offering only the free-threaded ABI must not silently
        // change the default, even if it has a newer interpreter available.
        let free_only = vec![records[1].clone(), records[3].clone()];
        let (specs, constraints) = solve_specs(&[]).unwrap();
        assert!(resolvo::Solver
            .solve(SolverTask {
                specs,
                constraints,
                ..SolverTask::from_iter([free_only.as_slice()])
            })
            .is_err());
    }
}
