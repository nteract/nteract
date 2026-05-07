//! Notebook trust extraction.
//!
//! Notebooks can embed arbitrary package dependencies that get installed with
//! full OS permissions when a kernel starts, which makes dependency lists a
//! supply-chain attack surface. The daemon gates kernel launch on whether
//! every dependency name and package source is present in a per-machine SQLite
//! allowlist.
//!
//! This crate provides the structural types and the dependency-extraction
//! helpers. It does not own the gating decision: callers pull a
//! `TrustInfo` out of metadata and pair it with the allowlist store to
//! finalize a `TrustStatus`.

#![cfg_attr(test, allow(clippy::unwrap_used, clippy::expect_used))]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Result of resolving a notebook's trust state.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum TrustStatus {
    /// Every dependency name and package source is approved in the local allowlist.
    Trusted,

    /// At least one dependency name or package source is not approved (or the
    /// allowlist cannot be queried).
    Untrusted,

    /// Notebook declares no dependencies, so there is nothing to gate.
    NoDependencies,
}

/// Information about notebook trust for the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrustInfo {
    pub status: TrustStatus,
    /// The UV dependencies that will be installed (if any).
    pub uv_dependencies: Vec<String>,
    /// UV dependencies already present in the local trusted package allowlist.
    #[serde(default)]
    pub approved_uv_dependencies: Vec<String>,
    /// The conda dependencies that will be installed (if any).
    pub conda_dependencies: Vec<String>,
    /// Conda dependencies already present in the local trusted package allowlist.
    #[serde(default)]
    pub approved_conda_dependencies: Vec<String>,
    /// Conda channels configured.
    pub conda_channels: Vec<String>,
    /// Conda channels already present in the local trusted package allowlist.
    #[serde(default)]
    pub approved_conda_channels: Vec<String>,
    /// The Pixi conda-style dependencies that will be installed (if any).
    #[serde(default)]
    pub pixi_dependencies: Vec<String>,
    /// Pixi conda-style dependencies already present in the local trusted package allowlist.
    #[serde(default)]
    pub approved_pixi_dependencies: Vec<String>,
    /// The Pixi PyPI dependencies that will be installed (if any).
    #[serde(default)]
    pub pixi_pypi_dependencies: Vec<String>,
    /// Pixi PyPI dependencies already present in the local trusted package allowlist.
    #[serde(default)]
    pub approved_pixi_pypi_dependencies: Vec<String>,
    /// Pixi channels configured.
    #[serde(default)]
    pub pixi_channels: Vec<String>,
    /// Pixi channels already present in the local trusted package allowlist.
    #[serde(default)]
    pub approved_pixi_channels: Vec<String>,
}

/// Get UV metadata from new path (runt.uv) or legacy path (uv)
pub fn get_uv_metadata(metadata: &HashMap<String, serde_json::Value>) -> Option<serde_json::Value> {
    if let Some(runt) = metadata.get("runt") {
        if let Some(uv) = runt.get("uv") {
            return Some(uv.clone());
        }
    }
    metadata.get("uv").cloned()
}

/// Get conda metadata from new path (runt.conda) or legacy path (conda)
pub fn get_conda_metadata(
    metadata: &HashMap<String, serde_json::Value>,
) -> Option<serde_json::Value> {
    if let Some(runt) = metadata.get("runt") {
        if let Some(conda) = runt.get("conda") {
            return Some(conda.clone());
        }
    }
    metadata.get("conda").cloned()
}

/// Get pixi metadata from runt.pixi
pub fn get_pixi_metadata(
    metadata: &HashMap<String, serde_json::Value>,
) -> Option<serde_json::Value> {
    metadata
        .get("runt")
        .and_then(|runt| runt.get("pixi"))
        .cloned()
}

/// Check if a notebook has any dependencies configured.
pub fn has_dependencies(metadata: &HashMap<String, serde_json::Value>) -> bool {
    if let Some(uv) = get_uv_metadata(metadata) {
        if let Some(deps) = uv.get("dependencies").and_then(|v| v.as_array()) {
            if !deps.is_empty() {
                return true;
            }
        }
    }

    if let Some(conda) = get_conda_metadata(metadata) {
        if let Some(deps) = conda.get("dependencies").and_then(|v| v.as_array()) {
            if !deps.is_empty() {
                return true;
            }
        }
    }

    if let Some(pixi) = get_pixi_metadata(metadata) {
        if let Some(deps) = pixi.get("dependencies").and_then(|v| v.as_array()) {
            if !deps.is_empty() {
                return true;
            }
        }
        if let Some(deps) = pixi.get("pypi_dependencies").and_then(|v| v.as_array()) {
            if !deps.is_empty() {
                return true;
            }
        }
    }

    false
}

/// Extract notebook trust information from metadata.
///
/// Returns a `TrustInfo` populated with the dependency lists and channels
/// from the snapshot. The returned `status` is `NoDependencies` when there
/// is nothing to install, otherwise `Untrusted`. `approved_*` fields are
/// always empty: the daemon's allowlist store enriches these and lifts
/// `status` to `Trusted` when every package and source identity is approved.
pub fn extract_trust_info(metadata: &HashMap<String, serde_json::Value>) -> TrustInfo {
    let uv_dependencies = string_array(get_uv_metadata(metadata).as_ref(), "dependencies");

    let conda_meta = get_conda_metadata(metadata);
    let conda_dependencies = string_array(conda_meta.as_ref(), "dependencies");
    let conda_channels = string_array(conda_meta.as_ref(), "channels");

    let pixi_meta = get_pixi_metadata(metadata);
    let pixi_dependencies = string_array(pixi_meta.as_ref(), "dependencies");
    let pixi_pypi_dependencies = string_array(pixi_meta.as_ref(), "pypi_dependencies");
    let pixi_channels = string_array(pixi_meta.as_ref(), "channels");

    let no_deps = uv_dependencies.is_empty()
        && conda_dependencies.is_empty()
        && pixi_dependencies.is_empty()
        && pixi_pypi_dependencies.is_empty();

    let status = if no_deps {
        TrustStatus::NoDependencies
    } else {
        TrustStatus::Untrusted
    };

    TrustInfo {
        status,
        uv_dependencies,
        approved_uv_dependencies: vec![],
        conda_dependencies,
        approved_conda_dependencies: vec![],
        conda_channels,
        approved_conda_channels: vec![],
        pixi_dependencies,
        approved_pixi_dependencies: vec![],
        pixi_pypi_dependencies,
        approved_pixi_pypi_dependencies: vec![],
        pixi_channels,
        approved_pixi_channels: vec![],
    }
}

fn string_array(parent: Option<&serde_json::Value>, key: &str) -> Vec<String> {
    parent
        .and_then(|v| v.get(key))
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_test_metadata(
        uv_deps: Vec<&str>,
        conda_deps: Vec<&str>,
    ) -> HashMap<String, serde_json::Value> {
        let mut metadata = HashMap::new();

        if !uv_deps.is_empty() {
            metadata.insert(
                "uv".to_string(),
                serde_json::json!({
                    "dependencies": uv_deps,
                }),
            );
        }

        if !conda_deps.is_empty() {
            metadata.insert(
                "conda".to_string(),
                serde_json::json!({
                    "dependencies": conda_deps,
                    "channels": ["conda-forge"],
                }),
            );
        }

        metadata
    }

    fn make_pixi_test_metadata(
        dependencies: Vec<&str>,
        pypi_dependencies: Vec<&str>,
    ) -> HashMap<String, serde_json::Value> {
        let mut metadata = HashMap::new();
        metadata.insert(
            "runt".to_string(),
            serde_json::json!({
                "pixi": {
                    "dependencies": dependencies,
                    "pypi_dependencies": pypi_dependencies,
                    "channels": ["conda-forge"],
                },
            }),
        );
        metadata
    }

    #[test]
    fn extract_trust_info_no_deps_is_no_dependencies() {
        let info = extract_trust_info(&HashMap::new());
        assert_eq!(info.status, TrustStatus::NoDependencies);
        assert!(info.uv_dependencies.is_empty());
        assert!(info.conda_dependencies.is_empty());
        assert!(info.pixi_dependencies.is_empty());
        assert!(info.pixi_pypi_dependencies.is_empty());
    }

    #[test]
    fn extract_trust_info_uv_deps_is_untrusted() {
        let metadata = make_test_metadata(vec!["pandas", "numpy"], vec![]);
        let info = extract_trust_info(&metadata);
        assert_eq!(info.status, TrustStatus::Untrusted);
        assert_eq!(info.uv_dependencies, vec!["pandas", "numpy"]);
        assert!(info.approved_uv_dependencies.is_empty());
    }

    #[test]
    fn extract_trust_info_conda_includes_channels() {
        let metadata = make_test_metadata(vec![], vec!["pytorch"]);
        let info = extract_trust_info(&metadata);
        assert_eq!(info.status, TrustStatus::Untrusted);
        assert_eq!(info.conda_dependencies, vec!["pytorch"]);
        assert_eq!(info.conda_channels, vec!["conda-forge"]);
    }

    #[test]
    fn extract_trust_info_pixi_separates_pypi_and_conda() {
        let metadata = make_pixi_test_metadata(vec!["pandas"], vec!["requests"]);
        let info = extract_trust_info(&metadata);
        assert_eq!(info.status, TrustStatus::Untrusted);
        assert_eq!(info.pixi_dependencies, vec!["pandas"]);
        assert_eq!(info.pixi_pypi_dependencies, vec!["requests"]);
        assert_eq!(info.pixi_channels, vec!["conda-forge"]);
    }

    #[test]
    fn test_trust_info_serialization() {
        // Verify TrustInfo serializes with status as a simple string, not nested object
        let info = TrustInfo {
            status: TrustStatus::NoDependencies,
            uv_dependencies: vec![],
            approved_uv_dependencies: vec![],
            conda_dependencies: vec![],
            approved_conda_dependencies: vec![],
            conda_channels: vec![],
            approved_conda_channels: vec![],
            pixi_dependencies: vec![],
            approved_pixi_dependencies: vec![],
            pixi_pypi_dependencies: vec![],
            approved_pixi_pypi_dependencies: vec![],
            pixi_channels: vec![],
            approved_pixi_channels: vec![],
        };

        let json = serde_json::to_value(&info).unwrap();

        assert_eq!(json["status"], "no_dependencies");
        assert!(json["status"].is_string());
    }
}
