# Comments Rollout

Scoped execution tracker for wiring notebook comments through the remaining app,
agent, and hosted surfaces. The durable design lives in
[Notebook Comments Document](../adr/notebook-comments-document.md).

## Current Baseline

The core comments architecture has landed:

- `crates/comments-doc` owns the document, identity, projection, and attribution
  model.
- `COMMENTS_DOC_SYNC` is part of the typed-frame protocol.
- `runtimed-wasm`, the TypeScript sync engine, and the local daemon have
  CommentsDoc sync/projection seams.
- The desktop app has comment projection and highlight/selection UI surfaces.
- Elements contains comment-surface fixtures for visual iteration.

## Remaining Work

- **MCP tools and resources.** Add first-class comment mutation tools
  (`create_comment`, `reply_comment`, `resolve_comment`, `reopen_comment`) and
  `nteract://` read resources so agents use the same authored-change model as
  humans.
- **Desktop product polish.** Finish rail/panel flows, stale-anchor display, and
  source/rich-rendered selection repair against live `CommentsDoc` projections.
- **Publish boundary.** Exclude private review comments from public artifacts by
  default; add an explicit opt-in policy before publishing comments.

Note: Hosted room ingress validates comment writes by scope
(`apps/notebook-cloud/src/room-materializer.ts:139-148` passes
`canWriteAllNotebookChanges` to `receive_peer_frame`;
`crates/runtimed-wasm/src/lib.rs:1063` rejects CommentsDoc changes when the
flag is false).

## Guardrail

Never trust author, resolver, or authority fields stored in the document.
Attribution comes from admitted Automerge change actors after sync ingress has
validated the connection actor and scope.
