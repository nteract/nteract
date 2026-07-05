# Notebook state stores

Scope: `src/components/notebook/state/**` - the shared store layer between
WASM/host sources and notebook UI. Two store idioms live here; the boundary is
a Decision 8 call, not an accident (`docs/adr/frontend-sync-bridge.md`).

## Two store idioms

- **Hand-rolled `Map`/`Set` pub/sub** (`cell-store.ts`, `execution-store.ts`,
  `output-store.ts`, `rail-ui-state.ts`, ...): synchronous per-entity fan-out
  where per-subscriber granularity is the point and nothing cancels. Keep them
  as they are; do not convert them to RxJS.
- **RxJS-bound** (`runtime-state.ts`, `runtime-store-projection.ts`,
  `view-store-projection.ts`): anything holding time, async, or an
  `AbortController`. `runtime-state-store.ts` in `packages/runtimed` extends
  `ObservableStore` (frontend-sync-bridge Decision 8).

## Binding is plumbing

- `observable-binding.ts` is the single tearing-safe `useSyncExternalStore`
  binding, shared by desktop and cloud store-hook modules. Its file header is
  authoritative: components never import it and never call `store.select(...)`
  inline in a render body; they consume named domain hooks
  (`useRuntimeState`, `useCloudAuthState`, ...). Inline `select()` creates a
  fresh Observable per render and defeats the binding cache.
- Reset/reconnect paths invalidate stale async writes by epoch, not just
  visible state. How-to depth: frontend-dev skill, "Module-Singleton Source
  Stores".
