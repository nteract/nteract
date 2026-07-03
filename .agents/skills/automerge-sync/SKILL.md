---
name: automerge-sync
description: >
  Automerge sync protocol internals, document model (OpSet, ChangeGraph,
  fork/merge, save/load lifecycle), and higher-level protocol design
  patterns. Use when debugging sync failures, reasoning about convergence,
  changing reconnection logic, working with document structure, diagnosing
  panics in op application, adding new sync streams, or evaluating
  architectural patterns from automerge-repo and samod.
---

# Automerge Sync & Document Model

## Document Model Essentials

### Core Types

| Type | Role | Key detail |
|------|------|-----------|
| `OpId(counter, actor_index)` | Universal op identifier | `ROOT` = `(0,0)`. Counter is per-actor monotonic. Actor index is position in actor table. |
| `ActorId` | Peer identity (`TinyVec<[u8;16]>`) | Lexicographic byte ordering is load-bearing. nteract uses `"runtimed"`, `"human:<uuid>"`. |
| `Change` | Batch of ops with causal deps | Has `actor_id`, `seq` (per-actor monotonic), `deps` (parent hashes), `hash` (SHA-256). |
| `ChangeGraph` | DAG of history | `heads` = changes with no children. `has_change(&hash)` is O(1). Backs `required_heads`. |
| `OpSet` | Materialized document (columnar) | Ops sorted by `(object, key, lamport_ts)`. Rebuilt from columns on `load()`. |

**Actor table ordering:** `OpSet.actors` is a sorted `Vec<ActorId>`. Ops store only the index. If two documents disagree on index→actor mapping, ops are misinterpreted. This is the root of the historical #1187 panic class.

### The Automerge / AutoCommit Structs

```rust
// Automerge: raw document
Automerge { queue: ChangeQueue, change_graph: ChangeGraph, deps: HashSet<ChangeHash>, ops: OpSet, actor: Actor }

// AutoCommit: wrapper nteract uses
AutoCommit { doc: Automerge, transaction: Option<(PatchLog, TransactionInner)>,
             patch_log: PatchLog, diff_cursor, save_cursor, isolation: Option<Vec<ChangeHash>> }
```

**Auto-transaction:** Mutations open a transaction implicitly. Reads, `save()`, `fork()`, `merge()`, and `sync()` commit pending ops first.

**Isolation mode:** `isolate(heads)` limits visible state. Mutations while isolated depend on isolation heads, not tips. `integrate()` returns to latest.

**PatchLog:** Tracks diffs for incremental materialization. nteract's WASM computes `CellChangeset` by diffing after sync frames.

### save() and load()

- **save()** serializes OpSet columns + ChangeGraph metadata + optional DEFLATE. Columnar format is canonical.
- **load()** rebuilds OpSet from columns, reconstructs ChangeGraph, verifies heads.
- **save/load round-trip clears corrupted indices** — the basis of nteract's `rebuild_from_save()` recovery.
- **load_incremental()** adds changes to existing doc. This is what `receive_sync_message` calls internally.
- **save_after(heads)** emits only changes after given heads (incremental saves).

### Fork and Merge

| Method | Semantics | Cost |
|--------|-----------|------|
| `fork()` | Deep clone + new random actor | O(doc size) |
| `fork_at(heads)` | Replay changes up to heads into fresh doc | More expensive than fork; use for views/diagnostics |
| `merge(other)` | Apply other's new changes to self | O(changes added) |

**DuplicateSeqNumber trap:** Two concurrent forks sharing the same ActorId produce changes with identical `(actor, seq)`. The second merge fails. Use unique actors for concurrent forks.

### Document Size

| Factor | Growth | Notes |
|--------|--------|-------|
| Operations | O(total mutations) | Largest factor |
| Tombstones | Accumulate forever | No built-in GC |
| Actor table | O(unique peers) | Small per entry |
| ChangeGraph | O(total changes) | Metadata per change |

`save()` compacts via columnar + DEFLATE. No history compaction exists.

## Sync Protocol Internals

### Sync Message Structure

```
Message { heads, need, have: Vec<Have>, changes: ChunkList, flags, version }
```

- `heads`: "here's what I have"
- `need`: "I'm missing these specific changes"
- `have`: bloom filter (1% FP rate, 10 bits/entry, 7 probes) of changes since `last_sync`
- `changes`: actual change data
- Sender sends a change only if all peer bloom filters say they lack it

### sync::State — Per-Peer Session

| Field | Persists across encode/decode? | Purpose |
|-------|-------------------------------|---------|
| `shared_heads` | **Yes** | Hashes both peers agree they share |
| `last_sent_heads` | No | Our heads at last send |
| `their_heads` / `their_need` / `their_have` | No | Peer's last advertisement |
| `sent_hashes` | No | Dedup already-sent changes |
| `in_flight` | No | Suppresses duplicate sends while awaiting ack |
| `have_responded` | No | True after first message sent |

**Critical:** `encode()` only serializes `shared_heads`. All else is session-ephemeral. `sync::State::new()` is always safe for reconnection — you lose optimization (may resend) but keep correctness.

### In-Flight Suppression

`generate_sync_message()` returns `None` when `in_flight && last_sent_heads == our_heads && have_responded`. Any incoming message sets `in_flight = false` (counts as ack). If you need a fresh exchange, reset sync state rather than working around `None`.

### Change Selection

1. Compute needed deps from their advertised heads
2. Build bloom filter from our changes since `shared_heads`
3. Filter through their bloom (send what they probably lack), deduplicate against `sent_hashes`
4. If sending >1/3 of doc, send whole doc as V2 (more efficient)

### Version Negotiation

V1 is original; V2 allows compressed document encoding. Backward-compatible via `MessageFlags` appended to V1 messages. V2 discovered via flags, then used for subsequent messages.

## nteract Sync Architecture

### Document Streams Over One Socket

| Stream | Frame | Document | Ownership |
|--------|-------|----------|-----------|
| Notebook | `0x00` AutomergeSync | `SharedDocState.doc` | Bidirectional |
| RuntimeState | `0x05` RuntimeStateSync | `SharedDocState.state_doc` | Daemon-authoritative |
| CommsDoc | `0x09` CommsDocSync | `SharedDocState.comms_doc` | Widget state, gated by RuntimeStateDoc topology |
| CommentsDoc | `0x0a` CommentsDocSync | `SharedDocState.comments_doc` (typed clients + frontend WASM); daemon replica persisted by `comments_store.rs` | Notebook-room comments sidecar; ingress validates change actor labels against the connection principal |
| PoolState | `0x06` PoolStateSync | PoolDoc | Frontend owns sync state; daemon carries `pool_peer_state` separately |

For CommentsDoc, see `crates/comments-doc`, daemon persistence at
`crates/runtimed/src/notebook_sync_server/comments_store.rs`, ingress at
`peer_comments_sync.rs`. Typed clients (`notebook-sync` crate) and frontend
WASM (`runtimed-wasm`) both hold CommentsDoc replicas. Optimistic client
mutations apply via Automerge; the daemon validates change actor labels against
the connection principal (clone-preview) and strips writes from scopes without
comment authority. There is no daemon finalization step — attribution
(`resolved_by_actor_label`, `resolved_at`) is projected from admitted change
actors.

### Sync Task Loop (biased select!)

Priority: **Frame** (drain socket) → **Changed** (outbound sync) → **Command** (RPC) → **Maintenance** (50ms tick).

Mutex is `std::sync::Mutex`, never held across `.await`. Poison recovery: `unwrap_or_else(|e| e.into_inner())`.

### Document-Level Recovery

Automerge is treated as a fallible boundary. Recovery lives inside the document owner while the guard is held.

```rust
state.receive_sync_message_recovering(msg, "notebook-sync-receive");
let bytes = state.generate_sync_message_recovering("notebook-sync-outbound");
```

**Rebuild procedure (notebook doc):**
1. `save()` → `AutoCommit::load()` (clears corrupted indices)
2. Cell-count guard: skip rebuild if fewer cells (prevents silent loss)
3. Preserve actor ID
4. `peer_state = sync::State::new()`

**Rebuild procedure (RuntimeStateDoc / CommsDoc):** Round-trip via
`rebuild_from_save()`, then reset the matching peer state with
`sync::State::new()`.

Principle: **reset transport state, preserve document truth.**

### Causal Ordering: required_heads (preferred)

1. Client captures current heads via `DocHandle::current_heads_hex()`
2. Sends request with `required_heads` in envelope
3. Daemon's `wait_for_required_heads()` checks containment via `get_change_by_hash`
4. Defers processing until all heads arrive (10s timeout) or proceeds immediately
5. Sync loop stays unblocked; only that specific request waits

**confirm_sync** (legacy alternative): Client-side waiter on `shared_heads`. Blocks client, daemon free. Still used for `SaveNotebook`.

| Scenario | Use |
|----------|-----|
| Execute / run-all | `required_heads` via `send_request_after_heads` |
| Client-initiated save | `confirm_sync` before `SaveNotebook` request |
| Daemon-internal autosave | Neither — daemon reads its own doc directly |

### RuntimeStateDoc Output Pressure

RuntimeStateDoc is the durable state boundary, not the hot transport for every
transient kernel event. Control-plane signals must stay independent of output
work:

- `KernelIdle`, `ExecutionDone`, `CellError`, and `KernelDied` use reliable
  lifecycle/control paths, not bounded output queues.
- stdout/stderr stream chunks may be periodically flushed through bounded,
  droppable work, but ordering boundaries use the stream committer priority
  path so terminal state follows the final durable stream manifest.
- Output widget replay back to the kernel is best-effort; widget state in
  RuntimeStateDoc is the durable truth.
- `update_display_data` with a `display_id` is transient display churn. Coalesce
  to the latest pending value per `display_id` off the IOPub path, then flush
  before `ExecutionDone`.

## Protocol Design Patterns

### Architecture Comparison

| | automerge-repo | samod | nteract |
|-|---------------|-------|---------|
| Topology | Mesh, transport-agnostic | Sans-IO state machine | Direct socket to single daemon |
| Heads tracking | `RemoteHeadsSubscriptions` (pub/sub) | Per-peer monotonic counters on every message | `required_heads` (request-scoped causal gate) |
| On disconnect | Keep sync state, encode/decode to clear in-flight | Clean slate (`peer_disconnected`) | Clean slate (`sync::State::new()`) |
| Batch→Incremental | Bloom filter exchange → live sync frames | Fingerprint reconciliation → subscription push | Same as raw automerge |
| Testability | Async, needs mocks | Pure sans-IO functions | Async select! loop |

**nteract's `required_heads` is novel:** request-scoped causal gating where the daemon defers one request until preconditions are met while sync continues unblocked. Neither automerge-repo nor samod gates actions on causal preconditions this way.

### Settings Sync

Settings have two distinct client shapes:

- **Long-lived watchers** use `SyncClient::connect` and keep the initial
  quiescence loop because they are about to wait on the same stream for future
  daemon fanout.
- **One-shot command paths** use `SyncClient::connect_snapshot` /
  `connect_snapshot_with_timeout`. They still perform as many Automerge rounds
  as needed to satisfy the daemon's advertised heads, but they do not pay the
  final blind 100ms receive timeout once the snapshot is causally present. The
  snapshot exchange must remain bounded by a protocol timeout.

Do not route connected-window settings UX through the JSON watcher. The daemon
persists `settings.json` for durability and imports external edits through a
debounced file watcher; ordinary window-to-window propagation should use the
settings sync stream plus Tauri `settings:changed` events.

### Connection Lifecycle

| System | On Disconnect | On Reconnect | Preserved |
|--------|--------------|--------------|-----------|
| automerge-repo | Keep sync state | encode/decode clears in-flight, keeps shared_heads | Sync state |
| samod | Remove + `peer_disconnected` | Fresh handshake + batch sync | Nothing |
| nteract | Clear session, stash target | `sync::State::new()` + full handshake | Session identity only |

If reconnect latency becomes a problem, preserving `shared_heads` (automerge-repo approach) could reduce initial sync burst.

## nteract Mutation Patterns

| Scenario | Method |
|----------|--------|
| Synchronous batch mutation | `fork_and_merge(\|fork\| { ... })` |
| Async write from captured heads | `transact_at_heads_recovering(&baseline_heads, actor, label, \|doc\| { ... })` |
| Concurrent async fork | `fork_with_actor("runtimed:iopub:kernel-abc")` — unique actor per fork |
| Per-cell O(1) reads (WASM) | Direct map lookups via `ObjIndex` |
| Recovery from corrupted indices | `save()` → `load()` round-trip |

### Historical #1187 Panic

Concurrent sync can trigger `PatchLog::migrate_actors()` mismatch when actor table ordering shifts mid-batch. nteract's pinned Automerge 0.9 desktop patch covers this, plus `transact_at_heads_recovering` for writes at captured heads. Document-level catch/rebuild/reset remains as containment.

## Adding a New Sync Stream

1. **Allocate frame type** in `notebook-wire`
2. **Choose ownership pattern:**
   - SharedDocState pattern (notebook, runtime-state): doc + peer_state in `SharedDocState`, managed by `sync_task.rs`
   - Separate ownership (pool-state): frontend owns sync state; daemon carries peer state in peer loop
3. **Add document-owned recovery helpers** (receive + generate with panic capture, rebuild, peer state reset)
4. **Add rebuild function** (save→load→reset pattern)
5. **Update biased select loop** or relevant frame handler
6. **Consider subscription scope** — every peer or specific consumers?
7. **Test with concurrent mutation** — actor/heads bugs only manifest under concurrent sync

## Invariants

- Each remote peer gets its own `sync::State` — sharing causes duplicate/missing sends
- `generate_sync_message()` returning `None` after local mutations is correct (in-flight suppression)
- Keep the frame reader draining — use waiters, not blocking waits
- Lock scope drops before `.await` — compute inside lock, send outside
- Reset sync state on transport breaks (reconnect, panic), not on local mutations
- Cell-count guard prevents silent cell loss during rebuild
- Actor table is sorted lexicographically — disagreement corrupts OpIds

## Decision Framework

| Situation | Action |
|-----------|--------|
| Transport disconnect | Reset `sync::State` (new or encode/decode) |
| Automerge panic caught | Rebuild doc (save/load), reset sync::State |
| Local mutation | Let next `generate_sync_message` handle it |
| Check if peer has changes | `change_graph.has_change(&hash)` — O(1) |
| Document at earlier point | `fork_at(heads)` — expensive, views only |
| Async notebook write at captured heads | `transact_at_heads_recovering()` |
| Concurrent async fork | `fork_with_actor()` with unique actor |
| Shrink document bytes | `save()` compacts; no history GC available |
| Daemon must see edits before executing | `required_heads` (not confirm_sync) |
| Adding a new sync stream | New frame type + sync::State + recovery helper |
| Should this block client or daemon? | Prefer daemon-side waits (required_heads) |
| Should protocol logic be async? | Consider sans-IO for testability (samod pattern) |
