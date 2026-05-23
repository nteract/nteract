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

## Decision 2: R2 layout is deterministic

For a notebook `n/:id`:

```text
n/{id}/snapshots/{notebookHeadsHash}.am
n/{id}/snapshots/runtime-state/{runtimeHeadsHash}.am
n/{id}/blobs/{sha256}
n/{id}/renders/{notebookHeadsHash}.json
```

The render path is optional. The first three paths are the durable publish
artifact set.

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
request. The next viewer step is to move this materialized model into the real
isolated output renderer path instead of the temporary JSON/pre text renderer.

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

## Decision 5: Presence stays typed-frame v4 CBOR

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

- This ADR does not define ACL semantics; that belongs with identity and room
  authorization.
- This ADR does not require hosted rooms to run kernels. Runtime snapshots can
  be imported from a local daemon or future remote runtime peer.
- This ADR does not define the final blob origin. `/api/n/:id/blobs/:hash` is a
  prototype origin; a separate output-blob origin with signed URLs remains open.

## Open Questions

1. Whether `/n/:id` should materialize in the Worker, in the browser, or both.
2. How the isolated output renderer bundle should be packaged for the cloud
   viewer.
3. How to publish large Arrow/Sift outputs efficiently without routing all
   artifact bytes through a single Worker request.
4. Whether public anonymous viewer presence should be visible to editors or
   remain connection-local.
