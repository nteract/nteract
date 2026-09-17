# Comments Rollout

**Status:** In progress, 2026-09-17. Remaining work covers desktop interactions
and the policy for including comments in published notebooks.

This plan tracks the remaining work on notebook comments. See
[Notebook Comments Document](../adr/notebook-comments-document.md) for the design.

## Current Baseline

The core comments architecture has landed:

- `crates/comments-doc` owns the document, identity, projection, and attribution
  model.
- `COMMENTS_DOC_SYNC` is part of the typed-frame protocol.
- `runtimed-wasm`, the TypeScript sync engine, and the local daemon include
  CommentsDoc sync and projection code.
- The desktop app and the hosted viewer project comments and provide a comments
  panel.
- MCP comment tools can create, reply, resolve, and reopen threads.
- Elements contains comment fixtures for trying out UI changes.
- Hosted room ingress rejects comment writes from scopes without comment
  authority (`RoomHost.receive_peer_frame` in `crates/runtimed-wasm/src/lib.rs`).

## Remaining Work

- **Desktop product polish.** Finish rail/panel flows, stale-anchor display, and
  source/rich-rendered selection repair against live `CommentsDoc` projections.
- **Publish boundary.** Exclude private review comments from public artifacts by
  default; add an explicit opt-in policy before publishing comments.

## Guardrail

Never trust author, resolver, or authority fields stored in the document.
Attribution comes from admitted Automerge change actors after sync ingress has
validated the connection actor and scope.
