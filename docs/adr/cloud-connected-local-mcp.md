# Cloud-Connected Local MCP Clients

**Status:** Draft, 2026-06-12.

## Context

nteract's MCP server is currently local-first: one stdio MCP process talks to a
local `runtimed` daemon over a Unix socket, holds one active
`NotebookSession`, and exposes tools such as `connect_notebook`,
`create_notebook`, `insert_cell`, and `execute_cell`. That model works well for
local notebooks because the agent edits the same Automerge document set the
desktop app sees.

Hosted notebooks at `preview.runt.run` now use the same document split:
`NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` travel over typed-frame v4
WebSockets. The browser viewer and workstation/runtime peers already prove that
native clients can speak the hosted room protocol with explicit credentials,
connection scope, principal, and operator attribution.

The next agent workflow should not require registering one MCP server per
notebook. A local MCP client should be able to call:

```json
{
  "target": "https://preview.runt.run/n/01KT..."
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

## Vocabulary

- **Room locator**: an address used to reach a notebook room host, such as a
  local path, a local room id, or `https://preview.runt.run/n/<id>/<slug>`.
- **MCP resource URI**: a local resource name exposed by an MCP server, such as
  `nteract://notebooks/<id>/cells`. It is not a room locator.
- **Cloud domain registry**: machine-local configuration that maps hosted
  nteract origins such as `https://preview.runt.run` to credential references
  and a default operator.
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

## Decision 2: Cloud remote config is separate from synced settings

Do not store hosted remote credentials in `SyncedSettings` or the synced
settings Automerge document.

Current synced settings are daemon preferences mirrored to
`settings.json`: theme, default runtime, default Python environment, pool sizes,
telemetry, redaction, and similar local behavior. The settings document is
designed to sync across windows on the same daemon and to tolerate external JSON
edits. It is not a credential store, and cloud API keys must not become part of
that live settings document.

Introduce a separate machine-local cloud domain registry near the existing
config namespace, for example:

```toml
default_domain = "https://preview.runt.run"

[[domains]]
url = "https://preview.runt.run"
auth = { kind = "anaconda-key", env = "NTERACT_PREVIEW_ANACONDA_API_KEY" }
operator = "agent:codex:lab2"
```

The exact path and encoding can be settled in implementation, but the
properties are load-bearing:

- non-secret routing and domain data may live in the registry;
- bearer values are read from environment variables, OS keychain, or a future
  secret helper, not persisted as plaintext by `runt config`;
- the registry is machine-local and may differ between Desktop, Codex, CI,
  workstation hosts, and user laptops;
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
    -> hosted target: typed-frame v4 WebSocket to preview.runt.run
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

## Decision 4: Principal comes from the credential; operator comes from local config

Hosted room auth still decides the principal. If the configured credential is
an Anaconda API key, the principal is the Anaconda-scoped principal returned by
the hosted identity layer. If it is a service-account key such as
`quilldaemon`, that service account is the principal.

The local MCP config supplies the operator suffix. The operator is attribution
metadata, not authorization. Examples:

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

## Decision 5: `list_notebooks` uses an optional domain parameter

Local `list_active_notebooks` should remain a daemon-local view. It lists active
local daemon rooms and should not surprise callers with network traffic.

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
remote:https://preview.runt.run:01KT...
https://preview.runt.run/n/01KT...
```

The MCP proxy's `NTERACT_MCP_REJOIN_NOTEBOOK` handoff may need to evolve from a
bare notebook id into an encoded session target. That should be a compatibility
change: old values keep meaning local notebook ids.

## Non-Goals

- Replacing local daemon rooms with hosted rooms.
- Making `nteract://` MCP resource URIs into room locators.
- Storing API keys in synced settings or notebook metadata.
- Granting execute/runtime authority merely because an MCP client can edit a
  hosted notebook.
- Building a remote MCP service before local stdio MCP can sync directly with
  hosted rooms.
- Migrating legacy hosted notebooks from other services or storage formats.
