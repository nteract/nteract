# Notebook Cloud Host Compatibility Audit

**Status:** Evidence audit, 2026-08-20. This is not a host-selection ADR.

This audit records the public contract that a non-Cloudflare room host must
preserve and the evidence collected against CellD 0.3.0. It supersedes the
CellD 0.1 assumptions in closed PRs
[#4128](https://github.com/nteract/nteract/pull/4128) and
[#4129](https://github.com/nteract/nteract/pull/4129), but it does not select a
production substrate.

Related:

- [Notebook Room Host Selection](../memos/notebook-room-host-selection.md)
- [AWS Rust Room Host](../memos/aws-rust-room-host.md)
- [Deployment Topology](../adr/deployment-topology.md)
- [Hosted Room Authorization](../adr/hosted-room-authorization.md)
- [Typed-frame v4 Wire Protocol](../adr/typed-frame-v4-wire-protocol.md)

## Compatibility Boundary

The stable boundary is behavior, not a new room-host interface:

- the existing HTTP routes and authenticated notebook catalog;
- typed-frame v4 WebSockets;
- `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and `CommentsDoc` semantics;
- notebook-level owner, editor, viewer, and runtime-peer authority;
- deterministic snapshot and content-addressed blob keys;
- a room checkpoint that is durable before an edit is acknowledged; and
- portable export of documents, catalog data, ACLs, and blob references.

The current Worker remains the control implementation. A candidate proof must
run the same route, authorization, document, storage, and recovery contract
before shared internals are extracted.

## CellD 0.3 Compatibility Matrix

The declared-support column is sourced from CellD's
[Cloudflare compatibility](https://github.com/denoland/celld/blob/v0.3.0/docs/cloudflare-compat.md),
[WebAssembly](https://github.com/denoland/celld/blob/v0.3.0/docs/wasm.md), and
[security](https://github.com/denoland/celld/blob/v0.3.0/docs/security.md)
documentation. The proof column records runs of the current nteract checkout,
not claims from the CellD documentation.

| Surface | nteract usage | CellD 0.3 declared support | Current proof | Result |
| --- | --- | --- | --- | --- |
| Module Worker | `fetch`, `env`, `ctx.waitUntil` | Supported | Current Worker booted and served `/api/health` | Pass |
| Durable Objects | `NotebookRoom`, `WorkstationEvents`, `OwnerComputeIndex` with SQLite storage | Supported | All three current classes deployed and activated | Pass |
| D1 | Catalog, ACLs, app sessions, shares, workstation records, and jobs | Partial: `prepare`, `bind`, `all`, `first`, `run`, `raw`, `exec`, `batch`, and sessions | All eight current migrations applied; create/list/ACL queries ran | Pass for queries exercised; full SQL inventory remains a gate |
| Hibernatable WebSockets | attachments, auto-response, `webSocketMessage`, close/error, restored socket enumeration | Supported; `getTags()` absent | Typed-frame v4 ready, sync, broadcast, and malformed-frame paths ran | Pass |
| Durable Object alarms | runtime-peer reconciliation, idle teardown, and room-summary refresh | Supported | Deployment and handlers load; timing/failover scenarios remain to run | Partial |
| WebAssembly | `runtimed-wasm` room host and frame policy | Compiled sibling-module imports supported | Static `.wasm` module import ran real Automerge sync | Pass |
| Static assets | notebook viewer and renderer assets | Supported | 62 assets deployed; root redirect and viewer JavaScript served | Pass |
| Fetch/Response | redirects, JSON, streams, upgrades | `Response.redirect()` absent; core constructors supported | Replaced the one helper call with an equivalent `302` response | Pass with portable seam |
| Streams | object bodies and response bodies | Supported except `ReadableStream.from()` | S3 adapter uses ordinary readable bodies; parity suite is not complete | Partial |
| R2 binding | snapshots and content-addressed blobs in the control | Deliberately unsupported | R2 access is behind `NotebookObjectStore`; CellD uses S3 | Pass through application adapter |
| S3-compatible application data | snapshots, summaries, and blobs | Not a Worker binding; outbound fetch is available | Separate application identity wrote the expected notebook prefix | Pass for local S3-compatible proof |
| Fleet storage | deployment, cell state, leases, and fleet secret | Required S3-compatible bucket | Deployment, D1 state, ownership recovery, and node leases ran | Pass for local proof |
| Node loss | acknowledged room checkpoint and catalog recovery | Ownership epochs and fleet-bucket replication | A repeatable two-node probe killed the owning process during a two-editor session, reconnected through the second node, recovered the acknowledged source, and converged another edit | Pass for forced active-node loss |
| Multi-node routing | any public node may receive a room connection | Signed private peer routing | A second public listener reopened a room owned by the first node and ran the collaboration contract; the active-node-loss probe then took ownership after fencing | Pass for two local nodes |
| Hostile multi-tenancy | isolate and tenant boundary | Explicitly not safe in the current alpha | Not waived by application tests | Fail for hostile shared tenancy |
| Internal/operator exposure | peer and operator endpoints must be private | Separate internal listener; most operator routes are unauthenticated | Public and internal listeners were bound separately on loopback | Configuration proof only |

## Current D1 Usage

The Worker currently uses prepared statements with `bind`, `first`, `all`, and
`run`, plus transactional `batch`. The schema and queries include:

- `PRAGMA table_info` migration checks;
- `INSERT OR IGNORE` and `ON CONFLICT` upserts;
- `RETURNING` clauses;
- joins, indexes, ordering, limits, and timestamp expressions; and
- eight ordered migrations under `apps/notebook-cloud/migrations`.

The live CellD proof applied those migrations and exercised notebook creation,
listing, ACL grants, and authorization lookups. That is evidence for the
documents-first slice, not proof of every dormant query. The contract harness
must enumerate and run the remaining query families before D1 compatibility
can be called complete.

CellD does not provide D1 Time Travel or `dump()`. Its documented migration
path is Cloudflare export followed by `celld d1 execute`; backup/export/restore
therefore remains an explicit gate rather than an inferred capability.

## WASM Packaging Finding

The first portable bundle inlined the 4.2 MB `runtimed-wasm` module as a byte
array. CellD could boot the Worker, but the first materialized sync stalled in
runtime compilation. CellD's supported path is a sibling `.wasm` module whose
default export is a compiled `WebAssembly.Module`.

The portable workspace build now preserves a static compiled-module import.
That change:

- keeps the existing Cloudflare module contract;
- allows CellD to discover and register the sibling module;
- reduces the generated JavaScript bundle from about 6.8 MB to about 1.2 MB;
  and
- avoids a candidate-specific room implementation.

The portable artifact records the Worker, WASM module, assets, configuration
hash, source commit, byte counts, and content hashes in
`dist-portable/manifest.json`.

## Storage Boundary

`NotebookObjectStore` covers only the behavior the application currently
needs: `get`, `head`, `put`, and `delete`; streaming bodies; content type, size,
ETag, and custom metadata; and deterministic keys. R2 and S3-compatible
adapters implement the same interface. Short-lived signed client transfers
belong in a later `BlobTransferBroker`, not this primitive.

CellD fleet state and nteract application data are separate security domains.
The proof used one identity for the fleet bucket and another for the notebook
application bucket, and verified that each identity received `403` against the
other bucket. The portable Worker currently accepts short-lived S3 credentials
through its host environment because CellD does not expose a secret binding or
workload-identity bridge inside Worker JavaScript. That is acceptable for the
disposable proof and remains a production hard gate.

## Behavioral Evidence Collected

The current proof established:

- one CellD deployment hosted multiple named notebook rooms;
- owner creation, editor grant, public viewer grant, and ungranted-principal
  downgrade;
- real `runtimed-wasm` Automerge convergence from owner to editor and viewer,
  then editor back to owner and viewer;
- actor attribution for both editors;
- a viewer-local mutation did not enter the authoritative document;
- rejection of unknown and malformed typed frames;
- synchronous checkpoint persistence before an edit receives
  `cloud_frame_accepted`;
- checkpoint recovery after forced process death and lease expiry;
- reopening the same notebook ID with the acknowledged cell source; and
- cross-node ingress to a room resident on another node; and
- active two-editor node loss, takeover, acknowledged-state recovery, and a
  converged post-failover edit. The measured reconnect after `SIGKILL` was
  9.85 seconds in this local two-node run.

These are functional proofs. The active-loss run is emitted as a
machine-readable bundle containing candidate and nteract commits,
configuration hash, failure signal, timings, checks, and bounded logs.
Backup/export/restore, origin and frame-budget matrices, repeated ownership
churn, long-lived hibernation, real workload identity, and operator-network
isolation still need repeatable result bundles.

## Security and Operations Consequences

CellD 0.3 is explicit that the alpha is not safe for hostile multi-tenant use.
It also states that:

- the public application listener and internal listener must be separate;
- most operator endpoints on the internal listener are unauthenticated;
- peer traffic retains signed protocol authentication;
- the fleet bucket is the root of fleet authority; and
- the application must provide its own authentication and TLS termination.

Accordingly, CellD remains a valid isolated candidate proof but is not
preselected for a shared production service. Any production evaluation must
prove a private internal network, one-purpose fleet credentials, resource
containment, upgrade behavior, observability, and incident recovery.

## Open Evidence Gates

1. Run every current D1 query and export/import path.
2. Run the full origin, ACL, malformed, stale, oversized, and cross-room frame
   matrix against the same artifact on the control and each finalist.
3. Repeat active node loss under load and define the acceptable reconnect
   service-level objective; the first local forced-loss measurement was 9.85
   seconds.
4. Exercise alarm delivery, WebSocket hibernation, and restore over longer idle
   intervals.
5. Run object-store parity against R2 and a qualified S3 service with transient
   failures and version recovery.
6. Produce a repeatable backup/export/restore package with unchanged notebook
   IDs and blob references.
7. Replace disposable Worker credentials with an acceptable workload-identity
   or secret-delivery boundary.
8. Complete licensing and production-operability review before scoring.
