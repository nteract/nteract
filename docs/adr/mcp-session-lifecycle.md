# MCP Session Lifecycle and Daemon Supervision

**Status:** Accepted, 2026-07-13; amended 2026-08-20 and 2026-09-04; supersedes Draft from 2026-05-23.

Source checkpoint: 2026-09-04 at `6bff3e7b`. This record describes the shipped
initialize-based MCP implementation, not conformance with the upstream
`2026-07-28` protocol revision. See [MCP protocol checkpoint](#mcp-protocol-checkpoint).

**Neighbors:**
- `docs/adr/room-source-lifecycle-and-file-recovery.md` - the room-owned source states, recovery journal, and progressive capability gates observed by MCP sessions.
- `docs/adr/typed-frame-v4-wire-protocol.md` - the wire that backs every `DocHandle` the MCP server holds.
- `docs/adr/document-split.md` - what `NotebookSession.handle` actually points at (`NotebookDoc`, `RuntimeStateDoc`, plus the runtime broadcast).
- `docs/adr/execution-pipeline.md` - why a stale `DocHandle` is so painful for the agent: `required_heads`, output sync, and broadcast replay all run through it.
- `docs/adr/blob-storage-and-content-addressing.md` - the blob HTTP port belongs to the daemon, not the stdio MCP transport.
- `docs/adr/identity-and-trust.md` - local peer credentials establish the principal; the MCP client identity supplies the agent operator suffix for attribution.

## Context

The MCP server gives agents stateful access to live nteract notebooks. It has to stand between three things that all have independent lifetimes:

1. **The MCP client** (Claude Code, the inspector, Codex, Zed). Connects on stdio and sends tool and resource requests. Most notebook tools use the connection's active selection; discovery and session-management calls need not have an active notebook.
2. **The runtimed daemon**. Unix-socket server that owns the Automerge rooms, the kernels, and the file watchers. Restarts on user upgrade, on a crash, or because the user toggled debug/release in dev. Versions bump independently of the MCP child.
3. **The room.** The per-notebook entity inside the daemon. Holds the Automerge doc, source controller, recovery journal, kernel handle, file checkpoint writer, and peer counter. It survives the last peer disconnecting (for a while) so reconnects are cheap, and its journal survives reaping so acknowledged heads remain recoverable.

The MCP server is the only place all three meet. Tool calls are stateful by convention ("each connection has one active notebook session"), but the connection is a stdio pipe and the session is a `DocHandle` into the daemon. When any of the three layers tears down or restarts, the other two have to find each other again without leaking kernels, dropping outputs, or surprising the agent with a stale `notebook_id`.

The shape that fell out:

- A **supervisor** (`nteract-mcp` in installed distributions, `mcp-supervisor` in dev) owns the child process. Both use `McpProxy` from the `runt-mcp-proxy` library for child monitoring and reconnection banners; the library is not a binary the MCP client spawns directly.
- A **child** (`runt-mcp`, the `runt mcp` subcommand) holds one active `NotebookSession`, a bounded parked map, and the watch loop.
- The **daemon** holds rooms and kernels and runs the ghost-room reaper.

Separate MCP clients can run separate children against one daemon and join the
same room. This is implemented multi-client sharing, not a future goal.
Concurrent requests on a child's stdio connection share its active selection;
the entrypoints do not multiplex independent MCP clients within that child.
The daemon's notebook framing is a separate transport protocol.

The source entrypoints are `crates/runt/src/main.rs:739`,
`crates/nteract-mcp/src/main.rs:260`, and
`crates/mcp-supervisor/src/main.rs:2910`. Same-room peer propagation is covered
by `test_notebook_sync_cross_window_propagation` in
`crates/runtimed/tests/integration.rs:1135`.

This ADR pins down session ownership, readiness, recovery, and the limits of
sharing one active target across concurrent requests.

## Decision 1: Three layers, three lifetimes, no shared state

The proxy, child, and daemon have separate state and failure boundaries:

| Layer | Owns | Recovery responsibility |
|-------|------|-------------------------|
| `nteract-mcp` / `mcp-supervisor`, using `McpProxy` | Child process, one preferred handoff target, upstream identity, tool cache | Restart child, re-resolve executable, request rejoin |
| `runt mcp` | Active and parked peers, activation generations, readiness evidence, daemon watcher | Reconcile local incarnation and publish only current sessions |
| `runtimed` | Rooms, source state, recovery, kernels, peer accounting | Keep room content available independently of a particular client or kernel |

There is no cross-process shared lock or transactional handoff. The proxy
passes recovery and operator environment variables and parses tool results.
The child talks to the daemon over its control and notebook connections.
`DaemonEvent` values are emitted by the child's `DaemonConnection` supervisor;
they wake the watcher rather than serving as authoritative daemon identity.

A session can outlive a kernel restart, and another peer can keep a kernel
alive after this child disconnects. These lifetimes are not strictly nested.
A daemon replacement invalidates local handles without necessarily ending the
proxy's MCP connection.

`McpProxy::restart_child_for_reason` re-resolves the executable on every
restart. Exit 75 is an intentional upgrade handoff with separate limiting,
not a charge against the ordinary crash budget. Version banners compare the
old and new child's `ServerInfo.server_info.title`, not a binary SHA.
`track_session` prefers the canonical path returned by connect, promotes a
local UUID target after save, and clears the handoff after active disconnect.
Disconnecting another parked session leaves the active handoff intact.
Only that one target is seeded into a restarted child; parked sessions are not
restored as a group.

See `crates/runt-mcp-proxy/src/proxy.rs:310`, `:962`, and
`crates/runt-mcp-proxy/src/session.rs:17`. The proxy's `reconnect` tool replaces
the child, not the daemon (`proxy.rs:1268`). A requested rejoin is not proof of
a ready notebook. Forwarding retries once after a closed child transport
(`proxy.rs:658`), so transparent restart is not an exactly-once mutation
contract.

## Decision 2: Proxy modes are policy, not state

`mcp-supervisor` (the dev wrapper) recognises three values for `NTERACT_DEV_MODE`:

| Mode | Spawns daemon? | Manages worktree daemon? | Used by |
|------|----------------|--------------------------|---------|
| `owner` | yes if not running | yes (up/down/rebuild) | Claude Code, default |
| `attach` | no | no, errors out if missing | Codex, second IDE |
| `isolated` | yes, per session | yes, scoped to session dir | one-shot test runs |

The installed `nteract-mcp` wrapper has no `NTERACT_DEV_MODE`. It locates the
channel's `runt` binary and spawns `runt mcp`; daemon service management remains
outside that child. See `crates/nteract-mcp/src/main.rs:190` and
`crates/runt/src/main.rs:715`.

**Why separate management from attachment.** Multiple children can share a
worktree daemon without each managing its lifecycle. Attach mode makes that
boundary explicit: it does not start, stop, rebuild, or restart the shared
daemon. Owner mode can also reuse a running daemon, so attach mode is not the
only mechanically possible way to share one. See
`crates/mcp-supervisor/src/main.rs:819`, `:2975`, and `:3004`.

**What attach mode does not guarantee.** It does not guarantee the daemon
outlives the child. If the daemon is stopped or replaced, the child reconciles
its local handles and attempts recovery. There is no owner-handoff event in
this watch loop. Peer attribution and daemon lifecycle ownership are separate:
knowing an agent's operator label does not make it the daemon's owner.

## Decision 3: The active slot plus daemon incarnation are session truth

The child holds one active slot:

```rust
session: Arc<RwLock<Option<NotebookSession>>>
```

A local session also carries `local_daemon_incarnation: Option<DaemonIncarnation>`, where the incarnation is `pid + started_at`. The slot answers which notebook is selected; the incarnation answers whether its local `DocHandle` belongs to the daemon that is live now. A hosted session deliberately has no local incarnation.

A local connect samples daemon identity before and after connection/readiness. Equal samples bind the session. A missing or changed sample leaves it unbound and it is not published as an active tool session. The watch loop removes any active or parked local session whose binding does not equal the live incarnation. Hosted sessions survive local-daemon reconciliation.

The parked map holds up to eight previous peers, with arbitrary HashMap-order
eviction at capacity. These are live connections, so parking can keep a room
and kernel alive. Local switch-back establishes a fresh activation and removes
the old parked peer only after successful publication; it does not generally
reuse the parked handle. Hosted reconnect has a parked-peer resume path.
Parked local entries obey the same incarnation rule as the active slot.

Most notebook tools use the active slot through an operation-specific readiness
gate, cloning an owned handle before releasing the read lock. Notebook resource
reads and explicit disconnect can address parked local sessions by notebook ID
without changing the active selection. This is not independent active routing
for several MCP clients in one process.

See `crates/runt-mcp/src/lib.rs:119`, `:273`,
`crates/runt-mcp/src/tools/session.rs:74`, `:742`, `:949`, `:1200`, and
`crates/runt-mcp/src/resources.rs:285`.

## Decision 4: Tool intent and guarded publication are the convergence point

Recovery connects outside the session lock. It captures `session_intent_epoch`
and the expected daemon incarnation, then verifies incarnation again after the
async connection/readiness work. `publish_rejoined_session` checks the epoch
and slot emptiness under the same write lock that installs the session. A tool
that has installed any session wins, including one for the same notebook.
Explicit disconnect advances the epoch under the active-slot write lock so
background work cannot resurrect the disconnected selection.

Explicit connect/create attempts use a separate `SessionActivation` generation.
Same-target connects share the current in-flight result; different-target
attempts supersede earlier attempts, including A→B→A. Publication rechecks the
lease before and under the slot lock, and restores the previous occupant if
its identity commit is refused. The installed identity remains usable until a
replacement actually publishes; a failed attempt does not poison it.

A completed recovery connection may be dropped after doing useful work.
Dropping its handle releases the extra peer; it is preferable to overwriting
the user's selected session. These guards order session publication, not all
concurrent notebook operations into one transaction.

See `crates/runt-mcp/src/daemon_watch.rs:365`, `:567`,
`crates/runt-mcp/src/session_activation.rs:76`, `:225`, and
`crates/runt-mcp/src/tools/session.rs:977`. Tests exercise the production
publication helpers in `daemon_watch.rs:1066` and
`session_activation.rs:501`, `:563`, as well as failed replacement at `:442`.

## Decision 5: Live daemon incarnation drives reconciliation

The watch loop treats events as wake-ups, not cached connection truth. On each
`DaemonEvent`, and after `RecvError::Lagged`, it directly queries
`query_daemon_info(socket_path)`. It does not make ownership decisions from
`DaemonConnection::info()`'s cached heartbeat. If that one-shot query fails,
only an explicit `Disconnected` event permits reconciliation against absence;
otherwise the watcher defers and retains the current handles.

Reconciliation removes active and parked local handles whose incarnation is
missing or unequal to the verified live incarnation. Removing the active
handle records its best recovery target, preferring a file path and never
replacing a saved path with a later UUID-only observation. With a live
incarnation and an empty active slot, recovery uses the proxy handoff target
first, then the preserved target. It does not reconnect every discarded parked
session.

The daemon version observed when the child starts is the version baseline.
Each successful live query is compared with it; a mismatch exits with 75. If
startup had no live daemon, the first live version establishes the baseline.
See `crates/runt-mcp/src/daemon_watch.rs:259–341`; the failed-query and lagged
observation tests are at `:985` and `:1096`.

## Decision 6: A same-incarnation heartbeat is structurally a no-op

`Connected` may be emitted as a routine liveness refresh. When the queried
incarnation equals the active and parked local bindings, reconciliation changes
nothing. An installed session clears obsolete recovery targets. No separate
`was_disconnected` gate is required. A same-version daemon restart has a
different `pid + started_at`, so reconciliation removes old local handles and
can recover the previous active target against the new incarnation.

See `crates/runt-mcp/src/daemon_watch.rs:301–341` and the heartbeat and
replacement tests at `:904`, `:1011`.

## Decision 7: Room is the durable entity; sessions and kernels are not

The daemon's eviction model has three layers:

1. **Kernel teardown** (`peer_eviction.rs`). All peers leave; after `keep_alive_secs` (default 30 s, configurable 5 s to 7 days), the kernel is shut down and the env directory is cleaned up. The room itself stays resident. The autosave debouncer and file watchers also stay alive.
2. **Ghost-room reaping** (`daemon::ghost_room_reaper_loop`). Every 5 minutes, sweep peer-less rooms whose kernel has been torn down. TTL is 24 hours; cap is 32 peer-less rooms. Aged-out or overflowed rooms may leave `notebook_rooms` and `path_index` only after the recovery journal covers their current heads.
3. **Daemon shutdown.** Resident tasks and kernels end, but the shutdown path first requires the same causal journal barrier for accepted room heads.

Reaping and clean shutdown call `await_durable(required_heads)`. A journal
failure makes room availability `Degraded` and keeps the room resident; it does
not turn acknowledged work into an evictable in-memory detail. The full
durability contract is defined in
[Room Source Lifecycle and File-Backed Recovery](./room-source-lifecycle-and-file-recovery.md).
The reaper snapshots heads, commits them to the journal, awaits the durable
barrier, then removes the registry entry only if the final predicate still
holds: no peers, no reservations, same connection generation, teardown timestamp
still present, source not loading, and durability not requiring repair.
Writer-side journaling plus the generation and reservation checks carry the
post-barrier protection.

**Why the room outlives the kernel.** Reconnects are common. A user closes the desktop window and re-opens it; a Claude Code session ends and a new one begins on the same notebook; a daemon upgrade restarts the child. In every case the agent or the UI wants to land on the same `notebook_id` with the same outputs visible and (where possible) the kernel still warm. Tearing down the room on the last disconnect would force a full re-load of the document, the file watcher rebind, and (if there's no `.ipynb` to reload from) loss of ephemeral cell state. Keeping the room resident makes reconnects cheap and idempotent.

**Why the kernel is torn down anyway.** A kernel and its environment consume
resources even when no peer is using the notebook. The keepalive delay permits
brief reconnects without requiring every abandoned kernel to run indefinitely.
Ordinary tool calls reuse their peer; they do not reconnect on every call.

**The reconnect-during-teardown race.** The teardown task snapshots connection
generation when the last peer leaves. It revalidates no peers, unchanged
generation, and a non-evicted room through `NotebookRooms::serialize_with`
before destructive work. Setting `kernel_teardown_destructive` in the same
serialized check tells a reconnecting peer not to reuse the doomed kernel.
Peer count, generation, and the latch cover different windows of the race;
none should be removed as redundant.

See `crates/runtimed/src/notebook_sync_server/peer_eviction.rs:107`, `:166`,
`:269`, and the reaper at `crates/runtimed/src/daemon.rs:5834`.
`test_kernel_teardown_keeps_room_resident` at
`crates/runtimed/tests/integration.rs:1861` verifies that zero peers and completed
teardown still leave a reconnectable room. Reaper tests at `:1991`, `:2088`,
and `:2657` cover TTL removal, reconnects, and reservations.

## Decision 8: Rejoin is keyed on file path for file-backed rooms

Automatic rejoin prefers a saved path when available. UUID-only recovery is
also implemented; it is not a request to create an empty room.

| Target | Rejoin method | Admission |
|--------|---------------|-----------|
| Known saved path | `connect_open(path)` | Watcher requires an existing source file; daemon reconciles source and recovery state |
| UUID with a resident room | `connect(uuid)` | Attach to that room |
| UUID with a persistent saved-path binding | `connect(uuid)` | Follow the registry binding and recover from the available source and journal |
| Persisted untitled UUID | `connect(uuid)` | Reload recoverable persisted content |
| UUID already absent from resident/registry/persisted admission checks | `connect(uuid)` | Refuse with `SyncError::NotebookUnavailable` |

The path remains a durable user-facing locator. The daemon's persistent
registry can also preserve a file-backed UUID across restart, including an
untitled notebook that was later saved. A registry row is not notebook content:
if its source file is missing, attachment refuses rather than importing a stale
mirror. Source and journal conflicts remain governed by
[Room Source Lifecycle and File-Backed Recovery](./room-source-lifecycle-and-file-recovery.md).

UUID availability and refusal are daemon-authoritative. Admission refuses an
already-unavailable UUID rather than deliberately creating a new notebook.
Rejoin does not precheck `list_rooms`: an unlisted room may still be recoverable.
`NotebookUnavailable` and a missing saved source record `Evicted` without retry.
Transient connection/readiness failures retain the recovery target for later
attempts. Explicit create/open flows remain separate from UUID attach.

This is not atomic protection against content disappearing during attachment.
The legacy snapshot existence check at `crates/runtimed/src/daemon.rs:3122`
precedes awaited room creation. If the snapshot disappears and no journal is
recovered, `crates/runtimed/src/notebook_sync_server/room.rs:1945–1955` can create
a fresh document. The already-absent UUID test does not cover that race.

Persisted untitled notebooks and explicitly ephemeral notebooks are different.
MCP creation defaults to `ephemeral=true`; a UUID alone does not guarantee
recovery when its content has been lost. See
`crates/runt-mcp/src/tools/session.rs:1602`.

On explicit UUID connect, MCP obtains the path from the daemon projection with
a `list_rooms` lookup fallback and stores it on the session. The response
exposes `notebook_path`; successful save also updates the proxy's preferred
handoff. These path preferences remain useful even though registry-backed UUID
recovery now works. See `crates/runt-mcp/src/tools/session.rs:1436`,
`crates/runt-mcp-proxy/src/session.rs:55`, and
[Notebook Identity and Path Binding](./notebook-identity-and-path-binding.md).

Admission is implemented at `crates/runtimed/src/daemon.rs:3041–3150` and
rejoin refusal handling at `crates/runt-mcp/src/daemon_watch.rs:506`, `:615`.
Tests at `crates/runtimed/tests/integration.rs:4015`, `:4054`, and `:4203`
verify refusal without a phantom for an already-absent UUID, saved-path recovery
by UUID across daemon restart, and refusal when only a journal remains without
its source file.

## Decision 9: `SessionDropReason` is the agent-facing recovery hint

When a tool call lands and finds `session = None`, the error has to tell the agent how to recover. `last_session_drop` records the last reason the session was cleared:

| Reason | What happened | Recovery |
|--------|---------------|----------|
| `Switched` | Agent called `connect_notebook` on a different notebook | Park slot may still have the previous one; call `connect_notebook` again with the old `notebook_id` |
| `Evicted` | Rejoin received a definitive unavailable refusal or found a missing saved source | Restore/open the source or create a new notebook; no automatic retry of that target |
| `Disconnected` | Reconciliation removed stale local ownership, rejoin exhausted its current attempts, or the user explicitly disconnected | Automatic recovery can retry on a later verified live observation; explicit disconnect cancels it |

The error message is generated at the point of tool failure (`no_session_error()`).
Drop info is best-effort context, not another authoritative session: a later
recording can replace an earlier reason. `SessionDropInfo` retains notebook ID,
path, and rejoin target so the error can name what was lost. Kernel teardown
alone does not mean `Evicted`; the room can still be resident or recoverable.
See `crates/runt-mcp/src/session.rs:636` and the recording sites in
`daemon_watch.rs` and `tools/session.rs`.

## Decision 10: Connection activation is progressive and generation-guarded

`session: Some` identifies the selected target; it does not mean every
subsystem is ready. Local path/UUID `connect_notebook` obtains a bounded,
heads-qualified projection over the independent daemon control connection,
retains it on the session, and returns while local peers continue converging.
A readable degraded projection can be retained without authorizing mutation.
Pending activation metadata is not a second active session.

The current connect response includes:

- `session_generation` and `source_state`;
- `readiness` booleans: `projection`, `document`, `runtime`, `interactive`;
- `projection.heads`, `runtime_state_heads`, and `completeness`;
- `capabilities.read`, `mutate`, and `execute`;
- existing `runtime`, `dependencies`, `project_context`, and cell summaries.

`cells` remains a formatted string containing stable IDs. Success is returned
as JSON text plus a notebook resource link, not the structured cell-array
response proposed in the initial-projection memo. See
`crates/runt-mcp/src/tools/session.rs:583`, `:808`, `:1332`, and `:1406`.

Tool handlers use `SessionRequirement` through `require_session_access!` or
`require_handle!`:

| Operation | Required evidence |
|-----------|-------------------|
| Bounded projection read | Retained projection or interactive document |
| Full NotebookDoc read or mutation | Interactive document with local readiness/head evidence |
| Kernel control | Interactive document, without requiring an already running kernel |
| RuntimeStateDoc read | Connected and ready local RuntimeStateDoc |
| Execution | Interactive document and ready runtime; preserve the execution `required_heads` gate |

`get_all_cells` serves the retained bounded projection before interactivity;
full notebook resources use `DocumentRead` and can remain unavailable then.
This is inspection of a retained revision, not a fresh full-document read.
Readiness is recomputed from current peer status, head containment, and source
health. A failed local peer or degraded source does not authorize cached-source
writes or execution.

See `crates/runt-mcp/src/session.rs:323`, `:485`, `:595`,
`crates/runt-mcp/src/tools/cell_read.rs:229`, and
`crates/runt-mcp/src/resources.rs:285`. Access captures installed generation
and target; `ensure_session_access_current` revalidates them after async work
(`crates/runt-mcp/src/lib.rs:273–320`). Session locks must not span file loading,
socket connection, projection, or sync waits.

Concurrent same-target connects coalesce through `SessionActivation`; path and
UUID aliases are resolved using the daemon and registered on the current
flight. A different target supersedes earlier pending work without invalidating
a healthy installed session until the replacement publishes. The implementation
and tests are in `crates/runt-mcp/src/session_activation.rs:76`, `:254`, `:391`,
`:442`, and `:605`.

Readiness errors distinguish `notebook_not_ready`, `runtime_not_ready`,
`source_degraded`, `source_conflict`, `session_superseded`, and `sync_failed`.
Document unreadiness keeps mutation and execution closed. Runtime-only
unreadiness can leave mutation open. Publication against a replaced daemon
returns `daemon_replaced` (`crates/runt-mcp/src/tools/session.rs:742`). Other
connection failures can still use text tool errors; not every failure is a
structured readiness result.

This progressive contract is specific to local connect. `create_notebook`
still awaits session readiness (`tools/session.rs:1648`), as does background
local rejoin (`daemon_watch.rs:517`). Hosted sessions use their existing
connected-replica readiness path, not the local room's retained-projection
contract (`session.rs:415`). The historical sketch and measurements remain in
[the initial-projection memo](../memos/mcp-connect-initial-projection.md).

## Worked examples

### Cold start: Claude Code spawns owner-mode proxy

1. Claude Code spawns `mcp-supervisor` over stdio. Before its proxy is initialized, the supervisor exposes its own tools and empty resource lists.
2. Background setup finds or starts the worktree daemon, initializes the proxy and `runt mcp` child, and notifies the client of the available tool surface.
3. With no handoff target, the child has `session = None` until a tool selects a notebook.
4. Agent calls `connect_notebook { path: "/tmp/foo.ipynb" }`. The child attaches, obtains a heads-qualified daemon projection, and installs a generation-guarded session. The call returns stable cell IDs while local peers continue converging.
5. Proxy parses the response and stores the preferred target, `/tmp/foo.ipynb`, in `last_notebook_id` for the next restart.
6. Subsequent notebook tools acquire the active session through their readiness gate. A successful connect does not mean execution is ready.

The installed wrapper differs at startup: `nteract-mcp` can serve cached tools
before its child starts, then starts the child after
`notifications/initialized` and sends list-change notifications. See
`crates/mcp-supervisor/src/main.rs:2910` and
`crates/runt-mcp-proxy/src/proxy.rs:1135`, `:1215`.

### Daemon upgrade during an active session

1. User upgrades the nteract desktop app. The installed daemon restarts; the new binary has version 2.1.3 (old was 2.1.2).
2. Child's `DaemonConnection` detects the daemon version change and emits `DaemonEvent::Upgraded { previous: 2.1.2, current: 2.1.3 }`.
3. The event wakes the watcher, which queries the live daemon version and compares it with its startup baseline. A mismatch exits with `EX_TEMPFAIL` (75), even if the original upgrade event was lost.
4. Proxy's child monitor sees the transport close and classifies exit 75 as an intentional handoff. It re-resolves the child binary, seeds `NTERACT_MCP_REJOIN_NOTEBOOK` with the preferred target (path when known, otherwise UUID or hosted URL), and spawns the new child.
5. New child's watch loop sees the handoff target. On the first live daemon observation it reconciles the empty slot, runs recovery against that daemon incarnation, and installs a freshly stamped `NotebookSession` if no tool activation won meanwhile.
6. Supervisor detects the daemon-version change across the child boundary (compares `ServerInfo.title` of old vs new child) and stamps a reconnection banner. The banner says `Daemon upgraded (2.1.2 -> 2.1.3), session reconnect requested` when a handoff target was supplied; it intentionally reports the request rather than claiming the asynchronous rejoin already succeeded.
7. The agent's next tool result has the banner prepended. The agent sees one message; underneath, the child has been completely replaced.

### Last peer leaves, comes back during teardown

1. Agent calls `disconnect_notebook` (or the MCP client exits). Child's session goes to `None`. Daemon sees the peer disconnect; `active_peers` drops to 0.
2. Daemon schedules kernel teardown for `keep_alive_secs` (default 30 s). Snapshots `teardown_generation = current connection_generation`.
3. At 25 s, agent calls `connect_notebook` on the same notebook. Daemon increments `active_peers` from 0 to 1, bumps `connection_generation`, zeroes `last_kernel_torn_down_at`.
4. At 30 s, the teardown task sees peers have reconnected and returns without touching the kernel. If reconnect instead races the later flush, the serialized peer/generation checks abort stale teardown work.
5. Agent's reconnect lands on the same room with the same kernel. No env rebuild, no relaunch.

### Daemon goes away mid-execution

1. The tool call owns a cloned local handle stamped with daemon incarnation A.
2. When a `Disconnected` event is accompanied by no live daemon identity, reconciliation removes active and parked local handles, preserves the active session's path when available, and records `SessionDropReason::Disconnected`. A failed query without that event instead defers reconciliation. Hosted handles are excluded from local ownership reconciliation.
3. The in-flight tool's cloned handle observes the closed socket and returns failure; no session lock is held across that await.
4. When daemon incarnation B becomes live, reconciliation still cannot retain any handle from A. With an empty active slot it reconnects using the preserved path (or UUID for recoverable untitled notebooks).
5. Recovery verifies incarnation B again after readiness, then publishes only if explicit tool intent has not advanced and the slot is still empty. A tool-installed session for B wins the race and is retained.

### Two MCP clients, attach mode

1. Claude Code starts in `owner` mode, spawns the worktree daemon. Connects child to socket, opens a notebook.
2. User starts Codex in `attach` mode against the same worktree. Codex's `mcp-supervisor` reads `NTERACT_DEV_MODE=attach`, asserts the daemon socket is reachable, spawns a child that connects without trying to start the daemon.
3. Both children have their own `NotebookSession` slots. Both can call `connect_notebook` on the same notebook; each becomes a separate peer on the room, with `active_peers` going from 1 to 2.
4. One agent calls `execute_cell`; the other peer observes shared runtime changes. Each child has its own selection and agent operator suffix. That attribution does not create separate authorization boundaries for same-user local clients.
5. Disconnecting one notebook peer leaves the other connected, so that disconnect does not schedule last-peer kernel teardown. This assumes the daemon itself remains running; stopping it through its lifecycle owner affects both clients.

The display label and `agent:<slug>:<session>` operator derive from the upstream
MCP identity. The proxy keeps the operator session suffix stable across child
restarts. See `crates/runt-mcp/src/lib.rs:48`, `:464`, and
`crates/runt-mcp-proxy/src/proxy.rs:180`, `:227`. Tests at
`crates/runt-mcp/src/lib.rs:628` and
`crates/runt-mcp/src/daemon_watch.rs:776` cover identity derivation and the
separation between rejoin actor identity and presence label.

## 2026-09-04 implementation checkpoint

The incarnation-based ownership decisions introduced in the 2026-08-20 amendment
remain in force. The current watcher uses direct live identity queries and
defers on unconfirmed absence, as described in Decision 5. It does not use the
older classify/disconnect-latch algorithm.

Repeated connect can reuse the active same-target replica only when it is
connected, its document or retained projection is readable, and its local
incarnation matches the live daemon. A pending activation takes precedence over
reuse. See `reuse_active_session` at
`crates/runt-mcp/src/tools/session.rs:666` and
`SessionActivation::can_reuse_installed` at
`crates/runt-mcp/src/session_activation.rs:130`.

The progressive harness at `scripts/mcp-connect-harness.py:1099` checks shared
activation generation, projection, and bounded peer count for same-target
connects. Its stalled-peer scenario at `:1367` checks that a connect projection
remains inspectable while mutation and execution remain closed. These are
application lifecycle checks, not an upstream MCP conformance suite.

## MCP protocol checkpoint

`Cargo.toml:90` requests `rmcp = "1.4"`; `Cargo.lock:7357` resolves it to 1.5.0.
That SDK defaults `ServerInfo::new` to MCP `2025-11-25`, which the child and
proxy use (`crates/runt-mcp/src/lib.rs:413`,
`crates/runt-mcp-proxy/src/proxy.rs:1113`). Older requested revisions can be
negotiated by the SDK, but negotiation is not proof of a complete old-client
compatibility matrix. The child emits resource links without a version-specific
fallback, and the proxy initializes its child with a separate default-capability
handshake (`crates/runt-mcp/src/tools/session.rs:808`,
`crates/runt-mcp-proxy/src/child.rs:28`).

The upstream `2026-07-28` revision removes the initialize/protocol-session model
and introduces per-request metadata, `server/discover`, and MRTR. The shipped
entrypoints still use initialize-based stdio and do not implement that newer
contract. Tools, resources, and the MCP Apps UI extension are advertised; the
SDK dependency alone does not imply every protocol feature is exposed. Detailed
compatibility and migration followups belong in the
[MCP, cloud, and Automerge audit](../audits/mcp-cloud-automerge-audit.md).

## Open Follow-ups

These are remaining design or compatibility choices, not prerequisites for the
already implemented separate-child/shared-daemon model.

1. **Several MCP clients within one child.** The shipped entrypoints expose one
   active selection and one upstream identity per child. Supporting independent
   clients there would require explicit routing and ownership, not merely more
   parked entries. Decide whether this is needed beyond separate children.
2. **Parked-peer policy and restart scope.** Eight live parked peers can keep
   kernels alive; local switch-back creates a fresh activation. Consider an
   idle/LRU policy only with explicit keepalive and resume semantics. Restoring
   the full parked set after child restart would be a separate feature; today
   only one preferred target is handed off.
3. **Daemon ownership handoff.** Attach mode deliberately does not manage the
   shared daemon. If ownership transfer between supervisors is needed, specify
   it independently of peer attribution and notebook keepalive. A stopped
   daemon affects all attached clients regardless of who started it.
4. **Tool compatibility beyond names.** `detect_divergence` compares tool-name
   sets, not input/output schemas (`crates/runt-mcp-proxy/src/tools.rs:98`).
   Removal/rename can trigger exit; schema changes under an unchanged name need
   a separate compatibility policy. Recovery hints are already caller-specific:
   installed wrapper at `crates/nteract-mcp/src/main.rs:204`, dev supervisor at
   `crates/mcp-supervisor/src/main.rs:3159`.
5. **Retry and protocol compatibility.** The proxy's one retry after a closed
   child transport does not establish exactly-once execution. Define any
   stronger retry guarantee and migration to the newer upstream protocol
   explicitly; do not infer either from transparent restart or SDK version.

Already-absent UUID refusal and file-backed UUID registry recovery are
implemented; the snapshot-disappearance race in Decision 8 remains a separate
limitation. Operator attribution and separate runtime-agent processes are also
implemented, not open prerequisites for the current MCP model.

## References

- `crates/runt-mcp/src/daemon_watch.rs` - incarnation reconciliation, `watch`, `rejoin`, and transition-sequence tests.
- `crates/runt-mcp/src/session.rs` - `NotebookSession`, `SessionDropReason`, `SessionDropInfo`.
- `crates/runt-mcp/src/lib.rs` - `NteractMcp`, active-session access and revalidation, upstream attribution.
- `crates/runt-mcp/src/session_activation.rs` - activation generations, coalescing, atomic publication helpers and tests.
- `crates/runt-mcp/src/tools/mod.rs` - readiness-aware access macros and tool dispatch.
- `crates/runt-mcp/src/tools/session.rs` - progressive local connect, create, parking, save, and disconnect.
- `crates/runt-mcp/src/resources.rs` - notebook-ID reads against active and parked sessions.
- `crates/runt-mcp-proxy/src/proxy.rs` - `McpProxy`, `restart_child`, child monitor, `track_session`.
- `crates/runt-mcp-proxy/src/session.rs` - `extract_session_id` for parsing tool results.
- `crates/runt-mcp-proxy/src/version.rs` - `ReconnectionEvent`, banner-message generation.
- `crates/runt-mcp-proxy/src/circuit_breaker.rs` - circuit breaker for crash loops.
- `crates/runtimed/src/notebook_sync_server/peer_eviction.rs` - kernel teardown task with all three race checks.
- `crates/runtimed/src/daemon.rs` - `room_eviction_delay`, `idle_peer_timeout`, `ghost_room_reaper_loop`, `ghost_room_reaper_sweep_with_cap`.
- `crates/runtimed-client/src/settings_doc.rs` - `keep_alive_secs` default (30), min (5), max (604800).
- `crates/runtimed-client/src/daemon_connection.rs` - `DaemonConnection`, heartbeat interval, `DaemonEvent` shape.
- `crates/mcp-supervisor/src/main.rs` - `DevMode` enum and `NTERACT_DEV_MODE` parsing.
- `.agents/skills/mcp-session-lifecycle/SKILL.md` - the operating rules; this ADR is the why.
