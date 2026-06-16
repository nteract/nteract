# Runtime Peer Contract and Blob Authority Audit

**Status:** Audit, updated 2026-06-16.

## Context

This audit follows `../adr/deployment-topology.md`, which makes Cloudflare the
hosted room/document host and JupyterHub compute an outbound `runtime_peer`
attachment. Two contracts need to stay sharp as implementation moves from the
single-user daemon toward hosted rooms:

1. `runtime_peer` is a room authorization role, not the local `RuntimeAgent`
   socket protocol.
2. `PutBlob` is a byte-transfer primitive, not authority to mutate notebook or
   runtime state.

Neighbors:

- `../adr/identity-and-trust.md` defines scopes and per-frame actor validation.
- `../adr/hosted-room-authorization.md` defines ACL-derived room scope.
- `../adr/deployment-topology.md` defines hosted and daemon-mediated runtime
  topologies.
- `../adr/typed-frame-v4-wire-protocol.md` defines the `RuntimeAgent` channel and
  `PutBlob` frame.
- `../adr/blob-storage-and-content-addressing.md` defines content addressing,
  multipart upload, durability, and resolver boundaries.

## Audit 1: Runtime peer contract

### Contract

| Term | Boundary | Allowed surface | Not allowed |
|------|----------|-----------------|-------------|
| `runtime_peer` | Room connection authenticated by the room host and authorized by the room ACL | Write runtime progress/output state for room-accepted executions, upload blobs referenced by runtime/output state, emit runtime lifecycle events, receive room sync needed to execute requested work | Create execution intent, edit `NotebookDoc`, mutate ACLs, publish revisions, host the room, or imply where the kernel process lives |
| `RuntimeAgent` | Local daemon implementation detail reached through the `RuntimeAgent` handshake | Supervise a kernel near the daemon that spawned it, receive daemon RPCs, and sync local `RuntimeStateDoc` changes | Serve as a cross-machine API boundary or product role |
| JupyterHub runtime sidecar/service | Hub-authenticated compute adapter | Open an outbound room WebSocket requesting `runtime_peer`; start or reach a kernel using Hub-local authority | Become document authority for Anaconda-hosted rooms |
| Remote daemon as runtime peer | Future daemon-mediated / SSH topology | Attach to a room or bridge as `runtime_peer`; run its own local `RuntimeAgent` beside the kernel | Expose the `RuntimeAgent` socket directly across machines |

The hosted v1 topology should therefore use this shape:

```text
browser/desktop/agent -> Cloudflare DO room host <- JupyterHub runtime_peer sidecar
```

Future daemon-mediated compute should preserve a daemon or room-host boundary:

```text
local client/daemon -> room host or bridge <-> remote daemon(runtime_peer)
  -> runtime agent local to remote daemon -> kernel
```

### Current implementation evidence

- `nteract_identity::ConnectionScope::RuntimePeer` allows runtime-state writes
  and rejects notebook writes through `allows_notebook_write()` /
  `allows_runtime_state_write()`.
- The normal notebook peer loop checks those helpers before applying
  `AutomergeSync` (`NotebookDoc`) or `RuntimeStateSync` frames.
- The local `RuntimeAgent` handler is a separate trusted local channel. It
  performs initial `NotebookDoc` and `RuntimeStateDoc` sync, forwards daemon
  RPCs over request/response frames, and applies runtime-agent
  `RuntimeStateDoc` changes. That is appropriate for the local daemon because
  provenance is the daemon-spawned runtime agent id, not hosted-room ACL scope.
- The wire protocol still reuses `Request` / `Response` type bytes for
  `NotebookSync` and `RuntimeAgent`, with the handshake variant selecting the
  envelope shape. That is workable locally but fragile as a cross-machine
  boundary.
- The hosted dispatch contract is now implemented in `runtimed-wasm`:
  owner-scoped `REQUEST` frames are validated by the room host, become queued
  executions with coordinator-owned provenance in `RuntimeStateDoc`
  (`receive_request`), and the runtime peer consumes them through normal
  `RuntimeStateDoc` sync while the shared policy rejects runtime-peer-forged
  execution intent. Active-target selection and disconnect/liveness gating
  remain open in `../adr/remote-workstation-doc-agents.md`.

### Findings

1. **The naming is now correct in ADRs, but implementation seams still invite
   confusion.** Hosted runtime sidecars should connect as room peers with
   `runtime_peer` scope. They should not use the `RuntimeAgent` handshake
   unless they are connecting to a daemon that owns the local kernel.
2. **The `RuntimeAgent` channel is not a hosted protocol.** It is optimized for
   a daemon-spawned subprocess and trusts daemon provenance checks. Making it
   remote would require a separate design for credential extraction, frame
   scope, request authorization, and misrouted envelope detection.
3. **Execution requests need a hosted dispatch contract.** In hosted rooms,
   browser/editor requests should target the active runtime peer through
   room-scoped request handling or `RuntimeStateDoc` transitions. They should
   not reach around the room host to a runtime-agent socket.

### Current follow-ups

- Keep `RuntimeAgent` documentation explicitly local-daemon scoped.
- Treat `runtime_peer` sidecars as normal authenticated room connections.
- Request variants are owner-only today and route through the
  `RuntimeStateDoc` queue. The remaining dispatch work is active-target
  selection and liveness gating (see `../adr/remote-workstation-doc-agents.md`).
- Do not expose the `RuntimeAgent` handshake as a cross-machine API without a
  new protocol decision.

## Audit 2: Blob authority contract

### Contract

`PutBlob` transfers bytes into the blob store and returns a content-addressed
hash. It does not authorize a document mutation, runtime mutation, publication,
or read. Authority comes from the connection scope plus the later reference
that tries to make the blob reachable from room state.

| Scope | Upload authority | Reference authority | Read authority |
|-------|------------------|---------------------|----------------|
| `viewer` | None | None | May resolve blobs already referenced by room state if the room host authorizes viewer access to that room |
| `editor` | Blobs needed for allowed `NotebookDoc` edits and allowed mutable widget state in `CommsDoc` | May reference uploads from allowed notebook fields, attachments, resolved assets, and permitted `CommsDoc` writes | Same as viewer, plus any private editor-visible room blobs |
| `runtime_peer` | Runtime output, execution-progress, lifecycle, and comm-output blobs | May reference uploads from allowed `RuntimeStateDoc` output/lifecycle paths for accepted executions | Same as viewer for the attached room |
| `owner` | Editor upload surface; runtime-peer upload surface only through an explicit runtime-peer connection | Editor reference surfaces, plus publish/export flows | Same as editor, plus owner-only artifact management |

The `PutBlobHeader.purpose` field is a hint for routing, metrics, retention, or
debugging. It is not an authorization decision. A malicious peer can choose any
purpose string, so the room host must authorize by connection scope and by the
document path that later references the content hash.

### Current implementation evidence

- The local daemon stores blobs by SHA-256 and verifies size/hash before
  publishing bytes. Multipart upload validates part hashes and the final hash.
- `PutBlob` uses the typed-frame path while multipart session control uses
  `NotebookRequest::{CreateBlobUpload, CompleteBlobUpload, AbortBlobUpload}`.
- Hosted rooms now enforce the upload gate: `allowsBlobUpload` permits only
  `runtime_peer` and `owner`, checked at both the `PUT_BLOB` frame prefilter
  and the HTTP upload route. Editor uploads stay denied until reference-path
  validation ships with them (staged policy recorded in
  `../adr/hosted-room-authorization.md` Decision 3).
- The local daemon now gates both one-shot `PutBlob` frames and multipart blob
  upload requests before they reach storage. The local gate denies viewers and
  permits local editor/runtime-peer uploads because same-UID editor peers still
  need document-scoped attachments, while runtime peers upload output blobs.
  This intentionally differs from hosted rooms until hosted editor uploads ship
  with reference-path validation.
- Hosted publish now validates reachability: a snapshot revision is rejected
  with `424 missing_blobs` when any materialized render ref is missing from
  the destination blob store, before any D1 revision row is recorded.
- Blob reads are unauthenticated on the local loopback HTTP origin and rely on
  same-machine isolation plus hash unguessability; that surface is now
  declared permanently single-user (`../adr/blob-storage-and-content-addressing.md`
  open question 3). Hosted reads ride the viewer-authorized
  `/api/n/:id/blobs/:hash` route; private sharing still needs the capability
  mechanism tracked as HCA-6.

### Findings

1. **Upload and reference are separate authorization gates.** A scoped peer may
   be allowed to upload bytes but still forbidden to reference them from a
   particular document path. The decisive check is the later `NotebookDoc`,
   `RuntimeStateDoc`, or `CommsDoc` mutation, not the blob frame alone.
2. **Upload entry points need explicit gates.** `viewer` must not be able to
   send `PutBlob` or multipart upload requests. Local daemon and hosted room
   gates now both reject viewer uploads, while hosted rooms deliberately keep
   the stricter `runtime_peer`/`owner` upload surface until editor
   reference-path validation exists.
3. **Hosted rooms need reference-path validation.** `runtime_peer` can point at
   uploaded blobs only from runtime/output state. `editor` can point at blobs
   only from notebook fields and mutable widget state in `CommsDoc`. Owner
   inherits both write surfaces.
4. **Content metadata mutation is multi-user sensitive.** The desktop blob
   store intentionally lets a duplicate put update `media_type`. In hosted or
   remote-peer deployments, the host should prevent a lower-scope peer from
   rewriting how an existing hash is served to other rooms/users. Either make
   metadata first-writer-wins per backend object, or move media type to the
   room/reference layer.
5. **Blob reads must be room-scoped in hosted deployments.** "Knows the hash"
   is not enough once blobs leave single-user loopback. The resolver should
   prove viewer-or-better access to the room or issue a short-lived signed URL
   with equivalent authority.

### Current follow-ups

- Keep the shared runtime document write policy in the hosted room host and
  daemon paths. `RuntimeStateDoc` remains runtime-peer writable for lifecycle,
  execution progress, output, and comm topology state. Mutable widget state
  writes belong in `CommsDoc`, where editor/owner authority can be scoped to
  existing widget comm state. Execution intent creation still belongs to the
  room-host request path
  (`ExecuteCell`/`RunAllCells`) so a runtime peer cannot enqueue work by syncing
  a forged execution entry.
  Future blob-reference validation should build on that policy rather than
  reintroducing a separate runtime-state authorization surface.
- Keep `BlobBackend` storage concerns separate from `BlobResolver` read
  authority. The former stores bytes; the latter decides how an authorized
  viewer obtains them.
- Ship hosted editor uploads only with server-side reference-path validation.
  Until then, hosted editor uploads remain denied even though local editor
  uploads are allowed for same-UID document attachment flows.
- Keep the publish reachability walk and daemon GC walk aligned as blob-bearing
  schemas evolve. Hosted publish already HEAD-checks every materialized render
  ref before recording a revision; the residual risk is schema drift between
  that walk and garbage collection.

## Summary

The intended architecture is internally consistent if these two rules remain
load-bearing:

1. Cross-machine compute attaches at daemon or room-host boundaries. The
   `RuntimeAgent` socket remains local to the daemon that owns the kernel.
2. Blob transfer is subordinate to room authorization. Bytes become meaningful
   only when an authorized `NotebookDoc`, `RuntimeStateDoc`, or `CommsDoc`
   mutation references their content hash.

The high-value remaining work is not a larger remote-runtime design. Upload
scope gates are in place; the remaining authority work is reference-path
validation, room-scoped reads, and keeping blob-reference walks aligned as
schemas evolve.
