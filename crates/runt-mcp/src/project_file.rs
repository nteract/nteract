//! Minimal project file detection for MCP tools.
//!
//! Walks up from a start path looking for `pyproject.toml` or `pixi.toml`.
//! Used to determine whether dep management should target a project file
//! (via `pixi add` / `uv add`) or notebook inline metadata.

use std::path::{Path, PathBuf};

/// The type of project file detected.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectFileKind {
    PyprojectToml,
    PixiToml,
}

/// A detected project file with its path and kind.
#[derive(Debug, Clone)]
pub struct DetectedProjectFile {
    pub path: PathBuf,
    pub kind: ProjectFileKind,
}

impl DetectedProjectFile {
    /// The package manager for this project file.
    pub fn manager(&self) -> notebook_protocol::connection::PackageManager {
        use notebook_protocol::connection::PackageManager;
        match self.kind {
            ProjectFileKind::PyprojectToml => PackageManager::Uv,
            ProjectFileKind::PixiToml => PackageManager::Pixi,
        }
    }

    /// The daemon env_source for this project type.
    pub fn env_source(&self) -> notebook_protocol::connection::EnvSource {
        use notebook_protocol::connection::EnvSource;
        match self.kind {
            ProjectFileKind::PyprojectToml => EnvSource::Pyproject,
            ProjectFileKind::PixiToml => EnvSource::PixiToml,
        }
    }
}

/// Detect the nearest project file by walking up from `start_path`.
///
/// Checks each directory for `pyproject.toml` and `pixi.toml`.
/// A `pyproject.toml` with `[tool.pixi]` is treated as a pixi project.
/// Stops at `.git` boundaries or the user's home directory.
pub fn detect_project_file(start_path: &Path) -> Option<DetectedProjectFile> {
    detect_project_file_with_home(start_path, dirs::home_dir())
}

fn detect_project_file_with_home(
    start_path: &Path,
    home_dir: Option<PathBuf>,
) -> Option<DetectedProjectFile> {
    let start_dir = if start_path.is_file() {
        start_path.parent()?
    } else {
        start_path
    };

    let mut current = start_dir.to_path_buf();

    loop {
        // Treat the user's home directory as a boundary before checking files
        // there. A top-level ~/pyproject.toml or ~/pixi.toml is valid for
        // other tooling, but MCP notebooks under ~/ should not inherit it
        // implicitly.
        if let Some(ref home) = home_dir {
            if current == *home {
                return None;
            }
        }

        // Check pyproject.toml first (higher priority in tiebreaker)
        let pyproject = current.join("pyproject.toml");
        if pyproject.exists() {
            // If it has [tool.pixi], treat as pixi project
            if has_pixi_section(&pyproject) {
                return Some(DetectedProjectFile {
                    path: pyproject,
                    kind: ProjectFileKind::PixiToml,
                });
            }
            return Some(DetectedProjectFile {
                path: pyproject,
                kind: ProjectFileKind::PyprojectToml,
            });
        }

        // Check pixi.toml
        let pixi = current.join("pixi.toml");
        if pixi.exists() {
            return Some(DetectedProjectFile {
                path: pixi,
                kind: ProjectFileKind::PixiToml,
            });
        }

        // Stop at git repo root
        if current.join(".git").exists() {
            return None;
        }

        match current.parent() {
            Some(parent) if parent != current => {
                current = parent.to_path_buf();
            }
            _ => return None,
        }
    }
}

/// Check if a pyproject.toml contains a `[tool.pixi]` section.
fn has_pixi_section(path: &Path) -> bool {
    std::fs::read_to_string(path)
        .ok()
        .is_some_and(|content| content.contains("[tool.pixi]") || content.contains("[tool.pixi."))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_file(dir: &Path, name: &str, content: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn home_directory_project_file_is_boundary_not_match() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path().join("home");
        let notebooks = home.join("notebooks");
        std::fs::create_dir_all(&notebooks).unwrap();
        write_file(&home, "pyproject.toml", "[project]\nname = \"home\"\n");

        let found =
            detect_project_file_with_home(&notebooks.join("analysis.ipynb"), Some(home.clone()));

        assert!(
            found.is_none(),
            "project detection must not bind notebooks to ~/pyproject.toml"
        );
    }

    #[test]
    fn subdirectory_project_file_still_matches_before_home_boundary() {
        let temp = tempfile::TempDir::new().unwrap();
        let home = temp.path().join("home");
        let project = home.join("project");
        let notebooks = project.join("notebooks");
        std::fs::create_dir_all(&notebooks).unwrap();
        write_file(
            &project,
            "pyproject.toml",
            "[project]\nname = \"project\"\n",
        );

        let found =
            detect_project_file_with_home(&notebooks.join("analysis.ipynb"), Some(home)).unwrap();

        assert_eq!(found.kind, ProjectFileKind::PyprojectToml);
        assert_eq!(found.path, project.join("pyproject.toml"));
    }
}
