# Shared-Store Projection Convergence

**Status:** In progress, 2026-06-09. Follow-up to [notebook-host-shell-convergence](./notebook-host-shell-convergence.md).

## Context

PR #3514 established a pattern: transient cell chrome (queued/running) stopped
living in per-host React state and moved into a shared, projection-backed store
(`src/components/notebook/state/execution-store.ts`, the queue projection),
consumed through `useSyncExternalStore`. Both Desktop (`apps/notebook`) and Cloud
(`apps/notebook-cloud/viewer`) feed the same `src/components/notebook/state/*`
stores and render the same shared components, including the same
`apps/notebook/src/components/NotebookView.tsx` (Cloud imports it). State held
inside those shared components is therefore effectively cross-host.

The goal of this line of work: stop forcing React to hold notebook state that
belongs in a shared store, and let Desktop and Cloud share as much as they
genuinely can. The hosts differ only as *hosts* (transport, runtime, app shell);
that boundary is real and must not be over-converged.

## Convergence template

A fact belongs in a shared store when more than one host (or a shared component)
needs it and it is not a host-transport detail. The store owns the value plus a
`useSyncExternalStore` selector; writers set the value and notify. Cell UI state
uses a deferred two-phase flush for StrictMode safety (`flushCellUIState()` from
`useLayoutEffect`), so **event-time and programmatic writes must flush
synchronously** the way `NotebookView.publishInteractionTarget` does. Skipping
the flush strands the update (marked dirty, never emitted).

## Done

- **#3514** — cell queued/running chrome reads the shared execution queue
  projection instead of `setExecutingCellIds`/`setQueuedCellIds` host pushes.
- **Cloud cell focus** — `notebook-viewer.tsx` no longer holds a `focusedCellId`
  `useState` shadow. It reads `useFocusedCellId()` and routes programmatic focus
  through `setFocusedCellId` + `flushCellUIState` (the NotebookView set+flush
  pattern), dropping the host bridge double-buffer.
- **Runtime-state projections → `RuntimeStateStore`** (runtime-state RxJS
  projection pass). The runtime-state store itself moved out of the desktop app
  into `packages/runtimed/src/runtime-state-store.ts`: a BehaviorSubject-backed
  store with fluent `select()` and deduplicated projections (`kernelInfo$`,
  `queueState$`, `envSyncState$`, `workstation$`, `statusKey$`,
  `throttledStatusKey$`). The busy-flash throttle that lived as an imperative
  `setTimeout` effect in `useDaemonKernel` is now the shared, virtual-time-
  testable `throttleBusyStatus` pipeline. The React adapter now lives in
  `src/components/notebook/state/runtime-state.ts` (`useRuntimeProjection`) over
  the package store; Desktop keeps `apps/notebook/src/lib/runtime-state.ts` as a
  compatibility re-export. Item 2 below rode this.
- **Cloud access/share facts first pass.**
  `apps/notebook-cloud/viewer/cloud-access-facts.ts` now names the hosted source
  facts for catalog access, live-room connection scope, selected mode, and the
  viewer's own edit request. It projects the effective shell access scope,
  edit-request notice, request-loading predicate, edit-link fallback, and
  live-room connect policy through one tested projection and a small RxJS store.
  `apps/notebook-cloud/viewer/cloud-sharing-facts.ts` likewise projects
  owner-facing share panel facts: access ledgers, public-link state, copy labels,
  invite readiness, and initial loading state, with the same facts-store/select
  contract. `apps/notebook-cloud/viewer/cloud-facts-react.ts` adapts those
  stores to `useSyncExternalStore`, and `notebook-viewer.tsx` plus
  `sharing-controls.tsx` consume the store projections instead of recomputing
  the same policy at each render site. The authoritative facts still come from
  hosted APIs/session state and the room host.
- **Materialized NotebookView projection → shared projector.**
  `src/components/notebook/state/view-store-projection.ts` owns the common
  mechanics for projecting materialized cells into the shared cell, execution,
  and output stores: markdown projection attachment, synthetic output IDs,
  synthetic display executions, output cache-key reuse, and cleanup of
  projector-owned execution/output entries. Cloud now keeps only a thin
  `notebook-view-store-bridge.ts` adapter that applies the
  bootstrap-preservation policy. RuntimeStateDoc-owned queue/execution
  snapshots still win over snapshot placeholders.
- **Rail/outline chrome → shared `rail-ui-state` store.**
  `src/components/notebook/state/rail-ui-state.ts` now owns
  `activePanelId`, `collapsed`, and `selectedOutlineItemId` through
  `useSyncExternalStore`. Desktop (`App.tsx`) and Cloud
  (`notebook-viewer.tsx`) consume the same store while keeping host policy
  local: desktop still collapses the packages rail on a second toolbar toggle,
  and cloud still falls back to outline when the owner-only workstations panel
  is unavailable.
- **Outline raster waypoints → shared execution/output stores.**
  `NotebookViewModel` resolves each code cell's current execution pointer
  through `execution-store.ts` and reads its output manifests from
  `output-store.ts`, so raster image outputs that no longer live on
  `cell.outputs` still project into the shared outline. The output structure
  subscription now advances for raster-preview payload updates under an
  existing output id; legacy `cell.outputs` remains the no-execution fallback.

## Remaining work (ranked)

Each item removes a second source of truth. None is unit-testable for its
runtime timing; each needs a hosted/desktop browser smoke (focus, run-all,
output focus, reconnect) before merge.

1. ~~**NotebookView output-focus → shared store.**~~ **Done** in #3533. The
   `outputFocusedCellId` `useState` moved to
   `src/components/notebook/state/output-focus-store.ts` (direct-emit
   pattern; `setOutputFocusedCellId` / `clearOutputFocusedCellId` with the
   conditional-clear preserving the old functional-updater race guard). The
   dismissal policy (focus-follows-selection, Esc, click-outside,
   removed-cell cleanup) stays in `NotebookView`.

2. ~~**Cloud `workstationAttachment` → shared runtime-state store.**~~ **Done**
   in the runtime-state RxJS projection pass. The shared store is now
   `RuntimeStateStore` (`packages/runtimed/src/runtime-state-store.ts`), whose
   `workstation$` projection dedups by
   `notebookShellWorkstationAttachmentCacheKey` — the same equality the old
   `workstationAttachmentKeyRef` enforced, but shared by every subscriber.
   The session's `useState` shadow, its key ref, and all per-site clears are
   deleted; disconnect/room-change sites call `resetRuntimeState()` and the
   projection emits null through the same pipeline. Both hosts consume
   `useWorkstationAttachment()` from the shared runtime-state module.

3. ~~**Rail/outline chrome (`activeRailPanel`, `railCollapsed`,
   `selectedOutlineItemId`) → shared `rail-ui-state` store.**~~ **Done** in
   the rail-ui-state pass. The store removes the duplicated host `useState`
   declarations and keeps the shared outline selection/focus coupling in
   `useOutlineSelection`, now backed by the same external store.

4. **Finish cloud access/share projection extraction.** The first access/share
   facts pass centralizes catalog access, selected vs effective interaction
   mode, own edit-request status, edit-link fallback, live-room connect policy,
   share ledger rows, public-link state, and panel loading/copy/invite readiness.
   Remaining cloud-local second sources of truth are owner mutation refresh
   state and diagnostics fetch helpers. Keep D1/ACL/OIDC fetching, mutation, and
   URL normalization in the cloud host; stores own the projection of those facts,
   not the authority. Do not move this policy into `runtimed-wasm`: WASM should
   receive already-negotiated room/document facts, not know what an OIDC invite,
   public ACL row, or copied `?mode=edit` URL means.

5. **Cloud connection facts (`connectionScope`/`PeerId`/`ActorLabel`/`Error`).**
   Keep in the session hook. Only promote to a shared store if a *shared* component
   (not just the cloud-local capabilities deriver) needs to subscribe.

## Keep host-specific (do not converge)

- Daemon lifecycle (`daemonStatus`, reconnect, ready timeouts) — Tauri/daemon
  bootstrap with no Cloud analog.
- Environment/pool/trust (`useDependencies`, `usePoolState`, `useTrust`,
  `runtime-state.ts` Pool/RuntimeStateDoc) — Desktop has direct filesystem and
  package-manager access; Cloud delegates to remote workstations.
- OIDC/app-session/room-sync and hosted sharing source facts
  (`collaborator-auth`, `use-cloud-auth`, `cloud-viewer-session` connect/sync,
  D1 ACL rows, public-link rows, invites, and access requests) — host transport
  and product-policy boundary. Project only their *results* (scope, actor, peer
  id, effective access/share state) into stores when a shared or cloud-local
  consumer needs them.
- Presence — Cloud room peers/cursors vs Desktop Automerge presence, already
  bridged through the shared `PresenceContext`. Keep the implementations split.
- Shell-capabilities *input derivation* — `desktop-shell-capabilities.ts` vs
  `use-cloud-shell-capabilities.ts`. The shared convergence point is the
  `NotebookShellCapabilities` type they both produce; the derivation must differ.
- NotebookView display placeholders (`notebook-view-execution:<cellId>`) vs
  RuntimeStateDoc changeset projection — the placeholder path is shared, but
  runtime-authored snapshots stay authoritative and release placeholder
  ownership when they arrive.

Rejected over-converge: interaction **target** (which cell) and interaction
**mode** (view vs edit) are different concepts; do not merge Cloud's
`selectedInteractionMode` into the shared `NotebookInteractionTarget` store.
