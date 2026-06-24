# MCP Session Lifecycle and Daemon Supervision

**Status:** Draft, 2026-05-23.

**Neighbors:**
- `docs/adr/typed-frame-v4-wire-protocol.md` - the wire that backs every `DocHandle` the MCP server holds.
- `docs/adr/document-split.md` - what `NotebookSession.handle` actually points at (`NotebookDoc`, `RuntimeStateDoc`, plus the runtime broadcast).
- `docs/adr/execution-pipeline.md` - why a stale `DocHandle` is so painful for the agent: `required_heads`, output sync, and broadcast replay all run through it.
- `docs/adr/blob-storage-and-content-addressing.md` - the blob HTTP port lives on the same `Daemon` the MCP proxy supervises.
- `docs/adr/identity-and-trust.md` - the principal/operator model the proxy/child will eventually enforce per connection; today the MCP child connects as `local:<uid>` via peer creds.

## Context

The MCP server is the agent's only way into a live nteract notebook. It has to stand between three things that all have independent lifetimes:

1. **The MCP client** (Claude Code, the inspector, Codex, Zed). Connects on stdio, sends a stream of tool calls, expects every successful call to map to *some* notebook.
2. **The runtimed daemon**. Unix-socket server that owns the Automerge rooms, the kernels, and the file watchers. Restarts on user upgrade, on a crash, or because the user toggled debug/release in dev. Versions bump independently of the MCP child.
3. **The room.** The per-notebook entity inside the daemon. Holds the Automerge doc, the kernel handle, the autosave debouncer, and a peer counter. Survives the last peer disconnecting (for a while) so reconnects are cheap.

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

## Decision 3: `Arc<RwLock<Option<NotebookSession>>>` is the only session truth

The child holds exactly one place that says "the current session is X":

```rust
session: Arc<RwLock<Option<NotebookSession>>>
```

`Option` is the load-bearing part. Three things set it to `None`:

1. **Daemon disconnect.** The watch loop's `MarkDisconnected` branch clears the session immediately so tool calls don't hang on a dead `DocHandle`. The previous notebook target is stashed in `disconnect_target` for automatic rejoin on the next `Connected`.
2. **Room eviction.** When `rejoin()` runs and `list_rooms` does not contain the target notebook UUID, the session is cleared and `SessionDropReason::Evicted` is recorded. No phantom empty room is created.
3. **Rejoin failure after `REJOIN_MAX_RETRIES`.** The session is cleared and `SessionDropReason::Disconnected` is recorded with the original notebook id and path so the next tool call gets a meaningful error.

Three things set it to `Some(_)`:

1. **A tool call** (`connect_notebook`, `create_notebook`, or the legacy `open_notebook` alias). Always wins. The user (or agent) explicitly chose this notebook.
2. **The watch loop's `rejoin()`** after a `Disconnected`, an `Upgraded`, or the initial proxy handoff. Conditional on the session-write guard (Decision 4).
3. **Resume from `parked_sessions`** when a tool call targets a notebook whose session was parked during a previous switch.

**Why one optional slot and not a registry of sessions.** Because the MCP protocol itself is single-client-per-connection. The MCP client is the agent (a single conversation), and that agent has one current notebook by convention. Multi-notebook would mean every tool call carries a `notebook_id` arg; today most don't. The `parked_sessions` map is a compromise: it lets `connect_notebook` switch back and forth between a small set of notebooks without re-doing the initial sync, but it does not let *concurrent* tool calls land on different notebooks. The "current" notebook is still one slot.

**Why `RwLock` and not `Mutex`.** Tool handlers clone the `DocHandle` under a read lock and drop the lock before doing any async work. Holding a write lock during async work would block every other tool call and the watch loop. `DocHandle` is cheap to clone (it's an `Arc<Mutex<SharedDocState>>` internally); the read lock is held only long enough to clone.

This convention is enforced by the `require_handle!` macro:

```rust
let handle = {
    let guard = session.read().await;
    match guard.as_ref() {
        Some(s) => s.handle.clone(),
        None => return no_session_error(...).await,
    }
};
// guard dropped; handle owned
handle.with_doc(|doc| { ... });
```

Tool code that doesn't use the macro and holds the lock through an `.await` is the most likely way to wedge the child. The `tokio-mutex-guard-stays-sync` rule in `AGENTS.md` / `CLAUDE.md` applies here too.

## Decision 4: The session-write guard is the convergence point

The longest async window in the child is `rejoin()`. It connects to the daemon socket, sends the initial sync handshake, awaits session-ready (up to 120 s), and only then installs the new session. During that window, a tool call can land and call `connect_notebook` on a different notebook. The guard:

```rust
{
    let guard = session.read().await;
    if let Some(existing) = guard.as_ref() {
        if existing.notebook_id != new_notebook_id {
            info!("Rejoin superseded by active session; dropping");
            return true;
        }
    }
}
*session.write().await = Some(new_session);
```

**Invariant: user-initiated session changes always win over background rejoin.** The guard runs immediately before the write. Anything else (the proxy's seeded target, the disconnect target, the previous session's notebook id) is advisory.

The guard does *not* hold the write lock across the entire rejoin. That would defeat the read-clone-drop pattern from Decision 3 and serialize every tool call behind a 120-second async window on the daemon socket.

The cost: rejoin can do all the work (connect, initial sync, peer announce) and then drop the result on the floor. That's fine. The peer connection drops cleanly when the `handle` goes out of scope, the daemon decrements its peer count, and the user's chosen session is left alone. We've paid one network round trip and one initial sync we then discard. Acceptable for what would otherwise be a class of bugs where the wrong notebook silently becomes the active session.

## Decision 5: `classify()` is the pure decision function; the loop is plumbing

`daemon_watch::classify()` is a pure function over `(event, initial_target, has_session, was_disconnected, disconnect_target)`. It returns one of:

| Decision | Trigger |
|----------|---------|
| `Exit(75)` | `Upgraded` with version change. Proxy will respawn with new binary. |
| `RejoinInitial(target)` | `Connected`/`Upgraded` with `initial_target` set (proxy handoff), OR `Connected`/`Upgraded` with `disconnect_target` set (session was cleared on disconnect). |
| `RejoinContinuation` | `Connected` after `Disconnected` with session still live, OR `Upgraded` (same version) with session still live. |
| `MarkDisconnected` | `Disconnected` event. |
| `NoOp` | Everything else, notably `Connected` heartbeats. |

The function is pure so the watch loop's interleavings are testable in isolation: the heartbeat-not-rejoin invariant (Decision 6), the proxy-handoff-clears-after-success rule, the disconnect-target priority, all live in the table.

**The watch loop does the side effects.** It clears `initial_target` only after `rejoin()` returns `true` (success, including "session cleared because room was evicted"). It bumps `was_disconnected` to true on lag (`broadcast::error::RecvError::Lagged`) because a dropped batch may have contained the `Disconnected`. It stamps `last_session_drop` and clears `parked_sessions` when the daemon goes away (their `DocHandle`s are dead too).

The classify/act split is the same pattern as our other state machines (cell execution, room teardown), and it's there for the same reason: every interleaving is a unit test, none of the side effects need an async runtime.

## Decision 6: Daemon `Connected` is a heartbeat, not a reconnect signal

`DaemonConnection` (in `runtimed-client`) emits `Connected` every ~10 s as a liveness ping. Without gating, every heartbeat would trigger a `rejoin()`, which would:

1. Open a fresh peer connection to the daemon.
2. Bump the room's `active_peers` from 1 to 2.
3. Drop the old peer connection.
4. Decrement `active_peers` from 2 to 1.

That sequence resets the room's eviction timer (the daemon zeroes `last_kernel_torn_down_at` on any peer count increase). With heartbeats every 10 s, an idle agent connection keeps a room alive forever. The fix (#2088) is the `was_disconnected` flag: a `Connected` only triggers a continuation rejoin if we previously saw a `Disconnected`.

This is structurally a workaround for `DaemonConnection`'s API conflating "I'm still here" with "I just came back." A cleaner shape would be a separate `Heartbeat` event variant, but the cost of the workaround is one boolean and a regression test.

## Decision 7: Room is the durable entity; sessions and kernels are not

The daemon's eviction model has three layers:

1. **Kernel teardown** (`peer_eviction.rs`). All peers leave; after `keep_alive_secs` (default 30 s, configurable 5 s to 7 days), the kernel is shut down and the env directory is cleaned up. The room itself stays resident. The autosave debouncer and file watchers also stay alive.
2. **Ghost-room reaping** (`daemon::ghost_room_reaper_loop`). Every 5 minutes, sweep peer-less rooms whose kernel has been torn down. TTL is 24 hours; cap is 32 peer-less rooms. Aged-out or overflowed rooms are removed from `notebook_rooms` and `path_index` for good.
3. **Daemon shutdown.** Everything goes.

**Why the room outlives the kernel.** Reconnects are common. A user closes the desktop window and re-opens it; a Claude Code session ends and a new one begins on the same notebook; a daemon upgrade restarts the child. In every case the agent or the UI wants to land on the same `notebook_id` with the same outputs visible and (where possible) the kernel still warm. Tearing down the room on the last disconnect would force a full re-load of the document, the file watcher rebind, and (if there's no `.ipynb` to reload from) loss of ephemeral cell state. Keeping the room resident makes reconnects cheap and idempotent.

**Why the kernel is torn down anyway.** Kernels are expensive (one Python process, one env directory). Holding them past the keep-alive window costs CPU, RAM, and disk for a notebook nobody is watching. The 30-second default is conservative for agents (who reconnect on every tool call burst) and generous for humans (who don't notice the 30 s).

**The reconnect-during-teardown race.** Between the moment the last peer leaves and the moment the kernel-shutdown RPC fires, a peer can reconnect. The teardown task re-checks `active_peers == 0` and `connection_generation == teardown_generation` under the rooms lock before each destructive step (kernel shutdown RPC, env cleanup, `last_kernel_torn_down_at` stamp). The `kernel_teardown_destructive` flag is set under the same lock so the connect path knows to auto-launch a fresh kernel instead of using the doomed one.

That's three layers of defense against the same race: peer count, generation counter, destructive latch. Each one would catch the race in isolation; together they cover the case where one is checked and then the rooms lock is released for the next step. The pattern is "snapshot, do work, revalidate under the lock, advance." Slow and defensive on purpose; tearing down a kernel a user is actively using is the worst failure mode.

## Decision 8: Rejoin is keyed on file path for file-backed rooms

Ephemeral untitled notebooks are rejoined by UUID; file-backed notebooks are rejoined by path:

| Notebook type | Identified by | Rejoin method | Eviction check |
|--------------|---------------|---------------|----------------|
| File-backed | Path; the UUID is daemon-local and not durable across restarts | `connect_open(path)` | `list_rooms` (only for ephemeral path; file-backed implicitly reloads) |
| Ephemeral (untitled) | UUID | `connect(uuid)` | Explicit `list_rooms` lookup |

The reason: file-backed rooms persist their state as `.ipynb`, not as a long-lived Automerge `.automerge` blob. When a file-backed room is reaped, its `.automerge` file is deleted; rejoining by UUID would create a new empty room with no cells. `connect_open(path)` triggers the daemon's reload-from-disk path so the agent finds the same cells it left.

Ephemeral rooms have no on-disk fallback. Their state is in the Automerge `.automerge` blob the daemon writes for resident rooms, which is also deleted on reap. The explicit `list_rooms` lookup avoids the "phantom room" failure mode: connecting to an evicted UUID would create an empty room with no kernel, no history, no outputs, and the agent would have no signal that anything went wrong.

**The path has to actually be on the session, or this whole decision is a no-op.** A session established by `connect_notebook(notebook_id=...)` does not learn its path for free - the by-id connect path (`ConnectResult`) has no `notebook_path`, unlike `connect_open`'s `OpenResult`. Until 2026-06, the by-id branch stored `notebook_path: None`, so a file-backed room joined by UUID rejoined by *UUID*, which Decision 8 says creates an empty room. On the nightly channel (frequent daemon upgrades) this was the live "agent sees `cells: []` while the desktop shows the notebook" bug: the desktop kept the path and reloaded, the agent kept the UUID and did not. The fix resolves the room's canonical path from `list_rooms` on a by-id connect and stores it on the session (in-child rejoin), and surfaces `notebook_path` in the connect/create response so the proxy seeds the path (not the UUID) into a respawned child's rejoin target. See `docs/adr/notebook-identity-and-path-binding.md` for why the path, not the UUID, is the durable handle.

## Decision 9: `SessionDropReason` is the agent-facing recovery hint

When a tool call lands and finds `session = None`, the error has to tell the agent how to recover. `last_session_drop` records the last reason the session was cleared:

| Reason | What happened | Recovery |
|--------|---------------|----------|
| `Switched` | Agent called `connect_notebook` on a different notebook | Park slot may still have the previous one; call `connect_notebook` again with the old `notebook_id` |
| `Evicted` | Room was reaped by the ghost-room sweep or evicted in `list_rooms` check | Notebook is gone; create a new one or open the file |
| `Disconnected` | Daemon went away and rejoin failed; **also** set on user-initiated `disconnect_notebook` and on the immediate clear when `MarkDisconnected` fires (before any rejoin retry runs) | Wait for daemon to come back; the watch loop will retry on next `Connected`. For the user-initiated case there is no retry. |

The error message is generated at the point of tool failure (`no_session_error()`), so the agent sees a reason that matches *the most recent* drop. The drop info is best-effort: if the session is cleared twice (e.g., disconnect followed by an evict on rejoin), the second one overwrites the first. The previous `notebook_id` and `notebook_path` are kept so the recovery message can name what was lost.

## Worked examples

### Cold start: Claude Code spawns owner-mode proxy

1. Claude Code spawns `mcp-supervisor` over stdio. The supervisor's internal `McpProxy` reads cached tool list from disk and returns it immediately to the MCP `tools/list` request, so Claude Code's tool registry is populated without waiting on the daemon.
2. Supervisor receives `notifications/initialized`. Spawns the `runt mcp` child.
3. Child connects to the daemon socket via peer creds, sees no `NTERACT_MCP_REJOIN_NOTEBOOK`, sits idle with `session = None`.
4. Agent calls `connect_notebook { path: "/tmp/foo.ipynb" }`. Proxy forwards to child. Child opens a peer connection, daemon creates the room (or rebinds the path index to an existing resident room), child stores the `DocHandle` in `session`, returns the `notebook_id`.
5. Proxy parses the response, stores `notebook_id` in `last_notebook_id`. This is the seed for the next restart.
6. Subsequent tool calls clone the handle under a read lock and execute.

### Daemon upgrade during an active session

1. User upgrades the nteract desktop app. The installed daemon restarts; the new binary has version 2.1.3 (old was 2.1.2).
2. Child's `DaemonConnection` detects the daemon version change and emits `DaemonEvent::Upgraded { previous: 2.1.2, current: 2.1.3 }`.
3. Watch loop classifies as `Exit(75)`. Process exits with `EX_TEMPFAIL`.
4. Proxy's child monitor sees the transport close, calls `restart_child()`. Re-resolves the child binary (picks up new symlink target after upgrade), seeds `NTERACT_MCP_REJOIN_NOTEBOOK = <last_notebook_id>`, spawns the new child.
5. New child's watch loop sees `initial_target = Some(<id>)`. On first `Connected`, classifies as `RejoinInitial`, runs `rejoin()`, installs new `NotebookSession`. Same `notebook_id`, fresh `DocHandle`.
6. Supervisor detects the daemon-version change across the child boundary (compares `ServerInfo.title` of old vs new child) and stamps a reconnection banner. The actual string is `Daemon upgraded (2.1.2 -> 2.1.3), session reconnected` (`crates/runt-mcp-proxy/src/version.rs:35`), and it fires whenever `rejoin_target.is_some()`, before the rejoin's success is known.
7. The agent's next tool result has the banner prepended. The agent sees one message; underneath, the child has been completely replaced.

### Last peer leaves, comes back during teardown

1. Agent calls `disconnect_notebook` (or the MCP client exits). Child's session goes to `None`. Daemon sees the peer disconnect; `active_peers` drops to 0.
2. Daemon schedules kernel teardown for `keep_alive_secs` (default 30 s). Snapshots `teardown_generation = current connection_generation`.
3. At 25 s, agent calls `connect_notebook` on the same notebook. Daemon increments `active_peers` from 0 to 1, bumps `connection_generation`, zeroes `last_kernel_torn_down_at`.
4. At 30 s, teardown task wakes, requests a synchronous flush of the persist debouncer, then revalidates under the rooms lock: `active_peers != 0`. Teardown task returns without touching the kernel.
5. Agent's reconnect lands on the same room with the same kernel. No env rebuild, no relaunch.

### Daemon goes away mid-execution

1. Agent calls `execute_cell`. Tool dispatch clones the handle, sends the
   request, then polls `RuntimeStateDoc` until the execution reaches a terminal
   state, with the execution pipeline's output-sync grace applied before
   returning outputs.
2. Daemon process is killed (SIGKILL from `runt daemon stop`, or a crash). Watch loop receives `DaemonEvent::Disconnected`, classifies as `MarkDisconnected`. Stashes `disconnect_target = "/tmp/foo.ipynb"`, sets `session = None`, sets `last_session_drop = Disconnected`. Also drains `parked_sessions` (their handles are dead).
3. In-flight `execute_cell` tool call's `DocHandle` is now connected to a
   closed socket. Whatever it was awaiting (RPC response or RuntimeStateDoc
   convergence) errors out. Tool returns failure to the agent.
4. Daemon comes back (launchd respawn, or user restart). Child's `DaemonConnection` reconnects; emits `Connected`.
5. Watch loop classifies as `RejoinInitial("/tmp/foo.ipynb")` because `disconnect_target` is set and `was_disconnected = true`. Runs `rejoin()` via `connect_open`, installs new session.
6. Next tool call from the agent lands on a fresh `DocHandle` for the same notebook. Cells the agent had already authored before the disconnect are still there (loaded from `.ipynb`); cells authored during the disconnect window (there are none, because the agent's tool call failed) are not lost.

### Two MCP clients, attach mode

1. Claude Code starts in `owner` mode, spawns the worktree daemon. Connects child to socket, opens a notebook.
2. User starts Codex in `attach` mode against the same worktree. Codex's `mcp-supervisor` reads `NTERACT_DEV_MODE=attach`, asserts the daemon socket is reachable, spawns a child that connects without trying to start the daemon.
3. Both children have their own `NotebookSession` slots. Both can call `connect_notebook` on the same notebook; each becomes a separate peer on the room, with `active_peers` going from 1 to 2.
4. One agent calls `execute_cell`; the other agent sees the cell-state changes via Automerge sync. There is no per-client routing, no per-client identity, no per-client scope (Decision 5 in `identity-and-trust.md` will eventually change this).
5. If Claude Code exits, its child closes the socket, daemon decrements `active_peers` to 1. The daemon does *not* tear down because Codex is still connected. The daemon is now orphan-owned (Claude Code started it, Codex is using it). If Codex also exits, `active_peers` goes to 0 and the kernel-teardown timer starts.

## Open Questions

These are the architectural gaps surfaced while writing this ADR. None block the current shape; all need decisions before we scale beyond one-MCP-client-per-daemon.

1. **Concurrent MCP clients per child process.** The session state is `Arc<RwLock<Option<NotebookSession>>>` - one slot. The "north star" line in the skill is "multiple concurrent MCP clients against the same daemon," and today's answer is "run one child per client" (attach mode). If two MCP clients ever share a child, every tool call needs a `notebook_id` parameter, the `require_handle!` macro needs notebook routing, and the proxy needs a session registry instead of `last_notebook_id`. Open question: do we ever want this, or is the attach-mode "one child per client, share the daemon" pattern enough?

2. **Per-MCP-client peer identity.** Today every child connects to a room as a single peer with a single peer label. The default is `"Inkwell"`, optionally overridden by the upstream MCP client's `Implementation.name` (e.g., `"Claude Code"`) - see `crates/runt-mcp/src/lib.rs:56-57, :83, :245-255`. If multiple clients share a child, they need distinct peer identities so presence works and attribution is honest. This ties directly into Decision 1 of `identity-and-trust.md` (operator-per-actor labels), but the wiring from "MCP client identity" to "actor label" does not exist yet.

3. **Daemon ownership across attach/owner boundaries.** Attach-mode children do not know who owns the daemon. If the owner exits cleanly, the daemon may or may not exit too depending on whether anyone else is connected. There is no protocol-level "I am the owner, I am exiting now" signal. Today this is fine because the user is responsible for noticing. As we ship more agents that auto-spawn MCP clients, the implicit "first wins, others attach" rule will get racy.

4. **`disconnect_target` precision after a real `Disconnected`.** When the daemon disappears, the child stashes the *last known* notebook target. But the daemon could have been gone for hours; the room may have been reaped during that window. The current `rejoin()` does the right thing for ephemeral notebooks (the `list_rooms` check returns "not present" and clears the session with `Evicted`), but the agent gets a confusing trail: first `Disconnected`, then `Evicted` on the next tool call.

5. **`parked_sessions` lifetime.** Capped at `MAX_PARKED_SESSIONS` with arbitrary HashMap-iteration LRU. Every parked session holds a live peer connection to the daemon, which means the daemon's `active_peers` for those rooms stays at 1 even when the agent is not actively using them. That keeps the kernel alive (good if the agent comes back), but it also disables the eviction timer for any notebook the agent has touched in the recent past. Open question: is the kernel-keep-alive the intended cost, or do we want parked sessions to drop the peer connection and rebuild on resume?

6. **Cross-daemon proxy resumption.** Proxy stamps the reconnection banner from `(old_daemon_version, new_daemon_version)`. For **file-backed** notebooks this is now handled: the proxy seeds the *path* (not the UUID) into the respawned child's rejoin target, and the path is meaningful across daemon instances, so the rejoin reloads from disk (Decision 8; `docs/adr/notebook-identity-and-path-binding.md` Decision 5). The remaining gaps are **ephemeral** notebooks (no path; their UUID is daemon-instance scoped, so a cross-daemon respawn loses them) and a daemon socket *path* change (dev-mode worktree switch in isolated mode), where even a file-backed `last_notebook_id` UUID would be meaningless - tracked as MSL-4.

7. **MCP child as runtime peer.** The child connects as the user's "operator" today, but the daemon has no concept of `runtime_peer` vs `editor` scope (Decision 5 of `identity-and-trust.md`). If we ever split the kernel sidecar off into its own process, that process will connect as `runtime_peer`. The MCP child does both (edits cells and triggers kernel commands). Reconciling that with the per-connection scope model is unresolved.

8. **`is_transport_closed` polling.** Proxy uses 500 ms polling because `RunningService` is not cloneable and `waiting()` consumes `self`. This is fine, but it adds up to 500 ms of latency between child exit and restart. Open question: is the rmcp API the right place to push back on, or do we live with the polling?

9. **`should_exit` on tool divergence.** When a daemon upgrade introduces a tool whose name or shape collides incompatibly with the cache, the proxy sets `should_exit = true` and returns an error. The MCP client then has to reconnect. The error message says "you may need to reinstall the nteract extension," which is correct for the MCPB bundle but not for `nteract-dev` (where the supervisor manages the binary on disk). The branching on environment is missing.

10. **Owner-mode and managed-daemon ownership across worktrees.** In dev, the supervisor manages a daemon per git worktree. If two worktrees of the same repo run owner-mode supervisors, each spawns its own daemon at a different socket. If a user switches worktrees mid-session by editing `.envrc`, the proxy keeps talking to the old daemon (the env vars only change for new shells). There is no detection. The fix is on the dev path, not the production path, but it bites regularly.

## References

- `crates/runt-mcp/src/daemon_watch.rs` - `classify`, `watch`, `rejoin`, all the watch-loop tests.
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

## Open Follow-ups

- **MSL-4** (Design; `crates/runt-mcp-proxy/src/proxy.rs`): When a dev worktree daemon's socket path changes (worktree switch in isolated mode, manual relocation), `mcp-supervisor` compares daemon versions across child restart but not socket paths. The `McpProxy.last_notebook_id` from the old daemon is meaningless in the new daemon's room space; rejoin fails with `SessionDropReason::Evicted` and the agent sees a confusing trail.
