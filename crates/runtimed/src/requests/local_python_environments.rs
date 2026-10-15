//! Local Python environment discovery and room-local selection.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;

use notebook_protocol::connection::{EnvSource, PackageManager};
use notebook_protocol::protocol::{
    LaunchedEnvConfig, LocalEnvironmentCandidate, LocalEnvironmentDetails,
    LocalEnvironmentSelection, NotebookResponse,
};
use runtimed_client::{EnvType, PooledEnv};
use sha2::{Digest, Sha256};

use crate::notebook_sync_server::NotebookRoom;

const MAX_CANDIDATES: usize = 250;
const ROOT_ENTRY_BUDGET: usize = 2_000;

pub(crate) struct Candidate {
    id: String,
    name: String,
    display_name: String,
    pub(crate) manager: String,
    pub(crate) executable: PathBuf,
}

pub(crate) struct SelectedPythonEnvironment {
    pub(crate) env: PooledEnv,
    pub(crate) name: String,
    pub(crate) id: String,
}

impl SelectedPythonEnvironment {
    pub(crate) fn env_source(&self) -> EnvSource {
        let manager = match self.env.env_type {
            EnvType::Conda => PackageManager::Conda,
            EnvType::Pixi => PackageManager::Pixi,
            _ => PackageManager::Uv,
        };
        EnvSource::Unknown(format!("{}:existing:local", manager.as_str()))
    }

    pub(crate) fn apply_to_launched_config(
        &self,
        mut config: LaunchedEnvConfig,
        conda_channels: Option<Vec<String>>,
    ) -> LaunchedEnvConfig {
        // Selected environments never inherit dependency baselines; Conda
        // tracks notebook additions against an empty package list.
        config.uv_deps = None;
        config.conda_deps = (self.env.env_type == EnvType::Conda).then(Vec::new);
        config.conda_channels = if self.env.env_type == EnvType::Conda {
            conda_channels
        } else {
            None
        };
        config.pyproject_path = None;
        config.pixi_toml_path = None;
        config.pixi_toml_deps = None;
        config.environment_yml_path = None;
        config.environment_yml_deps = None;
        config.python_path = Some(self.env.python_path.clone());
        config.venv_path = Some(self.env.venv_path.clone());
        config.environment_id = Some(self.id.clone());
        config.environment_name = Some(self.name.clone());
        config.prewarmed_packages.clear();
        config
    }
}

pub(crate) fn python_in_prefix(prefix: &Path) -> Option<PathBuf> {
    #[cfg(not(windows))]
    let executable = prefix.join("bin").join("python");
    #[cfg(windows)]
    let executable = [
        prefix.join("python.exe"),
        prefix.join("Scripts").join("python.exe"),
    ]
    .into_iter()
    .find(|path| path.is_file())?;
    Some(executable)
}

fn candidate_id(executable: &Path) -> String {
    let digest = Sha256::digest(executable.to_string_lossy().as_bytes());
    format!("python:{}", hex::encode(digest))
}

fn normalized_executable_key(path: &Path) -> String {
    let value = path.to_string_lossy();
    #[cfg(windows)]
    {
        value.replace('/', "\\").to_lowercase()
    }
    #[cfg(not(windows))]
    {
        value.into_owned()
    }
}

pub(crate) fn apply_candidate_limit(mut candidates: Vec<Candidate>) -> (Vec<Candidate>, bool) {
    candidates.sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.id.cmp(&b.id)));
    let truncated = candidates.len() > MAX_CANDIDATES;
    candidates.truncate(MAX_CANDIDATES);
    (candidates, truncated)
}

pub(crate) fn candidates_for_room(
    room: &NotebookRoom,
    notebook_path: Option<&Path>,
) -> Vec<Candidate> {
    let mut candidates = Vec::new();
    let mut seen = std::collections::HashSet::new();

    // Conda roots include configured/common envs dirs and the registered
    // prefixes. Each root and the registry have their own entry budget.
    for (name, prefix) in crate::project_file::discover_conda_envs() {
        let Some(executable) = python_in_prefix(&prefix) else {
            continue;
        };
        if !candidate_has_ipykernel(&executable) {
            continue;
        }
        if seen.insert(normalized_executable_key(&executable)) {
            candidates.push(Candidate {
                id: candidate_id(&executable),
                name: name.clone(),
                display_name: format!("{} ({})", name, prefix.display()),
                manager: "conda".to_string(),
                executable,
            });
        }
    }

    // PATH resolution is passive. Check each PATH entry, never execute Python.
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path).take(ROOT_ENTRY_BUDGET) {
            #[cfg(windows)]
            let names = ["python.exe", "python3.exe"];
            #[cfg(not(windows))]
            let names = ["python3", "python"];
            for name in names {
                let executable = dir.join(name);
                if executable.is_file()
                    && candidate_has_ipykernel(&executable)
                    && seen.insert(normalized_executable_key(&executable))
                {
                    candidates.push(Candidate {
                        id: candidate_id(&executable),
                        name: name.to_string(),
                        display_name: format!("{} ({})", name, dir.display()),
                        manager: path_manager_for_path(&dir),
                        executable,
                    });
                }
            }
        }
    }

    // Project-local environments are checked at bounded ancestor markers.
    {
        let start = notebook_path.unwrap_or(&room.identity.persist_path);
        let mut dir = if start.is_file() {
            start.parent().map(Path::to_path_buf)
        } else {
            Some(start.to_path_buf())
        };
        for _ in 0..32 {
            let Some(current) = dir.take() else { break };
            for (prefix, manager, name) in [
                (current.join(".venv"), "uv/venv", ".venv"),
                (
                    current.join(".pixi").join("envs").join("default"),
                    "pixi",
                    "Pixi default",
                ),
            ] {
                if let Some(executable) = python_in_prefix(&prefix) {
                    if candidate_has_ipykernel(&executable)
                        && seen.insert(normalized_executable_key(&executable))
                    {
                        candidates.push(Candidate {
                            id: candidate_id(&executable),
                            name: name.to_string(),
                            display_name: format!("{} ({})", name, prefix.display()),
                            manager: manager.to_string(),
                            executable,
                        });
                    }
                }
            }
            if current.join(".git").exists() || current.parent().is_none() {
                break;
            }
            dir = current.parent().map(Path::to_path_buf);
        }
    }

    candidates
}

fn candidate_has_ipykernel(python_path: &Path) -> bool {
    kernel_env::interpreter_site_packages_has_ipykernel(python_path) == Some(true)
}

fn path_manager_for_path(path: &Path) -> String {
    let path = path.to_string_lossy().to_lowercase();
    if path.contains("conda") || path.contains("anaconda") || path.contains("miniforge") {
        "conda".to_string()
    } else if path.contains(".pixi") {
        "pixi".to_string()
    } else if path.contains(".venv") || path.contains("virtualenv") {
        "uv/venv".to_string()
    } else {
        "path".to_string()
    }
}

async fn selection(room: &NotebookRoom) -> (LocalEnvironmentSelection, Vec<Candidate>) {
    let notebook_path = room.file_binding.path().await;
    let project_path = match notebook_path {
        Some(path) => Some(path),
        None => room.identity.working_dir.read().await.clone(),
    };
    let all = candidates_for_room(room, project_path.as_deref());
    let (candidates, truncated) = apply_candidate_limit(all);
    let selected_id = room
        .local_environment_selection
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let selected = selected_id
        .as_ref()
        .and_then(|id| candidates.iter().find(|candidate| &candidate.id == id));
    let response = LocalEnvironmentSelection {
        candidates: candidates
            .iter()
            .map(|candidate| LocalEnvironmentCandidate {
                id: candidate.id.clone(),
                name: candidate.name.clone(),
                display_name: candidate.display_name.clone(),
                manager: candidate.manager.clone(),
            })
            .collect(),
        selected_id,
        selected_name: selected.map(|candidate| candidate.name.clone()),
        truncated,
    };
    (response, candidates)
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod tests {
    use super::*;

    #[test]
    fn requested_specs_include_explicit_dependencies_but_not_python() {
        let exported = serde_json::json!({
            "dependencies": ["python >=3.12", "python=3.13", "ipykernel >=7", "pandas"]
        });
        assert_eq!(
            conda_requested_dependencies_from_export(&exported),
            ["ipykernel >=7", "pandas"]
        );
    }

    #[test]
    fn conda_version_spec_without_whitespace_is_excluded() {
        let exported = serde_json::json!({"dependencies": ["python=3.13", "ipykernel"]});
        assert_eq!(
            conda_requested_dependencies_from_export(&exported),
            ["ipykernel"]
        );
    }

    #[test]
    fn candidate_ids_do_not_expose_paths() {
        let id = candidate_id(Path::new("C:/Users/Example User/envs/rankings/python.exe"));
        assert!(id.starts_with("python:"));
        assert!(!id.contains("Example User"));
        assert!(!id.contains("/"));
    }

    #[test]
    fn selected_environment_tracks_conda_from_empty_baseline() {
        let environment = SelectedPythonEnvironment {
            env: PooledEnv {
                env_type: EnvType::Conda,
                venv_path: PathBuf::from("/envs/rankings"),
                python_path: PathBuf::from("/envs/rankings/bin/python"),
                prewarmed_packages: vec!["ipykernel".to_string()],
            },
            name: "rankings".to_string(),
            id: "python:opaque-id".to_string(),
        };
        let config = LaunchedEnvConfig {
            uv_deps: Some(vec!["pandas".to_string()]),
            conda_deps: Some(vec!["numpy".to_string()]),
            conda_channels: Some(vec!["conda-forge".to_string()]),
            pyproject_path: Some(PathBuf::from("pyproject.toml")),
            pixi_toml_path: Some(PathBuf::from("pixi.toml")),
            pixi_toml_deps: Some(vec!["numpy".to_string()]),
            environment_yml_path: Some(PathBuf::from("environment.yml")),
            environment_yml_deps: Some(vec!["scipy".to_string()]),
            ..LaunchedEnvConfig::default()
        };

        let config = environment.apply_to_launched_config(config, Some(vec!["conda-forge".into()]));
        assert_eq!(config.environment_id.as_deref(), Some("python:opaque-id"));
        assert_eq!(config.environment_name.as_deref(), Some("rankings"));
        assert_eq!(
            config.python_path,
            Some(PathBuf::from("/envs/rankings/bin/python"))
        );
        assert!(config.uv_deps.is_none());
        assert_eq!(config.conda_deps, Some(Vec::new()));
        assert_eq!(config.conda_channels, Some(vec!["conda-forge".to_string()]));
        assert!(config.pyproject_path.is_none());
        assert!(config.pixi_toml_path.is_none());
        assert!(config.pixi_toml_deps.is_none());
        assert!(config.environment_yml_path.is_none());
        assert!(config.environment_yml_deps.is_none());
        assert!(config.prewarmed_packages.is_empty());
        assert_eq!(environment.env_source().as_str(), "conda:existing:local");
    }

    #[test]
    fn list_selection_keeps_safe_name_separate_from_disambiguated_label() {
        let candidate = Candidate {
            id: "opaque".into(),
            name: "rankings".into(),
            display_name: "rankings (C:/Users/example/envs/rankings)".into(),
            manager: "conda".into(),
            executable: PathBuf::from("C:/Users/example/envs/rankings/python.exe"),
        };
        assert_eq!(candidate.name, "rankings");
        assert!(candidate.display_name.contains("C:/Users"));
    }

    #[test]
    fn candidates_are_deterministic_and_capped() {
        let candidates = (0..251)
            .rev()
            .map(|index| Candidate {
                id: format!("id-{index:03}"),
                name: format!("env-{index:03}"),
                display_name: format!("env-{index:03}"),
                manager: "conda".into(),
                executable: PathBuf::from(format!("/env-{index:03}/bin/python")),
            })
            .collect();
        let (limited, truncated) = apply_candidate_limit(candidates);
        assert_eq!(limited.len(), 250);
        assert!(truncated);
        assert_eq!(limited[0].name, "env-000");
        assert_eq!(limited[249].name, "env-249");
    }

    #[cfg(windows)]
    #[test]
    fn executable_deduplication_is_case_insensitive_on_windows() {
        assert_eq!(
            normalized_executable_key(Path::new(r"C:\Users\Name\env\python.exe")),
            normalized_executable_key(Path::new(r"c:/users/name/env/python.exe")),
        );
    }

    #[cfg(unix)]
    #[test]
    fn prefix_python_is_detected_without_execution() {
        let temp = tempfile::TempDir::new().unwrap();
        let executable = temp.path().join("bin").join("python");
        std::fs::create_dir_all(executable.parent().unwrap()).unwrap();
        std::fs::write(&executable, b"not executed").unwrap();
        assert_eq!(python_in_prefix(temp.path()), Some(executable));
    }

    #[cfg(unix)]
    #[test]
    fn discovery_eligibility_requires_ipykernel_filesystem_evidence() {
        let prefix = tempfile::TempDir::new().unwrap();
        let python = prefix.path().join("bin/python3.12");
        let packages = prefix.path().join("lib/python3.12/site-packages");
        std::fs::create_dir_all(python.parent().unwrap()).unwrap();
        std::fs::create_dir_all(&packages).unwrap();
        std::fs::write(&python, "not executed").unwrap();

        assert_eq!(
            kernel_env::interpreter_site_packages_has_ipykernel(&python),
            Some(false)
        );
        std::fs::create_dir_all(packages.join("ipykernel")).unwrap();
        assert_eq!(
            kernel_env::interpreter_site_packages_has_ipykernel(&python),
            Some(true)
        );
    }
}

pub(crate) async fn list(room: &Arc<NotebookRoom>) -> NotebookResponse {
    if room.is_hosted() {
        return NotebookResponse::Error {
            error: "Local environment discovery is unavailable for hosted notebooks".into(),
        };
    }
    let (selection, _) = selection(room).await;
    NotebookResponse::PythonEnvironments { selection }
}

pub(crate) async fn get_details(room: &Arc<NotebookRoom>) -> NotebookResponse {
    if room.is_hosted() {
        return NotebookResponse::PythonEnvironmentDetails { details: None };
    }
    let id = room
        .local_environment_selection
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone();
    let Some(id) = id else {
        return NotebookResponse::PythonEnvironmentDetails { details: None };
    };
    let (_, candidates) = selection(room).await;
    let details = if let Some(candidate) = candidates.iter().find(|candidate| candidate.id == id) {
        let python_version = python_version(&candidate.executable).await;
        let prefix = candidate
            .executable
            .parent()
            .and_then(Path::parent)
            .unwrap_or(Path::new("."));
        Some(LocalEnvironmentDetails {
            prefix: prefix.to_string_lossy().into_owned(),
            python_executable: candidate.executable.to_string_lossy().into_owned(),
            python_version,
            conda_dependencies: if candidate.manager == "conda" {
                conda_requested_dependencies(prefix).await
            } else {
                Vec::new()
            },
        })
    } else {
        None
    };
    NotebookResponse::PythonEnvironmentDetails { details }
}

async fn conda_requested_dependencies(prefix: &Path) -> Vec<String> {
    let conda = std::env::var_os("CONDA_EXE")
        .map(PathBuf::from)
        .or_else(|| {
            std::env::var_os("PATH").and_then(|path| {
                std::env::split_paths(&path)
                    .map(|directory| {
                        directory.join(if cfg!(windows) { "conda.exe" } else { "conda" })
                    })
                    .find(|path| path.is_file())
            })
        });
    let Some(conda) = conda else {
        return Vec::new();
    };
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(10),
        tokio::process::Command::new(conda)
            .arg("env")
            .arg("export")
            .arg("--from-history")
            .arg("--json")
            .arg("-p")
            .arg(prefix)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok);
    let Some(output) = output.filter(|output| output.status.success()) else {
        return Vec::new();
    };
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(&output.stdout) else {
        return Vec::new();
    };
    conda_requested_dependencies_from_export(&value)
}

fn conda_requested_dependencies_from_export(value: &serde_json::Value) -> Vec<String> {
    let Some(dependencies) = value
        .get("dependencies")
        .and_then(serde_json::Value::as_array)
    else {
        return Vec::new();
    };
    let mut packages = dependencies
        .iter()
        .filter_map(serde_json::Value::as_str)
        .map(|dependency| dependency.strip_prefix("- ").unwrap_or(dependency))
        .filter(|dependency| {
            !dependency
                .split(|character: char| {
                    character.is_whitespace()
                        || matches!(character, '=' | '<' | '>' | '!' | '[' | '@')
                })
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case("python"))
        })
        .map(str::to_string)
        .collect::<Vec<_>>();
    packages.sort();
    packages.dedup();
    packages
}

async fn python_version(executable: &Path) -> Option<String> {
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        tokio::process::Command::new(executable)
            .arg("-I")
            .arg("-c")
            .arg("import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
            .env("PYTHONNOUSERSITE", "1")
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|version| !version.is_empty())
}

pub(crate) async fn set(
    room: &Arc<NotebookRoom>,
    candidate_id: Option<String>,
) -> NotebookResponse {
    if room.is_hosted() {
        return NotebookResponse::Error {
            error: "Local environment selection is unavailable for hosted notebooks".into(),
        };
    }
    let (mut current, candidates) = selection(room).await;
    if let Some(id) = candidate_id.as_ref() {
        if !candidates.iter().any(|candidate| &candidate.id == id) {
            return NotebookResponse::Error {
                error: "Selected Python environment is no longer available; refresh the list"
                    .into(),
            };
        }
    }
    *room
        .local_environment_selection
        .lock()
        .unwrap_or_else(|error| error.into_inner()) = candidate_id.clone();
    current.selected_id = candidate_id;
    let selected = current
        .selected_id
        .as_ref()
        .and_then(|id| candidates.iter().find(|candidate| &candidate.id == id));
    current.selected_name = selected.map(|candidate| candidate.name.clone());
    NotebookResponse::PythonEnvironments { selection: current }
}

pub(crate) async fn selected_launch(
    room: &NotebookRoom,
) -> Result<Option<SelectedPythonEnvironment>, String> {
    let Some(id) = room
        .local_environment_selection
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .clone()
    else {
        return Ok(None);
    };
    let (_, candidates) = selection(room).await;
    let candidate = candidates
        .iter()
        .find(|candidate| candidate.id == id)
        .ok_or_else(|| "Selected Python environment is no longer available".to_string())?;
    let executable = candidate.executable.clone();
    let probe = tokio::time::timeout(std::time::Duration::from_secs(5), async move {
        tokio::process::Command::new(executable)
            .arg("-I")
            .arg("-c")
            .arg("import ipykernel")
            .env("PYTHONNOUSERSITE", "1")
            .kill_on_drop(true)
            .status()
            .await
    })
    .await;
    if !matches!(probe, Ok(Ok(status)) if status.success()) {
        return Err(
            "The selected Python environment cannot import ipykernel; no packages were installed"
                .into(),
        );
    }
    let prefix = candidate
        .executable
        .parent()
        .and_then(Path::parent)
        .unwrap_or(Path::new("."));
    let env_type = match candidate.manager.as_str() {
        "conda" => EnvType::Conda,
        "pixi" => EnvType::Pixi,
        _ => EnvType::Uv,
    };
    Ok(Some(SelectedPythonEnvironment {
        env: PooledEnv {
            env_type,
            venv_path: prefix.to_path_buf(),
            python_path: candidate.executable.clone(),
            prewarmed_packages: Vec::new(),
        },
        name: candidate.name.clone(),
        id: candidate.id.clone(),
    }))
}
