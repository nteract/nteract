# Comments Rollout

**Status:** Active product polish, 2026-09-17. Not the next structural move.
Writer decomposition is tracked in
[runtime writer decomposition](runtime-writer-decomposition.md).

This plan tracks the remaining comment product work. See
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
  authority. That is shipped behavior, not remaining work.

## Remaining Work

- **Desktop product polish.** Finish rail/panel flows, stale-anchor display, and
  source/rich-rendered selection repair against live `CommentsDoc` projections.
- **Publish boundary.** Exclude private review comments from public artifacts by
  default; add an explicit opt-in policy before publishing comments.

## Guardrail

Never trust author, resolver, or authority fields stored in the document.
Attribution comes from admitted Automerge change actors after sync ingress has
validated the connection actor and scope.
