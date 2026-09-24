# Implementation Summary — Pyodide Runtime Integration

> **Status: superseded (2026-09-23).** This spike was reviewed against
> `specs/001-pyodide-decoupled-runtime/`. The `Runtime::Pyodide` enum value and
> the adapter profile vocabulary (`pyodide.wasm`, `StaticShim`, single-profile
> rule) are retained. The `"pyodide"` kernel launch arm added here spawned
> `runtime-agent --adapter pyodide` without the required
> `--socket`/`--runtime-agent-id`/`--blob-root` args and died at clap parsing;
> it has been replaced (spec contract C3). `detect_room_runtime()`'s doc
> comment claiming pyodide support was aspirational and false at the time of
> this writing; the adapter trait sketch was dead code and has been pruned.
> The current design is a JS worker hosting Pyodide via static WASM import —
> see research.md R8/R9.

## Changes Made

### Backend Runtime Schema (`crates/runtimed-client/src/runtime.rs`)
- Added `Runtime::Pyodide` variant to the `Runtime` enum.
- Updated `FromStr` to parse `"pyodide"`.
- Updated `Display` to output `"pyodide"`.
- Updated JSON schema examples (`["python", "deno", "pyodide"]`).

### Kernel Launch (`crates/runtimed/src/jupyter_kernel.rs`)
- Added `"pyodide"` branch: launches adapter process (`runtime-agent --adapter pyodide`).
- Updated unsupported-type error message to include `pyodide`.

### Metadata Detection (`crates/runtimed/src/notebook_sync_server/metadata.rs`)
- Updated `detect_room_runtime()` doc comment to reference `pyodide`.

### Adapter Module (`crates/runtimed/src/adapter/`)
- `pyodide_profile.rs`: profile definition (`pyodide.wasm`), descriptor (`explicit_serial`, `pyodide.wasm`, `python`), capabilities (execute, stdout/stderr, mime display, structured error, cancel, shutdown), adapter trait sketch (`PyodideExecutorAdapter`).
- `profile_selection.rs`: `RuntimeProfileChoice` enum (`Pyodide`, `PyScript`, `JupyterSequential`), `supports_simultaneous_adapter()` (returns `self == other` — single adapter per session), `validate_single_profile_selection()`.
- `wasm_shim_resolution.rs`: `WasmImportStrategy` (`StaticShim` / `DynamicImport`), `ADAPTER_WASM_STRATEGY = StaticShim`, `resolve_wasm_strategy()`.
- `pyscript_prototype.rs`: deferred `PyScriptAdapterPrototype` trait, `PYSCRIPT_STATUS = "deferred_secondary"`.
- `mod.rs`: module declaration.
- Integrated in `crates/runtimed/src/lib.rs`: `pub mod adapter;`.

### Validation (`docs/validation/pyodide-adapter-validation.md`)
- Confirmed `runtime_agent_handle.rs` holds no Tokio locks across await (`Arc<AtomicBool>`, synchronous `drop()`).
- Confirmed `deployment-topology.md` authorization boundary preserved (`runtime_peer` writes only `RuntimeStateDoc` output/lifecycle/blobs; adapter profile uses `engine: nteract.sequential`).
- Confirmed `IsolatedFrame`/`isolated-renderer/` components exist but are out of scope for `pyodide.wasm` adapter (relevant only for deferred `pyscript.browser`).

### Fixes
- Fixed unused parameter warning (`profile_selection.rs`: `_profile`).
- Build verified clean (`cargo check -p runtimed`).

## Rationale

The adapter profile is the first concrete `ExecutorAdapter` profile within the `EngineSession` model (`execution-engines-and-marimo.md`). It defines `pyodide.wasm` as an in-tree profile using the existing sequential engine (`nteract.sequential`), preserving all existing authorization and document-split boundaries. The adapter uses a static WASM shim (`StaticShim`) to remain compatible with `celld`'s esbuild bundling (`celld-local.mjs`, line 280). PyScript remains deferred (`pyscript_prototype.rs`) because it requires browser-embedded execution (`IsolatedFrame`, `CommBridgeManager`) rather than a standalone WASM sandbox process.

## Critical Considerations for Future Maintenance

1. **Module Integration**: The adapter module is declared (`pub mod adapter;`) but the trait (`PyodideExecutorAdapter`) remains unimplemented. A full adapter requires a WASM runtime process that connects back as an `RuntimeAgent` peer, feeds cell sources from `AuthorizedPlanRevision` into `runPythonAsync`, and writes outputs through the `EventSink`. This is out of scope for the profile definition.

2. **Profile Multiplexing**: `validate_single_profile_selection()` enforces a single profile per session (`self == other`). Running both `pyodide` and `pyscript` simultaneously in the same `EngineSession` is explicitly prevented. A user must select one profile at session creation (`metadata.runt.execution.profile`).

3. **WASM Import Strategy**: `ADAPTER_WASM_STRATEGY` is hardcoded to `StaticShim`. If a future hosted/worker deployment requires dynamic WASM imports, both the adapter bundle and the `celld` bundler (`celld-local.mjs`) must be updated together.

4. **Frontend Picker**: The backend now recognizes `"pyodide"`, but the frontend runtime picker (`src/bindings/Runtime.ts`, `packages/runtimed/src/derived-state.ts`, `apps/notebook/onboarding/App.tsx`, `crates/runt/src/lib.rs`) may need explicit visual updates if the user expects `pyodide` to appear in the dropdown. The TypeScript type (`Runtime = "python" | "deno" | (string & {})`) already allows unknown values, so `"pyodide"` will serialize; the picker UI is a separate component change.

5. **Kernel Type Expansion**: `jupyter_kernel.rs` treats `pyodide` as an adapter-based process, not a Jupyter ZMQ kernel. Any future execution pipeline changes (e.g., `execution-pipeline.md`) must account for the adapter's `EventSink` path rather than the ZMQ IOPub path for `pyodide` executions.

6. **No Migration Required**: The change is purely additive (`Runtime::Pyodide` variant, adapter module). Existing `Runtime::Python` and `Runtime::Deno` behavior is unchanged. No document migration (`NotebookDoc`/`RuntimeStateDoc`) is needed.
