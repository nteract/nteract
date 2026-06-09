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
  remain open in `remote-workstation-doc-agents.md`.

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
- Request variants are owner-only today and route through the
  `RuntimeStateDoc` queue. The remaining dispatch work is active-target
  selection and liveness gating (see `remote-workstation-doc-agents.md`).
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
  `hosted-room-authorization.md` Decision 3).
- The local notebook peer loop still enqueues `PutBlob` frames without a
  scope check, and multipart request handling is intercepted before generic
  request dispatch with no scope annotation. That is acceptable for the
  current local same-UID daemon path because local connections authenticate
  as owner; punchlist BS-12 tracks daemon parity with the hosted gate.
- Hosted publish now validates reachability: a snapshot revision is rejected
  with `424 missing_blobs` when any materialized render ref is missing from
  the destination blob store, before any D1 revision row is recorded.
- Blob reads are unauthenticated on the local loopback HTTP origin and rely on
  same-machine isolation plus hash unguessability; that surface is now
  declared permanently single-user (`blob-storage-and-content-addressing.md`
  open question 3). Hosted reads ride the viewer-authorized
  `/api/n/:id/blobs/:hash` route; private sharing still needs the capability
  mechanism tracked as HCA-6.

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

### Required follow-ups

- Add scope annotations for `PutBlob` and multipart upload request variants
  in the daemon peer loop (punchlist BS-12). The hosted room host already
  gates uploads by scope.
- Keep the shared `RuntimeStateDoc` write policy in the hosted room host and
  daemon paths. `editor` and `owner` must remain limited to existing widget
  comm state, while `runtime_peer` remains the explicit writer for runtime
  lifecycle, execution progress, output, and comm topology state. Execution
  intent creation still belongs to the room-host request path
  (`ExecuteCell`/`RunAllCells`) so a runtime peer cannot enqueue work by syncing
  a forged execution entry.
  Future blob-reference validation should build on that policy rather than
  reintroducing a separate runtime-state authorization surface.
- Keep `BlobBackend` storage concerns separate from `BlobResolver` read
  authority. The former stores bytes; the latter decides how an authorized
  viewer obtains them.
- ~~Add publish-time reachability validation: a snapshot revision should not
  advance until every reachable blob ref exists in the destination backend.~~
  Done: `validateSnapshotPair` HEAD-checks every materialized render ref and
  fails the publish before recording a revision. The residual risk is
  schema drift between the publish walk and the daemon GC walk (punchlist
  BS-14).

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
