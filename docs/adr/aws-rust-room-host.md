# AWS Rust Room Host

**Status:** Draft, 2026-06-10.

**Supersedes in part:** `deployment-topology.md` Decision 1 for the next
hosted deployment target. The Cloudflare Worker/Durable Object stack remains
the current prototype and evidence source, but the proposed production-oriented
path is a native Rust room host on AWS.

## Context

The hosted prototype on `preview.runt.run` proved the core product loop:

- browsers, agents, and runtime/workstation peers can connect to a hosted
  notebook room over typed-frame v4 WebSockets;
- the room host can own `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc`;
- runtime peers can attach from a workstation and publish execution/output
  state back into the room;
- the dashboard, sharing, public snapshots, widgets, and workstation attach
  flows can all be productized around the same document model.

The Cloudflare implementation also exposed a deployment pressure point. Durable
Objects are convenient for one-object-per-room coordination, but the hosted
service is now hitting plan limits and is becoming harder to reason about as a
long-running collaborative runtime surface. The next architecture should keep
the protocol and local-first document model, but move room authority into a
native service we can scale, instrument, and operate directly.

The desired shift:

```text
browser / desktop / agent / workstation runtime peer
        |
        | wss://host/n/:notebook_id/sync
        | one WS binary message = [NotebookFrameType byte][payload]
        v
Rust hosted room service
        |
        | active room actor owns NotebookDoc + RuntimeStateDoc + CommsDoc
        v
Postgres catalog/ACL/workstations + S3 snapshots/blobs
```

This should be a `runtimed`-adjacent hosted service, not a line-by-line port of
the TypeScript Worker. The existing Cloudflare code is useful because it
clarifies product semantics, route contracts, ACL behavior, workstation attach
jobs, snapshot validation, and output isolation. The native daemon code is
useful because it already has the Rust room loop, request authority, peer writer
lanes, and runtime-state handling we want in the hosted service.

## Existing Seams

The shared protocol surface already exists:

- `crates/notebook-wire/src/lib.rs` defines `NotebookFrameType`, frame values,
  and frame-size limits.
- `crates/notebook-protocol/src/connection/transport.rs` defines
  `FrameSource` / `FrameSink` abstractions.
- `crates/notebook-cloud-transport/src/lib.rs` implements the hosted WebSocket
  transport for runtime/workstation peers: each WebSocket binary message is one
  typed frame with no local UDS length preamble.
- `apps/notebook-cloud/viewer/live-sync.ts` uses browser WebSockets against
  `/n/:id/sync`, so the browser does not require Durable Object semantics.

The native daemon already has pieces the hosted service should reuse or
extract, but the native `NotebookRoom` itself is not the hosted-room shape. It
also owns local file bindings, file watchers, autosave, trust state, local
runtime-agent handles, and destructive kernel teardown. Those are daemon/local
concerns, not hosted-room concerns.

- `crates/runtimed/src/notebook_sync_server/peer_loop.rs` has the biased
  frame/readiness/runtime/presence loop. It is generic over `AsyncRead` and
  `AsyncWrite`; the remaining daemon couplings should be carved out as
  explicit parameters or hosted adapters.
- `peer_writer.rs` classifies reliable frame lanes and gates request authority.
- The shared document and wire crates (`notebook-doc`, `runtime-doc`,
  `notebook-wire`, `notebook-protocol`) are daemon-free.

The cloud Worker has hosted product pieces that should be ported through proper
interfaces:

- `apps/notebook-cloud/src/index.ts` has route shape, auth/session endpoints,
  notebook APIs, sharing APIs, and workstation APIs.
- `apps/notebook-cloud/src/storage.ts` defines the current catalog, ACL,
  sharing, workstation, default-workstation, and attach-job data model.
- `apps/notebook-cloud/src/room-materializer.ts` has the checkpoint and
  published-snapshot recovery policy, currently backed by Durable Object
  storage, D1, R2, and `runtimed-wasm`.

`crates/runtimed-wasm/src/lib.rs` `RoomHostHandle` is the closest reference
design for the hosted room's shape: per-peer Automerge sync states, scope
validation, execution-queue handling, workstation attachment publication, and
`reconcile_runtime_peer_gone`. The native hosted room should mirror that
structure in Rust; it should not treat the WASM boundary as the implementation
to embed or mechanically extract.

## Decision 1: The Hosted Room Host Is Native Rust

The next hosted room engine should be a native Rust service. It accepts the same
typed-frame v4 WebSocket protocol as the Cloudflare room, but owns room state in
native Rust rather than through `runtimed-wasm` inside a Worker.

The service hosts one active actor per live notebook room:

```text
RoomRegistry
  notebook_id -> RoomActorHandle

RoomActor
  NotebookDoc
  RuntimeStateDoc
  CommsDoc
  per-peer Automerge sync states
  presence map
  runtime_peer tracking/grace timer
  checkpoint debounce
  peer broadcast channels
```

Inputs:

- peer joined;
- typed frame from peer;
- peer left;
- workstation attach-job status;
- checkpoint timer;
- graceful shutdown.

Outputs:

- typed frames to connected peers;
- checkpoint writes to S3;
- catalog/revision writes to Postgres;
- metrics/logs.

One Tokio task owns the three room documents and all per-peer sync state for a
given notebook. Peer tasks communicate with that owner through channels. Do not
share `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, or per-peer
`automerge::sync::State` through `Arc<RwLock<_>>` across peer tasks; that erodes
the single-writer guarantee that Durable Objects previously gave implicitly.

The service should reuse native `runtimed` room-loop mechanics where possible.
It should model the hosted document owner after `RoomHostHandle`, but should
not embed `runtimed-wasm` as its core room engine. WASM remains a browser/client
boundary and a compatibility/testing asset; the server is native Rust.

## Decision 2: The WebSocket Protocol Stays Stable

The externally visible room wire protocol does not change:

- Upgrade route: `/n/:notebook_id/sync`.
- WebSocket binary body: `[NotebookFrameType as u8][payload]`.
- Notebook document sync: `NotebookFrameType::AutomergeSync`.
- Runtime state sync: `NotebookFrameType::RuntimeStateSync`.
- Widget comm state sync: `NotebookFrameType::CommsDocSync`.
- Requests/responses, presence, session-control, broadcasts, and `PutBlob`
  remain their existing typed-frame channels.

Do not switch hosted browser/runtime peers to the local UDS length-preamble
framing. The preamble is for local daemon streams; hosted WebSockets already
have one-message-per-frame semantics.

The server should continue to send session-control readiness frames compatible
with current clients, including a `cloud_room_ready`-equivalent announcement
for hosted runtime/workstation peers that need the authenticated principal for
actor labeling.

The WebSocket implementation must configure its server-side frame/message caps
from `notebook-wire`'s frame-size limits instead of using Axum/Tungstenite
defaults or re-declared constants. `AutomergeSync`, `RuntimeStateSync`, and
`CommsDocSync` can be large; mismatched server caps will look like sync
corruption to clients.

The ALB/WebSocket deployment must either raise the ALB idle timeout above the
default or use a protocol-level keepalive. Quiet viewer-only rooms should not be
disconnected merely because no notebook edits or presence heartbeats happened
within the default load-balancer window.

## Decision 3: Authentication Happens Before Room Actor Admission

The Rust service authenticates HTTP and WebSocket requests before they enter a
room actor. The Worker-to-Durable-Object trusted-header pattern does not carry
over as an internal security boundary in a single binary.

The service still inherits the credential transport model from
`hosted-credential-transport.md`:

- browser OIDC callback creates an app-session cookie;
- browser WebSockets authenticate with the app session and retain the
  same-origin `Origin` gate;
- browser bearer/subprotocol fallback remains available only where explicitly
  allowed by the credential transport ADR;
- native clients and runtime/workstation peers authenticate with bearer tokens
  or API keys through the hosted WebSocket upgrade path.

The Rust service owns its own app-session signing/encryption keys. Terraform
must provision that key material through Secrets Manager or an equivalent secret
store before the app/auth routes are considered deployable. This is a
pre-Terraform design input, not a post-deployment cleanup item.

After authentication, authorization loads room ACL state from Postgres and
derives the requested connection scope before the room actor sees the peer. The
room actor receives a validated principal, operator/actor label, requested
scope, and capability bounds. It does not trust client-supplied actor labels or
scope claims.

## Decision 4: Postgres Is The Catalog And Authorization Store

Postgres is the application database for hosted notebooks. RDS PostgreSQL is
the preferred AWS deployment form.

Postgres owns:

- notebook catalog rows;
- revision metadata;
- blob indexes;
- ACL rows;
- principal profiles and account links;
- invites and access requests;
- workstations;
- default workstation choices;
- workstation attach jobs;
- future room leases;
- optional checkpoint metadata indexes.

S3 owns large bytes. Do not put full Automerge saves or output blobs in
Postgres rows.

The current D1 schema in `apps/notebook-cloud/src/storage.ts` is a useful
starting contract, but the Postgres schema should be real migrations rather
than request-time `ensureCatalogSchema` helpers. The first schema can mirror the
prototype tables while improving the database primitives:

- `timestamptz` instead of ISO timestamp strings;
- enum types or checked text domains for scopes and statuses;
- `jsonb` for bounded workstation environment facts;
- `updated_at` triggers instead of repeated manual timestamp writes;
- intentional `ON DELETE` behavior for notebook-owned rows;
- partial unique indexes for pending invites/access requests and active
  workstation attach jobs;
- explicit transactions around ACL mutation, invite acceptance, attach-job
  transitions, and revision publication.

The hosted ACL invariants from `hosted-room-authorization.md` remain portable
to Postgres:

- public access is an explicit `public`/`anonymous` viewer row, not inferred
  from an artifact key;
- owner rows are protected so ACL mutation cannot orphan a room with no owner;
- ACL writes update `updated_at` through a migration-owned trigger or storage
  helper;
- transactional revision publication updates revision rows and
  `notebooks.latest_revision_id` together;
- active workstation attach jobs stay protected by a partial unique index.

Use `sqlx` as the default Rust database client:

- it fits an Axum/Tokio service;
- it has an async pool and transaction API;
- it gives us checked queries and migrations as the schema grows;
- it makes it harder to quietly drift between application types and SQL rows.

`tokio-postgres` remains an acceptable fallback if a concrete dynamic-query
need makes `sqlx` awkward, but it should not be the default.

## Decision 5: RDS Is The Default Managed Postgres Deployment

For repeated demos or persistent hosted environments, use RDS PostgreSQL rather
than self-managed Postgres on the application instance.

RDS keeps database durability and operations separate from room-host CPU/RAM
scaling. It also gives us managed backups, snapshots, VPC deployment, SSL,
read-replica options, and Multi-AZ options when needed.

Terraform should own the initial AWS database shape:

```text
aws_db_subnet_group
aws_security_group       # app -> db only
aws_db_instance          # engine = postgres, private subnets
aws_secretsmanager_*     # or RDS-managed master password
aws_iam_role/policy      # app role can read db secret and access S3
```

Start with a single RDS PostgreSQL instance with backups enabled. Enable
Multi-AZ when the deployment moves beyond demo/staging reliability needs. Avoid
Aurora until there is evidence that the room host needs Aurora-specific scaling,
latency, or availability behavior.

Self-managed Postgres remains acceptable for:

- local integration tests;
- disposable EC2 experiments;
- emergency bring-up when RDS/IAM/Terraform setup would block learning.

The application code must not care which Postgres deployment form is used.
`DATABASE_URL` and migrations should be the boundary.

## Decision 6: S3 Stores Snapshots And Blobs

S3 stores Automerge document bytes, runtime/comms snapshots, output blobs, and
rendered/generated artifacts. Postgres stores metadata and authorization
decisions.

Initial object layout:

```text
notebooks/{notebook_id}/checkpoints/latest.json
notebooks/{notebook_id}/checkpoints/{checkpoint_id}/notebook.am
notebooks/{notebook_id}/checkpoints/{checkpoint_id}/runtime-state.am
notebooks/{notebook_id}/checkpoints/{checkpoint_id}/comms.am

docs/{notebook_doc_id}/snapshots/{notebook_heads_hash}.am
docs/{runtime_state_doc_id}/snapshots/{runtime_heads_hash}.am
docs/{comms_doc_id}/snapshots/{comms_heads_hash}.am

blobs/{sha256}
```

This lands the long-term namespace from `hosted-notebook-artifacts.md` for new
AWS buckets: published document snapshots use `docs/{docId}` for all document
types, including `NotebookDoc`. The `notebooks/{id}/checkpoints/` prefix is
reserved for operational room-host checkpoints, not published revision
artifacts.

Revision rows record exact snapshot keys, so mixed-layout reads remain
possible. Existing Cloudflare/R2 layouts such as `n/{id}/snapshots/...` and
legacy nested runtime snapshot keys should stay readable during migration.

Global `blobs/{sha256}` objects make S3 the content-addressed byte pool.
Authorization and lifetime flow through the Postgres `notebook_blobs` reference
table. The first implementation can choose "no blob GC yet"; if it does, that
must be explicit. Prefix deletion by notebook id is no longer sufficient once
the byte pool is shared.

The stable split:

- content-addressed bytes in S3;
- revision/checkpoint metadata in Postgres;
- room coordination in the Rust room actor, not S3.

## Decision 7: One Big Room Host First, Leases Later

The first AWS service should be one vertically scaled room-host process behind
an ALB. One active process owns all live room actors.

This is intentionally not horizontally distributed at first. It avoids a class
of subtle bugs:

- two active hosts mutating the same room;
- sticky-session assumptions replacing explicit document authority;
- concurrent room-owned bootstrap actors producing duplicate Automerge seq
  errors;
- per-peer sync state accidentally surviving room movement.

Scale-out should be explicit and later. When more than one room-host process is
needed, add a Postgres-backed `room_leases` table:

```sql
CREATE TABLE room_leases (
  notebook_id text PRIMARY KEY REFERENCES notebooks(id) ON DELETE CASCADE,
  holder_id text NOT NULL,
  generation bigint NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

A host may own a live room only while it holds the lease. Room movement resets
per-peer `automerge::sync::State`; document truth comes from the latest
checkpoint/snapshot.

Durable Object hibernation and the current frame replay buffer are not
architectural requirements for the native service. A long-running room host can
keep active rooms in memory and should rely on document sync plus checkpoints
for recovery rather than porting hibernation behavior mechanically.

## Decision 8: Room Checkpointing Is Debounced But Durable

On room load, port the current Cloudflare materializer's checkpoint precedence
logic rather than replacing it with a simpler "checkpoint else snapshot" rule:

1. Check the latest checkpoint metadata.
2. If the checkpoint's recorded published revision differs from the latest
   published revision, keep it only when its recorded heads prove unpublished
   room changes, with the same legacy-version timestamp fallback used by the
   prototype.
3. If the checkpoint is compatible with the latest published revision baseline,
   load checkpointed `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` bytes.
4. Otherwise load the latest published snapshot bundle.
5. If neither exists, create an empty hosted room using deterministic room-owned
   actor labels and deterministic hosted starter-cell IDs.

On room mutation:

1. Apply the mutation to in-memory document truth.
2. Broadcast sync replies/updates to connected peers.
3. Debounce checkpoint writes to S3.
4. Record checkpoint metadata when useful for recovery/debugging.
5. Flush checkpoints on graceful shutdown and room eviction.

S3 checkpoint commits should be pointer-swapped, not four independent "latest"
writes. Write immutable `{checkpoint_id}/*.am` objects first, then write
`checkpoints/latest.json` last as the single commit point. A crash before the
pointer update leaves the previous checkpoint active; a crash after the pointer
update points at a complete immutable object set.

Room-owned bootstrap actors are load-bearing. Use deterministic labels derived
from notebook id, following the current Cloudflare room-host pattern:

```text
system:notebook-cloud-room/room:{stable_room_key(notebook_id)}
```

The hosted starter-cell id is also deterministic:
`cell-room-{stable_room_key(notebook_id)}`. Port both identities with shared
test vectors so restart/bootstrap behavior cannot reintroduce duplicate
Automerge sequence errors.

Concurrent users, agents, and runtime peers must author with unique actor
labels under their authenticated principal/operator. On reconnect, reset
per-peer sync state and preserve document truth.

The runtime-peer grace timer currently implemented with Durable Object alarms
becomes an in-process Tokio timer in the single-host service. Because that timer
dies with the process, room load must also reconcile stale runtime-peer state so
phantom running executions and kernels do not survive a host crash.

## Decision 9: Authority Boundaries Stay The Same

Moving from Durable Objects to Rust/AWS must not weaken hosted authorization:

- The room URL identifies a room; it does not grant access.
- Credentials authenticate principals.
- Postgres ACL rows authorize room scope.
- The room actor is document authority.
- Runtime peers are compute/output authority for accepted work, not notebook
  editors and not execution-intent creators.
- Sandboxed output frames remain on a separate origin and must not receive app
  credentials.

Execution authority stays separate from edit authority. The current policy is
owner-only for execution requests until an explicit execute capability exists.
UI gating is not enough; the room host must reject unauthorized `REQUEST`
frames.

The hosted request dispatcher must also explicitly reject request types that are
local-daemon concerns, such as local kernel launch/interrupt/shutdown and
`.ipynb` save requests, unless a hosted controller intentionally implements
them. Hosted-safe request types include execution intent for an already attached
runtime peer, run-all intent, and widget comm messages. Unsupported request
types return structured error responses; they are not silently dropped.

Runtime control-plane signals must remain independent from output/blob
transport. `KernelIdle`, `ExecutionDone`, `CellError`, and `KernelDied` cannot
be backpressured by stdout floods, display churn, manifest commits, or blob
writes.

## Decision 10: Hosted Origins Stay Split

The AWS deployment keeps the three-origin security model from
`hosted-output-origin-isolation.md`:

- authenticated app/API/WebSocket origin;
- renderer asset origin;
- sandboxed output-document/usercontent origin.

The first Terraform plan therefore needs more than one origin, not merely one
ALB route. It may serve the authenticated app/API/WebSocket origin from the Rust
service and serve renderer/output assets through S3 + CloudFront, or another
equivalent split. The important invariant is that sandboxed output frames cannot
receive app cookies, tokens, or localStorage.

## Consequences

Positive:

- The hosted room engine becomes testable with ordinary Rust integration tests.
- We can use shared `runtimed` room-loop logic instead of maintaining a
  TypeScript/WASM room-host fork.
- Postgres gives real transactions, indexes, row-level locking, and a path to
  room leases.
- S3 gives a durable byte store for snapshots/blobs without relational row-size
  pressure.
- AWS deployment avoids Cloudflare Durable Object request limits for live demo
  traffic.

Negative:

- We take on more infrastructure surface: ALB, EC2/ECS, RDS, S3, IAM, secrets,
  and observability.
- The first single-host deployment is a single point of failure until lease
  based sharding/HA exists.
- Auth/session code currently written for Workers must be ported or extracted.
- The room-host core must be implemented natively while staying behaviorally
  aligned with the current `RoomHostHandle` reference design.

Neutral:

- The browser/client protocol should remain compatible.
- Runtime/workstation peers should keep using `notebook-cloud-transport`.
- Cloudflare can still serve static/edge pieces later if useful, but it is not
  the room authority in this ADR.

## Rejected Alternatives

### Run Wrangler/Miniflare On EC2

This can be useful as a temporary debugging bridge, but it keeps the Worker,
Durable Object, D1, and R2 mental model while removing the managed platform
that made that model worthwhile. It also does not move us toward native Rust
room-host tests or Postgres/S3 durability.

### Self-Managed Postgres On The Room Host

This is fine for disposable spikes but not the default. It couples application
instance replacement to database durability and makes backups, upgrades,
restore testing, disk alarms, and credential rotation our immediate problem.

### Store Automerge Bytes In Postgres

Postgres should store metadata and decisions. S3 should store large immutable
or checkpointed bytes. Keeping Automerge saves and blobs out of relational rows
avoids row bloat and makes content-addressed blob behavior straightforward.

### Horizontal Multi-Host First

The protocol and product are not ready for implicit multi-host room authority.
Start with one live host and add explicit leases once the native room host is
correct.

## Implementation Plan

No Terraform should land until the native hosted room passes local integration
tests against Postgres and an S3-compatible object store such as MinIO. The
first carve-outs should be verifiable with `cargo test` and local services,
without AWS.

1. Build an Axum/Tokio WebSocket adapter that implements `FrameSource` and
   `FrameSink` over one-message-per-frame hosted WebSockets, with frame-size
   caps sourced from `notebook-wire`. Test it against `CloudWsFrameTransport`
   as the client.
2. Decouple the reusable parts of `peer_loop` / `peer_writer` from `Daemon`.
   Pass idle timeout and pool-doc behavior as explicit parameters or hosted
   adapters.
3. Define hosted request policy and dispatch traits. Hosted dispatch should
   accept only hosted-safe request types and return structured errors for
   local-daemon request types.
4. Build `HostedRoom` / `RoomActor` after `RoomHostHandle`'s structure, reusing
   shared document crates and peer-loop mechanics. The actor owns documents and
   per-peer sync states in one task; it does not include file binding, local
   trust state, local kernel handles, or local autosave.
5. Define fresh native hosted room traits:
   - `HostedCatalogStore`;
   - `HostedObjectStore`;
   - `HostedCheckpointStore`;
   - `HostedAuthz`;
   - `HostedRoom`.
   These are new service abstractions, not an existing `runtimed` persistence
   layer. Provide filesystem/MinIO and dockerized-Postgres test adapters.
6. Implement `HostedObjectStore` and `HostedCheckpointStore`; port checkpoint
   precedence logic with shared test vectors for deterministic actor label,
   starter cell id, and keep/discard decisions.
7. Implement Postgres migrations and a `sqlx` `HostedCatalogStore` /
   `HostedAuthz` for catalog, ACL, sharing, workstations, and attach jobs.
   Preserve never-zero-owner ACL protection, partial unique active attach jobs,
   and transactional revision publication.
8. Implement the app-session/OIDC credential layer and key-management contract
   needed by the Rust service.
9. Add integration tests covering:
   - initial sync;
   - editor notebook writes;
   - owner execution request acceptance;
   - editor execution request rejection;
   - explicit rejection for local-daemon-only request types;
   - runtime peer RuntimeStateDoc/CommsDoc sync;
   - `PutBlob`;
   - widget state convergence across two browser clients;
   - checkpoint save/load after process restart.
10. Add Terraform for one staged AWS deployment:
   - VPC/subnets or use existing VPC input;
   - ALB and target group;
   - EC2/ECS room-host service;
   - RDS PostgreSQL;
   - S3 bucket;
   - Secrets Manager/SSM;
   - app, renderer-asset, and output-document origins;
   - IAM role/policies;
   - CloudWatch logs/metrics.
11. Run the existing hosted Playwright/smoke flows against the AWS origin.

## Tracked Follow-Ups

- Decide whether the Rust service binary is `runtimed cloud-room-host`,
  `runt cloud serve`, or a separate temporary binary.
- Decide whether HTTP app/API routes and WebSocket rooms live in one binary or
  split after the first deployment.
- Define a public/private output blob access policy for S3-backed blobs and the
  separate output origin.
- Add the future execute capability/scope before granting non-owner execution.
- Add `room_leases` only when multiple room-host processes are introduced.

## References

- AWS ALB WebSocket support:
  `https://docs.aws.amazon.com/elasticloadbalancing/latest/application/load-balancer-listeners.html`
- AWS ALB idle timeout attribute:
  `https://docs.aws.amazon.com/elasticloadbalancing/latest/application/edit-load-balancer-attributes.html`
- Amazon S3 consistency:
  `https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html`
- Amazon RDS for PostgreSQL:
  `https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/CHAP_PostgreSQL.html`
- RDS Multi-AZ deployments:
  `https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZ.html`
- Terraform `aws_db_instance`:
  `https://registry.terraform.io/providers/hashicorp/aws/latest/docs/resources/db_instance`
- Hosted credential transport:
  `hosted-credential-transport.md`
- Hosted output origin isolation:
  `hosted-output-origin-isolation.md`
- Hosted notebook artifacts:
  `hosted-notebook-artifacts.md`
