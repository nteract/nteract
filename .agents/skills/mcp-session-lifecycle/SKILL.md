---
name: mcp-session-lifecycle
description: >
  Understand the MCP server session lifecycle: proxy supervision, daemon
  watch loop, session state machine, rejoin/reconnect races, and room
  eviction. Use when working on runt-mcp, runt-mcp-proxy, daemon_watch.rs,
  or any code that reads/writes the session Arc<RwLock<Option<NotebookSession>>>.
---

# MCP Session Lifecycle

Use this skill when debugging session state, changing reconnection logic,
working on the proxy, or reasoning about races between background rejoin
and user-initiated tool calls.

Source checkpoint: 2026-09-04 at `6bff3e7b`. The decision record is
`docs/adr/mcp-session-lifecycle.md`. Read the source functions below rather
than copying an abbreviated session struct or reconnect algorithm.

## Three Layers

- **Process supervision:** installed `nteract-mcp` and development
  `mcp-supervisor` use the `runt-mcp-proxy` library to supervise a `runt mcp`
  child. The library is not an executable entrypoint.
- **MCP session state:** the child owns one active `NotebookSession`, a bounded
  map of parked sessions, explicit activation generations, and the daemon
  watch loop.
- **Daemon room state:** `runtimed` owns notebook rooms, runtime state, kernels,
  recovery, and peer accounting. Kernel teardown and room reaping are separate.

The shipped MCP entrypoints use stdio. Multiple MCP clients can run separate
children against the same daemon, including the same notebook room. Concurrent
requests on one stdio connection share that child's active slot; they are not
independent MCP clients. The daemon's multiplexed notebook frames are a
separate protocol, not an HTTP MCP endpoint.

Entry points: `crates/runt/src/main.rs:739`,
`crates/nteract-mcp/src/main.rs:260`, and
`crates/mcp-supervisor/src/main.rs:2910`.

## Proxy Layer

`McpProxy::track_session` and `session::extract_session_id` track one preferred
restart target, despite the field name `last_notebook_id`:

- Successful connect/create calls prefer the child's canonical file path for
  local file-backed notebooks, falling back to a UUID. Hosted targets retain
  their URL identity.
- Successful `save_notebook` promotes a local UUID target to the saved path.
- Disconnecting the active notebook clears the handoff. Disconnecting another
  parked notebook preserves it. Failed calls do not replace the target.
- Restart re-resolves the child executable and seeds
  `NTERACT_MCP_REJOIN_NOTEBOOK`. It does not reconstruct the parked map.
- Exit 75 is an intentional daemon-upgrade handoff, separate from the normal
  crash budget. Other restarts are subject to the proxy's restart controls.
- Daemon-version banners compare the old and new child's reported
  `ServerInfo.server_info.title`, not binary SHA. A banner says rejoin was
  requested; it does not prove that notebook readiness has completed.
- The `reconnect` tool restarts the child, not the daemon.

See `crates/runt-mcp-proxy/src/session.rs:17`,
`crates/runt-mcp-proxy/src/proxy.rs:310`, `:962`, and `:1268`.
A closed-child forwarding failure is retried once; this is not an exactly-once
mutation guarantee (`proxy.rs:658`).

## Active and Parked Sessions

`NteractMcp` holds the active slot and parked map in
`crates/runt-mcp/src/lib.rs:119`. `NotebookSession` in
`crates/runt-mcp/src/session.rs` carries the handle, target, activation identity,
readiness evidence, and local daemon incarnation when applicable.

Switching targets parks the previous peer instead of immediately disconnecting
it. `MAX_PARKED_SESSIONS` is eight; overflow removes an entry by arbitrary
HashMap iteration order. Parked peers keep their rooms from reaching zero
peers, so they can keep kernels alive. Local switch-back establishes a fresh
activation and removes the old parked peer after successful publication;
parked-handle reuse is not a universal reconnect contract.

Most notebook tools operate on the active target. Exceptions include explicit
parked-session disconnect and notebook-ID resource reads against connected or
parked local sessions. A parked map does not provide independent active tool
contexts for multiple MCP clients.

See `park_session`, `install_activated_session`, and `disconnect_notebook` in
`crates/runt-mcp/src/tools/session.rs:74`, `:742`, and `:949`, and
`handle_for_notebook` in `crates/runt-mcp/src/resources.rs:285`.

## The Watch Loop State Machine

`crates/runt-mcp/src/daemon_watch.rs:238` reconciles session ownership against a
live daemon incarnation (`pid + started_at`), not a disconnect latch:

1. A daemon event wakes the watcher. Lagged delivery also requires a fresh
   observation. The watcher directly calls `query_daemon_info(socket_path)`;
   it does not decide from `DaemonConnection`'s cached heartbeat info.
2. A failed identity query alone is not proof of daemon loss. Without an
   explicit `Disconnected` event, defer reconciliation and retain the handles.
3. Compare a live version with the startup baseline. A mismatch exits with 75;
   if startup had no daemon, the first live version establishes the baseline.
4. Remove active and parked local handles bound to a different incarnation, or
   to no live incarnation after confirmed absence. Hosted sessions are excluded
   from this local ownership reconciliation.
5. Preserve the removed active session's best recovery target, preferring a
   saved path. With a live daemon and empty slot, try the proxy handoff target
   first, then that preserved target.

A same-incarnation heartbeat leaves healthy bindings alone. A same-version
restart changes incarnation and invalidates old local handles even if a
`Disconnected` event was missed. Removing parked local handles does not enqueue
recovery for every parked notebook.

See `RecoveryState`, `reconcile_sessions`, and `watch`. Focused tests in the
same file cover same-incarnation heartbeats, lagged delivery, failed identity
queries, stale parked handles, and tool-installed replacements.

## The Session-Write Guard

Background rejoin connects outside the session lock and samples the expected
daemon incarnation before and after connection/readiness. Then
`publish_rejoined_session` checks the captured `session_intent_epoch` and slot
emptiness under the same write lock that installs the session. Any already
installed session wins, including one for the same notebook. Explicit
disconnect advances the epoch under that lock so a completed background
connection cannot resurrect the disconnected session.

Explicit connect/create activation has a separate generation owner:
`SessionActivation`. Same-target in-flight connects share a result. Selecting a
different canonical target supersedes the older attempt; A→B→A must not join
stale A work. `ActivationLease::install_in_slot_recovering` rechecks ownership
under the slot lock and restores the previous occupant if the installation
commit is refused. A failed replacement does not invalidate the healthy
installed session.

Use these production helpers, not a read-lock check followed by a separate
write. See `crates/runt-mcp/src/daemon_watch.rs:365`, `:493`, `:567`,
`crates/runt-mcp/src/session_activation.rs:76`, `:225`, and
`crates/runt-mcp/src/tools/session.rs:977`.

## Session Access Pattern

An installed session is not a readiness guarantee. Acquire access through
`require_session_access!` or `require_handle!` with the appropriate
`SessionRequirement`. `NteractMcp::session_access` checks installed activation
identity and delegates to `NotebookSession::access`; the returned handle is
owned, so the slot lock is released before async work.

| Requirement | Gate |
|-------------|------|
| `ProjectionRead` | Retained projection or interactive document; use the bounded projection before interactivity |
| `DocumentRead`, `DocumentMutation` | Interactive local document with the required readiness evidence |
| `KernelControl` | Interactive document; a running kernel is not required to launch or restart it |
| `RuntimeRead` | Connected, ready local RuntimeStateDoc |
| `Execute` | Interactive document and ready runtime; execution keeps its causal `required_heads` gate |

Retained projection reads do not authorize mutations or execution. Local sync
failure, source degradation, runtime unreadiness, and superseded activation
have distinct error paths. Use `ensure_session_access_current` after async work
before continuing an operation on the captured active target. Do not keep a
session lock across connection, file loading, projection, or sync waits.

See `crates/runt-mcp/src/tools/mod.rs:18`, `crates/runt-mcp/src/lib.rs:273`,
`crates/runt-mcp/src/session.rs:323`, `:485`, and `:595`.

Local `connect_notebook` returns a retained control-plane projection while
peers converge. `create_notebook` and background local rejoin still await
session readiness. Do not apply the progressive-connect contract to all three
paths. The response fields and historical API sketch are distinguished in
`docs/memos/mcp-connect-initial-projection.md`.

## Rejoin: File-Backed vs Ephemeral

Prefer a saved file path for automatic rejoin. The watcher verifies that the
source file exists and calls `connect_open(path)`. UUID-only attachment is
also recoverable when the daemon has a resident room, a persistent UUID/path
registry binding with available source, or a persisted untitled document.
The registry is identity, not content: a missing source file is not permission
to load a stale mirror or invent an empty notebook.

For a UUID target, call `connect(uuid)` and trust the daemon's attach-only
admission. `SyncError::NotebookUnavailable` is definitive and records
`Evicted` without retry. Do not use `list_rooms` as an existence precheck; an
unlisted room may still be recoverable. Transient failures retain the recovery
target for later attempts.

Daemon authority is not an atomic check-and-load guarantee. The legacy snapshot
existence check at `crates/runtimed/src/daemon.rs:3122` precedes awaited room
creation. If that snapshot disappears and no journal is recovered,
`crates/runtimed/src/notebook_sync_server/room.rs:1945–1955` can create a fresh
document. Keep this limitation distinct from the already-absent UUID refusal.

Persisted untitled notebooks are not the same as explicitly ephemeral
notebooks. MCP `create_notebook` defaults to `ephemeral=true`; do not promise
recovery after loss of its content merely because a UUID is known.

See `crates/runtimed/src/daemon.rs:3041`,
`crates/runt-mcp/src/daemon_watch.rs:485`, `:506`, `:615`, and
`crates/runt-mcp/src/tools/session.rs:1602`. The daemon integration tests at
`crates/runtimed/tests/integration.rs:4015` and `:4054` cover refusal without a
phantom room and saved-path recovery by UUID across restart.

## Daemon Room Lifetime

Only the last peer leaving schedules kernel teardown, after `keep_alive_secs`
(default 30 seconds). Room state, autosave, and file watchers remain resident.
Teardown revalidates peer count and connection generation before destructive
work; the destructive latch tells reconnecting peers not to reuse a doomed
kernel.

The ghost-room reaper separately sweeps eligible peerless, kernel-less rooms
every five minutes, with a 24-hour TTL and soft cap of 32. Removal requires the
durability barrier and final admission checks; reconnects and reservations
protect rooms from stale reaping decisions.

See `crates/runtimed/src/notebook_sync_server/peer_eviction.rs:107`, `:269`,
and `crates/runtimed/src/daemon.rs:484`, `:5834`. Kernel teardown is not proof
that a notebook has become unavailable.

## Session Drop Tracking

`last_session_drop` is best-effort recovery context, not another session:

- `Switched`: the old target was replaced and may still be parked.
- `Disconnected`: stale local ownership was removed, recovery failed, or the
  user explicitly disconnected. Explicit disconnect cancels automatic rejoin.
- `Evicted`: rejoin received a definitive unavailable refusal or found a missing
  saved source. It does not mean every kernel keepalive timeout deletes a room.

`SessionDropInfo` retains notebook ID, path, and rejoin target for
`no_session_error`. See `crates/runt-mcp/src/session.rs:636` and the recording
sites in `daemon_watch.rs` and `tools/session.rs`.

## Concurrent MCP Clients and Attribution

Separate MCP children sharing a daemon are implemented. Each child has its own
active selection; the room can have multiple peers. The upstream handshake
supplies the display label and an `agent:<slug>:<session>` operator suffix.
The proxy preserves the suffix across child restarts. Attribution is not a
separate authorization boundary for every same-user local client.

Multiple independently routed MCP clients inside one child are not implemented
by the shipped stdio entrypoints. Neither concurrent request IDs nor parked
notebooks provide that routing. See `crates/runt-mcp/src/lib.rs:48`, `:119`,
`:464`, and `crates/runt-mcp-proxy/src/proxy.rs:180`, `:227`.

## MCP Protocol Checkpoint

The locked `rmcp` 1.5.0 defaults to MCP `2025-11-25` and retains the
initialize-based lifecycle described here. This is not conformance with the
upstream `2026-07-28` revision. See the protocol checkpoint and followups in
`docs/adr/mcp-session-lifecycle.md` and
`docs/audits/mcp-cloud-automerge-audit.md` before changing the transport or
handshake contract.
