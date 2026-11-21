# Hosted Room Authorization and Cloud Room Host

**Status:** Draft, 2026-05-23. Core room ACL, materializer checkpoint precedence,
semantic editor diff validation, and staged blob-upload policy have shipped;
private blob reads, OIDC/Hub capability mapping, and live revocation remain
open.

## Context

`apps/notebook-cloud` establishes three core hosted pieces:

- Published notebook viewers load a snapshot bundle (`NotebookDoc`,
  `RuntimeStateDoc`, and optional `CommsDoc`) from R2 and materialize it with
  `runtimed-wasm`.
- Renderer sidecars run on a separate asset origin while notebook blobs stay
  behind the notebook host's blob resolver.
- The Durable Object accepts typed-frame v4 WebSockets, rewrites CBOR presence,
  enforces frame-size caps, and rejects read-only violations.

The materialized Durable Object room host unifies these pieces. Published
read-only notebooks, authenticated editors, runtime peers, and anonymous public
viewers connect to one room abstraction with different scopes. The Worker
authenticates the connection, D1 authorizes what that principal can do in the
room, and the Durable Object hosts the live document and persists snapshots.

Neighbors:

- `docs/adr/identity-and-trust.md`: principal/operator labels, connection
  scopes, provider validation, and actor-principal enforcement.
- `docs/adr/hosted-credential-transport.md`: direct OIDC, JupyterHub, browser
  WebSocket credential transports, and origin policy.
- `docs/adr/hosted-notebook-artifacts.md`: R2 snapshot bundle and render-cache
  layout.
- `docs/adr/blob-storage-and-content-addressing.md`: `BlobResolver` and
  renderer asset origin separation.
- `docs/adr/frontend-sync-bridge.md`: why hosted editing reuses the same
  WASM/sync/viewer surfaces instead of adding a second UI stack.

## Decision 1: Room access is an ACL, not a credential claim

Authentication answers "who is this connection?" Authorization answers "what can
this principal do in this notebook room?" The Worker keeps those as separate
steps:

1. Extract and validate a credential to get an authenticated principal, an
   operator, and provider-side capability bounds.
2. Look up the notebook room ACL in D1.
3. Derive the connection scope from the ACL row and provider bounds.
4. Stamp trusted headers for the Durable Object.

Dev auth follows the same flow. It identifies a principal and operator, never
final deployed scope. The requested `scope` query parameter or header is a
local-only bootstrap convenience; deployed scope always comes from the room ACL.

`notebooks.owner_principal` is catalog metadata for listing and provenance, not
authorization truth. Owner permission is an explicit ACL row with
`scope = 'owner'`.

This keeps hosted authority boundaries explicit:

- **Room URL**: addresses a room host; grants no access.
- **Durable Object**: document authority; materializes and validates live
  `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` state.
- **Room ACL**: access authority; decides whether a validated principal may
  connect as `viewer`, `editor`, `runtime_peer`, or `owner`.
- **Compute providers** (JupyterHub and others): authorize their own compute
  resources, then attach as scoped runtime peers when the room ACL allows it.
- **Blob uploads**: subordinate to connection scope and the later document
  mutation that references the uploaded hash.

## Decision 2: ACL rows are explicit D1 records

Room ACLs live in the D1 `notebook_acl` table:

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

When `subject_kind = 'principal'`, `subject` is a validated `Principal` string
from `nteract-identity`, such as `user:anaconda:...`,
`hub:hub.example.com:alice`, or `local:quill`.

When `subject_kind = 'public'` and `subject = 'anonymous'`, anonymous
connections receive `viewer` scope for that room. Public access is never
inferred from a render cache or snapshot object.

The primary key includes `scope` so one principal can hold multiple orthogonal
roles in the same room. A local daemon bridge, for example, may need one
`editor` connection and one `runtime_peer` connection under the same principal
with distinct operators, without being promoted to `owner`.

This schema deliberately avoids wildcard principals like `anonymous:*`. Wildcard
matching is authorization logic, not principal syntax.

D1 has no MySQL-style `ON UPDATE` timestamps. Every ACL write must go through a
storage helper that sets `updated_at = strftime(...)` explicitly on upserts and
replacements. Bare `UPDATE notebook_acl ...` statements are forbidden, and tests
must verify `updated_at` refreshes on mutation.

The same helper enforces orphan-room protection: it rejects any deletion or
replacement that leaves a notebook with zero `scope = 'owner'` rows. A principal
may hold redundant rows such as `owner` and `editor`, so the guard counts only
rows where `scope = 'owner'`.

## Decision 3: Scope derivation is capability intersection

The four scopes do not form a total order because `editor` and `runtime_peer`
grant disjoint write surfaces. Treat them as capability sets:

| Scope | Capabilities |
|-------|--------------|
| `viewer` | Read room state, receive sync, send empty sync negotiation, send presence (anonymous presence may be connection-local) |
| `editor` | `viewer` + write allowed `NotebookDoc` fields + mutable widget comm state in `CommsDoc` |
| `runtime_peer` | `viewer` + write kernel lifecycle, comm topology, output routing, and progress/output state for accepted executions + upload output blobs; cannot create execution intent or rewrite trust/environment/path/project metadata |
| `owner` | `editor` + publish revisions + mutate ACLs; holds `runtime_peer` separately via an explicit ACL row when runtime progress authorship is needed |

Execution intent is separate from runtime-state authorship. A runtime peer
consumes queued executions and reports lifecycle and outputs, but never creates
new execution intent. In the browser cloud viewer, run controls appear only
when:

1. a live `runtime_peer` is attached to the room; and
2. the browser connection holds `owner` scope.

`editor` grants document-editing authority, not compute authority. Edit mode and
an `editor` ACL row never let a principal spend hosted compute or enqueue runs.
A future explicit execute scope can grant compute to non-owners separately from
document editing, `runtime_peer`, and `owner` ACL management. Local-only kernels
author runtime state under a local principal; when promoted into a hosted room,
they adopt the authenticated room principal and operator for that connection.

Blob upload authority is staged (HCA-3). The audit in
`../audits/runtime-peer-and-blob-authority-audit.md` allows editor uploads only
as precursors to authorized document references. Until server-side
reference-path validation exists, hosted rooms deny editor uploads. Under the
shipped policy, `allowsBlobUpload` permits only `runtime_peer` and `owner`,
enforced at both the `PUT_BLOB` frame prefilter and the HTTP upload route.
Editor uploads and reference-path validation must ship together; see
[Open Follow-ups](#open-follow-ups).

Each request has a provider maximum capability set, room ACL grants, and a
requested role. Anonymous browser viewers may omit the role and default to
`viewer`. Authenticated native and system clients must specify their intended
role so a missing parameter fails early rather than failing on the first write.

Authorization is rejection-oriented:

1. Authenticate the request. A valid credential yields a principal and provider
   capabilities; no credential yields an unauthenticated request.
2. If authenticated, load ACL rows for `(notebook_id, principal)`.
3. If unauthenticated, load only the public-read ACL row. If present, grant
   anonymous `viewer`; otherwise reject.
4. Compute the union of ACL-granted capabilities.
5. Verify that the requested role's capabilities are a subset of both provider
   capabilities and ACL capabilities. Anonymous public reads have provider
   capabilities of exactly `viewer`.
6. If the check passes, stamp the connection scope as the requested role. If it
   fails, reject rather than silently downgrading, except for the browser
   public-read case below.

Each WebSocket holds a single scalar scope (`viewer`, `editor`, `runtime_peer`,
or `owner`). A principal holding both `editor` and `runtime_peer` rows opens two
connections with distinct operators and roles. It never gets publish or ACL
mutation rights without an `owner` row.

Dev credentials currently receive an implicit provider maximum of `owner` on
local loopback or with the deployed dev token. Real OIDC and JupyterHub
providers must map credential claims to explicit provider maximum capabilities
before the ACL lookup.

Browser notebook pages get one compatibility fallback on public rooms: if an
authenticated user requests `editor` without an editor ACL row, and the notebook
has an explicit public `viewer` ACL row, the Worker may stamp the connection as
`viewer`. This applies only to same-origin live-room WebSockets so stale tabs do
not block signed-in users from viewing public notebooks. HTTP mutations, publish
routes, blob uploads, and native/system clients still reject instead of
downgrading.

## Decision 4: Public viewers are authorized, not fallback guests

Unauthenticated requests become anonymous principals only after the room ACL
permits public read:

```text
anonymous:<session>/browser:<session>
```

Without a public ACL row, unauthenticated WebSocket upgrades and render API
reads return `401`/`403`, never an implicit viewer session. A signed-in user
without a principal ACL row can read through the public row by requesting
`viewer` (or via the browser live-room fallback above). Local Wrangler demo
routes may seed a public-read ACL for demo notebooks, but deployed rooms require
explicit rows.

Anonymous viewers are strictly read-only. They may receive room state and send
presence, but may not send non-empty `NotebookDoc`, `RuntimeStateDoc`, or
`CommsDoc` sync, request side effects, upload blobs, write pool state, publish,
or mutate ACLs.

Anonymous public presence stays connection-local: the server acknowledges the
frame to the sender without broadcasting it to other peers. Authenticated viewers
receive live broadcast presence. Room frames are not persisted as an activity
log; the materialized `NotebookDoc`/`RuntimeStateDoc`/`CommsDoc` checkpoint path
is the durable recovery boundary. Any future broadcast of anonymous presence
must explicitly choose between aggregate room presence and full cursor/cell
presence.

## Decision 5: Room creation is a privileged operation

Opening `/n/:id/sync` must not mint a notebook row for an arbitrary principal.
Notebook rows and their initial `owner` ACL row are created only by:

1. authenticated publish/import for a principal permitted to create hosted
   notebooks;
2. an explicit owner-only room creation API; or
3. a local-only test/bootstrap helper.

`ensureNotebook()` may remain as a low-level storage primitive, but call sites
must use explicit operations:

- `createNotebookWithOwnerAcl(...)` for publish, import, and bootstrap;
- `touchNotebook(...)` to update `updated_at` on existing rooms;
- `authorizeNotebookAccess(...)` for read/write route gates.

This prevents a dev-authenticated viewer or editor from creating catalog state
by connecting to a guessed ID.

## Decision 6: The Durable Object is the live document host

The Durable Object hosts the live room rather than relaying raw frames:

1. On first connection, load the latest revision from D1 and R2.
2. Materialize `NotebookDoc`, `RuntimeStateDoc`, and optional `CommsDoc` bytes
   through the room materializer.
3. Keep the WASM handle resident while peers are connected.
4. Route inbound typed-frame v4 bytes through the WASM handle.
5. Enforce scope and actor-principal validation before mutating live state.
6. Emit sync replies and broadcasts to connected peers.
7. Debounce snapshot persistence for `NotebookDoc`, `RuntimeStateDoc`, and
   `CommsDoc` to R2 and record a revision/checkpoint row in D1.

The Durable Object does not run kernels. Compute connects as a `runtime_peer`
that publishes lifecycle, comm topology, output routing, progress, outputs, and
output blobs for room-accepted executions. The DO owns documents, presence, auth
context, snapshots, scope enforcement, and the execution-intent request path.

Durable Object storage is a hibernation and recovery cache, never the durable
source of truth. R2 snapshot bundles and D1 catalog, ACL, and revision rows are
durable truth. Readers must not treat DO cache state as a published revision or
portability boundary.

For a connected browser page, the materialized live room is the active source of
truth. A render cache or `/api/n/:id/render` response may warm-start first
paint, but it must not remain a separate read lane after live materialization.
Viewers and editors consume the same live `NotebookDoc` and `RuntimeStateDoc`;
scope limits only what each connection may author.

### Checkpoint precedence

The live-room materializer (`apps/notebook-cloud/src/room-materializer.ts`) uses
DO checkpoint storage strictly as a recovery cache with three precedence rules:

1. Load a checkpoint only when its `published_revision_id` matches the
   notebook's latest published revision.
2. On revision mismatch, keep the checkpoint only if its document heads differ
   from its recorded published baseline, meaning it holds unpublished live
   changes. Otherwise load the published R2 snapshot pair.
3. On failure recovery, clear the checkpoint and reload the published snapshot
   pair rather than serving potentially corrupt cache state.

Checkpoint metadata stores the correlated
`(notebook_heads, runtime_state_heads, comms_doc_heads)` triplet for both the
current cache and its published baseline so rule 2 is decidable. Checkpoint
cadence remains an open tuning question; authority precedence is settled.

## Decision 7: Editor collaboration is full cell editing behind a semantic gate

Editor-scope collaborators get the full collaborative cell surface: add, delete,
reorder, and edit markdown, code, and raw cells. Everything else at the document
root stays owner-authored: notebook metadata (`kernelspec`, trust, environment,
path, project) and the identity roots `schema_version`, `notebook_id`,
`runtime_state_doc_id`, and `comms_doc_id`.

UI-only hiding is not a security boundary because a malicious browser can send
arbitrary `NotebookDoc` sync frames. The room host enforces the editor surface
server-side with a semantic diff validator:

- `validate_editor_notebook_changes` in `runtimed-wasm` runs from
  `receive_notebook_sync` whenever `can_write_all_notebook_changes` is false.
- It clone-previews the incoming `NotebookDoc` message, diffs it against prior
  heads, and accepts the frame only if every patch lands inside the `cells` map.
- The policy is an allowlist, not a metadata denylist. Root writes to metadata,
  `schema_version`, `notebook_id`, `runtime_state_doc_id`, `comms_doc_id`, or a
  root replace/delete of `cells` are rejected.
- Owners skip the validator and may write any notebook change.

This validator preserves client-local editing and stays aligned with the desktop
sync model without relying on UI restrictions.

Cell-level `execution_count` and `execution_id` sit under `cells/{id}`, so the
allowlist permits editor writes to them. This is intentional: `execution_count`
is written during normal cell creation and serves as the legacy nbformat
fallback, while `execution_id` points into `RuntimeStateDoc`. Because
`RuntimeStateDoc` is separately gated, an editor cannot fabricate live
execution state. The residual exposure is a forged persisted count on `.ipynb`
export, which is out of the current threat model.

Execution remains a separate axis from document editing. Hosted run controls
require owner request authority plus runtime availability. Execution requests go
through the room host to an authorized `runtime_peer`; widening editor cell
writes does not grant execution.

The shared runtime-doc policy closes the editor `RuntimeStateDoc` write surface
in both the hosted room host and the daemon:

- Editors and owners write mutable widget state through `CommsDoc`.
- Runtime peers write only policy-allowed lifecycle, execution status, comm
  topology, output routing, and outputs for accepted executions.
- Execution intent, provenance, and room-host facts stay outside the
  runtime-peer surface.
- Disallowed `RuntimeStateDoc` frames are rejected before the room document
  mutates, preventing editors from escalating into runtime lifecycle or
  fabricating outputs.

Narrowing collaborative editing further (for example, an owner-only "freeze
structure" mode or a scoped metadata-edit grant) is a future owner control, not
the baseline.

## Decision 8: Runtime peers are scoped connections

`runtime_peer` is the uniform connection shape for a remote runtime service,
local daemon bridge, or JupyterHub sidecar. A runtime peer:

- sends policy-validated `RuntimeStateDoc` sync frames for kernel lifecycle,
  progress, comm topology, and outputs;
- uploads blobs referenced by runtime output manifests;
- cannot edit `NotebookDoc`;
- cannot mutate ACLs or publish revisions unless it also holds an `owner` row.

Separating kernel attachment from document editing lets a hosted room render and
persist without compute attached. In the preferred Anaconda-hosted topology,
JupyterHub authorizes compute while the room ACL authorizes `runtime_peer`
access to the room.

## Decision 9: Blob and plugin origins stay separate

Room authorization leaves renderer hardening intact:

- Renderer sidecars stay static assets, preferably on the dedicated renderer
  asset Worker/origin with explicit CORS for sandboxed `srcdoc` iframes.
- Notebook output blobs stay behind the notebook host's `BlobResolver` path or a
  future signed output origin.
- Shared renderer code must not reconstruct cloud URLs from `notebookId`,
  `/api/n`, or other app-specific route shapes.
- Iframe CSP and sandbox permissions must not be loosened for plugin loading.

Blob reads may remain public for published demo notebooks only when the room has
a public-read ACL row. Private notebooks require viewer-or-better auth, signed
URLs, or an output origin enforcing equivalent access.

## Open Follow-ups

- **Editor blob uploads and reference-path validation (HCA-3):** Ship editor blob
  uploads together with server-side reference-path validation in one change set.
  Until then, `allowsBlobUpload` stays restricted to `runtime_peer` and `owner`
  at both the `PUT_BLOB` frame prefilter and the HTTP upload route.
- **Private hosted blob read capabilities (HCA-6):** Write and land the "Hosted Private
  Blob Read Capabilities" ADR (resolving `hosted-output-origin-isolation.md`
  open question 2) before private sharing ships, choosing between Worker auth
  on `/api/n/:id/blobs/:hash`, signed R2 URLs, or a separate output origin with
  short-lived tokens.
- **Remove prototype-only shortcuts:** Eliminate remaining prototype behavior on
  deployed paths:
  - deployed dev credentials selecting scope by query parameter or header;
  - implicit anonymous viewer access to arbitrary notebook IDs;
  - WebSocket connect creating a notebook catalog row as a side effect;
  - Durable Object relay paths that store frame metadata without owning a
    materialized notebook/runtime/comms bundle;
  - public snapshot or blob reads that bypass the room ACL on private notebooks.

## Open Questions

1. **Anonymous viewer presence granularity:** Should public viewers ever
   broadcast full cursor/cell presence, or only document-level aggregate
   presence?
2. **Scoped editor metadata grants:** Should editors eventually get a scoped
   grant for notebook metadata (`kernelspec`, language), or should metadata stay
   owner-only?
3. **DO checkpoint cadence and visibility:** How often should the DO checkpoint
   live room snapshots to R2, and should checkpoints appear as user-facing
   revisions or internal autosaves?
4. **Provider capability set representation:** Should provider capability bounds
   use a capability set in TypeScript immediately, or stay as a
   `ConnectionScope` plus helper until OIDC and JupyterHub providers land?
5. **Immediate eviction on ACL deletion:** Should deleting an ACL row evict live
   connections immediately via a `SESSION_CONTROL` close frame, or take effect
   on reconnect? `identity-and-trust.md` defers general revocation, but hosted
   ACL mutation surfaces this earlier.
