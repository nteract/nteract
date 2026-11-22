# MCP Session Lifecycle and Daemon Supervision

**Status:** Accepted, 2026-07-13; amended 2026-08-20 and 2026-09-04; supersedes Draft from 2026-05-23.

**Supersession:** Active-selection routing, connect supersession, parked-cache ownership, and implicit-target tool routing in this record are superseded by [Explicit notebook attachments in MCP](mcp-explicit-notebook-attachments.md). Daemon authority, three-layer process supervision, incarnation reconciliation, source recovery, notebook observation, and progressive readiness remain in force.

**Protocol status:** Public stdio entrypoints now run `rmcp` 3.2.0 and support legacy initialize-based revisions (`2024-11-05` through `2025-11-25`) alongside native `2026-07-28` discovery, inline metadata, and `subscriptions/listen`. The private child handshake remains pinned to `2025-11-25`, and broader `2026-07-28` features (HTTP transport, Tasks, multi-round-trip requests, and multi-client multiplexing) remain out of scope. See [MCP protocol checkpoint](#mcp-protocol-checkpoint).

**Neighbors:**
- `docs/adr/mcp-explicit-notebook-attachments.md` - explicit `notebook_handle` and `notebook_id` targeting that supersedes this record's single-slot routing.
- `docs/adr/room-source-lifecycle-and-file-recovery.md` - room-owned source states, recovery journal, and progressive capability gates observed by MCP sessions.
- `docs/adr/typed-frame-v4-wire-protocol.md` - wire protocol backing every `DocHandle` the MCP server holds.
- `docs/adr/document-split.md` - room document set (`NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, `CommentsDoc`) plus daemon-scoped `PoolDoc`.
- `docs/adr/execution-pipeline.md` - why a stale `DocHandle` disrupts agents: `required_heads`, output sync, and broadcast replay all flow through it.
- `docs/adr/blob-storage-and-content-addressing.md` - the blob HTTP port belongs to the daemon, not the stdio MCP transport.
- `docs/adr/identity-and-trust.md` - local peer credentials establish the principal; MCP client identity supplies the agent operator suffix.

## Context

The MCP server gives agents stateful access to live nteract notebooks across three entities with independent lifetimes:

1. **The MCP client** (Claude Code, MCP Inspector, Codex, Zed). Connects over stdio and sends tool and resource requests.
2. **The `runtimed` daemon.** Unix-socket server owning Automerge rooms, kernels, and file watchers. Restarts on upgrades, crashes, or dev debug/release toggles, with versions bumping independently of the MCP child.
3. **The room.** Per-notebook entity inside the daemon holding the Automerge documents, source controller, recovery journal, kernel handle, file checkpoint writer, and peer counter. It outlives its last peer long enough to make reconnects cheap, and its journal survives reaping so acknowledged heads remain recoverable.

The MCP server sits where all three layers meet. When any layer tears down or restarts, the remaining layers must reconcile without leaking kernels, dropping outputs, or serving a stale `notebook_id`.

This produces a three-layer architecture:

- **Supervisor** (`nteract-mcp` in installed distributions; `mcp-supervisor` in dev): owns the child process using `McpProxy` from `runt-mcp-proxy` for monitoring and reconnection banners. Clients do not spawn `runt-mcp-proxy` directly.
- **Child** (`runt-mcp`, invoked as `runt mcp`): holds notebook attachments (originally one active `NotebookSession` plus a bounded parked map; now an explicit attachment registry per `mcp-explicit-notebook-attachments.md`) and runs the daemon watch loop.
- **Daemon** (`runtimed`): owns rooms, kernels, and the ghost-room reaper.

Separate MCP clients can run separate child processes against one shared daemon and join the same room. This multi-client sharing is shipped, not a future goal. One child serves one upstream stdio connection and does not multiplex independent MCP clients. The daemon's notebook framing is a separate transport protocol.

Source entrypoints live in `crates/runt/src/lib.rs`, `crates/nteract-mcp/src/lib.rs`, and `crates/mcp-supervisor/src/main.rs`. Same-room peer propagation is verified by `test_notebook_sync_cross_window_propagation` in `crates/runtimed/tests/integration.rs`.

## Decision 1: Three layers, three lifetimes, no shared state

The proxy, child, and daemon maintain separate state and failure boundaries:

| Layer | Owns | Recovery responsibility |
|-------|------|-------------------------|
| `nteract-mcp` / `mcp-supervisor` (via `McpProxy`) | Child process, restart handoff target, upstream identity, tool cache | Restart child, re-resolve executable, request rejoin |
| `runt mcp` | Local/hosted peers, activation generations, readiness evidence, daemon watcher | Reconcile local daemon incarnation and publish only valid attachments |
| `runtimed` | Rooms, source state, recovery journal, kernels, peer accounting | Keep room content available independently of any single client or kernel |

There is no cross-process lock or transactional handoff:

- The proxy passes recovery and operator environment variables and inspects tool results.
- The child talks to the daemon over control and notebook connections.
- `DaemonEvent` values come from the child's `DaemonConnection` supervisor; they wake the watcher rather than acting as authoritative daemon identity.

Lifetimes are not strictly nested. A session can outlive a kernel restart, another peer can keep a kernel alive after this child leaves, and a daemon replacement invalidates local handles without ending the proxy's stdio connection.

Key proxy supervision rules (`crates/runt-mcp-proxy/src/proxy.rs` and `session.rs`):

- `McpProxy::restart_child_for_reason` re-resolves the executable on every restart.
- Exit `75` (`EX_TEMPFAIL`) signals an intentional upgrade handoff with separate rate limiting, not an ordinary crash.
- Reconnection version banners compare old and new `ServerInfo.server_info.title`, not binary SHAs.
- The proxy's `reconnect` tool replaces the child, not the daemon. A requested rejoin does not prove the notebook is ready.
- Forwarding retries at most once, only when no request was dispatched or the tool is on the proxy's explicit read-only replay allowlist.
- A mutation whose response is lost is never replayed automatically. It returns a tool error with structured `error.code: outcome_unknown` and `error.retry_safe: false`, instructing the agent to inspect notebook state or execution results first (including any recovery failures). This prevents duplicate dispatch on recovery; it does not provide exactly-once execution.
- Explicit disconnect clears any matching rejoin target before dispatch so a lost reply cannot resurrect the released session.
- Under the pre-explicit-attachment handoff model, `track_session` retained one preferred target (preferring canonical path, promoting a local UUID after save, and clearing on active disconnect while leaving parked disconnects alone). Only that single target was seeded on child restart; parked sessions were never restored as a group.

## Decision 2: Proxy modes are policy, not state

`mcp-supervisor` (the dev wrapper in `crates/mcp-supervisor/src/main.rs`) reads `NTERACT_DEV_MODE`:

| Mode | Spawns daemon? | Manages worktree daemon? | Used by |
|------|----------------|--------------------------|---------|
| `owner` | Yes, if not running | Yes (up/down/rebuild) | Claude Code (default) |
| `attach` | No | No (errors if missing) | Codex, second IDE |
| `isolated` | Yes, per session | Yes, scoped to session dir | One-shot test runs |

The compatibility `nteract-mcp` wrapper has no `NTERACT_DEV_MODE`. It locates the channel's `runt` binary and spawns `runt mcp`, leaving daemon service management outside the child. The canonical `nteract mcp` command uses the same proxy library and launches an internal worker from its selected CLI binary, preserving restart, protocol, cancellation, and handoff behavior.

Canonical local notebook connection and creation may lazily start an absent runtime. MCP initialization and direct hosted connections do not, and incompatible or uninspectable runtimes are left untouched (`crates/nteract-mcp/src/lib.rs`, `crates/runt/src/lib.rs`, and the [CLI guide](../runbooks/cli.md)).

- **Why separate management from attachment:** multiple children can share one worktree daemon without competing over its lifecycle. `attach` makes that boundary explicit by refusing to start, stop, rebuild, or restart the shared daemon. (`owner` mode can also reuse an already-running daemon.)
- **What `attach` does not guarantee:** it does not keep the daemon alive. If the owner stops or replaces the daemon, attached children reconcile local handles and attempt recovery. There is no owner-handoff event in the watch loop, and peer operator attribution does not imply daemon ownership.

## Decision 3: Daemon incarnation is local session truth

Every local attachment carries `local_daemon_incarnation: Option<DaemonIncarnation>`, where the incarnation is `pid + started_at`. The incarnation proves whether a local `DocHandle` belongs to the daemon running right now. Hosted attachments deliberately have no local incarnation and survive local-daemon reconciliation.

Local connect samples daemon identity both before and after connection and readiness checks:

- Equal samples bind the attachment to that incarnation.
- A missing or changed sample leaves it unbound and prevents publication.
- The watch loop removes any local attachment whose binding does not match the live incarnation.

### Superseded single-slot and parked-map routing (pre-2026-10-08)

*This routing model is retired in favor of [Explicit notebook attachments in MCP](mcp-explicit-notebook-attachments.md); kept here for historical context on the earlier checkpoint (`crates/runt-mcp/src/lib.rs`, `tools/session.rs`, `resources.rs`).*

Before explicit attachment handles landed, the child held one active slot (`session: Arc<RwLock<Option<NotebookSession>>>`) plus a parked map of up to eight previous live peers (with arbitrary `HashMap`-order eviction at capacity). Parking kept rooms and kernels alive; local switch-back created a fresh activation and removed the old parked peer only after publication, while hosted reconnect had a parked-peer resume path. Ordinary tools read the active slot through a readiness gate (cloning an owned handle before dropping the lock), while resource reads and explicit disconnect could target parked local sessions by notebook ID. Parked local entries obeyed the same daemon-incarnation rule as the active slot.

## Notebook observation

### Attachment handles and resource URIs

Connect and create responses return an opaque `notebook_handle` identifying the exact attachment. Handle-qualified URIs (`nteract://sessions/{notebook_handle}/cells`, `/cells/{cell_id}`, and `/comments`) remain readable for retained attachments. Replacing or releasing an attachment invalidates its handle. A reconnect must issue a fresh handle; an old handle never silently rebinds to a new peer. Legacy notebook-ID resource URIs remain readable, but ambiguous IDs require an explicit handle.

### Snapshot observers and change journal

Each observed session owns one observer covering `NotebookDoc` snapshots (including execution pointers), `RuntimeStateDoc`, `CommentsDoc`, and sync status:

- Observers subscribe before reading their initial baseline.
- Resource reads flush pending changes before selecting the cursor for the exact snapshot they serialize.
- The change journal retains 256 compact batches, coalescing background updates over 100 ms.
- Journal entries store IDs and change kinds, never copies of cell source or output bodies.
- Expired or foreign cursors require a fresh baseline.
- Mutable notebook reads advertise private caching with zero TTL.

### Subscriptions and bounded waits

- **Legacy `resources/subscribe`:** emits URI invalidations with a 128-watch limit per connection; unsubscribing is idempotent. The proxy orders subscription operations, forwards child notifications, and invalidates watches if the child transport closes. Watches hold snapshot receivers rather than `DocHandle` command senders, so they do not keep notebook peers or kernels alive. Releasing a session wakes pending observers as unavailable.
- **Bounded tool waits:** `inspect_notebook(after, timeout_secs)` provides change observation for tool-only hosts, and `get_results(execution_id, timeout_secs)` waits on an existing execution without resubmission. Both default to `0` s, cap at `50` s, and share an eight-wait budget. The hidden `wait_for_notebook_change` retains its original handle contract and `25` s default for compatibility. Resources and subscriptions remain the primary ongoing observation surface.

### Cancellation and progress reporting

Tool calls honor request cancellation and connection teardown throughout their observation future:

- The shared `mcp-transport` adapter attaches a connection token to every request and cancels it on EOF, write failure, close, or drop (the SDK's request token alone does not signal EOF during response drain).
- The proxy maps upstream cancellation to the private child's request ID and maps child progress back to the upstream progress token. Concurrent requests maintain isolated scopes.
- Dropping a forwarding future sends a bounded cancellation notification to the child; it does not interrupt a running kernel.
- Child restart, reconnect, and startup waits run in one owned task with a shared completion result. Concurrent callers await that result, and cancelling one caller stops only its own wait.

Progress notifications are opt-in:

- Updates emit elapsed seconds with real status messages at most once per second, plus a 5-second heartbeat.
- Short calls finish without status noise during their first second.
- The private child transport strips the SDK's automatic token when the upstream client did not request progress.
- A request keeps one elapsed clock and rate limit across a safe child retry.
- Progress delivery uses a short timeout so a slow consumer cannot stall the tool; completion and cancellation discard pending updates.

### Native `2026-07-28` lifecycle and explicit targeting

Native `2026-07-28` lifecycle support is active in the child, installed wrapper, and dev supervisor:

- Clients may send `server/discover` or an application request first with the revision's required inline metadata.
- Initialize-based connections stay on their negotiated legacy revision; inline metadata cannot upgrade a legacy connection.
- A rejected first request does not open the native lifecycle: entrypoints wait for valid protocol metadata before starting recovery or dev setup. Transient native child startup failures retry within the existing circuit breaker budget.
- Every supported protocol requires an explicit target per [Explicit notebook attachments in MCP](mcp-explicit-notebook-attachments.md). Ordinary calls accept `notebook_id` (with optional configured hosted `domain`) or an exact `notebook_handle`. ID calls bind only to already authorized replicas and retain a shared address owner without cold-connecting; target selection affects only that request. `disconnect_notebook` and the hidden legacy wait remain exact-handle operations.
- Handle-qualified `show_notebook` requests always pass through the child's attachment validation and launch policy; the supervisor's direct Vite launch path applies only to legacy explicit-path requests and must never bypass a supplied handle.
- Native resource catalogs list static output UI, notebook listing, and handle-qualified templates independent of which notebooks are currently open. Reads and catalogs carry private zero-TTL caching hints (legacy responses also include these as optional fields, while only native responses require the result-type discriminator).
- The private child stays on `2025-11-25`, advertises empty client capabilities, and disables SDK caching. The proxy restores native result discriminators when forwarding deserialized legacy responses.
- `subscriptions/listen` accepts handle-qualified resource subscriptions up to 128 watches per connection and declines unsupported filter categories. Watch installation and baseline capture complete before acknowledgment.
- Each accepted native stream correlates invalidations with its subscription ID, and cancelling one listener releases only its watches. The proxy reference-counts shared child watches so cancelling one listener never unsubscribes another.
- Releasing one attachment ends only its per-URI watches; other watches in the same native listen request stay active until cancelled, unavailable, or child transport loss. Child loss terminates native streams rather than rebinding them; clients must reconnect, obtain new handles, and capture new baselines.

### SDK 3.2 transport adapter workarounds

The shared `mcp-transport` adapter works around two `rmcp` 3.2 lifecycle ordering constraints:

1. **First-request priming:** primes a native first application request with a private, pure discovery request so the SDK's peer pump is running before a tool emits progress or a listener acknowledges.
2. **Acknowledgment gating:** holds the SDK's early subscription acknowledgment in a request-owned slot until the handler installs its watch. Validation errors preserve the original request ID without dispatching or replaying an application operation.

Tests verify first-request progress, filtered acknowledgments, cancellation, and child transport loss over the actual SDK wire.

## Decision 4: Tool intent and guarded publication are the convergence point

Background recovery connects outside the session lock. It captures `session_intent_epoch` and the expected daemon incarnation, then re-verifies incarnation after async connection and readiness work completes. `publish_rejoined_session` checks both the epoch and slot/target state under the write lock before installing:

- Explicit tool actions win over background recovery.
- Explicit disconnect advances `session_intent_epoch` under the write lock so background recovery cannot resurrect a released session.
- A completed recovery connection that loses the race is dropped cleanly; releasing the extra peer is preferable to overwriting user intent.

Explicit connect and create flows use `SessionActivation` generations (`crates/runt-mcp/src/session_activation.rs`):

- Same-target connects coalesce onto the in-flight attempt.
- Under the earlier single-slot checkpoint, different-target connects superseded earlier pending attempts (including A→B→A) while keeping the installed session usable until publication succeeded and restoring the previous occupant if identity commit failed. Under `mcp-explicit-notebook-attachments.md`, independent acquisitions no longer displace each other's handles, while non-blocking activation and guarded publication remain in force.

These guards order publication rather than serializing all concurrent notebook operations into one global transaction. Production publication helpers and failure-recovery paths are tested in `crates/runt-mcp/src/daemon_watch.rs` and `crates/runt-mcp/src/session_activation.rs`.

## Decision 5: Live daemon incarnation drives reconciliation

The watch loop (`crates/runt-mcp/src/daemon_watch.rs`) treats `DaemonEvent` notifications as wake-ups, not cached truth. It replaced the older classify/disconnect-latch algorithm with direct live queries:

1. On every `DaemonEvent` and after `RecvError::Lagged`, the watcher directly calls `query_daemon_info(socket_path)` instead of trusting `DaemonConnection::info()`'s cached heartbeat.
2. If the one-shot query fails, only an explicit `Disconnected` event triggers reconciliation against absence; otherwise the watcher defers and retains current handles.
3. Reconciliation drops any local attachment whose bound incarnation is missing or differs from the verified live incarnation.
4. Dropping an active local handle records its best recovery target, preferring a file path and never overwriting a saved path with a UUID-only observation.
5. When a live incarnation appears with an eligible recovery target, recovery tries the proxy handoff target first, then the preserved target. It does not reconnect discarded parked sessions as a batch.
6. The daemon version seen at child startup sets the version baseline (or the first live daemon establishes it if none was running at startup). Any subsequent mismatch exits with code `75` (`EX_TEMPFAIL`) so the proxy restarts the child against the new version.

Failed-query deferral and lagged-event observation are covered by unit tests in `crates/runt-mcp/src/daemon_watch.rs`.

## Decision 6: A same-incarnation heartbeat is structurally a no-op

`DaemonEvent::Connected` fires on routine liveness refreshes. When the queried incarnation matches existing local bindings, reconciliation does nothing. No `was_disconnected` latch is needed. An installed healthy session clears obsolete recovery targets. Because even a same-version daemon restart produces a new `pid + started_at`, reconciliation reliably drops stale local handles and recovers against the new incarnation.

Heartbeat no-op and same-version replacement tests live in `crates/runt-mcp/src/daemon_watch.rs`.

## Decision 7: Room is the durable entity; sessions and kernels are not

Daemon eviction operates in three layers:

1. **Kernel teardown** (`crates/runtimed/src/notebook_sync_server/peer_eviction.rs`): when `active_peers` hits `0`, the daemon waits `keep_alive_secs` (default `30` s; configurable `5` s to `7` days in `crates/runtimed-client/src/settings_doc.rs`), then shuts down the kernel and cleans up its environment directory. The room, autosave debouncer, and file watchers stay resident.
2. **Ghost-room reaping** (`ghost_room_reaper_loop` in `crates/runtimed/src/daemon.rs`): every 5 minutes, sweeps peerless rooms whose kernels are torn down (TTL 24 hours; cap 32 peerless rooms). Aged-out or overflowed rooms leave `notebook_rooms` and `path_index` only after the recovery journal covers their current heads.
3. **Daemon shutdown:** terminates resident tasks and kernels only after the same causal journal barrier covers accepted room heads.

Both reaping and clean shutdown call `await_durable(required_heads)`. A journal failure marks the room `Degraded` and keeps it resident rather than dropping acknowledged work (see [Room Source Lifecycle and File-Backed Recovery](./room-source-lifecycle-and-file-recovery.md)). The reaper snapshots heads, commits them, awaits the durable barrier, and removes the registry entry only if every predicate still holds: zero peers, zero reservations, unchanged connection generation, teardown timestamp still set, source not loading, and durability healthy.

- **Why the room outlives the kernel:** window reopens, agent reconnects, and daemon child upgrades are frequent. Keeping the room resident preserves `notebook_id`, visible outputs, file-watcher bindings, and ephemeral state without full reload.
- **Why the kernel still tears down:** idle kernels and environments consume memory and processes. The keepalive delay bridges brief reconnects while reclaiming abandoned kernels; normal tool calls reuse their peer and never reconnect per call.
- **The reconnect-during-teardown race:** the teardown task snapshots `connection_generation` when the last peer leaves, then revalidates zero peers, unchanged generation, and non-evicted status inside `NotebookRooms::serialize_with` before destructive teardown. Setting `kernel_teardown_destructive` inside that serialized check stops a racing reconnect from reusing the doomed kernel. Peer count, generation, and latch guard distinct windows; none is redundant.

`test_kernel_teardown_keeps_room_resident` and the reaper TTL, reconnect, and reservation tests in `crates/runtimed/tests/integration.rs` cover these invariants.

## Decision 8: Rejoin is keyed on file path for file-backed rooms

Automatic rejoin prefers a saved file path when known. UUID-only recovery is also supported and never fabricates an empty room on miss:

| Target | Rejoin method | Admission |
|--------|---------------|-----------|
| Known saved path | `connect_open(path)` | Watcher requires an existing source file; daemon reconciles source and recovery state |
| UUID with resident room | `connect(uuid)` | Attach to that room |
| UUID with persistent saved-path binding | `connect(uuid)` | Follow registry binding and recover from available source and journal |
| Persisted untitled UUID | `connect(uuid)` | Reload recoverable persisted content |
| Absent UUID (no resident, registry, or persisted content) | `connect(uuid)` | Refuse with `SyncError::NotebookUnavailable` |

The file path remains the durable user-facing locator, while the daemon's persistent registry preserves file-backed UUIDs across restarts (including untitled notebooks saved later). A registry row is not content: if its source file is missing, admission refuses rather than importing a stale mirror. Source/journal conflicts follow [Room Source Lifecycle and File-Backed Recovery](./room-source-lifecycle-and-file-recovery.md) and [Notebook Identity and Path Binding](./notebook-identity-and-path-binding.md).

Admission rules (`crates/runtimed/src/daemon.rs` and `crates/runt-mcp/src/daemon_watch.rs`):

- UUID availability and refusal are daemon-authoritative; rejoin never prechecks `list_rooms` because an unlisted room may still be recoverable.
- `SyncError::NotebookUnavailable` or a missing saved source records `SessionDropReason::Evicted` with no automatic retry.
- Transient connection or readiness errors retain the recovery target for later attempts.
- Explicit create/open flows stay separate from UUID attach. MCP creation defaults to `ephemeral=true` (`crates/runt-mcp/src/tools/session.rs`), so an ephemeral UUID is not guaranteed recoverable after content loss.
- On explicit UUID connect, MCP retrieves the path from the daemon projection (falling back to `list_rooms`), stores it, returns `notebook_path`, and updates the proxy handoff on save.

**Known race limitation:** admission's legacy snapshot-existence check in `crates/runtimed/src/daemon.rs` precedes awaited room creation. If the snapshot vanishes during that window and no journal recovers, `crates/runtimed/src/notebook_sync_server/room.rs` can instantiate a fresh document. Integration tests in `crates/runtimed/tests/integration.rs` verify already-absent UUID refusal, saved-path UUID recovery across restart, and journal-without-source refusal, but do not yet close this TOCTOU race.

## Decision 9: `SessionDropReason` is the agent-facing recovery hint

When a session/attachment is lost, `last_session_drop` (`SessionDropInfo` in `crates/runt-mcp/src/session.rs`) records the reason so `no_session_error()` gives the agent actionable recovery context:

| Reason | What happened | Recovery |
|--------|---------------|----------|
| `Switched` | Legacy active slot switched to another notebook | Reconnect to the previous `notebook_id` (superseded for explicit handles) |
| `Evicted` | Rejoin received `NotebookUnavailable` or found a missing saved source | Restore/open the source or create a new notebook; no automatic retry |
| `Disconnected` | Reconciliation dropped stale local ownership, rejoin exhausted retries, or client disconnected | Automatic recovery may retry on a later verified live observation; explicit disconnect cancels retry |

`SessionDropInfo` retains notebook ID, path, and rejoin target as best-effort diagnostic context (later drops replace earlier ones). Kernel teardown alone never sets `Evicted` because the room remains resident or recoverable.

## Decision 10: Connection activation is progressive and generation-guarded

An installed attachment identifies the target without guaranteeing every subsystem is ready. Local path/UUID `connect_notebook` fetches a bounded, heads-qualified projection over the independent daemon control connection, retains it on the session, and returns immediately while local Automerge peers finish converging. A readable degraded projection stays inspectable without authorizing mutation.

The connect response (`crates/runt-mcp/src/tools/session.rs`) returns JSON text plus a notebook resource link containing:

- `session_generation` and `source_state`
- `readiness`: `projection`, `document`, `runtime`, `interactive`
- `projection.heads`, `runtime_state_heads`, and `completeness`
- `capabilities`: `read`, `mutate`, `execute`
- `runtime`, `dependencies`, `project_context`, and `cells` (a formatted string with stable cell IDs, rather than the structured cell-array proposed in the initial-projection memo)

Tool handlers gate operations with `SessionRequirement` via `require_session_access!` or `require_handle!` (`crates/runt-mcp/src/session.rs`, `tools/mod.rs`, `tools/cell_read.rs`, `resources.rs`):

| Operation | Required evidence |
|-----------|-------------------|
| Bounded projection read | Retained projection or interactive document |
| Full `NotebookDoc` read or mutation | Interactive document with local readiness and head evidence |
| Kernel control | Interactive document (does not require an already-running kernel) |
| `RuntimeStateDoc` read | Connected and ready local `RuntimeStateDoc` |
| Execution | Interactive document and ready runtime, preserving the `required_heads` gate |

Key readiness invariants:

- `get_all_cells` serves the retained bounded projection before full interactivity; full notebook resources require `DocumentRead` and remain unavailable until converged.
- Readiness recomputes live from peer status, head containment, and source health; failed peers or degraded sources never permit cached-source writes or execution.
- `ensure_session_access_current` (`crates/runt-mcp/src/lib.rs`) revalidates generation and target after async awaits. Session locks must never span file loads, socket connects, projections, or sync waits.
- Concurrent same-target connects coalesce via `SessionActivation` (`crates/runt-mcp/src/session_activation.rs`), resolving path/UUID aliases against the daemon. Repeated connects reuse an installed same-target replica only when it is connected, readable, and bound to the live daemon incarnation, with any pending activation taking precedence (`reuse_active_session` in `tools/session.rs` and `SessionActivation::can_reuse_installed` in `session_activation.rs`).
- Structured readiness errors distinguish `notebook_not_ready`, `runtime_not_ready`, `source_degraded`, `source_conflict`, `session_superseded`, `sync_failed`, and `daemon_replaced`. Document unreadiness blocks mutation and execution; runtime-only unreadiness can leave mutation open. Other failures may still return text tool errors.
- Progressive activation applies to local `connect_notebook`. `create_notebook` and background local rejoin still await full readiness, and hosted sessions use connected-replica readiness.

The progressive harness (`scripts/mcp-connect-harness.py`) verifies shared activation generation, bounded peer count for concurrent same-target connects, and stalled-peer inspectability while mutation and execution remain closed. These are application lifecycle checks, not an upstream MCP conformance suite. Historical design sketches and measurements remain in [the initial-projection memo](../memos/mcp-connect-initial-projection.md).

## Worked examples

*Note: under [Explicit notebook attachments in MCP](mcp-explicit-notebook-attachments.md), notebook-scoped tool calls after connect pass the returned `notebook_handle` (or `notebook_id` for an already authorized replica) rather than relying on an implicit active slot.*

### Cold start: Claude Code spawns owner-mode proxy

1. Claude Code spawns `mcp-supervisor` over stdio. Before proxy initialization finishes, the supervisor exposes its own tools and empty resource lists.
2. Background setup locates or starts the worktree daemon, initializes `McpProxy` and the `runt mcp` child, and notifies the client of the tool catalog.
3. With no handoff target, the child starts with no notebook attachments.
4. The agent calls `connect_notebook { path: "/tmp/foo.ipynb" }`. The child attaches, fetches a heads-qualified daemon projection, binds the live daemon incarnation, and returns `notebook_handle` plus stable cell IDs while local peers converge.
5. Subsequent notebook tools pass the target handle (or ID) and check their readiness gate. Connect success does not imply execution is ready.

The installed `nteract-mcp` wrapper differs at startup: it serves cached tools immediately, spawns the child after `notifications/initialized`, and sends list-change notifications (`crates/runt-mcp-proxy/src/proxy.rs`).

### Daemon upgrade during an active session

1. The user upgrades Desktop; the installed daemon restarts as version `2.1.3` (previously `2.1.2`).
2. `DaemonConnection` emits `DaemonEvent::Upgraded { previous: 2.1.2, current: 2.1.3 }`.
3. The watcher queries live daemon info, detects a mismatch against its startup version baseline, and exits with `EX_TEMPFAIL` (`75`), even if the event itself was missed.
4. `McpProxy` classifies exit `75` as an intentional upgrade handoff, re-resolves the child binary, seeds `NTERACT_MCP_REJOIN_NOTEBOOK` if a preferred target is tracked, and spawns the new child.
5. The supervisor detects the version change by comparing old vs new `ServerInfo.server_info.title` and prepends `Daemon upgraded (2.1.2 -> 2.1.3), session reconnect requested` to the next tool result, reporting the request rather than claiming async rejoin already succeeded.
6. Under explicit attachments, clients obtain a fresh `notebook_handle` after child replacement; old handles never silently rebind.

### Last peer leaves, comes back during teardown

1. The agent calls `disconnect_notebook` (or exits). Daemon `active_peers` drops to `0`.
2. Daemon schedules kernel teardown after `keep_alive_secs` (default `30` s) and snapshots `teardown_generation = connection_generation`.
3. At `25` s, the agent reconnects. Daemon increments `active_peers` to `1`, bumps `connection_generation`, and clears `last_kernel_torn_down_at`.
4. At `30` s, the teardown task sees active peers and exits cleanly; if a flush races reconnect, serialized peer and generation checks abort teardown.
5. The reconnect lands on the warm room and kernel with no environment rebuild.

### Daemon goes away mid-execution

1. An in-flight tool holds an owned local handle stamped with daemon incarnation A.
2. On `Disconnected` with no live daemon identity, reconciliation drops local attachments bound to incarnation A, records `SessionDropReason::Disconnected`, and preserves the saved path for recovery. A failed query without `Disconnected` defers reconciliation; hosted handles are unaffected.
3. The in-flight tool observes the closed socket and returns failure without holding any session lock across the await.
4. When daemon incarnation B starts, stale handles from A cannot survive reconciliation. Any automatic recovery re-verifies incarnation B after readiness and yields to explicit tool intent.

### Two MCP clients in attach mode

1. Claude Code starts in `owner` mode, spawns the worktree daemon, and connects to a notebook.
2. Codex starts with `NTERACT_DEV_MODE=attach`, verifies the daemon socket exists, and spawns its own child without managing the daemon.
3. Both children connect to the same room (`active_peers` rises from `1` to `2`). Each holds independent attachment state and derives its own display label and `agent:<slug>:<session>` operator from upstream MCP identity, which stays stable across child restarts (`crates/runt-mcp/src/lib.rs`, `crates/runt-mcp-proxy/src/proxy.rs`). Same-user attribution does not create separate authorization boundaries.
4. When one calls `execute_cell`, the other observes shared runtime updates. Disconnecting one peer leaves `active_peers = 1` and does not schedule kernel teardown, though stopping the daemon via its owner affects both clients.

## MCP protocol checkpoint

The workspace runs `rmcp` 3.2.0:

- **Supported:** legacy initialize-based revisions `2024-11-05` through `2025-11-25`, plus native `2026-07-28` inline metadata, `server/discover`, and `subscriptions/listen` on all public stdio entrypoints.
- **Private child boundary:** pinned to `2025-11-25` with empty client capabilities and SDK caching disabled; `McpProxy` bridges native discriminators and subscription lifecycles.
- **Test coverage:** protocol tests verify negotiation, metadata validation, first-request behavior, and old/new SDK interoperability.
- **Out of scope:** HTTP transport, MCP Tasks, multi-round-trip requests, and multiplexing multiple independent MCP clients into one child process.

Protocol support alone does not guarantee how any given host surfaces notifications to its model; host probes and desktop acceptance remain separate checks. See the [MCP, cloud, and Automerge audit](../audits/mcp-cloud-automerge-audit.md).

## Open Follow-ups

These are remaining design or compatibility choices, not prerequisites for the shipped separate-child/shared-daemon model:

1. **Multiplexing independent MCP clients within one child.** Explicit attachment handles (`mcp-explicit-notebook-attachments.md`) isolate unrelated chats sharing a client connection, but each child still carries one upstream identity and stdio transport. Decide whether true multi-client multiplexing is ever needed beyond separate children.
2. **Backing-peer keepalive and multi-target restart handoff.** Under the legacy parked-map model, up to eight live parked peers could keep kernels alive while child restart handed off only one target. With explicit attachment handles now shipped, decide whether idle backing-peer keepalive policies or multi-attachment restart hints are needed.
3. **Daemon ownership handoff.** `attach` mode deliberately refuses to manage the shared daemon. If supervisor ownership transfer is ever needed, specify it separately from peer attribution and notebook keepalive.
4. **Tool compatibility beyond names.** `detect_divergence` (`crates/runt-mcp-proxy/src/tools.rs`) compares tool-name sets only, not input/output schemas. Schema changes under an unchanged name need a compatibility policy. (Caller-specific recovery hints are already split across `crates/nteract-mcp/src/lib.rs` and `crates/mcp-supervisor/src/main.rs`.)
5. **Snapshot-disappearance admission race.** Close the TOCTOU window in Decision 8 where a legacy snapshot vanishing between existence check and room creation can produce a fresh document.
6. **Further MCP protocol features.** Concurrent callers already await shared restart completion, but HTTP transport, Tasks, and multi-round-trip requests require explicit lifecycle design. Transparent restart and SDK upgrades never imply exactly-once execution.

*Completed items recorded in Decisions 5, 8, and `mcp-explicit-notebook-attachments.md`: already-absent UUID refusal, file-backed UUID registry recovery, operator attribution, separate runtime-agent processes, and explicit target handles.*

## References

- `crates/runt-mcp/src/daemon_watch.rs` - incarnation reconciliation, `watch`, `rejoin`, and transition-sequence tests.
- `crates/runt-mcp/src/session.rs` - `NotebookSession`, `SessionDropReason`, `SessionDropInfo`.
- `crates/runt-mcp/src/lib.rs` - `NteractMcp`, session access revalidation, upstream attribution.
- `crates/runt-mcp/src/session_activation.rs` - activation generations, coalescing, `can_reuse_installed`, atomic publication helpers.
- `crates/runt-mcp/src/tools/mod.rs` - readiness-aware access macros (`require_session_access!`, `require_handle!`) and tool dispatch.
- `crates/runt-mcp/src/tools/session.rs` - progressive local connect, `reuse_active_session`, create, save, and disconnect.
- `crates/runt-mcp/src/resources.rs` - handle-qualified and legacy notebook-ID resource reads.
- `crates/mcp-transport/src/lib.rs` - connection cancellation token, SDK 3.2 priming, and subscription ack gating.
- `crates/runt-mcp-proxy/src/proxy.rs` - `McpProxy`, `restart_child_for_reason`, child monitor, `track_session`.
- `crates/runt-mcp-proxy/src/session.rs` - `extract_session_id` for parsing tool results.
- `crates/runt-mcp-proxy/src/version.rs` - `ReconnectionEvent`, banner-message generation.
- `crates/runt-mcp-proxy/src/circuit_breaker.rs` - circuit breaker for crash loops.
- `crates/runtimed/src/notebook_sync_server/peer_eviction.rs` - kernel teardown task with all three race checks.
- `crates/runtimed/src/daemon.rs` - `room_eviction_delay`, `idle_peer_timeout`, `ghost_room_reaper_loop`, `ghost_room_reaper_sweep_with_cap`, UUID admission.
- `crates/runtimed-client/src/settings_doc.rs` - `keep_alive_secs` default (`30`), min (`5`), max (`604800`).
- `crates/runtimed-client/src/daemon_connection.rs` - `DaemonConnection`, heartbeat interval, `DaemonEvent` shape.
- `crates/mcp-supervisor/src/main.rs` - `DevMode` enum and `NTERACT_DEV_MODE` parsing.
- `scripts/mcp-connect-harness.py` - progressive connect and stalled-peer harness.
- `.agents/skills/mcp-session-lifecycle/SKILL.md` - operating rules; this ADR is the rationale.
