# MCP connect initial projection

Status: adopted on 2026-07-13 by
[Room Source Lifecycle and File-Backed Recovery](../adr/room-source-lifecycle-and-file-recovery.md)
and [MCP Session Lifecycle and Daemon Supervision](../adr/mcp-session-lifecycle.md)
for [issue #3907](https://github.com/nteract/nteract/issues/3907).

This memo preserves the investigation, benchmark, and original API sketch. The
ADRs are authoritative where the original recommendation assumed a disposable
file-backed Automerge mirror, rollback after partial loading, or one combined
readiness state. The design sections below preserve the original recommendation;
they are not an exact description of today's response schema or a claim that
every proposed diagnostic and acceptance scenario has shipped.

## Implementation checkpoint: 2026-09-04

At source baseline `6bff3e7b`, progressive local `connect_notebook` and
same-target coalescing are implemented. The path and UUID branches attach the
peer, fetch the room projection over an independent `PoolClient` control
connection, retain it, and publish through an activation lease. They no longer
wait for full local NotebookDoc/RuntimeStateDoc readiness before returning.
See `crates/runt-mcp/src/tools/session.rs:620`, `:1332`, and `:1406`.

The actual connect response has:

| Field | Current shape |
|-------|---------------|
| `cells` | Formatted summary string containing stable cell IDs, not the proposed array |
| `session_generation` | Installed activation generation |
| `source_state` | Source state, using `phase` rather than the sketch's `state` |
| `readiness` | Booleans `projection`, `document`, `runtime`, `interactive` |
| `projection` | `heads`, `runtime_state_heads`, `completeness` |
| `capabilities` | Booleans `read`, `mutate`, `execute` |
| `runtime`, `dependencies`, `project_context` | Initial context derived from the daemon projection |

Success is JSON text plus a notebook resource link, not structured connect
content. The sketch's `sync` object and top-level `availability` are not the
current connect response. See `add_progressive_session_fields` and
`notebook_session_response` at `tools/session.rs:583`, `:808`.

Readiness remains operation-specific. `get_all_cells` can return retained,
bounded projection data before interactivity; full NotebookDoc/resource reads
and mutations require an interactive document. Runtime reads require a
connected, ready RuntimeStateDoc; execution additionally requires an
interactive document and ready runtime. Kernel control need not wait for an
already running kernel. Retained projection data never authorizes cached-source
mutation or execution. See `crates/runt-mcp/src/session.rs:485`, `:595`,
`crates/runt-mcp/src/tools/cell_read.rs:229`, and
`crates/runt-mcp/src/resources.rs:285`.

Same-target callers share the current activation result. A different target
supersedes pending work, while a failed replacement leaves the installed session
usable. Publication and later active-session access are generation-guarded;
this is not transaction isolation for arbitrary concurrent tool calls. See
`crates/runt-mcp/src/session_activation.rs:76`, `:225`, `:442` and
`crates/runt-mcp/src/lib.rs:273`.

Do not extend the early-return contract to `create_notebook` or background
local rejoin: both still await session readiness (`tools/session.rs:1648`,
`crates/runt-mcp/src/daemon_watch.rs:517`). Hosted readiness also remains a
separate path, not the local retained-projection contract (`session.rs:415`).
Readiness failures use codes such as `notebook_not_ready`, `runtime_not_ready`,
and `sync_failed`; other connection failures can still be text tool errors.

The current harness includes shared-generation/projection and peer-count checks
at `scripts/mcp-connect-harness.py:1099` and a stalled-peer scenario at `:1367`.
These source-backed capabilities do not update the measurements below. The
2026-07-10 timings and two-peer observation remain historical, not a new
benchmark or current concurrency result. Protocol compatibility is separately
covered by the [lifecycle ADR](../adr/mcp-session-lifecycle.md#mcp-protocol-checkpoint)
and [source audit](../audits/mcp-cloud-automerge-audit.md); this checkpoint does
not claim conformance with upstream MCP `2026-07-28`.

## Summary

`connect_notebook` should continue to establish the MCP session and return
stable cell IDs in one tool call. It should stop requiring the MCP process's
local Automerge replica and RuntimeStateDoc replica to be fully ready before it
can return those IDs.

The recommended contract is:

1. resolve the target and reserve or open the daemon room;
2. obtain a compact projection directly from the room when room availability
   reaches `ProjectionReady`, even if its source generation is still
   `Publishing`;
3. install a generation-guarded MCP session and return the projection,
   including its document heads and completeness, while the MCP peer continues
   converging in the background;
4. gate later local-replica reads and writes on the specific readiness they
   require, with an explicit degraded-sync error if convergence fails.

Do not add a projection cache yet. The daemon already has the authoritative
room and can produce the projection under one short document read. A cache
would add identity aliases and invalidation rules without removing the initial
file-load boundary.

## Coupling observed on 2026-07-10

At the time of the investigation, the local path and UUID branches in
`crates/runt-mcp/src/tools/session.rs` called
`await_session_ready_timeout(120s)` before installing the session or formatting
the response. `SyncStatus::session_ready()` in
`crates/notebook-sync/src/status.rs` required all of the following:

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

Neither is the right final response shape. `InspectNotebook` is a daemon-wide
diagnostic API and `GetDocBytes` sends a full Automerge document over the same
peer transport as NotebookDoc sync. They show that no separate cache is needed
and that the room can own a compact projection API. The existing daemon control
connection is the safer transport because it does not share the MCP peer's
Automerge failure boundary.

## Proposed phases

Treat source lifecycle, room availability, and client readiness as separate
observable facts rather than one boolean:

| Milestone | Durable state | Meaning |
| --- | --- | --- |
| Room attached | `RoomAvailability::Attached` | Target resolved and room identity and canonical path known |
| Projection ready | `RoomAvailability::ProjectionReady` | A bounded, heads-qualified stable-cell projection is available |
| Room interactive | `RoomAvailability::Interactive` | The daemon room permits normal user-facing mutation |
| Notebook peer interactive | MCP NotebookDoc readiness | The local replica covers the required heads and is safe for local-replica operations |
| Runtime ready | MCP RuntimeState/runtime readiness | Runtime summaries and execution state are available locally |

The daemon also reports the independent `RoomSourceState` generation as
`Preparing`, `Publishing`, `Ready`, or `Failed`. Source failure can leave a
durable projection in `Degraded` availability; source state is not a synonym
for room or peer readiness.

`connect_notebook` should return after **Projection ready**. It should include
the later milestones in a `sync` object rather than waiting for both.

The original proposed response shape follows. It is preserved as an API sketch,
not the implemented schema; see the dated checkpoint above for current fields:

```json
{
  "notebook_id": "...",
  "notebook_path": "/abs/path/notebook.ipynb",
  "session_generation": 7,
  "cells": [
    { "id": "cell-...", "cell_type": "code", "source_preview": "..." }
  ],
  "dependencies": ["pandas>=2"],
  "runtime": { "kernel_status": "starting", "language": "python" },
  "project_context": { "state": "Pending" },
  "projection": {
    "source": "daemon_room",
    "notebook_heads": ["..."],
    "complete": true,
    "runtime_state_heads": ["..."],
    "captured_at": "2026-07-10T...Z"
  },
  "source_state": { "state": "publishing", "generation": 3 },
  "availability": "projection_ready",
  "capabilities": { "read": true, "mutate": false, "execute": false },
  "sync": {
    "notebook_doc": "syncing",
    "runtime_state": "ready",
    "runtime": "starting"
  }
}
```

The response should use structured cells rather than the current formatted
string. MCP text can still render the compact summaries, while structured
content and notebook resources expose the exact IDs. Preserve the current
top-level `runtime`, `dependencies`, and `project_context` fields so existing
clients do not lose initial context. The daemon should derive those values
directly from room-owned NotebookDoc and RuntimeStateDoc snapshots rather than
waiting for the MCP replicas.

## Daemon API

Add a read-only
`runtimed_client::protocol::Request::GetNotebookProjection { notebook_id }` on
the daemon control connection. Its response should contain:

- notebook UUID and canonical path when file-backed;
- ordered stable cell IDs, cell types, and bounded source previews;
- dependency and lightweight notebook metadata required by the existing
  connect response;
- a best-effort runtime and project-context summary from the room-owned
  RuntimeStateDoc, preserving the current top-level response shapes;
- current NotebookDoc heads;
- current RuntimeStateDoc heads for the best-effort runtime summary;
- source generation and `RoomSourceState`;
- `RoomAvailability`, projection completeness, and explicit capabilities;
- a projection schema version.

Runtime readiness is not a prerequisite for the stable-cell projection. If the
room's runtime or project context is still starting, pending, or unavailable,
return that state explicitly using the existing response vocabulary instead of
omitting the fields. The `sync.runtime_state` field separately tells the caller
whether the MCP process's local RuntimeStateDoc replica is ready.

The handler waits on room-owned `RoomAvailability`, not a loading atomic. The
source controller publishes its separate generation state and owns a bounded,
heads-qualified projection. Stale completions from an older source or session
generation cannot satisfy a new waiter. The projection uses narrow bounded
NotebookDoc accessors; it must not clone full sources or assets merely to
truncate them.

`ProjectionReady` is published only after the immutable staged changes, their
hashes, and the matching projection are durable. The projection may describe
the staged target heads while source state remains `Publishing`; local
operations wait until the room and MCP peer cover those required heads.

The daemon room, not the first attaching peer, owns the cold load. A room is not
published in a non-terminal source state until a task lease owns that
generation; cancellation or panic publishes `Failed` and wakes waiters. The
task prepares parsing and fallible asset work before live publication, authors
an immutable staged Automerge change stream from canonical genesis, persists
its hashes, and applies those exact changes in bounded batches. A peer send or
sync failure ends only that peer session. A source failure preserves any
durable partial publication and concurrent peer changes in a degraded room;
retry resumes recorded change hashes instead of rolling the document back.
This separation lets a cold room become projection-ready even when the peer
that initiated the open disconnects during bootstrap.

Do not route this request through `DocHandle` or `NotebookFrameType::Request`.
Those requests are owned by the same notebook sync task that closes and
disconnects pending requests after an unrecoverable Automerge error. The MCP
process should learn the notebook UUID from the attach handshake, then request
the projection over its independent daemon control connection. This lets the
projection complete even if the new NotebookDoc peer fails during bootstrap.

Do not put the projection in `NotebookConnectionInfo` initially. The daemon
sends that handshake before it performs a cold file-backed streaming load, so
the field would be complete for resident rooms and empty for cold rooms. The
room-gated control request has one meaning for every target.

### Durability and source conflicts

Progressive return depends on an honest durability boundary. File-backed rooms
keep an append-only Automerge recovery journal with source fingerprint,
generation, staged hashes, `durable_heads`, and `.ipynb` `exported_heads`.
Journal batches become visible atomically, acknowledgements wait for their
durable marker, and room reaping waits for the current required heads.

A matching file/journal fingerprint restores the journal and resumes staged
publication. Divergence preserves both versions and reports
`source_conflict`; it never silently picks disk or recovered state. A file save
advances `exported_heads` only after temporary-file flush and atomic replace.
`last_saved` remains display metadata, not evidence of durability.

These semantics are informed by automerge-repo's draft Subduction work on
source lifecycle, causal saved heads, concurrent storage merge, and surfaced
flush failure. Nteract encodes the behavior in its own interfaces and tests; it
does not take a production dependency on the draft branch.

## Safety of later operations

Returning early is safe only if MCP tools stop treating `session: Some` as
equivalent to a ready local replica.

Introduce operation-specific session guards:

- daemon-projection reads may run after **Projection ready**;
- NotebookDoc reads and cell CRUD must wait for room **Interactive** and local
  NotebookDoc readiness at the required heads;
- execution and runtime summaries must additionally wait for the relevant
  RuntimeState readiness;
- every wait must capture an activation generation and re-check it after the
  await so a superseded connect cannot operate on or install the wrong session.

Store the returned initial projection and its heads on the MCP session
independently from the live `DocHandle`. That retained value is what keeps the
one-call result inspectable if the peer sync task subsequently disconnects; it
does not authorize local CRDT writes.

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

In the 2026-07-10 baseline, the path installed its session only after the
readiness wait. Concurrent connects could therefore create multiple peer sync
tasks before any caller saw an active session. The coalescing recommendation
below is now implemented through `SessionActivation`; it is not an outstanding
feature request.

The recommendation was to coalesce connects by normalized target:

- canonical absolute path for local files;
- notebook UUID for local resident or ephemeral rooms;
- normalized hosted URL for cloud rooms.

Same-target callers should share one in-flight attach and projection result.
Different-target callers should increment the activation generation; the last
user-initiated target wins, matching the existing rejoin invariant. Do not hold
the session lock across socket connection, file load, projection request, or
sync waits. Once the daemon resolves identity, a path and UUID alias for the
same file-backed room use the same coalescing key.

## Failure semantics and diagnostics

The baseline's 120-second generic error lost the distinction between file load,
projection, NotebookDoc convergence, and RuntimeState convergence. The following
was the diagnostic recommendation, not a list of fields all guaranteed in the
current MCP response.

Record and surface:

- elapsed time and last progress time for every milestone;
- NotebookDoc heads or head counts observed on both sides where available;
- Automerge recovery attempts and whether the sync state was reset;
- a terminal local sync state with its reason when the sync task exits.

If room projection fails, `connect_notebook` fails because it cannot honor the
one-call stable-ID contract. If a durable projection exists while source or
local Automerge sync is degraded, the MCP session remains available with only
the capabilities its availability reports, even if its live `DocHandle`
disconnects. The retained connect projection is still useful, fresh
daemon-projection reads may continue over the control connection, and
local-replica writes fail quickly with the explicit source, conflict, or sync
reason. A retry starts a fresh activation or sync exchange rather than waiting
out another opaque 120 seconds.

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

The ordinary path was correct in this run, which did not reproduce `MissingOps`.
The roughly 100x difference between the connect and immediate-read timings was
consistent with connect waiting on broader peer readiness rather than the cost
of formatting the initial projection.

With two concurrent same-path connects in one MCP process, the harness observed
`active_peers = 2` for the target room before the calls completed and the room
settled back to one peer. Both calls returned the same notebook ID and all 64
cell IDs. In that baseline, duplicate connects multiplied peer and
sync-bootstrap work even though the final session state looked correct.

The original acceptance criteria were:

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

## Adopted implementation sequence

This preserves the original sequencing rationale, not a current list of
unfinished work. The checkpoint above records the implemented MCP behavior;
source and recovery guarantees remain owned by the linked ADRs.

1. Land room-owned source state, task leases, staged immutable imports, and
   bounded projections while preserving existing MCP waiting behavior.
2. Land the recovery journal, causal file checkpoints, conflict reconciliation,
   reaper barrier, and fault-injection coverage.
3. Add MCP activation generations, retained projection state, per-operation
   readiness guards, and UI/MCP mutation gating.
4. Return the control-plane projection from connect while live sync continues,
   then coalesce normalized same-target connects.
5. Turn stalled-peer, source-failure, conflict, target-switch, and shutdown
   harness scenarios into integration coverage.

Keep these slices separate. Progressive return must not land before durable
room recovery and operation-specific safety guards.
