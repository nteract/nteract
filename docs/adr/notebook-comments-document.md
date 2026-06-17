# Notebook Comments Document

**Status:** Draft, 2026-06-07. Updated 2026-06-17.

This ADR proposes a comment system for nteract notebooks that works in local
desktop rooms and Cloud hosted rooms, lets humans and agents participate through
the same API, and keeps comment state aligned with the existing Automerge
document split.

## Short Decision

Create another per-notebook Automerge document, `CommentsDoc`, instead of
storing comments in `NotebookDoc` cells or in `RuntimeStateDoc`. In the current
room model this makes comments the next notebook-room sidecar after
`CommsDoc`; `PoolDoc` remains daemon-scoped and is not part of the per-notebook
count.

`CommentsDoc` is durable collaboration state with different authority,
durability, attachment, fan-out, and publish policy from cells, outputs,
widgets, or runtime lifecycle. It syncs over its own typed frame:
`COMMENTS_DOC_SYNC = 0x0a`. Adding it is an exhaustive wire change, not only a
constant. User-facing comment writes should still use Automerge for immediate
local-first rendering: the client writes a tentative comment mutation into its
local `CommentsDoc` replica, and the daemon or Cloud comments authority
finalizes policy-bearing fields such as author identity, scope, resolve/delete
state, and rejection status in the same document.
Rendering must not wait for a request round trip. Pending comments are projected
from local Automerge heads; daemon or Cloud writes are subsequent authoritative
changes to the same objects.

## Source Constraints

Automerge's own docs frame the important granularity rule: a document is the
unit of collaboration for a small group, and many thousands of tiny documents
carry sync overhead. The same docs also warn that replacing whole arrays or text
values produces coarse merge behavior; fine-grained Automerge maps and text
objects should be mutated in place instead. Source:
https://automerge.org/llms-full.txt

nteract already follows the same shape:

- `docs/adr/document-split.md` says the split is load-bearing for
  permission boundaries, durability/lifetime, attachment identity, fan-out
  scope, and trust, and deliberately avoids naming the architecture by a fixed
  document count.
- `NotebookDoc` carries durable cells keyed by `cell_id`, with fractional
  `position` strings for order.
- `RuntimeStateDoc` carries kernel, execution, output, env, trust, project, and
  live output/widget topology state.
- `CommsDoc` is already a per-notebook side document for mutable widget comm
  state.
- `PoolDoc` is daemon-level, not notebook-level.
- `docs/adr/identity-and-trust.md` makes the principal the security boundary and
  the operator the attribution layer.
- `docs/adr/mcp-resource-addressing.md` keeps MCP read resources under the local
  `nteract://` namespace and explicitly separates them from room locators.
- Current sync code treats frame types and document streams as explicit seams:
  `crates/notebook-wire/src/lib.rs` assigns `COMMENTS_DOC_SYNC = 0x0a`, and
  generated TypeScript constants and protocol tests pin that table. The local
  daemon/notebook-sync/MCP path now materializes and dispatches comments sync.
  Cloud and browser runtimed code pin the frame byte but keep comments
  non-client-writable and unmaterialized until hosted comments authority and
  checkpointing policy land.
- `NotebookView` has a stable DOM-order invariant; comments cannot be rendered
  as extra cell rows that reorder existing cell DOM nodes.

Those constraints point to `CommentsDoc`: optional, durable, per-notebook,
multi-writer, not part of nbformat cell source, and not runtime state.

Rejected granularity alternatives:

- **One document per thread or per cell:** this is the many-small-docs sync
  overhead pattern the Automerge guidance warns about. A busy notebook with
  human and agent review traffic could create hundreds or thousands of comment
  loci.
- **Fold comments into `NotebookDoc`:** this couples optional review state to
  cell/source edits, `.ipynb` persistence, and notebook-content fan-out.
- **Fold comments into `RuntimeStateDoc`:** comments are durable review state,
  not kernel lifecycle, execution, output, env, or widget topology state.

One coarse comments document per notebook is the intended unit of collaboration:
the same humans and agents reviewing one notebook room.

## Document Identity And Attachment

The hardest part is not the schema. It is the attachment identity.

Use a `NotebookCommentLocator` abstraction from the start. Once a `CommentsDoc`
exists, its `comments_doc_id` is required identity for that doc; v0 local
desktop may derive it from path or room id without mutating `NotebookDoc`, but
sync, persistence, MCP, and Cloud code should treat a missing id as a resolver
or seeding failure, not as optional comments state.

```text
Cloud hosted room:
  kind: "hosted_room"
  room_locator: "preview.runt.run/n/<notebook_id>"
  comments_doc_id: "comments:<notebook_id>"

Local file-backed notebook:
  kind: "local_path"
  canonical_path: "/abs/path/notebook.ipynb"
  comments_doc_id: "comments:local-path:<sha256(canonical_path)>"

Local untitled notebook:
  kind: "local_room"
  room_id: "<uuid>"
  comments_doc_id: "comments:local-room:<uuid>"
```

For v0 local desktop, use a daemon-managed sidecar resolver index from canonical
path or room id to `comments_doc_id`, and store the document bytes by
`comments_doc_id`:

```text
$DAEMON_STATE/comments/index.json
$DAEMON_STATE/comments/<sha256(comments_doc_id)>.automerge
```

That avoids changing `.ipynb` metadata during the prototype and keeps comments
available after daemon restart. Save-as and untitled-to-file promotion must bind
the new canonical path locator to the room's existing `comments_doc_id`; the
path-derived fallback is only for first discovery. Path moves outside nteract
remain weak in v0 because the notebook file still does not carry the association.
Hashing the filename keeps `comments_doc_id` out of platform-sensitive file
names; the document still stores and validates the raw `comments_doc_id`. The v1
portability fix is to add `metadata.runt.comments_doc_id` or a root
`NotebookDoc.comments_doc_id` in a future notebook schema bump, make that
association required for notebooks with comments, then keep a path index only as
a lookup cache.

An adjacent file such as `notebook.ipynb.comments.automerge` is attractive for
Git portability, but it has product tradeoffs: hidden files appear next to every
notebook and save-as behavior becomes observable outside nteract. Treat it as an
export/import option, not the first local storage backend.

## Local Desktop Vs Cloud Hosted Rooms

The same `CommentsDoc` schema should run in both places, but the attachment,
authority, and persistence rules differ.

Local desktop:

- Authority is the local daemon serving a notebook room over the local sync
  socket.
- Attachment starts from either a canonical file path or an untitled room UUID.
  File-backed comments need a path sidecar until the notebook carries a durable
  `comments_doc_id`.
- Same-UID trust makes local convergence forgiving. The UI should still write
  tentative comment mutations into the local `CommentsDoc` so Automerge owns the
  optimistic state, while the daemon finalizes author/scope fields in the same
  doc.
- Local agents use MCP tools/resources against an active notebook session. The
  implemented local MCP slice lists projected comments, creates/replies through
  pending comment mutations, and routes resolve/reopen plus authority
  finalization through daemon request handling.

Cloud hosted rooms:

- Authority is the Cloud room host, currently the Durable Object plus
  `RoomHostHandle` materializer path.
- That authority may later be a separate comments Durable Object keyed by
  `comments_doc_id`. The protocol should expose a comments document attached to a
  notebook room, not the Cloud storage topology.
- Attachment starts from the hosted notebook id or room locator, not from a
  filesystem path.
- Persistence belongs in room checkpoints and published snapshots alongside
  notebook/runtime/comms bytes and heads.
- Cloud editors and agents create, reply, edit, delete, and resolve as
  tentative `CommentsDoc` changes that render immediately. The Cloud comments
  authority stamps author fields from the authenticated connection and accepts or
  rejects the tentative mutation in the same doc.
- Runtime peers are readers of comments, not comments authorities. A
  `runtime_peer` may need empty sync negotiation to keep a shared document set
  connected, but it must not create, edit, resolve, reject, or authority-finalize
  comment mutations.
- Publication policy must be explicit. Comments should not automatically become
  part of a public notebook publish because review notes and agent comments can
  be more sensitive than notebook contents or outputs.

Published notebook snapshots:

- Published notebooks are a third artifact class, separate from local rooms and
  live Cloud rooms.
- Comments are off by default for public publish.
- If comments are published, they are a frozen read-only projection at publish
  heads, not a live comments sync subscription.
- Published attribution may need redaction or coarsening because
  `created_by_actor_label` and display names can expose internal reviewers.

That means the v0 local path sidecar is intentionally an adapter detail. The
portable model is still "one comments doc attached to one notebook room," with a
future `comments_doc_id` making local files robust under rename and move.

## CommentsDoc Schema

Use maps keyed by stable IDs for lookup and use fractional indices for every
user-visible order. Do not rely on list indexes for thread or reply order.

```text
ROOT/
  schema_version: 1
  comments_doc_id: Str              # required document identity
  notebook_ref/
    kind: "hosted_room" | "local_path" | "local_room"
    room_locator: Str?               # hosted room evidence
    canonical_path: Str?             # local file-backed evidence
    room_id: Str?                    # local untitled room evidence
  threads/
    {thread_id}/
      id: Str
      anchor/
        kind: Str
        ...anchor fields...
      position: Str                  # fractional order in the projection scope
      thread_order_scope: Str        # denormalized anchor scope for insertion
      status: Str                    # provisional open/resolved status
      mutation_state: Str            # "pending" | "accepted" | "rejected"
      created_at: Str
      initial_message_id: Str
      authority_mutation_state: Str? # authority-written accepted/rejected
      authority_status: Str?         # authority-written open/resolved
      authority_anchor_json: Str?    # accepted anchor snapshot
      authority_position: Str?
      authority_created_at: Str?
      authority_created_by_actor_label: Str?
      authority_created_by_authority: Str?
      authority_rejection_reason: Str?
      authority_resolved_at: Str?
      authority_resolved_by_actor_label: Str?
      authority_resolved_by_authority: Str?
      authority_reopened_at: Str?
      authority_reopened_by_actor_label: Str?
      authority_reopened_by_authority: Str?
      messages/
        {message_id}/
          id: Str
          position: Str              # fractional reply order
          body: Text
          mutation_state: Str        # "pending" | "accepted" | "rejected"
          created_at: Str
          authority_mutation_state: Str?
          authority_body: Str?
          authority_position: Str?
          authority_created_at: Str?
          authority_created_by_actor_label: Str?
          authority_created_by_authority: Str?
          authority_rejection_reason: Str?
```

Do not store a derived `anchor_index` inside `CommentsDoc`. It would add synced
bytes for data that is a pure function of `threads/*/anchor`, and concurrent
re-anchoring could leave stale denormalized entries. Build `commentsByCellId` and
other indexes in the projection layer, memoized by `CommentsDoc` heads if scans
ever become hot.

Message bodies should be Automerge `Text`, even if v0 only edits a whole comment
body at once. It keeps the schema ready for collaborative comment editing and
avoids whole-string conflict behavior.

`authority_created_by_authority` and related authority fields record which
comments authority wrote the durable attribution snapshot. In the local
implementation that value is the authority actor label `runtimed:comments`;
hosted rooms should use a Cloud comments-authority actor label. Imported
comments should be replayed or stamped with an explicit imported-authority label
so they do not become indistinguishable from locally or hosted-authenticated
comments.

Pending state is carried by `mutation_state`, not by overloading the authority
enum. While a thread or message is pending, authority fields are absent or
treated as untrusted; provisional display can come from the validated change actor
or local actor projection.

`mutation_state` is what keeps optimistic UI inside Automerge instead of in a
parallel React store. The UI can render pending threads and replies immediately
from the local `CommentsDoc`. The authority then writes the same object to
`accepted` with stamped author fields, or `rejected` with a reason the projection
can display or collapse.

#### Finalization is verified by change author, not by field value

`mutation_state = "accepted"` is meaningful only because of *who wrote it*, not
because the field says so. In raw CRDT convergence any editor-scope peer can write
any field, so a malicious client could set `mutation_state = "accepted"`,
`authority_mutation_state = "accepted"`,
`authority_created_by_authority = "runtimed:comments"`, and
`authority_created_by_actor_label` to a victim in a single client change and
self-finalize a spoofed comment.

The trust invariant the projection must enforce:

- Policy-bearing `authority_*` fields (`authority_mutation_state`,
  `authority_status`, `authority_created_by_*`, `authority_resolved_*`,
  `authority_reopened_*`, future tombstone/edit/moderation snapshots, and any
  other authority-prefixed policy field) are trusted only when the latest change
  writing them was authored by an actor whose principal is the comments
  authority (local daemon or Cloud comments host).
- Body text is trusted when authored by the claimed author's validated principal.
- A client-authored `authority_mutation_state = "accepted"` is ignored and
  rendered as pending/unverified. The field is a cache of "an authority change
  finalized this," verifiable by the attribution projection below, never a
  self-asserted boolean.

This makes the attribution projection load-bearing for the core trust model, not
only for "edited by" display.

Implementation must therefore ship one of two explicit mechanisms:

1. an object-path/field attribution helper that can answer "which actor last
   wrote this policy field at the current heads?" with tests for concurrent
   client/authority changes; or
2. authority-authored acceptance records that are easier to validate than
   per-field latest-writer inference.

Do not rely on broad sync-frame actor validation alone. Existing ingress paths
can prove that an incoming change principal matches the connection, but they do
not by themselves prove that the current winning value for a policy field was
written by the comments authority.

### Anchors

Start with anchors that degrade gracefully:

```text
Notebook anchor:
  kind: "notebook"

Cell anchor:
  kind: "cell"
  cell_id: Str
  observed_cell_position: Str?

Cell range anchor:
  kind: "cell_range"
  start_cell_id: Str
  end_cell_id: Str
  start_position: Str?
  end_position: Str?

Source range anchor:
  kind: "source_range"
  cell_id: Str
  start_line: Int
  start_column: Int
  end_line: Int
  end_column: Int
  prefix_quote: Str?
  exact_quote: Str?
  suffix_quote: Str?

Output anchor:
  kind: "output"
  cell_id: Str
  execution_id: Str?
  output_id: Str?
```

Cell comments survive cell moves because they key on `cell_id`. Cell range
comments should render by current cell order and use stored positions as
fallback evidence. Source range comments are inherently best-effort: v0 stores
line/column plus quote context, then marks the anchor stale if the cell is gone
or the quote no longer matches. A later editor integration can use CodeMirror
decorations or Automerge/CodeMirror position tracking for stronger remapping.

Deleting a cell should not delete comments. It should make affected anchors
stale and still visible in the comments panel. This preserves audit history and
avoids silently destroying agent feedback.

Creation-time notebook heads belong in the request payload as validation and
staleness evidence. They should not be durably stored on every anchor unless a
future diagnostic needs them; durable anchors should keep compact evidence such
as cell positions and quote context.

### Projection Keys

Define projection from anchors as a total function in Phase 1:

```text
thread_order_scope(notebook) -> "notebook"
thread_order_scope(cell) -> "cell:<cell_id>"
thread_order_scope(source_range) -> "cell:<cell_id>"
thread_order_scope(output) -> "output:<cell_id>:<execution_id?>:<output_id?>"
thread_order_scope(cell_range) -> "cell_range:<start_cell_id>:<end_cell_id>"

badge_cell_ids(notebook, current NotebookDoc) -> []
badge_cell_ids(cell, current NotebookDoc) -> [cell_id] if present, else []
badge_cell_ids(source_range, current NotebookDoc) -> [cell_id] if present, else []
badge_cell_ids(output, current NotebookDoc) -> [cell_id] if present, else []
badge_cell_ids(cell_range, current NotebookDoc) -> current cells between the endpoints
```

`get_comments_for_cell(cell_id)` should use `badge_cell_ids`, so cell badges count
cell, source-range, output, and applicable cell-range comments. Output-row UI can
use the more precise output scope for placement. The projection must distinguish
"anchor target not synced yet" from "anchor target was deleted" so independent
NotebookDoc and CommentsDoc sync channels do not produce false stale markers.

## Ordering

Use the same conceptual pattern as `NotebookDoc` cell order:

- Each thread gets a `position` fractional index within its
  `thread_order_scope(anchor)`.
- Each message gets a `position` fractional index within its `thread_id`.
- Sort by `(position, id)` for deterministic ties.
- Generate indices with the existing `loro_fractional_index` dependency or a
  shared helper extracted from `notebook-doc`.

This keeps concurrent replies and concurrent thread creation mergeable without
making Automerge list positions the semantic order.

Phase 1 tests should include concurrent inserts into the same gap. Fractional
indices can still collide under concurrent midpoint generation; sorting by
`(position, id)` is the deterministic tie-breaker that makes the visible order
stable across peers.

## Wire And Sync

Add the first `CommentsDoc` wrapper in a dedicated `comments-doc` crate.
Comments are durable notebook collaboration state, not runtime state, and the
crate boundary keeps comment lifetime and moderation policy separate from
`RuntimeStateDoc` and `CommsDoc`.

Core seams:

- `crates/comments-doc/src/lib.rs` and related tests
  - add `CommentsDoc`, `CommentsDocHandle`, state/projection types, schema seed,
    save/load/head/sync helpers, mutation helpers, and authority-finalization
    tests
  - keep comments policy helpers separate from CommsDoc policy; widget-state
    authorization is not comments authorization
  - require `comments_doc_id` on every materialized comments document and reject
    sync/projection when the raw document identity conflicts with the expected id
- `crates/notebook-wire/src/lib.rs`
  - add `frame_types::COMMENTS_DOC_SYNC = 0x0a`
  - add `NotebookFrameType::CommentsDocSync`
  - give it the same initial size cap as `COMMS_DOC_SYNC` unless data says
    otherwise
  - update the exhaustive `TryFrom<u8>` and `typed_frame_size_limits` matches
    so the new byte does not fall through to the unknown-frame ceiling
- `crates/notebook-protocol/src/connection.rs`,
  `packages/runtimed/src/wire-constants.ts`,
  `packages/runtimed/tests/transport.test.ts`, and
  `apps/notebook-cloud/test/protocol.test.ts`
  - regenerate and pin the Rust/TypeScript frame constants, per-frame limits,
    display names, and client-writable table
- `crates/notebook-sync/src/shared.rs`
  - local client sync now owns a `CommentsDoc` sync target plus
    `comments_peer_state`
  - local clients seed that target from daemon-advertised
    `ProtocolCapabilities.comments_doc_id`; file-backed rooms use a UUID
    `notebook_id` on the wire but a path-derived `comments_doc_id` for the
    sidecar
  - it receives/generates comments sync frames after daemon materialization
- `crates/notebook-sync/src/sync_task.rs`
  - dispatch inbound `CommentsDocSync`
  - include comments in side-document sync confirmation once materialized
  - expose comments projection, current comment heads, and create/reply
    mutation helpers through the local handle; MCP builds list/create/reply and
    read resources on top of those helpers
  - frontend/UI-facing observables live in the WASM/frontend layer; direct
    `get_comments_for_cell` convenience remains future only if the app shell
    needs it
- `packages/runtimed/src/wire-constants.ts`,
  `packages/runtimed/src/request-types.ts`, and protocol-contract tests
  - generated TypeScript pins `COMMENTS_DOC_SYNC = 0x0a` and the daemon
    authority request types used by local MCP clients
  - browser/local desktop paths now extend `SyncableHandle`, `FlushDocKey`,
    flush/reply/cancel paths, delivery tracking, observables, and `FrameEvent`
    variants for comments sync so the UI can materialize comment projections
- `crates/runtimed/src/notebook_sync_server/room.rs`
  - add a room-owned `comments` document handle
  - load/save it from the local comments sidecar store
- `crates/runtimed/src/notebook_sync_server/peer_loop.rs`
  - send initial comments sync after notebook/runtime/comms
  - subscribe to comments broadcasts
  - dispatch inbound `CommentsDocSync` frames
- `crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs`
  - runtime agents do not participate in CommentsDoc sync; explicit
    `CommentsDocSync` frames on this channel are dropped
- `crates/runtimed/src/notebook_sync_server/peer_comments_sync.rs`
  - reuse `peer_comms_sync.rs` mechanics for decoding, actor validation,
    recovery, replies, and broadcasts, but not its authorization policy
  - allow tentative local-first comment mutations to sync
  - keep runtime_peer out of comment mutation authority
  - route request/MCP authority handling through daemon-authored policy fields
    for accept/reject and resolve/reopen
- `apps/notebook-cloud/src/protocol.ts`
  - add `COMMENTS_DOC_SYNC` to known frame names and size limits
  - keep it non-client-writable until hosted room materialization can enforce
    comments-specific mutation policy; revisit empty sync negotiation when the
    hosted `CommentsDoc` stream lands
- `apps/notebook-cloud/src/notebook-room.ts`
  - admit `COMMENTS_DOC_SYNC` through the same sync-frame prefilter as
    notebook/runtime/comms
  - keep scope handling explicit: viewers and runtime peers may negotiate sync
    but cannot commit comment changes; editors and owners can create tentative
    comment changes subject to authority finalization
- `apps/notebook-cloud/src/room-materializer.ts`
  - checkpoint comments bytes and heads with notebook/runtime/comms
  - route `COMMENTS_DOC_SYNC` through `isMaterializedSyncFrame`
  - include a sanitized frozen comments projection in published revisions only
    when publication policy explicitly opts in; do not publish raw CommentsDoc
    bytes as the public artifact
- `apps/notebook-cloud/viewer/live-sync.ts`
  - include comments sync methods in the cloud handle adapter and recoverable
    rejection handling, mirroring the CommsDoc deployed-WASM tolerance pattern
- `crates/runtimed-wasm/src/lib.rs`
  - add browser `NotebookHandle` and `RoomHostHandle` methods for comments sync,
    save/load, heads, and projection
  - add WASM sync state, `FrameEvent` variants, `receive_frame` routing,
    `flush_comments_doc_sync`, `cancel_last_comments_doc_flush`, and
    `generate_comments_doc_sync_reply`
  - do not give `RuntimeStatePeerHandle` comment mutation helpers; runtime-peer
    comments sync, if needed, is read-only negotiation through the room host
- `crates/notebook-protocol/src/protocol.rs`,
  `crates/runtimed/src/requests`, `crates/runt-mcp/src/tools`, and
  `crates/runt-mcp/src/resources.rs`
  - add first-class comment request variants, daemon handlers, MCP tools, and
    `nteract://` resource parsing/templates
- future `NotebookDoc.comments_doc_id` schema bump
  - add `CommentsDocId`, deterministic `default_comments_doc_id`, read/set/ensure
    APIs, genesis/schema verification, migration repair, and authorization tests
    matching the existing runtime/comms pointer protections

### Local-first mutation and authority finalization

Do not build a separate optimistic comment store outside Automerge. The
optimistic record should be the local `CommentsDoc` mutation itself.

The write flow:

1. UI or agent creates a tentative thread/message creation mutation in its local
   `CommentsDoc` replica with `mutation_state = "pending"` and no trusted
   authority fields yet.
2. The normal Automerge projection renders that pending state immediately. No
   separate React-side optimistic list is required.
3. The sync stream carries the tentative mutation to the local daemon or Cloud
   comments authority.
4. The authority validates scope, anchor, and causal evidence; stamps
   `authority_created_by_*`, future `authority_edited_by_*`,
   `authority_resolved_by_*`, future tombstone/archive actor fields, and related
   authority snapshots from the authenticated connection; then writes
   `authority_mutation_state = "accepted"` in the same `CommentsDoc`.
5. If validation fails, the authority writes
   `authority_mutation_state = "rejected"` plus
   `authority_rejection_reason`. The UI can display or collapse the rejected
   pending item, again from `CommentsDoc`.

For v0, `mutation_state` models creation finalization for threads and messages.
Acceptance/rejection snapshots the body, anchor, position, author, and timestamp
into authority-authored fields, and trusted projection reads those snapshots.
Later client-authored body edits remain Automerge content changes, but they do
not alter accepted/rejected projections until a future edit-moderation operation
is modeled and authority-finalized. Resolve, reopen, delete, and archive are
policy transitions: they must either be written by the authority through request
handling, or represented as pending operations until the authority writes
`authority_status`, authority-authored timestamp, tombstone, and actor fields.
The authority must not accept policy transitions by doing nothing, because that
would make client-authored policy fields durable truth by projection. If
body-edit moderation needs stronger UX later, add per-action pending operations;
do not overload the object-level creation state.

MCP tools and future UI commands are surfaces over the same state transition.
Human UI actions should perform the local tentative mutation before any authority
round trip. Agent tools may ask the local handle to create the tentative
Automerge mutation on their behalf, then call daemon authority requests to
accept, reject, resolve, or reopen. None of these surfaces should maintain a
second optimistic representation.

The landed local daemon request surface owns authority finalization and thread
status transitions:

```text
AcceptCommentThread {
  thread_id: Str
  message_id: Str
  observed_comments_heads: [Str]
}

RejectCommentThread {
  thread_id: Str
  message_id: Str
  reason: Str
  observed_comments_heads: [Str]
}

AcceptCommentMessage {
  thread_id: Str
  message_id: Str
  observed_comments_heads: [Str]
}

RejectCommentMessage {
  thread_id: Str
  message_id: Str
  reason: Str
  observed_comments_heads: [Str]
}

ResolveCommentThread {
  thread_id: Str
  observed_comments_heads: [Str]
}

ReopenCommentThread {
  thread_id: Str
  observed_comments_heads: [Str]
}
```

These requests return the existing `NotebookResponse::Ok` or
`NotebookResponse::Error`. Thread/message creation and reply creation are not
`NotebookRequest` variants in the first local slice; they are local-first
`CommentsDoc` mutations sent over comments sync, followed by one of the
authority finalization requests above.

The existing `NotebookRequestEnvelope.required_heads` only guards `NotebookDoc`.
For comments, use explicit `observed_comments_heads` in the request payload or
extend the envelope later with per-document required heads. In the landed local
handler these heads are required: the daemon rejects empty or unknown heads,
rejects stale content for accept/reject, and rejects status transitions unless
the observed trusted authority status still matches the requested transition.

Authorization policy for the first implementation:

- create/reply pending content over comments sync: editor or owner.
- content finalization: original author principal or owner.
- resolve/reopen: editor or owner, through authority requests with observed
  comments heads.
- edit body, delete message: future pending-operation work, not trusted v0
  projection.
- runtime_peer: no comment mutation.
- reply to a resolved thread reopens it with host/daemon-stamped
  `authority_status = "open"` and `authority_reopened_*` fields while recording
  the reply author on the new message.

Frame-level policy for `COMMENTS_DOC_SYNC = 0x0a`:

| Scope | Empty sync negotiation | Non-empty comment changes | Policy-field finalization |
|---|---:|---:|---:|
| `viewer` | allowed | rejected | rejected |
| `editor` | allowed | pending content mutations allowed | rejected |
| `owner` | allowed | pending non-authority content mutations allowed; moderation/status uses daemon requests | rejected unless acting as the room comments authority |
| `runtime_peer` | allowed | rejected | rejected |
| local daemon / Cloud comments authority | allowed | allowed | allowed |

The table is deliberately stricter than a generic protocol-helper
`client writable` flag. Local room ingress can allow editor/owner pending
comment changes because `peer_comments_sync.rs` inspects changes and scope; the
hosted helper currently keeps `COMMENTS_DOC_SYNC` non-client-writable until the
room materializer has equivalent comments policy.

Room ingress must also authenticate the connection principal to the Automerge
actor id before accepting authority-authored comment fields. The `comments-doc`
crate can project only fields authored by configured authority actor ids, but it
cannot prove that a remote peer was allowed to use that actor id.

### Sync policy

`CommentsDocSync` is the replication path for both pending client-authored
comment state and authority finalization. The policy line is not "no non-empty
client sync"; it is "client-authored policy fields are tentative until the
authority finalizes them."

Prototype policy:

- Local desktop and Cloud both render pending comments from `CommentsDoc`.
- Empty sync frames remain normal. They carry heads/have/need and no document
  changes.
- Non-empty editor/owner sync frames may create or update pending comment state;
  viewer and runtime-peer changes are rejected.
- The daemon/Cloud comments authority owns transition from pending to accepted or
  rejected, and owns durable author/scope fields.
- If a client writes policy fields directly, the projection treats them as
  unverified until an authority-authored change confirms them.
- Agents use the same local-first/state-finalization model as humans. MCP tools
  should operate through the daemon so agent comments land in `CommentsDoc` and
  receive the same authority finalization.
- Rejected or abandoned pending creations are not archival comment history. The
  authority owns cleanup policy and may tombstone or hard-delete them after the
  originating client observes the rejection or after a bounded timeout.

This mirrors the identity ADR: authorization uses authenticated principal and
scope; operator labels and display names are attribution, not authority.

### Attribution projection

Durable author fields are the fast path for display, but they should not be the
only integrity signal. The comments projection should also derive per-message
edit attribution from the validated Automerge change actor.

The repo already has the pieces for this pattern:

- `notebook_doc::diff::extract_change_actors` extracts actors from changes after
  a head range is applied.
- The sync ingress paths validate change actors against the authenticated
  connection principal before accepting client-authored changes.
- The notebook materialization pipeline already computes head-range diffs such
  as `CellChangeset`.
- `notebook-actor-projection.ts` turns actor labels into stable principal,
  operator, agent, and display projections.

`CommentsDoc` should add a sibling projection, not a render-time history walk:

```text
CommentProjection/
  threads/{thread_id}/messages/{message_id}/
    authority_created_by_actor_label # durable, host/daemon-stamped or imported
    authority_created_by_authority
    last_writer_actor_label         # derived from validated Automerge actor
    last_writer_authority           # "validated_change_actor" | "unknown"
    attribution_mismatch: Bool      # stamped field disagrees with actor evidence
```

The projection can tag `last_writer_actor_label` while applying
`CommentsDoc` sync changes, or through a WASM helper similar to `diff_cells` that
returns object-path to last-writer actor for the comments head range. The result
is memoized by `CommentsDoc` heads alongside `commentsByCellId`.

This matters for permissive Cloud convergence. Pending client-authored
Automerge changes can render immediately, but the UI should prefer the validated
`last_writer_actor_label` for "edited by" display and treat durable author fields
as fast-path data that becomes trusted only when authority-finalized. Principal
level change actors are verified; operator-level human-vs-agent labels remain
advisory unless they were host/daemon-stamped during finalization.

## MCP Surface

Expose a small comment tool/resource surface on top of the active MCP notebook
session. For explicit selection, future hosted/local variants should use the
same target model as `connect_notebook`: local `path`, local/hosted
`notebook_id`, optional hosted `domain`, or a hosted `target` URL. Path-only
selection is local; hosted comments are stamped from the hosted credential
principal and the locally configured operator.

The current local MCP implementation exposes:

```text
list_comments(cell_id?, include_resolved?) -> projected threads
create_comment_thread(anchor, body, after_thread_id?) -> thread_id, message_id
reply_comment_thread(thread_id, body, after_message_id?) -> message_id
resolve_comment_thread(thread_id) -> projected thread
reopen_comment_thread(thread_id) -> projected thread
```

`list_comments` exists because many MCP clients still surface tools better than
resources; the durable read path is also available as
`nteract://notebooks/{notebook_id}/comments`. `create_comment_thread` and
`reply_comment_thread` create pending `CommentsDoc` mutations with the MCP
process' stable local actor label, capture `observed_comments_heads`, and call
the daemon authority to accept the thread/message. Resolve and reopen tools also
route through daemon authority requests after capturing current comments heads;
they are not raw client writes.

The stable actor label is the durable change identity. `peer_label` remains a
display/presence label and must not be used as the Automerge actor for comment
authorship; otherwise two MCP clients that choose the same display name could
collide in durable history.

Delete/edit tools are intentionally not exposed by the first MCP slice. They are
policy transitions and must route through daemon or hosted-room request handling
so the comments authority writes tombstone, timestamp, and actor fields.
Resolve/reopen are exposed only because they already use daemon request handling
and authority-authored `authority_status` / `authority_reopened_*` /
`authority_resolved_*` fields.

Mutating tools should use the same pending-then-finalized model as human UI
actions so agent comments have the same durable authorship and ACL behavior as
human comments. The local daemon stamps accepted comments with the local
comments-authority actor (`runtimed:comments`) and the pending author actor it
validated. A hosted room stamps accepted comments from the authenticated hosted
principal; the local MCP process supplies only the operator suffix for
attribution and must not substitute a local principal for hosted authority.

Reads follow the repo's newer MCP resource direction rather than landing only as
a tool that immediately needs migration. They use the local `nteract://`
resource namespace from `mcp-resource-addressing.md`, not a standalone comment
scheme that looks like a room locator:

```text
nteract://notebooks/{notebook_id}/comments
nteract://notebooks/{notebook_id}/cells/{cell_id}/comments
nteract://notebooks/{notebook_id}/comments/threads/{thread_id}
```

The implemented read resources return projected `CommentsDoc` JSON for the whole
notebook, threads badged on a cell, or a single thread. Path inputs belong on
mutating tools and `connect_notebook`-style session selection; resource URIs
address already-visible notebooks by percent-encoded notebook id and
comment/cell/thread ids.

Per-actor read/unread state is an explicit non-goal for the first spike. Agents
will eventually want "new since I last looked" and "unaddressed for me," but that
state is per-principal and high-churn. It likely belongs in a per-principal
sidecar or future lightweight doc, not in the shared durable `CommentsDoc`.

## UI Plan

Build the first UI as a shared notebook component, not a cloud-only overlay.
The local desktop/browser prototype now consumes the WASM comments projection,
exposes an all-comments rail, and lets selected source prose/code create
source-range anchors with quoted snippets. Notebook-body cell markers, focused
thread popovers outside the rail, inline source highlights, output-anchor
markers, stale/deleted-anchor treatment, and hosted parity remain follow-up
work.

Placement:

- Materialize `CommentsDoc` into `commentsByCellId`, `notebookThreads`,
  `staleThreads`, and counts through a comments projection hook.
- Pass future comment markers into existing cell chrome instead of adding
  cell-like siblings. `CellContainer` already has a right action overlay and
  `data-cell-id` markers.
- Use the comments rail/panel for the first local UI; focused popovers can layer
  on later once body markers exist.
- For cell-range anchors, draw a parent-owned overlay by measuring
  `[data-cell-id]` elements. Do not insert extra rows into `NotebookView`.
- For source-range anchors, keep the selection button and quoted snippet path;
  a later CodeMirror extension can render inline highlights.
- For output anchors, place markers in `outputRightGutterContent` so the comment
  tracks the output row, not the code row.

Stable DOM order matters: `NotebookView` renders cells in sorted ID order and
uses CSS `order` for visual order. Comment UI must be markers, overlays,
popovers, or panels around existing cells. It must not change the cell iteration
order or add keyed cell-like siblings that move with visual order.

## Local And Hosted Persistence

Local desktop:

1. On room open, resolve `NotebookCommentLocator`.
2. Load `CommentsDoc` from sidecar by `comments_doc_id`, or create seeded
   genesis bytes if missing.
3. Debounce saves independently from `.ipynb` saves.
4. On save-as, rebind local path locator and keep the same comments doc when the
   save is clearly a rename or promotion from untitled.
5. On room eviction, keep file-backed comments; keep untitled comments only if
   the notebook itself has durable untitled persistence.

Cloud hosted:

1. Durable Object loads `CommentsDoc` alongside notebook/runtime/comms.
2. Checkpoint stores comments bytes and comments heads.
3. Published snapshots include a sanitized frozen comments projection if the
   publication policy allows comments; they do not expose raw CommentsDoc bytes
   as the public artifact.
4. Published public viewers receive a frozen read-only comments projection if
   comments are published; they do not subscribe to live comments sync.
5. Editor/owner comment mutations route through host request handling and ACL
   checks.

Publication policy should be explicit. Notebook comments may include private
review notes, agent traces, or unresolved critique. Default should be "not
included in public publish snapshots" until the product has a clear control.

## Clone, Save-As, Import, And Publish Boundaries

These boundaries should not all copy comments the same way.

Save-as:

- Save-as is the same room rebound to a new path.
- Comments stay with the room.
- The local sidecar store must follow the existing `comments_doc_id`; it must not
  orphan comments by recomputing `comments:local-path:<sha256(new_path)>` and
  treating that as a fresh document.

Clone:

- Clone is a new room with a new notebook UUID.
- Default clone behavior should create a fresh empty `CommentsDoc`, matching the
  existing clone behavior that drops outputs and runtime session state.
- If a future clone operation opts into comments, replay comments as fresh
  mutations into the new `CommentsDoc`. Never byte-fork the source comments doc,
  because that would share Automerge history and actor lineage across rooms.
- Imported clone comments should carry an imported-authority label in
  `authority_created_by_authority`. Output-anchored comments should be dropped
  or hard-marked stale because clone has no source outputs.

Local-to-Cloud promotion or import:

- Imported local comments should not be rejected, and they should not become
  indistinguishable from Cloud-host-stamped comments.
- Relabel imported author authority to an imported-authority label unless the
  Cloud host can map the source local principal to an authenticated Cloud
  principal.
- Import must not carry raw local Automerge actor history into the hosted room.
  Either replay imported comments as fresh destination-space changes or store
  them as sanitized projection data with imported authority labels.

Published snapshots:

- Comments are excluded by default.
- If included, the publish artifact receives a frozen comments projection at the
  published heads.
- Public viewers do not subscribe to live comments sync and cannot write back.
- Publish may redact or coarsen author labels and display names.
- Published comments follow the identity ADR's publish boundary: the public
  artifact does not preserve source Automerge history or raw local actor labels.
  The destination records who published the snapshot and may include sanitized,
  imported comment projection fields only when the publish policy opts in.

## Implementation Plan

Phase 0: ADR alignment

- Land this decision as an ADR before implementation.
- Keep `document-split.md` and the ADR register count-neutral: `CommentsDoc`
  becomes another notebook-room document alongside `NotebookDoc`,
  `RuntimeStateDoc`, and `CommsDoc`, while `PoolDoc` remains daemon-scoped.
- Keep this ADR aligned with `mcp-resource-addressing.md`: comment read
  resources live under `nteract://notebooks/{notebook_id}/comments...` and
  `nteract://notebooks/{notebook_id}/cells/{cell_id}/comments`.
- Keep neighboring docs explicit about landed slices versus future authority/UI
  work so agents do not treat stale punch-list prose as the current state.

Phase 1: schema and projection

- Add `CommentsDoc` type with schema seed, load/save, heads, sync helpers, and
  typed mutation methods. (Landed.)
- Ship a committed `comments_doc_genesis_v1.am` asset following the existing
  schema-evolution and genesis-byte convention. (Landed.)
- Add a comments changeset/projection surface that can derive per-message
  `last_writer_actor_label` from validated Automerge change actors and cache it
  by `CommentsDoc` heads.
- Add unit tests for create thread, reply ordering, concurrent inserts into the
  same fractional-index gap, resolve/reopen, stale cell anchor projection,
  projection keys, clone/import authority, last-writer attribution, durable-field
  mismatch detection, and deterministic sorting by `(position, id)`.
- Keep it pure Rust with no UI dependency.

Phase 2: local sync and MCP

- Add `COMMENTS_DOC_SYNC`. (Landed.)
- Wire `SharedDocState`, daemon room state, initial sync, peer broadcasts, and
  sidecar persistence. (Landed for local daemon notebook peers.)
- Add request variants and daemon handlers that finalize actor labels and own
  resolve/reopen policy transitions. (Landed for accept/reject thread/message
  creation and resolve/reopen; delete/edit remain future policy work.)
- Add local MCP `list_comments`, `create_comment_thread`, and
  `reply_comment_thread` tools for the active session. (Landed.)
- Add local MCP `resolve_comment_thread` and `reopen_comment_thread` tools that
  route through daemon authority requests. (Landed.)
- Add `nteract://notebooks/{notebook_id}/comments`,
  `nteract://notebooks/{notebook_id}/cells/{cell_id}/comments`, and
  `nteract://notebooks/{notebook_id}/comments/threads/{thread_id}` read
  resources for connected or parked sessions. (Landed.)
- Add explicit target resolution for non-active-session mutating tools.
- Ensure save-as follows the existing `comments_doc_id` instead of recomputing a
  path-hash key. (Landed for local SaveNotebook promotion/save-as.)

Phase 3: UI prototype

- Add an all-comments rail/panel. (Landed for the local desktop/browser
  prototype.)
- Add selected source prose/code comment affordances with source-range anchors
  and quoted snippets. (Landed.)
- Render cell comment markers in the existing cell chrome.
- Add a focused thread popover from body markers.
- Include stale/deleted-anchor handling.
- Render stamped authorship plus derived `last_writer_actor_label` for edit
  attribution, with a visible mismatch/unknown state for imported or raw changes.
- Validate moves do not reload iframes or violate stable DOM order.

Phase 4: hosted room host

- Extend `RoomHostHandle`, `RoomMaterializer`, checkpoint metadata, and snapshot
  storage.
- Route Cloud mutations through the comments authority so pending comments are
  finalized with stamped author authority.
- Add published snapshot policy for comments, defaulting to excluded.
- Add Cloud protocol tests that prove viewer/runtime-peer connections can do
  empty sync negotiation but cannot commit comment mutations.

Phase 5: portable identity

- Add `comments_doc_id` to notebook metadata or NotebookDoc root in a schema bump.
- Provide import/export for adjacent `.comments.automerge` files if needed for
  Git-based review workflows.
- Add clone/import options if product wants to carry comments across forks.

## Risks And Open Questions

- Path identity is weak under rename/move until the notebook carries an explicit
  `comments_doc_id`.
- `comments_doc_id` cannot remain "nice to have" after comments exist. A local
  v0 path-derived id is acceptable as a resolver input, but the created
  `CommentsDoc` must carry a stable id and implementation code must not silently
  create a second comments doc for the same notebook.
- Client-authored CRDT writes can spoof durable author fields unless the
  projection treats them as pending/unverified until authority-finalized.
- Public publish behavior needs product controls. The architectural default is
  exclusion; remaining product decisions are the opt-in control, redaction
  policy, and frozen projection format.
- `COMMENTS_DOC_SYNC = 0x0a` is currently free, but every generated binding,
  exhaustive cap table, client-writable gate, materialized-routing switch, and
  protocol test must move together. The local branch wires these pieces for
  local daemon peers and keeps hosted Cloud client-writable policy disabled until
  the room materializer can enforce comments policy.
- MCP resource naming can regress if comments use a standalone scheme. Keep read
  resources under `nteract://` and reserve room locators for connection targets.
- Source-range anchoring needs a real editor integration if line/column plus
  quote context is not good enough.
- Comment document tombstones can grow. Keep the active doc coarse-grained, but
  reserve a future archive/export-and-truncate story for resolved/deleted
  threads. If needed, use an active `CommentsDoc` plus a coarse archive doc, not
  one doc per thread.
- Agents need clear UX affordances so agent comments do not look like kernel
  output, presence, or execution status.
- Per-actor read/unread state is intentionally out of scope for the first spike
  and needs a separate sidecar/projection design.

## Minimal Spike Definition

A useful first local/MCP spike is:

1. `CommentsDoc` crate/module with create/reply/resolve/reopen,
   `source_range` anchors, fractional ordering, required `comments_doc_id`,
   sync helpers, and authority-aware projection.
2. Local daemon sidecar load/save keyed by `comments_doc_id`, with canonical path
   used only as the v0 resolver/index input, plus local `CommentsDocSync` for
   editor/owner clients and explicit runtime-peer/runtime-agent denial.
3. `list_comments`, `create_comment_thread`, `reply_comment_thread`,
   `resolve_comment_thread`, and `reopen_comment_thread` MCP tools plus
   `nteract://` comment read resources for notebook, cell, and thread views.
4. A shared local comments rail that supports document comments, displays
   document/cell/source threads, creates selected source comments from
   CodeMirror and host-rendered Markdown prose, focuses the composer on draft
   creation, and preserves stable cell DOM order.
5. Pending client-authored comments live in `CommentsDoc`; authority
   finalization is required before treating author/scope/status fields as
   durable truth.

That spike proves the storage identity, CRDT shape, author stamping, agent API,
local desktop product loop, MCP resource shape, and stable-DOM-safe UI. It
deliberately stops before hosted Cloud materialization, public publish,
delete/edit tools, per-actor read/unread state, body markers, focused popovers,
inline source highlights, output-anchor markers, and stale/deleted-anchor
treatment.
