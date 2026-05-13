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

Order of operations in the reaper, per room:

1. Snapshot the room's `Arc<NotebookRoom>` and UUID.
2. Acquire `notebook_rooms.lock()`. Re-check `active_peers == 0` and `last_kernel_torn_down_at != 0` and `last_kernel_torn_down_at < now - TTL` (or this room is the LRU victim in the count-cap path). If a peer raced in, abandon the sweep for this room.
3. Remove from `notebook_rooms`. Drop the rooms lock.
4. Remove from `path_index` by UUID (`remove_by_uuid`).
5. Force-flush persist debouncer via `flush_request_tx`, with timeout + retry on failure. Match the pattern in `peer_eviction.rs`: prefer leak over data loss.
6. `shutdown_autosave_debouncer(room, notebook_id, AUTOSAVE_TIMEOUT)` - sends final-save request and waits for ack.
7. `room.file_binding.shutdown_notebook_watcher()` - fire-and-forget oneshot.
8. `room.file_binding.shutdown_project_file_watcher()` - fire-and-forget oneshot.
9. For file-backed rooms: delete `room.identity.persist_path` (the .automerge). For untitled non-ephemeral rooms: leave it.
10. Drop our Arc. The room is freed when the watcher / autosave tasks finish exiting and release their Arcs.

The watcher shutdowns return immediately; the tasks exit on their own. There is a brief window between step 7-8 and final drop where the room is unreachable through the map but still alive in memory. That is acceptable.

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
| Reap concurrent with `OpenNotebook` for the same path | Race: lookup finds room, reaper removes it | `find_room_by_path` clones the Arc under `notebook_rooms.lock()`. Reaper removes under the same lock. Whoever wins the lock wins; the loser sees the post-state and reacts accordingly. If `OpenNotebook` clones the Arc first, the room stays alive via that Arc until the connection ends. If reap wins, the next `get_or_create_room_result` creates a fresh room. |
| `SaveAs` while reaper holds a snapshot of the Arc | TOCTOU on path | Reaper uses UUID, not path, to remove from path_index (`remove_by_uuid`). Mirrors the pattern in `peer_eviction.rs`. |
| Autosave shutdown hangs | Room leaks | Timeout-and-warn. Don't force-drop while autosave still holds an Arc; just give up on this reap pass. Next pass tries again. |

The hard invariant: never remove a room from `notebook_rooms` while `active_peers > 0` or `last_kernel_torn_down_at == 0`.

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
| 9 | Pure unit test on reaper selection logic | Given a set of (UUID, last_kernel_torn_down_at, active_peers) tuples and a count cap, produce the eviction set. No I/O. |

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
