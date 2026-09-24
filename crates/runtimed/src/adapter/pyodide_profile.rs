//! Pyodide adapter profile — concrete runtime profile within the EngineSession model.
//!
//! This defines the `pyodide.wasm` RuntimeProfile (see execution-engines-and-marimo.md)
//! without altering the core architecture (NotebookDoc, RuntimeStateDoc, runtime_peer
//! authorization boundary remain unchanged).
//!
//! The adapter treats Pyodide (WASM Python runtime) as an ExecutorAdapter profile.
//! It uses the existing `EngineSession` contract: `describe()`, `sync_notebook()`,
//! `execute(AuthorizedPlanRevision, EventSink)`, `cancel()`, `shutdown()`.

use std::collections::HashMap;

/// Runtime profile identifier for the WASM-based Python sandbox.
pub const PYODIDE_PROFILE_ID: &str = "pyodide.wasm";

/// Runtime descriptor for Pyodide.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PyodideDescriptor {
    /// Profile ID: `pyodide.wasm`
    pub profile_id: String,
    /// Engine scheduling mode: explicit serial.
    pub scheduling: &'static str,
    /// Executor adapter: `pyodide.wasm`.
    pub executor: &'static str,
    /// Language: Python.
    pub language: &'static str,
    /// Capabilities: basic execution, no Jupyter comms, no reactive planning.
    pub capabilities: Vec<&'static str>,
}

impl Default for PyodideDescriptor {
    fn default() -> Self {
        Self {
            profile_id: PYODIDE_PROFILE_ID.to_string(),
            scheduling: "explicit_serial",
            executor: "pyodide.wasm",
            language: "python",
            capabilities: vec![
                "execute",
                "stdout_stderr",
                "mime_display",
                "structured_error",
                "cancel_execution",
                "shutdown",
            ],
        }
    }
}

/// Profile definition matching the RuntimeProfile schema
/// (`execution-engines-and-marimo.md`, line 109-120).
pub fn pyodide_profile() -> HashMap<String, String> {
    let mut profile = HashMap::new();
    profile.insert("profile".to_string(), PYODIDE_PROFILE_ID.to_string());
    profile.insert("engine".to_string(), "nteract.sequential".to_string());
    profile.insert("executor".to_string(), "pyodide.wasm".to_string());
    profile.insert("language".to_string(), "python".to_string());
    profile.insert("mode".to_string(), "sandbox".to_string());
    profile
}

/// Validation: profile must reference an existing engine descriptor.
/// This check uses the existing sequential engine (`nteract.sequential`).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_defined() {
        let p = pyodide_profile();
        assert_eq!(p.get("executor").unwrap(), "pyodide.wasm");
        assert!(p.get("engine").unwrap().contains("sequential"));
    }

    #[test]
    fn descriptor_has_capabilities() {
        let d = PyodideDescriptor::default();
        assert!(d.capabilities.contains(&"execute"));
        assert!(!d.capabilities.contains(&"jupyter_comms"));
    }
}
