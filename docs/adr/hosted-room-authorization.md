# Hosted Room Authorization and Cloud Room Host

**Status:** Draft, 2026-05-23.

## Context

`apps/notebook-cloud` now proves three important hosted pieces:

- published notebook viewers load a persisted snapshot bundle (`NotebookDoc`,
  `RuntimeStateDoc`, and optional `CommsDoc`) from R2 and materialize it with
  `runtimed-wasm`;
- renderer sidecars can live on a separate asset origin while notebook blobs
  remain behind the notebook host's blob resolver;
- the Durable Object can accept typed-frame v4 WebSockets, rewrite CBOR
  presence, enforce frame-size caps, and reject obvious read-only violations.

The next phase should turn that prototype into one hosted room model instead of
two nearby products. A published read-only notebook, an authenticated editor, a
future runtime peer, and an anonymous public viewer should all connect to the
same room abstraction with different scopes. The Worker authenticates the
connection. D1 decides what that principal can do in this room. The Durable
Object hosts the live document and persists snapshots.

Neighbors:

- `docs/adr/identity-and-trust.md` - principal/operator labels,
  connection scopes, provider validation, and actor-principal enforcement.
- `docs/adr/hosted-credential-transport.md` - direct OIDC, JupyterHub,
  browser WebSocket credential transports, and origin policy.
- `docs/adr/hosted-notebook-artifacts.md` - R2 snapshot bundle and
  render-cache layout.
- `docs/adr/blob-storage-and-content-addressing.md` - BlobResolver
  and renderer asset origin separation.
- `docs/adr/frontend-sync-bridge.md` - why hosted editing should reuse
  the same WASM/sync/viewer surfaces rather than introduce a second notebook UI
  stack.

## Decision 1: Room access is an ACL, not a credential claim

Authentication answers "who is this connection?" Authorization answers "what
can this principal do in this notebook room?" The Worker keeps those as two
steps:

1. Extract and validate a credential. This yields an authenticated principal,
   an operator, and provider-side capability bounds.
2. Look up the notebook room ACL in D1.
3. Derive the connection scope from the ACL row and provider bounds.
4. Stamp trusted headers for the Durable Object.

Dev auth follows the same shape. It identifies a principal and operator, but it
does not get to self-assert final deployed scope. The requested `scope` query or
header remains local-only bootstrap/test convenience. In deployed environments,
scope comes from the room ACL.

The existing `notebooks.owner_principal` column becomes catalog metadata. It is
useful for listing and provenance, but it is not the authorization source of
truth. The owner permission is an ACL row with `scope = 'owner'`.

This keeps the hosted authority split explicit:

- The room URL addresses a room host; it does not grant access.
- The Durable Object is document authority; it materializes and validates live
  `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` state for the room.
- The ACL is access authority; it decides whether a validated principal may
  connect as `viewer`, `editor`, `runtime_peer`, or `owner`.
- JupyterHub and other compute providers authorize their own compute resources,
  then attach as scoped runtime peers when the room ACL permits it.
- Blob uploads are subordinate to the connection scope and the later document
  path that references the uploaded hash.

## Decision 2: ACL rows are explicit D1 records

The next schema migration adds `notebook_acl`:

```sql
CREATE TABLE notebook_acl (
  notebook_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL CHECK (subject_kind IN ('principal', 'public')),
  subject TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('viewer', 'editor', 'runtime_peer', 'owner')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_actor_label TEXT,
  PRIMARY KEY (notebook_id, subject_kind, subject, scope),
  FOREIGN KEY (notebook_id) REFERENCES notebooks(id),
  CHECK (subject_kind != 'public' OR (subject = 'anonymous' AND scope = 'viewer'))
);

CREATE INDEX notebook_acl_subject_idx
  ON notebook_acl(subject_kind, subject, notebook_id);
```

`subject_kind = 'principal'` means `subject` is a validated `Principal` string
from `nteract-identity`, such as `user:anaconda:...`,
`hub:hub.example.com:alice`, or `local:quill`.

`subject_kind = 'public'` with `subject = 'anonymous'` is the public-read entry.
It grants anonymous connections `viewer` scope for that room. Public access is
not inferred from the existence of a render cache or a snapshot object.

The primary key includes `scope` so one principal can hold more than one role in
the same room. This matters because `editor` and `runtime_peer` are orthogonal:
a local daemon bridge may need one connection as editor and a separate
connection as runtime peer, both under the same principal but with distinct
operators. The principal is not forced to become `owner` just to get both write
surfaces.

This deliberately avoids wildcard principal strings such as `anonymous:*`.
Wildcard matching is authorization logic, not principal syntax.

D1 does not provide MySQL-style `ON UPDATE` timestamps. All ACL writes must go
through a storage helper that sets `updated_at = strftime(...)` explicitly on
every upsert and replacement. Bare `UPDATE notebook_acl ...` statements are
forbidden; tests should assert the helper refreshes `updated_at` when mutating
ACL rows.

The same helper is also responsible for orphan-room protection: it must reject
any deletion or replacement that would leave a notebook with no `owner` ACL row.
A hosted room always has at least one owner principal. Redundant rows are
allowed: a principal may hold both `owner` and `editor`, but orphan-room
protection counts only rows with `scope = 'owner'`, not total ACL rows for that
principal.

## Decision 3: Scope derivation is capability intersection

The four scopes are not a clean total order because `editor` and `runtime_peer`
grant different write surfaces. Treat them as capability sets:

| Scope | Capabilities |
|-------|--------------|
| `viewer` | read room state, receive sync, send empty sync negotiation, send presence; anonymous viewer presence may be connection-local |
| `editor` | viewer + write allowed `NotebookDoc` fields + mutable widget comm state in `CommsDoc` |
| `runtime_peer` | viewer + write kernel lifecycle, comm topology, output routing, and progress/output state for accepted executions + upload output blobs; cannot create execution intent or rewrite trust/environment/path/project metadata |
| `owner` | editor + publish revisions + mutate ACLs; may hold separate `runtime_peer` capability through an explicit ACL row when it needs runtime progress authorship |

Execution intent is a separate authority from runtime-state authorship. A
runtime peer may consume queued executions and write lifecycle/output state, but
it must not create new execution intent. In the current browser-hosted
implementation, the cloud viewer surfaces run controls only when:

1. a live `runtime_peer` is attached to the room; and
2. the browser connection is scoped as `owner`.

This is an interim policy, not the final shape. The long-term model should add
an explicit execute capability/scope so principals that own both a document
editing connection and a runtime-peer connection can be granted execution intent
without conflating `editor`, `runtime_peer`, and `owner`. Local-only kernels
should continue to author runtime state under a local principal; when a local
kernel is promoted into a hosted room, it should adopt the authenticated room
principal/operator it uses for that connection.

The provider gives a maximum capability set for the credential. The ACL gives
one or more room grants. A connection also has a requested role. Anonymous
browser viewers may omit the role and default to `viewer`. Authenticated native
and system clients must request the role they intend to use so a missing
parameter fails early instead of connecting as `viewer` and failing on first
write.

The authorization algorithm is deliberately rejection-oriented:

1. Authenticate the request. If a credential is present, this yields a principal
   and provider capabilities. If no credential is present, this yields an
   unauthenticated request.
2. If the request authenticated successfully, load ACL rows for
   `(notebook_id, principal)`.
3. If the request has no credential, load only the public-read ACL row for the
   notebook. If present, the connection becomes an anonymous viewer. If absent,
   reject.
4. Compute the union of ACL-granted capabilities.
5. Check that the requested role's capabilities are a subset of both provider
   capabilities and ACL capabilities. Anonymous public reads have provider
   capabilities of exactly `viewer`.
6. If the check passes, the connection scope is exactly the requested role.
   If it fails, reject the connection instead of silently downgrading, except
   for the browser live-room public-read case below.

This keeps a WebSocket connection's scope scalar (`viewer`, `editor`,
`runtime_peer`, or `owner`) while still allowing one principal to open multiple
connections with different operators and roles. A principal that has both
`editor` and `runtime_peer` ACL rows may open one editor connection and one
runtime-peer connection. It does not receive ACL mutation or publish capability
unless it also has an `owner` row.

For the first implementation pass, dev credentials can use an implicit provider
maximum of `owner` when the request is local-loopback or carries the deployed dev
token. Real OIDC/JupyterHub providers should map credential claims to provider
maximum capabilities before the ACL lookup.

Browser notebook pages get one public-read compatibility path: if an
authenticated user asks the live room for `editor` but has no editor ACL row,
and the notebook has an explicit public `viewer` ACL row, the Worker may stamp
the connection as `viewer`. This is allowed only for the same-origin live-room
WebSocket path so stale tabs and over-eager UI defaults do not block signed-in
users from reading public notebooks. HTTP mutation routes, publish routes, blob
uploads, and system/native clients still fail rather than downgrade.

## Decision 4: Public viewers are authorized, not fallback guests

Requests with no authenticated credential become anonymous principals only
after the room ACL allows public read:

```text
anonymous:<session>/browser:<session>
```

If a room has no public ACL row, an unauthenticated WebSocket upgrade or render
API read gets `401`/`403`, not an implicit viewer session. A signed-in user who
lacks a principal ACL row can still read through that public row when they
request `viewer`, and browser live-room connections may use the public-read
downgrade described above. Local Wrangler demo routes may seed a public-read
ACL for the demo notebook, but deployed behavior must be explicit.

Anonymous viewers are always read-only. They may receive room state and send
presence. They may not send non-empty `NotebookDoc`, `RuntimeStateDoc`, or
`CommsDoc` sync, request side effects, blob uploads, pool-state writes, publish
requests, or ACL mutations.

Public viewer presence is a product policy layered on top of this ACL. The
minimum hosted-room behavior keeps anonymous public presence connection-local,
matching the current prototype: the server acknowledges the frame to the sender
but does not broadcast it to other peers or persist it as room activity.
Authenticated viewers can use normal broadcast presence. If product later wants
public viewer presence, that change should be explicit and should define whether
anonymous users appear as aggregate document presence or full cursor/cell
presence.

## Decision 5: Room creation is a privileged operation

Opening `/n/:id/sync` must not mint a notebook row for an arbitrary principal.
Notebook rows and their first owner ACL row are created by one of:

1. publish/import, authenticated as a principal with permission to create a
   hosted notebook;
2. explicit owner-only room creation API;
3. local-only test/bootstrap helper.

The current `ensureNotebook()` helper can remain as a low-level storage
primitive, but call sites should move to explicit operations:

- `createNotebookWithOwnerAcl(...)` for publish/import/bootstrap;
- `touchNotebook(...)` for updating `updated_at` on existing rooms;
- `authorizeNotebookAccess(...)` for read/write route gates.

This closes the class of bugs where a dev-authenticated viewer or editor can
create catalog state by connecting to a guessed id.

## Decision 6: The DO becomes the live document host

The Durable Object should evolve from a bounded frame relay into the hosted
room host:

1. On first connection, load the latest revision from D1 and R2.
2. Call the room materializer to load notebook, runtime-state, and optional
   comms bytes.
3. Keep the handle resident while the room has active peers.
4. Route inbound typed-frame v4 bytes through the WASM handle.
5. Enforce scope and actor-principal validation before mutating the live
   room state.
6. Emit sync replies and broadcasts to connected peers.
7. Debounce persistence of `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`
   snapshots back to R2 and record a revision/checkpoint row in D1.

The DO does not host kernels in this phase. Kernel execution enters later as a
`runtime_peer` connection that reports lifecycle, comm topology, output routing,
and progress/output for room-accepted executions and uploads output blobs. The
DO hosts documents, presence, auth context, snapshots, scope enforcement, and
the request path that creates execution intent.

Durable Object storage is not the source of truth for notebook content. It may
hold hibernation metadata and a small amount of transient room state. R2
snapshot bundles and D1 catalog/ACL rows are durable.

For a connected browser page, the materialized live room is the active source
of truth. A render cache or `/api/n/:id/render` response may warm-start first
paint, but it must not become a separate read lane once the live room
materializes. Read-only viewers and editors consume the same live
`NotebookDoc`/`RuntimeStateDoc`; scope only limits what each connection may
author.

## Decision 7: Editor collaboration is full cell editing behind a semantic gate

Editor-scope collaborators get the full collaborative cell surface: add, delete,
reorder, and edit cells of any type (markdown, code, raw source). Creating cells
with a collaborator is the baseline expectation for an editable notebook, so the
editor write surface is not restricted to markdown. Everything else at the
document root stays owner-authored: notebook metadata (kernelspec, trust,
environment, path, project) and the document-identity roots `schema_version`,
`notebook_id`, and `runtime_state_doc_id`.

UI-only hiding is not an authorization boundary. A malicious browser can send
arbitrary `NotebookDoc` sync frames, so the room host enforces the editor
surface server-side with a semantic diff validator: it clone-previews the
incoming `NotebookDoc` message, diffs it against the heads before the change,
and accepts it only if every patch lands inside the `cells` map. The policy is
an allowlist, not a metadata denylist: any other root write — notebook
metadata, `schema_version`, `notebook_id`, `runtime_state_doc_id`, or a
root-level replace/delete of the `cells` map itself — is rejected. Owners skip
the validator (they may write all notebook changes). This is
`validate_editor_notebook_changes` in `runtimed-wasm`, reached from
`receive_notebook_sync` whenever `can_write_all_notebook_changes` is false. The
diff-validator path stays close to the desktop sync model and preserves
client-local editing; "only the cloud UI exposes editing" is never sufficient.

Cell-level `execution_count` and `execution_id` live under `cells/{id}`, so the
allowlist accepts editor writes to them. This is intentional. They are the
legacy nbformat persisted fallback and a pointer into RuntimeStateDoc; the live
execution authority is RuntimeStateDoc, which is separately gated, so a
non-owner editor cannot fabricate live execution state. A cell's
`execution_count` is also written as part of normal cell creation, so carving
these fields out would mean special-casing creation. The residual exposure is a
fabricated persisted count surfacing on `.ipynb` export, which is out of the
current threat model. Revisit if export fidelity from a malicious editor ever
enters scope.

Execution is a separate axis from the document write surface. There is no kernel
provider in the hosted prototype yet, so run/restart/interrupt stay hidden
behind a runtime-availability capability rather than an ACL scope. When a kernel
provider is later attached, execution authority is granted through
`runtime_peer` scope and the kernel protocol, not by widening the editor
document surface.

The editor `RuntimeStateDoc` write surface is closed by the shared runtime-doc
policy used by the hosted room host and daemon. Editor and owner scopes write
mutable widget state through `CommsDoc`; `RuntimeStateDoc` remains runtime-owned
for lifecycle, execution status, comm topology, and output routing. In a
multi-user room, an editor sending arbitrary `RuntimeStateDoc` sync changes
would be privilege escalation into runtime lifecycle, execution status, or
fabricated outputs, so frames that touch those fields are rejected before the
real room document mutates.

Locking the surface down further is a future owner capability, not the baseline:
an owner-only "freeze structure" or metadata-edit grant can narrow what editors
may do, but collaborative cell editing is on by default.

## Decision 8: Runtime peers are just another scoped connection

`runtime_peer` is the shape for a future remote runtime service, local daemon
bridge, or JupyterHub sidecar. A runtime peer:

- can send `RuntimeStateDoc` sync frames;
- can upload blobs referenced by runtime output manifests;
- can emit kernel lifecycle broadcasts;
- cannot edit `NotebookDoc`;
- cannot mutate ACLs or publish revisions unless it also has owner capability.

This keeps kernel attachment separate from document editing. A hosted room can
exist without a runtime peer and still render/persist notebook state.
It also keeps JupyterHub out of the document-authority path for the preferred
Anaconda-hosted topology: Hub grants access to compute, while the room ACL
grants `runtime_peer` access to the room.

## Decision 9: Blob and plugin origins stay separate

The authorization work does not change renderer hardening:

- renderer sidecars remain static assets, preferably on the dedicated renderer
  asset Worker/origin with explicit CORS for sandboxed `srcdoc` iframes;
- notebook output blobs remain behind the notebook host's BlobResolver path or
  a future signed output origin;
- shared renderer code must not reconstruct cloud route shapes from
  `notebookId`, `/api/n`, or any other app-specific URL convention;
- iframe CSP/sandbox permissions must not be loosened to make plugin loading
  easier.

The room ACL gates access to notebook state. Blob reads can remain public for
published demo notebooks only when the room has public-read ACL. Private
notebooks need viewer-or-better auth, signed URLs, or an output origin that can
enforce equivalent access.

## Implementation Sequence

1. **ADR and docs.** Land this document, cross-reference it from
   `identity-and-trust.md` and `hosted-notebook-artifacts.md`.
2. **ACL schema, lookup, and side-effect removal.** Add `notebook_acl`, a
   storage helper, and unit tests for principal rows, public-read rows, and
   missing ACL rejection. This PR must also remove or guard the existing
   WebSocket `ensureNotebook()` side effect; do not ship an ACL table while
   `/n/:id/sync` can still mint notebook rows before authorization.
3. **Auth refactor.** Change Worker auth so dev/OIDC/JupyterHub authenticate a
   principal and operator first; route handlers call
   `authorizeNotebookAccess()` to derive final scope.
4. **Public viewer as ACL.** Seed demo/public notebooks with the public ACL
   row, and make anonymous render/sync fail without that row.
5. **Publish/create owner ACL.** Publish/import creates the notebook row and
   owner ACL row atomically before recording the first revision. Existing
   notebook creation helpers should be renamed or split so call sites choose
   between creation, touch/update, and authorization.
6. **DO snapshot materialization.** Load latest snapshot bundle into
   `runtimed-wasm` inside the DO and use it as the room state, initially still
   without kernels.
7. **Editor RuntimeStateDoc path enforcement.** Done in the shared
   runtime-doc policy: editor/owner `RuntimeStateDoc` sync is rejected for
   widget state and other runtime-owned fields. Mutable widget state lives in
   `CommsDoc`; queue, execution, kernel, environment, output routing, comm
   topology, and schema/root writes remain runtime-owned.
8. **Editor cell-editing slice.** Server-side semantic gate
   (`validate_editor_notebook_changes`) accepts full cell editing (any cell
   type, source, and structure) from authenticated `editor`/`owner`
   connections while rejecting notebook-level metadata edits from non-owners.
9. **Runtime peer ingress.** Allow runtime peers to attach and update
   `RuntimeStateDoc` plus blobs without notebook edits.
10. **Direct OIDC.** Wire real provider validation after ACL lookup is in
   place. Browser WebSockets follow `hosted-credential-transport.md` for
   non-echoed bearer subprotocols, one-time tickets, optional perimeter
   assertions/cookies, and origin checks; native/system clients may use
   headers.

## Prototype-only behavior to remove

- Scope requested by query/header on deployed dev credentials.
- Implicit anonymous viewer access to every notebook id.
- WebSocket connect creating a notebook row as a side effect.
- Durable Object relay behavior that stores frame metadata but does not own a
  materialized notebook/runtime/comms document bundle.
- Public snapshot/blob reads that bypass the room ACL for private notebooks.

## Open Questions

1. Whether anonymous public viewers should broadcast full cursor/cell presence
   or only document-level aggregate presence.
2. Whether editors should eventually get a scoped notebook-metadata grant
   (kernelspec, language) or whether metadata stays owner-only.
3. How often the DO should checkpoint live room snapshots to R2 and whether
   checkpoint rows are visible as user-facing revisions or internal autosaves.
4. Whether provider capability bounds should be represented as a set in
   TypeScript immediately, or kept as a `ConnectionScope` plus helper until
   OIDC/JupyterHub providers land.
5. How private hosted blob reads should be enforced: Worker auth check on
   `/api/n/:id/blobs/:hash`, signed R2 URLs, or a separate output origin with
   short-lived tokens.
6. Whether ACL row deletion by an owner should evict live connections
   immediately through a `SESSION_CONTROL` close frame or only take effect on
   the next connection attempt. `identity-and-trust.md` defers general
   revocation, but hosted ACL mutation makes the decision visible earlier.
