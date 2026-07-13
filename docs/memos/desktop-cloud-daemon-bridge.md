# Desktop Cloud Sessions Mediated by the Daemon

**Status:** V1 implemented in #3884, 2026-06-26. Remaining work (local
kernels, CommsDoc/CommentsDoc bridging, persistence) tracked in issue #3861.

This memo records the live-room opening primitive. Account discovery, Notebook
Home, multitenant/private deployment policy, and JupyterHub compute federation
are explored separately in
[Hosted Notebook Accounts and Compute Federation](hosted-notebook-federation.md).

## Problem

Desktop-hosted cloud notebooks should be mediated by the local daemon. Before
the V1 bridge, the only native path into a hosted room was direct: `runt mcp`
(and the cloud-runtime-agent / workstation peers) dialed
`wss://<host>/n/<id>/sync` with `CloudWsFrameTransport` and synced as standalone
peers. Desktop had no hosted path, and nothing gave UI, MCP agents, local
kernels, and persistence one local authority for a cloud notebook.

Target topology (from #3861):

```text
Desktop UI  <->  local daemon room  <->  hosted cloud room
MCP client  <->  local daemon room  <->  hosted cloud room
local runtime/kernel <-> daemon <-> hosted cloud room (policy TBD, later slice)
```

## What already exists

- `notebook-cloud-transport`: `CloudWsConfig`/`CloudAuth`/`CloudWsFrameTransport`
  with reconnect-oriented design, token refresher hook, `cloud_room_ready`
  principal observation, and workstation metadata headers.
- `runtimed cloud-peer` (`crates/runtimed/src/cloud_peer.rs`): a diagnostic
  daemon-side peer that already syncs NotebookDoc + RuntimeStateDoc with a
  hosted room and authors as `<principal>/<operator>:<nonce>`.
- `runt-mcp` hosted sessions: target parsing (`NotebookTarget::Hosted`) and the
  machine-local cloud domain registry (`CloudRegistry`, env-referenced
  credentials) in `crates/runt-mcp/src/cloud.rs`, per
  `docs/adr/cloud-connected-local-mcp.md` Decision 2.
- Daemon rooms: `NotebookRoom` owns the canonical `NotebookDoc` plus
  `RuntimeStateDoc`/`CommsDoc`/`CommentsDoc` handles, per-peer sync states, a
  `changed_tx` broadcast, and identity enforcement
  (`RoomConnectionIdentity`, actor-principal validation on inbound changes).

## Implemented Design: the bridge is another peer of the daemon room

A hosted daemon session creates an **ephemeral, hosted-flagged
`NotebookRoom`** keyed by the hosted locator, and attaches a **bridge task**
that is one more peer of that room — except its transport is the cloud
WebSocket instead of a Unix socket
(`crates/runtimed/src/notebook_sync_server/hosted_bridge.rs`).

Echo suppression falls out of the design: the daemon room holds exactly one
`NotebookDoc` instance; the cloud connection is one automerge `sync::State`
against that doc, and each local peer is another. The sync protocol guarantees
changes are not replayed to the peer they came from.

Bridged docs (V1): `NotebookDoc` (read/write) and `RuntimeStateDoc`
(cloud-authoritative, received with `receive_sync_message_with_changes`).
`CommsDoc`/`CommentsDoc` bridging and local-runtime-peer policy are deferred
(#3861 slice 5).

Execution (V1): hosted rooms do not launch local kernels. `execute_cell`
requests from local peers are forwarded to the cloud room as hosted `Request`
frames (`crates/runtimed/src/requests/mod.rs:217-267`); the resulting
queue/output state arrives back via RuntimeStateDoc sync.

Persistence (V1): none (ephemeral room). Local-first persistence for hosted
sessions is #3600.

## Attribution (Implemented)

The hosted room rejects changes whose actor principal differs from the
authenticated principal, so the bridge ensures local peers author under the
cloud principal. When a room is hosted-bridged
(`crates/runtimed/src/daemon.rs:2928-3037`):

- The room's connection identity mints local peers' actor labels under the
  **cloud principal** observed in `cloud_room_ready`, keeping the peer's
  self-declared operator suffix:

```text
user:anaconda:<sub>/operator:desktop:<session>
user:anaconda:<sub>/operator:codex:<session>
```

- The bridge never rewrites changes; attribution rides the actor label end to
  end, so cloud-side history shows which local operator made each change while
  authorization stays anchored to the one authenticated principal.
- Actor uniqueness: the bridge mints a fresh `:<nonce>` per cloud connect
  (automerge duplicate-seq rule), and local peers get per-connection labels
  from the room host.

## Credentials (Implemented)

V1 uses the machine-local cloud domain registry from
`docs/adr/cloud-connected-local-mcp.md` Decision 2, lifted out of `runt-mcp`
into a shared location so the daemon resolves the same file. Routing data is
in the registry; secrets are referenced via environment variables.
Credentials never ride the handshake from the desktop app; the desktop names
a URL, the daemon owns the credential. Keychain / device flow remain #3861
open questions.

Direct MCP hosted mode stays as a headless shortcut; the daemon-mediated path
is the desktop product lifecycle.

## Entry point (Implemented)

New connection handshake channel (`crates/notebook-protocol/src/connection/handshake.rs:62-81`):

```json
{"channel":"open_hosted_notebook","url":"https://preview.runt.run/n/01KT...","operator":"desktop"}
```

The daemon resolves the URL against the registry, creates or joins the
hosted-bridged room, spawns the bridge if needed, and serves the connection
like a normal `notebook_sync` peer (typed bootstrap, `NotebookConnectionInfo`
with the daemon-local room id). Reconnect/status composition in the desktop UI
is #3599.

## Remaining Work (see #3861)

- Account-aware discovery and Notebook Home use the federation memo above; they
  are not additional responsibilities of the per-room bridge.
- OAuth/device-flow credential acquisition and keychain storage.
- CommsDoc/CommentsDoc bridging; widget replay across the bridge.
- Offering local daemon compute to the hosted room (workstation attach is a
  separate, existing flow).
- Offline edits with later cloud rejection UX.
- Local-first persistence of hosted sessions (#3600).
- Richer status/presence composition in desktop UI (#3599).
