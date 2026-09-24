# Validation Checks — Pyodide Adapter Architecture Verification

## 1. runtime_agent_handle.rs Tokio lock audit (`AGENTS.md` rule: no Tokio locks across await)

- `RuntimeAgentHandle::spawn()` holds no `Mutex` or `RwLock` guard across `.await`.
- `cmd.spawn()` is synchronous; `child.wait().await` runs inside the `spawn_supervised` closure, separate from the `spawn` return path.
- `Arc<AtomicBool>` (`alive`) uses atomic ordering (`Ordering::Relaxed`), not a Tokio lock.
- `drop()` performs synchronous `killpg` / `start_kill()`; no await points exist.

**Result:** No violation. The adapter can launch a separate WASM process without blocking the daemon's Tokio runtime.

## 2. deployment-topology.md runtime_peer authorization (`docs/adr/deployment-topology.md`)

- `runtime_peer` writes only `RuntimeStateDoc`, output, lifecycle, and referenced blobs (`Decision 2`).
- It does not edit `NotebookDoc` or invent durable execution intent (`Decision 7`).
- The adapter's `EventSink` must be scoped to these surfaces; it cannot receive `NotebookDoc` mutation authority.
- The adapter profile (`pyodide_profile.rs`) uses `engine: nteract.sequential`, which preserves this scope.

**Result:** Authorization boundary preserved.

## 3. isolated-renderer / IsolatedFrame confirmation (`src/components/isolated/`)

- `IsolatedFrame`, `CommBridgeManager`, `isolated-frame-runtime.ts` exist.
- These components are relevant only for a browser-embedded PyScript adapter (`pyscript.browser`), not for the WASM sandbox adapter (`pyodide.wasm`).
- The adapter profile does not reference `IsolatedFrame`; it uses a standalone `ExecutorAdapter` process model.

**Result:** Confirmed — isolated renderer components are out of scope for Pyodide adapter.
