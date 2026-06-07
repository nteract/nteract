# Notebook Comments Prototype

Status: research prototype, 2026-06-07

This note proposes a comment system for nteract notebooks that works in local
desktop rooms and Cloud hosted rooms, lets humans and agents participate through
the same API, and keeps comment state aligned with the existing Automerge
document split.

## Short Decision

Create a fourth per-notebook Automerge document, `CommentsDoc`, instead of
storing comments in `NotebookDoc` cells or in `RuntimeStateDoc`.

`CommentsDoc` is durable collaboration state with different write frequency,
authority, fan-out, persistence, and UI projection from cells, outputs, widgets,
or runtime lifecycle. It should sync over its own typed frame, likely
`COMMENTS_DOC_SYNC = 0x0a`, while user-facing mutations should go through
request-stamped operations such as `create_comment`, `reply_comment`, and
`resolve_comment`. The room host or daemon stamps author identity from the
authenticated connection, mutates `CommentsDoc`, and then broadcasts the resulting
Automerge sync frames.

## Source Constraints

Automerge's own docs frame the important granularity rule: a document is the
unit of collaboration for a small group, and many thousands of tiny documents
carry sync overhead. The same docs also warn that replacing whole arrays or text
values produces coarse merge behavior; fine-grained Automerge maps and text
objects should be mutated in place instead. Source:
https://automerge.org/llms-full.txt

nteract already follows the same shape:

- `docs/adr/three-document-split.md` says the split is load-bearing for
  bandwidth, write-frequency isolation, fan-out, persistence, and trust.
- `NotebookDoc` carries durable cells keyed by `cell_id`, with fractional
  `position` strings for order.
- `RuntimeStateDoc` carries kernel, execution, output, env, trust, project, and
  live output/widget topology state.
- `CommsDoc` is already a per-notebook side document for mutable widget comm
  state.
- `PoolDoc` is daemon-level, not notebook-level.
- `docs/adr/identity-and-trust.md` makes the principal the security boundary and
  the operator the attribution layer.
- `NotebookView` has a stable DOM-order invariant; comments cannot be rendered
  as extra cell rows that reorder existing cell DOM nodes.

Those constraints point to `CommentsDoc`: optional, durable, per-notebook,
multi-writer, not part of nbformat cell source, and not runtime state.

## Document Identity And Attachment

The hardest part is not the schema. It is the attachment identity.

Use a `NotebookCommentLocator` abstraction from the start:

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

For v0 local desktop, use a daemon-managed sidecar store keyed by canonical path:

```text
$DAEMON_STATE/comments/index.json
$DAEMON_STATE/comments/<comments_doc_id>.automerge
```

That avoids changing `.ipynb` metadata during the prototype and keeps comments
available after daemon restart. It does mean path moves and renames are weak in
v0. The v1 portability fix is to add `metadata.runt.comments_doc_id` or a root
`NotebookDoc.comments_doc_id` in a future notebook schema bump, then keep a path
index only as a lookup cache.

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
- Same-UID trust makes raw editor/owner `CommentsDocSync` acceptable for a
  prototype, but the main human and agent mutation path should still be
  request-stamped so the eventual Cloud behavior is identical.
- Local agents use MCP tools that resolve `notebook_id | path`, submit comment
  requests to the daemon, and read projected comments from the local doc.

Cloud hosted rooms:

- Authority is the Cloud room host, currently the Durable Object plus
  `RoomHostHandle` materializer path.
- Attachment starts from the hosted notebook id or room locator, not from a
  filesystem path.
- Persistence belongs in room checkpoints and published snapshots alongside
  notebook/runtime/comms bytes and heads.
- Raw non-empty `CommentsDocSync` should be rejected or stripped until the host
  can prove durable author fields were host-stamped. Cloud editors and agents
  should create, reply, and resolve through request APIs.
- Publication policy must be explicit. Comments should not automatically become
  part of a public notebook publish because review notes and agent comments can
  be more sensitive than notebook contents or outputs.

That means the v0 local path sidecar is intentionally an adapter detail. The
portable model is still "one comments doc attached to one notebook room," with a
future `comments_doc_id` making local files robust under rename and move.

## CommentsDoc Schema

Use maps keyed by stable IDs for lookup and use fractional indices for every
user-visible order. Do not rely on list indexes for thread or reply order.

```text
ROOT/
  schema_version: 1
  comments_doc_id: Str
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
      anchor_key: Str
      position: Str                  # fractional order among sibling threads
      status: Str                    # "open" | "resolved"
      created_at: Str
      created_by_actor_label: Str    # host/daemon stamped
      created_by_display_name: Str?  # advisory, host projected when available
      resolved_at: Str?
      resolved_by_actor_label: Str?
      messages/
        {message_id}/
          id: Str
          position: Str              # fractional reply order
          body: Text
          created_at: Str
          created_by_actor_label: Str
          edited_at: Str?
          deleted_at: Str?
  anchor_index/
    {anchor_key}/
      {thread_id}: true
```

The `anchor_index` is a projection cache inside the CRDT. It lets the UI and MCP
tools answer "what comments are on this cell?" without scanning all threads.
Because it is derived, repair is easy: a maintenance pass can rebuild it from
`threads/*/anchor_key`.

Message bodies should be Automerge `Text`, even if v0 only edits a whole comment
body at once. It keeps the schema ready for collaborative comment editing and
avoids whole-string conflict behavior.

### Anchors

Start with anchors that degrade gracefully:

```text
Notebook anchor:
  kind: "notebook"

Cell anchor:
  kind: "cell"
  cell_id: Str
  observed_cell_position: Str?
  observed_notebook_heads: [Str]?

Cell range anchor:
  kind: "cell_range"
  start_cell_id: Str
  end_cell_id: Str
  start_position: Str?
  end_position: Str?
  observed_notebook_heads: [Str]?

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
  observed_notebook_heads: [Str]?

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

## Ordering

Use the same conceptual pattern as `NotebookDoc` cell order:

- Each thread gets a `position` fractional index within its `anchor_key`.
- Each message gets a `position` fractional index within its `thread_id`.
- Sort by `(position, id)` for deterministic ties.
- Generate indices with the existing `loro_fractional_index` dependency or a
  shared helper extracted from `notebook-doc`.

This keeps concurrent replies and concurrent thread creation mergeable without
making Automerge list positions the semantic order.

## Wire And Sync

Add a `CommentsDoc` wrapper crate or module, probably alongside `runtime-doc`
first because `CommsDoc` already lives there, then move to a dedicated crate if
it grows.

Core seams:

- `crates/notebook-wire/src/lib.rs`
  - add `frame_types::COMMENTS_DOC_SYNC = 0x0a`
  - add `NotebookFrameType::CommentsDocSync`
  - give it the same initial size cap as `COMMS_DOC_SYNC` unless data says
    otherwise
- `crates/notebook-sync/src/shared.rs`
  - add `comments_doc: CommentsDoc`
  - add `comments_peer_state: sync::State`
  - expose `get_comments`, `get_comments_for_cell`, and sync confirmation helpers
- `crates/runtimed/src/notebook_sync_server/room.rs`
  - add a room-owned `comments` document handle
  - load/save it from the local comments sidecar store
- `crates/runtimed/src/notebook_sync_server/peer_loop.rs`
  - send initial comments sync after notebook/runtime/comms
  - subscribe to comments broadcasts
  - dispatch inbound `CommentsDocSync` frames
- `crates/runtimed/src/notebook_sync_server/peer_comments_sync.rs`
  - mirror `peer_comms_sync.rs` for sync mechanics
  - use editor/owner write scope, not runtime_peer
  - prefer read-only direct sync for hosted clients unless mutation stamping is
    handled by request APIs
- `apps/notebook-cloud/src/protocol.ts`
  - add `COMMENTS_DOC_SYNC` and route it as materialized sync
- `apps/notebook-cloud/src/room-materializer.ts`
  - checkpoint comments bytes and heads with notebook/runtime/comms
  - include comments snapshots in published revisions
- `crates/runtimed-wasm/src/lib.rs`
  - add `RoomHostHandle` methods for comments sync, save/load, and heads

### Request-stamped mutation path

Do not let client payloads choose durable author fields. The daemon or hosted
room host already knows the connection principal, actor label, and scope. It
should stamp those into comment mutations.

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

### Direct raw sync policy

`CommentsDocSync` is still needed for reading, local-first replication, and
offline convergence. The question is whether clients may send raw non-empty
changes.

Prototype policy:

- Local desktop can allow editor/owner raw changes while same-UID trust remains
  acceptable, but request-stamped APIs should be the primary surface.
- Hosted should reject or strip raw non-empty `CommentsDocSync` changes until the
  host can prove new author fields were stamped by the host. Otherwise a client
  can write fake `created_by_actor_label` values even if the frame actor label
  itself passes principal validation.
- Agents should use the same request API as humans. MCP tools should call
  requests, not mutate the CRDT directly.

This mirrors the identity ADR: authorization uses authenticated principal and
scope; operator labels and display names are attribution, not authority.

## MCP Surface

Expose a small tool set once the daemon can mutate `CommentsDoc`:

```text
create_comment(notebook_id | path, anchor, body) -> thread_id, message_id
reply_comment(notebook_id | path, thread_id, body) -> message_id
resolve_comment(notebook_id | path, thread_id) -> ok
reopen_comment(notebook_id | path, thread_id) -> ok
list_comments(notebook_id | path, anchor_filter?, include_resolved?) -> threads
```

`list_comments` can read a projected snapshot from `CommentsDoc`. Mutating tools
go through the request-stamped path so agent comments have the same durable
authorship and ACL behavior as human comments.

## UI Prototype

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
3. Published snapshots include comments bytes if the publication policy allows
   comments.
4. Public viewers receive read-only comments sync if comments are published.
5. Editor/owner comment mutations route through host request handling and ACL
   checks.

Publication policy should be explicit. Notebook comments may include private
review notes, agent traces, or unresolved critique. Default should be "not
included in public publish snapshots" until the product has a clear control.

## Prototype Plan

Phase 1: schema and projection

- Add `CommentsDoc` type with schema seed, load/save, heads, sync helpers, and
  typed mutation methods.
- Add unit tests for create thread, reply ordering, resolve/reopen, stale cell
  anchor projection, and deterministic sorting by `(position, id)`.
- Keep it pure Rust with no UI dependency.

Phase 2: local sync and MCP

- Add `COMMENTS_DOC_SYNC`.
- Wire `SharedDocState`, daemon room state, initial sync, peer broadcasts, and
  sidecar persistence.
- Add request variants and daemon handlers that stamp actor labels.
- Add MCP tools using notebook ID or path resolution.

Phase 3: UI prototype

- Render cell comment markers in the existing right gutter.
- Add a popover thread view and an all-comments panel.
- Include stale/deleted-anchor handling.
- Validate moves do not reload iframes or violate stable DOM order.

Phase 4: hosted room host

- Extend `RoomHostHandle`, `RoomMaterializer`, checkpoint metadata, and snapshot
  storage.
- Enforce hosted raw-sync write policy.
- Add published snapshot policy for comments.

Phase 5: portable identity

- Add `comments_doc_id` to notebook metadata or NotebookDoc root in a schema bump.
- Provide import/export for adjacent `.comments.automerge` files if needed for
  Git-based review workflows.

## Risks And Open Questions

- Path identity is weak under rename/move until the notebook carries an explicit
  `comments_doc_id`.
- Hosted raw CRDT writes can spoof durable author fields unless host-stamped
  request mutations are the only write path.
- Public publish behavior needs a product decision. Comments are not obviously
  safe to publish with notebook outputs.
- Source-range anchoring needs a real editor integration if line/column plus
  quote context is not good enough.
- Comment document tombstones can grow. We will eventually need compaction or an
  archive/export story for resolved/deleted threads.
- Agents need clear UX affordances so agent comments do not look like kernel
  output, presence, or execution status.

## Minimal Spike Definition

A useful first spike is:

1. `CommentsDoc` crate/module with create/reply/resolve and fractional ordering.
2. Local daemon sidecar load/save keyed by canonical path.
3. `create_comment`, `reply_comment`, `resolve_comment`, and `list_comments` MCP
   tools.
4. Notebook UI markers for cell-level comments only.
5. No hosted raw writes, no source-range inline highlights, no public publish.

That spike proves the storage identity, CRDT shape, author stamping, agent API,
and stable-DOM-safe UI without committing to the hardest anchoring problem.
