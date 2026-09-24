//! Adapter profiles for execution-engine integration.
//!
//! Defines the concrete `pyodide.wasm` adapter profile within the EngineSession
//! model without altering core architecture. The `pyscript.browser` profile is
//! intentionally not shipped as a stub.

pub mod profile_selection;
pub mod pyodide_profile;
pub mod wasm_shim_resolution;
