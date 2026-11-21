# Peer Egress Lanes

**Status:** In progress, 2026-06-07. `Reliable` and `Ephemeral` lanes landed; metrics, reserved control capacity, explicit barriers, and runtime-state resync remain open.

## Context

The document split gives `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and daemon-scoped `PoolDoc` separate sync states, frame types, ingress validators, and broadcast sources.

Originally, that split collapsed at the per-peer egress boundary:

- `PeerWriter::send_frame` in `crates/runtimed/src/notebook_sync_server/peer_writer.rs` pushed every steady-state outbound frame into one bounded `mpsc` (`PEER_OUTBOUND_QUEUE_CAPACITY = 1024`) with `try_send`.
- `spawn_peer_writer` drained that single FIFO onto the peer socket.
- Bootstrap frames still write synchronously before steady-state begins; `PeerWriter` takes over once `run_sync_loop_v2` starts in `crates/runtimed/src/notebook_sync_server/peer_loop.rs`.

That kept the socket write half single-owner and prevented byte interleaving. However, a slow peer or high-volume `RuntimeStateSync` flood could starve request responses, session readiness, notebook sync, pool updates, presence, and broadcasts.

The first implementation step isolated ephemeral traffic into its own lane. All reliable traffic still shares one bounded queue, without reserved control capacity or runtime-state resync recovery.

## Producers and Current Lanes

Steady-state producers feed `PeerWriter` through `PeerEgressLane::classify`:

| Frame | Current lane | Producers | Pressure profile | Consequence if delayed or rejected |
|-------|--------------|-----------|------------------|------------------------------------|
| `0x02 Response` | `Reliable` | Request worker replies; request-queue full/closed errors; blob upload worker replies | Low volume, user/action critical | RPC promises hang or fail; execution queue responses become flaky. |
| `0x07 SessionControl` | `Reliable` | Session phase transitions after notebook/runtime sync and streaming load | Low volume, control-plane critical | Frontend keeps fail-closed UI state or observes readiness late. |
| `0x00 AutomergeSync` | `Reliable` | Notebook-doc sync replies, broadcast fanout, broadcast lag recovery | User-paced except streaming load/import | Cell source, metadata, and save sync sit behind runtime output churn. |
| `0x05 RuntimeStateSync` | `Reliable` | Runtime-state sync replies and state-change fanout | Highest volume: outputs, queue, lifecycle, env, widget comm state | Can fill the lane during stdout, widget, or display floods. |
| `0x06 PoolStateSync` | `Reliable` | Pool sync replies and pool state fanout | Low to moderate, daemon-global | Pool banners and env state go stale for this peer. |
| `0x04 Presence` | `Ephemeral` | Presence updates, snapshots, lag recovery | Chatty, lossy-tolerant UX | Cursor and selection state lag; must not block control frames. |
| `0x03 Broadcast` | `Ephemeral` | Surviving kernel `Comm` custom-message broadcasts | Lower volume than runtime sync, though messages can carry buffers | Widget custom messages lag or fail independently of durable comm state. |

Other reliable frame types (`Request`, `CommsDocSync`, `CommentsDocSync`, `KeyedDocSync`, `PutBlob`) also classify into `Reliable`.

Using `try_send` is intentional: producers must not block on a slow socket drain. The tradeoff is that queue saturation becomes a producer error and usually tears down the peer loop instead of applying lane-aware backpressure.

## Ordering Constraints

Every lane split must preserve five invariants:

1. **One writer owns the socket.** Multiple tasks must never call `send_typed_frame` on the same write half. Lane scheduling belongs inside one writer actor, not multiple writer tasks.
2. **Per-document sync messages stay ordered.** Each Automerge `sync::State` advances when a sync message is generated, before the peer receives it. Reordering messages within a document stream is unsafe.
3. **Session-control phase frames have local barriers.** Existing code queues session status immediately after the sync frame that advances that phase. For example, `handle_runtime_state_frame` queues a `RuntimeStateSync` reply before `run_sync_loop_v2` queues `SessionControl { runtime_state: Ready }` in `peer_loop.rs`. A priority lane must never let status overtake the sync reply it describes.
4. **Cross-document global order is not a durable contract.** The frontend demuxes by frame type and relies on per-document Automerge causal sync plus request ids for responses. Only explicit phase barriers require cross-type ordering.
5. **`RuntimeStateSync` is high volume, not trivially droppable.** Unlike presence, an encoded sync frame has already advanced that peer's `sync::State`. Dropping or coalescing encoded frames requires explicitly resetting or regenerating peer sync state.

## Decision

Split peer egress inside a single writer actor in stages. Do not jump to "one queue per frame type with biased select" — that can violate the `SessionControl` barrier above.

Isolate ephemeral traffic first without changing reliable ordering. Keep per-lane FIFO order in every stage: the scheduler may choose between lanes, never reorder within a lane. Add reserved control capacity only alongside explicit barrier tracking, and treat `RuntimeStateSync` overflow as a resync event rather than silent frame loss.

## Done

- Added `PeerEgressLane` (`Reliable` and `Ephemeral`) in `crates/runtimed/src/notebook_sync_server/peer_writer.rs` (2026-06-07).
- Split `PeerWriter` into separate bounded `Reliable` and `Ephemeral` `mpsc` channels (`PEER_OUTBOUND_QUEUE_CAPACITY = 1024` each), keeping one `spawn_peer_writer` socket task.
- Isolated `Presence` (`0x04`) and `Broadcast` (`0x03`) into `Ephemeral` while preserving FIFO order across all `Reliable` sync and response frames.

## Next

1. **Add lane instrumentation.** Record enqueue depth, full/rejected counts, and write latency by frame type. Use CI and nightly data to confirm whether runtime-state output floods dominate `Reliable` queue pressure.
2. **Add explicit phase barriers.** Attach a dependency from each doc-phase `SessionControl` frame to the preceding sync frame for that document. Prioritize control frames only after their barrier frame is written.
3. **Add a control lane with reserved capacity.** Separate `Response` and barrier-tracked `SessionControl` frames from bulk sync once barrier enforcement is in place. `Response` frames are id-correlated and can reorder globally; `SessionControl` frames wait on their barrier.
4. **Handle runtime-state overflow as resync.** When the runtime lane fills, mark the peer as needing a fresh `RuntimeStateDoc` sync and regenerate from current state once capacity returns. Never drop encoded `RuntimeStateSync` frames without resetting the peer's `sync::State`.

## Non-Goals

- Splitting the socket into multiple OS-level streams. That is a protocol and topology change, not a peer-writer refactor.
- Making presence or widget custom broadcasts durable. Durable widget state lives in `RuntimeStateDoc` and `CommsDoc`; custom broadcasts stay ephemeral.
- Using unbounded outbound queues. Unbounded queues hide backpressure and let a slow or dead peer grow memory without cap.
