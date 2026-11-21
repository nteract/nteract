# Cell Execution Pipeline and Control-Plane Separation

**Status:** Accepted, 2026-05-22.

## Context

The desktop daemon executes cells against out-of-process Jupyter kernels. Every
run crosses five state boundaries: the renderer's WASM Automerge peer, the
Unix-socket sync stream, the daemon's per-room request worker, the runtime agent
subprocess, and the kernel's ZMQ channels. Each boundary has its own queue,
backpressure behavior, and failure modes.

Two properties shape this pipeline:

1. **There is no separate "execution result" message.** Outputs, execution
   counts, and terminal status all land in `RuntimeStateDoc`, alongside queue
   and kernel-lifecycle state. Readers observe execution outcome by syncing
   `RuntimeStateDoc` until the entry becomes `done` or `error`.
2. **High-volume output traffic shares an async runtime with low-volume control
   signals.** Stdout floods, display churn, and widget-comm replay must never
   delay `KernelIdle` (which releases the queue) or `ExecutionDone` (which lets
   readers consume outputs).

This ADR records the execution and output-ordering invariants behind
`crates/runtimed/AGENTS.md` and the `execution-pipeline` skill.

Neighbors:

- `docs/adr/document-split.md`: why execution state lives in `RuntimeStateDoc`
  and not `NotebookDoc`, and why two writer paths update it.
- `docs/adr/0002-comms-document-split.md`: why mutable widget state lives in
  `CommsDoc` while `RuntimeStateDoc` owns comm topology and output routing.
- `docs/adr/typed-frame-v4-wire-protocol.md`: `Request`/`Response` correlation
  and `SessionControl` readiness phases.
- `docs/adr/blob-storage-and-content-addressing.md`: content-addressed storage
  for output payloads referenced by manifests.
- `docs/adr/identity-and-trust.md`: who may `ExecuteCell` and read outputs.

Three design pressures drove these choices:

- **Jupyter IOPub interleaving:** Status messages and outputs share one pub-sub
  channel from the kernel, so the daemon must separate control-plane signals
  from output transport on ingress.
- **Automerge eventual sync:** Each `transact_at_current_heads` commits as a
  separate Automerge change, syncs as a separate frame, and applies on its own
  tick. Completion and final outputs cannot rely on a separate atomic signal.
- **Automated readers (`runt-mcp`):** An LLM tool call returns whatever is in
  the document when the poll completes, so "outputs are durable and visible"
  must be a checkable invariant rather than a timing guess.

## Decision 1: `RuntimeStateDoc` is the durable record; broadcasts are advisory

Every execution progresses through `RuntimeStateDoc.executions[execution_id]`:

```text
executions["exec-abc"] = { status: "queued"        }
                       = { status: "running"       }
                       = { status: "running", outputs: [m1] }
                       = { status: "running", outputs: [m1, m2] }
                       = { status: "done", success: true, outputs: [m1, m2] }
```

The daemon writes `set_execution_done(eid, success)` **after** every output
manifest for that execution is committed
(`KernelState::execution_done` in `crates/runtimed/src/kernel_state.rs`,
ordered by the stream committer in Decision 3). Once a peer's replica sees
`status == "done"`, all outputs for that execution are committed in the same
document, at most one sync tick away.

`NotebookBroadcast` carries only `Comm` custom messages
(`crates/notebook-protocol/src/protocol.rs`). Completion reads
`RuntimeStateDoc` exclusively: `crates/notebook-sync/src/execution_wait.rs`
polls `kernel.lifecycle` and `executions/*/status` every 50ms
(`TERMINAL_POLL_INTERVAL`) and never consults broadcasts.

### Why `RuntimeStateDoc` instead of a broadcast

Broadcasts ride a separate channel from Automerge sync. When a completion
broadcast arrives, the receiver's Automerge replica can still be applying the
final output change, causing automated readers like MCP tools to observe partial
outputs.

Three invariants follow:

1. **`set_execution_done` is the commit boundary.** Writing outputs after it
   breaks reader contracts. The stream committer enforces this by sending
   `ExecutionDone` through the same priority queue as the final stream flush
   (Decision 3).
2. **Outputs preserve kernel IOPub order.** Readers consume the document array
   as written without reordering.
3. **Completion uses a two-phase wait.** After observing `status == "done"`,
   `await_execution_terminal` polls for outputs every 10ms for up to a 500ms
   grace window so late-arriving output frames settle while output-free cells
   still return promptly.

## Decision 2: Control-plane signals do not share transport with output work

Kernel-lifecycle signals (`KernelIdle`, `ExecutionDone`, `CellError`,
`KernelDied`) use an unbounded `mpsc`, separate from output-work commands
(`SendCommUpdate` for widget replay). `crates/runtimed/src/output_prep.rs`
enforces this split at compile time:

```rust
pub fn queue_command_channels(work_capacity: usize) -> (
    mpsc::UnboundedSender<LifecycleSignal>, // lifecycle
    mpsc::Sender<WorkCommand>,              // work
    QueueCommandReceivers,
) { ... }
```

Two compile-time guards prevent channel misuse:

- Non-lifecycle work cannot compile onto `UnboundedSender<LifecycleSignal>`.
- `queue_command_channels` wraps the work sender in
  `NonBlockingSender<WorkCommand>`, which exposes only `try_send` (EP-8). A
  blocking `.send().await` in an IOPub handler does not compile.

The runtime agent's `select!` loop (`crates/runtimed/src/runtime_agent.rs`)
prioritizes lifecycle deterministically:

- `tokio::select! { biased; ... }` polls the lifecycle arm ahead of the bounded
  work arm whenever both are ready (EP-10).
- Before handling any work command, the work arm drains every pending lifecycle
  signal via `drain_lifecycle_commands`.

Strict priority is safe because lifecycle cardinality is tiny and finite per
execution, whereas letting widget replay run ahead of `KernelIdle` causes
multi-second interrupt and queue-release stalls.

### Queue sizing and lossy bounds

- **Lifecycle channel (unbounded):** Fires at most a few signals per execution
  (`KernelIdle`, `ExecutionDone`, `CellError`, `KernelDied`). None may be
  dropped without breaking queue release.
- **Work channel (bounded at `100`):** Set via `queue_command_channels(100)`
  (`crates/runtimed/src/jupyter_kernel.rs`). When widget replay outpaces shell
  ingest, `try_send_comm_update` (`crates/runtimed/src/jupyter_kernel.rs`) drops
  excess updates and logs at `debug`. Because replay is best-effort
  (Decision 4), a later update overwrites the same widget property.
- **Periodic stream flush queue (`STREAM_COMMITTER_QUEUE_CAPACITY = 32`):**
  (`crates/runtimed/src/stream_committer.rs`). Drops are safe because
  `StreamTerminals` retains full rendered text for the next flush (Decision 3).
- **Display-update coalescing cap (`MAX_PENDING_DISPLAY_IDS = 128`):**
  (`crates/runtimed/src/display_update_committer.rs`). Bounds distinct pending
  display IDs; a 129th distinct ID drops while updates to queued IDs coalesce
  (Decision 5).

Whether these three lossy bounds (`100`, `32`, `128`) are sized well under
heavy load is tracked in [Open Follow-ups](#open-follow-ups).

### Rejected alternative: one bounded channel for everything

Merging lifecycle and work into one bounded `mpsc` stalls interrupts for 2–5
seconds during chatty progress-bar loops because `KernelIdle` queues behind
buffered widget replays awaiting kernel round-trips.

## Decision 3: Stream output uses a priority committer for ordering boundaries

Stdout and stderr arrive on IOPub as `StreamContent` chunks (`"stdout"` /
`"stderr"`). `StreamTerminals` (`crates/runtimed/src/stream_terminal.rs`) holds
an ANSI-aware terminal buffer per `(execution_id, stream_name)` and flushes
rendered text to `RuntimeStateDoc` as stream manifests.

`crates/runtimed/src/stream_committer.rs` exposes two ingress paths inside a
`biased;` select loop where the priority arm always wins when ready:

| Path | Channel | Behavior under pressure |
|------|---------|-------------------------|
| `request_flush` | bounded `mpsc(32)` | Drops on full; `StreamTerminals` retains latest text for the next flush. |
| `flush_for_ordering` / `flush_then_signal` | unbounded `mpsc` | Always delivered; used at output-type boundaries and execution completion. |

### Ordering boundaries

Non-stream outputs (`DisplayData`, `ErrorOutput`) that follow stdout on IOPub
must commit after that stdout in `RuntimeStateDoc`:

1. Consumers render outputs in document array order.
2. `StreamTerminals` clears its buffer at every non-stream boundary so later
   stdout starts a fresh manifest; clearing before flushing would lose text.

Every `JupyterMessageContent::ErrorOutput` and `DisplayData` handler in
`jupyter_kernel.rs` therefore awaits
`stream_committer.flush_for_ordering(boundary_flushes).await` before writing
non-stream state.

### `ExecutionDone` rides the priority path

Execution completion travels through the stream committer rather than directly
onto the lifecycle channel:

```rust
stream_committer.flush_then_signal(
    final_stream_flushes,
    LifecycleSignal::ExecutionDone { execution_id: eid },
);
```

The committer commits final stream manifests, then forwards `ExecutionDone` to
the lifecycle channel. The runtime agent calls `KernelState::execution_done`,
writing `set_execution_done(eid, true)` strictly after the final output.

`KernelIdle` rides the lifecycle channel directly (`crates/runtimed/src/jupyter_kernel.rs`)
so queue release never waits on stream commits; only `ExecutionDone` must wait.

Even when an execution produces no stream output, `flush_then_signal` enqueues
an empty priority commit instead of bypassing to `lifecycle_tx`
(`crates/runtimed/src/stream_committer.rs`, tested by
`flush_then_signal_without_flushes_rides_priority_queue`). That keeps
`ExecutionDone` ordered behind any earlier priority stream commit.

### Rejected alternative: synchronous writes in the IOPub reader

Awaiting `state.with_doc(...)` on every IOPub chunk blocks the reader on blob
writes and Automerge transactions, leaving `status: idle` unread behind output
throughput. Offloading commits to the committer keeps the IOPub reader draining.

## Decision 4: Output-widget replay is non-blocking and best-effort

A Jupyter Output widget captures outputs emitted during execution and replays
them as widget state. On IOPub ingress, the daemon writes the manifest to
`RuntimeStateDoc.comms[comm_id].outputs` (durable record) and sends a
`SendCommUpdate` to the kernel shell channel via `try_send_comm_update`
(`crates/runtimed/src/jupyter_kernel.rs`). If the work channel is full,
the replay drops with a `debug` log while the durable record stays intact.

Best-effort replay rests on two properties:

1. **`RuntimeStateDoc.comms[*].outputs` is the source of truth.** Kernel-side
   replay only aids kernel code inspecting its own widget; later updates
   overwrite the same comm property.
2. **Replay floods must never block the IOPub reader.** Awaiting `work_tx`
   stalls the IOPub reader (which holds `is_registered_execution`), delaying the
   next queued cell for seconds even after `KernelIdle` arrives. Dropping on
   full turns channel backpressure into safe load shedding.

## Decision 5: `update_display_data` coalesces by `display_id` off the hot path

Progress bars (such as `tqdm`) emit hundreds of `update_display_data` messages
per second for one `display_id`. `crates/runtimed/src/display_update_committer.rs`
coalesces them off the IOPub reader:

1. Only the latest update per `display_id` matters semantically.
2. Rewriting matching display manifests in `RuntimeStateDoc` is too slow for the
   IOPub hot path.
3. Terminal status must still wait for the latest pending update so readers
   after `ExecutionDone` see the final frame.

The committer stores `HashMap<String, PendingDisplayUpdate>` keyed by
`display_id`. `request_update` overwrites the map entry and calls
`Notify::notify_one`. `Notify` is only a wake hint; the map is the queue, so
burst arrivals do not allocate per-update permits. On wake, the committer drains
the map through `apply_display_manifest_updates`.

### Flush ordering before `ExecutionDone`

On `status: idle`, `crates/runtimed/src/jupyter_kernel.rs` awaits:

```rust
display_update_committer.flush_for_ordering().await;
```

The committer's priority arm drains the pending map and acknowledges via a
oneshot before `stream_committer.flush_then_signal` enqueues `ExecutionDone`.
End-to-end completion order is therefore:

`pending display updates committed -> final stream output committed -> ExecutionDone enqueued -> set_execution_done written -> consumer reads`

### Rejected alternatives

- **Coalescing inside the IOPub reader:** Still executes slow Automerge
  transactions on the reader task under heavy load.
- **Writing every `update_display_data` immediately:** Causes the IOPub reader
  (`AsyncRead`) to lag by hundreds of milliseconds during `tqdm` loops, masking
  kernel stall backpressure.

## Decision 6: `required_heads` is a causal precondition, not a strict barrier

The daemon executes cell source from its own `NotebookDoc` replica. To prevent
executing stale source before client edits sync, the client captures its current
`NotebookDoc` heads and attaches them as `required_heads`:

```rust
let required_heads = handle.current_heads_hex()?;
let response = handle.send_request_after_heads(request, required_heads).await;
```

The frontend captures heads first and then invokes its flush hook
(`NotebookClient.requiredHeadsOptions` in `packages/runtimed/src/notebook-client.ts`),
ensuring the requested heads are already in flight on the sync stream.

Before dispatching, the daemon's request worker calls `wait_for_required_heads`
(`crates/runtimed/src/notebook_sync_server/peer_writer.rs`), listening
on `changed_tx` until `get_change_by_hash` finds every required head in
`NotebookDoc`.

### Fail-closed 10-second timeout

Waiting indefinitely on a disconnected client would deadlock the request worker.
After 10 seconds, the daemon returns
`NotebookResponse::Error { error: "Timed out waiting for required notebook heads" }`
(`wait_for_required_heads` in `crates/runtimed/src/notebook_sync_server/peer_writer.rs`)
without running stale source. Clients decide whether to retry.

### Rejected alternative: passing cell source in the request

Sending source alongside `cell_id` creates two competing truths (request payload
vs `NotebookDoc`). Running request text makes other room peers blind to what
executed; preferring `NotebookDoc` makes the payload redundant. Cell-ID-only
requests gated by `required_heads` guarantee every peer can observe the exact
source executed.

## Decision 7: Execution state splits across `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`

| Document | Purpose | Frame |
|----------|---------|-------|
| `NotebookDoc` | Cell source, structure, metadata, `cell.execution_id` pointer | `0x00` |
| `RuntimeStateDoc` | Execution queue, lifecycle, outputs, kernel status, comm topology/routing | `0x05` |
| `CommsDoc` | Mutable widget comm state (ADR 0002) | `0x09` |

Keeping execution documents separate provides four properties:

1. **Isolated write cadences.** Human keystrokes in `NotebookDoc` do not contend
   with kernel output floods in `RuntimeStateDoc`.
2. **Frame-level writer authority.** `NotebookDoc` accepts editor/owner writes;
   `RuntimeStateDoc` sync rejects ordinary client writes and admits only
   policy-validated runtime-peer updates while the coordinator owns execution
   intent; `CommsDoc` carries mutable widget values (`identity-and-trust.md`
   Decision 5).
3. **Distinct local persistence.** `NotebookDoc` exports to `.ipynb`; local
   `RuntimeStateDoc` is ephemeral and rebuilt on daemon restart.
4. **Independent sync streams.** Distinct frame types and `sync::State` objects
   prevent an output storm from stalling source edits.

`required_heads` (Decision 6) gates `NotebookDoc` only; terminal waits
(Decision 1) read `RuntimeStateDoc` only. Consumers join them at read time.

## Worked examples

### Single cell, modest output

1. User types `print(2+2)`. The WASM peer updates `NotebookDoc` and queues sync.
2. User clicks run. The frontend captures `current_heads_hex()`, triggers its
   flush hook, and sends `executeCell` with `required_heads`
   (`NotebookClient.requiredHeadsOptions` in `packages/runtimed/src/notebook-client.ts`).
3. Daemon's request worker receives `ExecuteCell { cell_id, execution_id: None }`
   with `required_heads`, runs `wait_for_required_heads`, and proceeds once all
   heads are present.
4. Handler reads source from `NotebookDoc`, mints `execution_id`, writes
   `executions[eid] = { status: "queued", source, ... }`, updates `queue`, and
   replies `CellQueued { execution_id, cell_id }`.
5. Runtime agent syncs `RuntimeStateDoc`, runs `KernelState::queue_cell` and
   `process_next`, flips status to `running`, and sends ZMQ `execute_request`.
6. Kernel emits `status: busy`, `execute_input`,
   `stream { name: "stdout", text: "4\n" }`, and `status: idle`.
7. IOPub reader appends stdout to `StreamTerminals` and triggers a periodic
   flush committing a stream manifest to `executions[eid].outputs`.
8. On `status: idle`, the reader enqueues `KernelIdle`, awaits
   `display_update_committer.flush_for_ordering().await`, and calls
   `stream_committer.flush_then_signal(final_flushes, ExecutionDone { eid })`.
9. Stream committer's priority arm commits final stream output and forwards
   `ExecutionDone` to the lifecycle channel.
10. Runtime agent's lifecycle arm handles `KernelIdle` (status -> idle) and then
    `ExecutionDone` (`set_execution_done(eid, true)`, releases queue).
11. Frontend observes `status: "done"` and renders the stream manifest.

### Cell with a tight progress-bar loop

1. Cell runs `for i in range(10000): bar.update()` on an `IntProgress` widget.
2. Each `bar.update()` emits IOPub `comm_msg(update)` with the new `value`.
3. IOPub reader sends `CommCoalesceMessage::StateDelta { comm_id: bar_id, delta }`
   to the background coalescing writer over `comm_coalesce_tx` instead of writing
   directly on the IOPub hot path (`RuntimeStateDoc.comms[bar_id]` holds comm
   topology; Output-widget `try_send_comm_update` replay is separate).
4. The coalescing writer merges repeated `value` updates per `comm_id` in memory
   and flushes the batch every 16ms via `CommsDoc::merge_comm_state_delta`,
   updating `CommsDoc.comms[bar_id]` (the state map directly, with no `.state`
   sub-map) in one Automerge transaction.
5. User clicks interrupt. `RuntimeAgentRequest::InterruptExecution` clears the
   local queue, calls `mark_interrupted_executions_failed`, and sends ZMQ
   interrupt.
6. Kernel emits `KeyboardInterrupt`, late comm updates, and `status: idle`.
7. `KernelIdle` enters the unbounded lifecycle channel. Because the IOPub reader
   offloaded comm commits to the coalescing writer, `status: idle` is read
   promptly, and the `biased;` select runs the lifecycle arm ahead of any
   pending bounded work commands, releasing the queue immediately.
8. On its next 16ms tick, the coalescing writer commits the final merged delta
   to `CommsDoc.comms[bar_id]`, so `CommsDoc` holds the authoritative latest
   widget state without delaying interrupt or queue release.

### `update_display_data` storm

1. Cell runs `for i in range(1000): display(Image(...), display_id="x")`.
2. Each `UpdateDisplayData` calls
   `display_update_committer.request_update(display_id, data, metadata, buffers)`,
   overwriting `"x"` in the pending map and posting an idempotent `notify_one`.
3. The committer drains the map and commits the latest manifest for `"x"` to
   `RuntimeStateDoc` while newer updates coalesce into the map for the next
   wake.
4. On `status: idle`, the IOPub reader awaits
   `display_update_committer.flush_for_ordering().await`, draining the map one
   last time before the oneshot ack.
5. Stream committer flushes final stream output and sends `ExecutionDone`.
6. Readers observing `status: "done"` see the final rendered state of `"x"`.

## Open Follow-ups

- **Validate lossy queue bounds under load (EP-5):** Review the three independent lossy
  queue bounds against heavy widget and display-update workloads to confirm they
  neither drop too early nor buffer excessively: work channel capacity (`100` in
  `jupyter_kernel.rs`), periodic stream flush queue
  (`STREAM_COMMITTER_QUEUE_CAPACITY = 32` in `stream_committer.rs`), and pending
  display-ID coalescing cap (`MAX_PENDING_DISPLAY_IDS = 128` in
  `display_update_committer.rs`).

## References

- `crates/runtimed/src/stream_committer.rs`: bounded periodic + unbounded
  priority paths, `flush_then_signal`, `flush_for_ordering`.
- `crates/runtimed/src/display_update_committer.rs`: coalesced display updates
  and priority flush ack.
- `crates/runtimed/src/output_prep.rs`: `LifecycleSignal`, `WorkCommand`,
  `NonBlockingSender`, and `queue_command_channels`.
- `crates/runtimed/src/runtime_agent.rs`: lifecycle/work `biased;` select arms
  and `drain_lifecycle_commands`.
- `crates/runtimed/src/jupyter_kernel.rs`: IOPub `status: idle`,
  `UpdateDisplayData`, `try_send_comm_update`, and `CommCoalesceMessage`
  handling.
- `crates/runtimed/src/kernel_state.rs`: `execution_done` and
  `set_execution_done`.
- `crates/notebook-sync/src/execution_wait.rs`: two-phase terminal wait and
  output-sync grace.
- `crates/runtimed/src/notebook_sync_server/peer_writer.rs`:
  `wait_for_required_heads` gate.
- `crates/runt-mcp/src/execution.rs`: MCP consumer pattern.
- `.agents/skills/execution-pipeline/SKILL.md`: agent-facing pipeline summary.
- `crates/runtimed/AGENTS.md`: "Lifecycle and output ordering" scoped rules.
