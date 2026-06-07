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
| `RuntimeStateDoc` | notebook room | daemon/runtime-peer path writes lifecycle, queue, execution, output, env/trust/project, and comm topology for accepted work |
| `CommsDoc` | notebook room | editor/owner/runtime widget-state writes gated by RuntimeStateDoc topology |
| `CommentsDoc` | proposed notebook-room sidecar | ADR only; if implemented, keep optimistic local-first writes inside Automerge and authority-finalize policy fields |
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
- Public viewer state must be explicit: unauthenticated users only become
  anonymous viewers when the D1 ACL has a public `viewer` row. Anonymous
  presence is local-only unless product policy changes.
- Renderer sidecars and output documents stay on separate origins/routes from
  authenticated notebook APIs. Do not serve user blobs from the renderer asset
  origin.

## Verification

Use the narrowest relevant command:

```bash
pnpm --dir apps/notebook-cloud typecheck
pnpm --dir apps/notebook-cloud test
pnpm --dir apps/notebook-cloud build:viewer
pnpm --dir apps/notebook-cloud smoke:hosted:live-room
pnpm --dir apps/notebook-cloud smoke:hosted:runtime-peer
```

Before committing any repo change, still run the root-required formatter/lint:

```bash
cargo xtask lint --fix
```

## Reference ADRs

- `docs/adr/hosted-room-authorization.md`
- `docs/adr/runtime-principal-promotion.md`
- `docs/adr/live-notebook-projection-policy.md`
- `docs/adr/document-split.md`
- `docs/adr/notebook-comments-document.md`
