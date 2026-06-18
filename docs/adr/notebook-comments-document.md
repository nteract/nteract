# Notebook Comments Document

**Status:** Draft, 2026-06-07. Updated 2026-06-16.

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

`CommentsDoc` is durable collaboration state with different durability,
attachment, fan-out, and publish policy from cells, outputs, widgets, or runtime
lifecycle. It should sync over its own typed frame. The next available byte on
current main is `COMMENTS_DOC_SYNC = 0x0a`; adding it is an exhaustive wire
change, not only a constant.

Comments are plain authored Automerge changes. A client writes a comment into
its local `CommentsDoc` replica and it renders immediately from local heads, no
request round trip. There is no daemon "finalization" step and no parallel
authority keyspace in the document. Attribution (who authored a thread or
message, who resolved it) is read from the Automerge change author at projection
time, not from stored fields. That is trustworthy because the sync ingress binds
each connection to its own actor id before admitting its changes, so a peer
cannot author a change as someone else. The trust boundary is the ingress gate,
which lives in the sync layer; this crate only reads attribution from actor ids
already admitted into the document.

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
  `crates/notebook-wire/src/lib.rs` currently stops at `COMMS_DOC_SYNC = 0x09`,
  generated TypeScript constants and protocol tests pin that table, and both the
  daemon and Cloud room host dispatch notebook/runtime/comms streams explicitly.
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
  comments_doc_id: "comments:path:<sha256(canonical_path)>"

Local untitled notebook:
  kind: "local_room"
  room_id: "<uuid>"
  comments_doc_id: "comments:room:<uuid>"
```

For v0 local desktop, use a daemon-managed sidecar resolver index from canonical
path or room id to `comments_doc_id`, and store the document bytes by
`comments_doc_id`:

```text
$DAEMON_STATE/comments/index.json
$DAEMON_STATE/comments/<comments_doc_id>.automerge
```

That avoids changing `.ipynb` metadata during the prototype and keeps comments
available after daemon restart. It does mean path moves and renames are weak in
v0. The v1 portability fix is to add `metadata.runt.comments_doc_id` or a root
`NotebookDoc.comments_doc_id` in a future notebook schema bump, make that
association required for notebooks with comments, then keep a path index only as
a lookup cache.

An adjacent file such as `notebook.ipynb.comments.automerge` is attractive for
Git portability, but it has product tradeoffs: hidden files appear next to every
notebook and save-as behavior becomes observable outside nteract. Treat it as an
export/import option, not the first local storage backend.

## Local Desktop Vs Cloud Hosted Rooms

The same `CommentsDoc` schema should run in both places, but the attachment,
ingress, and persistence rules differ.

Local desktop:

- The local daemon serving a notebook room is the sync ingress gate for the
  local socket.
- Attachment starts from either a canonical file path or an untitled room UUID.
  File-backed comments need a path sidecar until the notebook carries a durable
  `comments_doc_id`.
- Same-UID trust makes local convergence forgiving. The UI writes comment
  mutations into the local `CommentsDoc` so Automerge owns the immediate visible
  state. The daemon admits a change only when its actor matches the connection
  actor and the connection scope may comment.
- Local agents use MCP tools that resolve `notebook_id | path`, submit comment
  commands to the daemon, and read projected comments from the local doc.

Cloud hosted rooms:

- The Cloud room host, currently the Durable Object plus `RoomHostHandle`
  materializer path, is the sync ingress gate for hosted connections.
- The ingress path may later be a separate comments Durable Object keyed by
  `comments_doc_id`. The protocol should expose a comments document attached to
  a notebook room, not the Cloud storage topology.
- Attachment starts from the hosted notebook id or room locator, not from a
  filesystem path.
- Persistence belongs in room checkpoints and published snapshots alongside
  notebook/runtime/comms bytes and heads.
- Cloud editors and agents create, reply, edit, delete, and resolve as
  authored `CommentsDoc` changes that render immediately. Hosted ingress admits
  each change only when the change actor matches the authenticated connection
  actor and the connection scope may perform the operation.
- Runtime peers are readers of comments. A `runtime_peer` may need empty sync
  negotiation to keep a shared document set connected, but it must not create,
  edit, resolve, or reopen comment state.
- Publication policy must be explicit. Comments should not automatically become
  part of a public notebook publish because review notes and agent comments can
  be more sensitive than notebook contents or outputs.

Published notebook snapshots:

- Published notebooks are a third artifact class, separate from local rooms and
  live Cloud rooms.
- Comments are off by default for public publish.
- If comments are published, they are a frozen read-only projection at publish
  heads, not a live comments sync subscription.
- Published attribution may need redaction or coarsening because actor labels
  and display names can expose internal reviewers.

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
    kind: Str
    value: Str
    path: Str?                       # local file-backed evidence
    runtime_state_doc_id: Str?       # association evidence, not authority
  threads/
    {thread_id}/
      id: Str
      anchor/
        kind: Str
        ...anchor fields...
      position: Str                  # fractional order in the projection scope
      status: Str                    # "open" | "resolved"
      created_at: Str
      resolved_at: Str?              # set when resolved
      messages/
        {message_id}/
          id: Str
          position: Str              # fractional reply order
          body: Text
          created_at: Str
```

The document stores comment content and shared state. It does not store author,
resolver, or trust fields. Those are read from change authorship at projection
time (see below).

Do not store a derived `anchor_index` inside `CommentsDoc`. It would add synced
bytes for data that is a pure function of `threads/*/anchor`, and concurrent
re-anchoring could leave stale denormalized entries. Build `commentsByCellId` and
other indexes in the projection layer, memoized by `CommentsDoc` heads if scans
ever become hot.

Message bodies should be Automerge `Text`, even if v0 only edits a whole comment
body at once. It keeps the schema ready for collaborative comment editing and
avoids whole-string conflict behavior.

#### Attribution is read from change authorship, not stored

A stored author field would be worthless. In raw CRDT convergence any
editor-scope peer can write any field, so a `created_by = "Ada"` is a
self-asserted claim a malicious client could set to a victim. So attribution is
not stored. It is read from the Automerge change that authored the object or
wrote the winning value:

- A thread's or message's author is the actor that created the object, recovered
  from the object id (`actor_label_of`).
- A thread's resolver is the actor that wrote the current `status` value
  (`field_writer_label`).

This is trustworthy only because the sync ingress binds each connection to its
own actor id and rejects changes that claim a different one. Actor ids are not
authentication by themselves; the ingress gate is what makes them mean
something. With that gate, the actor recorded against every admitted change is
its real author, and attribution is a pure read with nothing to forge. The trust
boundary therefore lives in the sync layer, not in the document schema and not
in this crate.

`status` (`open`/`resolved`) and `resolved_at` are shared data, not attribution.
Anyone may resolve or reopen; the projection reads the current value
last-writer-wins, and who resolved is the author of that `status` change.

Imported comments should be replayed under an explicit imported-author actor id
so their attribution does not masquerade as a live participant.

If a future concept genuinely cannot be expressed by change authorship, such as
a moderation accept/reject gate that is distinct from who wrote a comment, add an
authority-stamped field for that concept alone, trusted only when authored by the
comments-authority actor. Do not add authority fields back for author identity or
resolve state; those are attribution and belong to the change author.

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
    save/load/head/sync helpers, mutation helpers, attribution projection tests,
    and ingress-policy fixtures
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
  - add `comments_doc: CommentsDoc`
  - add `comments_peer_state: sync::State`
  - add receive/generate/rebuild helpers mirroring the CommsDoc recovery path
- `crates/notebook-sync/src/sync_task.rs`
  - dispatch inbound `CommentsDocSync`
  - send outbound comment sync frames when local comment heads change
  - expose `get_comments`, `get_comments_for_cell`, and sync confirmation helpers
- `packages/runtimed/src/handle.ts` and `packages/runtimed/src/sync-engine.ts`
  - extend `SyncableHandle`, `FlushDocKey`, flush/reply/cancel paths, delivery
    tracking, observables, and tests for comments sync
  - add `FrameEvent` variants for comments sync applied/error, including a
    comments projection changeset instead of forcing UI code to rematerialize the
    full document on every frame
- `crates/runtimed/src/notebook_sync_server/room.rs`
  - add a room-owned `comments` document handle
  - load/save it from the local comments sidecar store
- `crates/runtimed/src/notebook_sync_server/peer_loop.rs`
  - send initial comments sync after notebook/runtime/comms
  - subscribe to comments broadcasts
  - dispatch inbound `CommentsDocSync` frames
- `crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs`
  - if runtime agents need CommentsDoc negotiation, add it as read-only sync
    only; runtime agents/runtime peers must not commit comments changes or
    resolve comment state
- `crates/runtimed/src/notebook_sync_server/peer_comments_sync.rs`
  - reuse `peer_comms_sync.rs` mechanics for decoding, actor validation,
    recovery, replies, and broadcasts, but not its authorization policy
  - allow local-first comment mutations from editor and owner connections to
    sync when the change actor matches the connection actor
  - reject non-empty viewer and runtime-peer comment changes at ingress
  - reject any change whose actor id does not match the authenticated connection
    actor
  - keep runtime_peer out of comment mutation permission
  - project author and resolver attribution from admitted Automerge changes
- `apps/notebook-cloud/src/protocol.ts`
  - add `COMMENTS_DOC_SYNC` to known frame names and size limits
  - mark it client-writable at the protocol-helper layer so empty sync
    negotiation can pass, then rely on room-host/materializer policy to reject
    non-empty viewer/runtime-peer mutations
- `apps/notebook-cloud/src/notebook-room.ts`
  - admit `COMMENTS_DOC_SYNC` through the same sync-frame prefilter as
    notebook/runtime/comms
  - keep scope handling explicit: viewers and runtime peers may negotiate sync
    but cannot commit comment changes; editors and owners can commit comment
    changes only as their own actor
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

### Local-first mutation

Do not build a separate optimistic comment store outside Automerge. The
optimistic record is the local `CommentsDoc` mutation itself.

The write flow:

1. UI or agent creates a thread/message in its local `CommentsDoc` replica.
2. The normal Automerge projection renders it immediately, attributed to the
   local actor. No separate React-side optimistic list is required.
3. The sync stream carries the change to peers. The ingress gate at the daemon
   or Cloud admits it only if its actor id matches the authenticated connection,
   so the change cannot claim a different author.
4. Peers project the same change. Attribution is read from the change author;
   there is no acceptance step that rewrites it.

Resolve, reopen, and body edits are ordinary authored mutations on the same
objects. `status` is last-writer-wins shared state, and who resolved is the
author of the `status` change. A body edit is a new content change attributed to
its author. There is no daemon finalization that turns a "pending" comment into
an "accepted" one, because the ingress gate already decided whether the change
was allowed in.

Requests such as `CreateComment` and MCP tools are command surfaces over the
same state transition. Human UI actions should perform the local authored
mutation before any request/response round trip. Agent, daemon, or hosted-tool
surfaces may ask the daemon/host to create the Automerge mutation on their
behalf. None of these surfaces should maintain a second optimistic
representation.

Add protocol requests:

```text
CreateComment {
  thread_id: Option<Str>
  anchor: CommentAnchor
  body: Str
  after_thread_id: Option<Str>
  observed_notebook_heads: [Str]
  observed_comments_heads: [Str]
}

ReplyComment {
  thread_id: Str
  message_id: Option<Str>
  body: Str
  after_message_id: Option<Str>
  observed_comments_heads: [Str]
}

ResolveComment {
  thread_id: Str
  observed_comments_heads: [Str]
}

ReopenComment {
  thread_id: Str
  observed_comments_heads: [Str]
}

EditCommentMessage {
  thread_id: Str
  message_id: Str
  body: Str
  observed_comments_heads: [Str]
}

DeleteCommentMessage {
  thread_id: Str
  message_id: Str
  observed_comments_heads: [Str]
}
```

Responses:

```text
CommentCreated { thread_id, message_id }
CommentReplied { thread_id, message_id }
CommentResolved { thread_id }
CommentReopened { thread_id }
CommentEdited { thread_id, message_id }
CommentDeleted { thread_id, message_id }
CommentMutationRejected { reason }
```

The existing `NotebookRequestEnvelope.required_heads` only guards `NotebookDoc`.
For comments, use explicit `observed_comments_heads` in the request payload or
extend the envelope later with per-document required heads. In v0, these heads
can be advisory conflict evidence: reject only if the target thread/message is
missing or resolved in a way that invalidates the operation.

Authorization policy for the first implementation:

- create, reply, resolve, reopen: editor or owner.
- edit body, delete message: original author principal. Owner override is a
  separate product policy decision.
- runtime_peer: no comment mutation.
- reply to a resolved thread reopens it by writing `status = "open"` and
  clearing `resolved_at` as an authored change. The reply author is read from the
  new message's creating change.

Frame-level policy for `COMMENTS_DOC_SYNC = 0x0a`:

| Scope | Empty sync negotiation | Comment changes |
|-------|------------------------|-----------------|
| `viewer` | allowed | rejected |
| `editor` | allowed | allowed, only as its own actor |
| `owner` | allowed | allowed, only as its own actor |
| `runtime_peer` | allowed | rejected |

The table is deliberately stricter than the protocol-helper `client writable`
flag. Helpers may mark `COMMENTS_DOC_SYNC` writable so empty Automerge
negotiation can pass through generic client code, but room ingress still has to
inspect `Message.changes`, the authenticated connection actor, and scope before
applying document changes.

Room ingress must bind the connection principal to its Automerge actor id before
accepting comment changes. The `comments-doc` crate can read attribution from
admitted actors, but it cannot prove that a remote peer was allowed to use a
given actor id.

### Sync policy

`CommentsDocSync` is the replication path for authored comment changes. The
policy line is not "no non-empty client sync"; it is "admit non-empty comment
changes only when their actor matches the authenticated connection and the
connection scope may comment."

Prototype policy:

- Local desktop and Cloud both render comments from `CommentsDoc`.
- Empty sync frames remain normal. They carry heads/have/need and no document
  changes.
- Non-empty editor/owner sync frames may create or update comment state only
  when the change actor matches the connection actor; viewer and runtime-peer
  changes are rejected.
- The daemon or Cloud ingress gate owns actor binding and scope enforcement
  before applying changes.
- The projection reads thread, message, edit, and resolve attribution from the
  Automerge change authors admitted by ingress.
- Agents use the same local-first authored-change model as humans. MCP tools
  should operate through the daemon so agent comments land in `CommentsDoc` under
  the authenticated actor for that connection.
- Changes rejected by ingress are not part of archival comment history because
  they are not admitted into the shared document.

This mirrors the identity ADR: authorization uses authenticated principal and
scope; operator labels and display names are attribution, not authority.

### Attribution projection

The comments projection derives attribution from admitted Automerge change
authors. It does not read author, resolver, or trust fields from the document
because the schema does not store them.

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
  threads/{thread_id}/
    author_actor_label              # actor_label_of(thread object id)
    resolver_actor_label?           # field_writer_label(thread.status), when resolved
    status_writer_actor_label       # field_writer_label(thread.status)
    messages/{message_id}/
      author_actor_label            # actor_label_of(message object id)
      body_writer_actor_label       # field_writer_label(message.body)
```

The projection can tag field writer labels while applying `CommentsDoc` sync
changes, or through a WASM helper similar to `diff_cells` that returns
object-path and field-path writer actors for the comments head range. The result
is memoized by `CommentsDoc` heads alongside `commentsByCellId`.

This matters for permissive Cloud convergence. Authored Automerge changes can
render immediately after ingress admits them, and the UI can display the same
projected actor labels for local, hosted, human, and agent comments. Principal
level change actors are verified by ingress; operator-level human-vs-agent
labels remain advisory unless they are derived from authenticated connection
metadata outside the document.

## MCP Surface

Expose a small mutating tool set once the daemon can mutate `CommentsDoc`.
Tools should default to the active MCP notebook session. For explicit selection,
they should use the same target model as `connect_notebook`: local `path`,
local/hosted `notebook_id`, optional hosted `domain`, or a hosted `target` URL.
Path-only selection is local; hosted comments are authored by the hosted
connection actor bound to the hosted credential principal.

```text
create_comment(anchor, body, target?, notebook_id?, domain?, path?) -> thread_id, message_id
reply_comment(thread_id, body, target?, notebook_id?, domain?, path?) -> message_id
resolve_comment(thread_id, target?, notebook_id?, domain?, path?) -> ok
reopen_comment(thread_id, target?, notebook_id?, domain?, path?) -> ok
```

Mutating tools use the same local-first authored-change model as human UI
actions, so agent comments have the same attribution and ACL behavior as human
comments. A local daemon authors comments as the local connection actor it
validated. A hosted room authors comments as the authenticated hosted connection
actor; the local MCP process may supply an operator suffix for display, but it
must not substitute a local principal for the hosted principal.

Reads should follow the repo's newer MCP resource direction rather than landing
as a tool that immediately needs migration. They must use the local `nteract://`
resource namespace from `mcp-resource-addressing.md`, not a standalone comment
scheme that looks like a room locator:

```text
nteract://notebooks/{notebook_id}/comments
nteract://notebooks/{notebook_id}/cells/{cell_id}/comments
nteract://notebooks/{notebook_id}/comments/threads/{thread_id}
```

The resource response can be the projected snapshot from `CommentsDoc`, including
open/resolved filters and stale-anchor metadata. Path inputs belong on mutating
tools and `connect_notebook`-style session selection; resource URIs address
already-visible notebooks by percent-encoded notebook id and comment/cell/thread
ids. A temporary `list_comments` debug tool is acceptable during the spike, but
not the target public surface.

Per-actor read/unread state is an explicit non-goal for the first spike. Agents
will eventually want "new since I last looked" and "unaddressed for me," but that
state is per-principal and high-churn. It likely belongs in a per-principal
sidecar or future lightweight doc, not in the shared durable `CommentsDoc`.

## UI Plan

Build the first UI as a shared notebook component, not a cloud-only overlay.

Placement:

- Add a comments projection hook that materializes `CommentsDoc` into
  `commentsByCellId`, `notebookThreads`, `staleThreads`, and counts.
- Pass a comment marker into existing `rightGutterContent` next to delete/hide
  controls. `CellContainer` already has a right action overlay and `data-cell-id`
  markers.
- Use a popover for the focused thread and a right-side comments panel for all
  threads.
- For cell-range anchors, draw a parent-owned overlay by measuring
  `[data-cell-id]` elements. Do not insert extra rows into `NotebookView`.
- For source-range anchors, v0 can show a cell marker plus a quoted snippet in
  the popover. A later CodeMirror extension can render inline highlights.
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
5. Editor/owner comment mutations route through host request handling, actor
   binding, and ACL checks.

Publication policy should be explicit. Notebook comments may include private
review notes, agent traces, or unresolved critique. Default should be "not
included in public publish snapshots" until the product has a clear control.

## Clone, Save-As, Import, And Publish Boundaries

These boundaries should not all copy comments the same way.

Save-as:

- Save-as is the same room rebound to a new path.
- Comments stay with the room.
- The local sidecar store must follow the existing `comments_doc_id`; it must not
  orphan comments by recomputing `comments:path:<sha256(new_path)>` and treating
  that as a fresh document.

Clone:

- Clone is a new room with a new notebook UUID.
- Default clone behavior should create a fresh empty `CommentsDoc`, matching the
  existing clone behavior that drops outputs and runtime session state.
- If a future clone operation opts into comments, replay comments as fresh
  mutations into the new `CommentsDoc`. Never byte-fork the source comments doc,
  because that would share Automerge history and actor lineage across rooms.
- Imported clone comments should be replayed under an explicit imported-author
  actor id. Output-anchored comments should be dropped or hard-marked stale
  because clone has no source outputs.

Local-to-Cloud promotion or import:

- Imported local comments should remain visible after import, and they should
  not become indistinguishable from live Cloud-authored comments.
- Replay imported comments under explicit imported-author actor ids unless the
  Cloud host can map the source local principal to an authenticated Cloud
  principal.
- Import must not carry raw local Automerge actor history into the hosted room.
  Either replay imported comments as fresh destination-space changes or store
  them as sanitized projection data with imported author labels.

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
- Treat the current lack of source implementation as intentional. Until
  `CommentsDoc` lands in code, neighboring docs may reference it only as the
  proposed sidecar in this ADR.

Phase 1: schema and projection

- Add `CommentsDoc` type with schema seed, load/save, heads, sync helpers, and
  typed mutation methods.
- Ship a committed `comments_doc_genesis_v1.am` asset following the existing
  schema-evolution and genesis-byte convention.
- Add a comments changeset/projection surface that can derive message authors,
  body writers, and status writers from validated Automerge change actors and
  cache them by `CommentsDoc` heads.
- Add unit tests for create thread, reply ordering, concurrent inserts into the
  same fractional-index gap, resolve/reopen, stale cell anchor projection,
  projection keys, clone/import attribution, change-author attribution, and
  deterministic sorting by `(position, id)`.
- Keep it pure Rust with no UI dependency.

Phase 2: local sync and MCP

- Add `COMMENTS_DOC_SYNC`.
- Wire `SharedDocState`, daemon room state, initial sync, peer broadcasts, and
  sidecar persistence.
- Add request variants and daemon handlers that create authored comment
  mutations after actor binding and scope checks.
- Add MCP mutation tools using active-session or `connect_notebook`-style target
  resolution, and comment read resources using `nteract://`.
- Ensure save-as follows the existing `comments_doc_id` instead of recomputing a
  path-hash key.

Phase 3: UI prototype

- Render cell comment markers in the existing right gutter.
- Add a popover thread view and an all-comments panel.
- Include stale/deleted-anchor handling.
- Render projected authorship, status-writer attribution, and body-writer
  attribution from admitted Automerge changes.
- Validate moves do not reload iframes or violate stable DOM order.

Phase 4: hosted room host

- Extend `RoomHostHandle`, `RoomMaterializer`, checkpoint metadata, and snapshot
  storage.
- Route Cloud comment changes through ingress actor binding and ACL checks.
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
- Attribution is read from the Automerge change author and is trustworthy only
  if the sync ingress binds each connection to its own actor id. That ingress
  gate is the load-bearing requirement and lives in the sync layer, including the
  `COMMENTS_DOC_SYNC` frame path.
- Public publish behavior needs product controls. The architectural default is
  exclusion; remaining product decisions are the opt-in control, redaction
  policy, and frozen projection format.
- `COMMENTS_DOC_SYNC = 0x0a` is currently free, but every generated binding,
  exhaustive cap table, client-writable gate, materialized-routing switch, and
  protocol test must move together. A partial wire change will look like an
  unknown frame or a broadcast-only frame in some clients.
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

A useful first spike is:

1. `CommentsDoc` crate/module with create/reply/resolve and fractional ordering.
2. Local daemon sidecar load/save keyed by `comments_doc_id`, with canonical path
   used only as the v0 resolver/index input.
3. `create_comment`, `reply_comment`, and `resolve_comment` MCP tools plus
   `nteract://` comment read resources.
4. Notebook UI markers for cell-level comments only.
5. Client-authored comments live in `CommentsDoc` as admitted Automerge changes;
   attribution is read from the change author. No source-range inline
   highlights, no public publish.

That spike proves the storage identity, CRDT shape, change-author attribution,
agent API, and stable-DOM-safe UI without committing to the hardest anchoring
problem.
