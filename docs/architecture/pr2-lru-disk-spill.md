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

The reaper drops the in-memory NotebookDoc and RuntimeStateDoc. The `.automerge` file is kept for non-ephemeral untitled rooms (it's the only resume path) and **deleted** for file-backed rooms - the `.ipynb` is the source of truth, and the .automerge accumulates state that should not be replayed onto the canonical file. This matches `new_fresh_with_trusted_packages`'s existing behavior, which deletes the persist file when `path.is_some()` and creates a fresh doc.

Deleting the file is constrained by the debouncer: `spawn_persist_debouncer` writes the latest bytes when `flush_rx` closes (all senders dropped) and again when `persist_rx.changed()` returns `Err`. If the reaper deletes before those tasks have exited, the task immediately rewrites the file we just removed. The reaper therefore (a) needs a way to take ownership of the persist channels and drop them deterministically, then (b) wait for the task to exit before unlinking the file. The current `RoomPersistence::debouncer` is a plain `Option`; the implementation will turn it into `Mutex<Option<...>>` so the reaper can `.take()` the channels. This is the followup `finalize_untitled_promotion` already calls out.

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

Order of operations in the reaper, per room. The ordering is constrained by three failure modes worth calling out:

- **Removing from `notebook_rooms` before the persist flush succeeds** would land a reconnecting peer in the window between map removal and final write, creating a fresh room from stale or missing `.automerge` bytes. The existing `peer_eviction.rs` deliberately flushes-then-removes for exactly this reason.
- **Removing from `notebook_rooms` before `path_index`** opens the path-index race: `find_room_by_path` reads `path_index` first, then dereferences in `notebook_rooms`. A reaper that clears the rooms map but not the index leaves a dangling UUID; the racing opener creates a new room and then fails `path_index.insert` with `PathAlreadyOpen`, orphaning the new room from path lookup.
- **Deleting `room.identity.persist_path` before the persist debouncer task has exited** would let the task immediately rewrite the `.automerge` we just removed: `spawn_persist_debouncer` flushes pending bytes on `flush_rx` closure (all senders dropped) and again on `persist_rx.changed()` returning `Err`. Wait for the task to actually exit.

The sequence:

1. Snapshot the room's `Arc<NotebookRoom>` and UUID.
2. Force-flush the persist debouncer via `flush_request_tx`, with timeout + retry. On failure, abandon this pass; the room stays in `notebook_rooms` and we try again next tick. Prefer leak over data loss. (Matches `peer_eviction.rs`.)
3. Acquire `notebook_rooms.lock()`. Re-check `active_peers == 0` and `last_kernel_torn_down_at != 0` and the LRU / TTL predicate. If a peer raced in, drop the lock and return.
4. **Under the rooms lock**, also acquire `path_index.lock()` and `remove_by_uuid` the room's UUID. Then `notebook_rooms.remove(uuid)`. Release both locks. This serializes the path/UUID transition: any `find_room_by_path` either sees both entries or neither.
5. `shutdown_autosave_debouncer(room, notebook_id, AUTOSAVE_TIMEOUT)` - sends final-save request and waits for ack. Releases the autosave task's `Arc<NotebookRoom>`.
6. `room.file_binding.shutdown_notebook_watcher()` - fire-and-forget oneshot; the watcher task drops its `Arc` on receipt.
7. `room.file_binding.shutdown_project_file_watcher()` - fire-and-forget oneshot.
8. Take the `Option<PersistDebouncer>` out of `room.persistence.debouncer` (requires changing the field to `Mutex<Option<...>>` or `OnceLock<Option<...>>`; see `finalize_untitled_promotion`'s TODO note). Dropping the `watch::Sender` closes `persist_rx`; dropping the `mpsc::Sender<FlushRequest>` closes `flush_rx`. Wait for the task to exit. Easiest implementation: send a sentinel oneshot through `flush_rx` whose `do_persist` is the final write, then await its ack. Or wrap the debouncer with an `await`-able join handle.
9. For file-backed rooms: delete `room.identity.persist_path`. Safe now that the debouncer is gone. For untitled non-ephemeral rooms: leave the file in place; it's the only resume path.
10. Drop our `Arc`. With the autosave / watcher / debouncer tasks gone, the last `Arc` is ours; the room is freed.

Steps 5-7 each return after their owning task confirms exit (or times out). Step 8 is the new piece - the persist debouncer needs an explicit shutdown handle that the current code does not have. Closing the watch sender alone exits the task, but doesn't tell us when; we want the wait so step 9 is safe. The simplest implementation is to send a final flush request, ack it, then drop the senders.

If any of steps 5-8 time out, abandon the reap for this room and log; we already removed it from the maps in step 4. Reaper's correctness invariant becomes "if it's not in `notebook_rooms`, the live tasks are best-effort being torn down." A leaked room with no map entry is a memory bug; a leaked file with no live writer is harmless and eventually cleaned by the orphan-doc sweep.

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
| Reap candidate selected; peer reconnects mid-sweep | Two rooms for one path | Re-check `active_peers == 0` under `notebook_rooms.lock()` before removing. PR 1's `clear_kernel_torn_down()` on reconnect zeroes the LRU key, so future sweeps skip this room. |
| Reap concurrent with PR 1's kernel-teardown task | Double cleanup, double final-save | Reaper skips rooms with `last_kernel_torn_down_at == 0` (kernel-teardown not yet finished). Kernel teardown stamps the timestamp at the end. |
| Reap concurrent with `OpenNotebook` for the same path | Stale `path_index` entry orphans the new room | `find_room_by_path` reads `path_index` first, then dereferences in `notebook_rooms`. If the reaper splits those removals across two locks, a racing open can see a UUID in the index that no longer maps to a live room. Resolution: the reap step that removes from `notebook_rooms` and from `path_index` takes **both locks** in a fixed order (rooms then path_index) and releases together. Any racing open either sees both entries or neither. |
| `SaveAs` while reaper holds a snapshot of the Arc | TOCTOU on path | Reaper uses UUID, not path, to remove from `path_index` (`remove_by_uuid`). Mirrors the pattern in `peer_eviction.rs`. |
| Persist debouncer flush fails (timeout / write error) | Data loss if removed from map | Reap aborts before touching `notebook_rooms` or `path_index`. Room stays resident; next pass retries. |
| Persist file recreated after delete | Stale `.automerge` survives the reap | Step 8 of the reap waits for the persist debouncer task to actually exit before step 9 deletes the file. Required because `spawn_persist_debouncer` flushes pending bytes both on `flush_rx` closure and on `persist_rx.changed()` returning `Err`. |
| Autosave shutdown hangs | Watcher task pins room indefinitely | Timeout-and-warn. The room is already out of the maps (step 4 already happened); a leak past timeout is a memory bug but not a correctness one. Log and continue. Next pass cannot retry this room because it is no longer in the map; this is the price of the flush-first ordering. |

The hard invariants:

- Never remove a room from `notebook_rooms` while `active_peers > 0` or `last_kernel_torn_down_at == 0`.
- Never remove from `notebook_rooms` without also removing from `path_index` in the same critical section (or vice versa). They are joined indices.
- Never delete `room.identity.persist_path` before the persist debouncer task has exited.

## Code that gets simplified or replaced

Nothing from PR 1 is removed. PR 1 sets up `last_kernel_torn_down_at`; PR 2 reads it. PR 1's kernel-teardown task does not remove the room from any map; PR 2's reaper is the only code path that does.

The existing 24h orphan-doc sweep in `env_gc_loop` (`daemon.rs` around line 3766) walks `notebook_docs_dir/` and deletes `.automerge` files that don't correspond to any room in `notebook_rooms` AND are older than 24h. After PR 2:

- Spilled untitled rooms have a `.automerge` on disk with no live room. The orphan sweep would delete it after 24h. That's wrong if the reaper TTL is also 24h - we'd be relying on the reaper firing first.
- Fix: the reaper deletes the `.automerge` itself for file-backed rooms (where the .ipynb is the truth). For untitled, the reaper keeps the file; the orphan sweep eventually claims it once it ages past its own (longer) TTL.
- Raise the orphan-sweep floor to 7 days. The reaper handles the 24h window; the orphan sweep becomes a long-tail safety net.

This is the only existing code that changes semantics. No removals.

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
| 9 | Reap deletes the file-backed `.automerge` and does not let it come back | After reap finishes, the persist path does not exist and is not recreated within a generous (1s+) settle window. Catches a regression where the persist task flushes after the file was deleted. |
| 10 | `find_room_by_path` never sees a half-removed pair | Drive a `find_room_by_path` lookup concurrently with a reap. Across many iterations, every lookup either returns the live room or returns `None` (and the subsequent `path_index.insert` of a new UUID succeeds). No `PathIndexError::PathAlreadyOpen` leakage. |
| 11 | Flush failure aborts the reap | Inject a persist-debouncer that always fails the flush. Reap pass leaves `notebook_rooms` and `path_index` untouched. Room is still findable on the next lookup. |
| 12 | Pure unit test on reaper selection logic | Given a set of (UUID, last_kernel_torn_down_at, active_peers) tuples and a count cap, produce the eviction set. No I/O. |

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
