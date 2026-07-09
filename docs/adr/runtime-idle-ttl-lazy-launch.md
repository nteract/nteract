# Runtime Idle TTL and Lazy Launch On Execute

**Status:** Accepted, 2026-07-09.

## Context

Hosted notebook rooms can attach a registered workstation as a room-scoped
`runtime_peer`. The workstation supplies compute and writes accepted runtime
state, but the room host remains the authority for execution intent, runtime
peer admission, selected runtime session, and visible notebook state.

Compute should not stay live only because a notebook page is open. Browser tabs,
editor sockets, viewer sockets, and anonymous public viewers are document
presence, not execution demand. A hosted runtime that has no active or queued
execution is idle even when people are still reading the notebook.

Source note: `.context/runtime-idle-ttl-lazy-launch.md`.

The durable source anchors are:

- `apps/notebook-cloud/src/notebook-room.ts`
- `apps/notebook-cloud/src/storage.ts`
- `crates/runtimed-wasm/src/lib.rs`
- `crates/notebook-cloud-transport/src/lib.rs`
- `crates/runtimed/src/runtime_agent.rs`
- `crates/runtimed/src/workstation/agent_loop.rs`

## Decision 1: Idleness Is Execution-Only

Hosted runtime idle teardown is based only on runtime execution activity:

- an executing entry in `RuntimeStateDoc`;
- a `running` execution status;
- queued execution entries.

Room occupants do not keep compute alive. Owner, editor, viewer, runtime UI,
and anonymous viewer sockets are excluded from the idle decision. Anonymous
viewers never defer hosted compute teardown.

When the idle alarm fires, the room host reads the execution activity projection
from `runtimed-wasm`. If execution is active or queued, teardown is deferred. If
there is no runtime peer, the room only republishes the compute-session summary.
If a runtime peer is present and execution is idle, the room reconciles the
runtime state to an idle terminal projection and then closes runtime-peer
sockets.

The idle reconcile preserves the workstation attachment's existing `updated_at`.
Internal room-host rewrites change status and message, but they do not advance
the timestamp used to reject stale cross-session workstation publishes.

## Decision 2: The Idle TTL Is A Compile-Time Constant

The v1 hosted runtime idle TTL is fixed at 30 minutes:

```text
RUNTIME_IDLE_TTL_MS = 30 * 60_000
```

The constant lives in `apps/notebook-cloud/src/notebook-room.ts`. The room arms
the idle alarm from runtime-peer and execution-state transitions. There is no
per-notebook, per-workstation, or server-configured TTL policy in v1.

## Decision 3: Launch On Execute Uses Attach-Job Triggers

Workstation attach jobs carry a `trigger` field:

```text
user_attach
resume
```

`user_attach` preserves eager attach behavior. A user explicitly attaches a
workstation, the workstation agent receives the job, and the spawned
cloud-runtime-agent applies its initial current-Python `LaunchKernel` template
after initial `RuntimeStateDoc` sync.

`resume` represents lazy launch-on-execute. Owner execution that finds no
runtime peer creates or reuses a workstation attach job with trigger `resume`.
The workstation agent spawns the cloud runtime agent with launch mode
`execute`. The runtime agent holds the initial current-Python `LaunchKernel`
template until `RuntimeStateDoc` sync observes queued execution intent while no
kernel exists. It then applies the same runtime-agent launch path as an inbound
`LaunchKernel` RPC.

If an explicit `user_attach` request deduplicates onto an active `resume` job
for the same workstation, the stored job is upgraded to `user_attach` so the
workstation agent sees the eager intent on the next poll.

Any successful inbound `LaunchKernel` or `RestartKernel` RPC clears a pending
initial launch template. That prevents an old launch-on-execute template from
firing after a different environment has already launched.

## Decision 4: Idle Teardown Uses A Graceful Terminal Close Protocol

Idle teardown is a clean terminal shutdown, not a runtime-agent failure.

The room host first commits the idle reconcile in `RuntimeStateDoc`, delivers
the resulting sync frames to peers, and only then closes runtime-peer sockets.
This ordering lets viewers and the runtime peer observe the terminal idle state
before the runtime peer disconnects.

The close reason is cross-language pinned:

```text
runtime idle timeout
```

The room sends the terminal close as a cloud room close with that reason. The
Rust transport mirrors the same literal in
`RUNTIME_IDLE_TIMEOUT_CLOSE_REASON` and treats only room-authored close errors
ending in `reason=runtime idle timeout` as graceful shutdown. Frame rejections
or other permission errors that merely contain the phrase remain terminal
failures.

The runtime agent treats a graceful terminal close as a clean exit. It does not
set a terminal runtime-agent error for the job.

## Decision 5: Hosted Resume Is Owner-Only

Hosted execution that can spend remote compute is owner-only in v1. Editors can
edit notebook content when ACLs allow it, but edit authority is not compute
authority.

When owner execution needs to resume an idle workstation, the room creates the
resume attach job under the notebook owner's principal and uses actor label:

```text
execution resume
```

Runtime peers remain fenced by selected workstation id and runtime session id.
The room does not accept a stale runtime peer from an older attach job just
because it can authenticate as `runtime_peer`.

## Consequences

Open notebook pages no longer imply live hosted compute. A notebook can remain
readable while its runtime is idle and detached.

The first owner execution after idle teardown may include workstation attach and
kernel launch latency. The room still records execution intent in
`RuntimeStateDoc`, so the launch-on-execute runtime agent starts from the same
queued execution model as eager launch.

The room-host idle reconcile is now a durable state transition. It must commit
and sync before sockets close. Tests should cover ordering whenever this path
changes.

The close reason is protocol surface. Changing the string requires coordinated
updates across the room host, `notebook-cloud-transport`, and runtime-agent
tests.

The fixed 30-minute TTL is simple and reviewable, but it cannot express
notebook-specific or workstation-specific cost and latency preferences.

## Future Work

- Add a force-keep-alive pin per notebook for Kyle's hosted workflows.
- Add per-notebook and per-workstation TTL policy after v1 has usage evidence.
- File and fix the `uses_fresh_port_retry` lazy-path banner gap as a follow-up.
