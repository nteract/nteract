# Frontend Sync Bridge and Stable DOM Order

**Status:** Draft, 2026-05-23. Decision 8 added 2026-07-03.

## Context

The desktop notebook is a Tauri app: a Rust shell, a React webview, and a daemon
holding authoritative Automerge documents. Frames arrive over Tauri IPC, and
React renders cells, outputs, presence, kernel status, and widget state. Nothing
from the daemon arrives in a shape React can subscribe to directly.

Three layers sit between inbound frames and rendered pixels in
`apps/notebook/src/`:

1. **WASM peer (`runtimed-wasm`).** Owns a local `NotebookHandle` (Automerge
   document plus sync state). Decodes raw bytes into typed `FrameEvent`s,
   applies sync changes, and emits field-granular `CellChangeset`s.
2. **`SyncEngine` (`packages/runtimed/src/sync-engine.ts`).** Sole subscriber to
   WASM demux output. Owns debounced outbound flushes, coalesced inbound
   changesets, and per-concern RxJS Observables: `cellChanges$`,
   `runtimeState$`, `executionViewChanges$`, `outputIdChanges$`, `poolState$`,
   `presence$`, `broadcasts$`, `sessionStatus$`, `initialSyncComplete$`, plus
   three currently unsubscribed streams (`executionTransitions$`,
   `commBroadcasts$`, `commChanges$` at `:309, :334, :346`).
3. **Sync store bridge (`apps/notebook/src/lib/notebook-sync-store-bridge.ts`).**
   Module-level subscriber draining each engine Observable into
   `useSyncExternalStore` stores. React reads through `useCell(id)`,
   `useCellIds()`, `useRuntimeState()`, and `useOutputsVersion()`.

The bridge is a plain TypeScript function taking an options bag and returning
`{ resetReadiness, stop }`. Keeping subscription wiring outside
`useAutomergeNotebook`'s `useEffect` lets unit tests exercise materialization
without a React renderer and eliminates RxJS cleanup races on unmount.

Neighbors:

- `docs/adr/typed-frame-v4-wire-protocol.md`: bytes arriving at `frameIn$`
  before WASM decoding.
- `docs/adr/document-split.md`: `NotebookDoc` vs `RuntimeStateDoc` vs
  `BlobMap`, and why they feed React on separate paths.
- `docs/adr/execution-pipeline.md`: the `flushSync` -> `get_heads_hex()` ->
  `required_heads` handshake this layer honors.
- `docs/adr/blob-storage-and-content-addressing.md`: manifests resolved through
  `blob-port.ts` during cell materialization.
- `docs/adr/identity-and-trust.md`: actor labels held by the WASM handle.

Three constraints shape every decision below:

1. **React never owns the CRDT.** Automerge state lives in WASM; React reads a
   derived projection. If React state and the document disagree, the document
   wins.
2. **Iframes outlive React reconciliations.** Code cells render isolated outputs
   inside iframes (`src/components/isolated/AGENTS.md`). Moving a DOM node
   reloads its iframe, destroying widget state, JS context, and user input. The
   cell list cannot reconcile in document order.
3. **Outbound writes are local-first.** Keystrokes mutate the WASM handle
   synchronously and render immediately. Flushes to the daemon are debounced, so
   operations requiring daemon visibility (execute, save, run-all) must wait for
   a flush explicitly.

Prior art that shaped this design:

- **`automerge-repo`'s `DocHandle` / `RepoContext`:** Wiring React directly via
  `useDocument` (as in [intheloop](https://github.com/runtimed/intheloop))
  funnels runtime ticks, cell edits, and presence through one re-render path.
  Independent stores avoid that contention.
- **Zustand / Jotai external-store ergonomics:** `notebook-cells.ts` exposes
  per-slice selectors like Zustand without adding a state library, because the
  WASM peer already produces typed diffs.

## Decision 1: Bridge engine streams into stores; do not bind React to Automerge

`useSyncExternalStore` does not read directly off the WASM handle for three
reasons:

- **Snapshot cost.** The WASM handle is single-threaded; `get_cells_json()`
  serializes the full document and `get_cell_outputs(cellId)` walks output
  manifests. React calls `getSnapshot` on every commit to detect torn reads, so
  direct reads turn every render into a full document walk.
- **Async side effects.** Blob resolution is async, plugin pre-warm runs on the
  side, and `outputCacheRef` mutates in place to keep manifests stable across
  structural changes. None of that belongs in `getSnapshot`.
- **Independent update cadences.** Runtime state, outputs, presence, and cell
  source change independently. One shared snapshot forces `useCell(id)` to
  compete with `useRuntimeState()`.

Work splits cleanly across three layers:

- The **engine** owns the WASM call surface and exposes typed Observables.
- The **bridge** subscribes once and fans Observables into dedicated stores.
- Each **store** (`notebook-cells.ts`, `notebook-outputs.ts`,
  `runtime-state.ts`, `project-runtime-stores.ts`, `pool-state.ts`) wraps
  `useSyncExternalStore` with its own snapshot and subscriber set.

Store boundaries follow read patterns, not write paths. `useCell(id)` re-renders
only that cell when its map entry changes. `useCellIds()` re-renders only on
structural changes (add, delete, move). `useMaterializeVersion()` and
`useOutputsVersion()` bump counters for cross-cell derived state.

Bridge subscriptions, in source order:

- `sessionStatus$` -> `setIsLoading`, `setLoadError`,
  `refreshCanAcceptCellMutations`.
- `initialSyncComplete$` -> `materializeCells(handle)` once, seed output stores,
  mark `interactiveReady`.
- `cellChanges$` -> `materializeChangeset()` via `concatMap` so slow blob
  resolution cannot be overtaken by a later incremental batch.
- `broadcasts$` / `presence$` -> `emitBroadcast` / `emitPresence` (Decision 4).
- `runtimeState$` -> `setRuntimeState`.
- `executionViewChanges$` -> `applyExecutionViewChangeset`.
- `outputIdChanges$` -> `applyOutputChangeset` (async; errors logged and
  swallowed to keep the stream alive; see [Open Follow-ups](#open-follow-ups)).
- `poolState$` -> `setPoolState`.

Teardown runs one `Subscription.unsubscribe()` after setting a `stopped` flag.
`materializeChangeset` checks `stopped` before writing; `applyOutputChangeset`
at `notebook-sync-store-bridge.ts:163` still lacks this guard (tracked in
[Open Follow-ups](#open-follow-ups)). The hook's `useEffect` cleanup also calls
`handleHost.clear()` (`useAutomergeNotebook.ts:326, :350`,
`notebook-handle-host.ts:107, :121`), freeing the WASM handle so remounts create
a fresh peer.

### Why a standalone bridge instead of an inline `useEffect`

Extracting the bridge makes it unit-testable with a fake
`SyncEngineStoreStreams`
(`apps/notebook/src/lib/__tests__/notebook-sync-store-bridge.test.ts`) and a
stub handle. It also separates React's handle lifecycle from subscription
materialization: under React StrictMode double-mount, `stop()` releases every
subscription cleanly.

### `resetReadiness` is part of the contract

`useAutomergeNotebook` calls `storeBridge.resetReadiness()` from `daemon:ready`
before clearing the cell store. Because `interactiveReady` and
`latestSessionStatus` are subscription-local state rather than React state, an
explicit method resets them cleanly when the daemon restarts a relay generation.

## Decision 2: Cell list renders in stable DOM order, visual order via CSS

In `NotebookView.tsx`:

```ts
const stableDomOrder = useMemo(() => [...cellIds].sort(), [cellIds]);
```

Cells render in sorted-ID DOM order inside a `display: flex; flex-direction: column`
container. Each `SortableCell` wrapper sets `style={{ order: index }}` from its
position in `cellIds`. React reconciles in sorted DOM order while the browser
paints in CSS `order`.

Iterating `cellIds` directly makes React call `insertBefore` on reorder. Moving
an iframe in the DOM forces a full reload, wiping its React output tree,
ipywidgets state, plugin cache, theme, and local user input. The result is a
visible white flash and lost state.

Stable DOM order keeps every cell's iframe pinned to the same DOM node for its
lifetime. Drag-and-drop animations (`dnd-kit` `transform`/`transition`), visual
repositioning, and Automerge reorders all happen in CSS without moving mounted
DOM nodes.

### Three sites enforce this invariant

The rule lives in `apps/notebook/src/AGENTS.md` and depends on three sites in
`NotebookView.tsx`: the `stableDomOrder` memo, the `order: index` style, and the
flex container. Breaking any of them reintroduces iframe reloads, and CI does
not catch that regression.

### Hidden groups and drag-and-drop compose cleanly

- **Hidden groups:** Cells whose source and outputs are hidden collapse behind
  their first member, but still mount empty wrappers with the right `order` via
  `isHiddenInGroup`. Adding a cell to a group never shifts the first cell's DOM
  slot.
- **Drag-and-drop:** `dnd-kit`'s `SortableContext` takes visual `cellIds` and
  animates via CSS `transform`/`transition`. On drop, `onMoveCell` mutates WASM,
  `cellChanges$` updates `cellIds`, and CSS `order` settles without moving any
  DOM parent.

## Decision 3: `required_heads` plus a forced flush bridges local edits and daemon reads

Keystrokes update the WASM handle synchronously, and outbound sync is debounced
by 20ms (`FLUSH_DEBOUNCE_MS`). Three operations require the daemon to observe
the latest source before acting:

- **Execute cell:** Capture current WASM heads, trigger a flush, and send those
  heads as `required_heads`. The daemon waits for them before reading source.
- **Run all:** Same `required_heads` handshake before snapshotting the cell
  batch.
- **Save / save as:** Await `flushSync()` before telling the daemon to write
  `.ipynb`.

`flushSync` on `useAutomergeNotebook` delegates to `SyncEngine.flushAndWait()`:

1. Await all in-flight debounced flushes so pending IPC completes first.
2. Flush any remaining unpushed changes.
3. Await delivery and return `boolean`.

Returning `Promise<boolean>` exposes transport drop/error without duplicating
`sessionStatus$`. Direct flush callers (dependency sync, save) check `false`
and abort with app-layer error UI. Execute and run-all rely on `required_heads`,
so the daemon fails closed on timeout if the flush never arrives.

`App.tsx` wires `NotebookClient` with
`getRequiredHeads: () => getHandle()?.get_heads_hex() ?? []` and
`flushBeforeRequiredHeadsRequest: () => getEngine()?.flush()`. See
`docs/adr/execution-pipeline.md` for the daemon wait path. The bridge owns only
inbound projection, not this outbound handshake.

## Decision 4: WASM demux on ingress; module-level pub/sub for ephemeral events

Each inbound frame arrives as one Tauri event. The engine feeds bytes to
`handle.receive_frame(bytes)`, which returns a `FrameEvent[]` covering Automerge
sync, attributions, session-control transitions, runtime state, broadcasts,
presence, and pool state.

Broadcasts (ipywidgets comm updates, button clicks) and presence (remote cursors,
selections, heartbeats) are transient events, not React store state. Most
consumers are non-React (`StateEffect`s in CodeMirror, `WidgetStore`). Routing
them through a tiny module-level pub/sub bus (`notebook-frame-bus.ts`) avoids
React reconciliation and extra Tauri event hops:

```ts
const broadcastSubscribers = new Set<BroadcastSubscriber>();
const presenceSubscribers = new Set<PresenceSubscriber>();
```

The bridge calls `emitBroadcast` and `emitPresence` synchronously on engine
events. Subscribers (widget store, cursor registry, `useCrdtBridge`'s
text-attribution listener) narrow payloads with type predicates such as
`isTextAttributionEvent`. Keeping the bus untyped lets new broadcast variants
land without changing bus wiring while keeping WASM payloads authoritative.

## Decision 5: The split cell store re-renders one cell at a time

`notebook-cells.ts` separates list order from cell records:

- `_cellIds: string[]`: ordered cell IDs driving visual layout.
- `_cellMap: Map<string, NotebookCell>`: cell data keyed by ID.

`useCellIds()` and `useCell(id)` subscribe independently:

- **Single-cell edits** call `updateCellById(cellId, ...)`, notifying only that
  cell's subscribers and bumping `_sourceVersion`. Other cells and the list do
  not re-render.
- **Structural changes** call `replaceNotebookCells(newCells)` (from
  `materializeCells` or cache-only `rematerializeCellsSync`), rebuilding both
  collections, notifying all subscribers, and bumping `_materializeVersion` and
  `_sourceVersion`.

Cross-cell features subscribe to those counters: hidden-group membership reads
`materializeVersion`, and global find reads `sourceVersion`.

`materializeChangeset` uses `planCellChangesetProjection` (from `runtimed`) to
choose `"full"` materialization or per-cell `"incremental"` updates. Output-only
updates bypass the cell store entirely, writing to `notebook-outputs.ts` for
`<OutputArea>`. An output flood in one cell never re-renders sibling cells, and
typing never triggers a structural re-layout.

## Decision 6: Output area renders through the iframe boundary

Output rendering flows through `IsolatedRendererProvider`
(`src/components/isolated/isolated-renderer-context.tsx:46`, mounted at
`apps/notebook/src/main.tsx:130`) and `IsolatedFrame`
(`src/components/isolated/isolated-frame.tsx:281, :620`).

Not every output runs in an iframe. `OutputArea`
(`src/components/cell/OutputArea.tsx:260, :268, :421`) isolates only when
`shouldIsolate` is true: stdout/stderr streams and error tracebacks render
in-page, while rich MIME outputs (images, custom MIME, Sift tables, anywidget)
use the sandboxed iframe. Decision 2 protects that iframe boundary across cell
reorders.

Bridge responsibilities at this boundary:

- Write output data into `notebook-outputs.ts`; iframes receive payloads over
  the iframe message channel rather than reading the store directly.
- Fire `preWarmForMimes` on the React side before `<OutputArea>` mounts to avoid
  renderer startup stalls.
- Register `blob-port.ts` on the WASM handle (`handle.set_blob_port(blobPort)`)
  so `get_cells_json` serializes `ContentRef`s as fetchable URLs.

Renderer plugin internals live in `src/components/isolated/AGENTS.md`.

## Decision 7: CRDT bridge writes characters into WASM and listens for attributions

`useCrdtBridge(cellId)` returns a CodeMirror extension that:

- On editor input, calls `handle.splice_source(cell_id, index, delete_count, text)`
  directly at character granularity (no Myers diff), updates the cell store via
  `updateCellById`, and triggers `onSyncNeeded` -> `engine.scheduleFlush()`.
- On remote text-attribution broadcasts (`subscribeBroadcast` filtered by
  `isTextAttributionEvent`), calls `bridge.applyRemoteChanges(...)`.

The bridge tracks the local actor label to filter self-echoes, reading it from
`daemon:ready` and falling back to `desktop:<sessionId>` (`identity-and-trust.md`
Decision 1).

Editor input is the one path that bypasses React rendering: CodeMirror's
`ViewPlugin` renders the keystroke immediately, and `onSourceChanged` updates
the cell store asynchronously afterward.

## Decision 8: Non-CRDT source state rides the same bridge pattern

Cloud viewer async sources (OIDC/app-session auth, access requests, notebook
catalog, and workstation registry/pairing) use the same three-layer pattern
instead of per-component `useEffect` lifecycles, ad-hoc `setTimeout` polls, and
manual ref mirrors (`authStateRef`, `appSessionStatusRef`):

1. **Source driver.** `createPoll`/`fetchLatest` (`packages/runtimed/src/poll.ts`)
   or an `exhaustMap` chain for heterogeneous triggers (OIDC refresh) owns
   timers, fetches, aborts, and serialization. Drivers expose
   `activate(deps) => dispose` with injected `scheduler`, `fetch`, and `now` so
   tests run on virtual time.
2. **Store and deduped projections.** `ObservableStore<T>` subclasses
   (`packages/runtimed/src/observable-store.ts`) hold a `BehaviorSubject` spine,
   a `loaded$` gate, synchronous `snapshot`, and `select(project, equals)`
   projections deduped by named comparators.
3. **React bridge.** Each store exports named domain hooks (`useCloudAuthState`,
   `useHostedCatalogAuth`, `useCloudWorkstationsRegistry`, ...) backed by one
   internal tearing-safe helper
   (`src/components/notebook/state/observable-binding.ts`). Components import
   domain hooks, never raw observables or inline `store.select(...)` calls.

The Decision 1 invariant holds verbatim: React owns no async source of truth. If
React state and the store disagree, the store wins.

### Where each idiom applies

Use RxJS wherever time, async work, or cancellation exists: polls, fetch
lifecycles, renewal timers, reconnect keys, and `AbortController` flows. Keep
the hand-rolled `Map`/`Set` pub/sub stores in `src/components/notebook/state/*`
(cells, outputs, execution) for synchronous per-entity fan-out with no
cancellation.

### Equality convention

`distinctUntilChanged` uses named field-by-field comparators
(`hostedCatalogAuthEquals`, `cloudAppSessionsEqual`, ...), never deep-equal or
JSON serialization. Each comparator pairs with a colocated
`satisfies Record<keyof T, true>` manifest so adding a field breaks compilation
until the comparator is reviewed. The manifest guarantees every key is listed,
not that every comparison is right; treat a manifest error as a review prompt.

### Why auth is a module-level `BehaviorSubject`

`cloudInstantPaintPrincipalMatcher`
(`apps/notebook-cloud/viewer/instant-paint.ts`) reads the auth principal
synchronously before React mounts to decide whether instant paint applies. A
store seeded from React state or `useEffect` would return `skipped_no_principal`
on first paint. Auth therefore lives in a module-level `BehaviorSubject` seeded
synchronously from `cloudPrototypeAuthFromWindow()` and activated once at viewer
boot (skipped on the OIDC callback route, which uses no store hooks).

### Singletons for lifetime, context for consumption

Module singletons own boot and instant paint: drivers activate them once at
viewer boot, and `instant-paint.ts` reads `authSnapshot` before React mounts.
React context provides a consumption override only, never an activation
override:

- `cloud-auth-context.ts` defaults to `cloudAuthStore`, read via
  `useCloudAuthStore()`.
- `cloud-stores-context.ts` defaults to the three non-auth store singletons
  (access requests, catalog, workstations), read via `useCloudStores()`.

Production mounts no providers, so hooks resolve straight to the singletons.
Tests, Elements fixtures, and future embedded viewers can wrap a subtree in a
provider with their own activated store instances without altering production
boot.

Boot-path discipline follows the same split: only `cloudAuthStore` evaluates in
the entry chunk. The three non-auth stores stay behind `cloud-stores-context.ts`
in lazy route chunks, keeping them out of the `/n` cold-load closure (saving
8.6 kB gzip on the shared icons chunk, from 69.4 to 60.8 kB). Workstations loads
only with the lazy `/workstations` route. Adding any store to the entry chunk
requires an instant-paint-grade reason recorded here.

### The convention layer stays small

The shared surface is intentionally limited to `ObservableStore`, `select`,
`createPoll`/`fetchLatest`, and one internal React binding. Drivers act like
redux-observable epics without a central action bus, sharding by read pattern
for the same reason Decision 1 rejected `useDocument`. If this layer ever needs
middleware, a store registry, an action bus, or a devtools protocol, adopt an
existing library (Effect, NgRx-style tooling) instead of adding a fifth
primitive.

### Placement

DOM-free primitives (`ObservableStore`, `select`, `createPoll`, `fetchLatest`)
live in `packages/runtimed`. The React binding lives in shared
`src/components/notebook/state/`. The four cloud source stores (auth,
access-request, catalog, workstations) encode cloud host policy and stay in
`apps/notebook-cloud/viewer/`; shared surfaces consume projected results, never
fetch/mutation machinery.

## Worked examples

### A. Remote peer adds a cell

1. Daemon sends a `0x00 NotebookSync` frame.
2. `frameIn$` calls `handle.receive_frame`, returning a `sync_applied` event
   with `CellChangeset` (`added: [newId]`, `order_changed: true`).
3. `cellChanges$` runs `materializeChangeset` inside `concatMap`. The plan is
   `"full"`, so `materializeCells(handle)` updates `notebook-cells.ts`.
4. `replaceNotebookCells` notifies `useCellIds()`. `NotebookView` mounts one new
   `SortableCell` in sorted DOM position while existing DOM nodes stay put. CSS
   `order` repositions cells visually, and no existing iframe reloads.

### B. Local user types in a cell

1. Editor input calls `splice_source`, mutating WASM and calling `updateCellById`
   to re-render only that cell.
2. `engine.scheduleFlush()` resets the 20ms debounce.
3. After 20ms, the engine sends a `0x00` sync frame to the daemon.
4. Daemon applies and broadcasts; the authoring user does not re-render because
   the store already has the text.

### C. User hits "execute" while still typing

1. `App.tsx` calls `notebookClient.executeCell(...)`.
2. `NotebookClient` captures `handle.get_heads_hex()` via `getRequiredHeads()`,
   then calls `flushBeforeRequiredHeadsRequest()` to push the pending debounce.
3. The daemon waits for `required_heads` before reading source, failing closed
   on timeout rather than running stale text.
4. Daemon enqueues and executes, writing `RuntimeStateDoc`. The bridge updates
   separate stores from `runtimeState$`, `executionViewChanges$`, and
   `outputIdChanges$`.

### D. Remote peer moves a cell

1. Daemon sends `NotebookSync`; WASM emits `sync_applied` with
   `order_changed: true`.
2. `materializeChangeset` runs `"full"` materialization and
   `replaceNotebookCells`.
3. `cellIds` changes, but `stableDomOrder` keeps the same sorted order. No DOM
   node moves; each `SortableCell` updates `style.order` and no iframe reloads.

### E. Bridge teardown during StrictMode remount

1. Hook unmounts; `stop()` sets `stopped = true` and unsubscribes every stream.
2. Any in-flight `materializeChangeset` checks `stopped` and exits without
   writing to stores.
3. Hook remounts with a fresh engine, bridge, subscription, and WASM peer;
   daemon resync restores all durable state.

## Open Follow-ups

- **Guard and recover `outputIdChanges$` (`notebook-sync-store-bridge.ts:163`):**
  `applyOutputChangeset` does not check `stopped` before writing after teardown,
  and logs and swallows errors (leaving an iframe on a stale manifest until the
  next sync). Add the `stopped` guard and choose structured retry or a load-error
  surface.
- **Collapse the `useLiveInputs`/render-source straddle:** Delete the two-phase
  `set(notify:false)`/`flush()` adapter in `cloud-facts-react.ts` once
  connection facts are store-backed.
- **Make the comments store single-writer:** Use `commentsProjection$` as the
  sole comments source and route optimistic re-pulls through `refreshNow()`.
- **Remove the write-only `setCells` force-update:** Delete the `setCells`
  force-update in `cloud-viewer-session.ts` once consumers subscribe to view
  stores.

## Open Questions

1. **Bridge introspection:** Expose in-flight materialization and
   output-changeset counts plus last-error diagnostics on the bridge to debug
   `cellChanges$` stalls under high churn.
2. **Non-UUID cell IDs:** `[...cellIds].sort()` assumes UUIDs stay unique and
   order-stable across membership-preserving reorders. If legacy or imported
   non-UUID IDs ever risk prefix collisions, switch to a per-mount monotonic key.
3. **React 19 concurrent `useSyncExternalStore` semantics:** Stores currently
   update synchronously from RxJS microtasks/events, never during render. If any
   subscription ever fires mid-render, defer writes via `queueMicrotask` or
   `requestAnimationFrame`.
4. **Extracting an `nteract-frontend-sync` package:** Moving the bridge out of
   `apps/notebook/src/lib/` would let `apps/notebook-cloud` and future hosts
   reuse it once `NotebookHost` in `packages/notebook-host/` stabilizes.
5. **`presence$` cardinality:** Every presence frame currently dispatches to
   every subscriber without throttling (`identity-and-trust.md` Decision 4).
   Evaluate throttling when many remote peers share one room.

## References

- `apps/notebook/src/lib/notebook-sync-store-bridge.ts`: the bridge module.
- `apps/notebook/src/lib/frame-pipeline.ts`: `materializeChangeset` and its
  planner.
- `apps/notebook/src/components/NotebookView.tsx:519`: `stableDomOrder` memo
  and Decision 2 invariant.
- `apps/notebook/src/components/NotebookView.tsx:307`: `order: index` style.
- `apps/notebook/src/hooks/useAutomergeNotebook.ts`: WASM handle owner and
  bridge caller.
- `src/components/notebook/crdt-bridge.tsx`: CodeMirror-to-CRDT React bridge.
- `src/components/notebook/crdt-editor-bridge.ts`: `splice_source` and remote
  change application.
- `src/components/notebook/state/notebook-frame-bus.ts`: module-level pub/sub
  for broadcasts and presence.
- `apps/notebook/src/lib/notebook-cells.ts`: split cell store (`useCell`,
  `useCellIds`).
- `apps/notebook/src/lib/runtime-state.ts`: runtime-state store and
  `isRuntimeStateLoaded`.
- `apps/notebook/src/lib/project-runtime-stores.ts`: execution-view projection.
- `packages/runtimed/src/sync-engine.ts`: `flushAndWait`, `scheduleFlush`, and
  all `*$` Observables.
- `apps/notebook/src/AGENTS.md`: frontend data-flow map and stable DOM-order
  rule.
