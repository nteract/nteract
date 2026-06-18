# Comments Rollout

Scoped execution plan for landing notebook comments end to end, after the
durable core merged. The design lives in
[Notebook Comments Document](../adr/notebook-comments-document.md); this tracks
the slices that wire it into the daemon, MCP, and the app.

## References

- ADR: [Notebook Comments Document](../adr/notebook-comments-document.md)
- Merged: #3725 (Elements comment-surfaces showcase, presentational panel)
- Merged: #3726 (comments-doc crate, attribution trust model)
- Superseded drafts (reference only): #3709, #3710, #3712, #3713

## North Star

Humans and agents comment on the same live notebook through one API. Comments
render locally first from `CommentsDoc`, sync over their own wire frame, and
work in both local desktop rooms and Cloud hosted rooms. Attribution (author,
resolver) is read from the validated Automerge change author; trust is enforced
at the sync ingress, not in the document.

## Trust boundary

The attribution model is sound only because the sync ingress binds each
connection to its own Automerge actor id and admits a comment change only when
its actor matches the connection and the connection scope may comment. The
document stores no author or trust field. Every slice below that touches ingress
must preserve this: never trust a document field that any editor-scope peer
could have written.

## Slices

Dependency order. Each slice is a PR; the UI slices cannot precede the data
path.

### 1. Sync and MCP hookup

The keystone. The data path and the trust boundary. Re-extracted fresh against
the attribution API (the superseded drafts called the removed authority API).

- **1a. Wire frame.** Add `COMMENTS_DOC_SYNC = 0x0a` to `notebook-protocol` and
  `notebook-wire`, with the exhaustive cap tables, generated TypeScript
  constants, and protocol tests moving together. A partial change reads as an
  unknown or broadcast-only frame in some clients, so it ships as one slice.
- **1b. Daemon comments sidecar and ingress gate.** Load and save `CommentsDoc`
  by `comments_doc_id` with the resolver index, dispatch the new frame in the
  sync server, and enforce the actor-binding and scope check on admit. This is
  the local desktop trust boundary.
- **1c. MCP tools and read resources.** `create_comment`, `reply_comment`,
  `resolve_comment`, `reopen_comment`, and `nteract://` comment read resources,
  written against the attribution API. Agents use the same authored-change model
  as humans.
- **1d. TypeScript client bindings and projection store.** The `packages/runtimed`
  comments projection and hooks the app reads. May ride with 1c.

### 2. Desktop UI

Wire the merged presentational panel to the live projection store and the
daemon: create, reply, resolve, reopen from the rail, rendered from
`CommentsDoc` heads. Depends on slice 1.

### 3. Source-range selection

The hardest anchoring: select text in a cell or rendered markdown and anchor a
comment to it, with quote-context repair when source shifts. The ADR's minimal
spike deferred this deliberately. Depends on slice 2.

## Parallel tracks

- **Cloud ingress.** Slice 1b is the local-daemon implementation of the ingress
  gate. The Cloud room host (Durable Object plus materializer) is a parallel
  implementation of the same contract: bind connection to actor id, enforce
  scope, dispatch the comments frame. It follows the same trust boundary and can
  land after the desktop path proves the shape.
- **Publish boundary.** When `runt publish` and clone/save-as touch a notebook,
  comments are excluded by default per the ADR. A small guard, off the critical
  path, needed only once publish reaches these documents.

## Status

| Slice | PR | Status |
|-------|----|--------|
| Core crate (attribution) | #3726 | merged |
| Elements panel showcase | #3725 | merged |
| 1a. Wire frame | | next |
| 1b. Daemon sidecar + ingress | | planned |
| 1c. MCP tools + resources | | planned |
| 1d. TS bindings + projection | | planned |
| 2. Desktop UI | | planned |
| 3. Source-range selection | | planned |
| Cloud ingress | | parallel |
| Publish boundary | | parallel |
