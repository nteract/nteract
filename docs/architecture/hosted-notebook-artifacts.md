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
  with `NotebookHandle.load_snapshot()`.
- JS hosts have a shared `BlobResolver` surface, so blob references can stay as
  `{ "blob": "<sha256>" }` until the host maps them to a URL.
- The Worker can use shared typed-frame size limits and shared CBOR presence
  helpers instead of local protocol copies.

## Decision 1: Durable publish artifacts are snapshot pairs

A published revision is durable when these artifacts exist:

- Notebook snapshot: saved `NotebookDoc` bytes.
- Runtime snapshot: saved `RuntimeStateDoc` bytes.
- Blob objects: content-addressed output bytes referenced by output manifests.
- Catalog row: D1 metadata tying the above artifacts to a notebook id and heads.

The revision row records:

- `notebook_heads_hash`
- `runtime_heads_hash`
- `snapshot_key`
- `runtime_snapshot_key`
- `actor_label`

Render caches may exist, but they are derived caches. They are not the source of
truth and can be regenerated from the snapshot pair.

The publish API may materialize that cache before recording the catalog row.
This is a validation step, not a change in durability: if the `NotebookDoc` /
`RuntimeStateDoc` pair cannot load, or if any rendered output manifest points at
a missing blob object, the host rejects the publish and leaves no revision row.

## Decision 2: R2 layout is deterministic

For a notebook `n/:id`:

```text
n/{id}/snapshots/{notebookHeadsHash}.am
n/{id}/snapshots/runtime-state/{runtimeHeadsHash}.am
n/{id}/blobs/{sha256}
n/{id}/renders/{notebookHeadsHash}.json
```

The render path is derived. The first three paths are the durable publish
artifact set, but hosts can precompute the render path at publish time to prove
the snapshot pair and blob set are complete.

## Decision 3: Materialization uses runtimed-wasm

Hosted viewers and room hosts materialize published revisions by calling:

```ts
NotebookHandle.load_snapshot(notebookBytes, runtimeStateBytes)
```

Then they read cells through the same WASM handle APIs that the desktop viewer
uses. This keeps execution-id lookup and output manifest projection in the Rust
runtime document code rather than duplicating projection in a Worker-local JSON
format.

In the current prototype the Worker materializes a JSON render response on
request. The browser viewer consumes that response with the framework-agnostic
`createNteractOutputEmbed()` surface, so markdown cells, rich display data,
stdout/stderr, Plotly/Vega/Leaflet, and Sift-style table outputs go through the
same isolated renderer path as desktop instead of a Worker-local DOM renderer.

## Decision 4: Blob refs stay host-neutral

Runtime output manifests keep blob references as structured refs such as:

```json
{ "blob": "sha256-...", "size": 1234 }
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
  "chunks": [{ "hash": "sha256:...", "size": 9352 }],
  "complete": true
}
```

The cloud materializer may include a `blob_urls` inventory for these chunk
hashes so tests and debugging tools can see which hosted blob URLs are required,
but the durable state remains the snapshot pair plus blob objects. The browser
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

- render endpoint (`/api/n/:id/render` or pinned `/renders/:headsHash`);
- sync endpoint for anonymous viewer-scope presence;
- blob base path (`/api/n/:id/blobs/`).

This keeps the cloud app from copying desktop renderer code while still leaving
room host and artifact serving inside the Worker.

The `/api/plugins/*` route exists for isolated iframes whose origin is `null`.
Those iframes cannot fetch Worker Assets that are served before the Worker can
add CORS headers, so cloud blob-backed Sift outputs load the WASM binary through
the Worker-owned `/api/plugins/sift_wasm.wasm` path. Desktop keeps using the
daemon-local `/plugins/sift_wasm.wasm` route.

## Decision 6: Presence stays typed-frame v4 CBOR

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
  behavior live in `docs/architecture/hosted-room-authorization.md`.
- This ADR does not require hosted rooms to run kernels. Runtime snapshots can
  be imported from a local daemon or future remote runtime peer.
- This ADR does not define the final blob origin. `/api/n/:id/blobs/:hash` is a
  prototype origin; a separate output-blob origin with signed URLs remains open.

## Open Questions

1. Whether `/n/:id` should eventually stream materialized cells into the browser
   instead of returning one render JSON response.
2. How to publish large Arrow/Sift outputs efficiently without routing all
   artifact bytes through a single Worker request.
3. Whether public anonymous viewer presence should be visible to editors or
   remain connection-local.
