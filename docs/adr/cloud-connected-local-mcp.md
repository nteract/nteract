# Cloud-Connected Local MCP Clients

**Status:** Draft, 2026-06-12.

## Context

nteract's MCP server started local-first: one stdio MCP process talks to a local `runtimed` daemon over a Unix socket, manages notebook attachments under [Explicit notebook attachments in MCP](mcp-explicit-notebook-attachments.md), and exposes tools such as `connect_notebook`, `create_notebook`, `insert_cell`, and `execute_cell`. That lets an agent edit the exact Automerge document set the Desktop app sees.

Hosted notebooks at configured nteract cloud origins use the same document split (`NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`) over typed-frame v4 WebSockets. Browser viewers and workstation runtime peers already show that native clients can speak this hosted protocol with explicit credentials, connection scope, principal, and operator attribution.

`preview.runt.run` is a staging deployment and development target. It is neither a built-in Desktop remote nor a default in stable distributions.

Agents should not need to register a separate MCP server per notebook. Instead, a local MCP client should call:

```json
{
  "target": "https://notebooks.example.com/n/01KT..."
}
```

The already-registered local MCP server then connects to that hosted notebook as a first-class Automerge peer, while continuing to support local file paths and local daemon room IDs.

This ADR defines the addressing and configuration model across settings, MCP session lifecycle, hosted credential transport, and identity boundaries.

**Neighbors:**

- `docs/adr/mcp-resource-addressing.md` - keeps `nteract://` MCP resources separate from room locators.
- `docs/adr/mcp-explicit-notebook-attachments.md` - defines explicit `notebook_handle` and `notebook_id` targeting across local and hosted attachments.
- `docs/adr/mcp-session-lifecycle.md` - defines daemon supervision, incarnation reconciliation, proxy rejoin, and daemon-local room lifecycle.
- `docs/adr/identity-and-trust.md` - defines the principal/operator actor-label model.
- `docs/adr/hosted-credential-transport.md` - defines hosted WebSocket credential transport and browser app-session behavior.
- `docs/adr/remote-workstation-doc-agents.md` - defines workstation doc agents and room-scoped runtime peers.
- `docs/memos/hosted-notebook-federation.md` - explores the account-aware registry above this origin-scoped V1 config and treats JupyterHub primarily as a compute provider.

## Vocabulary

- **Room locator:** an address that reaches a notebook room host (a local file path, a local room ID, or `https://notebooks.example.com/n/<id>/<slug>`).
- **MCP resource URI:** a local resource name exposed by an MCP server, such as `nteract://notebooks/<id>/cells`. Never a room locator.
- **Cloud domain registry:** the origin-scoped V1 machine-local configuration mapping hosted origins (such as `https://notebooks.example.com`) to credential references and an optional fallback operator for headless clients. Holds zero, one, or many origins with an optional default; cannot represent two accounts at the same origin.
- **Hosted notebook account:** a planned stable, opaque, machine-local account ID binding a deployment, credential reference, principal projection, auth state, and capabilities. Account identity, not origin alone, is the durable namespace for federated catalogs and sessions.
- **Principal:** the authenticated entity proven by a credential, such as a user account or service account.
- **Operator:** the initiating application, agent, model family, harness, or runtime acting under that principal. Labels are open-ended (`agent:codex:lab2` and `agent:opencode:mbp` are examples, not closed protocol categories).

## Decision 1: One local MCP server resolves local and hosted notebook targets

Keep MCP registration machine-scoped, not notebook-scoped. Agents register one local nteract MCP server and select notebooks through tool calls.

Extend `connect_notebook` with a `target` argument while keeping `path` and `notebook_id` for compatibility. Add an optional `domain` argument for `notebook_id` so callers name the target namespace without introducing another tool.

Exactly one of `target`, `path`, or `notebook_id` may be supplied. `domain` applies only with `notebook_id`; omitting `domain` preserves local daemon targeting.

| Input | Connector |
| --- | --- |
| `path` or path-like `target` | Local daemon `connect_open(path)` |
| `notebook_id` with no `domain`, or `domain = "local"` / `"desktop"` | Local daemon `connect(uuid)` |
| `https://<host>/n/<id>` or `https://<host>/n/<id>/<slug>` | Hosted room on the matching configured domain |
| `notebook_id` plus `domain = "https://<host>"` | Hosted room on the matching configured domain |

Target-resolution guardrails:

- **URLs are locators, never credentials.** Authentication comes from local config, environment variables, OS keychain, or a future credential helper.
- **Unknown origins fail closed.** Hosted URLs must match a configured domain before attaching any credential; unknown origins return an actionable configuration error and never receive a default domain's credential.
- **Origin-scoped `domain` is a V1 compatibility shape.** It stays unambiguous only while the registry allows at most one account per normalized origin. Account-aware registries must add an explicit stable account selector instead of guessing between credentials.
- **`nteract://notebooks/...` is not a connect target.** That namespace belongs strictly to MCP resources exposed after attachment.
- **Short remote aliases (`preview:01KT...`) are reserved, not supported in V1.** Explicit URLs or `notebook_id` + `domain` avoid maintaining a second naming layer before the registry settles.
- **No bare-ULID remote guessing.** Local room IDs are UUIDs and hosted IDs are ULIDs, so a parser could distinguish them, but V1 intentionally requires an explicit hosted URL or `domain` rather than silently routing bare ULIDs to a default remote.

## Decision 2: Cloud host configuration starts as a machine-local, multi-host V1 registry

Never store hosted credentials in `SyncedSettings` or the synced settings Automerge document. `SyncedSettings` mirrors daemon preferences (`settings.json`: theme, default runtime, Python environment, pool sizes, telemetry, redaction) across windows and tolerates external JSON edits; it must not become a credential store.

Instead, store cloud domains in a separate machine-local `cloud-domains.toml` file in the existing config namespace:

```toml
# Optional; present only after an explicit user choice:
# default_domain = "https://notebooks.example.com"

[[domains]]
base_url = "https://notebooks.example.com"
# Optional fallback when a headless client does not declare an operator:
operator = "agent:codex:lab2"
credential = { kind = "oidc-bearer-env", env = "NTERACT_NOTEBOOKS_TOKEN" }

[[domains]]
base_url = "https://research.example.net"
credential = { kind = "anaconda-api-key-env", env = "NTERACT_RESEARCH_API_KEY" }
```

The current `CloudRegistry` rejects duplicate normalized origins. That is an intentional V1 routing seam, not a complete account model. Supporting two principals at one deployment requires stable account IDs across catalog rows, open requests, windows, bridges, and reconnect state (see `docs/memos/hosted-notebook-federation.md`).

Registry invariants:

- Holds zero, one, or many normalized hosted origins; a missing file or empty registry means no cloud hosts are configured.
- Starts empty on stable Desktop and MCP installs. Clients never synthesize a host or default (specifically never an implicit `preview.runt.run` entry).
- Requires `https` for all non-loopback origins; cleartext `http` is restricted to explicitly recognized loopback development origins and never used as a silent fallback.
- `default_domain` is optional, must match a configured entry, and applies only after the caller explicitly chooses a cloud operation (never reinterpreting a bare notebook ID as remote).
- Stores non-secret routing and domain metadata only. Bearer values are read from environment references today; OS keychain and secret-helper integration remain future work, and `runt config` must never persist plaintext bearer values.
- Remains machine-local and may differ across Desktop, agent harnesses, CI, workstations, and laptops.
- Shares the low-level registry across daemon bridges and standalone MCP/CLI clients, while the Desktop host adapter consumes the daemon-owned account/catalog API instead of resolving registry entries directly.
- Resolves secrets exclusively in the native connection owner; webviews receive host metadata and catalog rows, never bearer tokens.
- Keeps `runt config` for synced daemon preferences; cloud registry commands belong under a separate `runt cloud` or `runt remote` group.

**Shipped gap:** `notebook-cloud-transport::registry::normalize_url_domain` currently accepts both `http` and `https` without restricting `http` to loopback. This is an unmet safety requirement, not permission to configure cleartext remote hosts; closing it is tracked under [Open Follow-ups](#open-follow-ups).

The configured credential is the root credential for the hosted principal, not necessarily the wire token on every WebSocket. A cloud connector may exchange it for a short-lived sync ticket scoped to one domain, notebook, operator, session nonce, and capability set. Direct bearer vs. ticket transport stays internal to the connector, not part of the MCP tool contract.

## Decision 3: The local MCP process becomes the hosted room client

For hosted targets, `runt mcp` connects over a typed-frame v4 WebSocket via `notebook-cloud-transport` and exposes the synced document set through the same MCP tools used for local rooms:

```text
MCP client
  -> local runt mcp
    -> local target: runtimed Unix socket
    -> hosted target: typed-frame v4 WebSocket to configured host
```

This is deliberately distinct from a remote MCP service. A remote MCP service could serve future hosted automation, but it hides the local Automerge peer behind a remote reader/writer. The primary design is a local stdio MCP server syncing directly with the hosted room.

Hosted attachments follow [Explicit notebook attachments in MCP](mcp-explicit-notebook-attachments.md):

- Each `connect_notebook` or `create_notebook` returns an independently retained `notebook_handle`.
- Every notebook-scoped tool requires an explicit target, including initialize-based clients.
- `show_notebook`, cell CRUD, and dependency inspection target the named attachment.
- Resource reads and subscriptions capture explicit identity and never mutate tool selection.
- `disconnect_notebook` releases only the named owner and never shuts down a room or kernel while another peer or owner remains.

Hosted attachments survive local daemon replacement. Logical handle retention stays separate from physical peers, and hosted backing peers are never pooled without a stable authenticated identity key. Any session-handle abstraction bridging local `DocHandle` and hosted WebSocket clients must expose the underlying `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` directly rather than copying cloud state into React- or MCP-specific projections.

### Daemon-mediated bridge vs. direct MCP connector

Two hosted-room connection paths coexist:

- **Daemon-mediated bridge (`hosted_bridge.rs`, PR #3884):** the product default for Desktop hosted windows. The daemon dials the hosted room over `CloudWsFrameTransport` and attaches it as a sync peer on a local ephemeral `NotebookRoom`. Desktop windows and local clients connect to that daemon room like any local notebook, giving structural echo suppression (one `NotebookDoc`, one `sync::State` per peer) while keeping the hosted room authoritative for `RuntimeStateDoc`.
  - *Shipped limitations:* The bridge is currently a hidden, editor-oriented primitive rather than a general catalog opener. It requests `editor` scope and does not yet project the server-authorized `connection_scope` from `cloud_room_ready`. Execution forwarding handlers exist, but the local request gate rejects editor execution before reaching them and the hosted room requires owner scope, so execution does not work through this opener. Before Desktop portals open viewer, editor, and owner catalog rows, the handshake and session restore must preserve both requested access and effective (possibly downgraded) scope.
- **Direct MCP connector (`crates/runt-mcp/src/cloud.rs`):** `runt mcp` opens the typed-frame v4 WebSocket directly to the hosted room without a daemon bridge.

When to use each path:

- **Desktop hosted windows:** daemon-mediated bridge.
- **Current `runt mcp` hosted targets (standalone agents and harnesses):** direct MCP connector.
- **Future daemon-mediated agent sessions:** use the daemon bridge only after initiating operator descriptors and account-qualified targets survive the full open handshake (target path, not current behavior).

Both paths read the same `cloud-domains.toml` via `notebook-cloud-transport::registry` and share destination principal derivation and actor-label grammar, though they do not yet produce identical operator attribution.

## Decision 4: Principal comes from the credential; operator comes from the initiating client

Hosted room authentication determines the principal. An Anaconda API key yields the user's Anaconda-scoped principal; a service-account key (such as an illustrative automation account `quilldaemon`) yields that service account's principal.

The initiating client declares an operator descriptor per connection:

- Desktop declares a Desktop operator in its hosted-open handshake; an agent client or harness declares its operator through its MCP connection.
- Operator descriptors may name any agent, model family, provider, harness, or product; none is protocol-privileged. Exact model and version details belong in separate advisory audit metadata unless independently attested.
- The registry's optional `operator` field is strictly a fallback for headless clients that omit one. It must never override an explicit per-connection operator or misattribute one client to another.

The operator is attribution metadata, never authorization:

```text
user:anaconda:<sub>/agent:codex:lab2
user:anaconda:<sub>/agent:opencode:mbp
user:anaconda:<quilldaemon-sub>/agent:codex:lab2
```

Because independent Automerge document instances must never reuse an actor concurrently, live hosted connections append a short per-process nonce:

```text
<principal>/<operator>:<nonce>
```

That prevents duplicate sequence collisions across concurrent processes. Retained hosted attachments sharing one live connection inside an MCP process keep the same actor label. Reconnecting after the hosted socket drops must mint a fresh nonce unless a persisted actor store enforces a single-writer lease. Reusing an actor across restarts is unsafe if the prior connection could still be alive.

**Shipped state:** Desktop passes an explicit per-window operator through its daemon open handshake, whereas the direct `runt mcp` connector does not yet accept a per-connection operator and falls back to the registry operator or a generic MCP label. Generic agent-on-behalf-of-principal attribution across both direct and daemon-mediated paths remains an open follow-up.

## Decision 5: Hosted catalogs are explicit, account-qualified, and headless

`list_active_notebooks` stays strictly daemon-local so callers never trigger unexpected network requests.

Hosted catalog access belongs to a local cloud capability, never a React or browser-dashboard store:

- For Desktop, the daemon owns credentials, provider adapters, catalog refresh, caching, and the normalized account/catalog API consumed by `@nteract/notebook-host`.
- Standalone MCP and CLI clients may reuse a lower-level provider client and host-neutral data transfer objects (DTOs), but Desktop webviews never resolve credentials or refresh catalogs directly.
- Normalized hosted summaries key on `(account_id, provider_resource_id)`. The V1 registry may temporarily look up `(normalized origin, notebook id)` only while enforcing one account per origin; before supporting two accounts at one origin, `account_id` must namespace every catalog row, open request, window, bridge, and reconnect record.

Do not add a separate hosted-listing tool. Extend one `list_notebooks` tool with an optional `domain` parameter, keeping omitted `domain` local-only while hosted MCP remains early:

| `domain` | Source |
| --- | --- |
| omitted | Local daemon rooms |
| `"local"` or `"desktop"` | Local daemon rooms |
| `https://<host>` | Hosted catalog for that configured domain |

An account-aware listing surface must later add a stable account selector because `domain` becomes ambiguous once two accounts share one origin.

Keep the three state sources visibly distinct in structured responses so agents never mistake a hosted catalog entry for a warm local daemon room:

- **Local active rooms:** live daemon state.
- **Hosted notebook lists:** catalog/API state from configured domains.
- **Retained MCP attachments (and legacy parked sessions):** local MCP process state.

**Shipped state:** Desktop already ships a hidden hosted-open primitive with explicit hosted open mode, deterministic window reuse, and a hosted locator stored separately from local path/environment fields. The headless catalog slice (daemon-owned account and notebook listing exposed through `@nteract/notebook-host` without registering a visible page, menu item, or stable feature flag) is not yet landed; landing it does not commit Notebook Home to a dashboard layout or a default browser-vs-Desktop open action.

## Decision 6: Execution and workstation attachment stay separate

Connecting local MCP to a hosted notebook grants document access per the hosted room ACL. It does not attach local compute or grant runtime authority.

Providing compute from the same machine is a separate step via the workstation `runtime_peer` path:

1. Local MCP connects to the hosted notebook as `owner` or `editor`.
2. The local workstation/daemon registers as an available workstation.
3. The user or agent selects that workstation for the notebook.
4. The workstation attaches a room-scoped `runtime_peer`.
5. The room host creates execution intent, and the `runtime_peer` runs accepted queue entries.

This preserves the authority split in `remote-workstation-doc-agents.md`: document editing, workstation registration, runtime attachment, and kernel execution remain separate permissions.

**Shipped state:** `runt workstation connect` and `runt workstation run` already handle workstation pairing credentials and runtime attachment. The MCP cloud domain registry in this ADR stores document-client credentials and target resolution only; it must not replace or silently reuse workstation pairing credentials.

## Decision 7: Remote reconnect follows MCP session lifecycle rules

Hosted sessions follow the same user-initiated-intent-wins rule as local daemon sessions. If a background hosted reconnect races a new user-initiated `connect_notebook`, the new target wins and the stale reconnect result is dropped. Hosted reconnect may reset transport sync state because the hosted room preserves document truth.

Remote rejoin state must persist the full room locator, not a bare room ID, because IDs are only unique within an origin. Once account-aware registries land, rejoin state must also carry the stable `account_id` so two principals at the same origin never collide in a bridge or restored session.

Origin-scoped V1 rejoin encodings:

```text
remote:https://notebooks.example.com:01KT...
https://notebooks.example.com/n/01KT...
```

Evolving the proxy's `NTERACT_MCP_REJOIN_NOTEBOOK` handoff from a bare notebook ID to an encoded target must stay backwards-compatible so existing bare values still resolve as local notebook IDs.

## Open Follow-ups

- **Daemon-owned account/catalog API:** define normalized account, catalog-row, account-status, and capability contracts in the daemon and expose typed `@nteract/notebook-host` operations. Keep Desktop credentials, adapters, caching, and refresh daemon-owned.
- **Account-qualified session identity:** migrate the registry and all catalog, open, window, bridge, and reconnect keys to stable `account_id` before allowing two accounts at one origin. Add collision tests for identical provider resource IDs across accounts and deployments.
- **Requested and effective hosted scope:** carry requested access into hosted open, project server-authorized `connection_scope` from `cloud_room_ready`, and restore/display effective scope (including viewer downgrade and owner capability) instead of assuming `editor`.
- **Registry transport safety:** enforce HTTPS-only non-loopback URLs during domain normalization (`normalize_url_domain`) and target resolution before attaching credentials, with tests for non-loopback HTTP rejection and the explicit loopback development exception.
- **Machine-local registry management:** implement normalized, atomic list/upsert/remove/default operations behind a headless CLI or native surface before shipping stable host-configuration UI.
- **Per-connection operator precedence:** ensure explicit Desktop and MCP operator descriptors override the registry fallback across both daemon-mediated and direct paths. Test Desktop plus multiple agent/model/harness descriptors sharing one host credential with distinct attribution, and verify unknown future labels round-trip without affecting principal, scope, or authorization.
- **Explicit stable publish target:** `runt-publish` currently defaults to `preview.runt.run`. Remove that default (or confine it to explicit dev tooling) before exposing publish in stable Desktop so publishing requires an explicit URL or an explicitly configured registry default.

## Non-Goals

- Replacing local daemon rooms with hosted rooms.
- Turning `nteract://` MCP resource URIs into room locators.
- Storing API keys in synced settings or notebook metadata.
- Granting execute or runtime authority merely because an MCP client can edit a hosted notebook.
- Building a remote MCP service before local stdio MCP syncs directly with hosted rooms.
- Migrating legacy hosted notebooks from other services or storage formats.
- Choosing a built-in or vendor-specific stable cloud service.
- Defining the final Desktop Notebook Home layout or discoverability.
- Treating a hosted browser dashboard store as the Desktop catalog client.
