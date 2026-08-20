# MCP Session Lifecycle and Daemon Supervision

**Status:** Accepted, 2026-07-13; amended 2026-08-20; supersedes Draft from 2026-05-23.

**Neighbors:**
- `docs/adr/room-source-lifecycle-and-file-recovery.md` - the room-owned source states, recovery journal, and progressive capability gates observed by MCP sessions.
- `docs/adr/typed-frame-v4-wire-protocol.md` - the wire that backs every `DocHandle` the MCP server holds.
- `docs/adr/document-split.md` - what `NotebookSession.handle` actually points at (`NotebookDoc`, `RuntimeStateDoc`, plus the runtime broadcast).
- `docs/adr/execution-pipeline.md` - why a stale `DocHandle` is so painful for the agent: `required_heads`, output sync, and broadcast replay all run through it.
- `docs/adr/blob-storage-and-content-addressing.md` - the blob HTTP port lives on the same `Daemon` the MCP proxy supervises.
- `docs/adr/identity-and-trust.md` - the principal/operator model the proxy/child will eventually enforce per connection; today the MCP child connects as `local:<uid>` via peer creds.

## Context

The MCP server is the agent's only way into a live nteract notebook. It has to stand between three things that all have independent lifetimes:

1. **The MCP client** (Claude Code, the inspector, Codex, Zed). Connects on stdio, sends a stream of tool calls, expects every successful call to map to *some* notebook.
2. **The runtimed daemon**. Unix-socket server that owns the Automerge rooms, the kernels, and the file watchers. Restarts on user upgrade, on a crash, or because the user toggled debug/release in dev. Versions bump independently of the MCP child.
3. **The room.** The per-notebook entity inside the daemon. Holds the Automerge doc, source controller, recovery journal, kernel handle, file checkpoint writer, and peer counter. It survives the last peer disconnecting (for a while) so reconnects are cheap, and its journal survives reaping so acknowledged heads remain recoverable.

The MCP server is the only place all three meet. Tool calls are stateful by convention ("each connection has one active notebook session"), but the connection is a stdio pipe and the session is a `DocHandle` into the daemon. When any of the three layers tears down or restarts, the other two have to find each other again without leaking kernels, dropping outputs, or surprising the agent with a stale `notebook_id`.

The shape that fell out:

- A **supervisor** (`mcp-supervisor` in dev — the stdio entry the MCP client actually connects to) owns the child process and the daemon-version transition. Internally it uses `McpProxy` (the `runt-mcp-proxy` crate, a library) to drive the child-monitor loop and to assemble the reconnection banner; `runt-mcp-proxy` is not a binary the MCP client spawns directly.
- A **child** (`runt-mcp`, the `runt mcp` subcommand) holds the single active `NotebookSession` and runs the watch loop.
- The **daemon** holds the room and runs the ghost-room reaper.

Each layer has exactly one responsibility, and each one assumes the layer beneath it can disappear at any moment.

This ADR pins down those responsibilities, the state machine on the session lock, the races the code does and does not handle, and where the model breaks if we try to extend it (concurrent MCP clients, remote rooms, identity per peer).

## Decision 1: Three layers, three lifetimes, no shared state

The MCP server has three processes / loops with disjoint lifetimes:

```
[MCP client]            (stdio)
    |
[mcp-supervisor]        Process supervisor. Owns the child process.
                        (Uses runt-mcp-proxy as a library for monitor + banner.)
    | tracks: last_notebook_id, last_daemon_version, restart_count
    | does:   spawn child, monitor transport, restart on EOF or EX_TEMPFAIL,
    |         seed NTERACT_MCP_REJOIN_NOTEBOOK, prepend reconnection banner
    v (stdio)
[runt-mcp child]        Session state. Owns the DocHandle.
    | tracks: Arc<RwLock<Option<NotebookSession>>>,
    |         parked sessions, last_session_drop, peer_label
    | does:   daemon_watch loop, rejoin guard, tool dispatch
    v (Unix socket)
[runtimed daemon]       Room. Owns the kernel and the autosave debouncer.
    | tracks: active_peers atomic, last_kernel_torn_down_at,
    |         connection_generation, kernel_teardown_destructive
    | does:   kernel teardown after keep_alive_secs idle,
    |         ghost-room reaping at RESIDENT_ROOM_TTL_SECS
```

Each boundary is a process boundary. No shared memory, no shared lock, no transactional handoff. State that crosses a boundary is either a single env var (`NTERACT_MCP_REJOIN_NOTEBOOK`), a tool-result body (`notebook_id` parsed from JSON), or an event in the broadcast stream the daemon publishes (`DaemonEvent::{Connected, Disconnected, Upgraded}`).

This is deliberate. The proxy lives across daemon upgrades, but the child does not. The child lives across room evictions, but the session inside it does not. The room lives across peer disconnects, but the kernel inside it does not. The lifetime nesting is strict: proxy outlives child outlives session, room outlives session outlives kernel. Crossing one boundary never invalidates the layer above.

The cost we pay for the strict nesting is that every layer has to be re-entrant. The proxy has to handle the daemon-restart, child-crash, and daemon-upgrade cases through the same restart path. The child has to handle proxy handoff, daemon reconnect, and same-version daemon restart through the same rejoin path. The daemon has to handle "last peer left then came back five seconds later" without tearing down the kernel.

## Decision 2: Proxy modes are policy, not state

`mcp-supervisor` (the dev wrapper) recognises three values for `NTERACT_DEV_MODE`:

| Mode | Spawns daemon? | Manages worktree daemon? | Used by |
|------|----------------|--------------------------|---------|
| `owner` | yes if not running | yes (up/down/rebuild) | Claude Code, default |
| `attach` | no | no, errors out if missing | Codex, second IDE |
| `isolated` | yes, per session | yes, scoped to session dir | one-shot test runs |

For the stable / nightly desktop apps (the non-dev path), there is no `NTERACT_DEV_MODE`. The installed `runt mcp` binary is a sidecar that the user's nteract app launches; the app owns the daemon directly. The MCP server only ever talks to a daemon someone else started, which is structurally the same as `attach`.

**Why these three and not "always own the daemon."** Because two MCP clients on the same machine *will* try to spawn the daemon at the same time. The first wins by socket bind; the second crashes with `EADDRINUSE`. Splitting "may spawn" out of the child explicitly forces the user (or `.mcp.json`) to decide who's responsible. Letting the second client `attach` is the only way two clients can share a worktree without one losing a race against a socket.

**What attach mode does not guarantee.** It does not guarantee the daemon outlives the MCP child. If the owner kills the daemon, the attach-mode child sees `Disconnected` and goes through the normal rejoin loop. It does not get an "owner exited" notification. The watch loop has no concept of who owns the daemon, only whether the daemon is reachable.

This is a structural choice, not an oversight: the daemon doesn't know who its clients are beyond a peer label, so it cannot push "owner exited" anywhere. If we want explicit owner handoff (e.g., owner relinquishes ownership cleanly without killing the daemon), that's a feature on the daemon, not the proxy.

## Decision 3: The active slot plus daemon incarnation are session truth

The child holds one active slot:

```rust
session: Arc<RwLock<Option<NotebookSession>>>
```

A local session also carries `local_daemon_incarnation: Option<DaemonIncarnation>`, where the incarnation is `pid + started_at`. The slot answers which notebook is selected; the incarnation answers whether its local `DocHandle` belongs to the daemon that is live now. A hosted session deliberately has no local incarnation.

A local connect samples daemon identity before and after connection/readiness. Equal samples bind the session. A missing or changed sample leaves it unbound and it is not published as an active tool session. The watch loop removes any active or parked local session whose binding does not equal the live incarnation. Hosted sessions survive local-daemon reconciliation.

Tool handlers still clone the `DocHandle` under a read lock and release the lock before async work. The parked map remains a bounded cache, but parked local entries obey the same incarnation rule as the active slot.

## Decision 4: Tool intent and guarded publication are the convergence point

Recovery connects outside the session lock. It captures the explicit `session_intent_epoch` and expected daemon incarnation, verifies both after the async connect/readiness window, then takes the active-slot write lock. Publication occurs only if the epoch is unchanged and the slot is empty. A user tool that installs any session during recovery therefore wins, including a session for the same notebook.

A completed recovery connection may be dropped after doing useful work. Dropping its handle cleanly releases the extra peer; it is preferable to overwriting the user's selected session.

## Decision 5: Live daemon incarnation drives reconciliation

The watch loop does not infer connection state from a boolean latch. For every `DaemonEvent`, and obligatorily after `RecvError::Lagged`, it re-reads `DaemonConnection::info()`. That current info is the sole authority for local-session ownership.

Reconciliation removes active and parked local handles whose incarnation is missing or unequal. Removing the active handle records its best recovery target, preferring a file path and never replacing a saved path with a later UUID-only observation. With a live incarnation and an empty active slot, recovery uses the proxy handoff target first, then the preserved target.

The daemon version observed when the child starts is the version baseline. Every live event and every current `info()` result is compared with it; a mismatch exits with 75. If startup had no live daemon, the first live version establishes the baseline.

## Decision 6: A same-incarnation heartbeat is structurally a no-op

`Connected` may be emitted as a routine liveness refresh. When its live incarnation equals the active and parked local bindings, reconciliation changes nothing and has no recovery target to act on. No separate `was_disconnected` gate is required. A same-version daemon restart has a different `pid + started_at`, so the same reconciliation removes the old handles and recovers them against the new incarnation.

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

**Why the kernel is torn down anyway.** Kernels are expensive (one Python process, one env directory). Holding them past the keep-alive window costs CPU, RAM, and disk for a notebook nobody is watching. The 30-second default is conservative for agents (who reconnect on every tool call burst) and generous for humans (who don't notice the 30 s).

**The reconnect-during-teardown race.** Between the moment the last peer leaves and the moment the kernel-shutdown RPC fires, a peer can reconnect. The teardown task re-checks `active_peers == 0` and `connection_generation == teardown_generation` under the rooms lock before each destructive step (kernel shutdown RPC, env cleanup, `last_kernel_torn_down_at` stamp). The `kernel_teardown_destructive` flag is set under the same lock so the connect path knows to auto-launch a fresh kernel instead of using the doomed one.

That's three layers of defense against the same race: peer count, generation counter, destructive latch. Each one would catch the race in isolation; together they cover the case where one is checked and then the rooms lock is released for the next step. The pattern is "snapshot, do work, revalidate under the lock, advance." Slow and defensive on purpose; tearing down a kernel a user is actively using is the worst failure mode.

## Decision 8: Rejoin is keyed on file path for file-backed rooms

Ephemeral untitled notebooks are rejoined by UUID; file-backed notebooks are rejoined by path:

| Notebook type | Identified by | Rejoin method | Eviction check |
|--------------|---------------|---------------|----------------|
| File-backed | Path; the UUID is daemon-local and not durable across restarts | `connect_open(path)` | Daemon source controller restores matching journal state or imports disk; conflicts degrade explicitly |
| Untitled (persisted) | UUID | `connect(uuid)` | Daemon-authoritative (attaches if recoverable, refuses if gone) |

The reason: the path is the durable user-facing identity for a file-backed
room, while its UUID remains daemon-local. `connect_open(path)` lets the source
controller bind the current `.ipynb` fingerprint to its Automerge recovery
journal. A matching pair restores journal state; no journal imports disk; a
divergent pair preserves both and returns a degraded `source_conflict`. Rejoin
must not create an empty UUID room or delete unexported heads merely because the
previous resident room was reaped.

An untitled notebook is persisted by id to `docs_dir`, so on a daemon restart the daemon can reload it on a connect-by-id. The phantom-room failure mode (`#2088` - connecting to an evicted UUID minting an empty kernel-less room) is handled by `NotebookSync`-by-uuid being **attach-only and daemon-authoritative**: the daemon attaches to a resident room, reloads one still recoverable from its persisted doc, and **refuses** a gone one (a `NotebookConnectionInfo` with `error`, surfaced by the client as `SyncError::Protocol`) rather than minting a phantom. The rejoin just attempts the reconnect: recovered -> keep, refused -> clear `Evicted`. The phantom is prevented at the authoritative layer instead of guessed at by the client. The NotebookSync route to `create_empty_notebook` on a pristine room is not part of this attach-by-id path; `create_empty_notebook` remains the live seeding helper for explicit create/open flows.

**The path has to actually be on the session, or this whole decision is a no-op.** A session established by `connect_notebook(notebook_id=...)` does not learn its path for free - the by-id connect path (`ConnectResult`) has no `notebook_path`, unlike `connect_open`'s `OpenResult`. Until 2026-06, the by-id branch stored `notebook_path: None`, so a file-backed room joined by UUID rejoined by *UUID*, which Decision 8 says creates an empty room. On the nightly channel (frequent daemon upgrades) this was the live "agent sees `cells: []` while the desktop shows the notebook" bug: the desktop kept the path and reloaded, the agent kept the UUID and did not. The fix resolves the room's canonical path from `list_rooms` on a by-id connect and stores it on the session (in-child rejoin), and surfaces `notebook_path` in the connect/create response so the proxy seeds the path (not the UUID) into a respawned child's rejoin target. See `docs/adr/notebook-identity-and-path-binding.md` for why the path, not the UUID, is the durable handle.

## Decision 9: `SessionDropReason` is the agent-facing recovery hint

When a tool call lands and finds `session = None`, the error has to tell the agent how to recover. `last_session_drop` records the last reason the session was cleared:

| Reason | What happened | Recovery |
|--------|---------------|----------|
| `Switched` | Agent called `connect_notebook` on a different notebook | Park slot may still have the previous one; call `connect_notebook` again with the old `notebook_id` |
| `Evicted` | Room was reaped by the ghost-room sweep or evicted in `list_rooms` check | Notebook is gone; create a new one or open the file |
| `Disconnected` | Daemon went away and rejoin failed; **also** set on user-initiated `disconnect_notebook` and on the immediate clear when `MarkDisconnected` fires (before any rejoin retry runs) | Wait for daemon to come back; the watch loop will retry on next `Connected`. For the user-initiated case there is no retry. |

The error message is generated at the point of tool failure (`no_session_error()`), so the agent sees a reason that matches *the most recent* drop. The drop info is best-effort: if the session is cleared twice (e.g., disconnect followed by an evict on rejoin), the second one overwrites the first. The previous `notebook_id` and `notebook_path` are kept so the recovery message can name what was lost.

## Decision 10: Connection activation is progressive and generation-guarded

`session: Some` identifies the selected target; it does not mean every
subsystem is ready. Each connect activation carries a monotonically increasing
`session_generation`, the normalized target, a retained daemon projection, and
separate readiness for room projection, the local NotebookDoc peer, the local
RuntimeStateDoc peer, and the runtime.
Pending activation metadata is not a second active session; `session` remains
the only installed target.

`connect_notebook` remains one call. It returns after the room offers a safe
projection, either `ProjectionReady` or `Degraded` with a retained projection,
with stable cell IDs, projection heads and completeness, source state, later
readiness, and explicit read/mutate/execute capabilities. The local Automerge
peers continue converging in the background.

Tool handlers use operation-specific gates:

- daemon projection reads require `ProjectionReady`;
- local NotebookDoc reads and mutations require `Interactive` and any requested
  causal heads;
- execution additionally requires runtime readiness and carries
  `required_heads` through the existing execution gate.

The UI and MCP mutation surface stay read-only before `Interactive`, while the
low-level sync peer may still accept and durably journal Automerge changes. A
retained projection is inspectable after local sync failure but never
authorizes writes or execution against cached source.

Every async wait captures its activation generation and re-checks it before
installing state or dispatching an operation. A different target supersedes the
old generation. Concurrent connects for the same canonical path, resident UUID,
or normalized hosted target coalesce behind one in-flight attach and projection
result. Path and UUID aliases for a known file-backed room resolve through the
daemon to the same room key before coalescing. Session locks are not held across
file loading, socket connection, projection, or sync waits.

Failures are structured as `notebook_not_ready`, `runtime_not_ready`,
`source_degraded`, `source_conflict`, `session_superseded`, or `sync_failed`.
`notebook_not_ready` always carries closed mutate/execute capabilities. When
the document plane is already interactive and only the runtime is missing,
runtime reads and execution fail as `runtime_not_ready` instead, with mutation
still open. Projection success followed by local peer failure leaves a
degraded read-only session; source failure before a projection can be honored
fails the connection directly.

## Worked examples

### Cold start: Claude Code spawns owner-mode proxy

1. Claude Code spawns `mcp-supervisor` over stdio. The supervisor's internal `McpProxy` reads cached tool list from disk and returns it immediately to the MCP `tools/list` request, so Claude Code's tool registry is populated without waiting on the daemon.
2. Supervisor receives `notifications/initialized`. Spawns the `runt mcp` child.
3. Child connects to the daemon socket via peer creds, sees no `NTERACT_MCP_REJOIN_NOTEBOOK`, sits idle with `session = None`.
4. Agent calls `connect_notebook { path: "/tmp/foo.ipynb" }`. Proxy forwards to child. The daemon source controller creates or restores the room, publishes a heads-qualified projection, and the child installs the generation-guarded session. The call returns the `notebook_id` and stable cell projection while local peers continue converging.
5. Proxy parses the response, stores `notebook_id` in `last_notebook_id`. This is the seed for the next restart.
6. Subsequent tool calls clone the handle under a read lock and execute.

### Daemon upgrade during an active session

1. User upgrades the nteract desktop app. The installed daemon restarts; the new binary has version 2.1.3 (old was 2.1.2).
2. Child's `DaemonConnection` detects the daemon version change and emits `DaemonEvent::Upgraded { previous: 2.1.2, current: 2.1.3 }`.
3. Watch loop compares the live version with its startup baseline and exits with `EX_TEMPFAIL` (75).
4. Proxy's child monitor sees the transport close, calls `restart_child()`. Re-resolves the child binary (picks up new symlink target after upgrade), seeds `NTERACT_MCP_REJOIN_NOTEBOOK = <last_notebook_id>`, spawns the new child.
5. New child's watch loop sees the handoff target. On the first live daemon observation it reconciles the empty slot, runs recovery against that daemon incarnation, and installs a freshly stamped `NotebookSession` if no tool activation won meanwhile.
6. Supervisor detects the daemon-version change across the child boundary (compares `ServerInfo.title` of old vs new child) and stamps a reconnection banner. The actual string is `Daemon upgraded (2.1.2 -> 2.1.3), session reconnected` (`crates/runt-mcp-proxy/src/version.rs:35`), and it fires whenever `rejoin_target.is_some()`, before the rejoin's success is known.
7. The agent's next tool result has the banner prepended. The agent sees one message; underneath, the child has been completely replaced.

### Last peer leaves, comes back during teardown

1. Agent calls `disconnect_notebook` (or the MCP client exits). Child's session goes to `None`. Daemon sees the peer disconnect; `active_peers` drops to 0.
2. Daemon schedules kernel teardown for `keep_alive_secs` (default 30 s). Snapshots `teardown_generation = current connection_generation`.
3. At 25 s, agent calls `connect_notebook` on the same notebook. Daemon increments `active_peers` from 0 to 1, bumps `connection_generation`, zeroes `last_kernel_torn_down_at`.
4. At 30 s, teardown task wakes, requests a synchronous flush of the persist debouncer, then revalidates under the rooms lock: `active_peers != 0`. Teardown task returns without touching the kernel.
5. Agent's reconnect lands on the same room with the same kernel. No env rebuild, no relaunch.

### Daemon goes away mid-execution

1. The tool call owns a cloned local handle stamped with daemon incarnation A.
2. When the daemon disappears, the watch loop re-reads no live daemon info. Reconciliation removes active and parked local handles, preserves the active session's path when available, and records `SessionDropReason::Disconnected`. Hosted handles remain installed.
3. The in-flight tool's cloned handle observes the closed socket and returns failure; no session lock is held across that await.
4. When daemon incarnation B becomes live, reconciliation still cannot retain any handle from A. With an empty active slot it reconnects using the preserved path (or UUID for recoverable untitled notebooks).
5. Recovery verifies incarnation B again after readiness, then publishes only if explicit tool intent has not advanced and the slot is still empty. A tool-installed session for B wins the race and is retained.

### Two MCP clients, attach mode

1. Claude Code starts in `owner` mode, spawns the worktree daemon. Connects child to socket, opens a notebook.
2. User starts Codex in `attach` mode against the same worktree. Codex's `mcp-supervisor` reads `NTERACT_DEV_MODE=attach`, asserts the daemon socket is reachable, spawns a child that connects without trying to start the daemon.
3. Both children have their own `NotebookSession` slots. Both can call `connect_notebook` on the same notebook; each becomes a separate peer on the room, with `active_peers` going from 1 to 2.
4. One agent calls `execute_cell`; the other agent sees the cell-state changes via Automerge sync. There is no per-client routing, no per-client identity, no per-client scope (Decision 5 in `identity-and-trust.md` will eventually change this).
5. If Claude Code exits, its child closes the socket, daemon decrements `active_peers` to 1. The daemon does *not* tear down because Codex is still connected. The daemon is now orphan-owned (Claude Code started it, Codex is using it). If Codex also exits, `active_peers` goes to 0 and the kernel-teardown timer starts.

## 2026-08-20 implementation note

Decisions 3 through 6 use daemon incarnation rather than disconnect latches as
the authority for whether a local `DocHandle` is usable.

Every local `NotebookSession` is stamped with a `DaemonIncarnation` consisting
of the daemon PID and `started_at`. The connect path samples daemon identity
before and after establishing the peer. Only an unchanged pair binds the
session; a missing or changed sample produces an unbound local session, which
is stale by definition. Hosted sessions have no local incarnation.

On every daemon event, and after a lagged broadcast receiver, the watch loop
reads `DaemonConnection::info()` and reconciles the active slot and parked map
under their locks. A local session survives exactly when its incarnation equals
the live incarnation. Hosted sessions always survive local-daemon events. Thus
a same-incarnation `Connected` heartbeat makes no state change, while a
same-version restart with a new incarnation removes old handles without a
separate disconnect latch. Parked local handles follow the same rule.

When reconciliation removes the active local session it preserves the path,
when known, as the recovery target; a later UUID-only observation cannot
replace that path. Recovery connects outside the session lock, samples the
expected incarnation again after readiness, and publishes only if the explicit
`session_intent_epoch` is unchanged and no tool-installed session occupies the
slot. Explicit tool activation therefore remains authoritative.

The child records the daemon version observed at startup. Every live event and
every post-lag `info()` sample is compared with that baseline. A mismatch exits
with `EX_TEMPFAIL` (75), even if the event stream dropped the original upgrade
event. If no daemon was reachable at startup, the first live version becomes
the baseline.

Repeated `connect_notebook` calls may reuse the active same-target replica only
when its peer is connected, its document or retained projection is readable,
and (for local sessions) its incarnation equals the current daemon. Reuse of a
stale but locally readable replica is forbidden.

## Open Questions

These are the architectural gaps surfaced while writing this ADR. None block the current shape; all need decisions before we scale beyond one-MCP-client-per-daemon.

1. **Concurrent MCP clients per child process.** The session state is `Arc<RwLock<Option<NotebookSession>>>` - one slot. The "north star" line in the skill is "multiple concurrent MCP clients against the same daemon," and today's answer is "run one child per client" (attach mode). If two MCP clients ever share a child, every tool call needs a `notebook_id` parameter, the `require_handle!` macro needs notebook routing, and the proxy needs a session registry instead of `last_notebook_id`. Open question: do we ever want this, or is the attach-mode "one child per client, share the daemon" pattern enough?

2. **Per-MCP-client peer identity.** Today every child connects to a room as a single peer with a single peer label. The default is `"Inkwell"`, optionally overridden by the upstream MCP client's `Implementation.name` (e.g., `"Claude Code"`) - see `crates/runt-mcp/src/lib.rs:56-57, :83, :245-255`. If multiple clients share a child, they need distinct peer identities so presence works and attribution is honest. This ties directly into Decision 1 of `identity-and-trust.md` (operator-per-actor labels), but the wiring from "MCP client identity" to "actor label" does not exist yet.

3. **Daemon ownership across attach/owner boundaries.** Attach-mode children do not know who owns the daemon. If the owner exits cleanly, the daemon may or may not exit too depending on whether anyone else is connected. There is no protocol-level "I am the owner, I am exiting now" signal. Today this is fine because the user is responsible for noticing. As we ship more agents that auto-spawn MCP clients, the implicit "first wins, others attach" rule will get racy.

4. **Recovery-target precision after a daemon replacement.** The child retains
   the removed session's best target, preferring a path over a UUID. The daemon
   can still refuse an ephemeral UUID that is no longer recoverable, producing
   a `Disconnected` then `Evicted` trail for the agent.

5. **`parked_sessions` lifetime.** Capped at `MAX_PARKED_SESSIONS` with arbitrary HashMap-iteration eviction. Every parked session holds a live peer connection to the daemon, which means the daemon's `active_peers` for those rooms stays at 1 even when the agent is not actively using them. That keeps the kernel alive (good if the agent comes back), but it also disables the eviction timer for any notebook the agent has touched in the recent past. Open question: is the kernel-keep-alive the intended cost, or do we want parked sessions to drop the peer connection and rebuild on resume?

6. **Cross-daemon proxy resumption.** Proxy stamps the reconnection banner from `(old_daemon_version, new_daemon_version)`. For **file-backed** notebooks this is now handled: the proxy seeds the *path* (not the UUID) into the respawned child's rejoin target, and the path is meaningful across daemon instances, so the source controller can reconcile the recovery journal and current file (Decision 8; `docs/adr/notebook-identity-and-path-binding.md` Decision 5). The remaining gaps are **ephemeral** notebooks (no path; their UUID is daemon-instance scoped, so a cross-daemon respawn loses them) and a daemon socket *path* change (dev-mode worktree switch in isolated mode), where even a file-backed `last_notebook_id` UUID would be meaningless - tracked as MSL-4.

7. **MCP child as runtime peer.** The child connects as the user's "operator" today, but the daemon has no concept of `runtime_peer` vs `editor` scope (Decision 5 of `identity-and-trust.md`). If we ever split the kernel sidecar off into its own process, that process will connect as `runtime_peer`. The MCP child does both (edits cells and triggers kernel commands). Reconciling that with the per-connection scope model is unresolved.

8. **`is_transport_closed` polling.** Proxy uses 500 ms polling because `RunningService` is not cloneable and `waiting()` consumes `self`. This is fine, but it adds up to 500 ms of latency between child exit and restart. Open question: is the rmcp API the right place to push back on, or do we live with the polling?

9. **`should_exit` on tool divergence.** When a daemon upgrade introduces a tool whose name or shape collides incompatibly with the cache, the proxy sets `should_exit = true` and returns an error. The MCP client then has to reconnect. The error message says "you may need to reinstall the nteract extension," which is correct for the MCPB bundle but not for `nteract-dev` (where the supervisor manages the binary on disk). The branching on environment is missing.

10. **Owner-mode and managed-daemon ownership across worktrees.** In dev, the supervisor manages a daemon per git worktree. If two worktrees of the same repo run owner-mode supervisors, each spawns its own daemon at a different socket. If a user switches worktrees mid-session by editing `.envrc`, the proxy keeps talking to the old daemon (the env vars only change for new shells). There is no detection. The fix is on the dev path, not the production path, but it bites regularly.

## References

- `crates/runt-mcp/src/daemon_watch.rs` - incarnation reconciliation, `watch`, `rejoin`, and transition-sequence tests.
- `crates/runt-mcp/src/session.rs` - `NotebookSession`, `SessionDropReason`, `SessionDropInfo`.
- `crates/runt-mcp/src/lib.rs` - `NteractMcp` server, `require_handle!` macro, tool dispatch.
- `crates/runt-mcp/src/tools/session.rs` - `connect_notebook`, `create_notebook`, parking, `disconnect_previous_session`.
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
