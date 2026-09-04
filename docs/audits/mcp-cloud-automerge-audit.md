# MCP, cloud embedding, and Automerge audit

**Status:** Audit, 2026-09-04. Source baseline: `6bff3e7b0a6e27b89c9ee3e700c6e7ffd6100885`.

This checks implementation and tests against selected runtime and cloud docs.
It separates available components from proposed integrations. It is not a
live-deployment test or a complete review of every memo. This patch changes
instructions and documentation, not runtime behavior or dependencies.

## What can be reused today

| Area | Implemented | Boundary to preserve |
|---|---|---|
| MCP clients | Separate MCP processes can share a daemon and notebook room. Each child serves one stdio connection. | Concurrent requests on that connection share its active notebook; they are not independently scoped clients. See [the entrypoint](../../crates/runt/src/main.rs#L739) and [session state](../../crates/runt-mcp/src/lib.rs#L119). |
| Multiple notebooks | One active session plus up to eight parked peers; notebook-qualified resources can read parked sessions. | Ordinary notebook tools use the active target. Proxy restart restores one preferred target, not the parked collection. See [parking](../../crates/runt-mcp/src/tools/session.rs#L74) and [resource lookup](../../crates/runt-mcp/src/resources.rs#L285). |
| Local embedded editor | `NotebookHost`, the Electron MessagePort adapter, and the native Node relay exist. | The integrating app must authorize notebook selection and privileged methods, supply output-document routing, and own lifecycle. This is not remote-service authentication. See [the Electron host](../../packages/notebook-host/src/electron/index.ts#L46). |
| Hosted editor | The shared UI has a cloud host adapter and a Cloudflare room host. | The hosted shell sends `frame-ancestors 'none'`; it is not a ready-to-embed remote editor iframe. The Vite relay is a development transport, not a multi-user gateway. See [the CSP](../../apps/notebook-cloud/src/index.ts#L5914) and [browser relay](../../apps/notebook/vite-plugin-browser-relay.ts). |
| Remote compute | Workstation registration, attach jobs, runtime-peer reconnect, and eligible owner-triggered resume exist. | The agent advertises its configured **Current Python**, not a hosted catalog of daemon pools. Running it inside a Hub does not implement the JupyterHub provider. See [registration](../../crates/runtimed/src/workstation/agent_loop.rs#L148) and [the provider stub](../../crates/nteract-identity/src/jupyterhub.rs). |

On-prem compute attached to the current cloud does not move document authority
on premises. The reference hosted application still uses Workers, Durable
Objects, D1, and R2 ([bindings](../../apps/notebook-cloud/wrangler.toml)).
The [AWS room-host memo](../memos/aws-rust-room-host.md) is an exploratory
alternative, not a superseding deployment decision or a turnkey on-prem package.

## Corrections made

- [MCP lifecycle guidance](../adr/mcp-session-lifecycle.md) now describes live
  daemon-incarnation reconciliation, guarded session publication, active and
  parked peers, and current proxy handoff. The old classify/latch algorithm was
  no longer the implementation. Sources: [daemon watcher](../../crates/runt-mcp/src/daemon_watch.rs)
  and [activation controller](../../crates/runt-mcp/src/session_activation.rs).
- Last-peer departure schedules kernel teardown, not immediate room removal.
  Room reaping has a separate idle/capacity policy and durability checks.
  UUID recovery can use the daemon's persistent path registry. UUIDs absent at
  the daemon's availability check are refused; the check and recovery load are
  not atomic, as the follow-up below records. Sources:
  [teardown](../../crates/runtimed/src/notebook_sync_server/peer_eviction.rs#L107)
  and [UUID attachment](../../crates/runtimed/src/daemon.rs#L3041).
- [Daemon guidance](../../crates/runtimed/AGENTS.md) now describes recovery
  journals for persistent rooms and disk-backed blobs with garbage collection,
  rather than treating legacy snapshots and ephemeral outputs as the whole
  persistence model. Sources: [journal loading](../../crates/runtimed/src/notebook_sync_server/room.rs#L1808),
  [blob storage](../../crates/runtimed/src/blob_store.rs#L288), and
  [durable execution results](../../crates/runtimed/src/daemon.rs#L2014).
- The [progressive-connect memo](../memos/mcp-connect-initial-projection.md)
  distinguishes implemented local projection-first connect from its historical
  measurements and proposed response shape. Creation and background rejoin
  still have different readiness behavior.
- The [desktop bridge memo](../memos/desktop-cloud-daemon-bridge.md) distinguishes
  forwarding handlers from authorized execution through the editor-only opener.
  Two-hop connection-status composition is implemented; credential acquisition,
  effective-scope propagation, extra document streams, and persistence remain
  separate work.
- The [workstation runbook](../runbooks/remote-workstation.md) now distinguishes
  recoverable disconnects from intentional idle/replacement stops, documents
  eligible owner-triggered resume, and describes the configured interpreter
  instead of an unwired environment catalog.
- The [deployment ADR](../adr/deployment-topology.md) and
  [cloud-connected MCP ADR](../adr/cloud-connected-local-mcp.md) distinguish
  environment-backed credential references from proposed keychain integration.
  Workstation pairing credentials are a different path.

## Automerge is already upstream

| Dependency | Audited source |
|---|---|
| Production Rust and `runtimed-wasm` | crates.io Automerge exactly `0.11.0`, from [the workspace pin](../../Cargo.toml#L57) and `Cargo.lock`; no workspace patch override. |
| Legacy compatibility peer | `automerge-legacy`, Rust `0.10.0`, from `nteract/automerge` revision `3fb6af5cc3af23b79f27cebfa339c8c98987e7b7`, only under [store dev-dependencies](../../crates/automerge-store/Cargo.toml#L16). |
| Frontend | Generated Rust WASM bindings, not the JS `@automerge/automerge` package. JS release numbers are not this application's Automerge version. |

Commit `ae6aef0f` ([PR #4181](https://github.com/nteract/nteract/pull/4181))
switched production on August 26. Upstream
[Rust `0.11.0`](https://docs.rs/crate/automerge/0.11.0), released August 12,
is still the latest published Rust release checked on September 4.
No production version bump or fork removal is needed at this baseline.

The remaining fork is deliberate test coverage: the
[compatibility tests](../../crates/automerge-store/tests/version_compat.rs#L282)
exchange snapshots and encoded sync messages in both directions, including
representative rich text. The store also tests rejection/quarantine of malformed
legacy data without rewriting it. Removing the test dependency would require a
replacement compatibility strategy, not just a cleaner dependency list.

The [fork-patch memo](../memos/automerge-fork-patches.md) retains historical
research but no longer calls actor validation unimplemented. Current ingress
uses [clone-preview validation](../../crates/runtimed/src/notebook_sync_server/peer_notebook_sync.rs#L58).
A read-only incoming-change parser is a proposed optimization, not a prerequisite
for the existing authorization check. The disposition of every historical fork
patch was not exhaustively mapped.

## Follow-up work

### Refuse missing data during UUID-only legacy recovery

The [legacy snapshot branch](../../crates/runtimed/src/daemon.rs#L3122) checks
that a persisted file exists before awaiting room creation. If that file
vanishes and no journal is recovered, [room loading](../../crates/runtimed/src/notebook_sync_server/room.rs#L1945)
can fall back to a fresh document. Make this recovery path refuse missing data
instead, and add a regression test for disappearance between the availability
check and load. Caller-side `list_rooms` checks would not close this race.

### Enforce the registry's transport requirement

The ADR requires HTTPS outside explicit local-development exceptions, but
[`normalize_url_domain`](../../crates/notebook-cloud-transport/src/registry.rs#L231)
currently accepts both HTTP and HTTPS without a loopback check. Enforce the
requirement before attaching credentials, independently of any configuration UI.
Add non-loopback rejection and explicit loopback-exception tests. The gap is not
approval to configure remote cleartext endpoints.

### Carry authorized scope through hosted open

The daemon's hosted opener requests
[`editor`](../../crates/runtimed/src/daemon.rs#L3572), while the
[request gate](../../crates/runtimed/src/notebook_sync_server/peer_writer.rs#L384)
rejects editor execution before forwarding. Hosted attachment and execution
remain owner-only. Carry requested and server-authorized effective scope through
open/recovery/UI, and test viewer downgrade and authorized execution end to end.
Do not fix this by treating all editors as owners or by equating attached compute
with permission to execute.

### Define the remote embedding and deployment contracts

Keep the working local Electron integration distinct from a remotely editable
iframe. The latter needs parent/origin authorization, credential bootstrap,
notebook selection, capability projection, output isolation, and lifecycle rules.
Removing the hosted shell's framing restriction alone would not supply them.

For on-prem work, decide whether the target is compute, the document host, or
both. A new document host also needs deployment/storage adapters and admission
policy. Same-origin multiple accounts and catalog aggregation remain separate
contracts in the [federation memo](../memos/hosted-notebook-federation.md), not
features established by the current registry and workstation agent.

### Migrate the MCP SDK and test both sides of the proxy

The workspace requires `rmcp = "1.4"` and locks **1.5.0**. Its default protocol
revision is **2025-11-25**, inherited by the
[child's server info](../../crates/runt-mcp/src/lib.rs#L413) and the proxy.
The SDK can negotiate older revisions; that is not proof that every emitted
application payload is suitable for every negotiated revision.

Upstream [rmcp **3.2.0**](https://docs.rs/crate/rmcp/3.2.0), released August 31,
and the [2026-07-28 MCP revision](https://modelcontextprotocol.io/specification/2026-07-28/changelog)
need a separate migration. The newer SDK still defaults client startup to the
legacy `initialize` flow and `2025-11-25`, while its server supports both legacy
and modern requests. Updating the dependency alone does not choose the supported
application lifecycle.

The 2026 revision removes the initialization handshake and protocol-level
sessions, adds per-request version/capability metadata and `server/discover`,
and changes subscriptions and multi-round-trip requests. Application-level
notebook selection still needs an explicit scoping contract.

Test upstream-client-to-proxy and proxy-to-child behavior separately, including
identity attribution, tool/resource schemas, notifications, reconnect, and
explicit notebook targeting. The current harness requests `2024-11-05`; retain
legacy-client coverage rather than treating a newer SDK pin as conformance.
No claim of 2026-07-28 compatibility is made by this audit.

## Verification

These passed against the audited code. Rust commands ran from the repository root:

| Command | Passed |
|---|---:|
| `cargo test --locked -p automerge-store --test version_compat` | 2 |
| `cargo test --locked -p automerge-store --lib` | 13 |
| `cargo test --locked -p automerge-recovery` | 15 |
| `cargo test --locked -p runt-mcp --lib` | 218 |
| `cargo test --locked -p runt-mcp-proxy --lib` | 114 |
| `cargo test --locked -p notebook-cloud-transport --lib` | 33 |
| `python3 scripts/mcp-connect-harness.py --self-test` | 19 checks |

Host/relay/status tests: 29 passed, from the repository root:

```sh
pnpm test:run packages/notebook-host/tests/electron-host.test.ts packages/runtimed-node/tests/relay.test.ts apps/notebook/src/lib/__tests__/desktop-connection-status.test.ts
```

Workstation, identity, and authorization tests: 69 passed; selected room lifecycle
tests: 16 passed. Both commands ran from `apps/notebook-cloud`:

```sh
node --import tsx --test test/hosted-workstation-agent.test.mjs test/identity.test.ts test/authorization.test.ts
node --import tsx --test --test-name-pattern="resume|idle|non-owner|replacement workstation|runtime peer.*session" test/notebook-room.test.ts
```

`pnpm --dir apps/notebook-cloud typecheck` passed. Its runtime-WASM prerequisite
reused up-to-date artifacts and verified the four document genesis assets; it
was not a fresh WASM build. Live hosted/workstation smoke tests, live MCP fault
scenarios, installed/deployed artifact versions, and a protocol conformance
matrix were not tested. Passing unit tests does not establish those guarantees.
