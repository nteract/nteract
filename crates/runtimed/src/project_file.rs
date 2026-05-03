//! Project file detection with "closest wins" semantics.
//!
//! Walks up from the notebook directory, checking for project files at each
//! level. The first (closest) match wins, with tiebreaker priority when
//! multiple files exist at the same level.
//!
//! This is adapted from `crates/notebook/src/project_file.rs` for use in
//! the daemon's environment auto-detection.

use std::path::{Path, PathBuf};

/// The type of project file detected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectFileKind {
    PyprojectToml,
    PixiToml,
    EnvironmentYml,
}

/// A detected project file with its path and kind.
#[derive(Debug, Clone)]
pub struct DetectedProjectFile {
    pub path: PathBuf,
    pub kind: ProjectFileKind,
}

impl DetectedProjectFile {
    /// The resolved env_source for this project file.
    pub fn to_env_source(&self) -> notebook_protocol::connection::EnvSource {
        use notebook_protocol::connection::EnvSource;
        match self.kind {
            ProjectFileKind::PyprojectToml => EnvSource::Pyproject,
            ProjectFileKind::PixiToml => EnvSource::PixiToml,
            ProjectFileKind::EnvironmentYml => EnvSource::EnvYml,
        }
    }
}

/// Mapping from filename to project file kind, in tiebreaker priority order.
const ALL_CANDIDATES: &[(&str, ProjectFileKind)] = &[
    ("pyproject.toml", ProjectFileKind::PyprojectToml),
    ("pixi.toml", ProjectFileKind::PixiToml),
    ("environment.yml", ProjectFileKind::EnvironmentYml),
    ("environment.yaml", ProjectFileKind::EnvironmentYml),
];

/// Walk up from `start_path` checking each directory for project files.
///
/// Returns the first (closest) match. Within a single directory, tiebreaker
/// order is: pyproject.toml > pixi.toml > environment.yml > environment.yaml.
///
/// The `kinds` parameter controls which file types to search for. Pass a subset
/// to exclude types that can't be used (e.g., omit `PyprojectToml` when uv is
/// not available so the search continues to find pixi or environment.yml).
///
/// Stops at home directory or `.git` boundary.
pub fn find_nearest_project_file(
    start_path: &Path,
    kinds: &[ProjectFileKind],
) -> Option<DetectedProjectFile> {
    let start_dir = if start_path.is_file() {
        start_path.parent()?
    } else {
        start_path
    };

    let home_dir = dirs::home_dir();

    let mut current = start_dir.to_path_buf();
    loop {
        // Check all requested project file types at this level, in tiebreaker order
        for (filename, kind) in ALL_CANDIDATES {
            if !kinds.contains(kind) {
                continue;
            }
            let candidate = current.join(filename);
            if candidate.exists() {
                // pyproject.toml with [tool.pixi] should be treated as a pixi project
                if *kind == ProjectFileKind::PyprojectToml
                    && kinds.contains(&ProjectFileKind::PixiToml)
                    && pyproject_has_pixi_section(&candidate)
                {
                    return Some(DetectedProjectFile {
                        path: candidate,
                        kind: ProjectFileKind::PixiToml,
                    });
                }
                return Some(DetectedProjectFile {
                    path: candidate,
                    kind: kind.clone(),
                });
            }
        }

        // Stop at home directory or git repo root
        if let Some(ref home) = home_dir {
            if current == *home {
                return None;
            }
        }
        if current.join(".git").exists() {
            return None;
        }

        // Move to parent directory
        match current.parent() {
            Some(parent) if parent != current => {
                current = parent.to_path_buf();
            }
            _ => return None, // Reached filesystem root
        }
    }
}

/// Convenience function: detect project file with all kinds enabled.
pub fn detect_project_file(notebook_path: &Path) -> Option<DetectedProjectFile> {
    let all_kinds = vec![
        ProjectFileKind::PyprojectToml,
        ProjectFileKind::PixiToml,
        ProjectFileKind::EnvironmentYml,
    ];
    find_nearest_project_file(notebook_path, &all_kinds)
}

/// Check if a pyproject.toml contains a `[tool.pixi]` section.
fn pyproject_has_pixi_section(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .map(|c| c.contains("[tool.pixi]") || c.contains("[tool.pixi."))
        .unwrap_or(false)
}

/// Check if a pixi.toml (or pyproject.toml with [tool.pixi]) declares ipykernel.
///
/// Reads the file and checks for `ipykernel` as a TOML key in the
/// `[dependencies]` or `[pypi-dependencies]` tables. Uses a simple
/// text scan — if the line starts with `ipykernel` followed by `=` or
/// whitespace, it's a match. This avoids requiring a TOML parser dep.
pub fn pixi_toml_has_ipykernel(path: &Path) -> bool {
    let Ok(content) = std::fs::read_to_string(path) else {
        return false;
    };
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("ipykernel")
            && trimmed["ipykernel".len()..].starts_with(['=', ' ', '\t'])
        {
            return true;
        }
    }
    false
}

/// Minimal environment.yml parse result for the daemon.
///
/// Only extracts what the daemon needs: dependency names, channels, python version.
/// The full YAML parser lives in `crates/notebook/src/environment_yml.rs` (Tauri side).
#[derive(Debug, Clone)]
pub struct EnvironmentYmlConfig {
    pub dependencies: Vec<String>,
    pub channels: Vec<String>,
    pub python: Option<String>,
    pub name: Option<String>,
    /// Explicit prefix path from `prefix:` field (alternative to `name:`).
    pub prefix: Option<PathBuf>,
}

/// Search standard conda env directories for an existing named environment.
///
/// Checks `$CONDA_ENVS_DIRS`, `$CONDA_PREFIX/envs/`, `$MAMBA_ROOT_PREFIX/envs/`,
/// common install locations (`~/miniconda3`, `~/anaconda3`, `~/miniforge3`),
/// `~/.conda/envs/`, `~/.local/share/mamba/envs/` (micromamba default),
/// and any parent dirs from `~/.conda/environments.txt` (conda env registry).
///
/// Returns the first directory that contains `{dir}/{name}/bin/python` (or
/// `{dir}/{name}/python.exe` on Windows).
pub fn find_named_conda_env(name: &str) -> Option<PathBuf> {
    let candidates = conda_env_search_dirs();
    for dir in &candidates {
        let env_path = dir.join(name);
        let python = conda_python_path(&env_path);
        if python.exists() {
            return Some(env_path);
        }
    }
    None
}

/// Return the default directory for creating new named conda environments.
///
/// Uses the first writable directory from the search order. Falls back to
/// `~/.conda/envs/` if nothing else is available.
pub fn default_conda_envs_dir() -> PathBuf {
    let candidates = conda_env_search_dirs();
    for dir in &candidates {
        if dir.exists() && dir.is_dir() {
            // Check if writable by attempting to read dir
            if std::fs::read_dir(dir).is_ok() {
                return dir.clone();
            }
        }
    }
    // Fallback: ~/.conda/envs/
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/tmp"))
        .join(".conda")
        .join("envs")
}

/// Resolve the conda prefix for a daemon-created `conda:env_yml` environment.
///
/// When the daemon needs to create a new named env (not pre-existing on the
/// system), the path is scoped to the project directory so that different
/// projects using the same `name:` field in their `environment.yaml` get
/// isolated prefixes. Without this, concurrent notebooks sharing the same
/// env name but different dep sets can clobber each other - the rattler
/// Installer removes packages not in the current notebook's specs.
///
/// Returns `(prefix_path, is_daemon_owned)`.
///
/// - `prefix:` field -> use that path directly (user-managed)
/// - `name:` found on system -> use that path (user-managed)
/// - `name:` not found -> daemon-owned, project-scoped cache path
/// - no name or prefix -> hash-based cache path (daemon-owned)
pub fn resolve_conda_env_yml_prefix(
    env_config: &EnvironmentYmlConfig,
    yml_path: &Path,
) -> (PathBuf, bool) {
    if let Some(ref prefix) = env_config.prefix {
        // Explicit prefix: path from environment.yml - user-managed
        (prefix.clone(), false)
    } else if let Some(ref name) = env_config.name {
        match find_named_conda_env(name) {
            Some(found) => (found, false), // Pre-existing user env
            None => {
                // Daemon-created: scope by project dir so different projects
                // with the same env name get isolated prefixes.
                let cache_dir = crate::paths::default_cache_dir().join("conda-envs");
                let project_hash = compute_project_scope_hash(yml_path);
                (cache_dir.join(format!("{}-{}", name, project_hash)), true)
            }
        }
    } else {
        // No name or prefix - use a hash-based env in cache
        let cache_dir = crate::paths::default_cache_dir().join("conda-envs");
        let conda_deps_tmp = kernel_env::CondaDependencies {
            dependencies: env_config.dependencies.clone(),
            channels: env_config.channels.clone(),
            python: env_config.python.clone(),
            env_id: None,
        };
        (
            cache_dir.join(kernel_env::conda::compute_env_hash(&conda_deps_tmp)),
            true,
        )
    }
}

/// Compute a short hash that scopes a conda env to its project directory.
///
/// Uses the canonical parent directory of the environment.yaml file as the
/// scope key - two environment.yaml files in the same directory get the same
/// hash, different directories get different hashes even with identical
/// content.
fn compute_project_scope_hash(yml_path: &Path) -> String {
    use sha2::{Digest, Sha256};
    let canonical = yml_path
        .parent()
        .and_then(|p| p.canonicalize().ok())
        .unwrap_or_else(|| yml_path.to_path_buf());
    let mut hasher = Sha256::new();
    hasher.update(canonical.to_string_lossy().as_bytes());
    let hash = hasher.finalize();
    hex::encode(hash)[..12].to_string()
}

/// Get the python path within a conda prefix.
pub fn conda_python_path(prefix: &Path) -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        prefix.join("python.exe")
    }
    #[cfg(not(target_os = "windows"))]
    {
        prefix.join("bin").join("python")
    }
}

/// Resolve the conda prefix for an environment.yml file.
///
/// If the yaml has `prefix:` → use that path directly.
/// If the yaml has `name:` → search standard conda env dirs for it.
/// Returns `None` if neither is set or no matching env is found.
pub fn resolve_conda_env_prefix(yml_path: &Path) -> Option<PathBuf> {
    let config = parse_environment_yml(yml_path).ok()?;

    // prefix: takes precedence — it's an explicit path
    if let Some(ref prefix) = config.prefix {
        return Some(prefix.clone());
    }

    // name: — search standard conda env directories
    if let Some(ref name) = config.name {
        return find_named_conda_env(name);
    }

    None
}

/// Standard conda environment search directories.
fn conda_env_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();

    let mut push_unique = |p: PathBuf| {
        if !dirs.contains(&p) {
            dirs.push(p);
        }
    };

    // $CONDA_ENVS_DIRS (colon-separated on Unix, semicolon on Windows)
    if let Ok(envs_dirs) = std::env::var("CONDA_ENVS_DIRS") {
        let sep = if cfg!(windows) { ';' } else { ':' };
        for dir in envs_dirs.split(sep) {
            let p = PathBuf::from(dir.trim());
            if !p.as_os_str().is_empty() {
                push_unique(p);
            }
        }
    }

    // $CONDA_PREFIX/envs/
    if let Ok(prefix) = std::env::var("CONDA_PREFIX") {
        push_unique(PathBuf::from(prefix).join("envs"));
    }

    // $MAMBA_ROOT_PREFIX/envs/ (micromamba)
    if let Ok(prefix) = std::env::var("MAMBA_ROOT_PREFIX") {
        push_unique(PathBuf::from(prefix).join("envs"));
    }

    // Common conda/mamba installations
    if let Some(home) = dirs::home_dir() {
        for name in ["miniconda3", "anaconda3", "miniforge3"] {
            push_unique(home.join(name).join("envs"));
        }
        push_unique(home.join(".conda").join("envs"));
        // micromamba default location
        push_unique(home.join(".local").join("share").join("mamba").join("envs"));
    }

    // ~/.conda/environments.txt — conda's env registry, lists full paths to envs.
    // Extract parent dirs (the "envs/" directories) from each registered env path.
    if let Some(home) = dirs::home_dir() {
        let registry = home.join(".conda").join("environments.txt");
        if let Ok(content) = std::fs::read_to_string(&registry) {
            for line in content.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    let env_path = PathBuf::from(trimmed);
                    if let Some(parent) = env_path.parent() {
                        push_unique(parent.to_path_buf());
                    }
                }
            }
        }
    }

    dirs
}

/// Parse an environment.yml file using rattler's serde_yaml parser.
///
/// Handles the full environment.yml spec including pip subsections, proper
/// YAML syntax validation, and MatchSpec parsing.
pub fn parse_environment_yml(path: &Path) -> Result<EnvironmentYmlConfig, String> {
    let content =
        std::fs::read_to_string(path).map_err(|e| format!("Failed to read {:?}: {}", path, e))?;
    parse_environment_yml_content(&content)
}

/// Parse environment.yml content (testable without filesystem).
fn parse_environment_yml_content(content: &str) -> Result<EnvironmentYmlConfig, String> {
    use rattler_conda_types::EnvironmentYaml;

    let env = EnvironmentYaml::from_yaml_str(content)
        .map_err(|e| format!("Failed to parse environment.yml: {}", e))?;

    let mut dependencies = Vec::new();
    let mut python = None;

    for spec in env.match_specs() {
        let name = match &spec.name {
            rattler_conda_types::PackageNameMatcher::Exact(name) => {
                name.as_normalized().to_string()
            }
            _ => String::new(),
        };

        if name == "python" {
            // Preserve the full version spec string so downstream
            // constraint checks can apply correct operator semantics
            // (e.g. ">=3.9,<4" stays as ">=3.9,<4", not stripped to "3.9").
            if let Some(ref version_spec) = spec.version {
                let v = version_spec.to_string();
                if !v.is_empty() {
                    python = Some(v);
                }
            }
        } else if !name.is_empty() {
            // Convert MatchSpec back to the original string form for downstream consumers
            dependencies.push(spec.to_string());
        }
    }

    let channels: Vec<String> = if env.channels.is_empty() {
        vec!["defaults".to_string()]
    } else {
        env.channels.iter().map(|c| c.to_string()).collect()
    };

    Ok(EnvironmentYmlConfig {
        dependencies,
        channels,
        python,
        name: env.name,
        prefix: env.prefix,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn test_closest_wins_pixi_over_distant_pyproject() {
        let temp = TempDir::new().unwrap();
        let project = temp.path().join("project");
        let notebooks = project.join("notebooks");
        std::fs::create_dir_all(&notebooks).unwrap();

        write_file(&project, "pyproject.toml", "[project]\nname = \"test\"");
        write_file(&notebooks, "pixi.toml", "[project]\nname = \"test\"");

        let found = detect_project_file(&notebooks);
        assert!(found.is_some());
        let found = found.unwrap();
        assert_eq!(found.kind, ProjectFileKind::PixiToml);
        assert_eq!(
            found.to_env_source(),
            notebook_protocol::connection::EnvSource::PixiToml
        );
    }

    #[test]
    fn test_no_project_files() {
        let temp = TempDir::new().unwrap();
        let found = detect_project_file(temp.path());
        assert!(found.is_none());
    }

    #[test]
    fn test_pyproject_env_source() {
        let temp = TempDir::new().unwrap();
        write_file(temp.path(), "pyproject.toml", "[project]\nname = \"test\"");

        let found = detect_project_file(temp.path());
        assert!(found.is_some());
        assert_eq!(
            found.unwrap().to_env_source(),
            notebook_protocol::connection::EnvSource::Pyproject
        );
    }

    #[test]
    fn test_environment_yml_env_source() {
        let temp = TempDir::new().unwrap();
        write_file(temp.path(), "environment.yml", "name: test");

        let found = detect_project_file(temp.path());
        assert!(found.is_some());
        assert_eq!(
            found.unwrap().to_env_source(),
            notebook_protocol::connection::EnvSource::EnvYml
        );
    }

    #[test]
    fn test_pixi_toml_has_ipykernel_in_deps() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "pixi.toml",
            "[project]\nname = \"test\"\n\n[dependencies]\npython = \">=3.11\"\nipykernel = \"*\"\n",
        );
        assert!(pixi_toml_has_ipykernel(&temp.path().join("pixi.toml")));
    }

    #[test]
    fn test_pixi_toml_has_ipykernel_in_pypi_deps() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "pixi.toml",
            "[project]\nname = \"test\"\n\n[pypi-dependencies]\nipykernel = \">=6.0\"\n",
        );
        assert!(pixi_toml_has_ipykernel(&temp.path().join("pixi.toml")));
    }

    #[test]
    fn test_pixi_toml_missing_ipykernel() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "pixi.toml",
            "[project]\nname = \"test\"\n\n[dependencies]\npython = \">=3.11\"\nnumpy = \"*\"\n",
        );
        assert!(!pixi_toml_has_ipykernel(&temp.path().join("pixi.toml")));
    }

    #[test]
    fn test_pixi_toml_has_ipykernel_nonexistent_file() {
        assert!(!pixi_toml_has_ipykernel(Path::new(
            "/nonexistent/pixi.toml"
        )));
    }

    #[test]
    fn test_pyproject_with_tool_pixi_detected_as_pixi() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"test\"\n\n[tool.pixi.project]\nchannels = [\"conda-forge\"]\nplatforms = [\"linux-64\"]\n",
        );

        let found = detect_project_file(temp.path());
        assert!(found.is_some());
        let found = found.unwrap();
        assert_eq!(found.kind, ProjectFileKind::PixiToml);
        assert_eq!(
            found.to_env_source(),
            notebook_protocol::connection::EnvSource::PixiToml
        );
    }

    #[test]
    fn test_pyproject_without_tool_pixi_detected_as_uv() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"test\"\n\n[tool.uv]\ndev-dependencies = []\n",
        );

        let found = detect_project_file(temp.path());
        assert!(found.is_some());
        let found = found.unwrap();
        assert_eq!(found.kind, ProjectFileKind::PyprojectToml);
        assert_eq!(
            found.to_env_source(),
            notebook_protocol::connection::EnvSource::Pyproject
        );
    }

    #[test]
    fn test_pyproject_with_both_pixi_and_uv_prefers_pixi() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"test\"\n\n[tool.pixi.project]\nchannels = [\"conda-forge\"]\n\n[tool.uv]\ndev-dependencies = []\n",
        );

        let found = detect_project_file(temp.path());
        assert!(found.is_some());
        assert_eq!(found.unwrap().kind, ProjectFileKind::PixiToml);
    }

    #[test]
    fn test_ipykernel_in_pyproject_tool_pixi_deps() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "pyproject.toml",
            "[project]\nname = \"test\"\n\n[tool.pixi.dependencies]\nipykernel = \"*\"\nnumpy = \"*\"\n",
        );
        assert!(pixi_toml_has_ipykernel(&temp.path().join("pyproject.toml")));
    }

    #[test]
    fn test_parse_env_yml_basic() {
        let content = "name: myenv\nchannels:\n  - conda-forge\ndependencies:\n  - numpy=1.24\n  - pandas\n  - python=3.11\n";
        let config = parse_environment_yml_content(content).unwrap();
        assert_eq!(config.name, Some("myenv".to_string()));
        assert_eq!(config.channels, vec!["conda-forge"]);
        // rattler normalizes conda `=` pin: numpy=1.24 → numpy 1.24.*
        assert_eq!(config.dependencies, vec!["numpy 1.24.*", "pandas"]);
        // rattler normalizes conda `=` pin: python=3.11 → 3.11.*
        assert_eq!(config.python, Some("3.11.*".to_string()));
    }

    #[test]
    fn test_parse_env_yml_with_pip() {
        let content = "name: test\nchannels:\n  - conda-forge\n  - defaults\ndependencies:\n  - numpy\n  - pip:\n    - requests\n    - flask\n  - scipy\n";
        let config = parse_environment_yml_content(content).unwrap();
        assert_eq!(config.channels, vec!["conda-forge", "defaults"]);
        // pip deps are skipped, conda deps after pip block must still be captured
        assert_eq!(config.dependencies, vec!["numpy", "scipy"]);
    }

    #[test]
    fn test_parse_env_yml_pip_then_multiple_conda_deps() {
        let content = "name: test\ndependencies:\n  - numpy\n  - pip:\n    - requests\n    - flask\n  - scipy\n  - matplotlib\n  - python=3.11\n";
        let config = parse_environment_yml_content(content).unwrap();
        assert_eq!(config.dependencies, vec!["numpy", "scipy", "matplotlib"]);
        assert_eq!(config.python, Some("3.11.*".to_string()));
    }

    #[test]
    fn test_parse_env_yml_no_channels() {
        let content = "name: test\ndependencies:\n  - numpy\n";
        let config = parse_environment_yml_content(content).unwrap();
        assert_eq!(config.channels, vec!["defaults"]);
        assert_eq!(config.dependencies, vec!["numpy"]);
    }

    #[test]
    fn test_parse_env_yml_python_version_extraction() {
        let content = "dependencies:\n  - python>=3.9,<4\n  - numpy\n";
        let config = parse_environment_yml_content(content).unwrap();
        // Range constraints preserved: >=3.9,<4 stays as-is
        assert_eq!(config.python, Some(">=3.9,<4".to_string()));
        assert_eq!(config.dependencies, vec!["numpy"]);
    }

    #[test]
    fn test_parse_env_yml_from_file() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "environment.yml",
            "name: analysis\nchannels:\n  - conda-forge\ndependencies:\n  - numpy\n  - pandas\n",
        );
        let config = parse_environment_yml(&temp.path().join("environment.yml")).unwrap();
        assert_eq!(config.name, Some("analysis".to_string()));
        assert_eq!(config.dependencies, vec!["numpy", "pandas"]);
    }

    #[test]
    fn test_parse_env_yml_with_prefix() {
        let content = "prefix: /opt/conda/envs/myproject\nchannels:\n  - conda-forge\ndependencies:\n  - numpy\n";
        let config = parse_environment_yml_content(content).unwrap();
        assert_eq!(
            config.prefix,
            Some(PathBuf::from("/opt/conda/envs/myproject"))
        );
        assert!(config.name.is_none());
        assert_eq!(config.dependencies, vec!["numpy"]);
    }

    #[test]
    fn test_parse_env_yml_name_and_prefix() {
        // When both are present, both should be parsed (prefix takes precedence at resolution)
        let content = "name: myenv\nprefix: /custom/path\ndependencies:\n  - scipy\n";
        let config = parse_environment_yml_content(content).unwrap();
        assert_eq!(config.name, Some("myenv".to_string()));
        assert_eq!(config.prefix, Some(PathBuf::from("/custom/path")));
    }

    #[test]
    fn test_parse_env_yml_rejects_malformed_yaml() {
        // Malformed YAML must return Err, not silently produce an empty config
        let content = "dependencies:\n  - numpy\n  invalid: [yaml: {{broken";
        assert!(parse_environment_yml_content(content).is_err());
    }

    #[test]
    fn test_find_named_conda_env_not_found() {
        // A nonsense name should not be found
        assert!(find_named_conda_env("__nonexistent_env_abc123__").is_none());
    }

    #[test]
    fn test_conda_python_path() {
        let prefix = PathBuf::from("/opt/conda/envs/test");
        let python = conda_python_path(&prefix);
        #[cfg(not(target_os = "windows"))]
        assert_eq!(python, PathBuf::from("/opt/conda/envs/test/bin/python"));
        #[cfg(target_os = "windows")]
        assert_eq!(python, PathBuf::from("/opt/conda/envs/test/python.exe"));
    }

    #[test]
    fn test_resolve_conda_env_yml_prefix_with_prefix_field() {
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "environment.yml",
            "prefix: /custom/path\ndependencies:\n  - numpy\n",
        );
        let config = parse_environment_yml(&temp.path().join("environment.yml")).unwrap();
        let (prefix, is_daemon_owned) =
            resolve_conda_env_yml_prefix(&config, &temp.path().join("environment.yml"));
        assert_eq!(prefix, PathBuf::from("/custom/path"));
        assert!(!is_daemon_owned);
    }

    #[test]
    fn test_resolve_conda_env_yml_prefix_daemon_created_scoped_by_project() {
        // Two different project dirs with the same env name should get
        // different daemon-owned prefixes (project-scoped isolation).
        let temp1 = TempDir::new().unwrap();
        let temp2 = TempDir::new().unwrap();
        let yml_content = "name: shared-env\ndependencies:\n  - numpy\n";
        write_file(temp1.path(), "environment.yml", yml_content);
        write_file(temp2.path(), "environment.yml", yml_content);

        let config1 = parse_environment_yml(&temp1.path().join("environment.yml")).unwrap();
        let config2 = parse_environment_yml(&temp2.path().join("environment.yml")).unwrap();
        let (prefix1, owned1) =
            resolve_conda_env_yml_prefix(&config1, &temp1.path().join("environment.yml"));
        let (prefix2, owned2) =
            resolve_conda_env_yml_prefix(&config2, &temp2.path().join("environment.yml"));

        assert!(owned1, "daemon-created envs should be daemon-owned");
        assert!(owned2, "daemon-created envs should be daemon-owned");
        assert_ne!(
            prefix1, prefix2,
            "different project dirs must get different prefixes"
        );
        // Both should start with the env name
        let name1 = prefix1.file_name().unwrap().to_string_lossy();
        let name2 = prefix2.file_name().unwrap().to_string_lossy();
        assert!(
            name1.starts_with("shared-env-"),
            "prefix should start with env name"
        );
        assert!(
            name2.starts_with("shared-env-"),
            "prefix should start with env name"
        );
    }

    #[test]
    fn test_resolve_conda_env_yml_prefix_same_dir_same_hash() {
        // Same project dir should produce the same prefix
        let temp = TempDir::new().unwrap();
        write_file(
            temp.path(),
            "environment.yml",
            "name: myenv\ndependencies:\n  - numpy\n",
        );
        let config = parse_environment_yml(&temp.path().join("environment.yml")).unwrap();
        let (prefix1, _) =
            resolve_conda_env_yml_prefix(&config, &temp.path().join("environment.yml"));
        let (prefix2, _) =
            resolve_conda_env_yml_prefix(&config, &temp.path().join("environment.yml"));
        assert_eq!(
            prefix1, prefix2,
            "same project dir must produce same prefix"
        );
    }

    #[test]
    fn test_resolve_conda_env_yml_prefix_no_name_no_prefix() {
        // No name or prefix: should use hash-based path
        let temp = TempDir::new().unwrap();
        write_file(temp.path(), "environment.yml", "dependencies:\n  - numpy\n");
        let config = parse_environment_yml(&temp.path().join("environment.yml")).unwrap();
        let (prefix, is_daemon_owned) =
            resolve_conda_env_yml_prefix(&config, &temp.path().join("environment.yml"));
        assert!(is_daemon_owned);
        // Should be under the cache dir
        let cache_dir = crate::paths::default_cache_dir().join("conda-envs");
        assert!(
            prefix.starts_with(&cache_dir),
            "no-name prefix should be under cache dir"
        );
    }
}
