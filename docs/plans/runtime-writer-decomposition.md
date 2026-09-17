# Runtime writer decomposition

**Status:** Active plan, 2026-09-17.

This is the sequenced work for
[Runtime writer decomposition](../memos/runtime-writer-decomposition.md).
The memo holds the direction and the open questions. This plan holds the
order and the stop rules.

Do not treat a slice as permission to add a room document, a client surface,
or a daemon process.

## Stop rules

- No fifth room document. ADR 0002's gated `NotebookDoc` split stays gated.
- No new MCP session model, host shell, or execution engine.
- No substrate rewrite as a stand-in for the writer split.
- `PoolDoc` stays daemon-scoped.
- Execution requests name a synced `cell_id`.
- Recovery changes go through
  [room source lifecycle](../adr/room-source-lifecycle-and-file-recovery.md),
  not a second checkpoint design.

## Sequence

### 1. Register the current writer

Done when the document split, comments ADR, and the competing plans say the
same thing as the code: four room documents, one recovery authority, and this
plan as the next structural move.

Evidence: the status lines in `docs/adr/document-split.md`,
`docs/adr/notebook-comments-document.md`, and `docs/README.md`.

### 2. Prove ingress parity before moving code

Write one unauthorized-write case per room document. Run it against the local
daemon ingress and the hosted room-host ingress. Record where they already
disagree.

Do not extract a module to hide a disagreement. The test is the map.

Likely surfaces: `crates/runtimed/src/notebook_sync_server/peer_runtime_sync.rs`
and the hosted receive path in `apps/notebook-cloud`. The exact hosted function
has to be named from the checkout at implementation time. Do not trust a line
number from this plan.

### 3. Separate coordinator facts from runtime progress

Inside `runtimed`, make coordinator commits and runtime-progress commits call
different module entry points. Coordinator facts are execution intent, path,
save, trust, environment, and schema or root fields. Runtime progress is
lifecycle, outputs, and topology for accepted work.

Stay in one process. `daemon.rs` may keep the task, but it should not keep
both policies inline.

Done when a runtime-peer change that creates an unknown execution is rejected
by the progress entry point, and a coordinator change that writes widget values
is rejected by the coordinator entry point.

### 4. Make the hosted host use that boundary

The hosted room host must fail the slice 2 cases the same way as the daemon.
If the host cannot call the Rust policy, add a mirror and a parity test that
fails when the two policies diverge. A comment that says they match is not
the boundary.

Done when slice 2 is green on both hosts without a per-host exception.

### 5. Keep MCP a client of the room

MCP may park a session, rejoin a room, and wait on a subscription. It may not
own recovery, mint execution intent, or keep a document set the room does not
have.

Done when a lost MCP response cannot replay a mutation the room did not
commit, and a reconnect reads the room's source lifecycle instead of a private
ready flag.

### 6. Only then choose a process split

If slices 3 and 4 are landed and the remaining bugs are still process-lifetime
bugs, write an ADR for a process split. Do not start that ADR from this plan.

## Not in this sequence

- Desktop comment polish and publish opt-in. Tracked in
  [comments rollout](comments-rollout.md).
- The unified CLI release. Tracked in
  [unified CLI release](unified-cli-release.md). The source has merged. The
  release has not shipped. Checked base is still 2.7.6.
- Shared UI store convergence. The
  [surface checklist](notebook-surface-library-refactor-checklist.md) stays
  open, and it does not grow a new host surface ahead of slice 4.
- celld, an AWS room host, and a marimo execution engine.
