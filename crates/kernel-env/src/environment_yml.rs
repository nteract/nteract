//! Explicit local creation of an environment.yml manifest.
//!
//! This module only validates and creates files. Discovery, package installation,
//! trust approval, and kernel lifecycle remain separate operations.

use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rattler_conda_types::{EnvironmentYaml, PackageNameMatcher, ParseStrictness, VersionSpec};

/// The caller's requested manifest. No environment preferences are inferred.
#[derive(Debug, Clone)]
pub struct EnvironmentYmlSpec {
    pub name: Option<String>,
    pub dependencies: Vec<String>,
    pub python: Option<String>,
    /// At least one channel, in priority order.
    pub channels: Vec<String>,
}

/// Create `environment.yml` in an explicitly chosen, existing absolute directory.
///
/// The complete validated file is published without replacing any existing path,
/// including a dangling symlink. Concurrent creators have exactly one winner.
/// The caller must already have local filesystem authority for this directory.
pub fn initialize_environment_yml(directory: &Path, spec: &EnvironmentYmlSpec) -> Result<PathBuf> {
    let content = render(spec)?;
    if !directory.is_absolute() {
        bail!("environment.yml directory must be an absolute path");
    }
    let directory = directory
        .canonicalize()
        .context("environment.yml directory must already exist")?;
    if !directory.is_dir() {
        bail!("environment.yml directory is not a directory");
    }
    // Discovery prefers .yml over .yaml. Do not silently supersede a project
    // that already uses the alternate spelling, including a dangling symlink.
    match std::fs::symlink_metadata(directory.join("environment.yaml")) {
        Ok(_) => bail!("environment.yaml already exists; it was left unchanged"),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error).context("Could not check existing environment.yaml"),
    }
    let target = directory.join("environment.yml");
    let mut builder = tempfile::Builder::new();
    builder.prefix(".environment.yml-");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // OpenOptions applies the process's existing umask. Do not read or
        // change that process-global value in a multithreaded host.
        builder.permissions(std::fs::Permissions::from_mode(0o666));
    }
    let mut temporary = builder
        .tempfile_in(&directory)
        .context("Could not create a temporary environment.yml in the requested directory")?;
    temporary
        .write_all(content.as_bytes())
        .context("Could not write environment.yml")?;
    temporary
        .as_file()
        .sync_all()
        .context("Could not flush environment.yml")?;
    temporary.persist_noclobber(&target).map_err(|error| {
        // Dropping PersistError also drops its temporary file. The target has
        // never been opened for writing, so a failed publish cannot truncate it.
        if error.error.kind() == std::io::ErrorKind::AlreadyExists {
            anyhow::anyhow!("environment.yml already exists; it was left unchanged")
        } else {
            anyhow::anyhow!("Could not create environment.yml: {}", error.error)
        }
    })?;
    Ok(target)
}

fn render(spec: &EnvironmentYmlSpec) -> Result<String> {
    if spec.channels.is_empty() {
        bail!("At least one channel must be supplied explicitly");
    }
    let mut content = String::new();
    if let Some(name) = &spec.name {
        if name.is_empty()
            || !name
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
            || matches!(name.as_str(), "." | "..")
        {
            bail!("Environment name must contain only letters, numbers, '.', '_' or '-'");
        }
        content.push_str(&format!("name: {}\n", serde_json::to_string(name)?));
    }
    content.push_str("channels:\n");
    for channel in &spec.channels {
        if channel.is_empty()
            || channel
                .chars()
                .any(|ch| ch.is_whitespace() || ch.is_control())
        {
            bail!("Channels must be nonempty names or URLs without whitespace");
        }
        content.push_str(&format!("  - {}\n", serde_json::to_string(channel)?));
    }
    let mut dependencies = spec.dependencies.clone();
    if let Some(python) = &spec.python {
        if python.is_empty() || python.chars().any(char::is_control) {
            bail!("Python constraint must be nonempty and contain no control characters");
        }
        VersionSpec::from_str(python, ParseStrictness::Lenient)
            .context("Invalid Python version constraint")?;
        let separator = if python.starts_with(['<', '>', '=', '!', '~']) {
            ""
        } else {
            "="
        };
        dependencies.insert(0, format!("python{separator}{python}"));
    }
    if dependencies.is_empty() {
        content.push_str("dependencies: []\n");
    } else {
        content.push_str("dependencies:\n");
        for dependency in &dependencies {
            if dependency.trim().is_empty() || dependency.chars().any(char::is_control) {
                bail!("Dependencies must be nonempty Conda match specs without control characters");
            }
            // JSON strings are also YAML quoted scalars. Preserve the caller's
            // spelling without allowing YAML structure in a dependency value.
            content.push_str(&format!("  - {}\n", serde_json::to_string(dependency)?));
        }
    }
    // Use the same parser as project discovery, rather than a second partial
    // match-spec or YAML grammar in the binding.
    let parsed =
        EnvironmentYaml::from_yaml_str(&content).context("Invalid environment.yml spec")?;
    let mut python_specs = 0;
    for dependency in parsed.match_specs() {
        let PackageNameMatcher::Exact(name) = &dependency.name else {
            bail!("Every dependency must name a specific package");
        };
        if name.as_normalized() == "python" {
            python_specs += 1;
        }
    }
    if python_specs > 1 {
        bail!("Supply Python once, either in python or dependencies");
    }
    Ok(content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};

    fn spec() -> EnvironmentYmlSpec {
        EnvironmentYmlSpec {
            name: Some("analysis".into()),
            dependencies: vec!["numpy>=2,<3".into(), "pandas=2.2.*".into()],
            python: Some(">=3.11,<3.13".into()),
            channels: vec!["conda-forge".into(), "https://example.org/conda".into()],
        }
    }

    #[test]
    fn creates_parseable_manifest_with_requested_constraints_and_channel_order() {
        let directory = tempfile::tempdir().unwrap();
        let target = initialize_environment_yml(directory.path(), &spec()).unwrap();
        let parsed = EnvironmentYaml::from_path(&target).unwrap();
        assert_eq!(parsed.name.as_deref(), Some("analysis"));
        assert_eq!(parsed.channels[0].to_string(), "conda-forge");
        assert_eq!(parsed.channels[1].to_string(), "https://example.org/conda");
        let dependencies: Vec<_> = parsed.match_specs().map(ToString::to_string).collect();
        assert_eq!(
            dependencies,
            ["python >=3.11,<3.13", "numpy >=2,<3", "pandas 2.2.*"]
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn invalid_spec_leaves_directory_untouched() {
        let directory = tempfile::tempdir().unwrap();
        let mut invalid = spec();
        invalid.dependencies.push("bad!package".into());
        assert!(initialize_environment_yml(directory.path(), &invalid).is_err());
        invalid = spec();
        invalid.python = Some("definitely not a version".into());
        assert!(initialize_environment_yml(directory.path(), &invalid).is_err());
        invalid = spec();
        invalid.dependencies.push("python=3.10".into());
        assert!(initialize_environment_yml(directory.path(), &invalid).is_err());
        invalid = spec();
        invalid.dependencies.push("numpy\nname: injected".into());
        assert!(initialize_environment_yml(directory.path(), &invalid).is_err());
        invalid = spec();
        invalid.channels.clear();
        assert!(initialize_environment_yml(directory.path(), &invalid).is_err());
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn python_accepts_bare_versions_wildcards_and_ranges() {
        for constraint in ["3.12", "3.12.*", ">=3.11,<3.13", "==3.12.8", "~=3.12"] {
            let mut requested = spec();
            requested.python = Some(constraint.into());
            let content = render(&requested).unwrap();
            let parsed = EnvironmentYaml::from_yaml_str(&content).unwrap();
            assert_eq!(parsed.match_specs().count(), 3);
        }
    }

    #[test]
    fn requires_existing_absolute_directory() {
        let directory = tempfile::tempdir().unwrap();
        assert!(initialize_environment_yml(Path::new("."), &spec()).is_err());
        assert!(initialize_environment_yml(&directory.path().join("missing"), &spec()).is_err());
        let file = directory.path().join("file");
        std::fs::write(&file, "original").unwrap();
        assert!(initialize_environment_yml(&file, &spec()).is_err());
        assert_eq!(std::fs::read_to_string(file).unwrap(), "original");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }

    #[test]
    fn existing_file_is_never_overwritten() {
        for name in ["environment.yml", "environment.yaml"] {
            let directory = tempfile::tempdir().unwrap();
            let target = directory.path().join(name);
            std::fs::write(&target, "original").unwrap();
            let error = initialize_environment_yml(directory.path(), &spec()).unwrap_err();
            assert!(error.to_string().contains("already exists"));
            assert_eq!(std::fs::read_to_string(target).unwrap(), "original");
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
        }
    }

    #[cfg(unix)]
    #[test]
    fn manifest_uses_ordinary_file_permissions_under_the_current_umask() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let reference = directory.path().join("reference");
        std::fs::write(&reference, "ordinary project file").unwrap();
        let expected_mode = std::fs::metadata(reference).unwrap().permissions().mode() & 0o777;
        let manifest = initialize_environment_yml(directory.path(), &spec()).unwrap();
        assert_eq!(
            std::fs::metadata(manifest).unwrap().permissions().mode() & 0o777,
            expected_mode
        );
    }

    #[cfg(unix)]
    #[test]
    fn unwritable_directory_leaves_no_partial_manifest() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o500)).unwrap();
        // A privileged test runner can bypass Unix mode bits. Exercise the
        // failure only when this process is actually denied directory writes.
        if tempfile::NamedTempFile::new_in(directory.path()).is_err() {
            assert!(initialize_environment_yml(directory.path(), &spec()).is_err());
            assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
        }
        std::fs::set_permissions(directory.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn existing_and_dangling_symlinks_are_never_followed_or_replaced() {
        for name in ["environment.yml", "environment.yaml"] {
            for exists in [false, true] {
                let directory = tempfile::tempdir().unwrap();
                let outside = tempfile::tempdir().unwrap();
                let referent = outside.path().join("protected");
                if exists {
                    std::fs::write(&referent, "original").unwrap();
                }
                let target = directory.path().join(name);
                std::os::unix::fs::symlink(&referent, &target).unwrap();
                assert!(initialize_environment_yml(directory.path(), &spec()).is_err());
                assert_eq!(std::fs::read_link(&target).unwrap(), referent);
                if exists {
                    assert_eq!(std::fs::read_to_string(&referent).unwrap(), "original");
                } else {
                    assert!(!referent.exists());
                }
                assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
            }
        }
    }

    #[test]
    fn concurrent_creators_publish_one_complete_file() {
        let directory = tempfile::tempdir().unwrap();
        let barrier = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8)
            .map(|index| {
                let directory = directory.path().to_path_buf();
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let mut requested = spec();
                    requested.name = Some(format!("creator-{index}"));
                    barrier.wait();
                    initialize_environment_yml(&directory, &requested)
                })
            })
            .collect();
        assert_eq!(
            workers
                .into_iter()
                .map(|worker| worker.join().unwrap())
                .filter(Result::is_ok)
                .count(),
            1
        );
        EnvironmentYaml::from_path(&directory.path().join("environment.yml")).unwrap();
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
    }
}
