# Deployment Topology for nteract Notebook Rooms

**Status:** Draft, 2026-05-24.
**Supersedes:** GitHub issue #2284, which mixed room addressing, daemon
ownership, file persistence, runtime placement, and authorization into one
epic.

## Context

The identity and hosted-room ADRs split the notebook-room problem into separate
layers:

- `identity-and-trust.md` defines principals, operators, connection scopes, and
  per-frame actor validation.
- `hosted-room-authorization.md` defines the hosted room ACL and makes the
  Durable Object the live document host.
- `hosted-credential-transport.md` defines how Cloudflare Access, OIDC,
  JupyterHub, browser WebSockets, and native clients present credentials.
- `hosted-notebook-artifacts.md` defines the durable snapshot pair and blob
  layout.
- `runtime-peer-and-blob-authority-audit.md` clarifies that `runtime_peer` is
  the room role, `RuntimeAgent` is local daemon machinery, and `PutBlob` is not
  runtime topology.

The old notebook-URI direction was useful because it recognized that a notebook
room needs a stable address and that daemons should not independently mutate the
same room. The stale part is that it treated URI, ownership, and compute
placement as the same concept. The current model has sharper nouns:

- **room host**: the process or service that owns the live `NotebookDoc` and
  `RuntimeStateDoc` sync state;
- **document engine**: the room-host implementation that materializes,
  validates, persists, and broadcasts document changes;
- **runtime peer**: a scoped connection that writes runtime lifecycle, output,
  and blob state, but cannot edit `NotebookDoc`;
- **client/operator**: browser, desktop, TUI, or agent connection that acts on
  behalf of an authenticated principal;
- **file binding**: an optional local `.ipynb` persistence surface, not the
  identity of the room.

Authority boundaries:

- A **room locator** is an address for reaching a room host. It is not an ACL
  grant, runtime attachment, owner claim, blob credential, or file lock.
- The **room host** is document authority. It owns live document materialization,
  scope enforcement, sync fanout, and snapshot persistence for the room.
- The **room ACL** is access authority. Credentials authenticate principals;
  ACL rows and provider bounds decide the connection scope.
- A **runtime peer** is compute authority only for the room surfaces its scope
  grants: runtime state, output, lifecycle, and referenced blobs. It does not
  own the room and does not move the document authority to JupyterHub.
- A **blob upload** is byte transfer. It becomes reachable room state only when
  an authorized `NotebookDoc` or `RuntimeStateDoc` mutation references it.
- A **file binding** is local persistence metadata. It is not the room identity
  and should not decide who owns a hosted room.

The desired product direction is:

```text
browser / desktop / agent
        |
        | authenticated typed-frame v4 WebSocket
        v
Cloudflare Worker + Durable Object room host
        |
        | scoped runtime_peer WebSocket
        v
JupyterHub runtime sidecar / compute
```

Cloudflare is the document engine and collaboration surface. Anaconda OIDC,
usually through Cloudflare Access for the first hosted path, authenticates users
into the room. JupyterHub provides compute by attaching a runtime peer to that
room, not by becoming the room's document authority.

## Research Notes

Cloudflare Durable Objects fit the hosted document-engine role because they are
stateful Workers that can act as WebSocket servers, coordinate many clients per
object, and hibernate idle WebSocket rooms without disconnecting clients. The
hibernation model resets in-memory state when the object wakes, so a room host
must restore its WASM handle and per-socket attachments from durable state
rather than assume memory is durable. Cloudflare re-runs the constructor before
delivering a hibernation wake event, but the constructor should only install
cheap process state and register lazy rehydration. Every `webSocketMessage`,
`webSocketClose`, `webSocketError`, and `fetch` path that touches room state
must first ensure the WASM handle, ACL snapshot, and socket attachments are
loaded from Durable Object storage, D1, and R2 before processing the event.

Current Durable Object limits are compatible with one object per notebook room
as the coordination point, with guardrails:

- an individual object is single-threaded and has a soft throughput limit, so
  high-traffic public rooms eventually need fanout or sharding;
- incoming WebSocket messages are capped at 32 MiB, matching the need for blob
  side channels instead of sending large outputs as sync frames;
- SQLite-backed object storage has a 10 GB per-object limit on paid plans and
  2 MB row/value limits, so full notebook snapshots and large output blobs stay
  in R2, while D1/SQLite store catalog, ACL, revision, and hibernation metadata;
- each incoming WebSocket message gets a bounded CPU budget, so expensive
  clone-preview validation must be replaced by the lower-cost Automerge parser
  path before broad multi-user editing.

JupyterHub fits the compute side because services and single-user servers are
already OAuth/token-authenticated through the Hub. Hub services can resolve a
token to a user model by calling the Hub, and JupyterHub access scopes govern
whether a user or token can access a service or single-user server. Those Hub
scopes authorize access to Hub compute. They do not grant nteract room roles;
the nteract room ACL still grants `runtime_peer`, `editor`, or `owner`.

Anaconda auth fits the hosted room side as an OIDC identity source. For the
first Anaconda-friendly deployment, Cloudflare Access can own the browser login
flow with Anaconda configured as a generic OIDC provider, and the Worker
validates the Access assertion before consulting the room ACL. Direct Anaconda
OIDC validation can come later if we need Anaconda-scoped principals instead of
Access-scoped principals.

References:

- Cloudflare Durable Objects WebSockets:
  `https://developers.cloudflare.com/durable-objects/best-practices/websockets/`
- Cloudflare Durable Objects limits:
  `https://developers.cloudflare.com/durable-objects/platform/limits/`
- Cloudflare Access generic OIDC:
  `https://developers.cloudflare.com/cloudflare-one/identity/idp-integration/generic-oidc/`
- Cloudflare Access JWT validation:
  `https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/`
- JupyterHub services:
  `https://jupyterhub.readthedocs.io/en/latest/reference/services.html`
- JupyterHub scopes:
  `https://jupyterhub.readthedocs.io/en/latest/rbac/scopes.html`
- Anaconda Enterprise SSO:
  `https://www.anaconda.com/docs/anaconda-platform/cloud/admin/integrations/esso`

## Decision 1: Cloudflare is the hosted document engine

The primary hosted topology is a Cloudflare Worker routing room requests to one
Durable Object per notebook room. The Durable Object is the live room host:

1. It accepts typed-frame v4 WebSockets from browser, desktop, agent, and
   runtime-peer clients.
2. It authenticates only trusted headers stamped by the Worker.
3. It derives connection scope from D1 ACL rows and provider capability bounds.
4. It materializes `NotebookDoc` and `RuntimeStateDoc` from the latest snapshot
   pair using `runtimed-wasm`.
5. It applies sync frames through the WASM handle after scope and actor-principal
   validation.
6. It broadcasts sync replies, presence, and runtime updates to connected peers.
7. It debounces snapshot persistence to R2 and records revision metadata in D1.

The Durable Object does not run kernels. It can host a room with no active
runtime peer and still support reading, markdown editing, presence, comments,
publishing, and ACL management.

This topology makes the hosted room URL the stable document address. The URL
does not encode who owns the room, where compute runs, or which provider
authenticated the user. Those are ACL, credential, and runtime-attachment
questions.

## Decision 2: JupyterHub provides compute through runtime peers

JupyterHub-backed compute attaches to the Cloudflare-hosted room as a
`runtime_peer` connection.

The preferred flow:

1. A user opens an Anaconda-hosted notebook room.
2. The user selects or launches a JupyterHub runtime target.
3. A Hub-authenticated service or single-user server verifies that the user may
   access that compute target using JupyterHub OAuth/token and access scopes.
4. The room owner grants or confirms a persistent `runtime_peer` ACL row for
   the runtime principal.
5. The runtime sidecar opens an outbound WebSocket to the Cloudflare room host
   and requests `runtime_peer`.
6. The Durable Object authorizes the connection against the room ACL and
   provider bounds.
7. The runtime sidecar writes `RuntimeStateDoc`, uploads blobs, and emits
   lifecycle broadcasts. It cannot edit `NotebookDoc`.

The runtime connection should be outbound from the Hub side to Cloudflare. That
avoids requiring Cloudflare to reach into a user's private Hub deployment and
fits Hub deployments that sit behind institutional networking.

JupyterHub may authenticate the runtime sidecar in more than one way:

- Hub-issued OAuth token for a service or single-user server;
- service token controlled by the Hub deployment;
- future brokered token where the hosted room issues a short-lived runtime
  attachment credential after the Hub proves the user/server identity.

The v1 default is the persistent ACL-row path. A Hub-authenticated sidecar maps
to a stable runtime principal, that principal receives `runtime_peer` in the
room ACL, and each connection still presents a normal credential that the Worker
validates. A short-lived brokered runtime attachment credential is a later path
for deployments that cannot expose a stable Hub-backed runtime principal to the
room ACL. In both paths, the nteract room sees a validated principal requesting
`runtime_peer`, and the room ACL decides whether that connection is allowed.

### Runtime attachment topologies

Hosted v1:

```text
browser/desktop/agent -> Cloudflare DO room host <- JupyterHub runtime_peer sidecar
```

Daemon-mediated / SSH future:

```text
local client/daemon -> room host or bridge <-> remote daemon(runtime_peer)
  -> runtime agent local to remote daemon -> kernel
```

`runtime_peer` is the protocol and product role: an authenticated room
connection allowed to publish runtime state and output. `RuntimeAgent` is a
local daemon implementation detail for supervising kernels near the daemon that
owns them. Cross-machine boundaries should be daemon or room-host boundaries,
not `RuntimeAgent` socket boundaries. `PutBlob` is the byte-transfer primitive
used by authorized write and runtime peers; it is not itself the runtime
topology.

## Decision 3: Clients can connect directly or through a local bridge

The identity model does not require a local daemon bridge for hosted rooms.
Supported client-to-room patterns:

- **Browser direct.** The browser connects to the hosted room WebSocket. For the
  Anaconda-friendly path, Cloudflare Access handles browser login and forwards a
  validated Access assertion to the Worker.
- **Native direct.** Desktop, CLI, TUI, and agents connect directly to the room
  WebSocket with an `Authorization` header or equivalent native credential
  transport.
- **Local daemon bridge.** A desktop daemon stores credentials in the OS
  keychain, connects to the hosted room, and exposes local Tauri/Unix-socket
  clients to that remote room. This is a convenience and credential-management
  topology, not the security primitive.
- **Mixed local and hosted rooms.** One process may hold a `local:*` connection
  to a local daemon room and a `user:anaconda:*` or Access-scoped connection to
  a hosted room at the same time. The two rooms have separate actor spaces and
  ACLs.

The local bridge is useful for desktop ergonomics and agent delegation, but it
must not recreate #2284's implicit "the local daemon owns the room" model. When
bridging to a hosted room, the local daemon is just another authenticated
operator on a remote room.

## Decision 4: Browser WebSocket origin policy is mandatory

Browser WebSocket upgrades to hosted rooms must pass an explicit origin gate.
This topology inherits the credential transport ADR's rule: any browser-visible
credential transport, and especially Cloudflare Access cookie/assertion auth,
requires the Worker to reject missing, malformed, or untrusted `Origin` values
before the Durable Object sees the connection.

Minimum policy:

- same-origin notebook application pages are allowed by default;
- additional notebook application origins must be configured explicitly;
- renderer asset origins, sandboxed output iframe origins, and arbitrary
  third-party origins are never allowed to open authenticated room WebSockets;
- header-authenticated native, CLI, agent, and runtime-peer clients may omit
  `Origin`, but any supplied `Origin` must still be valid and trusted.

This ADR decides where the origin gate lives: the Worker enforces it before
credential normalization and before stamping trusted room headers. The detailed
credential-specific rules remain in `hosted-credential-transport.md`.

## Decision 5: Room locators are addresses, not authority

A room locator tells a client where to connect. It does not grant access and it
does not define runtime placement.

Examples:

| Locator | Room host | Auth boundary | Notes |
|---------|-----------|---------------|-------|
| `local-daemon:<uuid>` | local daemon | Unix peer credential / same-user trust | Local room, optional file binding |
| `https://notebooks.example/n/<id>` | Cloudflare Worker + DO | Access/OIDC/JupyterHub/native credential, then room ACL | Hosted document engine |
| `wss://notebooks.example/n/<id>/sync` | Cloudflare Worker + DO | Same as hosted URL | Direct sync endpoint |
| `hub.example/user/alice/n/<id>` | Hub deployment, if implemented | Hub token/OAuth, then room ACL | Possible self-hosted room host, not the preferred Anaconda-hosted topology |

`file:///path/notebook.ipynb` is not a hosted room locator. It is a local file
binding. A local daemon may open it into a local room, import/publish it into a
hosted room, or refuse to autosave if another daemon owns the same file binding.
The same-path autosave collision remains tracked by #2285 and should be fixed
with a local lock/heartbeat or dirty-disk refusal independent of this hosted
topology.

Do not encode runtime provider, identity provider, owner principal, or blob
backend into a locator unless that component is actually the room host. A
JupyterHub-backed kernel for an Anaconda-hosted room remains runtime attachment
metadata and an ACL grant, not part of the room address.

## Decision 6: Durable state is split by responsibility

The hosted room uses each Cloudflare storage product for the part it is good at:

- **Durable Object memory**: live WASM handle, per-peer sync state, pending
  debounced persistence, transient broadcast queues.
- **Durable Object storage**: hibernation metadata, compact per-socket
  attachment records, small room-local coordination state.
- **D1**: notebook catalog, ACL rows, revision metadata, invite state.
- **R2**: `NotebookDoc` snapshots, `RuntimeStateDoc` snapshots, output blobs,
  render caches.

Large document and output bytes do not live in Durable Object SQLite rows. This
keeps hibernation recovery cheap, avoids row/value limits, and makes published
artifacts inspectable without waking the room host for every blob read.

## Decision 7: Runtime attachment is explicit product state

Runtime attachment is not inferred from room URL or user identity. A room can be
in one of these states:

- no runtime attached;
- local desktop runtime attached as `runtime_peer`;
- JupyterHub runtime attached as `runtime_peer`;
- future managed Anaconda runtime attached as `runtime_peer`.

The room should surface the active runtime peer, its provider, and its
connection state as room metadata. Interrupt, restart, shutdown, and execution
requests target the active runtime peer through scoped room requests and
`RuntimeStateDoc` transitions. If no runtime peer is attached, execution
requests fail with a typed "no runtime attached" response rather than trying to
infer compute from the document host.

## Non-Goals

- Mesh sync between arbitrary desktop daemons.
- SSH as the first remote-room transport.
- Moving kernels into Cloudflare Workers or Durable Objects.
- Treating JupyterHub as the default document engine for Anaconda-hosted rooms.
- Preserving pre-publish local Automerge actor history inside hosted rooms.
- Solving the local same-path autosave bug; #2285 remains the concrete bug for
  local file-binding safety.

## Open Questions

1. **Runtime principal shape.** Should a JupyterHub runtime sidecar authenticate
   as `hub:<hub-host>:<user-server>` directly, or should the Cloudflare room
   mint a room-scoped runtime principal after Hub verification?
2. **Runtime attachment grant UX.** Is attaching compute an owner-only action,
   an editor action, or a separate capability?
3. **Token exchange.** Do we need a first-party brokered token from Cloudflare
   to the Hub sidecar, or is direct Hub token validation by the Worker enough
   for v1?
4. **Revocation.** If an owner removes a runtime-peer ACL row, should the DO
   close that live WebSocket immediately via session-control, or only reject
   reconnects until the revocation ADR lands?
5. **Offline editing.** Should native clients cache hosted snapshots and allow
   offline edits, or should hosted rooms be online-only until signed-change /
   conflict UX is clearer?
6. **Backpressure and fanout.** What is the first threshold where a public room
   needs a read-only fanout layer instead of every viewer WebSocket hitting the
   same Durable Object?

## Implementation Sequence

1. Keep `hosted-room-authorization.md` moving first: DO as live document host,
   ACL lookup before WebSocket admission, and snapshot persistence.
2. Add explicit runtime attachment metadata and UI/API vocabulary without
   launching JupyterHub yet.
3. Define typed failure states for no runtime, runtime disconnected, credential
   expired, and ACL revoked before the first Hub prototype consumes those
   errors.
4. Implement `runtime_peer` WebSocket attach from a trusted local/runtime test
   sidecar to prove the frame path.
5. Prototype a JupyterHub service or single-user sidecar that authenticates
   with Hub OAuth/token, starts a kernel, and opens outbound `runtime_peer`
   sync to the Cloudflare room.
6. Define the runtime attachment grant/token exchange after the prototype
   proves which side needs to mint which credential.
7. Only after the hosted runtime path is proven, revisit whether any of #2284's
   local URI-discovery work is still needed beyond #2285's file-binding safety
   stopgap.
