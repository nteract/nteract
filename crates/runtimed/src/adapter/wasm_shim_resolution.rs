//! WASM import / shim resolution for the adapter.
//!
//! Based on the plan (`Open / Out of Scope`): the adapter should use a static
//! import (`await import("*.wasm")`) or a dynamic shim. The `celld-local.mjs`
//! script (`docs/memos/celld-hosted-room-substrate.md`, line 280) uses a static
//! shim for WASM imports in bundled Workers.
//!
//! For the `pyodide.wasm` adapter, the recommendation is a static shim:
//! the adapter bundle includes a pre-built WASM module reference so `celld`'s
//! bundler can register it statically, avoiding dynamic `import()` rejection.

/// Adapter WASM import strategy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmImportStrategy {
    /// Static shim: WASM is bundled as a module reference (compatible with celld/esbuild).
    /// Used by `celld-local.mjs` (`line 280`).
    StaticShim,
    /// Dynamic import: `await import("*.wasm")` — rejected by some bundlers.
    DynamicImport,
}

/// Resolution: the adapter uses `StaticShim`.
pub const ADAPTER_WASM_STRATEGY: WasmImportStrategy = WasmImportStrategy::StaticShim;

/// Rationale recorded from `celld-hosted-room-substrate.md` and the execution-engine
/// proposal: dynamic WASM imports are rejected by `celld`'s esbuild pass; a static
/// import shim is required for hosted/worker deployment.
pub fn resolve_wasm_strategy() -> &'static str {
    match ADAPTER_WASM_STRATEGY {
        WasmImportStrategy::StaticShim => "static_shim",
        WasmImportStrategy::DynamicImport => "dynamic_import",
    }
}
