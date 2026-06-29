# Notebook Comments Document

**Status:** Accepted / implementation in progress, 2026-06-07. Trimmed
2026-06-29.

This ADR records the durable architecture for notebook comments. Historical
phase plans and file-by-file implementation checklists were removed once the
core `CommentsDoc` path landed.

## Decision

Comments live in a per-notebook Automerge sidecar document, `CommentsDoc`.
Comments do not belong in `NotebookDoc` cells, `RuntimeStateDoc`, widget
`CommsDoc`, or daemon-scoped `PoolDoc`.

`CommentsDoc` is durable collaboration state with its own identity, sync stream,
projection, persistence, attachment, fan-out, and publish policy. It syncs over
the typed-frame protocol as `COMMENTS_DOC_SYNC`.

Comments are plain authored Automerge changes. A client writes a comment into
its local `CommentsDoc` replica and renders from local heads. There is no daemon
finalization step and no stored authority keyspace. Author, resolver, and body
writer attribution are projected from admitted Automerge change actors.

## Source Constraints

nteract's document split is load-bearing:

- `NotebookDoc` owns durable notebook content.
- `RuntimeStateDoc` owns kernel lifecycle, execution, output, environment, and
  runtime topology.
- `CommsDoc` owns mutable widget comm state.
- `PoolDoc` is daemon-level state, not notebook-level state.

Comments need notebook-room durability and multi-writer collaboration, but they
must not affect `.ipynb` cell content, runtime state, widget topology, or kernel
execution. One coarse `CommentsDoc` per notebook room is the intended
collaboration unit; one document per thread or cell would create avoidable sync
overhead.

## Document Identity

Every materialized comments document has a `comments_doc_id` and a notebook
reference. Sync, persistence, and projection treat identity mismatches as repair
or seeding failures.

Hosted rooms derive the comments identity from the authoritative notebook id.
Local rooms use daemon-provided comments identity for the active room. A future
portable schema can persist a comments identity in notebook metadata when the
product wants comment portability across save-as/import/export workflows.

Adjacent files such as `notebook.ipynb.comments.automerge` remain an import or
export option, not the default local storage model.

## Sync And Trust

The trust boundary is sync ingress. A connection may commit comment changes only
when:

- its scope is allowed to write comments;
- the admitted Automerge actor matches the authenticated connection actor; and
- the document identity matches the expected `comments_doc_id` and notebook
  reference.

The document stores no trusted author or resolver fields. Any field inside
`CommentsDoc` is peer-writable by an authorized editor; attribution must come
from the admitted change author.

Viewer and runtime-peer connections may participate in empty sync negotiation
when needed, but they cannot commit non-empty comment mutations unless product
policy explicitly grants them comment authority.

## Local And Hosted Responsibilities

Local desktop daemon:

- resolves and persists the room's `CommentsDoc`;
- dispatches `COMMENTS_DOC_SYNC`;
- enforces actor binding and scope checks at ingress;
- exposes comment projections to the app.

Hosted room host:

- includes `CommentsDoc` in the live room document set and checkpoints;
- enforces the same actor/scope rules for browser, agent, and runtime-peer
  connections;
- excludes raw comments from public publish artifacts unless a publication
  policy explicitly opts in.

## UI And Agent Surface

The UI renders comments from the `CommentsDoc` projection. Source and rendered
markdown anchors may use quote/context repair, but the repair result is still a
comment mutation in `CommentsDoc`.

Agents should use first-class comment tools and `nteract://` comment resources
when available. They should not mutate raw document bytes or invent parallel
comment stores.

## Non-Goals

- Storing comments in nbformat cell metadata.
- Treating runtime output or widget replay as the comment record.
- Deriving trusted authorship from document fields.
- Publishing private review comments by default.
