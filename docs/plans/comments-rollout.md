# Comments Rollout

This plan tracks the remaining work to support notebook comments in the app,
agents, and hosted notebooks. See
[Notebook Comments Document](../adr/notebook-comments-document.md) for the design.

## Current Baseline

The core comments architecture has landed:

- `crates/comments-doc` owns the document, identity, projection, and attribution
  model.
- `COMMENTS_DOC_SYNC` is part of the typed-frame protocol.
- `runtimed-wasm`, the TypeScript sync engine, and the local daemon include
  CommentsDoc sync and projection code.
- The desktop app projects comments and provides highlighting and selection UI.
- Elements contains comment fixtures for trying out UI changes.

## Remaining Work

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
