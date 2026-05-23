# Cell Execution Pipeline and Control-Plane Separation

**Status:** Draft, 2026-05-22.

## Context

The desktop daemon runs cells against out-of-process Jupyter kernels. Between the click in the UI and the rendered output, the request crosses five state boundaries: the WASM Automerge peer in the renderer, the Unix-socket sync stream, the daemon's per-room request worker, the runtime agent subprocess, and the kernel's ZMQ channels. Each boundary has its own queue, its own backpressure shape, and its own failure modes.

Two facts make this pipeline unusual:

1. **There is no separate "execution result" message.** Outputs, execution counts, and terminal status all land in `RuntimeStateDoc`, the same Automerge document that holds queue and kernel-lifecycle state. Consumers read execution outcome by syncing this document and observing the entry transition to `done` or `error`.

2. **The daemon multiplexes high-volume output traffic and low-volume lifecycle signals on the same async runtime.** stdout floods, image-display churn, and widget-comm replay must not delay the `KernelIdle` that releases the queue or the `ExecutionDone` that lets a client read outputs.

This ADR captures the load-bearing decisions that make those facts work. Most of these rules live as paragraph-shaped invariants in `CLAUDE.md` and the `execution-pipeline` skill. Writing them down as decisions surfaces both the rationale and the gaps.

Three projects shaped the design:

- **Jupyter's IOPub model**: status messages and outputs interleave on a single pub-sub channel from the kernel. The daemon has to peel apart what's "output transport" from what's "control plane" on the way out, because no Jupyter component does that for us.
- **automerge / automerge-repo**: state convergence is guaranteed eventually, not promptly. We can't write "execution done, here are the outputs" as one atomic message because each `transact_at_current_heads` lands as a separate Automerge change, syncs as a separate frame, and applies on the receiver in its own tick.
- **runt-mcp**: the MCP server is an automated reader of execution results. Unlike a human who scrolls back when outputs are slow, an LLM call returns whatever was in the document the moment the poll fired. The pipeline has to make "outputs are durable and visible" a checkable condition, not a probabilistic one.

## Decision 1: RuntimeStateDoc is the durable record; broadcasts are advisory

Every execution writes to `RuntimeStateDoc.executions[execution_id]`:

```
executions["exec-abc"] = { status: "queued"        }
                       = { status: "running"       }
                       = { status: "running", outputs: [m1] }
                       = { status: "running", outputs: [m1, m2] }
                       = { status: "done", success: true, outputs: [m1, m2] }
```

The daemon writes `set_execution_done(eid, success)` **after** every output manifest for that execution is committed (`crates/runtimed/src/kernel_state.rs:150-181`, plus the stream-committer priority path described in Decision 2). Once a consumer's local Automerge replica observes `status == "done"`, the outputs in the same map are guaranteed to be in the same document, modulo one more sync tick.

An older design routed completion through `NotebookBroadcast` runtime variants. Those variants have been removed (the surviving `NotebookBroadcast` carries only `Comm` custom messages, see `crates/notebook-protocol/src/protocol.rs:748-765`). The shared completion helper (`crates/notebook-sync/src/execution_wait.rs`) polls RuntimeStateDoc on a 50ms cadence (`TERMINAL_POLL_INTERVAL`) and only consults the document's `kernel.lifecycle` and `executions/*/status`. No broadcast is consulted.

### Why RuntimeStateDoc and not the broadcast

A broadcast is a separate channel. By the time `ExecutionDone` arrives, the receiver's Automerge replica may still be applying the final stream-output change. Reading outputs at that moment yields fewer manifests than the durable record has. We hit this race repeatedly in early MCP work: the broadcast fired, the LLM read three of five outputs, the fourth and fifth landed 20ms later.

The durable-record rule has three consequences:

1. **`set_execution_done` is the commit boundary.** Code that writes outputs after that point silently breaks reader contracts. The stream committer enforces this by routing `ExecutionDone` through the same priority queue as the final stream flush (Decision 2).
2. **Output ordering inside an execution must match the kernel's IOPub order.** Consumers don't get to reorder; they read the array as it stands in the document.
3. **There is a two-phase wait, not a one-phase wait.** Even after `status == "done"`, a consumer's local replica may be one sync tick behind on the outputs. `await_execution_terminal` polls for outputs at 10ms cadence for up to a 500ms grace window after terminal status. The grace is bounded so a genuinely output-free execution still returns promptly.

### Counterfactual: broadcasts as truth

If we let consumers trust the broadcast, an MCP tool call ordering `execute_cell` then `get_cell` would read the cell's outputs at the moment the broadcast fires. That moment is the daemon's send; the consumer's apply lags by however long it takes the typed-frame writer, the socket, and the receiver's sync task to land the final stream change. The MCP path returned partial outputs, intermittently, depending on output size. The fix wasn't tuning the broadcast latency. It was making the broadcast irrelevant.

## Decision 2: Control-plane signals do not share transport with output work

Kernel-lifecycle signals (`KernelIdle`, `ExecutionDone`, `CellError`, `KernelDied`) ride a separate, unbounded `mpsc` from output-work commands (`SendCommUpdate` for widget replay). The split is enforced by the channel construction in `crates/runtimed/src/output_prep.rs:484-501`:

```rust
pub fn queue_command_channels(work_capacity: usize) -> (
    mpsc::UnboundedSender<QueueCommand>,  // lifecycle
    mpsc::Sender<QueueCommand>,            // work
    QueueCommandReceivers,
) { … }
```

`QueueCommand::is_lifecycle()` is the type-system marker for which channel a command belongs on. The stream committer's `flush_then_signal` `debug_assert!`s that the signal is a lifecycle signal before forwarding it.

The runtime agent's `select!` loop has two arms for these channels (`crates/runtimed/src/runtime_agent.rs:592-639`):

- The lifecycle arm runs whenever a lifecycle command is ready.
- The work arm, before processing its own command, drains every pending lifecycle command via `drain_lifecycle_commands`. This prevents the work arm from being chosen while lifecycle signals sit unprocessed.

The `biased;` modifier is intentionally **not** used here. The reordering is at the body level, not the arm level. Both arms compete fairly for selection, but once the work arm wins it still defers to lifecycle. A `biased;` strict-priority loop would starve work entirely whenever lifecycle signals arrive faster than they can be drained, which we don't want.

### Why separate channels

The widget-output replay (`SendCommUpdate`) can be high-volume. When a kernel runs a tight `IntProgress` loop, the daemon receives hundreds of comm updates per second and forwards each to the kernel as a `comm_msg(update)`. If lifecycle and work shared a bounded queue, an interrupt's `KernelIdle` could sit behind a backlog of widget replays, leaving the queue stuck in `Busy` until the backlog drained. The user's interrupt would *eventually* take effect, but with seconds of latency that look exactly like a hang.

### Why the work channel is bounded and the lifecycle channel is unbounded

Lifecycle signals are rare. `KernelIdle` fires once per execution, `ExecutionDone` once per execution, `KernelDied` once ever, `CellError` zero or once per execution. The cardinality is small and we can't drop any of them without breaking queue release. Unbounded is safe.

Work signals are unbounded in the worst case (widget replay during a runaway loop). The work channel is bounded at capacity 100 (`crates/runtimed/src/jupyter_kernel.rs:1221-1224`, `queue_command_channels(100)`). If a flood of `SendCommUpdate`s outpaces the kernel's shell ingest, the sender drops via `try_send` (`jupyter_kernel.rs:196-224`) and logs. The kernel-facing comm replay is best-effort by design (Decision 4); dropping a redundant update doesn't lose state because the next update will overwrite the same widget property.

Two other bounded queues sit nearby and are easy to confuse with the work channel:

- `STREAM_COMMITTER_QUEUE_CAPACITY = 32` (`stream_committer.rs:25`) bounds the **periodic** `request_flush` mpsc inside the stream committer. Drops here are safe because the terminal buffer still holds the text and a later flush will publish it (see Decision 3).
- `MAX_PENDING_DISPLAY_IDS = 128` (`display_update_committer.rs:24`) bounds the **distinct display IDs** queued for display-data coalescing. A 129th distinct ID is dropped; updates to already-queued IDs always coalesce (see Decision 5).

The work channel, the periodic stream channel, and the display-update bound are three different lossy queues with three different sizes and reasons. EP-5 in the cleanup punchlist tracks the open question of whether these are right.

### Counterfactual: one bounded channel for everything

We tried this in an earlier iteration. The user-visible failure was "interrupt does nothing for 2-5 seconds when a chatty progress bar is running." The root cause was a `KernelIdle` enqueued behind buffered widget replays, each requiring a kernel round-trip; with the lifecycle and work channels merged into one bounded mpsc, the buffered work blocked the urgent signal. The fix shipped as the two-channel split documented here.

## Decision 3: Stream output uses a priority committer for ordering boundaries

stdout and stderr arrive on IOPub as `StreamContent` messages with `name: "stdout"|"stderr"` and a text chunk. Rendered terminal state lives in `StreamTerminals` (`crates/runtimed/src/stream_terminal.rs`), an in-memory ANSI-aware buffer per `(execution_id, stream_name)`. Coalesced periodic flushes commit the rendered text to RuntimeStateDoc as a stream manifest.

The committer has two ingress paths (`crates/runtimed/src/stream_committer.rs`):

| Path | Channel | Behavior under pressure |
|------|---------|--------------------------|
| `request_flush` | bounded `mpsc(32)` | Drop on full. The terminal buffer holds the latest text; a later flush will publish it. |
| `flush_for_ordering` / `flush_then_signal` | unbounded `mpsc` | Always delivered. Used at output-type boundaries and at execution completion. |

The select loop in `run_stream_committer` is `biased;` and priority-receives. The priority arm wins whenever it has anything pending.

### When does ordering matter

A display-data or error output that follows stdout text in the kernel's IOPub stream must land in RuntimeStateDoc *after* the stream output. The reason is twofold:

1. Consumers render outputs in array order. A reordered display-data appearing before its preceding stdout produces visibly wrong output ordering.
2. Stream output in RuntimeStateDoc is keyed by `(execution_id, stream_name)`. The terminal buffer is cleared at every non-stream output boundary so subsequent stdout starts a fresh manifest. If we clear the buffer before flushing the prior stream's text, that text is lost.

Every output-type boundary therefore calls `stream_committer.flush_for_ordering(boundary_flushes).await` before mutating non-stream output state. This is visible at every `JupyterMessageContent::ErrorOutput` and `DisplayData` handler in `jupyter_kernel.rs`.

### `ExecutionDone` rides the priority path

The final lifecycle signal for an execution travels through the stream committer, not the lifecycle channel directly:

```rust
stream_committer.flush_then_signal(
    final_stream_flushes,
    QueueCommand::ExecutionDone { execution_id: eid },
);
```

This is the ordering glue. The committer flushes the final stream content, then sends `ExecutionDone` on the lifecycle channel. The runtime agent receives `ExecutionDone`, calls `KernelState::execution_done`, which writes `set_execution_done(eid, true)`. The durable-record invariant from Decision 1 holds: terminal status follows the final output.

`KernelIdle` rides the lifecycle channel directly (`jupyter_kernel.rs:1408-1430`). It releases the queue and is allowed to arrive before the final stream flush; what cannot arrive early is `ExecutionDone`.

One subtle case: when `flush_then_signal` is called with an empty flushes list, it sends the lifecycle signal directly on `lifecycle_tx` instead of routing through the priority committer (`stream_committer.rs:106-118`, test `flush_then_signal_without_flushes_sends_lifecycle_immediately`). For a no-output execution, `ExecutionDone` and `KernelIdle` therefore race freely on the same lifecycle channel. Both writes are idempotent on the receiver side, but if a consumer treated `KernelIdle` as terminal it would see the queue released before `set_execution_done` ran. The cleanup punchlist tracks this as EP-11.

### Counterfactual: synchronous output writes from the IOPub reader

If the IOPub reader awaited `state.with_doc(…)` for every chunk, blob writes and Automerge mutations would block the reader from advancing. A subsequent `status: idle` would sit unread until the buffered chunk finished its blob upload. Interrupt latency would scale with output throughput. The committer pattern decouples the reader from the writes: the reader feeds the terminal buffer and triggers best-effort flushes; the committer absorbs the slow writes off the hot path.

## Decision 4: Output-widget replay is non-blocking and best-effort

A Jupyter Output widget captures outputs emitted while a target cell is executing and replays them as the widget's state. The daemon's IOPub reader does both jobs: it appends the manifest to `RuntimeStateDoc.comms[comm_id].outputs` (the durable record), and it sends a `SendCommUpdate` to the kernel's shell channel so the kernel-side Output widget object stays in sync.

The kernel-facing replay uses `try_send_comm_update` (`crates/runtimed/src/jupyter_kernel.rs:196-224`). If the work channel is full, the update is dropped with a `debug` log. The durable record in RuntimeStateDoc is unaffected: it was written first, on the synchronous path.

### Why best-effort

Two reasons.

1. **The durable record is the truth.** Any peer that needs Output widget state reads `RuntimeStateDoc.comms[*].outputs` directly. The kernel-side replay is convenience for kernel code that introspects its own widget. Dropping a replay does not lose state; the next state update will overwrite the same comm property.

2. **Replay floods cannot stall lifecycle.** A `clear_output` + `display_data` + 1000 stdout chunks in a tight loop produces 1000+ comm updates. If each `await`ed the work channel, the IOPub reader would block waiting for the runtime agent's shell sender. `KernelIdle`, which would normally release the next execution, would arrive late. With `try_send`, the reader keeps draining IOPub and the queue stays responsive.

### Counterfactual: awaited replay

We tried `work_tx.send(...).await`. The symptom was that a notebook running a long loop with widget output would interrupt successfully (the control-plane `KernelIdle` worked), but the next queued cell would not start for several seconds. The blocked replay sender was holding the IOPub reader, which held the `is_registered_execution` state, which gated the next execution start. The fix was to make replay drop-on-full and treat any back-pressure on the work channel as load-shed signal.

## Decision 5: `update_display_data` coalesces by display_id off the hot path

`update_display_data` is the Jupyter mechanism for replacing the contents of a previously-displayed output, keyed by a `display_id`. tqdm progress bars use this to rewrite the same line. A long `for` loop with `display(handle, display_id="x")` can emit hundreds of updates per second for one logical "output."

The display-update committer (`crates/runtimed/src/display_update_committer.rs`) is built around three observations:

1. Only the latest update per `display_id` matters semantically. Earlier updates are obsolete the moment a later one arrives.
2. Each update requires a RuntimeStateDoc transaction (to find all outputs sharing that display_id and rewrite their data manifests). That transaction is too slow to run on the IOPub reader's hot path under load.
3. Terminal status must still wait for the latest pending update to be durable, so consumers reading after `ExecutionDone` see the final rendered state, not the second-to-last.

The committer therefore holds a `HashMap<String, PendingDisplayUpdate>` keyed by `display_id`. `request_update` inserts (overwriting any previous entry for the same id) and wakes the committer with `Notify::notify_one`. The committer drains the entire map per wake and commits each latest value through `apply_display_manifest_updates`.

`Notify` is intentionally only a wake hint, not the queue. The pending map is the source of truth. This decouples "how many updates arrived" from "how many wakes we generated" and means burst arrivals don't need one permit per update.

### The flush before `ExecutionDone`

When `status: idle` arrives from the kernel, `jupyter_kernel.rs:1419` calls:

```rust
display_update_committer.flush_for_ordering().await;
```

This routes through a priority arm of the committer's select loop. The arm drains the pending map (same drain the wake arm runs), then acknowledges via oneshot. Only after that ack does the stream committer's `flush_then_signal` enqueue `ExecutionDone`.

The ordering is therefore: pending display updates committed → final stream output committed → `ExecutionDone` enqueued → `set_execution_done` written → consumer reads.

### Counterfactual: coalesce on the IOPub hot path

We could maintain the pending map inside the reader and write only on a debounce. The reason we don't: every write would still touch RuntimeStateDoc from the reader's task, and the reader would still occasionally block on slow Automerge transactions during high-frequency updates. The committer pattern moves the slow path off the reader entirely.

### Counterfactual: no coalescing

Every `update_display_data` writes immediately. We tried this with tqdm-style loops and saw the IOPub reader fall behind by hundreds of milliseconds during heavy updates. The reader queue (`AsyncRead`) does not have unlimited buffering; falling behind means losing the back-pressure signal we need to detect a stalled kernel.

## Decision 6: `required_heads` is a causal precondition, not a strict barrier

The daemon executes against its own copy of `NotebookDoc`. The client edits cell source locally, those edits sync to the daemon as a series of Automerge changes. There is no guarantee that the daemon has applied the client's most recent source edit by the time the client's `ExecuteCell` request lands at the daemon's request worker.

To close this race, the client captures the current heads of its NotebookDoc replica before sending the request:

```rust
let required_heads = handle.current_heads_hex()?;
let response = handle.send_request_after_heads(request, required_heads).await;
```

The daemon's request worker calls `wait_for_required_heads` before dispatching (`crates/runtimed/src/notebook_sync_server/peer_writer.rs:222-256`). It loops on the room's `changed_tx` broadcast, checking after each notification whether every required head exists in the daemon's NotebookDoc via `get_change_by_hash`. Once all are present, the request proceeds.

### Why a 10-second timeout exists

If the client and daemon are healthy but the sync stream is congested, the daemon may take longer than expected to receive a head. If the client and daemon are *unhealthy* (the client disconnected, the head will never arrive), waiting forever would deadlock that request worker. The 10-second cap is the bound on how long we'll wait for a head that should already be in flight. On timeout, the daemon returns `NotebookResponse::Error { error: "Timed out waiting for required notebook heads" }` to the client (`crates/runtimed/src/notebook_sync_server/peer_writer.rs:167-181`); the request is **not** dispatched against stale state.

This is fail-closed, not graceful degradation. The client sees an error response and decides whether to retry. The frontend pushes pending source edits into the sync stream before capturing heads (`packages/runtimed/src/notebook-client.ts:98-101`: heads are captured first, then the configured flush hook is invoked) so that under normal conditions every required head is already in flight by the time the request arrives at the daemon.

### Counterfactual: pass source as a request parameter

Tempting and wrong. If the request carries source and a `cell_id`, the daemon now has two sources of truth: the request payload and the synced document. They can disagree (the document is the latest, the request was captured at an older state). The daemon would have to pick. Picking the request payload means the rest of the room's peers, which only see NotebookDoc changes, are blind to what just executed. Picking the document means the source parameter was pointless to begin with.

The chosen model has one source: NotebookDoc, synced through Automerge, gated by `required_heads`. The cell-id-only request envelope is structurally incapable of executing source the room cannot also observe.

## Decision 7: Two-document architecture for execution state

Execution spans two synced Automerge documents:

| Document | Purpose | Frame |
|----------|---------|-------|
| `NotebookDoc` | Cell source, structure, metadata | `0x00` |
| `RuntimeStateDoc` | Execution queue, lifecycle, outputs, kernel status | `0x05` |

The split is intentional and load-bearing:

1. **Different write cadence.** NotebookDoc absorbs character-level edits from human typing. RuntimeStateDoc absorbs output streams from kernels. Combining them would tie editing latency to output churn.
2. **Different writer authority.** NotebookDoc is frontend-authoritative for source and structure. RuntimeStateDoc is daemon-authoritative for outputs and lifecycle (except for the narrow `comms/*/state/*` widget-state surface). Keeping them separate lets the trust gate enforce different scopes at the frame layer (see `docs/architecture/identity-and-trust.md`, Decision 5).
3. **Different persistence shapes.** NotebookDoc serializes to `.ipynb` on autosave. RuntimeStateDoc is ephemeral and recreated on daemon restart.
4. **Different sync streams.** Both flow over the same connection but use distinct frame types and sync states. A flood on one document's stream does not stall the other.

The `required_heads` causal gate (Decision 6) is over NotebookDoc only. Execution waiting (Decision 1) reads RuntimeStateDoc only. Both replicate concurrently and the consumer joins them at read time.

## Worked examples

### Single cell, modest output

1. User types `print(2+2)`. The renderer's WASM peer applies the source edit and queues an outbound NotebookDoc sync.
2. User clicks run. The frontend calls `current_heads_hex()` (capture the new heads), then invokes the flush hook (commit the edit, pushing it onto the sync stream), then `executeCell` with those heads attached (`packages/runtimed/src/notebook-client.ts:98-101`). The capture-then-flush order is intentional: capturing first ensures the heads passed to the daemon are a strict subset of the bytes about to arrive on the sync stream.
3. Daemon's peer-writer worker receives `ExecuteCell { cell_id, execution_id: None }` with `required_heads`. It calls `wait_for_required_heads` and observes all heads present (the sync frame arrived in the same TCP burst). Returns from the wait.
4. Handler reads source from NotebookDoc, mints `execution_id`, writes `executions[eid] = { status: "queued", source, … }` and updates `queue`. Responds `CellQueued { execution_id, cell_id }`.
5. Runtime agent observes the new execution via RuntimeStateDoc sync, calls `KernelState::queue_cell` then `process_next`. Status flips to `running`. ZMQ `execute_request` goes to the kernel.
6. Kernel emits `status: busy`, `execute_input`, `stream { name: "stdout", text: "4\n" }`, `status: idle`.
7. IOPub reader feeds the stdout chunk to `StreamTerminals` and requests a periodic flush. Flush commits a stream manifest to `executions[eid].outputs`.
8. On `status: idle`: enqueue `KernelIdle` on lifecycle channel, then `display_update_committer.flush_for_ordering().await` (no pending updates, returns immediately), then `stream_committer.flush_then_signal(final_flushes, ExecutionDone { eid })`.
9. Stream committer's priority arm flushes the final stream manifest, then sends `ExecutionDone` on the lifecycle channel.
10. Runtime agent's lifecycle arm processes `KernelIdle` (status -> idle, no execution to release). Then `ExecutionDone` (status -> idle, calls `set_execution_done(eid, true)`, releases queue).
11. Frontend's polling consumer of RuntimeStateDoc observes `status: "done"` with the stream manifest in `outputs`. UI renders.

### Cell with a tight progress-bar loop

1. Cell runs `for i in range(10000): bar.update()` where `bar` is an `IntProgress` widget.
2. Each `bar.update()` triggers a kernel-side `comm_msg(update)` carrying the widget's new `value`. IOPub delivers it as a comm update.
3. IOPub reader writes to `RuntimeStateDoc.comms[bar_id].state.value` synchronously (durable record). Then calls `try_send_comm_update` for kernel-side replay.
4. Work channel fills. Subsequent `try_send_comm_update` calls drop. Daemon logs at `debug`.
5. User clicks interrupt. `RuntimeAgentRequest::InterruptExecution` arrives. Handler clears local queue, calls `mark_interrupted_executions_failed`, spawns ZMQ interrupt.
6. Kernel emits a flurry of late IOPub including `KeyboardInterrupt` error, more comm updates, then `status: idle`.
7. `KernelIdle` enqueued on lifecycle channel. Runtime agent's lifecycle arm runs before the work arm processes any backlogged `SendCommUpdate`. Queue releases.
8. Pending work-channel items are processed afterward at whatever rate they drain. Each is a best-effort replay; the durable record in RuntimeStateDoc already has the correct state.

If lifecycle and work shared one channel, the interrupt's `KernelIdle` would have queued behind whatever `SendCommUpdate` backlog existed and the user-visible interrupt latency would scale with the depth of that backlog.

### `update_display_data` storm

1. Cell runs `for i in range(1000): display(Image(...), display_id="x")`.
2. Each update arrives on IOPub as `UpdateDisplayData`. IOPub reader calls `display_update_committer.request_update(display_id, data, metadata, buffers)`. The pending map's entry for `"x"` is overwritten on each call. A single `notify_one` is posted per call (idempotent under the wake-hint semantics).
3. The committer wakes, drains the pending map, commits the *latest* manifest for `"x"` to RuntimeStateDoc. While that transaction runs, more requests pile into the pending map; the next wake catches them.
4. `status: idle` arrives. IOPub reader calls `display_update_committer.flush_for_ordering().await`. The committer's priority arm drains the pending map one more time, sends ack, and the reader proceeds.
5. Stream committer flushes any final stream output, then sends `ExecutionDone`. Reader proceeds to next message.
6. Consumers reading `executions[eid].outputs` after `status: "done"` see the latest rendered state of `"x"`, not the second-to-last.

## What this leaves open

1. **Output sync-grace tuning under load.** `DEFAULT_OUTPUT_SYNC_GRACE = 500ms` is empirical. We don't have a measured upper bound on how long a final output manifest can take to sync under realistic load. Large DataFrames, batched plots, or congested socket scenarios may exceed it. There's no metric for "wait completed but outputs still empty" today.

2. **Capacity constants are picked by judgment, not measurement.** The work channel (100), `STREAM_COMMITTER_QUEUE_CAPACITY = 32`, `MAX_PENDING_DISPLAY_IDS = 128`, and `DEFAULT_OUTPUT_SYNC_GRACE = 500ms` are all empirical defaults. None is enforced by a benchmark; none has telemetry on actual drop rates or grace-window misses. We may be silently dropping more periodic stream flushes (or capacity drops on the work channel) than we expect. Punchlist EP-5.

3. **What if `set_execution_done` is never written?** A panic or task drop between the final output write and `set_execution_done` leaves the execution in `running` forever. Consumers time out. There is no per-execution timeout or watchdog at the daemon side. `KernelDied` clears the queue but only fires when IOPub disconnects.

4. **The `is_lifecycle()` discipline is a runtime check.** Both `flush_then_signal` (`stream_committer.rs:101-104`) and `drain_lifecycle_commands` (`runtime_agent.rs:1422-1425`) `debug_assert!` it. In release builds a non-lifecycle command would be silently forwarded onto the lifecycle channel. No CI lint enforces "only `KernelIdle | ExecutionDone | CellError | KernelDied` may travel on the lifecycle channel." The cleanup punchlist tracks this as EP-2.

5. **`required_heads` is `NotebookDoc`-only.** A request that semantically depends on a recent RuntimeStateDoc write (rare in v1, but conceivable for future request types) has no causal gate.

6. **Run-all timeouts are shared, not per-cell.** Run-all (`crates/runt-mcp/src/execution.rs:249-285`) polls each queued execution against a single shared deadline rather than calling a dedicated `await_execution_terminal` helper per cell. A long-running first cell can starve the budget for later cells. There is no fairness mechanism. The cleanup punchlist tracks this as EP-9.

7. **No formal model of "the IOPub reader cannot block."** It's a discipline observed by reading `jupyter_kernel.rs`. Adding a new `await` on a bounded queue inside the IOPub message-handler match arms would silently re-introduce the backpressure failure mode the priority committers exist to prevent.

8. **`update_display_data` buffers are not coalesced.** The pending map keeps the *latest* `data`, `metadata`, and `buffers` per `display_id`. If two updates each carry a different binary buffer set, the earlier buffers are dropped along with the earlier data. This is correct under the semantics ("only the latest update matters"), but the contract is implicit.

9. **`SendCommUpdate` drop telemetry is asymmetric.** The `Full` arm of `try_send_comm_update` logs at `debug`; the `Closed` arm logs at `warn` (`jupyter_kernel.rs:208-220`). Production daemons running with default log levels see channel-closed drops but not capacity drops. EP-4 and EP-13 in the punchlist.

11. **`KernelDied` is also produced by committer-supervisor panic.** Both `start_stream_committer` and `start_display_update_committer` use `spawn_supervised`, which on panic enqueues `QueueCommand::KernelDied` on the lifecycle channel to release the queue (`display_update_committer.rs:249-262`). The ADR's coverage of `KernelDied` reads as IOPub-disconnect-only; the committer-crash path is also load-bearing. Punchlist EP-12.

12. **Stale-stream-flush-after-clear is silently dropped.** If the stream buffer is cleared (terminal state reset) between a `request_flush` and its commit, the committer drops the stale write (`stale_stream_flush_after_clear_is_ignored` test at `stream_committer.rs:438`). This is relied on by the ordering-boundary clears in `jupyter_kernel.rs:1716,1923` but is not stated as an invariant.

10. **No invariant test that `ExecutionDone` follows the final stream manifest in RuntimeStateDoc order.** The stream committer's `flush_then_signal_commits_stream_before_lifecycle_signal` test checks that the lifecycle signal is sent after the manifest write returns; it does not assert ordering at the `RuntimeStateDoc.changes` level. A future refactor could break the causal order without that test failing.

## References

- `crates/runtimed/src/stream_committer.rs` - bounded periodic + unbounded priority paths, `flush_then_signal`, `flush_for_ordering`.
- `crates/runtimed/src/display_update_committer.rs` - coalesced display updates, priority flush ack.
- `crates/runtimed/src/output_prep.rs:444-501` - `QueueCommand`, `is_lifecycle`, channel construction.
- `crates/runtimed/src/runtime_agent.rs:592-639, 1414-1430` - lifecycle/work select arms and `drain_lifecycle_commands`.
- `crates/runtimed/src/jupyter_kernel.rs:1394-1441, 1805-1818` - IOPub `status: idle` and `UpdateDisplayData` handling.
- `crates/runtimed/src/kernel_state.rs:147-181` - `execution_done` and `set_execution_done`.
- `crates/notebook-sync/src/execution_wait.rs` - two-phase terminal wait, output-sync grace.
- `crates/runtimed/src/notebook_sync_server/peer_writer.rs:167-256` - `required_heads` gate.
- `crates/runt-mcp/src/execution.rs` - MCP consumer pattern.
- `.agents/skills/execution-pipeline/SKILL.md` - the agent-facing summary that this ADR expands.
- `CLAUDE.md` "Runtime control-plane signals are not output transport" - the load-bearing paragraph this ADR is the long-form of.
