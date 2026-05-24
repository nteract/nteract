# Runtime Peer Contract and Blob Authority Audit

**Status:** Draft, 2026-05-24.

## Context

This audit follows `deployment-topology.md`, which makes Cloudflare the hosted
room/document host and JupyterHub compute an outbound `runtime_peer`
attachment. Two contracts need to stay sharp as implementation moves from the
single-user daemon toward hosted rooms:

1. `runtime_peer` is a room authorization role, not the local `RuntimeAgent`
   socket protocol.
2. `PutBlob` is a byte-transfer primitive, not authority to mutate notebook or
   runtime state.

Neighbors:

- `identity-and-trust.md` defines scopes and per-frame actor validation.
- `hosted-room-authorization.md` defines ACL-derived room scope.
- `deployment-topology.md` defines hosted and daemon-mediated runtime
  topologies.
- `typed-frame-v4-wire-protocol.md` defines the `RuntimeAgent` channel and
  `PutBlob` frame.
- `blob-storage-and-content-addressing.md` defines content addressing,
  multipart upload, durability, and resolver boundaries.

## Audit 1: Runtime peer contract

### Contract

| Term | Boundary | Allowed surface | Not allowed |
|------|----------|-----------------|-------------|
| `runtime_peer` | Room connection authenticated by the room host and authorized by the room ACL | Write `RuntimeStateDoc`, upload blobs referenced by runtime/output state, emit runtime lifecycle events, receive room sync needed to execute requested work | Edit `NotebookDoc`, mutate ACLs, publish revisions, host the room, or imply where the kernel process lives |
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

### Required follow-ups

- Keep `RuntimeAgent` documentation explicitly local-daemon scoped.
- Treat `runtime_peer` sidecars as normal authenticated room connections.
- Before hosted runtime execution ships, define which request variants can be
  sent by editors/owners and how they route to the active runtime peer.
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
| `editor` | Blobs needed for allowed `NotebookDoc` edits and the allowed widget comm-state subtree | May reference uploads from allowed notebook fields, attachments, resolved assets, and permitted `doc.comms/*/state/*` writes | Same as viewer, plus any private editor-visible room blobs |
| `runtime_peer` | Runtime output, execution, lifecycle, and comm-output blobs | May reference uploads from allowed `RuntimeStateDoc` output/lifecycle paths | Same as viewer for the attached room |
| `owner` | Editor and runtime-peer upload surfaces | Editor and runtime-peer reference surfaces, plus publish/export flows | Same as editor/runtime-peer, plus owner-only artifact management |

The `PutBlobHeader.purpose` field is a hint for routing, metrics, retention, or
debugging. It is not an authorization decision. A malicious peer can choose any
purpose string, so the room host must authorize by connection scope and by the
document path that later references the content hash.

### Current implementation evidence

- The local daemon stores blobs by SHA-256 and verifies size/hash before
  publishing bytes. Multipart upload validates part hashes and the final hash.
- `PutBlob` uses the typed-frame path while multipart session control uses
  `NotebookRequest::{CreateBlobUpload, CompleteBlobUpload, AbortBlobUpload}`.
- The current local notebook peer loop enqueues `PutBlob` frames without a
  scope check. Multipart request handling is intercepted before generic request
  dispatch and also has no scope annotation today.
- This is acceptable for the current local same-UID daemon path because local
  connections authenticate as owner. It is not sufficient for hosted
  multi-user rooms where viewer/editor/runtime-peer scopes are distinct.
- Blob reads are unauthenticated on the local loopback HTTP origin and rely on
  same-machine isolation plus hash unguessability. Hosted reads already need a
  room-aware resolver or signed output origin.

### Findings

1. **Upload and reference are separate authorization gates.** A scoped peer may
   be allowed to upload bytes but still forbidden to reference them from a
   particular document path. The decisive check is the later `NotebookDoc` or
   `RuntimeStateDoc` mutation, not the blob frame alone.
2. **Hosted rooms need an explicit upload gate.** `viewer` must not be able to
   send `PutBlob` or multipart upload requests. `editor` and `runtime_peer`
   should be allowed only because they have a later path where an authorized
   reference can appear.
3. **Hosted rooms need reference-path validation.** `runtime_peer` can point at
   uploaded blobs only from runtime/output state. `editor` can point at blobs
   only from notebook fields and the widget comm-state subtree. Owner inherits
   both write surfaces.
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

### Required follow-ups

- Add scope annotations for `PutBlob` and multipart upload request variants
  before exposing hosted multi-user room sockets.
- Add server-side path validation for `RuntimeStateDoc` writes so `editor`
  remains limited to widget comm state and `runtime_peer` remains limited to
  runtime/output state.
- Keep `BlobBackend` storage concerns separate from `BlobResolver` read
  authority. The former stores bytes; the latter decides how an authorized
  viewer obtains them.
- Add publish-time reachability validation: a snapshot revision should not
  advance until every reachable blob ref exists in the destination backend.

## Summary

The intended architecture is internally consistent if these two rules remain
load-bearing:

1. Cross-machine compute attaches at daemon or room-host boundaries. The
   `RuntimeAgent` socket remains local to the daemon that owns the kernel.
2. Blob transfer is subordinate to room authorization. Bytes become meaningful
   only when an authorized `NotebookDoc` or `RuntimeStateDoc` mutation references
   their content hash.

The high-value implementation work is therefore not a larger remote-runtime
design yet. It is scope-gating and path-validation: make the hosted room host
prove that every write-bearing frame, request, and blob reference is legal for
the connection scope that submitted it.
