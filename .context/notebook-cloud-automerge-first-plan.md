# Notebook Cloud Automerge-First Load Plan

Date: 2026-05-29

## Goal

Move notebook-cloud from a render-cache-first prototype to an Automerge-first
hosted notebook surface.

The intended steady state is:

1. Authenticate and authorize the notebook route.
2. Resolve the latest authorized `NotebookDoc` snapshot.
3. Read `NotebookDoc.runtime_state_doc_id`.
4. Resolve the matching `RuntimeStateDoc` snapshot by document id and heads.
5. Load both Automerge documents in the browser and render from that local model.
6. Open `/n/:id/sync` and converge from the loaded heads.
7. Treat `/render` as a warm-start/export cache only, never as a separate stale
   state lane.

## Current Audit After #3088

### Model state on `origin/main`

- `NotebookDoc` schema v5 carries `runtime_state_doc_id`.
- `RuntimeStateDoc` carries `runtime_state_doc_id` as self identity.
- `RuntimeStateDoc` no longer carries a notebook backlink in the schema.
- The sync wire format still has separate notebook and runtime-state streams.

### Cloud catalog and object storage

`apps/notebook-cloud/src/storage.ts` still records runtime state as revision
metadata only:

- `notebook_revisions.runtime_heads_hash`
- `notebook_revisions.runtime_snapshot_key`
- `n/{notebookId}/snapshots/{notebookHeadsHash}.am`
- `n/{notebookId}/snapshots/runtime-state/{runtimeHeadsHash}.am`
- `n/{notebookId}/renders/{notebookHeadsHash}.json`

There is no cloud `runtime_state_doc_id` column yet, and new runtime-state
snapshots are still nested under the notebook id.

### Worker publish and render routes

`apps/notebook-cloud/src/index.ts` still publishes in this order:

- `PUT /api/n/:id/runtime-snapshots/:runtimeHeadsHash`
- `PUT /api/n/:id/snapshots/:notebookHeadsHash`
- pre-materialize `renderKey(notebookId, notebookHeadsHash)`
- record the revision row with `runtime_snapshot_key`

`routeRender()` reads or materializes a JSON render cache from the snapshot pair.
That is still useful as validation and fallback, but it should stop being the
normal browser state lane.

### Durable Object room materializer

`apps/notebook-cloud/src/room-materializer.ts` loads a live room from:

1. Durable Object checkpoint bytes, or
2. latest published snapshot pair, or
3. empty room host.

Checkpoint metadata records published notebook/runtime heads, but it does not
record `runtime_state_doc_id`. It still depends on the revision's
`runtime_snapshot_key` to find the runtime document bytes.

### Browser viewer

`apps/notebook-cloud/viewer/loading-policy.ts` has two paths:

- unpinned `/n/:id` routes connect to the live room and do not fetch render JSON;
- pinned `/n/:id/r/:headsHash` routes fetch `/api/n/:id/renders/:headsHash` and
  do not connect to live sync.

The live route is closer to the desired model, but
`apps/notebook-cloud/viewer/live-sync.ts` creates an empty bootstrap
`NotebookHandle` and waits for sync. It does not yet fetch a checkpoint snapshot
pair first. That means first useful render depends on WebSocket convergence
instead of parallel object snapshot fetch plus sync catch-up.

### Publish tool

`crates/runt-publish/src/main.rs` still uploads the runtime snapshot to
`runtime-snapshots/:runtimeHeadsHash`, uploads the notebook snapshot with
`X-Runtime-Heads-Hash`, and then asserts the latest render source is
`snapshot-pair`.

It loads the notebook bytes locally to collect blob refs, so it is a natural
place to read and report `runtime_state_doc_id` once the publish API accepts it.

### Existing docs to reconcile

`docs/architecture/hosted-notebook-artifacts.md` already says published
revisions should record `runtime_state_doc_id` and that `/render` is a
warm-start cache, not the source of truth.

`docs/architecture/runtime-state-document-identity.md` still contains some
optional RuntimeStateDoc notebook-backlink language. Code after #3088 treats
the runtime state document as document-agnostic. A docs cleanup PR should remove
that remaining ambiguity before deeper cloud work lands.

## PR Slices

### PR 1: Reconcile ADR language with #3088

Scope:

- Update `docs/architecture/runtime-state-document-identity.md` so the document
  model is explicitly `NotebookDoc -> RuntimeStateDoc` with no RuntimeStateDoc
  notebook backlink.
- Keep heads in catalog/checkpoint metadata only.
- Keep object storage guidance at `docs/{docId}/snapshot/{headsHash}` and avoid
  introducing a custom delta extension.

Validation:

```bash
cargo xtask lint --fix
```

Risk:

- Low. This is docs-only, but it removes a wording trap before implementation.

### PR 2: Add runtime-state document identity to cloud catalog and publish

Scope:

- Add `runtime_state_doc_id` to `notebook_revisions`.
- Add a migration for existing D1 databases.
- Teach publish routes to accept and record `runtime_state_doc_id`.
- Teach `runt publish` to read `NotebookDoc.runtime_state_doc_id` from the
  uploaded notebook snapshot and send it with the snapshot publish.
- Keep legacy rows readable by deriving `runtime:{notebookId}` when the column
  is absent/null.

Validation:

```bash
pnpm --dir apps/notebook-cloud exec node --import tsx --test \
  test/worker-routes.test.ts \
  test/sharing-storage.test.ts
cargo test -p runt-publish
cargo xtask lint --fix
```

Risks:

- D1 migration drift in preview.
- Legacy published notebooks must remain readable without republishing.
- The cloud WASM/type layer may need a small binding if TypeScript needs to
  inspect notebook identity server-side instead of relying on `runt publish`.

### PR 3: Introduce document-id snapshot keys with compatibility fallback

Scope:

- Add key helpers:
  - `docs/{docId}/snapshot/{headsHash}`
  - `blobs/{sha256}` as the future global content-addressed path
- Write new NotebookDoc and RuntimeStateDoc snapshots to document-id keys.
- Continue writing/reading legacy `n/{notebookId}/...` keys during migration.
- Store both canonical document keys and compatibility keys in revision metadata
  as needed.
- Update GET snapshot routes so notebook authorization still flows through the
  notebook ACL even when runtime bytes are stored by `runtime_state_doc_id`.

Validation:

```bash
pnpm --dir apps/notebook-cloud exec node --import tsx --test \
  test/worker-routes.test.ts \
  test/room-materializer.test.ts \
  test/snapshot-render.test.ts
pnpm --dir apps/notebook-cloud test
cargo xtask lint --fix
```

Risks:

- Runtime-state snapshots are intentionally not independently authorized yet.
  Every runtime-state object fetch must remain notebook-authorized.
- Blob paths need an overlap period because existing output manifests and tests
  assume notebook-scoped blob routes.

### PR 4: Add an authenticated Automerge bootstrap manifest

Scope:

- Add `GET /api/n/:id/automerge-bootstrap`.
- Response includes notebook heads/key, runtime_state_doc_id, runtime heads/key,
  byte lengths/ETags where available, sync URL, blob base path, renderer asset
  base path, output document base URL, and WASM asset paths.
- The manifest is the auth/ACL gate for snapshot bootstrap.
- Return compatibility keys for legacy rows and canonical document keys for new
  rows.

Validation:

```bash
pnpm --dir apps/notebook-cloud exec node --import tsx --test \
  test/worker-routes.test.ts \
  test/authorization.test.ts \
  test/html.test.ts
cargo xtask lint --fix
```

Risks:

- Avoid presigned URL work in this slice. Worker-authenticated snapshot routes
  are enough for correctness.
- The manifest must not leak runtime snapshot URLs to users without notebook
  read access.

### PR 5: Browser snapshot-pair bootstrap before live sync

Scope:

- Teach the viewer to fetch the bootstrap manifest for latest notebook routes.
- Fetch NotebookDoc and RuntimeStateDoc snapshots in parallel.
- Load them with `NotebookHandle.load_snapshot()`.
- Render synchronously from the loaded snapshot pair as first useful paint.
- Start live sync from those heads and replace/merge UI state only after sync
  catches up.
- Keep `/render` as a fallback if snapshot bootstrap fails or for pinned/static
  revision routes.

Validation:

```bash
pnpm --dir apps/notebook-cloud exec node --import tsx --test \
  test/viewer-loading-policy.test.ts \
  test/live-sync.test.ts \
  test/render-resolution.test.ts \
  test/viewer-render-props.test.ts \
  test/viewer-shared-cell-surface.test.ts
pnpm --dir apps/notebook-cloud typecheck
pnpm --dir apps/notebook-cloud test:renderer-parity
cargo xtask lint --fix
```

Risks:

- `live-sync.ts` currently constructs an empty bootstrap handle. Replacing that
  with a loaded snapshot handle must preserve sync state initialization.
- We need to prevent stale snapshot cells from overwriting newer live cells.
- Widget comm projection and output manifest resolution need to run identically
  for snapshot-loaded and live-updated cells.

### PR 6: Live-room checkpoint publication and stale-head diagnostics

Scope:

- Add metrics/timing around:
  - shell first paint
  - manifest fetch
  - notebook/runtime snapshot fetch
  - WASM snapshot load
  - first heading paint
  - first output paint
  - WebSocket open
  - sync convergence
- Add a hosted smoke assertion that viewers see live updates after initial
  snapshot paint.
- Add room checkpoint metadata for `runtime_state_doc_id`.
- Decide whether live rooms should publish immutable R2 checkpoint pairs on idle
  debounce in this PR or the next one.

Validation:

```bash
pnpm --dir apps/notebook-cloud smoke:hosted
pnpm --dir apps/notebook-cloud smoke:hosted:live
pnpm --dir apps/notebook-cloud smoke:hosted:collab
pnpm --dir apps/notebook-cloud test
cargo xtask lint --fix
```

Risks:

- Publishing from live rooms needs blob closure guarantees before advancing the
  catalog pointer.
- Metrics should be visible in smoke output without making local tests flaky.

### PR 7: Demote `/render` from normal viewer boot

Scope:

- Keep `/api/n/:id/renders/:headsHash` for static/export/pinned compatibility.
- Remove render JSON from the normal `/n/:id` load path.
- Update `runt publish` so render materialization is validation/fallback, not the
  proof that the hosted viewer will be fast.
- Keep render cache generation as an optional server-side derived artifact.

Validation:

```bash
pnpm --dir apps/notebook-cloud exec node --import tsx --test \
  test/worker-routes.test.ts \
  test/viewer-loading-policy.test.ts \
  test/hosted-smoke-routes.test.mjs
pnpm --dir apps/notebook-cloud smoke:hosted
cargo test -p runt-publish
cargo xtask lint --fix
```

Risks:

- Existing hosted smoke scripts currently derive pinned render API URLs. They
  need to distinguish fallback/export coverage from primary viewer coverage.

## Open Questions

1. Should pinned `/n/:id/r/:headsHash` routes remain strictly static, or should
   they offer an explicit "follow live" transition after loading that pinned
   checkpoint?
2. Should `runt publish` upload canonical `docs/{docId}` keys immediately, or
   should the Worker duplicate legacy uploads into canonical keys after it has
   validated the snapshot pair?
3. Should canonical blob storage become global `blobs/{sha256}` in the same PR
   as document-id snapshots, or stay notebook-scoped until auth for direct blob
   reads is clearer?
4. What is the first hard performance budget for topic-viz? Candidate:
   first heading under 1s warm CDN, first output placeholder under 2s, first
   Sift table render under 4s.

## Suggested Initial Branch Stack

1. `docs(notebook-cloud): reconcile runtime state identity docs`
2. `feat(notebook-cloud): record runtime state document identity`
3. `feat(notebook-cloud): add automerge bootstrap manifest`
4. `perf(notebook-cloud): bootstrap viewer from automerge snapshots`
5. `test(notebook-cloud): smoke live snapshot convergence`

Each PR should use `pr-worktree-pipeline`, run `pr-reviewer`, and stay draft
until local validation, reviewer verdict, and GitHub checks are clear.
