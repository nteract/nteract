# Remote Workstation Doc Agents

**Status:** Draft, 2026-06-04.

## Context

We need a provider-neutral path for users to run notebook compute on an nteract
workstation while using the hosted room surface at `preview.runt.run`.

In this design, **workstation** is the nteract product noun. JupyterHub can
provide an nteract workstation. Outerbounds can provide nteract workstations.
Future provider adapters can do the same without changing hosted room
authority.

PR [#3359](https://github.com/nteract/nteract/pull/3359) proves a useful
primitive for Desktop: a local daemon can launch a runtime agent through an SSH
wrapper by passing `--runtime-agent-exe` or `RUNTIMED_RUNTIME_AGENT_EXE`. In
that design the local daemon remains the notebook room authority. SSH is only
the transport that moves execution close to a remote kernel.

PR [#3380](https://github.com/nteract/nteract/pull/3380) proves a second useful
primitive on the product surface: Desktop and Hosted can feed host-owned content
sections into a shared notebook rail. The prototype data is still
fixture-backed, but the contract is the right shape for a future hosted catalog
that can include notebooks, shared rooms, local files, and workstation content
without making the shared rail own those data sources.

The hosted workstation path inverts the SSH prototype's direction. Instead of a
local daemon SSHing into compute, a remote process dials home to
`preview.runt.run`, registers itself as an available workstation/doc agent, and
later attaches to selected notebook rooms as a scoped `runtime_peer`.

Outerbounds publicly positions Workstations as always-on, personal cloud
workstations that support VS Code and Jupyter notebooks inside the customer's
cloud. JupyterHub already has a well-understood service/single-user-server model
for launching per-user compute. Both are good providers for long-lived
interactive workstation targets.

Neighbors:

- `deployment-topology.md` defines hosted rooms, room hosts, and runtime peers.
- `hosted-room-authorization.md` defines the `runtime_peer` ACL scope.
- `hosted-credential-transport.md` defines API-key and bearer-token transport.
- `../audits/runtime-peer-and-blob-authority-audit.md` keeps `runtime_peer`
  distinct from local `RuntimeAgent`.
- `typed-frame-v4-wire-protocol.md` defines the room WebSocket frame protocol.
- PR #3380, `quod/content-explorer-prototype`, defines the shared content rail
  host-provided-section contract that can later show workstation catalogs.

## Vocabulary

- **nteract workstation**: a provider-backed compute/workspace target that can
  be shown to users, selected by a room, and attached to a hosted notebook.
- **compute source**: anything a room can select for execution. Local Desktop,
  registered workstations, and SSH/direct-access targets can all become compute
  sources, but they do not share the same security or protocol boundary.
- **provider**: the system that supplies the workstation, such as JupyterHub,
  Outerbounds, local Desktop, or a future managed runtime service.
- **doc agent**: the remote registration/control actor for a workstation. It
  dials home, advertises capabilities, receives attach commands, and may expose
  safe catalog metadata.
- **runtime peer**: a room-scoped WebSocket connection with `runtime_peer`
  authority. It can write runtime lifecycle/progress/output state for accepted
  work, but cannot edit `NotebookDoc` or create execution intent.
- **runtime adapter**: provider-specific code that translates accepted room
  execution into local kernel/runtime work.

The doc agent and runtime peer are intentionally separate. A workstation can be
online as a doc agent before it is attached to any room as a runtime peer.

## Compute source taxonomy

The UI should make three related compute families visible without flattening
their authority models:

1. **Local Desktop.** Desktop can offer the user's local machine as compute,
   much like a local Codex/Claude-style agent surface. This should be
   owner-only and should not grant other room participants access to the user's
   local daemon, filesystem, Python, or shell.
2. **Registered workstations.** Outerbounds Workstations, JupyterHub-backed
   servers, and future managed targets register with the hosted API as
   workstation/doc agents. They can be room-mediated through attachment tickets
   and `runtime_peer` scope.
3. **SSH/direct access.** The SSH prototype is a direct key-based cross-compute
   path. It is workstation-like in the UI because it selects a remote compute
   target, but its trust boundary is SSH credentials plus Desktop ownership, not
   hosted API registration.

The selected compute target is room state. The attached interpreter, kernelspec,
package set, and readiness are environment state for the current notebook after
the target is selected.

## Decision 1: Workstations dial home as doc agents

Add a workstation connector process that runs inside the provider environment
and opens an outbound authenticated connection to `preview.runt.run`.

The install flow for an Outerbounds-hosted workstation might look like:

```bash
curl -fsSL https://preview.runt.run/install/outerbounds | sh
runt workstation login --api-key-stdin
runt workstation service install --provider outerbounds
```

A JupyterHub deployment might install the same connector as a Hub service,
single-user-server sidecar, or kernelspec-adjacent process:

```bash
runt workstation service install --provider jupyterhub
```

The exact command names can change, but the properties should not:

- The API key or provider credential is supplied once and stored in a
  user-private service credential, never in argv for the long-running process.
- The workstation process makes outbound HTTPS/WebSocket connections only.
- The hosted service records workstation metadata: owner principal, provider,
  provider instance, display name, hostname or workspace id, version,
  capabilities, last seen time, and health.
- Registration proves the user's identity and workstation ownership. It does
  not grant room runtime authority by itself.

The doc-agent control channel is not the notebook room sync channel. It is a
workstation registration and command channel:

- register/update workstation metadata;
- heartbeat and report health;
- advertise runtime, workspace, catalog, and environment capabilities;
- receive "attach this workstation to room X" commands;
- report attachment status and provider diagnostics.

Room execution still flows through a room-scoped `runtime_peer` connection.

## Decision 2: Providers supply workstations through adapters

Outerbounds and JupyterHub should be modeled as providers of the same nteract
workstation abstraction.

Outerbounds-specific adapter responsibilities:

- install inside an Outerbounds Workstation;
- use the workstation's current filesystem and current Python environment by
  default;
- discover stable workspace identity and project metadata once the VS Code
  extension/source clarifies Outerbounds connection semantics;
- avoid assuming that nteract can manage or recreate the provider environment.

JupyterHub-specific adapter responsibilities:

- authenticate and authorize through JupyterHub service/single-user-server
  mechanisms;
- map Hub user/server identity into nteract principals and workstation ids;
- expose available kernelspecs and workspace roots when the deployment permits;
- avoid making JupyterHub the room document authority.

Provider adapters may differ substantially below the doc-agent control plane.
The hosted room should still see the same product shape: online workstations
with capabilities that can be selected, attached, detached, and rendered in
shell UI.

## Decision 3: Room attachment uses `runtime_peer`, not `RuntimeAgent`

When a user chooses a workstation for a hosted notebook room, the workstation's
doc agent opens a separate WebSocket to:

```text
wss://preview.runt.run/n/<notebook-id>/sync
```

It requests `scope=runtime_peer` using either a normal validated bearer
credential or a short-lived room attachment ticket minted by the hosted service.
The Durable Object authorizes the connection against the room ACL and provider
bounds before accepting it.

The attachment-ticket path is load-bearing for non-dev provider workstations.
The current hosted identity layer validates dev credentials, Anaconda OIDC, and
Anaconda API keys; it does not treat an Outerbounds or JupyterHub workstation's
native credential as room authority. The minimum ticket contract should be:

- notebook-host-issued, not provider-token passthrough;
- signed by the hosted control plane or atomically stored and consumed by the
  room Durable Object;
- audience-bound to the target `/n/<notebook-id>/sync` attachment;
- scoped to `runtime_peer`;
- bound to notebook id, workstation id, runtime-peer principal, operator,
  expiry, and nonce or connection id;
- expires within seconds and is single use; and
- maps to a principal that still needs an explicit `runtime_peer` ACL row.

For early dev, a seeded `runtime_peer` ACL row plus
`X-Notebook-Cloud-Dev-Token` and `X-Scope: runtime_peer` can stand in for this
ticket. Before non-dev deployment, the ticket signer, audience, principal
mapping, lifetime, and replay behavior should move into
`hosted-credential-transport.md` alongside the existing service-token runtime
peer open question.

This preserves the existing hosted authority model:

- Browser, desktop, or agent connections create notebook edits and execution
  intent.
- The Durable Object is the document and execution-intent authority.
- The workstation runtime peer is compute authority only for accepted
  executions.
- The local `RuntimeAgent` protocol remains inside the daemon that owns the
  kernel; it is not exposed as an internet-facing API.

## Decision 4: Execution intent stays coordinator-owned

The room host must create execution records from editor/owner requests before a
runtime peer can act on them.

For `ExecuteCell`:

1. An editor/owner sends `NotebookRequest::ExecuteCell` to the room host.
2. The room host verifies the request, required heads, and active workstation.
3. The room host writes a queued execution entry into `RuntimeStateDoc` with the
   cell id, source, sequence number, and coordinator-owned provenance.
4. The runtime peer observes the queued entry through `RuntimeStateDoc` sync.
5. The runtime peer runs the cell and updates only allowed runtime fields:
   kernel lifecycle, queue progress, status transitions, outputs, and blob refs.

The existing runtime-doc policy already enforces the runtime-peer side of this
split. `validate_runtime_peer_runtime_delta` in
`crates/runtime-doc/src/policy.rs` lets runtime peers update accepted
executions and the queue projection, but rejects attempts to create execution
records, rewrite room-host-owned fields, or edit `NotebookDoc`.

The room-host half of this contract is implemented in `runtimed-wasm`:
`receive_request` validates owner-scoped `ExecuteCell` / `RunAllCells`
requests and writes queued execution entries with cell source provenance into
`RuntimeStateDoc`, which the runtime peer consumes through normal sync. What
remains for workstations is target selection: how the active runtime peer is
chosen for accepted executions, and how readiness/disconnect gates the
dispatch (punchlist 3D-7).

Kernel lifecycle and widget requests should follow the same split, but they do
not all have the same reply contract. `InterruptExecution` and `SendComm` are
command-only today: the hosted room can authorize the user request and forward
the typed frame to the newest active `runtime_peer`. The browser ack for those
frames means "accepted and delivered to a runtime peer", not "the kernel handled
it" and not "widget state converged". Widget-visible results must still arrive
through the normal runtime documents (`CommsDoc` / `RuntimeStateDoc`) and shared
projections.

Response-bearing runtime requests need a stronger contract. `Complete` can use
a narrow correlated response bridge because the browser's `NotebookResponse`
envelope and the runtime peer's `RuntimeAgentResponse` envelope have compatible
result shapes for that query RPC. `GetHistory` remains hosted-local for now
because it is a broader notebook feature in Cloud rather than only a kernel
history query. `LaunchKernel`, `RestartKernel`, `ShutdownKernel`, and
`SyncEnvironment` require either a room-owned state transition or a mapped
response path back from the runtime peer. Hosted rooms should reject direct
runtime request frames for unsupported actions until that orchestration exists
rather than acknowledging a no-op delivery. This keeps toolbar and environment
UI from mistaking WebSocket delivery for kernel success.

## Decision 5: Current Python is a first-class environment policy

Outerbounds needs a lighter-weight runtime agent path because the important
environment is often the workstation's current Python, not a daemon-managed
environment that nteract builds from notebook metadata.

The workstation capability payload should include an explicit environment
policy:

```text
environment_policy = current_python | kernelspec | managed_project | unknown
```

For `current_python`:

- the adapter executes with the Python interpreter visible to the installed
  connector or selected provider workspace;
- package-management controls stay disabled unless the provider adapter
  explicitly advertises safe package mutation;
- the UI labels the target as current Python on the workstation, not as a
  reproducible managed environment;
- dependency trust remains a notebook/document concern, but environment repair
  is provider-owned.

This gives Outerbounds a practical first implementation without forcing it into
the Desktop daemon's environment-management model. JupyterHub deployments can
advertise `kernelspec` when the Hub's kernel selection is the right surface.

## Decision 6: The remote daemon is an adapter boundary

The connector should reuse daemon/runtime-agent implementation near the kernel
where useful, but the cross-machine boundary should be higher level than the
local `RuntimeAgent` socket.

Recommended shape:

```mermaid
sequenceDiagram
    participant User as Browser/Desktop
    participant Room as preview.runt.run Room DO
    participant Control as preview.runt.run Workstation Control
    participant Agent as Workstation Doc Agent
    participant Adapter as Provider Runtime Adapter
    participant Runtime as Remote runtimed or lightweight agent
    participant Kernel as Provider Kernel

    Agent->>Control: register workstation + heartbeat
    User->>Room: select workstation target
    Room->>Control: request target attachment
    Control->>Agent: attach room as runtime_peer
    Agent->>Room: open room WebSocket with runtime_peer scope
    User->>Room: ExecuteCell
    Room->>Room: create queued execution in RuntimeStateDoc
    Room-->>Agent: RuntimeStateDoc sync
    Agent->>Adapter: run accepted execution
    Adapter->>Runtime: launch/reuse runtime machinery
    Runtime->>Kernel: execute cell
    Kernel-->>Runtime: IOPub outputs/status
    Runtime-->>Adapter: runtime progress/output
    Adapter-->>Agent: hosted output mutations + blob refs
    Agent-->>Room: RuntimeStateDoc sync + PutBlob
    Room-->>User: RuntimeStateDoc sync + output refs
```

The adapter can start as a thin wrapper around a colocated daemon or a lighter
current-Python runtime process:

- Use provider-local machinery to manage kernels, interrupts, and output
  preparation.
- Translate hosted room execution entries into provider-local runtime work.
- Translate local runtime progress/output back into hosted `RuntimeStateDoc`
  mutations and hosted blob uploads.

The adapter may eventually become a native mode inside `runtimed`, but the v1
contract should be clear before folding it into the daemon.

One part of that v1 contract is net-new: an outbound authenticated
`runtime_peer` sync client. The current Rust connection paths use local Unix
sockets or Windows named pipes and `Handshake::RuntimeAgent`; there is no
`wss://preview.runt.run/n/<id>/sync` dialer, remote `runtime_peer` handshake, or
hosted credential/ticket presentation path in `runtimed` today. The writer side
can reuse generic `AsyncWrite` plumbing, but the dialer, read path, auth
handshake, reconnect behavior, and revocation close path need to be explicit
implementation items rather than hidden inside the adapter step.

## Decision 7: Target selection and attachment progress are explicit room state

Hosted rooms need an explicit active workstation target, distinct from access
control. The registry answers "what workstations can this user choose?" The
room state answers "what compute is this notebook trying to use right now, and
is it ready to execute?"

Minimum target state:

```text
workstation_id
workstation_provider = "outerbounds" | "jupyterhub" | ...
workstation_display_name
workstation_principal
workstation_default_environment_label
workstation_environment_policy
workstation_cpu_count
workstation_memory_bytes
workstation_working_directory
workstation_status = disconnected | connecting | ready | busy | error
workstation_capabilities
```

That state must be visible to late joiners and collaborators without polling a
separate workstation-control resource. The room host therefore mirrors the
selected target, attach/detach progress, readiness, disconnect, and error facts
into a room-owned `RuntimeStateDoc` field. The doc agent can report provider
facts over the control channel, but the room host writes the notebook-visible
projection because it is also the authority that dispatches execution intent.

The visible rail/header projection should lead with the workstation id as
small metadata, the display name as the primary label, and compact resource
facts such as CPU count, RAM, default environment, and working directory. The
principal remains authority/provenance metadata rather than the primary
workstation label; UI should not make the workstation look like it owns the
document.

The UI should treat workstation availability as runtime capability, not as
editor authorization. A user can edit a hosted notebook without a connected
workstation target. Run/restart/package controls appear only when the room has
an active, ready target and the user's role permits execution requests.

`SessionControl` can still carry transient wake-up messages, and the workstation
registry can still serve app-shell lists, but neither is the notebook's durable
attachment display. Because target readiness affects execution dispatch and
late joiners, the v1 default is room-host-owned runtime state. That keeps the
design aligned with the current policy: `env` and other deployment facts are
room-host/daemon-owned fields, not fields a `runtime_peer` may mutate directly.

## Decision 8: Content discovery and runtime attachment stay separate

PR #3380's shared Content rail is relevant to workstations, but it should not
become the runtime authority surface.

Use the rail for host-owned discovery:

- available hosted notebooks;
- notebooks shared with the user;
- the current room;
- future workstation content, such as remote project folders, notebook files,
  environment files, datasets, or recent workstation artifacts.

Use workstation target state for attachment and execution:

- selected workstation target;
- attach/detach status;
- kernel/runtime readiness;
- execution and package-management capability.

This keeps the shared rail contract clean. The rail receives host-provided
sections and `onOpenContentItem` callbacks; it does not decide what a user may
run, which workstation is attached, or whether a room can create execution
intent. Hosted and Desktop shells can render a workstation's catalog in Content
while the toolbar/header continues to expose the active workstation target and
its state.

The practical implication for the first implementation slice: the workstation
registry should be shaped so it can later back both APIs:

- workstation-target APIs for selecting and attaching compute;
- content-catalog APIs for showing workstation/project artifacts in the shared
  rail.

## UI prototype direction

The first UI prototype should be a shell experience, not a full runtime
transport implementation.

Prototype these states in Elements:

- no workstation selected: editing is possible, execution controls are hidden;
- workstation online: the target is visible in the cloud shell but not attached;
- attaching: the control plane is connecting the doc agent to the room;
- ready: the header names the active workstation and the notebook toolbar shows
  kernel controls;
- current Python: the active target is explicitly labeled as current Python on
  the workstation, with package mutation disabled;
- disconnected: the active target remains selected but execution controls are
  disabled and queued work fails after a timeout.

The cloud shell should expose the active workstation in host-owned chrome and
continue to use shared notebook components for notebook commands. Existing
actor projection can show runtime authorship once the workstation attaches as a
`runtime_peer`.

## API sketch

Control plane:

```text
POST /api/workstations/register
GET  /api/workstations
GET  /api/workstations/:id
WS   /api/workstations/:id/control
```

Room APIs:

```text
GET  /api/n/:id/workstation-targets
POST /api/n/:id/workstation-target
POST /api/n/:id/workstation-target/attach
POST /api/n/:id/workstation-target/detach
```

The v1 storage can use D1 tables roughly shaped as:

```sql
workstations(
  id TEXT PRIMARY KEY,
  owner_principal TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_instance TEXT,
  display_name TEXT NOT NULL,
  hostname TEXT,
  capabilities_json TEXT NOT NULL,
  environment_policy TEXT NOT NULL,
  version TEXT,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL
)

workstation_doc_agent_sessions(
  workstation_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  connected_at TEXT,
  last_heartbeat_at TEXT,
  connection_id TEXT
)

notebook_workstation_targets(
  notebook_id TEXT PRIMARY KEY,
  workstation_id TEXT NOT NULL,
  selected_by_actor_label TEXT NOT NULL,
  selected_at TEXT NOT NULL,
  status TEXT NOT NULL
)
```

The connector's control channel does not need to expose notebook content. It
only receives room attachment commands and one-time room attachment material.
Notebook contents flow over the room WebSocket after room authorization.

## Security constraints

- Treat the API key as identity proof, not room authorization.
- Prefer short-lived room attachment tickets for connector-to-room
  `runtime_peer` connections. Persistent `runtime_peer` ACL rows are acceptable
  for early dev, but broad product use should avoid permanent room grants to a
  long-lived workstation principal unless the user explicitly asks for it.
- Never put API keys or room attachment tokens in URLs.
- Origin checks still apply to browser WebSockets; connector/native WebSockets
  use headers and may omit `Origin`.
- Runtime peers may upload output blobs, but references must still be accepted
  through authorized `RuntimeStateDoc` changes.
- A disconnected workstation must not leave a room thinking execution is ready.
  The room host should mark the active target disconnected and fail queued work
  after a bounded timeout.
- Revoking a workstation or API key should close the doc-agent control session
  and any active room `runtime_peer` sockets.

## Implementation sequence

1. **Design issue / ADR.** Land this contract and link it from the hosted
   topology docs.
2. **UI prototype.** Add Elements states for workstation selection, current
   Python, attach/readiness, and disconnected execution gating.
3. **Workstation registry.** Add D1 schema and Worker routes for workstation
   registration, listing, and heartbeat using existing write-capable Anaconda
   API-key auth.
4. **Connector skeleton.** Add a Linux-friendly `runt workstation` or
   `runtimed workstation` mode that stores an API key, registers the host,
   maintains an outbound control WebSocket, and reports capabilities. No
   notebook execution yet.
5. **Catalog projection.** Project registered workstations into host-owned
   catalog data that can later feed PR #3380's Content rail contract, without
   making the rail responsible for runtime authority.
6. **Attachment-ticket contract.** Define the notebook-host-issued
   room-attachment ticket or equivalent non-dev service credential in
   `hosted-credential-transport.md`, including signer, audience, principal
   mapping, TTL, single-use semantics, and revocation hooks.
7. **Outbound runtime-peer sync client.** Add a minimal authenticated
   `wss://.../n/<id>/sync` client for doc agents, including credential/ticket
   presentation, a remote runtime-peer handshake or equivalent, reconnect, and
   revocation close behavior. Prove attach/detach and state sync before
   executing cells.
8. **Room target selection.** Add owner/editor-controlled target selection for a
   hosted room plus session-control/status messages that let the UI show the
   selected target and readiness.
9. **Runtime peer attachment.** Let the control plane command the doc agent to
   open a room WebSocket as `runtime_peer`, initially proving attach/detach and
   state sync without executing cells.
10. **Hosted request dispatch.** Implement room-host handling for
   `LaunchKernel`, `ExecuteCell`, `RunAllCells`, `InterruptExecution`, and
   `ShutdownKernel` against the active workstation target. The room host
   creates execution intent before the runtime peer sees work.
11. **Remote execution adapter.** Bridge accepted hosted execution entries to a
   colocated daemon or lightweight current-Python runtime agent and mirror
   progress/output/blob refs back to the hosted room.
12. **End-to-end smoke.** Run provider-specific smokes:
    - Outerbounds: register target, attach to a `preview.runt.run` room,
      execute `socket.gethostname()` / `platform.platform()`, and verify the
      output came from the workstation.
    - JupyterHub: register a Hub-backed workstation, attach as `runtime_peer`,
      execute a kernelspec-backed Python cell, and verify Hub/user identity
      projection.

## First useful slice

The smallest valuable PR should avoid kernel execution:

- Elements UI prototype for workstation target states and current-Python copy.
- D1 tables for workstation registry.
- `POST /api/workstations/register` authenticated by write-capable Anaconda API
  key.
- `WS /api/workstations/:id/control` heartbeat with version, provider, and
  capability payload.
- A connector command that can run on Linux and keep the target visible.
- Tests proving API keys authenticate a principal, deployed routes do not accept
  query-scope authority, and workstation registration does not grant
  `runtime_peer` room access.
- Metadata fields that make the same target usable later as a Content rail
  source, without exposing notebook/project contents in the registration call.

That slice gives the product a real "workstation is online" signal without
prematurely deciding the hosted execution dispatch protocol.

## Implementation status (2026-06-05): outbound WS sync client

Step 7 (the outbound `runtime_peer` sync client) has a working first cut:
`crates/runt-cloud-peer`, a standalone CLI that dials `wss://<host>/n/<id>/sync`,
authenticates on the upgrade, and runs Automerge sync for both the NotebookDoc
and the RuntimeStateDoc over the typed-frame v4 stream, reusing `notebook-doc`
and `runtime-doc` directly. It is the role the Outerbounds workstation will
eventually play; for now it runs locally to prove the path against live preview.

Verified against the deployed preview: the client authenticates with a staging
Anaconda OIDC bearer (`Authorization: Bearer`, no subprotocol), reserves a room
via `POST /api/n`, attaches as `owner`, and drives a NotebookDoc edit (adds a
code cell) that the room accepts and converges on. The cell renders in the
hosted viewer.

Load-bearing findings:

- **Change actor must match the authenticated principal.** The room host
  (`validate_room_notebook_change_actors`, `crates/runtimed-wasm/src/lib.rs`)
  rejects any change whose actor principal differs from the connection's
  authenticated principal. Author the doc as `<principal>/<operator>`, taking
  `<principal>` from the room's `cloud_room_ready` frame. A mismatched actor is
  silently dropped: the change never lands and sync never converges (the room
  keeps re-advertising that it lacks the change). Use a unique operator per run,
  or two doc instances reusing one actor collide at `(actor, seq 1)` (automerge
  `DuplicateSeqNumber`).
- **Header-bearer auth, not subprotocol.** Non-browser peers send
  `Authorization: Bearer` + `X-Scope`; offering a `Sec-WebSocket-Protocol` the
  room will not echo trips tungstenite's "server sent no subprotocol".
- **Bootstrap, do not scaffold.** The client `bootstrap()`s genesis only; the
  room owns the `cells`/`metadata` maps and we receive them before editing
  (invariant #2 in `crates/notebook-doc/AGENTS.md`).

Built since (the runtime half):

- **Hosted execution dispatch (#3399).** The room host turns an editor/owner
  `ExecuteCell` `REQUEST` into a queued execution in RuntimeStateDoc
  (`create_execution_with_source_provenance`), stamps the cell's `execution_id`,
  and broadcasts both docs. Execution intent is created only by the room host:
  clients request, the host writes (the RuntimeStateDoc policy forbids non-host
  execution creation over sync). Idempotent on a double-run, and attributed to
  the submitter's full `principal/operator` actor label. `--run-cell` here drives
  it and observes the queued execution; verified end-to-end against preview. The
  consumer-side receive on this client uses `receive_sync_message_with_changes`,
  not the daemon-authoritative `receive_sync_message` (which strips incoming
  changes) - otherwise the room's queued execution never lands locally.

Remaining for "run a cell", not yet built:

- **Request/response contract.** The cloud room acks `REQUEST` frames with
  `cloud_frame_accepted` but does not emit a `RESPONSE` envelope, so await-based
  callers (the viewer's `await executeCell`, which waits on `sendRequest` by id)
  do not resolve. Needs cloud-room request/response plumbing (a `cell_queued` /
  structured-error response keyed by the request id).
## Kernel hosting: proof, then the production shape

A standalone kernel-host spike is built and verified end-to-end (`runt-cloud-peer
--host-kernel --scope runtime_peer`). It launches `python -m ipykernel_launcher`
on self-chosen ports, drives it over `jupyter-protocol` + `jupyter-zmq-client`,
and streams `set_execution_running` / `append_output` / `set_execution_done` onto
its RuntimeStateDoc, pushed back to the room. Against live preview, a queued
execution runs and the driver observes queued -> running -> outputs (stdout +
execute_result) -> done.

**Treat that spike as a proof, not the production driver.** Its job was to de-risk
the uncertain half: the cloud wire (runtime_peer attach + the room's ExecuteCell
dispatch + the full lifecycle round-trip over WS). That now works. But its kernel
drive (`kernel_host.rs`) reimplements what the daemon already does well, and it
hardcodes a python path instead of using the daemon's environments / pools /
launcher cache. Do not grow it into the product.

**Production shape (the daemon stays the launcher; the agent's transport goes
pluggable):**

- **Workstation endpoint on the daemon.** A workstation is an endpoint you pick
  compute from: it *lists the environments it has* and, on demand, *allocates and
  starts a runtime in env X for room Y*. That is a daemon capability plus a small
  control surface (the "receiver"), built on the existing env pool + launcher,
  not a reimplementation.
- **`runtime_agent` becomes transport-agnostic.** It already drives the kernel
  and syncs RuntimeStateDoc/NotebookDoc over the *same* typed-frame v4 protocol
  the cloud room speaks. The reusable core (the `select!` loop,
  `queue_synced_executions`, the RuntimeStateSync apply/generate, the
  `KernelConnection` drive) is transport-independent. The coupling is narrow and
  extractable into a `FrameTransport` trait:
  - `AgentReader`/`AgentWriter` (`runtime_agent.rs:670,672`) are `UnixStream`
    halves;
  - `connect_and_handshake` (`:703`) connects the socket and sends
    `Handshake::RuntimeAgent`;
  - `send_typed_frame` / `recv_typed_frame` use the daemon's length-preamble
    framing.
  The cloud impl differs only in transport (WS), auth (the `Authorization` +
  `X-Scope` upgrade + `cloud_room_ready` instead of `Handshake::RuntimeAgent`),
  and framing (one typed frame per WS binary message, no preamble). The kernel,
  `RuntimeStateHandle`, and `BlobStore` stay daemon-side; only the sync sink
  swaps.
- **runt-cloud-peer's keepable value is that WS transport** (dial + Anaconda auth
  + the typed-frame wire + the consumer-side `receive_sync_message_with_changes`).
  It becomes the cloud `FrameTransport` impl the daemon's `runtime_agent` writes
  to. `kernel_host.rs` retires.

**Status (2026-06-10):** done. The WS transport lives in
`crates/notebook-cloud-transport` (`CloudWsFrameTransport`), the daemon's
`cloud-runtime-agent` subcommand drives the real `runtime_agent` over it, and
the standalone `crates/runt-cloud-peer` binary is retired. Its remaining
diagnostic role (attach as owner, add a cell, request execution, observe
RuntimeStateDoc) moved onto the same transport as the hidden
`runtimed cloud-peer` subcommand (`crates/runtimed/src/cloud_peer.rs`), which
the hosted runtime-peer smoke uses.

This refactor touches the daemon (and therefore desktop), so it is a deliberate
change, not a drop-in. The runtime_peer ACL requirement holds either way: an
explicit `runtime_peer` ACL row via `POST /api/n/:id/acl` (owner alone is 403;
`aclRowsCoverScope` special-cases the scope).

## Implementation status (2026-06-10): the system as built

The end-to-end path is live. What exists, mapped to the implementation
sequence:

- **Registry (step 3).** D1 tables `workstations`, `workstation_defaults`, and
  `workstation_attach_jobs` (`apps/notebook-cloud/src/storage.ts`), with Worker
  routes `/api/workstations`, `/api/workstations/default`, and the attach-job
  endpoints. Registration upserts and refreshes `last_seen_at`.
- **Connector (step 4).** `apps/notebook-cloud/scripts/hosted-workstation-agent.mjs`
  registers the workstation, polls attach jobs over HTTP, and spawns
  `runtimed cloud-runtime-agent` per job. This diverges from the sketch above:
  attach commands arrive by polling `workstation_attach_jobs`, not a
  `WS /api/workstations/:id/control` channel. A Rust `runt workstation` service
  mode is still open.
- **Target selection + attachment (steps 8–9).** The viewer's workstation panel
  (`use-cloud-workstations.ts`) drives `/api/n/:id/workstation-attachments`;
  attach jobs command the connector, which attaches as `runtime_peer` over
  `CloudWsFrameTransport`.
- **Execution (steps 10–11).** The room host queues executions from owner
  REQUESTs (#3399); viewer requests resolve via `cloud_frame_accepted` /
  `cloud_frame_rejected` acks. Launch-on-attach starts a `current_python`
  kernel through the daemon's launcher (`crates/runtimed/src/workstation/`).
  Verified live: browser submits, workstation executes, output lands in the
  viewer.
- **Runtime-agent commands.** Cloud now forwards owner-authorized
  fire-and-forget runtime-agent command REQUESTs (`interrupt_execution` and
  `send_comm`) directly to attached `runtime_peer` sockets. These requests do
  not persist as room history and do not produce `RESPONSE` envelopes; visible
  results must arrive through RuntimeStateDoc/CommsDoc convergence, matching the
  local runtime-agent command model. During reconnect overlap, command routing
  targets the newest connected runtime peer, matching the attachment
  `updated_at` projection until runtime generations become explicit.
  `send_comm` is especially easy to misread: the socket ack only means the room
  forwarded the comm message to the selected runtime peer. The widget-visible
  result is still the later CommsDoc/RuntimeStateDoc change; cloud must not
  invent a response envelope or treat the ack as a completed widget round trip.
- **Runtime-agent query bridge.** Cloud supports a narrow correlated response
  bridge for `complete`. The room stores a bounded in-memory pending map,
  forwards the request to the newest active runtime peer, and routes the
  matching runtime-peer `RESPONSE` frame back to the original browser peer.
  This is intentionally narrower than a generic runtime-agent RPC bridge:
  `complete` works because the browser request/response envelopes and
  runtime-agent response shape are compatible. The bridge must remain bounded,
  disconnect-aware, and non-durable until runtime generations and room-owned
  lifecycle transitions are explicit.
- **Unsupported response-bearing runtime requests fail honestly.** Hosted cloud
  rooms reject direct `launch_kernel`, `shutdown_kernel`, `sync_environment`,
  and `get_history` request frames instead of acknowledging them as empty
  room-host no-ops. The cloud viewer still handles current hosted history in
  `CloudNotebookHostTransport`; a real kernel-backed history implementation
  needs a product decision about whether history is notebook-wide, user-wide,
  or kernel-local before routing it through the runtime peer.

Runtime request subtleties to keep visible:

- A WebSocket delivery ack is not a kernel success signal. For commands such as
  `interrupt_execution` and `send_comm`, users should only see success through
  later runtime-document convergence or explicit lifecycle state.
- `send_comm` is input to kernel/widget machinery, not durable widget state.
  It should never bypass CommsDoc/RuntimeStateDoc projection or become a
  room-authored widget update.
- Response-bearing requests need per-action contracts. A narrow query bridge is
  acceptable for `complete`; lifecycle requests such as restart need room-owned
  state transitions, stale-runtime deadlines, and late-response suppression.
- The newest-runtime-peer rule is a temporary routing policy. Runtime
  generations should eventually make "which runtime handled this request"
  explicit enough to ignore late frames from a replaced peer.
- Unsupported requests should fail loudly and cheaply. Accepting a delivered
  frame that the room cannot observe or reconcile creates false UI readiness.

Operator instructions: `docs/remote-workstation.md`.

Still open: response-bearing kernel lifecycle over cloud
(`launch_kernel`/`shutdown_kernel`/restart, plus `sync_environment` and a
product-shaped history contract), the attachment-ticket contract (step 6; dev
path today is API key / dev token plus an explicit `runtime_peer` ACL row),
catalog projection (step 5), and the provider-specific Outerbounds/JupyterHub
smokes (step 12). Restart also needs a bounded stale-runtime policy: if the
selected runtime does not confirm restart in time, the room should assume that
runtime generation is gone, start a new attachment, and ignore late frames from
the old runtime. Tracked in
[#3381](https://github.com/nteract/nteract/issues/3381).

## Open questions

1. Is a workstation target personal to the API-key principal, shareable within a
   room, or shareable across a workspace/team?
2. Should target selection be owner-only at first, or can editors choose from
   targets they own?
3. Does an Outerbounds install script have a stable non-interactive place to
   persist user service credentials, or do we need a user-scoped systemd unit
   plus a `0600` env file?
4. For JupyterHub, should the doc agent run as a Hub service, per-server
   sidecar, kernelspec wrapper, or some combination?
5. What provider metadata is safe to collect before the Outerbounds VS Code
   extension/source clarifies workspace connection semantics?
6. How should local-to-remote working directories map for notebooks published
   from Desktop into a hosted room?
7. Do large output blobs go directly from workstation to hosted R2 through
   `PutBlob`, or should the connector upload via room HTTP blob endpoints for
   easier retry/accounting?
8. How should the UI explain an active workstation without implying that the
   workstation owns the document?
9. Which workstation artifacts belong in the Content rail v1, and which should
   remain hidden until the remote catalog has real permission and freshness
   semantics?

## References

- PR #3359, hidden SSH runtime-agent launcher:
  `https://github.com/nteract/nteract/pull/3359`
- PR #3380, shared content explorer rail prototype:
  `https://github.com/nteract/nteract/pull/3380`
- Outerbounds Workstations overview:
  `https://outerbounds.com/features/cloud-workstations`
- Metaflow notebook remote execution notes:
  `https://docs.metaflow.org/metaflow/managing-flows/notebook-runs`
