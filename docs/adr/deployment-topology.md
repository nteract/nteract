# Deployment Topology for nteract Notebook Rooms

**Status:** Draft, 2026-05-24. Supersedes GitHub issue #2284, which combined
room addressing, daemon ownership, file persistence, runtime placement, and
authorization into one epic.

## Context

Hosted notebook rooms separate document hosting, access control, compute, and
local file persistence into distinct layers:

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

Cloudflare Workers and Durable Objects serve as the primary hosted document
engine and collaboration surface. Direct Anaconda OIDC authenticates users on
`preview.runt.run`. JupyterHub attaches compute as a scoped `runtime_peer`
rather than becoming document authority.

Core nouns and authority boundaries:

- **Room host (document authority):** Process or service owning live
  `NotebookDoc` and `RuntimeStateDoc` sync, scope enforcement, fanout, and
  snapshot persistence.
- **Document engine:** Room-host implementation that materializes, validates,
  persists, and broadcasts document changes.
- **Room ACL (access authority):** D1 rows plus provider bounds deciding
  connection scope after credential validation.
- **Runtime peer (compute attachment):** Scoped connection writing runtime
  lifecycle, execution progress, outputs, and referenced blobs for accepted
  work. Cannot edit `NotebookDoc` or create execution intent.
- **Client / operator:** Browser, desktop, TUI, or agent acting for an
  authenticated principal.
- **Blob upload:** Byte transfer that becomes reachable room state only when an
  authorized `NotebookDoc` or `RuntimeStateDoc` mutation references it.
- **File binding:** Optional local `.ipynb` persistence metadata, not room
  identity or hosted ownership.

Neighbors:

- `docs/adr/identity-and-trust.md`: principals, operators, connection scopes,
  and per-frame actor validation.
- `docs/adr/hosted-room-authorization.md`: hosted room ACLs and Durable Object
  room host.
- `docs/adr/hosted-credential-transport.md`: direct OIDC, JupyterHub, browser
  WebSockets, and native credential transports.
- `docs/adr/hosted-notebook-artifacts.md`: durable snapshot bundle and blob
  layout.
- `docs/adr/hosted-output-origin-isolation.md`: separation of authenticated app
  origins, renderer asset origins, and untrusted output origins.
- `docs/audits/runtime-peer-and-blob-authority-audit.md`: `runtime_peer` role
  vs local `RuntimeAgent` machinery and `PutBlob` transfer semantics.
- `docs/adr/remote-workstation-doc-agents.md`: dial-home workstation and doc
  agent path for JupyterHub, Outerbounds Workstations, and `preview.runt.run`.

## Decision 1: Cloudflare is the hosted document engine

The primary hosted topology routes room requests through a Cloudflare Worker to
one Durable Object per notebook room, backed by Workers D1 and R2 bindings.
Alternative substrate proposals (`../memos/aws-rust-room-host.md` for native
Rust on AWS, and `../memos/celld-hosted-room-substrate.md` for running the same
Worker code on [celld](https://github.com/denoland/celld) against a fleet
bucket) are exploratory memos, not accepted deployment decisions.

The Durable Object is the live room host:

1. Accepts typed-frame v4 WebSockets from browser, desktop, agent, and
   runtime-peer clients.
2. Trusts only identity headers stamped by the Worker.
3. Enforces connection scope derived from D1 ACL rows and provider capability
   bounds.
4. Materializes `NotebookDoc` and `RuntimeStateDoc` from the latest snapshot
   pair via `runtimed-wasm`.
5. Validates scope and actor-principal rules before applying sync frames.
6. Broadcasts sync replies, presence, and runtime updates to connected peers.
7. Debounces snapshot persistence to R2 and records revision metadata in D1.

The Durable Object never runs kernels. A room without compute still supports
reading, editing, presence, comments, publishing, and ACL management.

## Decision 2: JupyterHub provides compute through runtime peers

JupyterHub-backed compute attaches to the hosted room as a `runtime_peer`
connection:

1. A user opens an Anaconda-hosted notebook room and selects or launches a
   JupyterHub runtime target.
2. A Hub-authenticated service or single-user server verifies compute access via
   JupyterHub OAuth/token and Hub access scopes.
3. The room owner grants or confirms a persistent `runtime_peer` ACL row for the
   runtime principal.
4. The runtime sidecar dials an outbound WebSocket to the Cloudflare room host
   and requests `runtime_peer`.
5. The Durable Object authorizes the connection against the room ACL and
   provider bounds.
6. The sidecar writes `RuntimeStateDoc`, uploads blobs, and emits lifecycle
   updates without editing `NotebookDoc`.

Outbound dialing from the Hub to Cloudflare lets institutional Hubs stay behind
private networks without inbound access from Cloudflare.

JupyterHub sidecars may authenticate via Hub-issued OAuth tokens, Hub service
tokens, or a future short-lived brokered attachment credential minted by the
hosted room after Hub verification. The v1 default is a persistent ACL row for a
stable Hub-backed runtime principal. In every path, the Worker validates the
credential and the room ACL authorizes `runtime_peer`.

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

`runtime_peer` is the protocol role for publishing runtime state and output.
`RuntimeAgent` is local daemon machinery supervising kernels next to their
owning daemon. Cross-machine boundaries sit at daemon or room-host edges, never
at raw `RuntimeAgent` sockets. `PutBlob` is a byte-transfer primitive, not
runtime topology.

## Decision 3: Clients connect directly or through a local bridge

Hosted rooms do not require a local daemon bridge. Four client patterns are
supported:

- **Browser direct:** First-party app sessions authenticate via the OIDC
  app-session cookie with trusted `Origin` enforcement
  (`apps/notebook-cloud/src/index.ts:720-778`). Non-cookie browser clients
  (embedded shells, explicit MCP bridges) may send a validated bearer token in
  the non-echoed WebSocket subprotocol.
- **Native direct:** Desktop, CLI, TUI, and agents connect directly using an
  `Authorization` header or equivalent native credential transport.
- **Local daemon bridge:** A desktop daemon resolves environment-backed
  credential references from machine-local `cloud-domains.toml`, connects to the
  hosted room, and exposes it to local Tauri/Unix-socket clients. Keychain
  storage and device-flow acquisition remain future work; workstation pairing
  credentials use a separate path.
- **Mixed local and hosted rooms:** One process may hold a `local:*` daemon room
  connection and a `user:anaconda:*` hosted connection simultaneously, with
  separate actor spaces and ACLs.

When bridging to a hosted room, the local daemon is an authenticated operator on
a remote room, never the room owner.

## Decision 4: Browser WebSocket origin policy is mandatory

Every browser WebSocket upgrade to a hosted room must pass an explicit origin
gate in the Worker before credential normalization and before stamping trusted
headers for the Durable Object (`hosted-credential-transport.md`):

- Same-origin notebook app pages are allowed by default.
- Extra notebook app origins require explicit configuration.
- Renderer asset origins, sandboxed output iframe origins, and arbitrary
  third-party origins are never allowed (`hosted-output-origin-isolation.md`).
- Header-authenticated native, CLI, agent, and runtime-peer clients may omit
  `Origin`, but any supplied `Origin` must be valid and trusted.

## Decision 5: Room locators are addresses, not authority

A room locator names where to reach a room host. It never encodes or grants an
ACL role, owner principal, identity provider, runtime attachment, blob
credential, or file lock.

| Locator | Room host | Auth boundary | Notes |
|---------|-----------|---------------|-------|
| `local-daemon:<uuid>` | Local daemon | Unix peer credential / same-user trust | Local room, optional file binding |
| `https://notebooks.example/n/<id>` | Cloudflare Worker + DO | OIDC / JupyterHub / native credential, then room ACL | Hosted document engine |
| `wss://notebooks.example/n/<id>/sync` | Cloudflare Worker + DO | Same as hosted URL | Direct sync endpoint |
| `hub.example/user/alice/n/<id>` | Hub deployment (if implemented) | Hub token / OAuth, then room ACL | Self-hosted option, not the preferred Anaconda topology |

`file:///path/notebook.ipynb` is a local file binding, not a hosted room
locator. A local daemon may open it into a local room or publish it to a hosted
room. Local same-path autosave safety (originally tracked as #2285) is handled
independently by cross-channel file claim leases and source-conflict
reconciliation; see `docs/adr/notebook-identity-and-path-binding.md` Decision 6.

Do not encode runtime provider, identity provider, owner principal, or blob
backend into a locator unless that component is the room host. A JupyterHub
kernel for an Anaconda-hosted room stays runtime attachment metadata plus an ACL
grant.

## Decision 6: Durable state is split by responsibility

Each Workers storage binding handles the state that fits its limits (on
Cloudflare these are the named products; on celld the same bindings persist to
the fleet bucket):

- **Durable Object memory:** live WASM handle, per-peer sync state, pending
  debounced persistence, transient broadcast queues.
- **Durable Object storage:** hibernation metadata, compact per-socket
  attachment records, small room-local coordination state.
- **D1:** notebook catalog, ACL rows, revision metadata, invite state.
- **R2:** `NotebookDoc` snapshots, `RuntimeStateDoc` snapshots, output blobs,
  render caches.

Keeping large document and output bytes out of Durable Object SQLite keeps
hibernation recovery fast, avoids row/value limits, and allows published artifact
reads without waking the room host.

## Decision 7: Runtime attachment is explicit product state

A room never infers compute from its URL or user identity (Decision 5). Its
attachment state is explicit room metadata:

- no runtime attached;
- local desktop runtime attached as `runtime_peer`;
- JupyterHub runtime attached as `runtime_peer`;
- future managed Anaconda runtime attached as `runtime_peer`.

The room surfaces the active runtime peer, provider, and connection state.
Interrupt, restart, shutdown, and execution requests route through the room host
to the active runtime peer; the room host creates accepted execution entries and
the runtime peer reports progress via `RuntimeStateDoc`.

## Current deployments

Operational snapshot of where this Worker/DO model runs today. Cloudflare
remains the primary topology described in Decision 1.

### Deployed substrates (as of 2026-10-29)

| Deployment | App | Substrate | Identity | Source |
|------------|-----|-----------|----------|--------|
| `preview.runt.run` | `apps/notebook-cloud` | Cloudflare Workers, Durable Objects, D1, R2 | Anaconda stage OIDC | `apps/notebook-cloud/wrangler.toml`, `apps/notebook-cloud/DEPLOY.md` |
| `main.runtimed.run` and `<id>.runtimed.run` PR previews | `apps/notebook-cloud` | celld on EC2, run by private `nteract/preview-infra` controller | Controller-owned | `.github/preview/README.md`, `celld-local.mjs export` in `.github/workflows/build.yml` and `preview-reusable.yml` |
| `pages.runtimed.run` and `page10.runtimed.run` | Pages | celld 0.6.3 on `lab1`, `CELLD_DURABILITY=bucket`, S3 fleet bucket, Cloudflare Tunnel ingress | Anaconda production OIDC | `apps/pages/DEPLOYMENT.md`, `scripts/deployment/profiles.mjs`, `install.mjs` |

Pages is a separate application, not a notebook room host. `pages.runtimed.run`
and Page10 are isolated targets on separate services and prefixes; Page9 and
earlier Pages services are frozen. The promotion gates in
`../memos/celld-hosted-room-substrate.md` remain unmet for every celld
deployment above.

### Hosted runtime resume behavior (as of 2026-09-04)

Hosted attachment and execution requests are currently owner-only
(`ensureRuntimeForHostedExecution` in `apps/notebook-cloud/src/notebook-room.ts`):

- With no active runtime peer, owner execution can queue while the selected
  attachment is already connecting.
- Otherwise it can create a resume attach job for a previously selected
  registered workstation in `ready`, `disconnected`, or `idle` state, provided
  the workstation belongs to the notebook owner and passes online, lease, and
  heartbeat checks.
- If no eligible attachment exists, the room rejects execution with a
  no-runtime-peer error rather than falling back to unrelated compute.

## Platform Constraints and Research Notes

### Cloudflare Durable Objects

Durable Objects coordinate WebSocket rooms per object and hibernate idle sockets
without disconnecting clients. Because hibernation resets in-memory state, the
constructor must only install cheap state and register lazy rehydration. Every
`webSocketMessage`, `webSocketClose`, `webSocketError`, and `fetch` handler that
touches room state must ensure the WASM handle, ACL snapshot, and socket
attachments are rehydrated from DO storage, D1, and R2 before processing.

Platform limits shaping this design:

- **Single-threaded soft throughput limit:** high-traffic public rooms will
  eventually need a read-only fanout layer or sharding.
- **32 MiB incoming WebSocket message cap:** reinforces keeping large outputs on
  blob side channels rather than sync frames.
- **SQLite storage limits (10 GB per object on paid plans, 2 MB row/value
  limit):** keeps full snapshots and output blobs in R2 while D1/SQLite hold
  catalog, ACL, revision, and hibernation metadata.
- **Bounded per-message CPU budget:** expensive clone-preview validation must
  move to a lower-cost Automerge parser path before broad multi-user editing.

### JupyterHub and Anaconda OIDC

JupyterHub services and single-user servers resolve OAuth/API tokens against the
Hub, and Hub access scopes govern compute access. Those scopes authorize Hub
compute only; the nteract room ACL still grants `runtime_peer`, `editor`, or
`owner`.

On the hosted room side, `preview.runt.run` authenticates users via direct
Anaconda stage OIDC; the Worker validates Anaconda-issued bearer JWTs before
checking the room ACL.

External references:

- Cloudflare Durable Objects WebSockets:
  `https://developers.cloudflare.com/durable-objects/best-practices/websockets/`
- Cloudflare Durable Objects limits:
  `https://developers.cloudflare.com/durable-objects/platform/limits/`
- JupyterHub services:
  `https://jupyterhub.readthedocs.io/en/latest/reference/services.html`
- JupyterHub scopes:
  `https://jupyterhub.readthedocs.io/en/latest/rbac/scopes.html`
- Anaconda Enterprise SSO:
  `https://www.anaconda.com/docs/anaconda-platform/cloud/admin/integrations/esso`

## Non-Goals

- Mesh sync between arbitrary desktop daemons.
- SSH as the first remote-room transport.
- Running kernels inside Cloudflare Workers or Durable Objects.
- Using JupyterHub as the default document engine for Anaconda-hosted rooms.
- Treating preserved pre-publish actor history as verified attribution (current
  publish carries source actor history; re-authoring at the publish boundary is
  the target in `identity-and-trust.md` Decision 6).
- Local same-path file-binding safety (covered separately by cross-channel file
  claims in `docs/adr/notebook-identity-and-path-binding.md` Decision 6).

## Open Questions

1. **Runtime principal shape:** Should a JupyterHub runtime sidecar authenticate
   as `hub:<hub-host>:<user-server>` directly, or should the room mint a
   room-scoped runtime principal after Hub verification?
2. **Delegated execute / attach capability:** Attaching compute and running
   cells are currently owner-only. Should a future explicit capability delegate
   either action without granting owner authority? (`editor` alone must never
   grant execution.)
3. **Token exchange:** Is direct Hub token validation by the Worker enough for
   v1, or do we need a Cloudflare-brokered token for Hub sidecars?
4. **Live revocation:** When an owner removes a `runtime_peer` ACL row, should
   the DO close that WebSocket immediately via `SESSION_CONTROL`, or only block
   reconnects until the revocation ADR lands?
5. **Offline editing:** Should native clients cache hosted snapshots for offline
   edits, or keep hosted rooms online-only until signed-change and conflict UX
   are ready?
6. **Fanout threshold:** At what viewer count does a public room need a
   read-only fanout layer instead of direct Durable Object WebSockets?
