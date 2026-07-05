# Frontend Sync Bridge and Stable DOM Order

**Status:** Draft, 2026-05-23. Decision 8 added 2026-07-03.

## Context

The desktop notebook is a Tauri app: a Rust shell, a webview running React, and a daemon process holding the authoritative Automerge documents. Frames arrive at the webview over a Tauri IPC channel; React renders cells, outputs, presence, kernel status, and widget state. Nothing the daemon sends is in a shape React can subscribe to directly.

Between the inbound frame and the on-screen pixel sit three reinforcing layers, all in `apps/notebook/src/`:

1. **WASM peer** (`runtimed-wasm`). Owns a local `NotebookHandle` (Automerge document plus sync state). Decodes raw bytes into typed `FrameEvent`s, applies sync changes, emits a `CellChangeset` describing what changed at field granularity.
2. **`SyncEngine`** (in the shared `runtimed` TS package). Single subscriber to the WASM demux output. Owns debounced outbound flush, coalescing of inbound changesets, and a bank of RxJS Observables, one per document concern. The current set is: `cellChanges$`, `runtimeState$`, `executionViewChanges$`, `outputIdChanges$`, `poolState$`, `presence$`, `broadcasts$`, `sessionStatus$`, `initialSyncComplete$`, plus three the bridge does not (yet) subscribe to: `executionTransitions$`, `commBroadcasts$`, `commChanges$` (`packages/runtimed/src/sync-engine.ts:309, :334, :346`).
3. **Sync store bridge** (`apps/notebook/src/lib/notebook-sync-store-bridge.ts`). One module-level subscriber that drains every engine Observable and writes into a set of `useSyncExternalStore`-backed stores. From here React reads through `useCell(id)`, `useCellIds()`, `useRuntimeState()`, `useOutputsVersion()`, etc.

The bridge was extracted in commit `4baa957e` from `useAutomergeNotebook` (the hook that owns the WASM handle). Before extraction the subscription logic was inlined in a single `useEffect`, which meant unit tests had to spin up a React renderer to exercise materialization, and Rx errors surfaced as effect-cleanup races on unmount. The new shape is a plain TypeScript function whose surface is an options bag and a `{ resetReadiness, stop }` handle.

Neighbors:

- `docs/adr/typed-frame-v4-wire-protocol.md` - what arrives at `frameIn$` before WASM decodes it.
- `docs/adr/document-split.md` - `NotebookDoc` vs `RuntimeStateDoc` vs `BlobMap`, and why two of them feed the React tree on different paths.
- `docs/adr/execution-pipeline.md` - the `flushSync` -> `get_heads_hex()` -> required-heads handshake that this layer is responsible for honoring.
- `docs/adr/blob-storage-and-content-addressing.md` - manifests that resolve through `blob-port.ts` before a cell can finish materializing.
- `docs/adr/identity-and-trust.md` - actor labels live in the WASM handle the bridge subscribes to.

Three constraints shape every decision below:

1. **React must not own the CRDT.** The Automerge document lives in WASM. React subscribes to a derived projection. If React state and the document disagree, the document wins.
2. **Iframes outlive React reconciliations.** Every code cell renders its output inside an isolated iframe (see `src/components/isolated/AGENTS.md`). DOM moves trigger iframe reload, which destroys widget state, JS execution context, and any user interaction since the last sync. The cell list cannot be reconciled in document order.
3. **Outbound writes are local-first.** A keystroke mutates the WASM handle synchronously and shows in the editor that frame. The flush to the daemon is debounced. Anything that needs the daemon to have observed a change (execute, save, run-all) must wait for the flush explicitly.

Two projects shaped the design:

- **`automerge-repo`'s `DocHandle` / `RepoContext`**. The upstream pattern wires React directly to handle changes via `useDocument`. We learned from [intheloop](https://github.com/runtimed/intheloop) that this works fine for a single doc but pulls every consumer through one re-render path: a runtime-state tick competes with a cell edit competes with a presence frame. We split those into independent stores.
- **Zustand and Jotai's external-store ergonomics**. The split-store pattern in `notebook-cells.ts` is shaped to match how Zustand exposes per-slice selectors. We didn't pull in a library because the WASM peer already produces typed diffs; the store is a one-call wrapper around `useSyncExternalStore`.

## Decision 1: Bridge engine streams into stores; do not bind React to Automerge

`useSyncExternalStore` can subscribe a React tree to any external state. It is tempting to make `getSnapshot` read directly off the WASM handle. We don't, for three reasons.

First, the WASM handle is single-threaded and not cheap to call repeatedly. `get_cells_json()` serializes the whole document. `get_cell_outputs(cellId)` walks output manifests. React calls `getSnapshot` on every commit to detect torn reads. A naive binding turns every render into a full doc walk.

Second, the bridge owns side effects React cannot model. Blob resolution is async. Plugin pre-warm fires on the side. The output cache (`outputCacheRef`) is mutated in place to keep manifests stable across structural changes. None of that fits inside a `getSnapshot`.

Third, the daemon sends concerns we want to consume independently. Runtime state is one update; output projections are another; presence and broadcasts are a third. Materializing everything from one snapshot would force `useCell(id)` to compete with `useRuntimeState()` for the same React update.

So we split the work:

- The **engine** owns the WASM call surface and exposes typed Observables.
- The **bridge** is one subscriber that fans those Observables out into specific stores.
- Each **store** (`notebook-cells.ts`, `notebook-outputs.ts`, `runtime-state.ts`, `project-runtime-stores.ts`, `pool-state.ts`) is a tiny `useSyncExternalStore` wrapper with its own subscriber set and snapshot.

The store boundaries fall along read patterns, not write paths. `useCell(id)` subscribes only that cell's subscribers and re-renders only that cell when its row in the map changes. `useCellIds()` re-renders only on structural changes (add/delete/move). `useMaterializeVersion()` and `useOutputsVersion()` bump version counters for components that need to recompute cross-cell derived state.

The bridge's responsibilities, in source order:

- `sessionStatus$` -> `setIsLoading`, `setLoadError`, `refreshCanAcceptCellMutations`.
- `initialSyncComplete$` -> `materializeCells(handle)` once, then seed output stores from the handle, mark `interactiveReady`.
- `cellChanges$` -> `materializeChangeset()` (a `concatMap` keeps batches serialized, so a slow blob-resolution batch can't be overtaken by the next batch's incremental update).
- `broadcasts$` / `presence$` -> `emitBroadcast` / `emitPresence` (module-level pub/sub; cross-references Decision 4).
- `runtimeState$` -> `setRuntimeState`.
- `executionViewChanges$` -> `applyExecutionViewChangeset`.
- `outputIdChanges$` -> `applyOutputChangeset` (async; logged and swallowed on failure to keep the stream alive).
- `poolState$` -> `setPoolState`.

Cleanup is one `Subscription.unsubscribe()`. The bridge sets a `stopped` flag before tearing down. `materializeChangeset` checks it before writing to a store; `applyOutputChangeset`'s subscription does **not** check `stopped` (`notebook-sync-store-bridge.ts:163`) — FSB-1 tracks adding either the guard or a structured retry. The hook's `useEffect` cleanup also calls `handleHost.clear()` (`useAutomergeNotebook.ts:326, :350`, `notebook-handle-host.ts:107, :121`), which nulls and frees the WASM handle. A subsequent re-mount creates a fresh peer, not a reused one.

### Why not just `useEffect` in the hook

Two practical wins. The bridge is now unit-testable with a fake `SyncEngineStoreStreams` (`apps/notebook/src/lib/__tests__/notebook-sync-store-bridge.test.ts`) and a stub handle. It also disentangles "the React lifecycle that owns the WASM handle" from "the subscription topology that materializes its frames." Under React StrictMode the hook mounts twice; the bridge's `stop()` cleanly releases every subscription without needing the WASM peer to teardown and rebuild.

### `resetReadiness` is part of the contract

`useAutomergeNotebook` calls `storeBridge.resetReadiness()` from the `daemon:ready` path before clearing the cell store. The bridge's `interactiveReady` and `latestSessionStatus` are subscription-local state, not React state; they have to be cleared from outside when the daemon re-bootstraps the relay generation. Exposing this as one method on the bridge handle keeps the hook from poking at the bridge's internals.

## Decision 2: Cell list renders in stable DOM order, visual order via CSS

In `NotebookView.tsx`:

```
const stableDomOrder = useMemo(() => [...cellIds].sort(), [cellIds]);
```

Cells render in sorted-ID order. Each `SortableCell` wrapper sets `style={{ order: index }}` from its position in `cellIds`. The parent is `display: flex; flex-direction: column`. The browser paints in `order` order; React reconciles in DOM order.

Iterating `cellIds` directly would mean React reconciliation calls `insertBefore` whenever the order changes. `insertBefore` on a node that contains an iframe forces the iframe to unload and reload, because the iframe element has been moved in the DOM tree. Reload destroys: the in-iframe React tree (for the output renderer), any ipywidgets state mounted there, the plugin cache, the iframe theme, and any user input since the last frame. The visible symptom is a white flash and lost widget state.

Stable-DOM-order rendering keeps every cell's iframe pinned to the same DOM node for its lifetime. Drag-and-drop animation (dnd-kit's `transform`/`transition`), `order`-based visual repositioning, and Automerge cell reordering all flow through CSS. React's reconciler never has to move a cell node it has already mounted.

### Why this is load-bearing across the codebase

The invariant lives in `AGENTS.md` (also available through the `CLAUDE.md`
symlink). Three code sites implement it: the `stableDomOrder` memo
(`NotebookView.tsx`), the `order: index` style, and the parent flex container.
Any one of them flipping back to "iterate cellIds and let React handle order"
reintroduces the iframe reload. CI doesn't catch this; the visible failure is a
paper cut that is easy to misdiagnose as "iframes are slow."

### Hidden-group rendering composes with this

Cells whose source and outputs are both hidden collapse into a group that renders only its first member. The collapsed cells still get DOM nodes (`isHiddenInGroup` returns an empty wrapper with the right `order`), so the iframe-bearing first-member cell does not lose its slot if a later cell joins the group.

### Drag-and-drop fits in the same shape

`dnd-kit`'s `SortableContext` is built around `transform` + `transition`. We feed it `cellIds` (the visual order) and let it drive an inline transform on the picked-up cell. On drop, `onMoveCell` mutates the WASM doc; the inbound `cellChanges$` re-projects `cellIds`; CSS `order` settles into the new positions. The cell's DOM node never changes parent; dnd-kit is purely visual.

## Decision 3: `required_heads` plus a forced flush is the contract between local edits and daemon-side reads

A keystroke updates the WASM handle synchronously. The next sync to the daemon is debounced 20ms (`FLUSH_DEBOUNCE_MS`). Most of the time the debounce is invisible: by the time a user hits "execute," the source has been on the daemon for tens of milliseconds.

Three operations need the daemon to have the latest source before the daemon
acts on the request:

- **Execute cell.** The daemon reads source from the synced `NotebookDoc`. The
  client captures current WASM heads, triggers a flush, and sends those heads as
  `required_heads`; the daemon waits for them before reading source.
- **Run all.** Same handshake, applied before the daemon snapshots the cell
  list and source for the batch.
- **Save / save as.** The UI awaits `flushSync()` because the daemon writes the
  on-disk snapshot from its replica.

`flushSync` is exposed off `useAutomergeNotebook` and delegates to
`SyncEngine.flushAndWait()`:

1. Await every in-flight debounced flush. A new debounced flush can claim changes while the timer is mid-fire; awaiting them all keeps `flushAndWait` from returning before the timer's IPC actually completes.
2. Flush any remaining changes (most of the time the debounce already got them).
3. Await delivery, then return.

The function returns `boolean`, not `void`, because outbound flush is the failure surface where the transport can drop or error. Direct flush callers such as dependency sync and save check `false` and bail before issuing their dependent request. Execute and run-all use the `required_heads` path instead: the daemon fails closed if the triggered flush does not deliver the requested heads before its timeout.

The `required_heads` extension lives in `App.tsx`: `NotebookClient` is
constructed with `getRequiredHeads: () => getHandle()?.get_heads_hex() ?? []`
and `flushBeforeRequiredHeadsRequest: () => getEngine()?.flush()`.
Cross-reference `docs/adr/execution-pipeline.md` for the daemon side. The bridge
does not own this handshake; it owns the inbound projection that lets a UI read
the result.

### Why the engine returns `Promise<boolean>` and not a result type

`flushAndWait` only knows about flush success/failure. Anything richer (per-frame errors, partial commits) would imply the engine can describe sync state to callers, which is what `sessionStatus$` already does. Keeping the contract minimal here keeps the caller logic at the App layer where decisions like "show a save-failed toast" actually live.

## Decision 4: WASM demux on the way in; module-level pub/sub on the way out

Every inbound frame is one Tauri event. The hook subscribes once, the engine pipes payloads through `handle.receive_frame(bytes)`, and the WASM peer returns a `FrameEvent[]` covering all of: applied Automerge sync, attributions, session-control transitions, runtime-state changes, broadcasts, presence, pool state. The engine then fans these out into typed Observables.

Two of those concerns (broadcasts and presence) are not React state. They are *events*. A broadcast is an ipywidgets comm update or a button click. A presence frame is a remote cursor/selection or a left/heartbeat. Putting them in a store would force every consumer through React reconciliation; many of them aren't React components (cursor rendering goes through CodeMirror `StateEffect`s; widget state goes through `WidgetStore`).

So broadcasts and presence ride a tiny module-level pub/sub bus (`notebook-frame-bus.ts`):

```
const broadcastSubscribers = new Set<BroadcastSubscriber>();
const presenceSubscribers  = new Set<PresenceSubscriber>();
```

The bridge calls `emitBroadcast`/`emitPresence` on every relevant engine event. Subscribers (the widget store, the cursor registry, `useCrdtBridge`'s text-attribution listener) receive payloads inline, no event-loop hop, no Tauri round-trip. The previous shape re-emitted these as Tauri webview events; the bus replaces that hop.

The bus does not enforce types. Each subscriber narrows with a type predicate (e.g., `isTextAttributionEvent`). The cost is "another guard in each subscriber"; the benefit is that adding a new broadcast variant doesn't touch the bus, and the WASM payload remains the source of truth for what a broadcast looks like.

## Decision 5: The split cell store re-renders one cell at a time

`notebook-cells.ts` holds two pieces of state:

- `_cellIds: string[]` - ordered IDs (cellIds, which drive the visual layout).
- `_cellMap: Map<string, NotebookCell>` - cell-by-id.

`useCellIds()` and `useCell(id)` are independent subscribers. A source edit on one cell is `updateCellById(cellId, ...)`, which touches only that cell's subscriber set. The cell list and other cells do not re-render.

A structural change is `replaceNotebookCells(newCells)`, which rebuilds both `_cellIds` and `_cellMap` and notifies every subscriber. `replaceNotebookCells` runs from `materializeCells` (the full path) and `rematerializeCellsSync` (the cache-only path used after WASM mutations).

`updateCellById` notifies the per-cell subscriber set and bumps `_sourceVersion`. `replaceNotebookCells` notifies every per-cell subscriber, bumps `_materializeVersion`, and bumps `_sourceVersion`. The two version counters are read by features that need to recompute across cells: hidden-group membership reads `materializeVersion`; global find reads `sourceVersion`.

The cost of this shape is that the bridge has to know which level of granularity each engine event maps to. The `materializeChangeset` planner (`planCellChangesetProjection`, exported from `runtimed`) returns `"full"` (fall back to full materialization) or per-cell `"incremental"` plans with field flags. Output-only changes don't touch the cell store at all; outputs live in `notebook-outputs.ts` and `<OutputArea>` reads them there.

This split is the reason an output flood in one cell does not re-render every other cell, and why a single source edit doesn't trigger a structural re-layout.

## Decision 6: Output area renders through the iframe boundary

Output rendering goes through `IsolatedRendererProvider` (`src/components/isolated/isolated-renderer-context.tsx:46`, mounted at `apps/notebook/src/main.tsx:130`). The iframe itself is `IsolatedFrame` (`src/components/isolated/isolated-frame.tsx:281, :620`); the provider supplies it the renderer registry and host context. **Not every output runs in an iframe**: `OutputArea` (`src/components/cell/OutputArea.tsx:260, :268, :421`) only isolates when `shouldIsolate` is true. Stream output (stdout/stderr) and error tracebacks render in-page; rich MIME types (images, custom MIME, Sift tables, anywidget) take the sandbox path. The iframe boundary is real where it applies but not universal — Decision 2 exists in large part to keep it intact across cell reorder for the outputs that *do* use it.

What that means for the bridge:

- The bridge writes output data into `notebook-outputs.ts`. Iframes do not see this store directly; they receive output payloads via the iframe message channel.
- Plugin pre-warm fires on the React side (`preWarmForMimes`) before the iframe needs the renderer. This avoids a stall when `<OutputArea>` mounts.
- Blob resolution runs through `blob-port.ts`. The WASM handle holds a port reference (`handle.set_blob_port(blobPort)`) so `get_cells_json` can serialize ContentRefs as URLs the iframe can fetch.

Renderer plugins themselves are out of scope here. See `src/components/isolated/AGENTS.md`. The contract this ADR cares about: the bridge produces output store updates; the iframe boundary is the consumer; the cell DOM node owns the iframe and must not move.

## Decision 7: CRDT bridge writes characters into WASM and listens for attributions

`useCrdtBridge(cellId)` returns a CodeMirror extension that:

- On every editor change, calls `handle.splice_source(cell_id, index, delete_count, text)`. Character-level, no Myers diff. The same call updates the cell store via `updateCellById` and triggers a debounced sync via `onSyncNeeded` -> `engine.scheduleFlush()`.
- On every text-attribution broadcast targeting this cell, calls `bridge.applyRemoteChanges(...)`. Attributions reach the bridge through `subscribeBroadcast` (the same module bus as Decision 4), filtered by `isTextAttributionEvent`.

The bridge holds a local-actor label so it can filter self-echo attributions. The actor label is sourced from `daemon:ready` payloads and falls back to `desktop:<sessionId>` until the daemon hands one over. Cross-reference Decision 1 of `docs/adr/identity-and-trust.md` for the actor-label format.

This is the one place where editor input bypasses the React render path entirely. CodeMirror's ViewPlugin sees the change before React; the cell-store update happens after, asynchronously, via the bridge's `onSourceChanged` callback. The user sees the keystroke instantly.

## Decision 8: Non-CRDT source state rides the same bridge pattern

The first seven decisions cover Automerge-backed state: WASM peer, engine
Observables, store bridge, `useSyncExternalStore`. The cloud viewer's other
async sources - OIDC/app-session auth, access requests, the notebook catalog,
workstation registry and pairing - grew up separately as per-component
`useEffect` lifecycles: duplicated renewal timers across four views, three
hand-rolled chained-`setTimeout` polls, ref mirrors (`authStateRef`,
`appSessionStatusRef`) reconstructing snapshot reads that a store gives for
free, and stale-write guards reinvented per effect with uneven coverage.

The same three-layer shape now applies to these sources:

1. **Source driver.** A `createPoll`/`fetchLatest` pipeline
   (`packages/runtimed/src/poll.ts`), or a hand-wired `exhaustMap` chain where
   triggers are heterogeneous (OIDC refresh), owns timers, fetches, aborts,
   and serialization. Drivers live behind an `activate(deps) => dispose` call
   with injected `scheduler`/`fetch`/`now`, so tests run on virtual time and
   the browser runs on wall clock.
2. **Store + deduped projections.** An `ObservableStore<T>` subclass
   (`packages/runtimed/src/observable-store.ts`) holds one `BehaviorSubject`
   spine, a `loaded$` gate, synchronous `snapshot`, and
   `select(project, equals)` projections deduped by named field-by-field
   comparators.
3. **React bridge.** Each store exposes named domain hooks
   (`useCloudAuthState`, `useHostedCatalogAuth`, `useCloudWorkstations`, ...)
   defined next to its module-level projections. The hooks share one internal
   tearing-safe binding (`src/components/notebook/state/observable-binding.ts`,
   extracted from the runtime-state binding) but the binding is plumbing, not
   API: components import domain vocabulary, never raw observables. This
   matches the existing read surface (`useCell`, `useCellIds`,
   `useRuntimeState`) and keeps inline `store.select(...)`-per-render - which
   would defeat the binding cache - out of component bodies.

The Decision 1 invariant extends verbatim: React owns no async source of
truth. If React state and the store disagree, the store wins.

### Where each idiom applies

RxJS is the idiom wherever time, async, or cancellation is involved: polls,
fetch lifecycles, renewal timers, reconnect keys, anything holding an
`AbortController`. The hand-rolled `Map`/`Set` pub/sub stores in
`src/components/notebook/state/*` (cells, outputs, execution) stay as they
are: they fan out synchronous per-entity updates where per-subscriber
granularity is the point and no cancellation exists. That boundary is a
decision, not an accident.

### Equality convention

`distinctUntilChanged` uses named field-by-field comparators
(`hostedCatalogAuthEquals`, `cloudAppSessionsEqual`, ...), never deep-equal or
JSON. Each comparator carries a colocated
`satisfies Record<keyof T, true>` manifest so adding a field to the projection
type breaks the build until the comparator is revisited. The manifest forces
every key to be listed, not every key to be compared - treat a manifest break
as a review prompt for the comparator body, not proof of correctness.

### Why auth is a module-level BehaviorSubject

`cloudInstantPaintPrincipalMatcher`
(`apps/notebook-cloud/viewer/instant-paint.ts`) reads the auth principal
synchronously before React mounts to decide whether instant paint applies. A
store seeded from React state or a `useEffect` would return
`skipped_no_principal` on every first paint. Auth state is therefore a
module-level `BehaviorSubject` seeded synchronously from
`cloudPrototypeAuthFromWindow()`, activated once at viewer boot (skipped on
the OIDC callback route, which consumes no store hooks).

### The convention layer stays a convention layer

The generic surface is deliberately small: `ObservableStore`, `select`,
`createPoll`/`fetchLatest`, and one internal React binding. Stock RxJS
composition is the framework; these are conventions over it. Drivers are
epics in the redux-observable sense (effect streams with injected deps and
schedulers) without the action bus - stores shard by read pattern instead of
funneling through one dispatch path, for the same reason Decision 1 rejected
`useDocument`. If this layer ever wants middleware, a store registry, an
action bus, or its own devtools protocol, that is the signal to adopt an
existing system (Effect, NgRx-style tooling) rather than grow a fifth
primitive here.

### Placement

Mechanism (`ObservableStore`, `select`, `createPoll`, `fetchLatest`) is
DOM-free and lives in `packages/runtimed`. The React binding imports React and
lives in shared `src/components/notebook/state/`. The four source stores
(auth, access-request, catalog, workstations) hold cloud host policy and stay
in `apps/notebook-cloud/viewer/` per the convergence memo's do-not-converge
list: shared surfaces consume projected results, never the fetch/mutation
machinery.

### Follow-ups

- FSB-2: retrofit `RuntimeStateStore extends ObservableStore` once the four
  cloud stores have proven the base; gated by `runtime-state-store.test.ts`.
- FSB-3: collapse the `useLiveInputs`/render-source straddle when connection
  facts become store-backed, deleting the two-phase
  `set(notify:false)`/`flush()` adapter in `cloud-facts-react.ts`.
- FSB-4: comments store single-writer (`commentsProjection$` as sole source,
  optimistic re-pull through a `refreshNow()` action).
- FSB-5: remove the write-only `setCells` force-update in
  `cloud-viewer-session.ts` once consumers subscribe to view stores.

## Worked examples

### A. Remote peer adds a cell

1. Daemon sends a `0x00 NotebookSync` frame.
2. Engine's `frameIn$` pipes it to `handle.receive_frame`. WASM returns a `FrameEvent[]` containing a `sync_applied` with a `CellChangeset` (`added: [newId]`, `order_changed: true`).
3. Engine emits on `cellChanges$`. Bridge's `concatMap` calls `materializeChangeset`. The plan is `"full"` (structural change) so `materializeCells(handle)` runs: serialize doc, resolve manifests, write to `notebook-cells.ts`.
4. `replaceNotebookCells` notifies `useCellIds()` subscribers. `NotebookView` re-renders with a new cellIds array. `stableDomOrder = [...cellIds].sort()` adds the new ID in sort position; React mounts a new `SortableCell` node for it. Existing cells' DOM nodes are untouched. `order` recalculates and CSS repositions visually.
5. No existing iframe reloads.

### B. Local user types in a cell

1. Editor input -> `splice_source` -> WASM doc updated -> `updateCellById` -> the cell's subscriber re-renders.
2. `engine.scheduleFlush()` resets a 20ms debounce.
3. After 20ms, debounce fires, engine generates an Automerge sync message and sends it as a `0x00` frame.
4. Daemon applies and broadcasts. The same user sees no further re-render (text was already in their store).

### C. User hits "execute" while still typing

1. UI dispatches execute. App.tsx calls `notebookClient.executeCell(...)`
   directly.
2. `NotebookClient` reads `handle.get_heads_hex()` through
   `getRequiredHeads()`, then calls `flushBeforeRequiredHeadsRequest()` to force
   the pending debounce to move.
3. The request carries those heads as `required_heads`. Daemon will not start
   execution until its replica observes them; if the flush does not arrive in
   time, the request fails closed on the daemon timeout instead of reading stale
   source.
4. Daemon enqueues, executes, writes outputs and execution state to
   `RuntimeStateDoc`. Frontend's bridge picks up `runtimeState$`,
   `executionViewChanges$`, and `outputIdChanges$` separately; each updates its
   own store.

### D. Remote peer moves a cell

1. Daemon sends `NotebookSync`. WASM returns `sync_applied` with `order_changed: true`.
2. `materializeChangeset` plan is `"full"`. `replaceNotebookCells` runs.
3. `cellIds` array changes. `stableDomOrder` is the same set, sorted; the sort key didn't change for any ID. The DOM children list does not reorder.
4. Each `SortableCell` recomputes `style.order` from its new index in `cellIds`. CSS repositions visually. No iframe moves in the DOM tree, so no iframe reloads.

### E. Bridge teardown during StrictMode rehearsal

1. Hook unmounts. Bridge's `stop()` runs: `stopped = true`, `subscription.unsubscribe()` releases every engine subscription.
2. An async `materializeChangeset` in flight checks `stopped` before writing to stores. It returns without touching state.
3. Hook remounts. New engine, new bridge, fresh subscription, fresh WASM peer.
   Durable state comes back from daemon resync, so no notebook state is lost.

## Open Questions

1. **Bridge introspection.** Stores publish version counters but the bridge itself doesn't expose how many in-flight materializations or output-changeset applies are pending. Adding bridge-level diagnostics (count, last-error) would help debug `cellChanges$` stalls under high-churn. Open follow-up; no owner yet.

2. **`outputIdChanges$` error handling.** Failed `applyOutputChangeset` is logged at warn and swallowed. A partially-applied output projection can leave the cell's iframe rendering a stale manifest until the next change. Open: do we retry, raise a load-error banner, or accept the inconsistency until the next sync?

3. **Sort order of cell IDs.** `[...cellIds].sort()` is a string sort over UUIDs. It is stable enough for Decision 2 to work, but cell IDs that are *not* UUIDs (legacy notebooks, imports) could in principle collide on a sort prefix. The invariant required is "the order is stable across `cellIds` changes that preserve set membership," which UUIDs satisfy. A future change to allow non-UUID cell IDs would need to switch to a content-derived stable key (e.g., a per-mount monotonic counter).

4. **React 19 `useSyncExternalStore` semantics under concurrent rendering.** Stores are written from RxJS subscriptions (synchronous). React may tear if a subscriber writes during render; in practice we don't, because the bridge fires from microtasks/events, not render. If we ever surface a subscription that could fire mid-render, we'd need to defer to `queueMicrotask` or `requestAnimationFrame`.

5. **Bridge as an `nteract-frontend-sync` package.** The current location (`apps/notebook/src/lib/`) couples the bridge to app stores. Extracting it would let `apps/notebook-cloud` and any future host reuse the wiring. Out of scope here; depends on the `NotebookHost` boundary in `packages/notebook-host/`.

6. **`presence$` cardinality.** The bridge dispatches every presence frame to every subscriber. With many remote peers and high heartbeat frequency, this could become a hot path. No throttling today; cross-reference Decision 4 of `docs/adr/identity-and-trust.md` for the heartbeat shape.

## References

- `apps/notebook/src/lib/notebook-sync-store-bridge.ts` - the bridge module.
- `apps/notebook/src/lib/frame-pipeline.ts` - `materializeChangeset` and its planner.
- `apps/notebook/src/components/NotebookView.tsx:519` - `stableDomOrder` memo and Decision 2 invariant.
- `apps/notebook/src/components/NotebookView.tsx:307` - `order: index` style.
- `apps/notebook/src/hooks/useAutomergeNotebook.ts` - WASM handle owner and bridge caller.
- `src/components/notebook/crdt-bridge.tsx` - CodeMirror -> CRDT React bridge.
- `src/components/notebook/crdt-editor-bridge.ts` - `splice_source` + remote-change application.
- `src/components/notebook/state/notebook-frame-bus.ts` - module-level pub/sub for broadcasts and presence.
- `apps/notebook/src/lib/notebook-cells.ts` - split cell store (`useCell`, `useCellIds`).
- `apps/notebook/src/lib/runtime-state.ts` - runtime-state store and `isRuntimeStateLoaded`.
- `apps/notebook/src/lib/project-runtime-stores.ts` - execution-view projection.
- `packages/runtimed/src/sync-engine.ts` - the engine: `flushAndWait`, `scheduleFlush`, every `*$` Observable.
- `apps/notebook/src/AGENTS.md` - companion frontend-architecture map (data-flow diagram).
- `AGENTS.md` / `CLAUDE.md` - "Cell list uses stable DOM order" load-bearing invariant.
