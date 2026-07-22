# Kernel stdin control protocol

**Status:** Proposed for [issue #4069](https://github.com/nteract/nteract/issues/4069),
2026-07-21. This memo is an implementation-shaped design for review; it does
not yet change the wire protocol or promise hosted stdin support.

## Summary

Jupyter `input()` and `getpass()` require a request/reply path that nteract
does not currently implement. `JupyterKernel::execute` constructs
`ExecuteRequest::new(...)`, whose `allow_stdin` default is false, and the
kernel connection has no stdin DEALER reader. Enabling that flag alone would
make executions hang because no component can receive or answer the kernel's
`input_request`.

The proposed contract is:

1. stdin is an execution capability, off by default;
2. only an interactive single-cell request may opt in;
3. the runtime agent sends prompts on a new reliable, actor-targeted control
   frame rather than through Automerge or room broadcast;
4. the initiating connection replies through a correlated, scope-checked
   `NotebookRequest` that the coordinator forwards to the active runtime
   peer;
5. the runtime agent accepts exactly one reply for the current prompt and
   cancels it on every execution or connection terminal boundary; and
6. reply values exist only in the client input element, request payload,
   runtime-agent memory, and Jupyter stdin socket. They never enter an
   Automerge document, output, broadcast, diagnostic, or log.

This keeps RuntimeStateDoc authoritative for execution lifecycle without
turning it into a secret transport. Local rooms and direct cloud viewers can
share one wire-level model. Daemon-mediated hosted sessions can reuse that
model only after their bridge preserves the initiating local actor on request
forwarding; the current bridge does not.

## Existing mechanics to preserve

- `RuntimeStateDoc.executions[*].submitted_by_actor_label` already records the
  authenticated actor that created execution intent. The room coordinator
  writes it with the source and sequence number; the runtime peer consumes it.
- Cell execution is CRDT-driven. The runtime agent discovers queued execution
  entries and sends source from RuntimeStateDoc to the kernel. No new code
  payload belongs in the stdin request path.
- Typed-frame writers already distinguish reliable frames from lossy
  `Broadcast` and `Presence` lanes. A prompt that can block a kernel belongs on
  the reliable lane.
- Hosted execution authority is currently owner-only. `editor` and
  `runtime_peer` scopes do not independently grant execution intent.
- Unknown daemon-to-client frame types can be skipped safely by older v4
  clients. Client-to-server additions need capability gating so a newer
  client never sends an unsupported frame or request to an older host.

## Non-goals

- Headless stdin for MCP, Python, scheduled jobs, or agents.
- Interactive `run all`. V1 keeps `allow_stdin = false` for batches.
- Resuming a prompt after its initiating connection disconnects.
- Enabling stdin through the current daemon-mediated hosted bridge before it
  gains an end-actor delegation/return-routing contract.
- Persisting prompt history or replaying prompts to late joiners.
- Letting another owner or editor answer a prompt they did not initiate.
- Treating notebook trust approval as stdin authority. Trust and interactive
  input are separate gates.

## Proposed execution request contract

Add a default-false `allow_stdin` field to `ExecuteCell` and
`ExecuteCellGuarded`, and carry the value into the execution entry that the
runtime agent observes. Older senders omit it and retain current behavior.

The room host accepts `allow_stdin: true` only when all of these are true:

- the request is a single-cell interactive execution;
- the requesting connection has execution authority;
- the connection advertised `kernel_stdin_v1`; and
- the room/runtime peer advertised `kernel_stdin_v1`.

If any condition fails, the host must either force the field false or reject
the opt-in with a typed error. Silent acceptance followed by `allow_stdin =
false` is acceptable only across an older-server compatibility boundary where
the field is ignored; a current host should be explicit.

`RunAllCells`, `RunAllCellsGuarded`, MCP, and Python callers do not expose the
opt-in in V1. Their Jupyter execute requests keep `allow_stdin = false`, so an
attempted `input()` fails in the kernel instead of blocking a queue forever.

## Proposed control payloads

Reserve the next unassigned typed-frame discriminant, currently `0x0b` in
`notebook-wire`, named `KernelStdin`. The implementation must verify the
authoritative enum and byte table before reserving it. Payloads are small JSON
objects with a tight control-frame size cap.

Runtime peer to initiating notebook peer:

```json
{
  "type": "input_prompt",
  "execution_id": "exec-...",
  "prompt_id": "stdin-...",
  "target_actor_label": "<authenticated-actor-label>",
  "prompt": "Password: ",
  "password": true
}
```

Runtime peer to initiating notebook peer when the prompt is no longer valid:

```json
{
  "type": "input_cancelled",
  "execution_id": "exec-...",
  "prompt_id": "stdin-...",
  "target_actor_label": "<authenticated-actor-label>",
  "reason": "interrupted"
}
```

The browser does not send `KernelStdin` directly. It sends a correlated
request on the existing reliable request lane:

```json
{
  "id": "request-...",
  "action": "reply_input",
  "execution_id": "exec-...",
  "prompt_id": "stdin-...",
  "value": "..."
}
```

`ReplyInput` has the same JSON shape in `NotebookRequest` and
`RuntimeAgentRequest`. That lets the local coordinator translate/forward it
through the existing runtime-agent query path, and lets the hosted room route
it through the same response-bearing runtime-peer machinery used by
`Complete`. The reply is an `Ok` or structured stale/unauthorized error.

The value is intentionally absent from all server-originated payloads.

## Routing and authority

### Runtime agent

For each running execution, the runtime agent knows the execution id and reads
its `submitted_by_actor_label`. When Jupyter sends `input_request`, the agent:

1. verifies the execution opted into stdin and has a submitter actor;
2. generates a cryptographically unpredictable `prompt_id`;
3. stores one in-memory `PendingInput` containing execution id, prompt id,
   target actor, and the Jupyter parent/request correlation needed to reply;
4. emits `input_prompt`; and
5. waits for either a matching reply or a cancellation boundary while the
   main control loop continues draining.

The agent rejects a reply unless execution id, prompt id, and submitter actor
all match the current pending input. It consumes a prompt exactly once before
sending `input_reply` to Jupyter. Duplicate and late replies are errors.

### Local daemon room

The coordinator receives `KernelStdin::InputPrompt` from the room's current
runtime agent and enqueues it only to the peer whose authenticated actor label
exactly equals `target_actor_label`. It does not publish the payload on
`kernel_broadcast_tx`, because `NotebookBroadcast` fans out to the room and is
lossy under pressure.

For `ReplyInput`, the request worker compares its authenticated connection
actor label with `submitted_by_actor_label` from the coordinator's own
materialized RuntimeStateDoc, never a value claimed by the request. This is an
authorization check, not merely a routing optimization. The runtime agent
then compares the reply with the actor snapshot and generation held in its
in-memory `PendingInput`; that prompt-generation check remains authoritative
if the coordinator's CRDT projection advances concurrently.

### Hosted room

The Durable Object applies the same rules:

- accept prompt frames only from the selected `runtime_peer`;
- send them only to the currently connected peer with the exact target actor
  label and stdin capability;
- accept `ReplyInput` only from that target peer with current execution
  authority; and
- forward it only to the selected runtime peer, preserving request/response
  correlation.

If the target peer is absent, the room rejects or cancels the prompt. It must
not fall back to another connection sharing the same principal: actor labels
include the operator/session identity precisely so one browser tab or desktop
connection cannot answer another's prompt.

### Daemon-mediated hosted bridge gap

The current hosted bridge forwards a local request as a request from the
bridge WebSocket connection. It does not carry a cloud-verifiable delegation
for the original local peer. Consequently, the hosted room would record the
bridge actor as submitter and cannot safely address a prompt to the original
desktop tab.

Do not enable stdin on this path by treating the bridge principal as the end
user. A later bridge slice must add an authenticated delegation envelope (or
equivalent room-issued mapping) that binds the cloud-visible bridge request
to one local actor, routes the prompt back through that bridge, and makes the
local daemon repeat the exact-actor check before delivery. The cloud room must
accept delegated labels only from a bridge capability that explicitly owns
that delegation surface. Until then, daemon-mediated hosted execution keeps
`allow_stdin = false`.

## Jupyter channel integration

The Jupyter kernel launch path must create an stdin DEALER connection with the
same `PeerIdentity` used for the shell connection. The current shell path
already uses `create_client_shell_connection_with_identity`, and
`jupyter-zmq-client` documents that
`create_client_stdin_connection_with_identity` must receive that same
identity. A fresh unrelated identity can cause the kernel to route
`input_request` somewhere the execution client never reads. A real-kernel
integration test must prove the assumption rather than relying only on the
library contract.

`KernelConnection::execute` gains `allow_stdin: bool` and sets the Jupyter
field explicitly. The stdin reader parses only `input_request`, preserving:

- the kernel request message id;
- `parent_header.msg_id`, which must equal the active execution id;
- the prompt text; and
- the `password` presentation hint.

Malformed, unregistered, or non-active execution parents are rejected and
must not create UI. `input_reply` is sent on the stdin channel using the
original Jupyter routing/correlation data required by the protocol.

The stdin reader feeds a dedicated reliable control channel into the runtime
agent loop. It must not share bounded output/work transport with IOPub
manifests, stream flushes, display updates, or widget replay.

## Lifecycle and cancellation

Exactly one `PendingInput` may exist for the running execution. It is cleared
on:

- an accepted reply;
- interrupt;
- kernel restart or shutdown;
- kernel process death;
- execution terminal state;
- replacement by a protocol-invalid second prompt; or
- loss of the target connection.

Clearing first invalidates the prompt id, then best-effort unblocks Jupyter
with the protocol's cancellation behavior, then sends `input_cancelled` when
the target connection still exists. A late reply therefore observes no
pending prompt and cannot reach a later execution.

`input_cancelled` is not ordered atomically with RuntimeStateDoc's execution
terminal transition. The runtime agent should suppress the cancellation event
after it has published terminal state, but clients must still discard a
cancellation for an execution they already observe as terminal.

The exact kernel-side cancellation payload needs an integration test. An
empty `input_reply` is valid input, not necessarily EOF; if Jupyter provides
no standard EOF reply, interrupt/restart is the reliable cancellation
primitive and the implementation must not claim otherwise.

V1 should also impose a bounded prompt lifetime. The timeout is runtime
policy, not frontend state. On expiry the agent follows the same cancellation
path and records only a non-secret reason/code.

## Frontend behavior

The shared CodeCell execution surface subscribes to a narrow frame-event
ephemeral stdin store keyed by execution id. It is not a RuntimeStateDoc
projection: it has no CRDT backing, persistence, or replay to late joiners.
Desktop and cloud feed it from the same decoded `KernelStdin` frame event, and
session teardown resets it synchronously.

- `password: false` renders a text input.
- `password: true` renders an input with `type="password"`.
- Submit sends `ReplyInput`, disables duplicate submission, and clears the
  value immediately after transport accepts it.
- Cancel invokes the existing interrupt action; it does not invent a local
  reply value.
- `input_cancelled`, execution terminal, session replacement, and disconnect
  remove the prompt.

The value should be held in the DOM input and read through a ref on submit,
not copied into RuntimeStateDoc, a module store, analytics, diagnostics, or a
logger. React local state is not itself durable, but avoiding it reduces the
number of inspectable copies for passwords.

An Elements fixture should cover ordinary input, password input, disabled
submission, cancellation, and constrained width without a live kernel.

## Compatibility

This proposal is additive but crosses both directions of the wire:

- old clients safely skip an unknown server-originated `KernelStdin` frame;
- old servers do not promise to accept new client behavior;
- old runtime peers ignore the new execution field and continue sending
  Jupyter requests with stdin disabled.

Therefore capability negotiation is mandatory even if the implementation
keeps protocol version 4. `kernel_stdin_v1` must be present at the notebook
client, room host/coordinator, and selected runtime peer before a current host
accepts `allow_stdin: true`. A protocol-version bump remains an implementation
option if plumbing the capability through every handshake proves less clear
than a v5 cut; the change must not ship as an unadvertised v4 assumption.

## Security and observability invariants

- Never log a reply value, request payload, serialized `PendingInput`, or
  Jupyter `input_reply` content.
- Prompt text may contain sensitive context. Log only prompt id, execution id,
  actor hash/redacted actor, lifecycle reason, and byte length.
- Diagnostics must summarize pending state without prompt text or value.
- No `input_prompt`, `input_cancelled`, or reply value enters NotebookDoc,
  RuntimeStateDoc, CommsDoc, CommentsDoc, checkpoint storage, or output blobs.
- No room-wide broadcast carries prompt text.
- Hosted ingress verifies scope and exact actor ownership before forwarding a
  reply; the runtime agent repeats correlation checks before kernel delivery.
- Size-limit the value independently of the enclosing request frame. V1 should
  choose a small text ceiling appropriate for interactive input rather than
  inheriting the 16 MiB request cap.

## Implementation slices

1. **Protocol and kernel seam**
   - Add default-false execution opt-in and generated TypeScript contracts.
   - Add the stdin DEALER/read path, same-identity test, explicit Jupyter
     `allow_stdin`, pending-input state machine, and reply method.
   - Keep the feature unreachable from production UI.
2. **Local room routing**
   - Add `KernelStdin` frame/cap, reliable lane, runtime-agent routing, exact
     actor checks, cancellation, and protocol tests.
   - Add a test-kernel scenario proving one prompt, one reply, stale rejection,
     and interrupt cleanup.
3. **Shared desktop UI**
   - Add the ephemeral store, CodeCell surface, Elements fixtures, and desktop
     `allow_stdin` opt-in.
4. **Hosted routing**
   - Add room capability projection, selected-runtime-peer checks, targeted
     WebSocket delivery, and cloud authority tests before enabling the direct
     cloud UI opt-in.
   - Keep daemon-mediated hosted stdin off until the bridge has the delegated
     end-actor contract described above.
5. **End-to-end verification**
   - Real Python `input()` and `getpass()` tests, multi-peer injection tests,
     disconnect/interrupt/restart races, and a diagnostic scan proving the
     submitted sentinel secret appears nowhere outside the live request path.

Each slice can land with stdin still default-off. Product exposure happens
only after the full path for that host has capability negotiation and cleanup.

## Open questions

1. Should `KernelStdin` reserve a new frame byte or become a narrowly typed
   `SessionControl` extension? A new type gives direction, caps, and ingress
   policy an explicit compile-time surface; overloading session readiness is
   smaller but less clear.
2. Is v4 capability negotiation enough, or should bidirectional stdin support
   be the first protocol-v5 feature?
3. What is the tested Jupyter cancellation behavior when no textual reply is
   appropriate? Do not equate an empty string with EOF without evidence.
4. What prompt timeout balances unattended kernels with legitimate long-form
   input? The runtime must own it regardless of duration.
5. Should V2 allow an explicit transfer to another owner connection? V1 does
   not; exact initiating-actor ownership is simpler and safer.

## References

- [Cell Execution Pipeline and Control-Plane Separation](../adr/execution-pipeline.md)
- [Typed-frame v4 Wire Protocol](../adr/typed-frame-v4-wire-protocol.md)
- [Identity and Trust for nteract Notebook Rooms](../adr/identity-and-trust.md)
- [Hosted Room Authorization and Cloud Room Host](../adr/hosted-room-authorization.md)
- [Desktop Cloud Sessions Mediated by the Daemon](desktop-cloud-daemon-bridge.md)
- `crates/runtimed/src/jupyter_kernel.rs`
- `crates/runtimed/src/kernel_connection.rs`
- `crates/runtimed/src/runtime_agent.rs`
- `crates/runtimed/src/notebook_sync_server/peer_runtime_agent.rs`
- `apps/notebook-cloud/src/notebook-room.ts`
- `crates/runtime-doc/src/doc.rs`
