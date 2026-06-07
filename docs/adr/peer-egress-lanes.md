# Peer Egress Lane Split Investigation

**Status:** Draft, 2026-05-28.

**Update, 2026-06-07:** The first implementation step has landed:
`PeerWriter` now classifies frames into `Reliable` and `Ephemeral` lanes, with
presence and broadcasts isolated from reliable sync/response traffic. This
document remains the investigation record for the remaining work: metrics,
reserved control capacity, explicit barriers, and runtime-state catch-up.

## Context

The three-document split gives `NotebookDoc`, `RuntimeStateDoc`, and `PoolDoc`
separate sync states, frame types, ingress validators, and broadcast sources.
The original investigation found that the split still collapsed at the final
per-peer egress point:

- `PeerWriter::send_frame` sends every steady-state outbound frame through one
  bounded `mpsc` (`PEER_OUTBOUND_QUEUE_CAPACITY = 1024`) with `try_send`
  (`crates/runtimed/src/notebook_sync_server/peer_writer.rs:14,57-77`).
- `spawn_peer_writer` drains that one FIFO and writes typed frames to the one
  socket (`peer_writer.rs:117-136`).
- Bootstrap frames are still written synchronously before steady-state starts;
  the shared queue applies after `run_sync_loop_v2` creates `PeerWriter`
  (`peer_loop.rs:100-128`).

This kept the socket write half single-owner and prevented concurrent byte
interleaving, but it also meant a slow peer or high-volume runtime-state sync
could consume the same bounded queue needed by request responses,
readiness/status frames, notebook-doc sync, pool updates, presence, and
broadcasts. The current implementation fixes the broadest version of that
problem by splitting reliable and ephemeral lanes; it has not yet added reserved
control capacity or runtime-state resync recovery.

## Current Producers

All steady-state producers share the same `PeerWriter` queue:

| Frame | Producers | Pressure profile | Consequence if delayed or rejected |
|-------|-----------|------------------|------------------------------------|
| `0x02 Response` | request worker replies; request-queue full/closed errors; blob upload worker replies | Low volume, user/action critical | RPC promises hang or fail; execution queue responses become flaky. |
| `0x07 SessionControl` | session phase transitions after notebook/runtime sync and streaming load | Low volume, control-plane critical | Frontend can keep fail-closed UI state or observe readiness late. |
| `0x00 AutomergeSync` | notebook-doc sync replies, notebook-doc broadcast fanout, broadcast lag recovery | User-paced except streaming load/import | Cell source/metadata/save sync can sit behind runtime output churn. |
| `0x05 RuntimeStateSync` | runtime-state sync replies and state-change fanout | Highest volume: outputs, queue, lifecycle, env, widget comm state | Can occupy the queue during stdout/widget/display floods. |
| `0x06 PoolStateSync` | pool sync replies and pool state fanout | Low to moderate, daemon-global | Pool banners and env state become stale for this peer. |
| `0x04 Presence` | presence updates, snapshots, lag recovery | Potentially chatty but lossy-ish UX | Cursor/selection state lags; should not block control frames. |
| `0x03 Broadcast` | surviving kernel `Comm` custom-message broadcasts | Usually lower volume than runtime sync, but individual widget messages can carry buffers | Widget custom messages can lag or fail independently of durable comm state. |

The current `try_send` behavior is intentional: producers do not wait for a
slow socket drain. The cost is that queue saturation becomes a producer error
and commonly tears down the peer loop rather than applying backpressure in a
lane-aware way.

## Ordering Constraints

A split must preserve these constraints:

1. **One writer owns the socket.** Multiple tasks must not call
   `send_typed_frame` on the same write half. Lane splitting belongs inside a
   single writer actor/scheduler, not as multiple socket writer tasks.
2. **Per-document sync messages remain ordered.** Each Automerge
   `sync::State` is advanced when a sync message is generated, before the peer
   has necessarily received it. Reordering messages within a document stream
   is unsafe.
3. **Session-control phase frames have local barriers.** Existing code queues
   the session status after the sync frame that just advanced that phase. For
   example, `handle_runtime_state_frame` may queue a `RuntimeStateSync` reply,
   then `run_sync_loop_v2` queues `SessionControl { runtime_state: Ready }`
   (`peer_loop.rs:291-311`). A priority lane must not allow the status frame
   to overtake the sync reply it describes.
4. **Global ordering across unrelated documents is not the durable contract.**
   The frontend demuxes by frame type and relies on Automerge causal sync per
   document plus request ids for responses. Cross-document order should not be
   treated as an API except for explicit phase/barrier relationships.
5. **RuntimeStateSync is high volume but not trivially droppable.** Unlike
   presence, an encoded sync message has already advanced that peer's
   `sync::State`. Dropping or coalescing encoded messages requires resetting or
   regenerating peer sync state deliberately.

## Recommended Shape

Do not start with "one queue per frame type and biased select" alone. That
would improve latency but can violate the session-control barrier above. The
lowest-risk first split isolates ephemeral traffic without changing reliable
sync/response ordering.

Recommended staged design:

1. **Add lane instrumentation first.** Record enqueue depth, full/rejected
   counts, and write latency by frame type. This gives CI/nightly evidence for
   whether runtime-state output floods are the dominant source of queue
   pressure.
2. **Introduce a `PeerEgressLane` classifier and a single scheduler task.**
   Keep one socket writer, but enqueue frames into lanes. Start with:
   - `Reliable`: `Response`, `SessionControl`, `AutomergeSync`,
     `RuntimeStateSync`, `PoolStateSync`.
   - `Ephemeral`: `Presence`, `Broadcast`.
3. **Only then add a control lane with reserved capacity.** `Response` frames
   are id-correlated and may be globally reordered, but some
   `SessionControl` frames summarize a preceding sync frame. That makes a
   naive "control always first" lane unsafe.
4. **Represent barriers explicitly.** A `SessionControl` frame that reports a
   doc phase must carry a dependency on the immediately preceding sync frame for
   that doc. The scheduler may prioritize control frames only after their
   barrier frame has been written.
5. **Keep per-lane FIFO order.** The scheduler may choose between lanes, but it
   must never reorder frames inside one lane.
6. **Treat runtime-state overflow as a resync event, not arbitrary loss.** If
   the runtime lane fills, prefer marking that peer as needing a fresh
   `RuntimeStateDoc` sync and regenerating from current state when capacity
   returns. Do not drop encoded `RuntimeStateSync` frames without resetting the
   corresponding `sync::State`.

## Draft Implementation Plan

### PR 1: observability and contract tests

- Add `PeerEgressLane` classification.
- Keep the existing FIFO writer.
- Log/metric queue depth and full errors by lane and frame type.
- Add tests that pin the current control barrier ordering:
  `RuntimeStateSync` reply before `SessionControl(runtime_state=Ready)`, and
  notebook sync reply before `SessionControl(notebook_doc=Interactive)`.

### PR 2: scheduler without semantic drops

- Replace the single `mpsc<OutboundFrame>` receiver with a single writer actor
  that owns a `Reliable` queue and an `Ephemeral` queue.
- Preserve per-lane FIFO.
- Prefer `Reliable` over `Ephemeral` when both are ready.
- Bound or coalesce `Ephemeral` pressure before it can reject reliable frames.
- Keep overflow behavior fail-closed initially so this PR changes latency and
  isolation, not delivery semantics.

### PR 3: control reservation and barriers

- Split `Response` into a reserved-capacity control lane.
- Keep phase-related `SessionControl` with the sync frame it summarizes, or add
  explicit barrier tokens before allowing it to use the control lane.
- Add tests that a runtime-state flood cannot delay an unrelated response once
  the reserved lane exists.

### PR 4: runtime-state catch-up policy

- Add a lane-full recovery path for `RuntimeStateSync`.
- On runtime lane saturation, invalidate that peer's runtime sync state and
  enqueue one catch-up generation when capacity returns.
- Test with a synthetic runtime output burst that response/session-control
  frames still reach the peer promptly and the RuntimeStateDoc replica
  converges after the burst.

## Non-Goals

- Do not split the socket into multiple OS-level streams in this pass. That is
  a protocol/topology change, not a peer-writer refactor.
- Do not make presence or widget custom broadcasts more durable than they are.
  Durable widget state already lives in `RuntimeStateDoc`; custom broadcasts are
  still ephemeral.
- Do not use an unbounded outbound queue for everything. That hides the failure
  and allows a dead or slow peer to accumulate memory without a clear cap.

## Open Questions

1. Should `Broadcast::Comm` live in `Control` or `Ancillary`? The durable widget
   state path suggests ancillary, but custom comm messages are user-visible.
2. Should `PoolStateSync` have its own lane or share ancillary with presence?
   Pool state is daemon-global but not usually critical to notebook execution.
3. Should queue-full behavior disconnect only the slow peer, or should some
   lanes shed/recover while preserving the connection?
4. Can `RuntimeStateDoc` sync generation move closer to the writer so runtime
   lane coalescing regenerates from current state instead of handling already
   encoded messages?
5. Should frontend output projection serialize per-cell async materialization?
   A lane split can increase runtime burstiness, and `applyOutputChangeset`
   awaits blob resolution. The frame protocol does not require global ordering,
   but the projection path should still prevent stale async writes.
