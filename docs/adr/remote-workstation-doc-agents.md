# Remote Workstation Doc Agents

**Status:** Accepted, 2026-07-10. The provider-neutral registration and
room-scoped `runtime_peer` foundation tracked in
[#3381](https://github.com/nteract/nteract/issues/3381) is shipped; focused
follow-ups remain.

This ADR records the hosted workstation architecture. Earlier API sketches,
prototype UI notes, and landed implementation ledgers were removed to keep the
record decision-shaped.

## Context

nteract needs a provider-neutral way for users to run notebook compute on a
workstation while using a hosted notebook room. JupyterHub, Outerbounds
Workstations, Desktop, and future managed runtimes can all provide compute, but
they do not share the same trust or transport boundary.

The hosted workstation path inverts the early SSH prototype. Instead of a local
daemon SSHing into compute, a remote connector dials home to the hosted service,
registers as an available workstation/doc agent, and later attaches to selected
rooms as a scoped `runtime_peer`.

Related decisions:

- [Deployment Topology](./deployment-topology.md)
- [Hosted Room Authorization](./hosted-room-authorization.md)
- [Hosted Credential Transport](./hosted-credential-transport.md)
- [Runtime Principal Promotion](./runtime-principal-promotion.md)

## Vocabulary

- **nteract workstation**: a provider-backed compute/workspace target that can
  be shown to users, selected by a room, and attached to a hosted notebook.
- **compute source**: anything a room can select for execution. Local Desktop,
  registered workstations, SSH/direct-access targets, and future managed
  runtimes are compute sources with different trust boundaries.
- **provider**: the system that supplies a workstation, such as JupyterHub,
  Outerbounds, local Desktop, or a managed runtime service.
- **doc agent**: the remote registration and control actor for a workstation. It
  dials home, advertises capabilities, receives attach commands, and may expose
  safe catalog metadata.
- **runtime peer**: a room-scoped WebSocket connection with `runtime_peer`
  authority. It writes runtime lifecycle, progress, and output state for
  accepted work, but cannot edit `NotebookDoc` or create execution intent.
- **runtime adapter**: provider-specific code that translates accepted room
  execution into kernel/runtime work.

The doc agent and runtime peer are intentionally separate. A workstation can be
online as a doc agent before it is attached to any room as a runtime peer.

## Decision 1: Workstations Dial Home As Doc Agents

A workstation connector runs inside the provider environment and opens outbound
authenticated connections to the hosted service. The hosted service records
workstation metadata: owner principal, provider, provider instance, display
name, capabilities, version, health, and last-seen time.

Credentials are supplied once and stored as user-private service credentials.
The long-running process does not rely on secrets in argv.

## Decision 2: Attachment Is Room-Mediated

Selecting a workstation does not grant compute authority by itself. The room
creates an attachment job, the doc agent accepts it, and the launched runtime
peer connects to the room with `runtime_peer` scope.

The room host remains the authority for:

- selected workstation target;
- active runtime session id;
- runtime peer admission and fencing;
- execution intent;
- runtime/output state acceptance.

Late peers from previous sessions are fenced by workstation id and runtime
session id before they can write runtime state.

## Decision 3: Runtime Peers Do Not Create Execution Intent

Runtime peers perform accepted work and publish runtime state. Owners and
authorized editors create execution intent through room requests. This keeps
compute attachment, notebook editing, and execution authority separate.

Fire-and-forget runtime-agent commands such as interrupt and comm sends may be
forwarded to the selected runtime peer, but visible results still arrive through
`RuntimeStateDoc` or `CommsDoc` convergence. A socket acknowledgment is only a
forwarding acknowledgment.

## Decision 4: Host UI Shows Compute Source, Not Ownership Transfer

The hosted shell may show the active workstation and execution readiness in
host-owned chrome. Shared notebook components should continue to consume
capabilities and runtime state rather than knowing provider-specific workstation
details.

Local Desktop remains owner-local compute. Registered workstations are
room-mediated compute. SSH/direct access remains a credential-owned direct
compute path. The UI may group them as compute sources, but the authorization
models must stay distinct.

## Current Implementation Shape

The core objective in
[#3381](https://github.com/nteract/nteract/issues/3381) is present on `main`:
provider-neutral workstation records, pairing and registration, attach jobs, a
Rust workstation connector, and per-job cloud runtime agents that join selected
rooms with explicit `runtime_peer` authority. Runtime session ids are projected
through `RuntimeStateDoc.workstation`; the room host fences stale peers and
retains authority over execution intent and accepted runtime/output state.

Liveness and idle handling, version reporting, structured CPU, memory, and
accelerator capability projection, and owner-authorized execution and runtime
command forwarding are also shipped. These establish the shared control-plane
foundation without making provider setup, credentials, environments, or update
lifecycle part of the room protocol.

Implementation details live in source and tests, especially the hosted cloud
app, `notebook-cloud-transport`, `runtime-doc`, `runtimed-wasm`, and
`crates/runtimed/src/workstation`.

## Open Boundaries

- Notebook-first setup, recovery, compute-source selection, and accelerator UX
  belong to host-owned notebook chrome; shared notebook components should
  consume normalized host facts
  ([#3990](https://github.com/nteract/nteract/issues/3990)).
- Persistent pairing remains the registration bootstrap. Short-lived,
  room- and session-scoped attachment credentials are focused security work and
  do not change room-mediated runtime authority
  ([#3991](https://github.com/nteract/nteract/issues/3991)).
- Provider-specific packaging, environment selection, and validation stay
  outside the room protocol. The Outerbounds current-Python smoke is tracked in
  [#3992](https://github.com/nteract/nteract/issues/3992); the JupyterHub
  kernelspec and working-directory adapter remains in
  [#3608](https://github.com/nteract/nteract/issues/3608).
- Compatibility notices and safe idle self-update remain connector lifecycle
  work and must not interrupt active execution
  ([#3975](https://github.com/nteract/nteract/issues/3975)).
- Public sharing does not imply compute access.
- Runtime peer attachment does not imply notebook edit authority.
