# Hosted notebook cloud

Scope: `apps/notebook-cloud/**`, including the Cloudflare Worker, Durable
Object room host, viewer bundle, smoke scripts, and cloud-specific tests.

## Current product and architecture decisions

- Hosted execution request authority is owner-only until an explicit execute
  capability exists. Do not treat `editor` access, edit mode, or a live
  `runtime_peer` as permission to spend hosted compute.
- `editor` is notebook-editing authority. It may write allowed `NotebookDoc`
  fields and mutable widget state in `CommsDoc`; it must not author runtime
  lifecycle, outputs, trust/environment/path/project metadata, ACLs, publish
  revisions, or execution intent.
- `runtime_peer` is a room-scoped compute/output writer. It can report runtime
  lifecycle, comm topology, output routing, progress/output state, and output
  blobs for room-accepted executions. It cannot edit `NotebookDoc`, mutate ACLs,
  publish revisions, or create execution intent.
- R2 snapshot bundles and D1 catalog/ACL/revision rows are the durable hosted
  source of truth. Durable Object storage may be used as a live-room recovery
  or hibernation cache, but it is not the portability boundary or published
  revision record.
- Latest live notebook pages join the room and consume the materialized live
  `NotebookDoc`/`RuntimeStateDoc`/`CommsDoc` set. Pinned revisions read
  persisted snapshot sets directly.
- Cloud live projection should share the desktop changeset path. Do not add
  new steady-state full-cell rematerialization paths when a `CellChangeset`
  can drive narrow store updates.

## Document and authority boundaries

The cloud room host materializes and validates the notebook-room documents:

| Document | Scope | Cloud write authority |
|---|---|---|
| `NotebookDoc` | notebook room | owners write all; editors write allowed cell surface only; viewers and runtime peers read |
| `RuntimeStateDoc` | notebook room | room host writes execution intent and room facts; runtime peers write policy-allowed lifecycle, progress, output, and comm topology for accepted work; viewer/editor/owner clients read only |
| `CommsDoc` | notebook room | editor/owner/runtime-peer widget-state writes gated by RuntimeStateDoc topology |
| `CommentsDoc` | notebook room sidecar | editor/owner write policy; live room host checkpoints at `CHECKPOINT_COMMENTS_DOC_KEY`, routes `FrameType.COMMENTS_DOC_SYNC` frames, and saves `comments_doc_id` to peers (commit 778fc53e); revision rows record `comments_heads_hash` and `comments_snapshot_key` for catalog recovery |
| `PoolDoc` | daemon scoped | not a notebook room document; hosted deployments should not assume it belongs in room identity |

Permission and durability boundaries are the reason for separate documents.
Rendering efficiency comes from changesets, narrow projections, and shared
stores, not from using document boundaries as a rerender workaround.

## Worker and viewer split

- `src/` owns Worker routes, auth, ACL/storage helpers, Durable Object room
  materialization, blob resolution, observability, and output/renderer asset
  Workers.
- `viewer/` owns the browser shell, live room session, cloud-specific host
  adapter, shell capabilities, dashboard/list projections, and shared notebook
  surface integration.
- Keep notebook UI behavior in shared notebook surfaces where possible. Cloud
  code should adapt host capabilities and routes, not fork cell/output/runtime
  UI semantics.
- **Wiring parity, not just component parity.** When desktop iterates on a
  shared surface (rail, outline, toolbar, cells), check that the viewer passes
  the same interaction props and hooks — a shared component rendered with a
  thinner prop set silently lacks the new behavior even though the shared code
  ships in the bundle. Optional interaction props on shared components are the
  smell; prefer shared hooks colocated with the component (see the outline
  case study in `docs/adr/notebook-host-shell-convergence.md`). Known
  intentional asymmetry: desktop does not render the workstations panel while
  remote compute matures on hosted first.
- Public viewer state must be explicit: unauthenticated users only become
  anonymous viewers when the D1 ACL has a public `viewer` row. Anonymous
  presence is local-only unless product policy changes.
- Renderer sidecars and output documents stay on separate origins/routes from
  authenticated notebook APIs. Do not serve user blobs from the renderer asset
  origin.

### Viewer async state

- The four source stores (`cloud-auth-store.ts`,
  `cloud-access-request-store.ts`, `cloud-catalog-store.ts`,
  `cloud-workstations-store.ts` in `viewer/`) extend `ObservableStore` and hold
  cloud host policy per `docs/adr/frontend-sync-bridge.md` Decision 8.
  Mechanism (`ObservableStore`/`select`/`createPoll`/`fetchLatest`) stays
  DOM-free in `packages/runtimed`; these stores stay viewer-side per the
  convergence memo's do-not-converge list.
- Components consume named domain hooks (`useCloudAuthState`,
  `useHostedCatalogAuth`, `useCloudWorkstations`, ...), never
  `store.select(...)` in a render body and never a second React binding.
- The stores are module singletons shared across surfaces, so every async
  completion - poll tick, imperative action, and any follow-up refetch - is
  captured at issue and dropped at apply against an activation epoch plus the
  auth reference; `dispose`, `reset`, and a closed gate bump the epoch.
  Comparators are named field-by-field functions with a colocated completeness
  manifest, never deep-equal or JSON. Full pattern: frontend-dev skill,
  "Module-Singleton Source Stores".

## Verification

Use the narrowest relevant command:

```bash
pnpm --dir apps/notebook-cloud typecheck
pnpm --dir apps/notebook-cloud test
pnpm --dir apps/notebook-cloud build:viewer

# Core room smoke
pnpm --dir apps/notebook-cloud smoke:hosted:live-room
pnpm --dir apps/notebook-cloud smoke:hosted:collab

# Runtime peer / workstation attach
pnpm --dir apps/notebook-cloud smoke:hosted:runtime-peer
pnpm --dir apps/notebook-cloud smoke:hosted:workstation-agent
pnpm --dir apps/notebook-cloud smoke:hosted:workstation-toolbar

# Browser-side execution
pnpm --dir apps/notebook-cloud smoke:hosted:browser-execute
pnpm --dir apps/notebook-cloud smoke:hosted:runtime-browser-execute

# Widget cross-window sync
pnpm --dir apps/notebook-cloud smoke:hosted:widget-cross-window
```

Before committing any repo change, still run the root-required formatter/lint:

```bash
cargo xtask lint --fix
```
