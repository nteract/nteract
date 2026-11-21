# Hosted Notebook Artifacts

**Status:** Draft, 2026-05-22.

## Context

Hosted notebook rooms serve two workflows:

1. A live room relaying typed-frame v4 sync and presence.
2. A published viewer at `/n/:notebookId` that loads without the publisher's local daemon.

A publish bundle JSON holding projected cells, executions, blobs, and render data is tempting, but it would create a second durable notebook format alongside `NotebookDoc`, `RuntimeStateDoc`, and `.ipynb`.

Shared runtime primitives give us a cleaner path:

- `NotebookDoc` persists cells, metadata, ordering, and execution pointers.
- `RuntimeStateDoc` persists executions and output manifests by execution id.
- `runtimed-wasm` loads a `NotebookDoc` + `RuntimeStateDoc` pair via `NotebookHandle.load_snapshot()` and loads optional `CommsDoc` bytes via `load_comms_doc()`.
- JS hosts share a `BlobResolver` surface, so blob references stay `{ "blob": "<sha256>" }` until the host maps them to URLs.
- The Worker uses shared typed-frame size limits and shared CBOR presence helpers instead of local protocol copies.
- Hosted output documents, renderer sidecars, and private blob reads use separate origin boundaries (see `hosted-output-origin-isolation.md`).
- The shared output renderer segments mixed output lists, not the cloud viewer (see `output-rendering-segmentation.md`).
- `runtime-state-document-identity.md` makes `RuntimeStateDoc` a first-class document identified by `NotebookDoc`, not an object nested under a notebook path.

## Decision 1: Durable publish artifacts are snapshot bundles

A published revision is durable once these artifacts exist:

- **Notebook snapshot:** saved `NotebookDoc` bytes.
- **Runtime snapshot:** saved `RuntimeStateDoc` bytes.
- **Comms snapshot:** optional saved `CommsDoc` bytes for mutable widget state.
- **Blob objects:** every content-addressed byte object reachable from the bundle. This covers `RuntimeStateDoc` execution output manifests, widget comm state and outputs, `NotebookDoc.resolved_assets`, `NotebookDoc.attachments`, and child refs inside inline manifests such as Arrow/Sift chunks.
- **Catalog row:** D1 metadata linking the artifacts to a notebook id and heads.

Each revision row records:

- `notebook_heads_hash`
- `runtime_state_doc_id`
- `runtime_heads_hash`
- `snapshot_key`
- `runtime_snapshot_key`
- `comms_heads_hash`
- `comms_snapshot_key`
- `comments_heads_hash`
- `comments_snapshot_key`
- `actor_label`
- `cell_composition` — derived CSV of cell languages for catalog filtering
- `language` — primary notebook language for catalog display
- `cover_blob_hash` — derived notebook cover image hash (first raster output embed)
- `cover_mime` — MIME type of the cover blob

Derived render JSON is not a durable artifact.

Public OG images use the latest revision's cover metadata. Pinned revisions do not override the latest OG image.

The publish API validates the snapshot bundle before writing a catalog row. It rejects the publish and leaves no revision row if any check fails:

- The `NotebookDoc` and `RuntimeStateDoc` pair fails to load.
- A recorded `CommsDoc` snapshot fails to load.
- Any projected cell, widget comm, or manifest child references a missing blob object.

## Decision 2: R2 layout is deterministic

The current hybrid compatibility layout for notebook `n/:id` is:

```text
n/{id}/snapshots/{notebookHeadsHash}.am
docs/{runtimeStateDocId}/snapshots/{runtimeHeadsHash}.am
n/{id}/blobs/{sha256}
```

Notebook snapshots keep the `n/{id}` compatibility namespace for now. Runtime-state snapshots use the first-class document namespace from `runtime-state-document-identity.md`. Publish and runtime-snapshot routes require `runtime_state_doc_id`, and each revision row records its exact `runtime_snapshot_key`. `CommsDoc` snapshots record `comms_heads_hash` and `comms_snapshot_key` separately when present.

Longer-term storage moves all document snapshots into the first-class document namespace:

```text
docs/{docId}/snapshots/{headsHash}.am
docs/{docId}/incremental/{chunkHash}
blobs/{sha256}
```

Snapshot and blob paths form the durable publish set. Incremental paths are an optional optimization following Automerge Repo's logical storage shape rather than a new file-extension convention. The host loads the snapshot bundle at publish time to verify both snapshots and blobs are complete. Legacy nested runtime snapshot keys remain readable when recorded on older revision rows.

For connected notebook pages, the live room is the primary read model. Viewers and editors render the same live `NotebookDoc` + `RuntimeStateDoc` + `CommsDoc`; permissions restrict only which frames a client may author.

## Decision 3: Materialization uses `runtimed-wasm`

Hosted viewers and room hosts materialize published revisions with:

```ts
const handle = NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes);
if (commsBytes) handle.load_comms_doc(commsBytes);
```

They then read cells through the same WASM handle APIs used on desktop. Execution-id lookup and output manifest projection stay in Rust rather than being duplicated in a Worker-local JSON format.

For pinned revisions, the browser viewer loads raw snapshot bytes, opens them through `runtimed-wasm`, and normalizes cell/runtime state into shared `ReadOnlyNotebookCellData`. It then renders through the shared React stack: `ReadOnlyNotebook` -> `ReadOnlyNotebookCell` -> `OutputArea` -> `MediaRouter` / isolated iframe. `createNteractOutputEmbed()` remains the non-React embedding contract; the cloud viewer does not fork a separate DOM renderer.

Widget comm state adds one host-specific projection step:

- During publish, the Worker validates comm `ContentRef` entries through the hosted `BlobResolver`.
- In the browser, the viewer projects comm topology from `RuntimeStateDoc` and seeds a read-only `WidgetStore`.
- `_esm` and `_css` stay URL strings for browser loading; `text_paths` refs are fetched and inlined; `buffer_paths` binary refs are installed as `DataView` instances.

This keeps widget components shared while keeping the blob authority boundary explicit in the host.

## Decision 4: Blob refs stay host-neutral

Runtime output manifests keep structured blob refs:

```json
{ "blob": "<sha256-hex>", "size": 1234 }
```

WASM never rewrites refs into daemon-local HTTP URLs. Each host provides a `BlobResolver`:

- **Desktop:** maps refs to the local daemon blob HTTP port.
- **Cloud:** maps refs to `/api/n/:id/blobs/:hash` or a future signed blob origin.

Storage and rendering stay independent of where blob bytes live.

Arrow/Sift outputs follow the same rule. `RuntimeStateDoc` stores an `application/vnd.nteract.arrow-stream-manifest+json` content ref naming chunk objects by content hash:

```json
{
  "chunks": [{ "hash": "<sha256-hex>", "size": 9352 }],
  "complete": true
}
```

The cloud materializer may include a `blob_urls` inventory for tests and debugging. Durable state remains the snapshot bundle plus blob objects, and the browser viewer still resolves chunk hashes through `BlobResolver` for the isolated Sift renderer.

## Decision 5: The cloud viewer is a static bundle, not a forked app

The Worker owns notebook identity, artifact routes, and room WebSockets. The viewer UI is a static browser bundle served from Worker assets:

```text
/assets/notebook-cloud-viewer.js
/assets/* dynamic renderer chunks
/plugins/sift_wasm.wasm
/api/plugins/sift_wasm.wasm
```

The bundle imports the shared isolated output embed API and renderer plugin virtual modules. The Worker HTML shell injects notebook config as JSON:

- catalog endpoint plus snapshot endpoints for pinned revision discovery;
- sync endpoint for the live notebook room;
- blob base path (`/api/n/:id/blobs/`);
- renderer asset base URL;
- `runtimed` WASM base URL;
- output document base URL when hosted output-origin isolation is configured.

This avoids copying desktop renderer code while keeping room hosting and artifact serving inside the Worker.

Hosted deployments serve renderer sidecars from `RENDERER_ASSETS_BASE_URL`. Worker-owned `/renderer-assets/*`, `/plugins/*`, and `/api/plugins/*` routes remain as local and prototype compatibility aliases. The dedicated renderer asset Worker binds only `dist/plugins`; it is neither a notebook API nor a blob origin.

## Decision 6: Cloud owns adaptation, shared components own rendering

The cloud renderer boundary is narrow:

- **Worker:** authenticates reads, validates snapshot bundles, serves snapshot/blob artifacts, and maps content-addressed blobs to host URLs.
- **Cloud viewer:** owns the browser shell, live-room bridge, theme selection, presence chrome, and normalization from live or pinned Automerge docs to shared cell/output props.
- **Shared renderer components:** own MIME priority, output manifest resolution, plugin installation, iframe sandboxing, scroll handoff, and output DOM.

Cloud code adapts host inputs to the shared renderer contract. Renderer plugins and shared isolated-frame code must never learn about `/api/n/:id`, Worker catalog routes, ACLs, or Cloudflare auth. Hosts pass blob URLs, renderer asset URLs, and output document URLs through `BlobResolver` and host context.

`apps/notebook-cloud` carries a cloud-owned renderer parity fixture and Playwright harness. It mounts cloud render cells through `ReadOnlyNotebook`, serves output documents and fixture blobs via local Vite middleware, and checks:

- markdown, code source, streams, errors, HTML, SVG, image, JSON, MIME fallback, and Arrow/Sift outputs;
- isolated iframe sandbox attributes and hosted output-document URL mode;
- light/dark theme propagation from cloud shell into output frames;
- zero renderer or plugin dependency on hard-coded cloud API paths.

`apps/renderer-test` remains the lower-level harness for raw iframe payloads. MCP Apps align to the same host-context contract; cloud parity work stays in `apps/notebook-cloud` unless a shared renderer API needs a documented extension.

## Decision 7: Presence stays typed-frame v4 CBOR

Cloud rooms relay frame type `0x04` as canonical nteract presence CBOR. The Worker decodes and rewrites ingress presence using shared `runtimed-wasm` helpers:

- overwrite the peer id with the server-assigned peer id;
- rewrite actor labels to the authenticated principal while preserving the operator suffix;
- reject malformed or non-CBOR presence instead of rebroadcasting a local shim.

Anonymous public viewers connect with viewer scope and send local presence. In the prototype, anonymous presence stays connection-local until product behavior for public viewer presence is decided.

## Non-Goals

- ACL semantics and public-read policy: owned by `docs/adr/hosted-room-authorization.md`.
- Running kernels in hosted rooms: runtime snapshots can come from a local daemon or a future remote runtime peer.
- Final private blob origin design: the prototype still reads `/api/n/:id/blobs/:hash`; production signed/capability URLs live in `hosted-output-origin-isolation.md`.

## Open Follow-ups

- Evaluate incremental chunk streaming or progressive loading for large pinned notebooks if loading full raw snapshot bytes before browser-side `runtimed-wasm` materialization hits bootstrap latency limits.
- Support publishing large Arrow/Sift outputs without routing all artifact bytes through a single Worker request.
- Decide whether public anonymous viewer presence should be visible to editors or remain connection-local.
