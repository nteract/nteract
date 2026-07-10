# MCP connect initial projection

Status: recommendation for [issue #3907](https://github.com/nteract/nteract/issues/3907)

## Summary

`connect_notebook` should continue to establish the MCP session and return
stable cell IDs in one tool call. It should stop requiring the MCP process's
local Automerge replica and RuntimeStateDoc replica to be fully ready before it
can return those IDs.

The recommended contract is:

1. resolve the target and reserve or open the daemon room;
2. obtain a compact projection directly from that room after any initial file
   load completes;
3. install the MCP session and return the projection, including its document
   heads, while the MCP peer continues converging in the background;
4. gate later local-replica reads and writes on the specific readiness they
   require, with an explicit degraded-sync error if convergence fails.

Do not add a projection cache yet. The daemon already has the authoritative
room and can produce the projection under one short document read. A cache
would add identity aliases and invalidation rules without removing the initial
file-load boundary.

## Current coupling

The local path and UUID branches in
`crates/runt-mcp/src/tools/session.rs` call
`await_session_ready_timeout(120s)` before installing the session or formatting
the response. `SyncStatus::session_ready()` in
`crates/notebook-sync/src/status.rs` requires all of the following:

- `NotebookDocPhase::Interactive`;
- `RuntimeStatePhase::Ready`;
- initial load `NotNeeded` or `Ready`.

Only the first and third conditions are relevant to obtaining the notebook's
initial cells, and even `NotebookDocPhase::Interactive` describes the MCP
peer's replica rather than the daemon room's ability to answer a read.

The daemon already demonstrates the cheaper read in two places:

- the `InspectNotebook` control request reads `room.doc.get_cells()` for a live
  UUID;
- the notebook connection supports a read-only `GetDocBytes` request, including
  for viewer-scoped connections.

Neither is the right final wire shape. `InspectNotebook` is a daemon-wide
diagnostic API and `GetDocBytes` sends a full Automerge document. They show that
no separate cache is needed and that the room can own a compact projection API.

## Proposed phases

Treat connect as four observable milestones rather than one boolean:

| Milestone | Owner | Meaning |
| --- | --- | --- |
| Room attached | daemon handshake | Target resolved, room identity and canonical path known, peer connection alive |
| Projection ready | daemon room | Initial file load, if any, is complete and stable cell IDs can be read from the authoritative room |
| Notebook interactive | MCP Automerge peer | The local NotebookDoc replica has completed a sync exchange and is safe for local-replica operations |
| Runtime ready | MCP RuntimeState peer | Runtime summaries and execution state are available locally |

`connect_notebook` should return after **Projection ready**. It should include
the later milestones in a `sync` object rather than waiting for both.

An example response shape is:

```json
{
  "notebook_id": "...",
  "notebook_path": "/abs/path/notebook.ipynb",
  "cells": [
    { "id": "cell-...", "cell_type": "code", "source_preview": "..." }
  ],
  "projection": {
    "source": "daemon_room",
    "notebook_heads": ["..."],
    "captured_at": "2026-07-10T...Z"
  },
  "sync": {
    "notebook_doc": "syncing",
    "runtime_state": "ready",
    "initial_load": "ready"
  }
}
```

The response should use structured cells rather than the current formatted
string. MCP text can still render the compact summaries, while structured
content and notebook resources expose the exact IDs.

## Daemon API

Add a read-only `NotebookRequest::GetNotebookProjection` handled by the room's
request worker. Its response should contain:

- notebook UUID and canonical path when file-backed;
- ordered stable cell IDs, cell types, and bounded source previews;
- dependency and lightweight notebook metadata required by the existing
  connect response;
- current NotebookDoc heads;
- a projection schema version.

The request worker starts after `stream_initial_load_with_frame_drain`, so a
cold path open naturally waits for the daemon's file load without waiting for
the MCP peer to acknowledge full Automerge convergence. Resident UUID and path
opens read the existing room immediately.

Do not put the projection in `NotebookConnectionInfo` initially. The daemon
sends that handshake before it performs a cold file-backed streaming load, so
the field would be complete for resident rooms and empty for cold rooms. A
post-load request has one meaning for every target.

## Safety of later operations

Returning early is safe only if MCP tools stop treating `session: Some` as
equivalent to a ready local replica.

Introduce operation-specific session guards:

- daemon-projection reads may run after **Projection ready**;
- NotebookDoc reads and cell CRUD must wait for **Notebook interactive**;
- execution and runtime summaries must additionally wait for the relevant
  RuntimeState readiness;
- every wait must capture an activation generation and re-check it after the
  await so a superseded connect cannot operate on or install the wrong session.

For a cell ID from the connect projection that was deleted before the local
peer became interactive, the later operation should return `Cell not found at
current notebook revision`. It must not recreate the cell or execute cached
source.

Local CRDT mutations can keep using the existing sync transport after the
NotebookDoc peer is interactive. Requests that already support
`required_heads` should keep their causal gate. The projection heads describe
what the agent initially saw; they are not permission to write from a partial
local replica.

## Duplicate connects

The current path installs its session only after the readiness wait. Concurrent
connects can therefore create multiple peer sync tasks before any caller sees
an active session.

Coalesce connects by normalized target:

- canonical absolute path for local files;
- notebook UUID for local resident or ephemeral rooms;
- normalized hosted URL for cloud rooms.

Same-target callers should share one in-flight attach and projection result.
Different-target callers should increment the activation generation; the last
user-initiated target wins, matching the existing rejoin invariant. Do not hold
the session lock across socket connection, file load, projection request, or
sync waits.

## Failure semantics and diagnostics

The current 120-second generic error loses the distinction between file load,
projection, NotebookDoc convergence, and RuntimeState convergence.

Record and surface:

- elapsed time and last progress time for every milestone;
- NotebookDoc heads or head counts observed on both sides where available;
- Automerge recovery attempts and whether the sync state was reset;
- a terminal local sync state with its reason when the sync task exits.

If room projection fails, `connect_notebook` fails because it cannot honor the
one-call stable-ID contract. If the projection succeeds but local Automerge
sync later fails, the session remains attached in a degraded read-only state:
the connect result is still useful, daemon-projection reads may continue, and
local-replica writes fail quickly with the explicit sync reason. A retry should
start a fresh sync exchange rather than waiting out another opaque 120 seconds.

The `InvalidChanges(MissingOps)` diagnostic belongs in this second category.
It should close or reset the broken local sync task, mark NotebookDoc sync as
failed, and leave the daemon-owned projection visible. It should not turn the
initial room read into a 120-second timeout.

## Harness and acceptance criteria

Run the raw-stdio harness against the isolated dev daemon:

```bash
cargo xtask dev-daemon
python3 scripts/mcp-connect-harness.py target/debug/runt \
  --fixture-cells 64 --samples 3 --report .context/mcp-connect-baseline.json
python3 scripts/mcp-connect-harness.py target/debug/runt \
  --fixture-cells 64 --samples 1 --parallel 2 \
  --report .context/mcp-connect-duplicate.json
```

The harness measures MCP initialization, `connect_notebook`, and an immediate
`get_all_cells`, verifies every stable fixture ID appears in the connect
response, and records active-room peer counts and MCP stderr for duplicate-sync
or Automerge warnings.

### Baseline from 2026-07-10

Against the per-worktree daemon at `6f7e91a17`, a generated 64-cell notebook
produced:

| Scenario | `connect_notebook` | Immediate `get_all_cells` | Stable IDs |
| --- | ---: | ---: | --- |
| Cold path open | 875.3 ms | 6.4 ms | 64 of 64 |
| Warm path open 1 | 541.0 ms | 5.0 ms | 64 of 64 |
| Warm path open 2 | 535.3 ms | 4.8 ms | 64 of 64 |

The ordinary path is correct, and this run did not reproduce `MissingOps`.
The roughly 100x difference between the connect and immediate-read timings is
consistent with connect waiting on broader peer readiness rather than the cost
of formatting the initial projection.

With two concurrent same-path connects in one MCP process, the harness observed
`active_peers = 2` for the target room before the calls completed and the room
settled back to one peer. Both calls returned the same notebook ID and all 64
cell IDs. This confirms that duplicate connects currently multiply peer and
sync-bootstrap work even when the final session state looks correct.

An implementation is ready to ship when:

1. cold path, resident path, resident UUID, and ephemeral UUID connects return
   the authoritative stable IDs in one call;
2. connect latency no longer depends on MCP NotebookDoc or RuntimeState peer
   convergence;
3. a deliberately stalled NotebookDoc peer returns the connect projection but
   rejects local-replica mutation with an explicit degraded-sync error;
4. same-target parallel connects create one durable peer sync task;
5. a different target selected during an earlier attach always wins;
6. no path returns cached source as authoritative after the projection revision
   has been superseded.

## Implementation slices

1. Add the compact daemon-room projection request and focused protocol tests.
2. Add MCP session activation generations and per-operation readiness guards.
3. Return the daemon projection from connect and keep live sync in the
   background.
4. Coalesce normalized same-target connects.
5. Add fault injection for a stalled or failed NotebookDoc peer and turn the
   harness scenarios into integration coverage.

Keep these slices separate. The first is useful independently, while the third
must not land before the safety guard in the second.
