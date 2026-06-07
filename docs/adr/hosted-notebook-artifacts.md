# Hosted Notebook Artifacts

**Status:** Draft, 2026-05-22.

## Context

Hosted notebook rooms need to serve two related workflows:

1. A live room that relays typed-frame v4 sync and presence.
2. A published viewer at `/n/:notebookId` that can load without the publisher's local daemon.

The tempting shortcut is a publish bundle JSON that contains projected cells,
executions, blobs, and output render data. That would create a second durable
notebook format next to `NotebookDoc`, `RuntimeStateDoc`, and `.ipynb`.

The shared runtime work now gives us a cleaner path:

- `NotebookDoc` persists cells, metadata, ordering, and execution pointers.
- `RuntimeStateDoc` persists executions and output manifests by execution id.
- `runtimed-wasm` can load a persisted `NotebookDoc` + `RuntimeStateDoc` pair
  with `NotebookHandle.load_snapshot()` and then load saved `CommsDoc` bytes
  with `load_comms_doc()`.
- JS hosts have a shared `BlobResolver` surface, so blob references can stay as
  `{ "blob": "<sha256>" }` until the host maps them to a URL.
- The Worker can use shared typed-frame size limits and shared CBOR presence
  helpers instead of local protocol copies.
- Hosted output documents, renderer sidecars, and private blob reads have
  separate origin boundaries; see `hosted-output-origin-isolation.md`.
- Mixed output lists are segmented by the shared output renderer, not by the
  cloud viewer; see `output-rendering-segmentation.md`.
- `runtime-state-document-identity.md` makes the `RuntimeStateDoc` a
  first-class document identified from `NotebookDoc`, rather than only an
  object nested under a notebook artifact path.

## Decision 1: Durable publish artifacts are snapshot bundles

A published revision is durable when these artifacts exist:

- Notebook snapshot: saved `NotebookDoc` bytes.
- Runtime snapshot: saved `RuntimeStateDoc` bytes.
- Comms snapshot: optional saved `CommsDoc` bytes for mutable widget state.
- Blob objects: every content-addressed byte object reachable from the
  snapshot bundle. This includes `RuntimeStateDoc` execution output manifests,
  widget comm state and comm outputs, `NotebookDoc.resolved_assets`,
  `NotebookDoc.attachments`, and child refs named by inline manifests such as
  Arrow/Sift chunks.
- Catalog row: D1 metadata tying the above artifacts to a notebook id and heads.

The revision row records:

- `notebook_heads_hash`
- `runtime_state_doc_id`
- `runtime_heads_hash`
- `snapshot_key`
- `runtime_snapshot_key`
- `comms_snapshot_key`
- `actor_label`

Derived render JSON is not a durable artifact. The publish API validates the
snapshot bundle before recording the catalog row: if the `NotebookDoc` /
`RuntimeStateDoc` pair cannot load, if a recorded `CommsDoc` snapshot cannot
load, or if any projected cell, widget comm, or manifest child points at a
missing blob object, the host rejects the publish and leaves no revision row.

## Decision 2: R2 layout is deterministic

The current hybrid compatibility layout for a notebook `n/:id` is:

```text
n/{id}/snapshots/{notebookHeadsHash}.am
docs/{runtimeStateDocId}/snapshots/{runtimeHeadsHash}.am
n/{id}/blobs/{sha256}
```

Notebook snapshots retain the `n/{id}` compatibility namespace for now.
Runtime-state snapshots already use the first-class document namespace from
`runtime-state-document-identity.md`; publish and runtime-snapshot routes
require `runtime_state_doc_id`, and the revision row records the exact
`runtime_snapshot_key`. `CommsDoc` snapshots are recorded separately through
`comms_snapshot_key` when present.

Longer-term storage work should move all document snapshots toward the
first-class document namespace:

```text
docs/{docId}/snapshots/{headsHash}.am
docs/{docId}/incremental/{chunkHash}
blobs/{sha256}
```

Snapshot paths and blob paths are the durable publish artifact set; incremental
paths are an optional future optimization that should follow Automerge Repo's
logical storage shape rather than introduce a new file-extension convention. The
host can load the snapshot bundle at publish time to prove the document
snapshots and blob set are complete. Legacy nested runtime snapshot keys remain readable when
they are recorded on older revision rows.

For connected notebook pages, the live room is the primary read model. Viewers
and editors render the same live `NotebookDoc` + `RuntimeStateDoc` + `CommsDoc`;
permission differences only change which frames the client may author.

## Decision 3: Materialization uses runtimed-wasm

Hosted viewers and room hosts materialize published revisions by calling:

```ts
const handle = NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
if (commsBytes) handle.load_comms_doc(commsBytes);
```

Then they read cells through the same WASM handle APIs that the desktop viewer
uses. This keeps execution-id lookup and output manifest projection in the Rust
runtime document code rather than duplicating projection in a Worker-local JSON
format.

The browser viewer loads raw snapshot bytes for pinned revisions, opens them
through `runtimed-wasm`, normalizes the resulting cell/runtime state into shared
`ReadOnlyNotebookCellData`, then renders through the same React notebook output
stack as desktop: `ReadOnlyNotebook` → `ReadOnlyNotebookCell` → `OutputArea` →
`MediaRouter` / isolated iframe. The framework-agnostic
`createNteractOutputEmbed()` surface remains the non-React embedding contract,
but the cloud notebook viewer itself should not fork a separate DOM renderer.

Widget comm state has one additional host-specific projection step. The Worker
validates comm `ContentRef`s through the hosted `BlobResolver` during publish.
The viewer projects comm topology from `RuntimeStateDoc` and seeds a read-only
`WidgetStore`: `_esm` / `_css` stay URL strings for browser loading, text refs
listed in `text_paths` are fetched and inlined by the viewer, and binary refs
listed in `buffer_paths` are installed as `DataView`s. This keeps the rendered
widget components shared while making the blob authority boundary explicit in
the host.

## Decision 4: Blob refs stay host-neutral

Runtime output manifests keep blob references as structured refs such as:

```json
{ "blob": "<sha256-hex>", "size": 1234 }
```

WASM does not rewrite these into daemon-local HTTP URLs. The host provides a
`BlobResolver`:

- Desktop resolver: maps refs to the local daemon blob HTTP port.
- Cloud resolver: maps refs to `/api/n/:id/blobs/:hash` or a future signed blob
  origin.

This keeps the storage and rendering model independent of where the blob bytes
live.

Arrow/Sift outputs follow the same rule. The `RuntimeStateDoc` output stores an
`application/vnd.nteract.arrow-stream-manifest+json` content ref. That manifest
names chunk objects by content hash:

```json
{
  "chunks": [{ "hash": "<sha256-hex>", "size": 9352 }],
  "complete": true
}
```

The cloud materializer may include a `blob_urls` inventory for these chunk
hashes so tests and debugging tools can see which hosted blob URLs are required,
but the durable state remains the snapshot bundle plus blob objects. The browser
viewer still resolves chunk hashes through the shared `BlobResolver` when the
isolated Sift renderer consumes the output.

## Decision 5: The cloud viewer is a static bundle, not a forked app

The Worker still owns notebook identity, artifact routes, and room WebSockets.
The viewer UI is a static browser bundle served from Worker assets:

```text
/assets/notebook-cloud-viewer.js
/assets/* dynamic renderer chunks
/plugins/sift_wasm.wasm
/api/plugins/sift_wasm.wasm
```

The bundle imports the shared isolated output embed API and the existing
renderer plugin virtual modules. It receives notebook-specific configuration
from the Worker HTML shell as JSON:

- catalog endpoint plus snapshot endpoints for pinned revision discovery;
- sync endpoint for the live notebook room;
- blob base path (`/api/n/:id/blobs/`);
- renderer asset base URL;
- runtimed WASM base URL;
- output document base URL when hosted output-origin isolation is configured.

This keeps the cloud app from copying desktop renderer code while still leaving
room host and artifact serving inside the Worker.

Renderer sidecars are served from `RENDERER_ASSETS_BASE_URL` in hosted
deployments, with Worker-owned `/renderer-assets/*`, `/plugins/*`, and
`/api/plugins/*` aliases kept as local/prototype compatibility routes. The
dedicated renderer asset Worker binds only `dist/plugins`; it is not a notebook
API or blob origin.

## Decision 6: Cloud owns adaptation, shared components own rendering

The cloud renderer boundary is intentionally narrow:

- Worker: authenticate reads, validate snapshot bundles, serve snapshot/blob
  artifacts, and map content-addressed blobs to host URLs.
- Cloud viewer: own the browser shell, live-room bridge, theme selection,
  presence chrome, and normalization from live or pinned Automerge documents to
  shared cell/output props.
- Shared renderer components: own MIME priority, output manifest resolution,
  plugin installation, iframe sandboxing, scroll handoff, and output DOM.

Cloud code may adapt host-specific inputs into the shared renderer contract, but
it must not teach renderer plugins or shared isolated-frame code about
`/api/n/:id`, Worker catalog routes, ACLs, or Cloudflare-specific auth. Blob
URLs, renderer asset URLs, and output document URLs are host configuration
passed through `BlobResolver` and host context.

The notebook-cloud app carries a cloud-owned renderer parity fixture and
Playwright harness. That harness mounts semantic cloud render cells through the
same `ReadOnlyNotebook` path as the deployed viewer, serves output documents and
fixture blobs from local Vite middleware, and checks:

- markdown, code source, streams, errors, HTML, SVG, image, JSON, MIME fallback,
  and Arrow/Sift outputs;
- isolated iframe sandbox attributes and hosted output-document URL mode;
- light/dark theme propagation from cloud shell into output frames;
- no renderer/plugin dependency on hard-coded cloud API paths.

`apps/renderer-test` remains the lower-level isolated-renderer harness for raw
iframe payloads. MCP Apps should align to the same host-context contract, but
cloud renderer parity work should stay in `apps/notebook-cloud` unless a shared
renderer API needs a small, documented extension.

## Decision 7: Presence stays typed-frame v4 CBOR

Cloud rooms relay frame type `0x04` as canonical nteract presence CBOR. The
Worker decodes and rewrites ingress presence with shared `runtimed-wasm`
helpers:

- overwrite the peer id with the server-assigned peer id,
- rewrite actor labels to the authenticated principal while preserving the
  operator suffix,
- reject malformed/non-CBOR presence instead of rebroadcasting a local shim.

Anonymous public viewers can connect with viewer scope and send local presence,
but the prototype keeps anonymous presence connection-local until the product
decision for public viewer presence is settled.

## Non-Goals

- This ADR does not define ACL semantics; hosted ACL shape and public-read
  behavior live in `docs/adr/hosted-room-authorization.md`.
- This ADR does not require hosted rooms to run kernels. Runtime snapshots can
  be imported from a local daemon or future remote runtime peer.
- This ADR does not define the final private blob origin. The prototype still
  reads `/api/n/:id/blobs/:hash`; the production signed/capability URL direction
  lives in `hosted-output-origin-isolation.md`.

## Open Questions

1. Whether `/n/:id` should eventually stream materialized cells into the browser
   instead of returning one render JSON response.
2. How to publish large Arrow/Sift outputs efficiently without routing all
   artifact bytes through a single Worker request.
3. Whether public anonymous viewer presence should be visible to editors or
   remain connection-local.
