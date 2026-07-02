# Local-First Notebook State

**Status:** Accepted, 2026-06-11. Trimmed 2026-06-29.

This ADR records the local-first contract for cloud notebook handles. Historical
PR sequencing and landed implementation notes belong in Git history, not in the
architecture register.

Related:

- [Live Notebook Projection Policy](./live-notebook-projection-policy.md)
- [Shared-Store Projection Convergence](../memos/shared-store-projection-convergence.md)

## Context

The cloud viewer must tolerate thin or flapping networks without discarding the
live notebook handle, blanking the notebook, or losing unflushed local changes.
The core failure mode was reconnect teardown: freeing the WASM
`NotebookHandle`, `SyncEngine`, and projections destroyed local document state
that the room had not yet accepted.

The design keeps the notebook document local-first while preserving the room as
the sync authority. Reconnect is a transport/session concern, not a reason to
reseed the document graph.

## Decision

Cloud notebook sessions keep a browser-local `NotebookDoc` snapshot and preserve
the active handle across reconnect whenever the existing handle is still valid.
The viewer recreates transport and sync state as needed, but does not rebootstrap
the notebook document or blank shared store projections during a normal
reconnect.

`SyncEngine.notebookDocChanged$` is the narrow persistence hint. It may fire for
remote changes or local flush attempts, and consumers must treat saves as
idempotent. It is not a proof that content changed.

`RuntimeStateDoc` is not persisted as syncing state. It may be cached only as a
render-only snapshot for first paint, decoded into a throwaway handle, and never
flushed back to the room from the browser.

## Durable Contract

- Only `NotebookDoc` bytes may seed a syncing cloud viewer handle.
- After loading a `NotebookHandle`, set a fresh per-connection actor label before
  any authoring. Never reuse an actor label across document instances.
- Persisted bytes and their authoring principal commit atomically. Anonymous or
  unverifiable principals never seed, save, clear, or bridge local persistence.
- Storage failures degrade to no persistence; they do not break the live session.
  Corrupt local bytes degrade to room bootstrap.
- A seeded session whose replayed changes the room rejects clears its local
  record after teardown flush settles and retries from room bootstrap.
- Reconnect preserves store projections and stable DOM order while transport and
  sync state recover.
- Connection status stays out of kernel/runtime status surfaces. Reconnect and
  asset-load failures render as viewer notices, not kernel chrome.

## Reconnect Model

Reconnect is transport-owned and session-preserving:

1. Keep the current document handles and projected stores alive.
2. Recreate the WebSocket transport and per-peer Automerge sync state.
3. Resync against the room.
4. Fall back to bootstrap only when the preserved handle or persisted snapshot is
   invalid for the room.

This mirrors the daemon runtime-agent shape: preserve the documents and queue;
recreate sync states around them.

## Asset And Degraded States

Viewer assets such as `runtimed-wasm` and renderer bundles are independent from
document authority. Failed asset fetches should expose retryable degraded states
instead of leaving a blank notebook behind a generic live-room notice.

## Out Of Scope

- Offline authoring before the first successful hosted room handshake.
- Desktop adoption of the browser persistence module for remote-attached
  notebooks.
- Cross-tab replay for changes that predate the active bridge. Divergence heals
  through the room or through shared persistence on the next load.
