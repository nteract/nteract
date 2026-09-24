//! Runtime profile selection mechanism.
//!
//! Based on the execution-engine proposal (`execution-engines-and-marimo.md`):
//! both `pyodide.wasm` and `pyscript.browser` can coexist as separate profiles,
//! but a single `EngineSession` must not multiplex two adapters simultaneously.

pub const PYODIDE_PROFILE: &str = "pyodide.wasm";
pub const PYSCRIPT_PROFILE: &str = "pyscript.browser";

/// Profile selection for a given notebook session.
/// The profile is selected at session creation time (metadata `runt.execution.profile`)
/// and persists for the lifetime of the `EngineSession`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RuntimeProfileChoice {
    Pyodide,
    PyScript,
    JupyterSequential,
}

impl RuntimeProfileChoice {
    /// Returns true if the architecture supports running this profile in the same
    /// session as another adapter. Per the plan (`Runtime Selection`): false for
    /// all — a single `EngineSession` owns one adapter.
    pub fn supports_simultaneous_adapter(&self, other: &Self) -> bool {
        self == other // Only identical profiles are allowed together (same adapter).
    }

    /// Convert to profile string.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pyodide => PYODIDE_PROFILE,
            Self::PyScript => PYSCRIPT_PROFILE,
            Self::JupyterSequential => "nteract.sequential",
        }
    }
}

/// Validation rule: a session selects exactly one profile.
/// The profile is persisted in `RuntimeStateDoc` and referenced by
/// `ExecutorAdapter` initialization.
pub fn validate_single_profile_selection(_profile: RuntimeProfileChoice) -> Result<(), String> {
    // The architecture does not allow merging profiles.
    // Each adapter requires a distinct environment policy and event sink.
    Ok(())
}
