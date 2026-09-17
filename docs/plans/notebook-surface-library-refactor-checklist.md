# Notebook Surface Library Refactor Checklist

**Status:** Active checklist, 2026-06-14.

This checklist coordinates the multi-PR effort to make Desktop, Cloud, and
Elements render from stable shared notebook libraries instead of app-to-app
imports, cloud/desktop wrapper layers, or duplicated React projection state.
It is intentionally allowed to grow as new seams appear. Each PR should either
retire at least one item or add evidence explaining why the item is host-owned.

## References

- [Shared-Store Projection Convergence](../memos/shared-store-projection-convergence.md)
- [Notebook Host Shell Convergence](../adr/notebook-host-shell-convergence.md)
- [Notebook Identity and Environment Surface Audit](../audits/notebook-identity-environment-surface-audit.md)
- [Hosted Cloud Rooms](../../apps/notebook-cloud/README.md)

## North Star

Shared libraries own notebook presentation, headless projection/state stores,
output identity invariants, runtime/output projection helpers, interaction
state, capability projection types, and reusable RxJS/store mechanics.

Host adapters own real authority and side effects: Tauri/filesystem/daemon,
Cloudflare/OIDC/D1/R2/Durable Object policy, credentials, ACL mutation,
runtime-peer attachment, package trust enforcement, and launch/transport
concerns.

## Active Checklist

- [ ] Finish shared-store convergence for interaction,
      runtime/workstation status, and output cache identity. Each fact should
      have one projection owner and host-local write authority. Desktop focus
      now reads/writes the shared cell UI store directly; the outline now reads
      raster output waypoints from the execution/output stores. Remaining work
      should keep pushing cross-cell derived views toward those stores instead
      of per-host React copies.
- [ ] Extract reusable RxJS projection-store patterns only after concrete
      duplicated stores prove the shape. Avoid generic factories that hide
      simple store logic without reducing real coupling.

## Host-Owned Boundaries

- Hosted auth, OIDC refresh, ACL rows, public-link policy, invites, access
  requests, room mutation, R2/D1/Durable Object behavior, and dev-token
  transport remain cloud-owned.
- Local filesystem mutability, Tauri commands, daemon launch/readiness, local
  package trust, and local kernel lifecycle remain desktop-owned.
- Runtime peers author runtime state only. They must not become document edit,
  package, share, or credential authorities.
- RuntimeStateDoc remains authoritative for execution, queue, and output
  snapshots. Placeholder projections must release ownership when runtime-owned
  records arrive.

## Completed Slices

- 2026-06-14: Moved the frontend logger and external URL opener into
  `src/lib`. Desktop keeps compatibility re-exports, while Cloud installs its
  logger and external-link host shims directly through shared modules. Also
  drained public cell-store/change-set imports from `notebook-surface`, so the
  desktop surface barrel is smaller and restricted to the remaining
  component/materialization seam.
- 2026-06-14: Promoted runtime/output store projection to
  `src/components/notebook/state/runtime-store-projection.ts`. Desktop keeps a
  thin wrapper for blob resolver discovery, logging, and execution performance
  marks; Cloud imports execution changesets, output changesets, and runtime
  store reset directly from the shared module. Reset now invalidates in-flight
  async output projection retries so stale blob resolutions cannot repaint a
  switched or unmounted notebook.
- 2026-06-14: Cloud render resolution no longer stamps missing output IDs with
  `cloud-output:*`; missing IDs are visible invariant errors with diagnostic
  `resolution-error:missing-output-id:*` identities.
- 2026-06-14: Promoted the runtime-state React adapter from the desktop app to
  `src/components/notebook/state/runtime-state.ts`; Desktop re-exports it for
  compatibility and Cloud imports runtime reset/set/hooks from the shared state
  module directly.
- 2026-06-14: Promoted bootstrap-preservation helpers to
  `src/components/notebook/state/bootstrap-preservation.ts`; Desktop re-exports
  the old path for compatibility and Cloud imports the preservation predicate
  through the shared projection-lifecycle helper.
- 2026-06-14: Reconnected `NotebookViewModel` outline projection to the shared
  execution/output stores so raster outputs emitted through RuntimeStateDoc
  appear as outline waypoints. Code-cell view-model outputs are now store-only:
  materialized `cell.outputs` source snapshots must be projected into
  execution/output stores before they can render or appear in the outline.
- 2026-06-14: Removed the cloud-only notebook view store bridge and promoted the
  projection lifecycle into `src/components/notebook/state/projection-lifecycle.ts`.
  Cloud now calls shared projection/reset/cleanup helpers directly while keeping
  room timing and auth policy local.
- 2026-06-14: Promoted pool state, notebook controller/cell id, frame bus,
  presence value context, CRDT bridge/provider, cursor dispatch, and editor
  registry helpers into shared notebook modules. Desktop keeps compatibility
  re-export files for old app-local imports; Cloud and Elements now import the
  host-neutral helpers directly from shared notebook paths.
- 2026-06-14: Added `projectNotebookWorkstationSurface` in `packages/runtimed`
  to compose workstation selection, launch readiness, toolbar intent, busy id,
  and panel status without taking ownership of Cloud fetch/default/attach/ACL
  policy.
- 2026-06-14: Collapsed desktop focused-cell ownership onto the shared cell UI
  store. `useAutomergeNotebook` now writes focus through the shared store and
  command handlers read the current focused cell at invocation time.
