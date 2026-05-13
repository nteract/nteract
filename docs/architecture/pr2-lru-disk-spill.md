# PR 2: LRU reaper for resumable rooms

PR 1 keeps a `NotebookRoom` resident after the kernel is torn down so a returning user reattaches to the same doc, outputs, and file binding. The kernel goes away, the room stays. PR 1 also added a `last_kernel_torn_down_at` timestamp on `RoomConnections`. PR 1 did not implement the reaper that eventually removes these rooms. That is this PR.

This document is the plan. The implementation PR follows.

## Diagnosis

Today's eviction model (pre-PR-1) tore the room down 30s after the last peer left. That cost users their outputs and their in-memory doc state on every disconnect, even brief ones. PR 1 fixed the user-visible part of that. It does not bound memory.

Without a reaper, a long-running daemon accumulates `NotebookRoom` instances for every notebook the user has ever opened. The persist debouncer mirrors the `NotebookDoc` to disk, but the in-memory `Arc<NotebookRoom>` and its `RuntimeStateDoc` are not bounded. A user who opens 30 notebooks over a day pays 30 rooms worth of memory until the daemon restarts.

PR 2's job is the reaper: a background sweep that removes peer-less rooms once they have been peer-less long enough that resume is unlikely, capped at a maximum count.

The relationship to "disk spill" is subtle. The .automerge file is already on disk for non-ephemeral rooms - the persist debouncer mirrors NotebookDoc bytes there on a 500ms / 5s schedule. PR 1 ensures the file is flushed at kernel teardown. So spill-to-disk is not new work. The new work is forgetting about the resident in-memory copy.

## What is in memory per room

| Field | Cost |
|------|------|
| `id: Uuid` | 16 bytes |
| `doc: Arc<RwLock<NotebookDoc>>` | Automerge doc with cell source, structure, metadata. Saved size scales with edit history. |
| `state: RuntimeStateHandle` (RuntimeStateDoc) | Automerge doc with queue, executions (capped at 64 via `trim_executions`), outputs as inline manifests with blob refs, env, trust. `compact_if_oversized` threshold is 80 MiB; that is the upper bound after compaction. |
| `broadcasts` | Four broadcast channels (16-64 deep) and a PresenceState. Tiny when peer-less. |
| `persistence` | Persist debouncer handles. The debouncer task holds the latest serialized NotebookDoc bytes in its watch channel, so the doc effectively lives twice while resident. |
| `file_binding` | Path, ephemeral flag, three shutdown senders for watcher / autosave / project-watcher tasks. |
| `blob_store: Arc<BlobStore>` | Shared across rooms. Not counted per-room. |
| `trust_state`, `trusted_packages` | Small. |
| `runtime_agent_*` | `None` once the kernel is torn down. |
| Persist debouncer task | Owns serialized NotebookDoc bytes in its watch channel. |
| Autosave debouncer task | Owns an `Arc<NotebookRoom>`. Pins the whole room until shut down. |
| `.ipynb` file watcher task | Owns an `Arc<NotebookRoom>`. |
| Project-file watcher task | Owns an `Arc<NotebookRoom>` when armed. |

The two movers are the two Automerge docs. Estimates:

| Profile | NotebookDoc in-memory | RuntimeStateDoc in-memory | Per-room total |
|---|---|---|---|
| Small (3-5 cells, no history) | ~50-100 KiB | <50 KiB | ~200 KiB |
| Medium (20-30 cells, some executions) | ~200-500 KiB | ~200-500 KiB | ~1 MiB |
| Large (100+ cells, widgets, long history) | ~1-3 MiB | ~2-10 MiB | ~3-13 MiB |
| Pathological (uncompacted, long session) | up to 80 MiB | up to 80 MiB | ~160 MiB |

These are estimates from code reading, not measurements. The repo has no benchmark fixture for room footprint. **Open question:** add a benchmark before tuning the cap. For an initial cap of 64 medium rooms, expected residency is ~64 MiB. At the pathological end, 64 rooms is 10 GiB; the byte budget below catches that.

## Reaper triggers

Three options:

**(A) Pure LRU on room count.** Hard cap on count of resident peer-less rooms; evict oldest when over.

**(B) Memory-pressure-driven.** Periodically poll RSS or sum saved bytes; evict to fit a budget.

**(C) Combined.** Hard count cap + soft byte budget. Active rooms (peers > 0) exempt from both.

Recommend (C), but in two phases:

- **PR 2:** ship (A) with a count cap. The reaper uses `last_kernel_torn_down_at` (from PR 1) as the LRU key. Live rooms (timestamp = 0) are exempt.
- **Follow-up:** add a byte budget once we have measurements that justify a specific number. Cheap proxy: stash the last persisted byte length on `RoomPersistence` (the debouncer already serialized it). At sweep time, sum those across peer-less rooms.

`doc.save()` is not free. Do not call it on every tick. The persisted-byte-length proxy avoids that.

Initial constants for PR 2:

- `MAX_RESIDENT_PEERLESS_ROOMS = 32` (conservative; raise after benchmarking).
- `RESIDENT_ROOM_TTL = 24h` (matches the existing orphan-doc sweep window; means rooms only get evicted by count pressure within a day).
- `REAPER_INTERVAL = 5min` (cheap sweep, not on the hot path).

These are all `Daemon` config knobs with defaults, overridable in tests.

## What disk spill means concretely

PR 2 does not introduce a new on-disk format. NotebookDoc is already mirrored to `notebook_docs_dir/<sha256(uuid)>.automerge` by the persist debouncer for every non-ephemeral room. PR 1's kernel-teardown flush guarantees the file is current. So when the reaper sweeps a room:

1. NotebookDoc bytes are already on disk.
2. RuntimeStateDoc has no disk representation. The cell-level outputs that matter live in the `.ipynb` (autosaved by PR 1's preserved autosave task). On resume, `load_notebook_from_disk_with_state_doc_and_execution_store` rebuilds outputs from the `.ipynb` for file-backed rooms. Untitled rooms lose live execution state on reap; cell source survives via `.automerge`.

The reaper drops the in-memory `NotebookDoc` and `RuntimeStateDoc`. The `.automerge` file on disk is **kept** for both file-backed and non-ephemeral untitled rooms. Two reasons:

- For file-backed rooms, the `.ipynb` does not by itself carry every blob reference that the room held. Arrow-stream manifests (DX parquet outputs) store sub-blob hashes that the blob GC's existing `collect_blob_refs_for_gc` finds by walking active rooms plus `notebook-docs/*.automerge` files. Deleting the `.automerge` would let the next blob GC pass sweep those sub-blobs, breaking reload of Arrow outputs (the `.ipynb` keeps the manifest hash but the blob is gone).
- For untitled rooms, the `.automerge` is the only resume path; cell source survives nowhere else.

The existing 24h orphan-doc sweep already prunes `.automerge` files for rooms not in `notebook_rooms`. We raise that floor to 7 days, leaving plenty of overlap with the blob GC's 30-day grace. A follow-up PR can teach blob GC to walk `.ipynb` files for Arrow-stream manifest refs; once it does, the reaper can delete the file-backed `.automerge` for tighter disk cleanup. Out of scope here.

Implications:

- **No persist-file unlinking in the reap path.** The persist debouncer task is still shut down so the in-memory Arc-pinning ends, but the file stays.
- **The persist debouncer takeover** (closing the channels and waiting for task exit) is needed for the in-memory cleanup but does not touch the file. Order it as the last cleanup step so an aborted reap does not need to recreate the debouncer.

## Reload path

Today's reload for file-backed:

```
OpenNotebook(path)
  -> canonicalize(path)
  -> find_room_by_path -> None (room was reaped)
  -> get_or_create_room_result(new_uuid, path)
       -> NotebookRoom::new_fresh_with_trusted_packages
            -> path.is_some(): delete stale .automerge, NotebookDoc::new
       -> insert into rooms map + path_index
       -> bind_existing(canonical) -> spawn watcher + autosave
  -> stream-load from .ipynb (load_notebook_from_disk_*)
```

This is the same path as today's "first open." The room gets a new UUID. Outputs come back from the .ipynb. Trust gets re-verified. Project context re-detected.

For untitled (path = None, uuid stable):

```
CreateNotebook(notebook_id = existing_uuid)
  -> get_or_create_room_result(existing_uuid, path=None)
       -> NotebookRoom::new_fresh_with_trusted_packages
            -> path.is_none() AND persist_path.exists(): NotebookDoc::load_or_create_with_actor
       -> insert into rooms map
       -> no path_index insert
  -> no streaming load needed; doc already populated
```

This already works in the current code. The reaper just has to leave the `.automerge` in place for untitled rooms.

Differences from today's fresh-open:

| Aspect | Fresh open | Reload after reap |
|--------|------------|-------------------|
| UUID identity (file-backed) | new | new |
| UUID identity (untitled) | new | reused via persist file |
| NotebookDoc bytes | empty until stream load | empty for file-backed (streamed); loaded from .automerge for untitled |
| RuntimeStateDoc | empty | empty |
| Outputs | reconstructed from .ipynb | reconstructed from .ipynb |
| Trust | verified from .ipynb / doc | same |
| Path index | created on insert | created on insert |
| Kernel | not running | not running |
| Watcher / autosave | spawned via `bind_existing` | spawned via `bind_existing` |

No new code paths. Reap + reload is structurally identical to "close then reopen."

## Interaction with PR 1

PR 1 leaves these alive on a peer-less room with kernel torn down:

- The `NotebookRoom` in `notebook_rooms`.
- The path_index entry.
- The persist debouncer task.
- The autosave debouncer task.
- The `.ipynb` file watcher (when applicable).
- The project-file watcher (when armed).

Autosave, file watcher, and project-file watcher own `Arc<NotebookRoom>`. They pin the room. PR 2's reaper must explicitly shut them down before the last Arc can drop.

Order of operations in the reaper, per room. The ordering is constrained by five failure modes:

- **Removing from `notebook_rooms` before the persist flush succeeds** lands a reconnecting peer in the window between map removal and final write. `peer_eviction.rs` flushes-then-removes for this reason.
- **Removing from `notebook_rooms` before `path_index` (or vice versa) under separate locks** opens the path-index race: `find_room_by_path` reads `path_index` first, then dereferences in `notebook_rooms`. A reaper that splits the removals can leave a dangling UUID; the racing opener mints a new UUID and then fails `path_index.insert` with `PathAlreadyOpen`.
- **Removing from the maps before cleanup tasks confirm exit** makes a hung autosave / watcher / debouncer invisible to the reaper. Retry by finding it in the map becomes impossible, so cleanup timeouts permanently leak resident rooms - the exact failure this PR is bounding.
- **Reservation gap on reconnect.** A reconnect path clones `Arc<NotebookRoom>` via `find_room_by_path` before it ever increments `active_peers` (the handshake does metadata seeding, trust checks, etc. between the clone and the `fetch_add`). A reaper that checks only `active_peers == 0` misses that in-flight reconnect, removes the registry entry, and leaves the new client talking to a cleaned-up, unindexed room. The reservation must happen at the moment the Arc is cloned, not at the end of the handshake.
- **Taking ownership of the persist debouncer destructively before commit is guaranteed** leaves an aborted reap with a room that has no persist debouncer. The reconnect path's `bind_existing` does not respawn the debouncer; only the initial room creation does.

The corollary is that map removal must be the **last** step, after every Arc-pinning task has confirmed exit, and any destructive takeover (debouncer) must happen after commit is irreversible. Cleanup happens with the room still in the registry. A peer reconnecting mid-cleanup aborts the pass; that's fine because nothing externally visible has changed.

**Combined registry.** `notebook_rooms` and `path_index` are currently behind separate `tokio::sync::Mutex`es. Holding both across one critical section requires nested `.lock().await` calls, which violates the load-bearing tokio-mutex invariant. Implementation introduces a `RoomRegistry` that owns both inside a single `tokio::sync::Mutex`, with sync helper methods for joined operations. All callers (catalog, peer_eviction, daemon handshakes) move to the new API. Joined-indices fix and mutex-invariant fix in one.

**Reservation token.** Add `RoomConnections.reservations: AtomicUsize`, bumped at the moment `find_room_by_path` / `get_or_create_room_result` hands an `Arc<NotebookRoom>` to a connection path, decremented when that path resolves into a real `active_peers` increment (handshake done) or aborts. The reaper's "is this room a reap candidate" predicate becomes `active_peers == 0 AND reservations == 0 AND last_kernel_torn_down_at != 0 AND ...`. The reservation is the atomic counterpart to the connection clone.

The sequence:

1. Under the registry lock, identify a reap candidate. Re-check `active_peers == 0 AND reservations == 0 AND last_kernel_torn_down_at != 0` plus the LRU / TTL predicate. Snapshot the Arc, drop the registry lock.
2. Force-flush the persist debouncer via `flush_request_tx`, with timeout + retry. On failure, abandon the pass. The debouncer keeps running afterwards (we only requested a flush).
3. `shutdown_autosave_debouncer(room, notebook_id, AUTOSAVE_TIMEOUT)` - sends final-save request and waits for ack. Releases the autosave task's `Arc<NotebookRoom>` on success. On timeout, abandon.
4. `room.file_binding.shutdown_notebook_watcher()` - fire-and-forget oneshot; watcher task drops its `Arc` on receipt. Add an ack to wait for actual exit; alternatively, poll task-supervisor counters with a timeout.
5. `room.file_binding.shutdown_project_file_watcher()` - same.
6. Under the registry lock: re-check `active_peers == 0 AND reservations == 0`. If a reconnect raced in during cleanup, abandon and warn (cleanup already torn down autosave / watchers; the reconnect's `bind_existing` re-arms them). If clear, remove from both indices in one sync block. Drop the lock. **This is the commit point.**
7. Now (and only now) take the `Option<PersistDebouncer>` out of `room.persistence.debouncer` (requires the field to become `Mutex<Option<...>>`; see `finalize_untitled_promotion`'s TODO note). Drop both senders. Wait for the debouncer task to exit. The debouncer's `flush_rx` closure flush and `persist_rx` closure flush write the latest bytes one last time; that's harmless because the file stays on disk for the orphan-doc sweep.
8. Drop our `Arc`. With every pinning task gone, the room is freed.

Trade-offs:

- Step 6's racing-reconnect-aborts-after-cleanup case leaves the room with no autosave or watchers but still in the registry. The reconnect's `bind_existing` must respawn them. The current `bind_existing` does spawn both; verify in the implementation that calling it on a room with `watcher_shutdown_tx = None` is safe.
- The persist debouncer is never torn down on aborted reap because step 7 runs after commit. Reconnect therefore inherits a working debouncer.
- The file stays on disk through reap. The orphan-doc sweep (7d) handles disk cleanup later.

## Path index lifecycle

Two options:

**(1) Drop on reap.** `path_index` entry goes away when the room is reaped. Reload mints a new UUID via the normal `OpenNotebook(path)` flow.

**(2) Keep, mark spilled.** `path_index` entry stays; lookup signals "spilled, please resurrect." Reload preserves the UUID.

Recommend (1). For file-backed notebooks, the path is the stable external identifier; the UUID is daemon-internal. The MCP proxy already reconnects file-backed rooms via path (`connect_open(path)`), not UUID. Frontends use the room UUID only for the lifetime of a single connection. UUID churn on a reload-after-reap is fine.

For untitled rooms, they never live in path_index, so this doesn't apply. UUID stability comes free via the `.automerge` file being keyed by `sha256(uuid)`.

## Concurrency

The reaper runs on a periodic tick. Concurrent flows worth enumerating:

| Scenario | Risk | Resolution |
|----------|------|-----------|
| Reap candidate; peer reconnects mid-sweep | Two rooms for one path | Reaper commits map removal only after cleanup confirms. The commit-time recheck (`active_peers == 0 AND reservations == 0`) catches a racing reconnect even if it hasn't yet incremented `active_peers`. |
| Reservation gap: reconnect has cloned Arc but not yet incremented `active_peers` | Reaper removes registry entry while client continues on unmapped room | Connection paths bump `reservations` at the moment `find_room_by_path` / `get_or_create_room_result` hands them the Arc. Decrement when handshake finishes (success or failure). Reaper predicate includes `reservations == 0`. |
| Reap concurrent with PR 1's kernel-teardown task | Double cleanup | Reaper skips rooms with `last_kernel_torn_down_at == 0`. PR 1 stamps the timestamp at the end of teardown. |
| Reap concurrent with `OpenNotebook` for the same path | Stale `path_index` orphans the new room | Combined `RoomRegistry` holds both indices behind one tokio `Mutex`. Joined removal in one sync block. |
| Reap holds rooms lock across path_index lock | Lint failure / convoy deadlock | Joined registry has a single lock; no nested `.await`-on-lock pattern. |
| `SaveAs` while reaper has cloned the Arc | TOCTOU on path | Reaper uses UUID, not path. Mirrors `peer_eviction.rs`. |
| Persist debouncer flush fails (timeout / write error) | Data loss if removed from map | Reap aborts before any map removal. Room stays in registry; next pass retries. |
| Autosave / watcher shutdown hangs | Indefinite leak invisible to the reaper | Map removal deferred until cleanup confirms. On timeout, abandon. Room stays in registry; next reaper tick re-evaluates. Partial teardown is restartable via `bind_existing` on a racing reconnect. |
| Aborted reap leaves debouncer torn down | Future autosave / persist breaks for the reconnected client | Destructive debouncer takeover (step 7) runs **after** commit, so an abort never touches the debouncer. The reconnect inherits a fully-working room. |
| Daemon shutdown mid-reap | Half-cleaned room at exit | Existing global-shutdown signal already triggers debouncer / autosave final flushes via channel close. Reaper task uses `spawn_best_effort` so it is dropped on shutdown without holding cleanup. |
| Arrow-stream blob refs after `.automerge` deletion | `.ipynb` reload fails on parquet outputs | Reap does **not** delete the `.automerge`. Existing blob GC walks `.automerge` files to mark Arrow sub-blob refs. Orphan-doc sweep handles disk cleanup later (raised floor 7d). Tighter cleanup requires a future PR that teaches blob GC to walk `.ipynb` files. |

The hard invariants:

- Never remove from the registry while `active_peers > 0`, `reservations > 0`, `last_kernel_torn_down_at == 0`, or any pinning task is still running.
- Removal from `notebook_rooms` and `path_index` is one sync block under the registry's tokio mutex.
- Destructive debouncer takeover only happens after the commit point; aborted reaps must leave the room fully functional.
- Cleanup that has begun and then been aborted (because a reconnect raced in) must be safely restartable. `bind_existing` is the re-arm path for watchers and autosave; the debouncer is never torn down on aborted reap.
- Reap never deletes the `.automerge` file; the orphan-doc sweep is the only path that does.

## Code that gets simplified or replaced

Nothing from PR 1 is removed. PR 1 sets up `last_kernel_torn_down_at`; PR 2 reads it. PR 1's kernel-teardown task does not remove the room from any map; PR 2's reaper is the only code path that does.

**Combined `RoomRegistry`.** Today's `NotebookRooms` (`Arc<Mutex<HashMap<Uuid, Arc<NotebookRoom>>>>`) and `Arc<Mutex<PathIndex>>` are split. PR 2 unifies them so joined operations don't need nested locks. Catalog, peer_eviction, and daemon handshake code paths move to the new API. Public surface stays similar - `find_room_by_path`, `get_or_create_room_result` remain, just rerouted through the new owner.

**Reservation counter.** `RoomConnections` gains a `reservations: AtomicUsize`. Bumped by connection paths the moment they receive an Arc from the registry; decremented when the handshake either reaches `active_peers.fetch_add(1)` or aborts. Reaper predicate includes `reservations == 0`. A small new contract for everyone who clones an Arc from the registry: take a `ReservationGuard` that increments on construction and decrements on drop. `find_room_by_path` and `get_or_create_room_result` return `(Arc<NotebookRoom>, ReservationGuard)`; the guard is held until the handshake commits or aborts.

**`RoomPersistence::debouncer` becomes `Mutex<Option<PersistDebouncer>>`** so the reaper can `.take()` the channels at commit time. See the existing TODO in `finalize_untitled_promotion`.

**Orphan-doc sweep window.** The existing 24h orphan-doc sweep in `env_gc_loop` (`daemon.rs` around line 3766) walks `notebook_docs_dir/` and deletes `.automerge` files that don't correspond to any room in `notebook_rooms` AND are older than 24h. After PR 2:

- Spilled untitled rooms have a `.automerge` on disk with no live room. The orphan sweep would delete it after 24h. That overlaps with the reaper's TTL.
- Fix: the reaper deletes the `.automerge` itself for file-backed rooms (the .ipynb is the truth). For untitled, the reaper keeps the file; the orphan sweep eventually claims it after a longer TTL.
- Raise the orphan-sweep floor to 7 days. Reaper handles the 24h window; orphan sweep becomes the long-tail safety net.

No outright removals.

## Test plan

Integration tests live in `crates/runtimed/src/notebook_sync_server/tests.rs`. Reaper-specific tests should drive the reaper with explicit test hooks (e.g. `daemon.force_reaper_pass().await`) rather than waiting for the 5-minute tick.

| # | Test | What it proves |
|---|------|----------------|
| 1 | Spill-then-reconnect file-backed preserves outputs | Open notebook, run a cell, disconnect, wait past kernel-teardown delay, force a reap pass with TTL 0, reconnect via path. Outputs come back from .ipynb. |
| 2 | Spill-then-reconnect untitled preserves cells | Create untitled, add cells, disconnect, reap with TTL 0. Reconnect via UUID; cells load from .automerge. |
| 3 | LRU count cap evicts oldest peer-less room | Set cap = 4. Open 5 notebooks, disconnect all in order. Force reap. One is removed, the four most-recent stay. |
| 4 | Active rooms exempt from cap | Set cap = 2. Open 3 notebooks, keep all 3 connected. Force reap. All 3 still resident. |
| 5 | Concurrent reconnect during reap aborts reap for that room | Reap candidate identified; reconnect arrives; reap re-checks and abandons; room remains. |
| 6 | Reap shuts down autosave + watchers | After reap, the previously-resident room's tasks are no longer running. Asserted via task-supervisor counters or tracing capture. |
| 7 | Reap-then-orphan-sweep does not double-delete | Reap deletes .automerge for file-backed room. Orphan sweep runs; no error, no double-delete. |
| 8 | Untitled `.automerge` survives reap | Reap an untitled room. The .automerge persists. A subsequent CreateNotebook with the same UUID resurrects content. |
| 9 | File-backed `.automerge` survives reap | After reap, the `.automerge` is still on disk. The blob GC's persisted-doc walk still finds Arrow-stream sub-blob refs. |
| 10 | `find_room_by_path` never sees a half-removed pair | Drive a `find_room_by_path` lookup concurrently with a reap. Across many iterations, every lookup either returns the live room or returns `None` (and the subsequent `path_index.insert` of a new UUID succeeds). No `PathIndexError::PathAlreadyOpen` leakage. |
| 11 | Reservation token blocks the reap | Connection path bumps `reservations` but pauses before incrementing `active_peers` (test hook in handshake). Reaper sees `active_peers == 0` but `reservations > 0` and skips. Handshake completes; `reservations` decrements; `active_peers` is now 1. |
| 12 | Flush failure aborts the reap | Inject a persist-debouncer that always fails the flush. Reap pass leaves `notebook_rooms` and `path_index` untouched. Room is still findable on the next lookup. |
| 13 | Reconnect mid-cleanup restarts autosave + watchers | Open notebook, reap starts, autosave shutdown completes, then a peer reconnects before the reaper takes the registry lock. Reaper abandons the pass. Reconnect calls `bind_existing` which respawns autosave and the file watcher. The room is healthy and the persist debouncer is still running. |
| 14 | Aborted reap preserves the persist debouncer | Force step 6 to abort (reservation appears). Verify `room.persistence.debouncer.is_some()` after the abort. Subsequent edits still get persisted. |
| 15 | Pure unit test on reaper selection logic | Given a set of (UUID, last_kernel_torn_down_at, active_peers, reservations) tuples and a count cap, produce the eviction set. No I/O. |

Plus stress: a soak test that opens, runs, and disconnects N notebooks in a loop, asserts resident-room count stays bounded.

## Out of scope

Pushed to PR 3 or beyond:

- Memory-pressure-driven eviction (byte budget). PR 2 is count-only. Add a byte budget after benchmarking justifies a number.
- Tiered storage (warm vs cold rooms with different residency rules). Single bucket.
- Persisting `RuntimeStateDoc` to disk. Dropped on reap; rebuilt from `.ipynb` on reload. The cost-benefit isn't there until we hit a use case where execution counts and history matter post-reap.
- Caller-visible "this room was spilled" signal. Callers re-open via path and don't notice.
- Per-room weight (heavy notebooks count as more than 1 unit). All rooms count as 1 for the cap.
- Multi-daemon coordination. Reaper is per-daemon.
- A `runt daemon status` field exposing reaper stats (resident_rooms, reaped_today). Useful for measurements; small enough to land alongside PR 2 if there's room.

## Open questions

- Initial cap value: 32 is conservative. Without a benchmark, the real ceiling could be higher. Land 32, expose via config, raise after observation.
- Should the reaper deduct one slot per "ghost" room (peer-less, no kernel) or count all rooms toward the cap? Recommend: cap applies only to peer-less rooms. Active rooms can exceed the cap because they're load-bearing.
- Should the reaper integrate with the env GC loop or run as its own task? Recommend its own task on a 5min tick. Decoupled from the 30min env GC.
- Telemetry: do we want a Prometheus-style counter (`runtimed_room_reaps_total`)? Not yet. Logs are enough for v1.

## References

PR 1 (parallel): keeps rooms resident after kernel teardown. Adds `last_kernel_torn_down_at`. The reaper in this PR consumes that timestamp.

Key files:

- `crates/runtimed/src/notebook_sync_server/room.rs` - `NotebookRoom`, `RoomConnections`, `RoomPersistence`, `NotebookFileBinding`
- `crates/runtimed/src/notebook_sync_server/peer_eviction.rs` - PR 1's kernel teardown task
- `crates/runtimed/src/notebook_sync_server/catalog.rs` - `get_or_create_room_result`, `find_room_by_path`
- `crates/runtimed/src/notebook_sync_server/path_index.rs` - secondary path -> UUID index
- `crates/runtimed/src/notebook_sync_server/persist.rs` - `spawn_persist_debouncer`, `spawn_autosave_debouncer`, `shutdown_autosave_debouncer`
- `crates/runtimed/src/notebook_sync_server/load.rs` - `load_notebook_from_disk_with_state_doc_and_execution_store`
- `crates/runtimed/src/daemon.rs` - `env_gc_loop`, orphan-doc sweep (lines ~3766-3804)
- `crates/runtime-doc/src/doc.rs` - `RuntimeStateDoc`, `trim_executions`, `compact_if_oversized` (80 MiB threshold)
- `crates/notebook-doc/src/lib.rs` - `NotebookDoc::load_or_create_with_actor`, `save`, `save_to_file`
