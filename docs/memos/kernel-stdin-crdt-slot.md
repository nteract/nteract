# Kernel stdin as a single-assignment runtime slot

**Status:** Alternative proposal for [issue #4069](https://github.com/nteract/nteract/issues/4069),
2026-07-22. This memo is intentionally separate from
[the targeted-frame proposal](https://github.com/nteract/nteract/pull/4084).
The two proposals should not both become protocol contracts; review should
select one shape before implementation begins.

## Summary

Jupyter `input()` and `getpass()` need an `input_request` / `input_reply` round
trip. nteract currently sends every `execute_request` with stdin disabled and
does not read the Jupyter stdin channel.

This proposal models a prompt as a single-assignment slot on the existing
RuntimeStateDoc execution entry:

1. the runtime peer creates a `waiting` input slot when Jupyter sends
   `input_request`;
2. the initiating client observes that slot through the existing
   RuntimeStateDoc projection and edits a local input control;
3. submission sends the value once through a correlated `ReplyInput` request;
4. the runtime peer validates and consumes that reply exactly once, sends it to
   Jupyter, and marks the slot consumed; and
5. interrupt, disconnect, timeout, restart, or execution termination marks the
   slot cancelled.

The prompt and its lifecycle are CRDT state. The response value is not. In
particular, a `getpass()` value must never enter an Automerge document: deleting
a secret later does not remove it from CRDT history.

This uses RuntimeStateDoc for reliable prompt delivery and lifecycle projection,
and the existing reliable request lane for the one secret-bearing message. It
does not add a server-originated stdin frame or a separate frontend prompt
store.

## Goals

- Support interactive Python `input()` and `getpass()` for a single-cell run.
- Bind each prompt to the execution and authenticated connection that initiated
  it.
- Accept at most one reply for one live prompt.
- Keep reply values out of documents, persistence, outputs, diagnostics, logs,
  analytics, and broadcasts.
- Reuse RuntimeStateDoc's existing reliable sync and execution identity, and
  require input-slot terminal state to precede execution terminal state.
- Keep stdin default-off until every participating component advertises the
  capability.

## Non-goals

- Headless stdin for MCP, Python clients, scheduled jobs, or agents.
- Interactive `run all` in V1.
- Answering another connection's prompt, even when both connections represent
  the same account.
- Resuming a prompt after the initiating connection loses its actor identity.
- Storing an answer for later replay.
- Enabling daemon-mediated hosted stdin before the bridge preserves the
  initiating local actor.

## Document model

Add an optional `pending_input` map to each RuntimeStateDoc execution:

```text
executions/{execution_id}/pending_input/
  prompt_id: Str
  target_actor_label: Str
  prompt: Str
  password: Bool
  state: Str                 # waiting | consumed | cancelled
  requested_at: Str
  deadline_at: Str
  terminal_reason: Str      # empty while waiting
```

The runtime peer owns these fields. Notebook clients continue to receive
RuntimeStateDoc through a read-only projection and cannot author prompt state.
The input value is deliberately absent from the schema.

The slot is single-assignment in the domain sense:

- `waiting` may transition once to `consumed` or `cancelled`;
- terminal states never transition back to `waiting`;
- another Jupyter prompt receives a new unpredictable `prompt_id`; and
- the runtime peer, not Automerge conflict resolution, decides which reply wins.

CRDT convergence makes the current prompt state reliable and naturally
observable by every projection. It does not provide authorization or
compare-and-set semantics. Those remain host and runtime responsibilities.

## Prompt visibility tradeoff

RuntimeStateDoc is room-scoped, so every peer allowed to read runtime state can
technically receive the prompt text, target actor label, and password
presentation hint. Only the target connection renders the control, but filtering
the UI is not a confidentiality boundary. Prompt metadata may also remain in
Automerge history after the current map is replaced or removed.

This proposal does not accept that tradeoff on behalf of product or security.
It asks for an explicit decision from both before implementation. Prompt strings
can themselves contain sensitive, non-redactable context, such as an account,
host, or credential purpose, even when the entered value is the primary secret.
If prompt text must be actor-confidential, select the targeted-frame proposal
instead. Creating a private per-actor CRDT solely for prompts would be more
machinery than the reliable frame it replaces.

Regardless of the selected transport, the entered value must stay ephemeral.

## Execution and reply flow

### 1. Opt in

Add a default-false `allow_stdin` field to interactive single-cell execution.
The room accepts `true` only when the notebook client, room host, and selected
runtime peer all advertise `kernel_stdin_slot_v1` and the initiating connection
has execution authority.

Batch, MCP, Python, and unattended execution keep stdin disabled in V1.

### 2. Create the slot

The Jupyter connection uses a stdin DEALER with the same identity as the shell
connection. When it receives `input_request`, the runtime peer verifies that:

- stdin was enabled for the active execution;
- the Jupyter parent message belongs to that execution;
- the execution has an authenticated `submitted_by_actor_label`; and
- there is no other waiting slot for the execution.

It then generates an unpredictable `prompt_id`, retains the Jupyter routing
correlation in memory, and writes the `waiting` slot to RuntimeStateDoc. The
Jupyter correlation data does not need to enter the document.

The write uses the reliable runtime-state path. It must not share bounded output
work with stdout, display updates, manifests, or widget replay.

### 3. Render a local editor

The shared CodeCell surface derives its prompt view from the execution's
RuntimeStateDoc entry. It renders only when `target_actor_label` matches the
authenticated local connection and `state == "waiting"`.

- `password: false` renders a normal text input.
- `password: true` renders an uncontrolled `type="password"` input.
- The draft stays in the DOM control and is read through a ref on submit.
- React state, shared stores, diagnostics, and analytics do not copy the value.

RuntimeStateDoc is the prompt store, so reconnect, sync lag, cancellation, and
terminal execution updates do not require a second event store to reconcile.
Loss of the initiating actor still cancels the prompt; a different actor must
not inherit it merely because it later observes the slot.

### 4. Submit once

Submission sends a correlated request on the existing reliable request lane:

```json
{
  "id": "request-...",
  "action": "reply_input",
  "execution_id": "exec-...",
  "prompt_id": "stdin-...",
  "value": "..."
}
```

The room host verifies the authenticated connection actor against the
execution's submitter and current slot target. It forwards the request only to
the selected runtime peer.

The runtime peer performs the authoritative check against its in-memory pending
input: execution id, prompt id, target actor, execution generation, and
`waiting` state must all match. It invalidates the slot before sending
`input_reply` to Jupyter, so duplicate or concurrent submissions cannot produce
two kernel replies.

Exactly one selected runtime peer owns an execution and its pending-input
authority. A replacement runtime peer must not adopt a `waiting` slot from CRDT
state: restart or ownership transfer cancels that slot and requires a new
Jupyter prompt with a new id. Consume-once is therefore bounded to one runtime
peer lifetime rather than inferred from Automerge conflict resolution.

After accepting the request, the runtime peer:

1. moves the response value into the Jupyter reply buffer;
2. overwrites or drops its request-memory copy as soon as the socket send
   completes;
3. writes `state = "consumed"` without the value; and
4. returns success to the initiating client.

A stale, duplicate, timed-out, or unauthorized reply returns a structured error
and never reaches Jupyter.

### 5. Cancel and terminate

The runtime peer transitions a waiting slot to `cancelled` on:

- interrupt;
- target-connection loss;
- prompt deadline expiry;
- kernel restart, shutdown, or death;
- execution cancellation or terminal state; or
- a protocol-invalid second prompt.

It invalidates the in-memory prompt first, then uses the tested Jupyter
cancellation behavior. If Jupyter has no true EOF-style input reply, interrupt
or restart remains the reliable cancellation primitive; an empty string is
valid input and must not be mislabeled as cancellation.

Implementation must prove that execution terminal state is causally after the
final input-slot transition, extending the existing output-before-terminal
contract rather than assuming input ordering comes for free. A client that
observes a terminal execution cannot continue submitting to an older waiting
slot.

## Authority and writer policy

Regular notebook peers remain read-only for RuntimeStateDoc. Supporting stdin
does not grant them a new CRDT write surface.

- The runtime peer may create and terminally update `pending_input` only for its
  current execution.
- The local daemon or hosted room admits those writes only from the selected
  runtime peer under the existing runtime-state policy.
- The initiating notebook peer answers through `ReplyInput`, where the host can
  authenticate the connection before the secret leaves it.
- The runtime peer repeats correlation and generation checks because the host's
  materialized RuntimeStateDoc may advance concurrently.

This separates projection from authority: the document says a prompt is
waiting, while only the request path can attempt to fill it.

## Hosted paths

Direct hosted viewers can use the same model when the room preserves the
initiating actor in `submitted_by_actor_label`, admits the selected runtime
peer's slot writes, and routes `ReplyInput` back to that peer.

The daemon-mediated hosted bridge remains unsupported in V1. Today the cloud
room sees the bridge connection as the submitter, not the original local tab.
RuntimeStateDoc delivery does not repair that attribution gap. The bridge needs
an authenticated delegation and return-routing contract before it can advertise
`kernel_stdin_slot_v1`.

## Security and observability invariants

- A reply value never enters NotebookDoc, RuntimeStateDoc, CommsDoc,
  CommentsDoc, browser persistence, output blobs, checkpoints, or `.ipynb`.
- A reply value is never logged, serialized into diagnostics, recorded in
  analytics, or copied into an error.
- Request-body logging and debug formatting must redact `ReplyInput.value` by
  construction.
- The value has an independent small size limit rather than inheriting the
  notebook request-frame cap.
- Only the exact initiating actor may render or answer the current prompt.
- Runtime validation is consume-once and generation-qualified.
- Prompt text visibility to other runtime-state readers is a proposed tradeoff
  requiring explicit product and security approval, not an assumed secret
  channel.

## Simplification relative to the targeted-frame proposal

This shape removes:

- a new server-originated `KernelStdin` frame discriminant and decoder path;
- a targeted reliable prompt lane through the local daemon and hosted room;
- a second frontend ephemeral prompt store;
- explicit prompt/cancellation event reconciliation with RuntimeStateDoc; and
- prompt replay logic separate from ordinary document sync.

It retains the parts that carry real semantics:

- Jupyter stdin socket integration and same-identity verification;
- explicit stdin capability negotiation;
- `allow_stdin` on interactive execution intent;
- authenticated `ReplyInput` forwarding;
- in-memory consume-once validation at the runtime peer;
- lifecycle cancellation; and
- secret-handling tests.

The main cost is broader visibility and CRDT retention of prompt metadata.

## Compatibility

`pending_input` is an additive RuntimeStateDoc field. Older readers ignore it.
Older runtime peers never create it and continue to send Jupyter requests with
stdin disabled. Current hosts accept `allow_stdin: true` only after all three
participants advertise `kernel_stdin_slot_v1`.

The reply action is new in the client-to-host direction, so capability gating
is mandatory. A protocol-v5 cut remains an option, but the additive document
field does not by itself require one.

## Implementation slices

1. **Runtime document schema**
   - Add typed pending-input accessors, writer-policy validation, projections,
     and state-transition tests.
   - Keep production stdin disabled.
2. **Jupyter and runtime state machine**
   - Add the same-identity stdin socket, input parsing, in-memory correlation,
     cancellation, and consume-once tests.
   - Keep UI opt-in disabled.
3. **Local request and UI**
   - Add capability negotiation, `ReplyInput`, exact-actor checks, CodeCell UI,
     and Elements fixtures.
4. **Direct hosted routing**
   - Add room policy and selected-runtime-peer forwarding before advertising the
     capability.
   - Leave daemon-mediated hosted stdin disabled.
5. **End-to-end verification**
   - Exercise real Python `input()` and `getpass()`, duplicate replies,
     disconnect/interrupt/restart races, and a sentinel-secret scan across
     documents, files, diagnostics, and logs.

Every slice can land with stdin default-off.

## Decision tests before implementation

Review should answer these questions before selecting this proposal over the
targeted-frame alternative:

1. Do product and security explicitly accept room-wide visibility and
   non-redactable CRDT retention of prompt text when the reply value remains
   secret?
2. Does RuntimeStateDoc reliably reach the initiating UI quickly enough while a
   kernel is blocked on stdin?
3. Can runtime-state ingress restrict prompt mutations to the selected runtime
   peer without broadening ordinary client authority?
4. Does a terminal input-slot write remain causally ordered before execution
   terminal state across local and hosted runtime peers?
5. Is actor identity stable for the supported connection lifetime, and does
   disconnect cancellation prevent a new actor from inheriting a prompt?

If question 1 is answered no, use the targeted-frame proposal. If the remaining
questions fail, the document model is not actually simpler in production and
should not be adopted merely to avoid a frame type.

## References

- [Issue #4069: `getpass` not implemented](https://github.com/nteract/nteract/issues/4069)
- [Alternative targeted-frame proposal](https://github.com/nteract/nteract/pull/4084)
- [Cell Execution Pipeline and Control-Plane Separation](../adr/execution-pipeline.md)
- [RuntimeStateDoc identity](../adr/runtime-state-document-identity.md)
- [Typed-frame v4 wire protocol](../adr/typed-frame-v4-wire-protocol.md)
- [Identity and Trust for nteract Notebook Rooms](../adr/identity-and-trust.md)
- [Hosted Room Authorization and Cloud Room Host](../adr/hosted-room-authorization.md)
- [Desktop Cloud Sessions Mediated by the Daemon](desktop-cloud-daemon-bridge.md)
- `crates/runtime-doc/src/doc.rs`
- `crates/runtimed/src/jupyter_kernel.rs`
- `crates/runtimed/src/runtime_agent.rs`
