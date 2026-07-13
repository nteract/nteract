# Cloud-Connected Local MCP Clients

**Status:** Draft, 2026-06-12.

## Context

nteract's MCP server is currently local-first: one stdio MCP process talks to a
local `runtimed` daemon over a Unix socket, holds one active
`NotebookSession`, and exposes tools such as `connect_notebook`,
`create_notebook`, `insert_cell`, and `execute_cell`. That model works well for
local notebooks because the agent edits the same Automerge document set the
desktop app sees.

Hosted notebooks at configured nteract cloud origins now use the same document
split: `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` travel over typed-frame
v4 WebSockets. The browser viewer and workstation/runtime peers already prove
that native clients can speak the hosted room protocol with explicit
credentials, connection scope, principal, and operator attribution.

`preview.runt.run` is one staging deployment and useful development target. It
is not a built-in Desktop remote or a default in stable distributions.

The next agent workflow should not require registering one MCP server per
notebook. A local MCP client should be able to call:

```json
{
  "target": "https://notebooks.example.com/n/01KT..."
}
```

and have the already-registered local MCP server connect to that hosted notebook
as a first-class Automerge peer. The same local MCP server should still support
local file paths and local daemon room ids.

This ADR defines that addressing and config model. It is intentionally an ADR
first because it crosses existing settings, MCP session lifecycle, hosted
credential transport, and identity boundaries.

Neighbors:

- `docs/adr/mcp-resource-addressing.md` keeps `nteract://` MCP resources
  separate from room locators.
- `docs/adr/mcp-session-lifecycle.md` defines the single active session,
  parked sessions, proxy rejoin, and daemon-local room lifecycle.
- `docs/adr/identity-and-trust.md` defines the principal/operator actor-label
  model.
- `docs/adr/hosted-credential-transport.md` defines hosted WebSocket
  credential transport and app-session/browser behavior.
- `docs/adr/remote-workstation-doc-agents.md` defines workstation doc agents
  and room-scoped runtime peers.
- `docs/memos/hosted-notebook-federation.md` explores the account-aware
  registry above this origin-scoped V1 config and treats JupyterHub primarily
  as a compute provider.

## Vocabulary

- **Room locator**: an address used to reach a notebook room host, such as a
  local path, a local room id, or `https://notebooks.example.com/n/<id>/<slug>`.
- **MCP resource URI**: a local resource name exposed by an MCP server, such as
  `nteract://notebooks/<id>/cells`. It is not a room locator.
- **Cloud domain registry**: machine-local configuration that maps hosted
  nteract origins such as `https://notebooks.example.com` to credential
  references and an optional fallback operator for headless clients. The
  registry may contain zero, one, or many origins; its default origin is
  optional.
- **Principal**: the authenticated entity proven by a credential, such as a
  user account or service account.
- **Operator**: the local process/persona acting under that principal, such as
  `agent:codex:lab2` or `agent:opencode:mbp`.

## Decision 1: One local MCP server resolves local and hosted notebook targets

Keep the user-facing MCP registration machine-scoped, not notebook-scoped.
Agents register one local nteract MCP server. Notebook selection remains a tool
call.

Extend `connect_notebook` with a `target` argument while keeping the existing
`path` and `notebook_id` arguments for compatibility. Add an optional `domain`
argument for `notebook_id` so callers can say which notebook namespace the id
belongs to without inventing another tool.

Exactly one of `target`, `path`, or `notebook_id` may be provided. `domain` is
only meaningful with `notebook_id`; omitted `domain` preserves today's local
daemon behavior.

Resolution order:

| Input | Connector |
| --- | --- |
| `path` or path-like `target` | Local daemon `connect_open(path)` |
| `notebook_id` with no `domain`, or `domain = "local"` / `"desktop"` | Local daemon `connect(uuid)` |
| `https://<host>/n/<id>` or `https://<host>/n/<id>/<slug>` | Hosted room on the matching configured domain |
| `notebook_id` plus `domain = "https://<host>"` | Hosted room on the matching configured domain |

The hosted URL is a room locator, not a credential. Authentication comes from
local config, environment, OS keychain, or a future credential helper.

Hosted URL targets must match a configured cloud domain before any credential
is attached. Unknown hosted origins should produce an actionable configuration
error. Do not send a default domain's credential to an arbitrary pasted URL.

Do not treat `nteract://notebooks/...` as a connect target. That namespace
remains the MCP resource namespace exposed after a session exists.

Remote aliases such as `preview:01KT...` are intentionally reserved but not
supported in the first implementation. A URL target or `notebook_id` plus
`domain` is slightly more verbose, but it keeps initial routing explicit and
avoids maintaining a second user-facing naming layer before the cloud domain
registry has settled.

Local room ids are UUIDs today, while hosted notebook ids are ULIDs. A parser
can therefore distinguish them structurally, but v1 should still avoid treating
a bare hosted ULID as a default-remote notebook. Requiring a hosted URL or
`domain` is a chosen guardrail, not a technical limitation.

## Decision 2: Cloud host configuration is a machine-local, multi-host registry

Do not store hosted remote credentials in `SyncedSettings` or the synced
settings Automerge document.

Current synced settings are daemon preferences mirrored to
`settings.json`: theme, default runtime, default Python environment, pool sizes,
telemetry, redaction, and similar local behavior. The settings document is
designed to sync across windows on the same daemon and to tolerate external JSON
edits. It is not a credential store, and cloud API keys must not become part of
that live settings document.

Use the separate machine-local `cloud-domains.toml` registry in the existing
config namespace. For example:

```toml
# Optional, and present only after an explicit user choice:
# default_domain = "https://notebooks.example.com"

[[domains]]
base_url = "https://notebooks.example.com"
# Optional fallback when a headless client does not declare its operator:
operator = "agent:codex:lab2"
credential = { kind = "oidc-bearer-env", env = "NTERACT_NOTEBOOKS_TOKEN" }

[[domains]]
base_url = "https://research.example.net"
credential = { kind = "anaconda-api-key-env", env = "NTERACT_RESEARCH_API_KEY" }
```

The following properties are load-bearing:

- the registry may contain zero, one, or many normalized hosted origins;
- a missing file or empty registry means no cloud hosts are configured;
- the stable Desktop/MCP registry starts empty and those clients synthesize no
  host or default, specifically not an implicit `preview.runt.run` entry;
- `default_domain` is optional, must name an existing registry entry, and may
  be consulted only after the caller has explicitly chosen a cloud operation;
  it never reinterprets a bare notebook id as remote;
- non-secret routing and domain data may live in the registry;
- bearer values are read from environment variables, OS keychain, or a future
  secret helper, not persisted as plaintext by `runt config`;
- the registry is machine-local and may differ between Desktop, Codex, CI,
  workstation hosts, and user laptops;
- the registry is consumer-neutral and shared by daemon bridges, MCP, CLI, and
  the Desktop host adapter;
- secrets are resolved in the native process; webviews receive host metadata
  and catalog results, not bearer values;
- `runt config` remains for synced daemon preferences unless we intentionally
  add a separate `runt cloud ...` or `runt remote ...` command group.

The configured credential is the root credential for the hosted principal, not
necessarily the credential sent on every sync frame or WebSocket. A hosted
implementation may exchange it for a short-lived notebook sync ticket scoped to
one domain, notebook, operator, actor/session nonce, and capability set. Direct
bearer transport and ticket transport should remain an implementation detail of
the cloud connector, not a new MCP tool shape.

This keeps the existing settings contract small and lets cloud domains evolve
without turning every settings-sync consumer into an auth surface.

## Decision 3: The local MCP process becomes the hosted room client

For hosted targets, `runt mcp` should establish a WebSocket to the hosted room
using `notebook-cloud-transport` and expose the resulting document set through
the same MCP tools used for local sessions.

The local MCP server is still the active client:

```text
MCP client
  -> local runt mcp
    -> local target: runtimed Unix socket
    -> hosted target: typed-frame v4 WebSocket to configured host
```

This is deliberately different from a remote MCP service. A remote MCP service
may be useful later for hosted automation, but it would make the remote service
the document reader/writer and would hide the local Automerge peer from the
agent. The first-class path is a local stdio MCP server syncing directly with
the hosted room.

Hosted sessions should preserve the existing MCP semantics:

- one active notebook session per MCP connection;
- bounded parked sessions for recently touched notebooks;
- `show_notebook`, cell CRUD, dependency inspection, and read-only resources
  operate over the active session;
- `disconnect_notebook` drops this MCP process's peer without implying room or
  kernel shutdown.

The implementation may need a session-handle abstraction because existing tools
assume a local `DocHandle`. That abstraction should represent the same stable
document set (`NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`) rather than copying
cloud state into React-specific or MCP-specific projections.

### Daemon-mediated bridge vs. direct MCP connector

Two hosted-room connection paths coexist:

**Daemon-mediated bridge** (commit 0745eeab, #3884) — the product default for
desktop notebook use. The daemon dials the hosted room over
`CloudWsFrameTransport` and attaches it as one more sync peer of a local
ephemeral `NotebookRoom` (`hosted_bridge.rs`). Desktop windows and MCP sessions
connect to that daemon-local room exactly like any daemon-local notebook. Echo
suppression is structural (one `NotebookDoc`, one `sync::State` per peer). The
hosted room is authoritative for `RuntimeStateDoc`; execution requests forward
as hosted `Request` frames.

**Direct MCP connector** (`runt-mcp/src/cloud.rs`) — still implemented but not
the primary desktop path. `runt mcp` establishes a typed-frame v4 WebSocket
directly to the hosted room without a daemon bridge.

When to use each:

- **Desktop app, Codex app/CLI:** daemon-mediated bridge. The desktop app
  attaches to a daemon notebook room; the daemon bridges to the hosted room if
  the notebook's domain is hosted.
- **Standalone MCP clients, agents without daemons:** direct connector. No
  daemon required; the MCP process holds the WebSocket.

Both paths resolve the same machine-local `cloud-domains.toml` (shared via
`notebook-cloud-transport::registry`) and produce the same principal/operator
actor labels.

## Decision 4: Principal comes from the credential; operator comes from the initiating client

Hosted room auth still decides the principal. If the configured credential is
an Anaconda API key, the principal is the Anaconda-scoped principal returned by
the hosted identity layer. If it is a service-account key such as
`quilldaemon`, that service account is the principal.

The initiating client supplies an operator descriptor per connection. Desktop
declares a Desktop operator in its hosted-open handshake; Codex and other agents
declare their agent operator through their MCP connection. The registry's
optional `operator` field is only a fallback for headless clients that do not
declare one. It must not replace an explicit per-connection operator or cause a
Desktop-initiated action to be attributed to an agent.

The operator is attribution metadata, not authorization. Examples:

```text
user:anaconda:<sub>/agent:codex:lab2
user:anaconda:<sub>/agent:opencode:mbp
user:anaconda:<quilldaemon-sub>/agent:codex:lab2
```

Because Automerge actors cannot be reused concurrently by independent document
instances, the actual actor label used on a hosted sync connection should be
unique per live process or backed by persisted actor state. The existing cloud
runtime path appends a short nonce:

```text
<principal>/<operator>:<nonce>
```

That is safe for concurrent processes and avoids duplicate sequence collisions.
If a future MCP client persists actor state for a remote notebook, it may use a
stable actor only when it can guarantee the same actor is not live in another
process.

Parked hosted sessions keep the same live session object and therefore keep the
same actor label while parked and resumed inside one MCP process. A reconnect
after the hosted socket has been dropped should mint a fresh nonce unless an
implementation introduces a persisted actor store with a single-writer lease.
Persisted actor reuse across process restarts is unsafe if the prior connection
may still be alive.

## Decision 5: Hosted catalogs are explicit, host-qualified, and headless

Local `list_active_notebooks` should remain a daemon-local view. It lists active
local daemon rooms and should not surprise callers with network traffic.

Hosted catalog access must be a local cloud capability, not a React or
browser-dashboard store. It accepts an explicitly resolved registry entry,
authenticates process-side against the host-owned catalog API, and returns typed
notebook summaries qualified by both normalized origin and notebook id. MCP
tools, CLI commands, and the Desktop host adapter should consume the same
boundary.

Do not add a separate hosted-listing tool. The cloud-aware listing surface
should be one `list_notebooks` tool with an optional `domain` parameter. While
hosted MCP access remains hidden/early, omitted `domain` defaults to the
desktop-local daemon view so existing clients do not unexpectedly make network
requests:

| `domain` | Source |
| --- | --- |
| omitted | local daemon rooms |
| `"local"` or `"desktop"` | local daemon rooms |
| `https://<host>` | hosted catalog for that configured domain |

The important distinction is:

- local active rooms are live daemon state;
- hosted notebook lists are catalog/API state from configured domains;
- parked MCP sessions are local MCP process state.

A unified UI response may group those sources, but the source must stay visible
in the structured response so agents do not mistake a hosted catalog row for a
warm local daemon room.

The first Desktop slice may expose tested host-adapter operations to list
configured hosts, list notebooks for one explicitly selected host, and open a
hosted locator without registering a visible page, menu item, or stable feature
flag. Landing this headless capability does not commit the product to a
dashboard layout or to opening hosted notebooks in a browser versus a Desktop
notebook window.

## Decision 6: Execution and workstation attachment stay separate

Connecting the local MCP server to a hosted notebook gives the agent document
access according to its hosted room ACL. It does not automatically attach local
compute or grant runtime authority.

If the same machine should provide compute, that is a second action through the
workstation/runtime-peer path:

1. local MCP connects to the hosted notebook as owner/editor;
2. local workstation/daemon registers as an available workstation;
3. user or agent selects that workstation for the notebook;
4. workstation attaches a room-scoped `runtime_peer`;
5. execution intent is created by the room host, and the runtime peer executes
   accepted queue entries.

This preserves the authority split from `remote-workstation-doc-agents.md`:
document editing, workstation registration, runtime attachment, and kernel
execution are related but not the same permission.

Current `main` already has `runt workstation connect` and
`runt workstation run` for the workstation pairing flow. Those commands manage
workstation credentials and runtime attachment. The MCP cloud domain registry in
this ADR is for document-client credentials and target resolution; it should not
replace or silently reuse workstation pairing credentials.

## Decision 7: Remote reconnect follows MCP session lifecycle rules

Hosted sessions should use the same user-initiated-session-wins rule as local
daemon sessions.

If a background hosted reconnect is in progress and the MCP client calls
`connect_notebook` for another target, the new user-initiated target wins. The
old reconnect result is dropped. Transport sync state may be reset on hosted
reconnect; document truth is preserved by the hosted room.

Remote rejoin state should store the original room locator, not just the room
id, because the same id may be meaningful only within a remote origin. For
example:

```text
remote:https://notebooks.example.com:01KT...
https://notebooks.example.com/n/01KT...
```

The MCP proxy's `NTERACT_MCP_REJOIN_NOTEBOOK` handoff may need to evolve from a
bare notebook id into an encoded session target. That should be a compatibility
change: old values keep meaning local notebook ids.

## Open Follow-ups

- **Shared typed catalog client:** Extract the MCP-private hosted catalog request
  into a process-side client used by MCP, CLI, and the Desktop host adapter.
  Current MCP code still returns untyped JSON, and Desktop has no cloud catalog
  namespace yet.
- **Machine-local registry management:** Add normalized, atomic list/upsert/
  remove/default operations and a headless CLI or equivalent native management
  surface before exposing stable host-configuration UI.
- **Per-connection operator precedence:** Ensure an explicit Desktop or MCP
  operator descriptor wins over the registry fallback, with coverage showing
  that Desktop and Codex using the same host credential retain distinct
  attribution.
- **Explicit stable publish target:** `runt-publish` currently defaults to
  `preview.runt.run`. Remove that product default, or confine it to explicit
  development tooling, before publishing is exposed through stable Desktop.
  Stable publishing should require an explicit URL or an explicitly selected
  registry default.

## Non-Goals

- Replacing local daemon rooms with hosted rooms.
- Making `nteract://` MCP resource URIs into room locators.
- Storing API keys in synced settings or notebook metadata.
- Granting execute/runtime authority merely because an MCP client can edit a
  hosted notebook.
- Building a remote MCP service before local stdio MCP can sync directly with
  hosted rooms.
- Migrating legacy hosted notebooks from other services or storage formats.
- Choosing a built-in or vendor-specific stable cloud service.
- Defining the final Desktop notebook-home layout or discoverability.
- Treating a hosted browser dashboard store as the Desktop catalog client.
