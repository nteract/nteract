# Execution Liveness: Detecting Divergence, Not Policing Time

**Status:** Exploration, 2026-05-23.

This is a design memo, not an ADR. It explores what "stuck execution" actually means in nteract, why a wall-clock watchdog is the wrong frame, and what shape a real fix would take. Code is a follow-up after review.

Neighbors:

- `docs/adr/execution-pipeline.md` — the seven invariants behind cell execution.
- `docs/adr/document-split.md` — `RuntimeStateDoc` as the durable record.
- `docs/adr/identity-and-trust.md` — who is allowed to interrupt or restart.
- `docs/adr/execution-pipeline.md` — EP-3 in its tracked follow-ups links here.

## Context

The cleanup punchlist's EP-3 row originally read:

> No daemon-side execution watchdog. A panic or task drop occurs between the
> final output write and `set_execution_done`, the execution stays in `running`
> forever. Consumers time out; the daemon has no signal to clean up.
> `KernelDied` is only fired on IOPub disconnect.

The implied fix was a timer: if an execution has been at `status: "running"` past some threshold, force it to terminal. That fix is wrong, and the wrongness comes from misreading the user's behavior.

### The user behavior the watchdog framing misses

nteract is a notebook environment. The canonical thing users do in notebook environments is start a long-running computation and walk away. Two examples that the daemon must handle as *normal*, not as anomalies:

1. **Model training jobs.** A user kicks off a fine-tune on a 70B model and goes to lunch. Or to sleep. The cell runs for six hours. The kernel emits a status line every ten minutes. The desktop window is closed, but the daemon is still running, the kernel is still computing, and the user expects to come back, reopen the notebook, and watch the same execution finish.

2. **Streaming inference / long pipelines.** A user runs a cell that processes a 50 GB Parquet file. Output trickles in over hours. The kernel is alive and producing data; the daemon is alive and writing manifests; there is nothing wrong.

The desktop app is structured around this pattern. nteract's notebook rooms are daemon-owned, not window-owned: closing the window does not stop the kernel, and reconnecting reattaches to the same execution stream. That property is a feature, not an accident, and a watchdog that force-completes "long-running" executions destroys it.

So the punchlist framing was right about the symptom — sometimes the daemon's view of an execution diverges from kernel reality — but wrong about the cause. Elapsed time is not the signal. **State divergence is.**

## What divergence actually looks like

An execution is at `status: "running"` in `RuntimeStateDoc`. The honest question is: does that match what's happening below?

We have four independent signals about kernel reality:

| Signal | What it tells us | Where it lives |
|---|---|---|
| ZMQ heartbeat | Kernel process is alive and pinging | `jupyter_kernel.rs:2614-2700` (5s interval, 3-failure threshold) |
| IOPub activity | Kernel is *doing* something user-visible (stream, status, comm, display) | IOPub reader in `jupyter_kernel.rs` |
| Shell socket | The execute_request was accepted; reply pending | `jupyter_kernel.rs` shell reader |
| Committer queues | The daemon has buffered output work it has not yet committed | `stream_committer` periodic queue, `display_update_committer` pending map |

A healthy long-running training execution looks like:

- ✅ Heartbeat: alive, no recent failures.
- ✅ IOPub: occasional `stream` messages (loss curves, every-N-step prints) or `status: busy` heartbeats. Even silent kernels emit `status: busy → idle` at cell boundaries.
- ✅ Shell: execute_request pending, expecting a reply.
- ✅ Committer queues: maybe a flush pending, maybe drained.

The execution is genuinely running. Wall-clock is irrelevant.

A *diverged* execution looks like one of:

- ❌ Heartbeat failures over the threshold but no `KernelDied` emitted yet. (Race: the heartbeat task is still cycling.)
- ✅ Heartbeat alive, ❌ IOPub silent for an unusually long stretch *and* shell socket has gone quiet *and* no committer work pending. (Kernel is wedged in C code or a native dead-loop the Jupyter protocol can't reflect.)
- ✅ Heartbeat alive, ✅ IOPub idle status received, ✅ committer queues drained, ❌ `set_execution_done` never called. (The bug EP-3 was originally trying to catch: a panic or task drop in the daemon's own runtime agent between final output flush and terminal status write.)
- ❌ Kernel process gone (Unix `wait_for_pid_exit` returns), ❌ but `KernelDied` not yet propagated. (Race between IOPub disconnect and the heartbeat task's pid check.)

The first three are not catastrophes the daemon should "fix" by force-completing. They are observability signals. The third one — the panic-between-flush-and-`set_execution_done` case — is the only one where the daemon really has lost track and the queue genuinely needs releasing, and it has a clean signature distinct from a real busy kernel.

## What we have today

Two existing mechanisms are useful:

1. **Heartbeat task** (`jupyter_kernel.rs:2614`). Pings the kernel every 5s, 3s timeout, 3 consecutive failures → declares the kernel dead and routes through the existing `KernelDied` path. This already covers the case where the kernel process itself has gone away.

2. **Committer supervisor `KernelDied` on panic** (`stream_committer.rs:227`, `display_update_committer.rs:259`). If a committer task panics, the supervisor emits `KernelDied` on the lifecycle channel and the queue releases. This covers the case where the committers themselves crash.

What we **don't** have:

- A signal for "the runtime agent's own loop panicked between flush and `set_execution_done`."
- An observable for "the kernel hasn't emitted anything on IOPub for an unusual stretch."
- A way to distinguish "user's training job, working as intended" from "wedged native code."

## A divergence-detection shape

The proposal is *not* to write a watchdog. It is to write a **detector** that surfaces divergence without acting on it.

### Three signals, conjunctive

Detect divergence when **all** of:

1. `execution.status == "running"` in `RuntimeStateDoc` for the cell.
2. No IOPub activity (`stream` / `status` / `display_data` / `update_display_data` / `error` / `execute_result` / comm) for `N` seconds. `N` is configurable; a default in the 60-300s range is plausible. Multi-hour training jobs that print every 10 min would still trip this — but the response is observability, not action.
3. Heartbeat is healthy *or* recently unhealthy.

Two flavors of "diverged":

- **Heartbeat alive + IOPub silent + committers drained + no shell reply pending**: kernel is most likely wedged in native code. Surface it. Do not kill.
- **Heartbeat alive + IOPub recently idle + committers drained + `set_execution_done` not called**: the daemon-side EP-3 bug. The runtime agent has lost track. This is the case where queue release is correct — and only when this specific signature is met, not on a timer.

### What detection produces

- A structured log line at `warn` (not `error` — divergence is sometimes intentional from the user's perspective). Fields include `execution_id`, `cell_id`, `seconds_since_last_iopub`, `heartbeat_status`, `pending_committer_work`, `shell_reply_pending`.
- A telemetry counter incremented per divergence event by signature. Operators can wire alerts on these without involving an end-user-visible state change.
- For the specific daemon-side bug signature: an option (`--auto-recover-execution-liveness` off by default) to emit `CellError { reason: "daemon execution liveness gap detected" }` and release the queue. Off by default because the safer thing is to log and let a human read the log; on by default may come later once we have telemetry on false-positive rate.

### What detection does NOT produce

- No "force complete this execution after N minutes."
- No client-visible `cloud_frame_rejected` or `ExecutionDone` write for the kernel-still-computing cases.
- No automatic kill of long-running cells. The user runs them on purpose.

## Where the detector lives

Three candidate placements:

1. **Inside the runtime agent's `select!` loop.** Adds a periodic tick arm that checks per-`running` execution against the four signals. Cheap; same task that owns the data.
2. **A separate `liveness_monitor` supervised task.** Like the heartbeat task but reading shared state. More isolation, but more state to thread through.
3. **A daemon-level periodic sweep.** Aligns with the GC sweep cadence. Wrong placement: per-room concerns don't belong in the daemon-global tick.

Option 1 is the cleanest. The runtime agent already owns `pending_executions`, the committer queue handles, and the IOPub timestamp; a tick arm that reads those and decides "diverged or not" is a small addition.

## Open Questions

1. **What's the IOPub silence threshold?** 60s? 300s? Does it depend on the cell's announced expected runtime (which the user could provide via cell metadata)? A bare model-training cell with no metadata gets the default; a cell tagged `runtime_hint: "long"` gets a longer threshold.

2. **Should we distinguish "no IOPub" from "no IOPub *and* no committer work pending"?** A kernel that's actively printing every 200ms might have IOPub activity sitting in the committer's bounded queue and not yet visible on the wire. The committer queue depth is part of the signal.

3. **Should the detector run when the desktop window is closed?** The daemon stays up; the heartbeat task already runs. The detector should too — if anything, divergence on a long-running closed-window training job is exactly the case worth observing.

4. **What's the right operator-visible surface?** `runt diagnostics` already exists; an `executions liveness` subcommand that walks all rooms and reports any current divergence would be useful. Tied to the existing telemetry counter.

5. **Auto-recovery, eventually?** With enough telemetry on the specific daemon-side bug signature (running + idle IOPub + drained committers + no shell reply), we may decide it's safe to auto-emit `CellError` and release the queue. This is the only signature where the kernel itself genuinely has nothing more to say.

6. **Interaction with reconnect.** When the desktop window reconnects to a long-running cell, what divergence indicators should the frontend see? Probably none — the divergence detector is daemon-side observability, not user-facing. But the frontend may want to surface "this cell has been silent for N minutes; interrupt or wait?" as a separate UX affordance.

7. **Interaction with `KernelInterrupt` / `KernelRestart`.** If a divergence is detected and the user requests interrupt, do we run the normal interrupt path or use the divergence signature to short-circuit (assume the kernel can't respond)? Probably the normal path; interrupt has its own timeout in the existing code.

## Why a memo, not an ADR

This document doesn't commit to a decision. It commits to a *frame*: divergence detection, not time-based watchdogging. The shape of the actual detector — placement, thresholds, recovery policy — is worth designing with telemetry from real use, not from this memo alone.

When a real implementation lands, an ADR can record what we picked and why. Until then this memo is the load-bearing context for "EP-3 in the cleanup punchlist is not a wall-clock watchdog PR."
