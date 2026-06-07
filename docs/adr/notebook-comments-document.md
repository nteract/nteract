# Notebook Comments Document

**Status:** Draft, 2026-06-07.

This ADR proposes a comment system for nteract notebooks that works in local
desktop rooms and Cloud hosted rooms, lets humans and agents participate through
the same API, and keeps comment state aligned with the existing Automerge
document split.

## Short Decision

Create a fourth per-notebook Automerge document, `CommentsDoc`, instead of
storing comments in `NotebookDoc` cells or in `RuntimeStateDoc`.

`CommentsDoc` is durable collaboration state with different write frequency,
authority, fan-out, persistence, and UI projection from cells, outputs, widgets,
or runtime lifecycle. It should sync over its own typed frame, likely
`COMMENTS_DOC_SYNC = 0x0a`. User-facing comment writes should still use
Automerge for immediate local-first rendering: the client writes a tentative
comment mutation into its local `CommentsDoc` replica, and the daemon or Cloud
comments authority finalizes policy-bearing fields such as author identity,
scope, resolve state, and rejection status in the same document.
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
- Same-UID trust makes local convergence forgiving. The UI should still write
  tentative comment mutations into the local `CommentsDoc` so Automerge owns the
  optimistic state, while the daemon finalizes author/scope fields in the same
  doc.
- Local agents use MCP tools that resolve `notebook_id | path`, submit comment
  requests to the daemon, and read projected comments from the local doc.

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
      position: Str                  # fractional order in the projection scope
      status: Str                    # "open" | "resolved"
      mutation_state: Str            # "pending" | "accepted" | "rejected"
      rejection_reason: Str?
      created_at: Str
      created_by_actor_label: Str    # host/daemon stamped when accepted
      created_by_authority: Str      # "pending" | "host_stamped" | "local_uid" | "imported"
      created_by_display_name: Str?  # advisory, host projected when available
      resolved_at: Str?
      resolved_by_actor_label: Str?
      resolved_by_authority: Str?
      archived_at: Str?
      messages/
        {message_id}/
          id: Str
          position: Str              # fractional reply order
          body: Text
          mutation_state: Str        # "pending" | "accepted" | "rejected"
          rejection_reason: Str?
          created_at: Str
          created_by_actor_label: Str
          created_by_authority: Str
          edited_at: Str?
          edited_by_actor_label: Str?
          edited_by_authority: Str?
          deleted_at: Str?
```

Do not store a derived `anchor_index` inside `CommentsDoc`. It would add synced
bytes for data that is a pure function of `threads/*/anchor`, and concurrent
re-anchoring could leave stale denormalized entries. Build `commentsByCellId` and
other indexes in the projection layer, memoized by `CommentsDoc` heads if scans
ever become hot.

Message bodies should be Automerge `Text`, even if v0 only edits a whole comment
body at once. It keeps the schema ready for collaborative comment editing and
avoids whole-string conflict behavior.

`created_by_authority` and related authority fields record the trust context of
the durable attribution field:

- `host_stamped`: Cloud room host stamped the field from an authenticated Cloud
  request.
- `local_uid`: local daemon stamped the field from same-UID desktop provenance.
- `pending`: client-authored optimistic state that has not yet been finalized by
  the local daemon or Cloud comments authority.
- `imported`: attribution was carried across a boundary such as local-to-Cloud
  promotion, clone-with-comments, or external import and should be displayed as
  imported/unverified.

`mutation_state` is what keeps optimistic UI inside Automerge instead of in a
parallel React store. The UI can render pending threads and replies immediately
from the local `CommentsDoc`. The authority then writes the same object to
`accepted` with stamped author fields, or `rejected` with a reason the projection
can display or collapse.

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
  - allow tentative local-first comment mutations to sync
  - canonicalize authority-owned fields from the daemon or Cloud comments host
  - keep runtime_peer out of comment mutation authority
  - validate or overwrite policy-bearing fields instead of asking the UI to keep
    a separate optimistic state
- `apps/notebook-cloud/src/protocol.ts`
  - add `COMMENTS_DOC_SYNC` and route it as materialized sync
- `apps/notebook-cloud/src/room-materializer.ts`
  - checkpoint comments bytes and heads with notebook/runtime/comms
  - include comments snapshots in published revisions
- `crates/runtimed-wasm/src/lib.rs`
  - add `RoomHostHandle` methods for comments sync, save/load, and heads

### Local-first mutation and authority finalization

Do not build a separate optimistic comment store outside Automerge. The
optimistic record should be the local `CommentsDoc` mutation itself.

The write flow:

1. UI or agent creates a tentative thread/message/edit/resolve mutation in its
   local `CommentsDoc` replica with `mutation_state = "pending"` and
   `created_by_authority = "pending"` when applicable.
2. The normal Automerge projection renders that pending state immediately. No
   separate React-side optimistic list is required.
3. The sync stream carries the tentative mutation to the local daemon or Cloud
   comments authority.
4. The authority validates scope, anchor, and causal evidence; stamps
   `created_by_*`, `edited_by_*`, `resolved_by_*`, and authority fields from the
   authenticated connection; then writes `mutation_state = "accepted"` in the
   same `CommentsDoc`.
5. If validation fails, the authority writes `mutation_state = "rejected"` plus
   `rejection_reason`. The UI can display or collapse the rejected pending item,
   again from `CommentsDoc`.

Requests such as `CreateComment` and MCP tools are command surfaces over the
same state transition. Human UI actions should perform the local tentative
mutation before any authority round trip. Agent, daemon, or hosted-tool surfaces
may ask the daemon/host to create the tentative Automerge mutation on their
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
- edit body, delete message: original author principal, or owner as moderator.
- runtime_peer: no comment mutation.
- reply to a resolved thread reopens it with host/daemon-stamped
  `resolved_at = null`, `resolved_by_* = null`, and the reply author recorded on
  the new message.

### Sync policy

`CommentsDocSync` is the replication path for both pending client-authored
comment state and authority finalization. The policy line is not "no non-empty
client sync"; it is "client-authored policy fields are tentative until the
authority finalizes them."

Prototype policy:

- Local desktop and Cloud both render pending comments from `CommentsDoc`.
- Empty sync frames remain normal. They carry heads/have/need and no document
  changes.
- Non-empty client sync frames may create or update pending comment state.
- The daemon/Cloud comments authority owns transition from pending to accepted or
  rejected, and owns durable author/scope fields.
- If a client writes policy fields directly, the projection treats them as
  unverified until an authority-authored change confirms them.
- Agents use the same local-first/state-finalization model as humans. MCP tools
  should operate through the daemon so agent comments land in `CommentsDoc` and
  receive the same authority finalization.

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
    created_by_actor_label          # durable, host/daemon-stamped or imported
    created_by_authority
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

Expose a small mutating tool set once the daemon can mutate `CommentsDoc`:

```text
create_comment(notebook_id | path, anchor, body) -> thread_id, message_id
reply_comment(notebook_id | path, thread_id, body) -> message_id
resolve_comment(notebook_id | path, thread_id) -> ok
reopen_comment(notebook_id | path, thread_id) -> ok
```

Mutating tools use the same pending-then-finalized model as human UI actions so
agent comments have the same durable authorship and ACL behavior as human
comments.

Reads should follow the repo's newer MCP resource direction rather than landing
as a tool that immediately needs migration:

```text
comments://notebook/<notebook_id_or_path>
comments://notebook/<notebook_id_or_path>/cell/<cell_id>
comments://notebook/<notebook_id_or_path>/thread/<thread_id>
```

The resource response can be the projected snapshot from `CommentsDoc`, including
open/resolved filters and stale-anchor metadata. A temporary `list_comments`
debug tool is acceptable during the spike, but not the target public surface.

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
3. Published snapshots include comments bytes if the publication policy allows
   comments.
4. Public viewers receive read-only comments sync if comments are published.
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
  orphan comments by recomputing `comments:path:<sha256(new_path)>` and treating
  that as a fresh document.

Clone:

- Clone is a new room with a new notebook UUID.
- Default clone behavior should create a fresh empty `CommentsDoc`, matching the
  existing clone behavior that drops outputs and runtime session state.
- If a future clone operation opts into comments, replay comments as fresh
  mutations into the new `CommentsDoc`. Never byte-fork the source comments doc,
  because that would share Automerge history and actor lineage across rooms.
- Imported clone comments should carry `created_by_authority = "imported"`.
  Output-anchored comments should be dropped or hard-marked stale because clone
  has no source outputs.

Local-to-Cloud promotion or import:

- Imported local comments should not be rejected, and they should not become
  indistinguishable from Cloud-host-stamped comments.
- Relabel imported author authority to `imported` unless the Cloud host can map
  the source local principal to an authenticated Cloud principal.

Published snapshots:

- Comments are excluded by default.
- If included, the publish artifact receives a frozen comments projection at the
  published heads.
- Public viewers do not subscribe to live comments sync and cannot write back.
- Publish may redact or coarsen author labels and display names.

## Implementation Plan

Phase 0: ADR alignment

- Land this decision as an ADR before implementation.
- Amend or cross-link `three-document-split.md` because `CommentsDoc` becomes
  another per-notebook split document alongside `NotebookDoc`, `RuntimeStateDoc`,
  and `CommsDoc`.

Phase 1: schema and projection

- Add `CommentsDoc` type with schema seed, load/save, heads, sync helpers, and
  typed mutation methods.
- Ship a committed `comments_doc_genesis_v1.am` asset following the existing
  schema-evolution and genesis-byte convention.
- Add a comments changeset/projection surface that can derive per-message
  `last_writer_actor_label` from validated Automerge change actors and cache it
  by `CommentsDoc` heads.
- Add unit tests for create thread, reply ordering, concurrent inserts into the
  same fractional-index gap, resolve/reopen, stale cell anchor projection,
  projection keys, clone/import authority, last-writer attribution, durable-field
  mismatch detection, and deterministic sorting by `(position, id)`.
- Keep it pure Rust with no UI dependency.

Phase 2: local sync and MCP

- Add `COMMENTS_DOC_SYNC`.
- Wire `SharedDocState`, daemon room state, initial sync, peer broadcasts, and
  sidecar persistence.
- Add request variants and daemon handlers that can create tentative comment
  mutations and finalize actor labels.
- Add MCP mutation tools and comment read resources using notebook ID or path
  resolution.
- Ensure save-as follows the existing `comments_doc_id` instead of recomputing a
  path-hash key.

Phase 3: UI prototype

- Render cell comment markers in the existing right gutter.
- Add a popover thread view and an all-comments panel.
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

Phase 5: portable identity

- Add `comments_doc_id` to notebook metadata or NotebookDoc root in a schema bump.
- Provide import/export for adjacent `.comments.automerge` files if needed for
  Git-based review workflows.
- Add clone/import options if product wants to carry comments across forks.

## Risks And Open Questions

- Path identity is weak under rename/move until the notebook carries an explicit
  `comments_doc_id`.
- Client-authored CRDT writes can spoof durable author fields unless the
  projection treats them as pending/unverified until authority-finalized.
- Public publish behavior needs a product decision. Comments are not obviously
  safe to publish with notebook outputs, and attribution may need redaction.
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
2. Local daemon sidecar load/save keyed by canonical path.
3. `create_comment`, `reply_comment`, and `resolve_comment` MCP tools plus
   comment read resources.
4. Notebook UI markers for cell-level comments only.
5. Pending client-authored comments live in `CommentsDoc`; authority finalization
   is required before treating author/scope fields as durable truth. No
   source-range inline highlights, no public publish.

That spike proves the storage identity, CRDT shape, author stamping, agent API,
and stable-DOM-safe UI without committing to the hardest anchoring problem.
