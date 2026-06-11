# Local-First Notebook State

**Status:** Proposed, 2026-06-11. Design for issue #3421; follow-up to #3530.
Informed by automerge-repo's storage/network subsystems (prior art) and the
projection-convergence line ([shared-store-projection-convergence](./shared-store-projection-convergence.md),
[live-notebook-projection-policy](./live-notebook-projection-policy.md)).

## Context

On a thin or flapping network the cloud viewer degrades badly: a dropped
WebSocket tears down the entire session — transport, WASM `NotebookHandle`,
`SyncEngine`, and store projections — and recreates them from scratch after a
fixed 1 s timer. Any local change the room had not yet accepted dies with the
freed handle. A failed asset fetch (runtimed WASM, renderer bundle) leaves a
blank viewer behind a generic "Live room needs attention." notice, with no
retry.

Precursor #3530 added `ConnectionStatus` (`"connecting" | "online" | "offline"
| "reconnecting"`) to every `NotebookTransport` and `notebookDocChanged$` to
`SyncEngine`. The `connectionStatus$` observables survive on main but have no
UI consumer. `notebookDocChanged$` was **accidentally removed** by #3535 (its
branch was rebuilt during a rebase and clobbered the post-#3530 region of
`sync-engine.ts`; neither the PR body nor the commit message mentions the
removal, and `transport.ts` still documents the observable).

Two findings sharpen the original #3530 design:

1. **Inbound-only is not enough.** `sync_applied { changed: true }` only fires
   for changes received *from* a peer. Local edits mutate the handle directly
   and the engine only sees them at flush time. A persistence trigger derived
   solely from `sync_applied` misses every local edit — the exact edits
   local-first persistence exists to protect.
2. **The reconnect teardown is the data-loss point**, not the wire protocol.
   `scheduleReconnect` → `handle.free()` destroys unflushed changes;
   `resetCloudViewStoreProjection()` blanks the visible notebook. The daemon's
   own cloud runtime agent already demonstrates the correct shape
   (`runtime_agent.rs`): preserve the docs and the queue, recreate only the
   sync states, and resync.

## Direction

Four stacked PRs. Each lands independently useful behavior; later ones build
on earlier ones.

```
main
 └─ PR 1  local-first/01-persistence      notebookDocChanged$ + IndexedDB persistence
     └─ PR 2  local-first/02-reconnect    transport reconnect loop, session preservation
         └─ PR 3  local-first/03-slot     connection/identity slot (cloud + desktop)
             └─ PR 4  local-first/04-assets  asset retry + degraded states
```

---

## PR 1 — Persistence: `notebookDocChanged$` + browser-persisted NotebookDoc

### Restore the trigger, complete it

`SyncEngine.notebookDocChanged$: Observable<void>` returns, emitted from **two**
sources:

- the `sync_applied` pipeline when `e.changed` (the #3530 behavior — remote
  changes), and
- the flush path, whenever `flush_local_changes()` yields bytes (local
  changes). Emission happens on the flush *attempt*, regardless of send
  success: `cancel_last_flush()` rolls back sync-state bookkeeping, not the
  doc — and offline flush attempts are precisely the ones persistence must
  capture.

The signal is a **save hint, not a doc-changed proof**: the flush source can
over-fire, because `generate_sync_message` also yields bytes for
protocol-only messages (the initial handshake on a fresh `sync::State`,
resync negotiation). It never under-fires for committed local changes.
Consumers must treat saves as idempotent; the persistence throttle makes the
occasional no-op snapshot cheap.

This stays consistent with the projection-convergence ADR: a narrow,
cross-host observable derived from already-computed WASM facts (the heads
comparison in `receive_frame`, the bytes-or-null from
`generate_sync_message`), no second diff, no React involvement. Saving lives
*outside* the engine.

### Storage layer (`packages/runtimed/src/persistence/`)

Borrowed from automerge-repo's proven shapes:

```ts
export type StorageKey = string[];
export interface StorageChunk { key: StorageKey; data: Uint8Array | undefined; }
export interface StorageAdapter {
  load(key: StorageKey): Promise<Uint8Array | undefined>;
  save(key: StorageKey, data: Uint8Array): Promise<void>;
  remove(key: StorageKey): Promise<void>;
  loadRange(prefix: StorageKey): Promise<StorageChunk[]>;
  removeRange(prefix: StorageKey): Promise<void>;
}
```

`IndexedDbStorageAdapter`: database `"nteract-local-first"`, object store
`"notebook-docs"`, out-of-line `string[]` keys (IDB array-key ordering gives
prefix ranges via `IDBKeyRange.bound(prefix, [...prefix, "￿"])`), one
short-lived transaction per op, writes resolve on `transaction.oncomplete`.
Where automerge-repo's adapter is thin we harden: `indexedDB` unavailable
(private mode) → adapter factory returns `null` and persistence is skipped;
`QuotaExceededError` and other write failures are caught and surfaced through
an `onError` callback (never an unhandled rejection); the connection is
reopened on `onversionchange`/close (including a rejected `open()` — the
cache is cleared through the promise, not the executor), and `close()`
exists for effect-teardown connection hygiene.

Key layout (room for incremental chunks later, without migration):

| Key | Value |
|---|---|
| `[notebookId, "snapshot"]` | one **envelope record**: 4-byte little-endian meta-JSON length, meta JSON utf8 (`{ headsHex, savedAt, principal, schemaVersion: 1 }`), then full `handle.save()` NotebookDoc bytes |
| `[notebookId, "runtime-state-cache"]` | same envelope shape over `save_state_doc()` RuntimeStateDoc bytes (meta heads = runtime heads) — PR 6's render-only paint cache, never a sync seed |

The envelope is deliberate: a single record means a single IDB transaction,
so the meta (which carries the principal guard) can never tear apart from
the bytes it describes — a two-key layout could pair one principal's meta
with another's bytes after a crash between transactions. Decode failures and
truncation degrade to `meta: null`, which seeding treats as unverifiable
(clear + bootstrap); a tear inside the doc bytes is caught by
`NotebookHandle.load()` throwing at seed time.

PR 1 saves full snapshots (the only surface `NotebookHandle` exposes is
`save()`); the adapter interface and key scheme already accommodate
automerge-repo-style content-addressed incremental chunks + compaction if doc
sizes ever demand it.

`NotebookDocPersistence` controller: subscribes `notebookDocChanged$` through
a trailing-edge async throttle (serialize saves; latest call wins —
automerge-repo's `asyncThrottle` semantics), default 1 000 ms. `flushNow()`
is wired to `pagehide`/`visibilitychange: hidden` and to runtime teardown,
and captures **unconditionally** (ignoring the change-signal dirty flag):
local edits inside the engine's 20 ms flush debounce have not emitted yet,
but `handle.save()` already sees them — the capture is synchronous, so the
session can free the WASM handle immediately after the call returns. After
three consecutive save failures the controller self-disposes (one
`[notebook-persistence] disabled after repeated save failures` warning)
so a dead or quota-exhausted backend cannot generate doomed full-doc
serializations for the rest of the session.

### What is persisted — and what is not

**NotebookDoc bytes only.** RuntimeStateDoc and CommsDoc are
daemon/room-authoritative and ephemeral; restoring stale local bytes would
fight the authority model on reconnect (#3530's settled decision). Automerge
sync state is also not persisted: the room assigns a fresh peer and fresh sync
state per connection, and (unlike automerge-repo, which persists
`shared_heads` keyed by a stable remote `storageId`) our room presents no
stable storage identity to key it by. Re-negotiation from a seeded doc is
already cheap — the sync protocol exchanges only missing changes.

### Load on init (cloud viewer)

In `connectCloudSyncRuntime`, after `cloud_room_ready` resolves,
`resolveCloudNotebookHandle` returns `{ handle, outcome }` with `outcome ∈
{ seeded, bootstrap, cleared, read_failed }`:

```
if principal is anonymous: bootstrap                 // outcome: bootstrap
persisted = await loadPersisted(notebookId)          // bounded by a 2 s timeout
  — rejection/timeout: bootstrap WITHOUT clearing    // outcome: read_failed
if persisted.meta && persisted.bytes && meta.principal === currentPrincipal:
    handle = NotebookHandle.load(persisted.bytes)    // NotebookDoc only; state/comms start empty
    handle.set_actor(ready.actor_label)              // mandatory: load() leaves a random actor
    — load() throwing: clear record, bootstrap       // outcome: cleared
else:
    clear record; bootstrap                          // outcome: cleared
```

then the existing `startCloudBootstrapSync` (`start; resetForBootstrap;
flush`) runs unchanged — a seeded doc and the room host share the frozen
genesis ([0001-notebook-seeding-invariant](./0001-notebook-seeding-invariant.md)),
so the fresh-sync-state negotiation converges by exchanging only the delta.
Offline edits captured in the persisted bytes flow to the room as ordinary
sync; the room merges them via CRDT convergence — no special merge path.

The session arms the `NotebookDocPersistence` save loop only when
`outcome !== "read_failed"` and the principal is not anonymous. A failed
read leaves an unread record (possibly the only copy of offline edits) in
place; arming the save loop would overwrite it with the bootstrap doc within
one throttle tick — fail-open for reads must be fail-closed for writes.

Safety rails:

- **Actor uniqueness.** Actor IDs are raw label bytes; reusing a label across
  doc instances collides at `(actor, seq)` (`DuplicateSeqNumber`,
  `cloud_peer.rs:73-76`). Freshness is **client-supplied**: the browser mints
  the `browser:<sessionId>` operator nonce per connect-effect run, and the
  worker rewrites only the principal segment of the presented actor label
  (`rewriteActorLabelPrincipal`) — it does not mint the operator. The
  per-run sessionId (crypto-random, with a collision-resistant non-UUID
  fallback) is therefore load-bearing; making it stable across reconnects
  would silently reintroduce duplicate seqs against a seeded doc.
- **Principal guard.** Persisted bytes carry the authoring principal in the
  envelope meta. On mismatch (sign-in changed between sessions) the record
  is discarded and cleared — otherwise the room's actor-principal
  authorization would reject the replayed changes on every reconnect,
  looping forever.
- **Anonymous sessions skip persistence entirely** (no seed, no save, no
  clear): anonymous principals embed the per-connection session nonce, so a
  record can never match the next session — and an anonymous session must
  not clear a signed-in user's record on principal mismatch.
- **Corruption guard.** `NotebookHandle.load()` throwing → clear the record,
  fall back to `create_bootstrap` (mirror automerge-repo's
  storage-unavailable degradation: local cache lost, network still works).
- **Seeded-rejection escalation (poison pill).** The principal guard cannot
  catch every record the room will refuse: a scope downgrade (editor →
  viewer holding offline edits) or a room history regression rejects seeded
  changes under the *same* principal, and `cloud_frame_rejected
  (AUTOMERGE_SYNC)` → reconnect → reseed would loop forever. When a seeded
  session hits a recoverable sync rejection the session disposes the
  runtime FIRST (teardown's `flushNow` re-writes the record with the
  rejected changes), then clears the record once that write settles, and
  marks the next connect attempt bootstrap-only. The rejected changes are
  unauthorized — losing them is the intended outcome.

Desktop is not wired in PR 1 (the Tauri app persists to the filesystem; a
desktop client attached to a remote notebook can adopt the same module later —
that is why it lives in `packages/runtimed`, not in the cloud app).

### Tests

`fake-indexeddb` (dev dep) for the adapter (round-trips, segment-exact
prefix ranges, unavailable-IDB factory, write-failure surfacing, reopen
after stale connection / failed open, `close()`); sync-engine tests for both
emission sources plus the negatives (no emission on `changed=false`, on
no-op flush, on runtime-state/comms events, or when only non-notebook
flushes produce bytes); controller tests (throttle, latest-wins, serialized
writes, unconditional `flushNow`, flush-then-dispose commit, envelope codec
incl. torn records, failure escalation); live-sync tests for seed-outcome
selection (seeded / bootstrap / cleared / read_failed incl. timeout),
anonymous skip, principal mismatch, corrupt-bytes fallback, and the
seeded-rejection discard predicate; a stub-module test for the real
`load + set_actor + free-on-error` binding.

---

## PR 2 — Reconnect: transport-owned loop, session-owned continuity

### Transport (`CloudWebSocketTransport`)

Today the transport is single-shot: one WS, `markClosed` is terminal, and the
session rebuilds the world. It becomes multi-connection, borrowing the
automerge-repo websocket adapter's good parts and fixing its known flaws:

- **One re-entrant `#connect()`** is both initial connect and every retry:
  detach the old socket's listeners, open a fresh socket from a
  `connectTarget: () => Promise<{url, protocols}>` factory (re-resolves auth
  per attempt — tokens expire mid-session), replay the `cloud_room_ready`
  handshake in full. The factory also mints a **fresh operator nonce per
  attempt** (`createCloudConnectTarget`): the actor-safety rule is "preserve
  the handle XOR reuse the actor label" — a preserved handle with a new
  label is safe (`set_actor` starts a fresh seq chain), a fresh handle with
  a reused label collides (DuplicateSeqNumber); fresh-per-attempt is the
  universally safe choice. Each attempt is bounded end to end by a 30 s
  per-attempt budget: the `connectTarget()` resolution itself is timed out
  (a hung auth fetch becomes a normal failed attempt, never a wedge with no
  socket and no timers) and the same budget arms a handshake timer (open ≠
  ready) that recycles the attempt instead of dead-ending. The `online`
  event also supersedes an attempt parked in `connectTarget()` — the epoch
  guard discards the late-settling target.
- **Exponential backoff with jitter** (automerge-repo uses a fixed 5 s
  interval — explicitly noted as a flaw): base 1 s, ×2, cap 30 s, ±50 %
  full jitter. Reset on `cloud_room_ready` (the application-level ack),
  *not* on WS `open` — an LB can accept sockets while the room is
  unreachable. A `navigator` `online` event short-circuits the current
  wait. Retries continue until manual `disconnect()`.
- **Status transitions:** `connecting` (first attempt *and* pre-first-ready
  retries) → `online` (each ready) → `reconnecting` (a previously-online
  connection lost, loop active) → `offline` (manual disconnect only). This
  is the first user of the reserved `"reconnecting"` status.
- **Drop, don't buffer.** Sends while not-OPEN reject, and so do sends in
  the open→ready handshake window — frames sent there would go out under
  the PREVIOUS connection's sync state and actor (the outbound mirror of
  the inbound roomReady$ ordering guarantee). Pending FIFO frame ACKs are
  rejected per connection loss (they cannot span sockets). Frames queued
  from a dead connection are likewise discarded — they are bound to that
  connection's sync state. The sync layer already rolls back via
  `cancel_last_flush` and regenerates from sync state after the handshake —
  correctness lives in the protocol, not in an outbound queue.
- **`roomReady$: Observable<CloudRoomReady>`** emits per successful handshake
  (initial and every reconnect) carrying the new `peer_id`, `actor_label`,
  `connection_scope` — the session's signal to re-establish identity. Two
  load-bearing delivery properties: the emission is **synchronous within
  the ready message's handling**, before any subsequent frame of that
  connection is dispatched (the room host kicks host-initiated sync
  immediately after ready, and a sync frame applied against the previous
  connection's sync state is garbage); and the subject **replays the
  latest handshake** to late subscribers, so a reconnect that lands while
  the session is still creating the handle is adopted on subscribe.

### Session (`cloud-viewer-session.ts`)

The reconnect effect no longer tears the world down. Across a transport-level
reconnect the session **preserves** the WASM handle (unflushed local edits
live there), the `SyncEngine` and its subscriptions, and the store projections
(no `resetCloudViewStoreProjection()` / `replaceNotebookCells([])` blanking —
the desktop bootstrap-preservation pattern, applied to cloud). On each
`roomReady$` after the first it **recreates** only the per-connection state,
mirroring the daemon agent (`runtime_agent.rs:1046-1052`) via
`CloudSyncRuntime.applyRoomReady` → `reestablishCloudConnection`:

```
handle.set_actor(ready.actor_label)   // fresh actor (client-minted nonce,
                                      // principal rewritten by the worker)
engine.resetForBootstrap()            // pending session status, cleared diff caches
engine.resetAndResync()               // reset_sync_state() + flush() — full resync kick
presence/identity state ← ready       // peer_id, scope, actor label, peer label
```

The first three steps run **synchronously inside the roomReady$ emission**
(no awaits before them): the room kicks sync immediately after ready, so the
re-establish must complete before the new connection's first frame is
applied. Identity is mutable on the runtime (getters), so presence encoders
always stamp the latest peer id; the persistence principal follows the
latest identity (same-principal reconnects keep the controller, a principal
change recreates it, and a `read_failed` seed outcome keeps saves disarmed
for the runtime's whole life).

RuntimeStateDoc/CommsDoc re-sync from the room (authoritative) into the
preserved stores. The offline fail-open window on cloud is closed by
`connectionError` → shell-capability / `sessionRuntimeState` gating
(`canAcceptCellMutations` requires no connection error; cleared on the
next `cloud_room_ready`) — NOT by `resetForBootstrap`'s pending
`SessionStatus`, which is inert on this surface: the cloud transport
consumes every SESSION_CONTROL frame itself, so `sessionStatus$` never
fires on cloud (it is the engine-level guard for sessionStatus$-consuming
surfaces, i.e. desktop). `resetForBootstrap` remains load-bearing on cloud
for its diff-cache clearing. Known limitation until PR 3 surfaces
connection state: the runtime-state store is deliberately not blanked on
transport-level reconnects, so stale kernel/execution chrome can stay
visible during the offline window. The initial-connect failure path
(previously a terminal error after a 30 s ready timeout) now rides the
same loop — the transport keeps trying, the session stays in
`connecting`/`reconnecting` (`onConnectionLost` is informational: presence
marked disconnected, `connectionError` surfaced, access diagnostics run
once), and the existing notices surface a quiet reconnecting state instead
of the dead-end "Live room needs attention."

Escalation (`CloudRecoverableRejectionTracker`): the first recoverable
`cloud_frame_rejected(AUTOMERGE_SYNC)` on a connection is handled in place —
`resetAndResync()` on the live connection, no teardown. The strike only
clears once the resync's outbound flush has actually been delivered
(`engine.flushAndWait()`): the ack protocol carries no frame id and several
AUTOMERGE_SYNC frames are routinely in flight, so rejections that arrive
before delivery cannot have observed the resync — they **absorb** into
strike 1 (the same divergence event) instead of escalating. Only a
post-delivery repeat within the same connection (the tracker resets per
`cloud_room_ready`) escalates to the full teardown path, as does a
rejection that arrives before the runtime exists (which also marks the
next attempt bootstrap-only — closing the former poison-pill blind spot).
For transport-level divergence the persisted snapshot reseeds the fresh
handle loss-lessly; for content-caused rejections on a seeded session the
reseed would be the poison, so PR 1's escalation takes over: dispose, clear
the record after the teardown flush settles
(`discardPersistedSeedAfterTeardown`), and bootstrap the next attempt. The
discard chain is stashed in a ref the next attempt's persistence arming
awaits (strict clear-then-arm), so a straggling clear can never delete the
fresh attempt's first record. Escalation teardowns also bump the
materialization generation before freeing the handle, so in-flight
materializations bail instead of touching a freed handle.

### Tests

Mock WS server harness (extended `live-sync.test.ts`): backoff schedule
under mock timers (growth, cap, jitter bounds, reset-on-ready, NO reset on
WS open without ready, online-event short-circuit and supersession of a
parked `connectTarget()` await); per-attempt budget recycling for both a
handshake that never completes and a hung or rejecting `connectTarget()`;
status transitions incl. `reconnecting`; handshake replay emitting
`roomReady$` with fresh identity (plus late-subscriber replay) and the
adoption seam (`applyCloudRoomReady` dedup/identity ordering); pending-ACK
rejection and queued-frame discard at socket loss; pre-ready send
rejection; the ready→immediate-sync-frame ordering regression; an
engine-level continuity test proving an edit made while disconnected is
rolled back, preserved, and delivered by the reconnect resync while the
original `cellChanges$` subscription keeps receiving (no engine restart,
no projection blanking); rejection-tracker lifecycle (strike, absorb,
post-delivery escalation, per-connection reset); the dispose-flush→clear
ordering of the seed discard; fresh-operator-nonce-per-attempt through the
real `createCloudConnectTarget`.

---

## PR 3 — Connection/identity slot

One shared component — `NotebookConnectionIdentity`
(`src/components/notebook/`) — mounted in slots that already existed and
were empty:

- **Cloud:** the `identityControls={null}` slot in `notebook-viewer.tsx`
  (right-most header slot), now filled.
- **Desktop:** `trailingControls` on `<NotebookToolbar>` in `App.tsx` →
  `identityControls` at the right end of the command toolbar, fed by a
  daemon-lifecycle source (`createDesktopConnectionStatusSource`:
  `daemon:ready` → online, `daemon:disconnected` → reconnecting — the host
  auto-reconnects — `daemon:unavailable` → offline; the host facade's
  ready-cache backfill covers late mounts). The Tauri IPC transport's own
  `connectionStatus$` is deliberately NOT used: it is honest about IPC but
  constant in practice (the app never disconnects it), so a dot fed from
  it could never transition through a daemon restart. The desktop copy is
  scoped to the measured link via `connectionLabel="Daemon connection"` —
  daemon↔room link health for runtime-peer contexts is **future work**;
  until it exists the dot must say which hop it reports.

**Conditionality** (the reason #3290 pulled the previous attempt): the slot
renders **nothing** for a purely local desktop session. The predicate is
centralized in the component (`isRemoteNotebookContext`):
`access.source !== "local"` or `runtime.target.kind === "runtime_peer"`.
Cloud is always remote, so hosts mount unconditionally.

**Content:** self-identity (the flattened avatar treatment via the shared
actor projection — initials/avatar only, no visible label, hidden from the
a11y tree so the sr-only copy is the single accessible text) paired with a
connectivity dot driven by `connectionStatus$` — its first UI consumer. The
component accepts a structural `NotebookConnectionStatusSource` (an
rxjs-free `Observable` subset with an optional `getCurrent()` snapshot so
first paint shows the real status, no one-frame "connecting" flash) so
shared `src/` takes no new dependency. Status vocabulary follows the
existing tones: emerald `online`, amber pulse `reconnecting`/`connecting`,
muted `offline`; non-online states also dim the wrapper (opacity, not
copy). Status CHANGES (never the initial value) are announced through a
polite sr-only live region using the scoped link copy — quiet for the eyes
is not silence for screen readers. This is the surface that makes the PR-2
limitation interpretable: runtime-state stores are not blanked during the
offline window, and the pulsing dot stays live through `reconnecting` so
frozen kernel/execution chrome reads as "reconnecting", not as truth — for
the link each host actually measures.

**Aesthetic rules distilled from the three pulled designs** (#3273, #3290,
#3337, #3349 — recorded so we do not relitigate them):

- flat `rounded-md border-border/70 bg-muted/35`; never `rounded-full` +
  shadow ("raised bubble");
- icon/avatar-first; `sr-only` labels + tooltip detail; no text pills (the
  #3337 regression tests assert their absence — keep them passing);
- state changes express as opacity/dot color, not copy;
- errors and reconnect prompts belong to the notices stack, never inline
  header chrome;
- connection state never masquerades as kernel/runtime status (#3273);
- collapse to icon-only at narrow widths (≤520 px cloud pattern);
- lucide icons at `size-4` or smaller.

Plumbing fix included: the host facade's `connectionStatus$` delegation
captures whichever transport exists at subscribe time and never switches — a
subscriber can watch a dead transport forever. With PR 2 the transport object
survives reconnects, but initial-connect attempts and escalation teardowns
still replace it; the session exposes `CloudConnectionStatusBridge`
(`live-sync.ts`) — a stable BehaviorSubject-backed source attached to each
replacement transport via `onTransportCreated`, deduplicating across
switches. On escalation teardown — and in the effect cleanup, where the
auth-refresh re-run early-returns without attaching a replacement — the
bridge detaches BEFORE the dispose and reports `"reconnecting"`, so the
disposed transport's terminal `"offline"` (manual-disconnect vocabulary)
never surfaces and the gap reads as a transition, never as stale
`"online"`. The bridge implements the slot's source contract directly
(`subscribe` + `getCurrent`).

Tests: component tests for every status × identity combination
(data-state + dot tone + opacity), the local-session-renders-nothing gate,
the runtime-peer remote case, the live-dot-through-reconnecting regression,
scoped-link copy, `getCurrent` first paint, live-region announcements
(changes only, never the mount), aria-hidden avatar, unmount-unsubscribe,
the flat-never-raised treatment across the whole subtree, and
icon-only-at-every-width via clone-and-strip (wrapper text nodes included);
desktop tests for the daemon-lifecycle source (lifecycle walk, dedup,
replay/getCurrent, dispose), the real-projection composition with
`isRemoteNotebookContext`, the toolbar trailingControls flow with real
`desktopNotebookShellCapabilities` output, and a source-text pin on the
App.tsx mount (daemon source + scoped label, not the IPC transport); bridge
tests for transport replacement, plain-detach silence, the slot source
contract, teardown-retry masking of the disposed transport's offline, and
the PR-2 loop reflected without a switch; session wiring order
(attach-on-transport-created, retry-before-dispose in all three teardown
paths) pinned by source guardrails; #3337's quiet-chrome regressions stay
green (the `identityControls={null}` pin became a module-scoped pin on the
new mount).

---

## PR 4 — Asset fetch resilience and degraded states

Findings → interventions (all paths verified in research):

1. **Cached-rejection bug (fix first).** `runtimed-wasm-client.ts` caches the
   dynamic `import()` promise; the failure path resets `initialized` but not
   `loadedModule`/`loadedModuleSource`, so one transient failure pins a
   rejected promise for the life of the page and every "retry" re-awaits it.
   Clear them on rejection + regression test.
2. **Retry the runtimed WASM load** with the blob-resolver ladder (delays
   `[150, 500, 1500]`; retry thrown fetch errors and statuses 404/409/425/
   429/5xx — 404 is deliberately retryable for deploy propagation), then
   **fall back from hashed to stable filenames** (`runtimed_wasm.js` /
   `runtimed_wasm_bg.wasm` are deployed under both names for exactly this) to
   absorb deploy-window skew.
3. **Renderer bundle:** bounded backoff retries inside
   `IsolatedRendererProvider` (module-level cache means one recovery un-blanks
   every output iframe), plus an exposed `retry()`.
4. **Visible degraded state instead of N silent blanks:** the isolated-output
   branch gets the `ErrorBoundary` + `OutputErrorFallback`-with-retry
   treatment the in-DOM branch already has; N identical renderer failures
   aggregate into one quiet notice in `CloudNotebookNotices` (per the
   header-chrome rules above) rather than per-output console errors.
5. **Finish the content-hash story:** apply the `runtime-wasm-assets.mjs`
   hashed-filename + manifest pattern (PR #3449) to `isolated-renderer.js`/
   `.css` (and the `sift_wasm.wasm` filename, retiring its `?v=` query on
   cloud), so `isContentHashedAssetPathname` returns the renderer-assets
   origin to fully `immutable` caching. Stable-name copies remain the
   documented fallback. (The interim `must-revalidate` fix was #3416.)

Initial-connect retry is *not* in this PR — it landed with PR 2's loop, where
connection resilience lives.

---

## Invariants (load-bearing, checked in review)

- Only **NotebookDoc bytes** may seed a syncing handle. CommsDoc and
  Automerge sync states are never written to storage. RuntimeStateDoc bytes
  are stored solely as the render-only `runtime-state-cache` record (PR 6)
  — a paint source decoded into a throwaway handle, never loaded into the
  syncing handle, never flushed, never synced; the syncing handle always
  bootstraps RuntimeStateDoc empty and the daemon/room remains the only
  writer.
- After `NotebookHandle.load()`, `set_actor()` with a **fresh per-connection
  label** before any authoring (operator nonce client-minted per connect
  attempt; principal rewritten by the worker). Never reuse an actor label
  across doc instances.
- Persisted bytes and their authoring principal live in **one atomic
  envelope record**; principal mismatch or an unverifiable envelope ⇒
  discard. Anonymous principals never seed, save, or clear.
- Preserve the handle **xor** mint a new actor — never re-bootstrap a
  preserved handle.
- Storage failures degrade to no-persistence; they never break the live
  session. Corrupt local bytes degrade to bootstrap. A failed or timed-out
  seed read leaves the record in place **and** leaves the save loop
  disarmed — fail-open reads are fail-closed for writes.
- A seeded session whose replayed changes the room rejects clears its
  record (after the teardown flush settles) and retries from bootstrap —
  a persisted record must never be able to wedge a notebook permanently.
- `notebookDocChanged$` is a narrow engine observable derived from existing
  WASM-computed facts; persistence I/O stays outside the engine
  (projection-convergence ADR).
- Connection state stays out of kernel/runtime status surfaces; reconnect
  errors go to notices, not header chrome.
- Store projections are not blanked during reconnect; cell list keeps stable
  DOM order while projections update in place.

## Planned follow-ups (beyond the stack)

### PR 5 — Surface offline merges (conflicts are silent today)

Offline edits merge silently on reconnect: the returning user gets no signal
that their changes interleaved with remote ones, that a same-key write lost
deterministically, or — the sharp edge — that a cell they edited offline was
deleted remotely and stays deleted (Automerge does not resurrect). The
ingredients to surface this already exist: heads before/after resync, the
text-attribution stream, and the PR 3 slot/notices stack as the quiet mount
point ("merged N offline changes" affordance, never a modal). We will
inevitably hit this as collaborative offline use grows; scoped follow-up
once the stack lands.

### PR 6 — Instant first paint from the persisted snapshot (landed)

The persistence layer's second purpose (and a primary motivation for using
IndexedDB at all): page load paints the notebook *immediately* from the
local envelope records instead of waiting for the WS dial +
`cloud_room_ready` + full bootstrap sync. PR 1 deliberately seeds *after*
the handshake because authoring needs the server-assigned actor label — but
**painting needs no actor**. The pinned-snapshot path already proved
bytes → throwaway handle → `materializeCloudNotebookView` works without a
live connection. As landed:

- **Outputs paint too — via a render-only RuntimeStateDoc cache (the base
  case).** Outputs are most of what a notebook visually *is*. The session
  arms a second throttled persistence controller alongside the NotebookDoc
  seed (`createCloudNotebookPersistence`,
  `apps/notebook-cloud/viewer/notebook-persistence.ts`): RuntimeStateDoc
  bytes from `save_state_doc()` under the sibling key
  `[notebookId, "runtime-state-cache"]`, same envelope codec, own meta
  (runtime heads via `get_runtime_state_heads_hex()`, savedAt, principal,
  schemaVersion 1), driven by the engine's `runtimeState$` stream. The
  record is **strictly a paint source** — decoded into a throwaway render
  handle, never loaded into the syncing handle, never flushed, never
  synced. The authority invariant forbids restoring runtime state into the
  sync path, not caching pixels; the syncing handle still bootstraps
  RuntimeStateDoc empty and the room remains the only writer. Anonymous
  sessions and `read_failed` seed outcomes keep the whole save loop
  disarmed; teardown/pagehide flushes commit both records before the handle
  frees, and seed-level clears (`removeRange`) discard the cache with the
  seed. Blob-backed output *bytes* were already solved (content-addressed
  refs + `Cache-Control: immutable`); the cache preserves the
  **addressing** — the execution-id → output → manifest → blob-ref chain —
  so the normal output-resolution path runs against cached bytes with no
  live room. Cloud-only; desktop has the local daemon.
- **Paint-before-handshake:** the live-room effect kicks
  `resolveCloudInstantPaintHandle` (`viewer/instant-paint.ts`) in parallel
  with the WS dial (after the connect call, so the dial is never delayed).
  Both envelopes are read (bounded by a 2 s timeout; a failed read skips
  the paint and clears nothing), decoded via
  `loadRenderSnapshotHandle` — `load_snapshot(notebook, runtimeState)`
  with the cache, plain `load(notebook)` without it, **no `set_actor`** —
  then materialized through `materializeCloudNotebookView` and freed.
- **Pre-handshake principal gate:** before `cloud_room_ready` the
  connection's principal is unknown, and IDB may hold another user's
  notebook on a shared machine. `cloudInstantPaintPrincipalMatcher`
  derives a matcher from locally stored auth material: the dev-token user
  maps to the exact `user:dev:<encoded user>` principal (the worker's
  derivation is deterministic); OIDC matches the stored subject claim as
  the principal's encoded id segment (the namespace prefix is
  server-configured and not client-derivable), with expired claims
  accepted only when the app-session cookie backs them. No derivable
  principal, or a mismatch on **either** envelope, skips the paint without
  clearing — post-handshake seeding owns clear decisions. Anonymous
  principals never match.
- **Degradations:** notebook envelope without a cache record paints
  cells-only. A torn cache envelope, or `load_snapshot` rejecting with
  cache bytes in play, clears **only** the `runtime-state-cache` record
  and retries cells-only; corrupt notebook bytes skip the paint without
  clearing; transient WASM asset failures clear nothing.
- **Race + handoff:** if the live connect wins the race against the cache
  read, the paint is skipped (`liveMaterializedRef` guards every apply) —
  stale cache never overwrites a live materialization. When the paint
  wins, it lands through the same `applyResolvedCells` path, so the #3577
  preservation gate keeps it across effect re-runs and the live
  materialization replaces it wholesale in place (no blanking). The paint
  runs only on the live-room path; the pinned-revision URL keeps its
  snapshot fetch (mutually exclusive by loading policy). Poison-pill
  attempts (seed discard in flight) skip the paint along with the seed.
- Offline *editing* before the first-ever handshake stays out of scope
  (below) — this PR is about read latency, not offline authoring.

## Prior-art trajectory: subduction / sedimentree

The automerge ecosystem's successor sync line (Ink & Switch
[subduction](https://github.com/inkandswitch/subduction), the Beelay
successor; integrated on automerge-repo's `subductionjs` branch, with the
fragments API on automerge core's `next` tag as `3.3.0-fragments.1`)
replaces per-peer bloom-filter `sync::State` with content-addressed
**sedimentree** sync: commit hashes deterministically partition history into
fragments, batch sync is a 1.5-RT fingerprint diff, and **no durable
per-peer sync state exists** — reconnect is a re-handshake plus one summary
exchange. Explicitly experimental upstream ("DO NOT use for production");
not adoptable now. What this ADR already gets right relative to it: the
`StorageAdapter` interface here is the same interface subduction's storage
bridge wraps upstream, and subduction writes under its own
`["subduction", ...]` key prefix — coexistence requires zero migration, and
our snapshot envelope degrades into a bootstrap cache. Cheap alignment
moves when the time comes:

1. Optional `saveBatch(entries)` on `StorageAdapter` (upstream's exact
   extension; sequential-save fallback) with crash-ordered writes
   (blobs → metadata → id-marker: a crash leaves invisible orphans, never a
   visible-but-incomplete record).
2. Fill the reserved "incremental chunks later" slot against the automerge
   3.3 fragments API (`getFragmentMetadata`/`bundleFragmentMetadata` via new
   `NotebookHandle` WASM exports) instead of inventing a chunk format —
   core-driven, deterministic compaction for free.
3. Operational patterns worth stealing regardless: per-doc heal-retry with
   an exhaustion signal, and "confirmation is just another sync"
   idempotence.

## Out of scope (recorded, no PR planned)

- Offline *authoring* before the first `cloud_room_ready` of a session
  (needs an actor-label strategy that does not depend on the server
  handshake, e.g. locally-minted operator nonces).
- Incremental chunk persistence + compaction (key scheme reserves room; add
  `save_incremental`-style WASM exports when doc sizes justify it).
- Desktop adoption of the persistence module for remote-attached notebooks.
- Multi-tab write coordination. The envelope is last-write-wins per
  notebook: a second tab's save (or pagehide flush) can regress the stored
  heads and destroy the only copy of another tab's flushed-but-undelivered
  edits — the room only heals divergence it has seen. Accepted limitation
  until content-addressed incremental chunks (which the key scheme reserves
  room for) make concurrent writers structurally safe.
