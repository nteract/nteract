# Tokio Mutex Discipline and the Concurrency-Invariant Family

**Status:** Draft, 2026-05-22.

## Context

The daemon is a multi-tenant async server. One process holds every open room, every kernel subprocess, every blob HTTP handler, and every sync stream. A single Tokio runtime drives all of it. Under load (a notebook generating multi-megabyte image output while another room is opening a kernel while a third is shutting down) the daemon's responsiveness is determined by which futures get to run when, and what each holds when it suspends.

This ADR collects the rules that keep that runtime responsive. The headline rule is the tokio-mutex-across-await ban that lives as a single paragraph in `AGENTS.md` (also available through the `CLAUDE.md` symlink) and is enforced by a CI lint. But that rule does not stand alone. It is one member of a family of concurrency invariants that all serve the same goal: no single piece of work, however large, can stall the daemon's ability to drive other work forward.

Neighbors:

- `docs/adr/typed-frame-v4-wire-protocol.md` - the framing that bounds inbound work. `FramedReader`'s actor pattern is one of the cancel-safety primitives this ADR depends on.
- `docs/adr/document-split.md` - why `NotebookDoc` and `RuntimeStateDoc` live behind `std::sync::Mutex` in `DocHandle`, not async locks.
- `docs/adr/execution-pipeline.md` - Decision 2 (control-plane vs output-plane separation) is the same problem family at the IOPub boundary. Same goal, different boundary.
- `docs/adr/blob-storage-and-content-addressing.md` - the blob store keeps large writes out of the document apply path; concurrency discipline keeps them out of the lifecycle path.
- `docs/adr/identity-and-trust.md` - connection-time authentication keeps the validator's hot path mutex-free.

Three things shaped the rules:

- **Tokio's work-stealing scheduler does not preempt suspended futures.** A future that owns an async mutex and `.await`s a long operation holds the mutex for the whole time. Other waiters park; the convoy forms. We hit this in the daemon's early days and the lint exists because the failure mode is invisible at the call site.
- **Automerge document mutations are synchronous and microsecond-fast.** They do not need an async lock. They want a `std::sync::Mutex` taken in a tight scope with no awaits inside. The async layer wraps the sync layer, never the other way around.
- **The reader half of a socket is not cancel-safe under partial reads.** `read_exact` will silently consume bytes when its future is dropped mid-read. Putting it in a busy `select!` arm corrupts the stream the moment another arm wins.

## Decision 1: Tokio async-lock guards never live across `.await`

A `tokio::sync::Mutex` guard or `tokio::sync::RwLock` read/write guard must be released before the next `.await` in the same scope. The lint accepts three shapes of compliance: leaving the guard's enclosing block, an explicit `drop(guard)` before the await, or shadowing the guard's binding. Project style prefers the block-scope shape for review-clarity reasons (see below), but all three structurally satisfy the lint.

```rust
// OK - guard dropped at end of block, await happens after
let value = {
    let guard = handle.lock().await;
    guard.cloned_state()
};
some_future(value).await;
```

```rust
// BAD - guard lives across the await, convoy deadlock risk
let guard = handle.lock().await;
let value = guard.cloned_state();
some_future(value).await;
```

### Why convoy, not just deadlock

The classic textbook failure mode is mutual deadlock: task A holds lock X and awaits lock Y; task B holds Y and awaits X. That can happen, but it is rare in practice because the daemon's lock graph is thin.

The common failure mode is the **single-lock convoy**. Task A acquires lock X, then awaits an unrelated long operation (a `uv` install, a kernel response, a blob upload, a sync round-trip). Tasks B, C, D, E all need to take X briefly. They park behind A. The runtime is otherwise idle. The daemon stops responding to ping. From the outside it looks like a hang.

The mutex itself never deadlocks. It is functioning correctly. The bug is that A's lock-holding scope is wrong: it extended over an operation that did not need the lock.

This is invisible at the call site. The code reads as "lock, do some work, return." It costs nothing under low load. It costs everything when two callers race and one of them yields.

### The block-scope rule and why `drop()` doesn't satisfy the lint

The lint accepts three patterns as "the guard is gone before this `.await`":

1. The guard is bound in an inner `{ ... }` block and the await is outside that block.
2. The guard's name is shadowed by another `let` before the await.
3. `drop(guard)` appears as a statement before the await.

The repo's discipline strongly prefers pattern 1. The reason is reviewability, not lint mechanics: a block boundary tells the reader exactly when the guard ends, and Rust's borrow checker enforces it. `drop()` is a runtime call that can be missed in review and is easy to delete by accident. The lint accepts it because the rule engine has no way to require "block-scoped" syntactically, but the rule for humans is "use a block." See `crates/notebook-sync/src/handle.rs:206-229`, where `with_doc` takes the closure inside a scoped lock and returns before the next sync notification fires.

The lint is also conservative on shadowing: it accepts `let guard = ...;` as killing the previous binding named `guard`. That can mask intent. Project style is to prefer fresh names so the lint is doing structural matching, not name-equality reasoning.

## Decision 2: Use `std::sync::Mutex` for sync-only critical sections; `tokio::sync::Mutex` only when an async API is needed

Two locks, two purposes:

- **`std::sync::Mutex` / `std::sync::RwLock`**: critical section is purely synchronous. Acquire, mutate, release. No `.await` is possible inside, by construction. The lint does not need to fire because the surface area does not exist.
- **`tokio::sync::Mutex` / `tokio::sync::RwLock`**: the critical section is *forced* to span an `.await`. The standard case is a singleton handle to something that owns an async resource (a writer half of a socket, a child process stdin) and serializes async sends.

In practice the daemon defaults to `std::sync::Mutex`. The handful of tokio locks are documented at the site.

| Location | Lock | Why |
|----------|------|-----|
| `crates/notebook-sync/src/handle.rs:73` | `std::sync::Mutex<SharedDocState>` | Automerge apply is sync; closure runs inside the scope; no `.await` inside |
| `crates/runtime-doc/src/handle.rs` | `std::sync::Mutex` | Same shape as `DocHandle`: sync-only document mutation |
| `crates/runtimed/src/notebook_sync_server/room.rs:345,357` | `std::sync::Mutex<Option<PersistDebouncer>>`, `std::sync::Mutex<HashMap<...>>` | Take channel handles or compare maps, sync only |
| `crates/runtimed/src/jupyter_kernel.rs:327` | `Arc<tokio::sync::Mutex<StreamTerminals>>` | Owned by the kernel; the stream committer **drops the lock before awaiting `create_manifest_with_redactor`** (`stream_committer.rs:254-285, :327-337`) and reacquires after. The mutex is async only because IOPub-side push and commit-side flush want serialised mutation; the discipline holds. |
| `crates/runtimed/src/daemon.rs:1097-1102` | `Arc<RwLock<...>>` for `settings`, `pool_doc` | Reads/writes from async tasks; both locks released in block scope before any await |
| `crates/runtimed/src/notebook_sync_server/registry.rs` | `tokio::sync::Mutex` | Room registry mutation paired with async I/O |

The room's `lock_debouncer()` (`room.rs:471`) is the model for the synchronous shape: a small method returns the std-mutex guard, callers do one or two field reads or writes, the guard drops at end of statement. No await ever appears.

### Mixing the two safely

When a structure holds both kinds of state, the rule is: **the sync lock is taken inside the async lock's scope, never the other way around.** A sync lock taken first, then an async lock acquired before releasing the sync lock, blocks the runtime thread (sync mutex is OS-blocking; the executor thread cannot make progress on anything else while it spins).

`crates/runtimed/src/notebook_sync_server/metadata.rs:2249-2267` documents the ordering at the use site: "state handle uses `std::sync::Mutex` - no lock ordering concern with `runtime_agent_handle` (`tokio::sync::Mutex`)." The async lock has already been released by the time the sync `with_doc` runs. The comment names the invariant a future reader needs.

## Decision 3: Owned state in `select!` loops, not `Arc<Mutex<...>>`

Long-lived `select!` loops own their working state as local variables and mutate it via `&mut self` from inside the loop body. They do not park state behind shared mutexes.

The runtime agent's main loop (`crates/runtimed/src/runtime_agent.rs:121-160`) is the canonical case. It owns:

- `kernel: Option<JupyterKernel>`
- `interrupt_handle: Option<InterruptHandle>`
- `kernel_state: KernelState` (queue, executing id, lifecycle status)
- `seen_execution_ids: HashSet<String>`
- `echo_suppressor: EchoSuppressor`
- `lifecycle_rx`, `work_rx`: kernel-attached channels
- `inflight_sync: Option<JoinHandle<()>>` for env sync

Each tick of the `select!` loop takes one event, mutates whatever state is needed, sends what needs sending. No mutex. No lock contention. No convoy.

`KernelState` documents the discipline at the type level (`kernel_state.rs:1-9`): "designed to be held as a plain local variable in the runtime agent's `select!` loop - no mutex needed. Async methods accept `&mut impl KernelConnection` so they can send execute requests without owning the connection." The mutation surface is `&mut self`; ownership stays in the loop.

### What if a side task needs to see this state?

Use a channel, not a shared lock. The loop owns the writer half (or a watch sender, or a broadcast sender) and publishes deltas. Side tasks subscribe and react. Examples:

- `state_changed_tx: broadcast::Sender<()>` notifies any peer that wants to refresh from the runtime state doc.
- `async_response_tx: mpsc::Sender<RuntimeAgentResponseEnvelope>` lets spawned `SyncEnvironment` tasks return their responses to the loop, which then forwards them on the socket. The loop never blocks waiting for the spawn; the spawn never blocks waiting for the loop.

The cost is a small amount of allocation per event. The win is that no spawned task ever waits on a lock that the loop is holding. The select arm wakes, drains, mutates, moves on.

### Cancel-safe reads via `FramedReader`

The reader half of the socket is the one place where the loop body cannot be the sole reader: a `read_exact` future, dropped mid-read, silently consumes the bytes it had already pulled. The next `recv_typed_frame` call starts in the middle of a payload and reads the next length prefix from garbage. The daemon's symptom is `frame too large: 538976288 bytes` panics, which is the ASCII for `   "` interpreted as a u32 big-endian length.

`FramedReader` (`crates/notebook-protocol/src/connection/framing.rs:245-297`) is the fix. It spawns a dedicated task that owns the read half exclusively and publishes parsed frames through a bounded mpsc. Callers `select!` on `framed.recv()`, which is just an mpsc receive - cancel-safe by construction. The loop body's other arms can win freely; the read task keeps draining the socket.

`FramedReader` is not a mutex pattern, but it sits in the same family. The principle is the same: don't hold ownership of an uncancellable I/O operation in a select arm.

## Decision 4: The peer loop's "biased writer-task first" priority

The peer loop in `crates/runtimed/src/notebook_sync_server/peer_loop.rs:176-200` uses `biased;` and reorders arms so that the writer task and the request worker (both spawned helpers) are polled first. If they have terminated, the loop returns immediately rather than reading another frame from the client and dispatching it.

This is a degenerate version of the control-plane priority pattern from `docs/adr/execution-pipeline.md` Decision 2. There, the stream committer routes `ExecutionDone` through a priority arm that always wins over output flushes. Here, the peer loop routes "the helper task you depend on has died" through a priority arm that always wins over "another frame to dispatch." Either way, the principle is: **lifecycle-bearing events do not compete fairly with throughput-bearing events.**

The same pattern shows up in the runtime agent's main loop (`runtime_agent.rs:155`) and the daemon's connection-accept loop (`daemon.rs:1951, 1991, 2102`). They are not all `biased;` because some of them want fair selection over equally-priority events, but every one of them owns its state locally, drains short events before yielding to long ones, and never holds a lock across a `.await`.

## Decision 5: CI lint covers tokio mutex across await; everything else is review

The lint (`cargo test -p runtimed --test tokio_mutex_lint`, source `crates/runtimed/tests/tokio_mutex_lint.rs`) wraps the `async-rust-lsp::rules::mutex_across_await::check_mutex_across_await` rule from the `async-rust-lsp` crate (`0.3.x`).

The lint is tree-sitter based, so it is a structural matcher, not type-aware. What it checks:

- For each `block` node, find `let` bindings whose RHS is `<expr>.lock().await`, `.write().await`, or `.read().await`. Treat them as live guards.
- Walk subsequent statements in the same block (and statements inside nested blocks that the block contains). If an `await_expression` appears while any guard is still live, emit a diagnostic.
- A guard becomes not-live on shadowing (`let guard = something_else;`), on explicit `drop(guard)`, or on exit from its scope.
- The `if`/`match`/`loop` branches are walked with branch-local copies of the live set, so `drop(guard)` in one arm does not leak liveness into the other arm.

What it does **not** check:

1. **Cross-function liveness.** A function that takes a `MutexGuard<'a, T>` as an argument and `.await`s inside is invisible to the lint. The lint only sees the file where the guard is bound. Project discipline: do not pass guards across function boundaries.
2. **Async-trait or boxed-future returns.** A `pub async fn` that returns `impl Future` is matched as long as the await is lexically in the same source file. Returning a guard inside a future the caller awaits is not detected. The repo avoids this pattern.
3. **Non-method lock acquisitions.** A call like `acquire_lock(&mtx).await` that returns a guard does not match the `.lock().await` / `.read().await` / `.write().await` triplet. There is no such API in tokio's mutex/rwlock, but a wrapper that did this would be invisible to the lint. Do not write one.
4. **Parking lots and `lock_api`.** The lint targets tokio. `parking_lot::Mutex` is not async and not flagged. (It is also not currently used in the daemon.)
5. **`std::sync::Mutex.lock().unwrap()`.** Not async, not flagged. Clippy has `clippy::await_holding_lock` for that; we leave it to clippy.

The lint reached zero violations on 2026-04-08 (`runtimed/tests/tokio_mutex_lint.rs:8-12`) and CI keeps it there. New violations fail the test.

**Scope caveat: the lint does not recurse into subdirectories.** It uses `std::fs::read_dir(&src_dir)` with no recursion, where `src_dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src")`. So only top-level files in `crates/runtimed/src/*.rs` are scanned. Subdirectory files including the entire `notebook_sync_server/` tree (`peer_loop.rs`, `peer_runtime_agent.rs`, `metadata.rs`, `room.rs`, `registry.rs`, `peer_writer.rs`, ~24 files), `runtime_agent/echo_suppression.rs`, and `requests/*.rs` are silently invisible to the lint. The "zero violations" claim is scoped to top-level files only. Several files cited elsewhere in this ADR — `room.rs`, `metadata.rs`, `registry.rs`, `peer_loop.rs`, `peer_runtime_agent.rs` — sit in subdirectories the lint never visits.

Fixing the scope is a one-line `walkdir` change to `tokio_mutex_lint.rs`. It is on the cleanup punchlist as a Targeted PR.

Alternatives we considered:

- **Clippy `await_holding_lock`.** Catches `std::sync::Mutex`, not `tokio::sync::Mutex`. Wrong target.
- **Custom rust-analyzer lint via `lints.toml`.** Did not exist as a stable API when we needed it. The async-rust-lsp tree-sitter rule did, and gave us the right semantics with a small dependency.
- **Loom-based runtime test.** Loom catches actual deadlocks at test time but cannot enumerate all task interleavings in a production daemon. It is a complement, not a replacement; we have not adopted it for this surface.

## Decision 6: The concurrency-invariant family

Tokio-mutex-across-await is one rule in a larger discipline. The family shares a goal: under arbitrary load, the daemon's responsiveness must not collapse. Each rule closes a different mechanism by which a single piece of work could stall the rest.

| Rule | Mechanism it closes | Enforcement |
|------|---------------------|-------------|
| No tokio async-lock across `.await` | Convoy on a single lock when the holder yields | CI lint (`tokio_mutex_lint`) |
| Owned state in `select!`, not `Arc<Mutex<...>>` | Same convoy mechanism, applied to long-lived loops | Review; convention in `kernel_state.rs`, `runtime_agent.rs` |
| Control-plane signals do not share transport with output work | A flood of output work delays `KernelIdle` / `ExecutionDone` | `stream_committer.rs` priority arm, `execution-pipeline.md` Decision 2 |
| Cancel-safe reads via `FramedReader` | A select arm dropping `read_exact` desyncs the framed stream | Project convention; the alternative panics under load |
| `biased;` lifecycle arms in `select!` loops | A throughput event reordering ahead of a "your dependency died" event | Code review; pattern in `peer_loop.rs:178`, `peer_runtime_agent.rs:168` |
| Bounded mpsc capacities sized for steady-state, not worst-case | Unbounded growth of a slow consumer's queue starves memory | Code review; capacities are explicit and documented |
| Stream output uses lossy periodic flushes; ordering boundaries use the priority path | Display churn cannot delay `ExecutionDone` past terminal | `execution-pipeline.md` Decision 3, `stream_committer.rs` |

What ties them together is that none of them is "make the work itself faster." Each closes a path by which slow work could block fast work. That is the property the daemon needs.

The runtime agent's loop is the model. Local state, channel-published deltas, cancel-safe reads, biased lifecycle arms, no shared locks. It is the loop most likely to be touched by future work and the loop most worth holding to the discipline.

## Limitations

The tokio mutex lint scans only the top-level files of `crates/runtimed/src/`. It does not scan:

- Subdirectories of `crates/runtimed/src/` (see the scope caveat in Decision 5). This is the most consequential gap because much of the daemon's async-lock surface lives there.
- `crates/runtimed-client/`, `crates/runtimed-service/`, `crates/runtimed-py/`. **`runtimed-py`'s `session_core.rs` does hold `tokio::sync::Mutex<SessionState>` across awaited connection calls** outside the pyo3 wrapper (`crates/runtimed-py/src/session_core.rs:59-63, :214-240`); the lint does not see it.
- `crates/notebook-sync/`. `DocHandle` uses `std::sync::Mutex` so the lint has no work to do there, but a future `tokio::sync::Mutex` in `sync_task.rs` would not be checked.
- `crates/notebook-protocol/`, `crates/notebook-wire/`, `crates/notebook-doc/`. No async-lock usage today; nothing to scan.
- The runtime agent uses `Arc<RwLock<PresenceState>>` (`runtime_agent.rs:110`). This is the one async RwLock in the agent's main file. The lint covers it.

Extending the lint to subdirectories (`walkdir` instead of `read_dir`) and to additional crates (multiple source roots) is mechanical. It has not been done because the discipline has held under review; the lint-scope gap was surfaced while writing this ADR.

Open gaps:

- **Cross-function liveness.** The lint is file-scoped. A function that takes a `MutexGuard` argument and awaits inside is invisible. The codebase does not pass guards across function boundaries, but the lint will not catch it if someone does.
- **Async-trait return shapes.** A method that returns `Pin<Box<dyn Future + Send>>` and embeds a guard in the future is invisible. The repo uses RPITIT (return-position `impl Trait` in traits) instead, partly because it composes better with this lint.
- **The std-sync side of mixed-lock ordering.** No lint covers "sync lock taken first, async lock acquired second, sync lock still held." The cost is OS-thread blocking. Review catches it; convention documents it at use sites.
- **`std::sync::Mutex` held across `.await` in async code.** Clippy's `await_holding_lock` covers this, but we have not turned it on as a workspace deny. The pattern is rare in practice because Rust's `MutexGuard` is `!Send`, but `parking_lot::MutexGuard` *is* `Send` and would compile. If `parking_lot` ever lands in the daemon, the lint surface should expand.

## Migration

The lint reached zero violations on 2026-04-08 after a multi-PR burndown:

- #1614, #1637, #1638: initial fixes and lint expansion (raw count: 58 → 19)
- #1642: Phase 1 mechanical burndown
- #1647: kernel actor pattern conversion (19 → 14)
- Dead code removal plus IOPub scoping (14 → 0)

The path from 58 violations to 0 was not "add `drop(guard)` calls." Most were structural: extract the locked region into a helper that returns owned data, then let the helper drop the guard at return. The kernel actor pattern (#1647) replaced a shared `Arc<tokio::sync::Mutex<KernelState>>` with the owned-state-in-`select!` pattern documented in Decision 3.

New code follows the discipline by convention plus lint. New crates that adopt `tokio::sync::Mutex` or `RwLock` should add themselves to the lint's source roots before the second async-lock site is added.

## Open Questions

These follow-ups are tracked but not decided here:

1. **Lint coverage expansion to additional crates.** Mechanical; do it when the second async-lock site lands outside `runtimed/`.
2. **Cross-function guard liveness.** A type-level encoding (e.g., a marker type that cannot escape a closure) would be the right fix. None of the existing async-Rust lint crates offer it. Continue to forbid by convention.
3. **`std::sync::Mutex` across `.await` via `parking_lot`.** If `parking_lot` is introduced, turn on `clippy::await_holding_lock` workspace-wide. Until then, the absence of `parking_lot` is itself the mitigation.
4. **Loom coverage for the runtime agent's `select!` loop.** Loom would not catch the convoy pattern (it requires actual contention), but it would catch the rare two-lock deadlock case if it ever arose. Low priority; the loop's owned-state design makes the two-lock case structurally hard to introduce.
5. **`async fn`-trait migration.** When stable Rust supports `async fn` in traits with `Send` bounds without RPITIT boilerplate, revisit the lint's coverage of trait method bodies. The current RPITIT pattern is already lint-friendly; migrating should not regress.

## References

- `AGENTS.md` / `CLAUDE.md` "Tokio mutex guards stay within synchronous blocks" - the load-bearing paragraph this ADR expands.
- `crates/runtimed/tests/tokio_mutex_lint.rs` - the CI lint and the violation-count history.
- `async-rust-lsp::rules::mutex_across_await` - the tree-sitter rule the lint wraps. Documented inline in the crate; current version `0.3.1`.
- `crates/notebook-sync/src/handle.rs:73,206-229` - `DocHandle::with_doc`, the canonical sync-only critical section behind a `std::sync::Mutex`.
- `crates/runtimed/src/kernel_state.rs:1-9` - type-level documentation of the owned-state-in-`select!` pattern.
- `crates/runtimed/src/runtime_agent.rs:121-160` - the runtime agent's local-variables-only `select!` loop.
- `crates/runtimed/src/notebook_sync_server/peer_loop.rs:176-200` - `biased;` lifecycle priority in the peer loop.
- `crates/notebook-protocol/src/connection/framing.rs:245-297` - `FramedReader`, the cancel-safe read primitive.
- `crates/runtimed/src/notebook_sync_server/metadata.rs:2249-2267` - a use-site comment documenting mixed-lock ordering.
- `docs/adr/execution-pipeline.md` Decision 2 - the sibling rule for control-plane signal priority at the IOPub boundary.

## Tracked follow-ups (from the retired cleanup punchlist)

These items were migrated from `docs/adr/cleanup-punchlist.md` when it was
retired (2026-06-10). Severity: **Targeted PR** = one-or-two-file fix ready
to implement; **Design** = needs a decision in this ADR before code moves.

- **TMD-2** (Targeted PR; `crates/runtimed-py/src/session_core.rs`): `crates/runtimed-py/src/session_core.rs:59-63, :214-240` holds `Arc<tokio::sync::Mutex<SessionState>>` live across `connect_with_socket` awaits. The lint does not scan `runtimed-py`. Discipline violation, but the cure (restructure or extend lint) is non-trivial.
