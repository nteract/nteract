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
extract:

- `crates/runtimed/src/notebook_sync_server/peer_loop.rs` has the biased
  frame/readiness/runtime/presence loop.
- `peer_writer.rs` classifies reliable frame lanes and gates request authority.
- The native room model owns `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`,
  presence, request workers, blob upload workers, and runtime lifecycle.

The cloud Worker has hosted product pieces that should be ported through proper
interfaces:

- `apps/notebook-cloud/src/index.ts` has route shape, auth/session endpoints,
  notebook APIs, sharing APIs, and workstation APIs.
- `apps/notebook-cloud/src/storage.ts` defines the current catalog, ACL,
  sharing, workstation, default-workstation, and attach-job data model.
- `apps/notebook-cloud/src/room-materializer.ts` has the checkpoint and
  published-snapshot recovery policy, currently backed by Durable Object
  storage, D1, R2, and `runtimed-wasm`.

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

The service should reuse native `runtimed` room-loop mechanics where possible.
It should not embed `runtimed-wasm` as its core room engine. WASM remains a
browser/client boundary and a compatibility/testing asset; the server is native
Rust.

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

## Decision 3: Postgres Is The Catalog And Authorization Store

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

Use `sqlx` as the default Rust database client:

- it fits an Axum/Tokio service;
- it has an async pool and transaction API;
- it gives us checked queries and migrations as the schema grows;
- it makes it harder to quietly drift between application types and SQL rows.

`tokio-postgres` remains an acceptable fallback if a concrete dynamic-query
need makes `sqlx` awkward, but it should not be the default.

## Decision 4: RDS Is The Default Managed Postgres Deployment

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

## Decision 5: S3 Stores Snapshots And Blobs

S3 stores Automerge document bytes, runtime/comms snapshots, output blobs, and
rendered/generated artifacts. Postgres stores metadata and authorization
decisions.

Initial object layout:

```text
notebooks/{notebook_id}/checkpoints/latest.json
notebooks/{notebook_id}/checkpoints/{checkpoint_id}/notebook.am
notebooks/{notebook_id}/checkpoints/{checkpoint_id}/runtime-state.am
notebooks/{notebook_id}/checkpoints/{checkpoint_id}/comms.am

notebooks/{notebook_id}/snapshots/{notebook_heads_hash}.am
docs/{runtime_state_doc_id}/snapshots/{runtime_heads_hash}.am
docs/{comms_doc_id}/snapshots/{comms_heads_hash}.am

blobs/{sha256}
```

This aligns with `hosted-notebook-artifacts.md`: published revisions are
snapshot bundles, and blob references are content-addressed. The exact key
prefixes may change during implementation, but the split is stable:

- content-addressed bytes in S3;
- revision/checkpoint metadata in Postgres;
- room coordination in the Rust room actor, not S3.

## Decision 6: One Big Room Host First, Leases Later

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

## Decision 7: Room Checkpointing Is Debounced But Durable

On room load:

1. Check the latest checkpoint metadata.
2. If the checkpoint is compatible with the latest published revision baseline,
   load checkpointed `NotebookDoc`, `RuntimeStateDoc`, and `CommsDoc` bytes.
3. Otherwise load the latest published snapshot bundle.
4. If neither exists, create an empty hosted room using deterministic room-owned
   actor labels and deterministic hosted starter-cell IDs.

On room mutation:

1. Apply the mutation to in-memory document truth.
2. Broadcast sync replies/updates to connected peers.
3. Debounce checkpoint writes to S3.
4. Record checkpoint metadata when useful for recovery/debugging.
5. Flush checkpoints on graceful shutdown and room eviction.

Room-owned bootstrap actors are load-bearing. Use deterministic labels derived
from notebook id, following the current Cloudflare room-host pattern:

```text
system:notebook-cloud-room/room:{stable_room_key(notebook_id)}
```

Concurrent users, agents, and runtime peers must author with unique actor
labels under their authenticated principal/operator. On reconnect, reset
per-peer sync state and preserve document truth.

## Decision 8: Authority Boundaries Stay The Same

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

Runtime control-plane signals must remain independent from output/blob
transport. `KernelIdle`, `ExecutionDone`, `CellError`, and `KernelDied` cannot
be backpressured by stdout floods, display churn, manifest commits, or blob
writes.

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
- The room-host core must be extracted from the WASM boundary carefully to avoid
  reintroducing projection drift.

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

1. Define native hosted room traits:
   - `HostedCatalogStore`;
   - `HostedObjectStore`;
   - `HostedCheckpointStore`;
   - `HostedAuthz`;
   - `HostedRoom`.
2. Extract the room-host document logic out of `runtimed-wasm` into native Rust
   where needed.
3. Build an Axum/Tokio WebSocket adapter that speaks hosted typed-frame v4
   messages.
4. Implement Postgres migrations and a `sqlx` store for catalog, ACL, sharing,
   workstations, and attach jobs.
5. Implement S3 object storage for snapshots and blobs, with a filesystem/minio
   test adapter.
6. Add integration tests covering:
   - initial sync;
   - editor notebook writes;
   - owner execution request acceptance;
   - editor execution request rejection;
   - runtime peer RuntimeStateDoc/CommsDoc sync;
   - `PutBlob`;
   - widget state convergence across two browser clients;
   - checkpoint save/load after process restart.
7. Add Terraform for one staged AWS deployment:
   - VPC/subnets or use existing VPC input;
   - ALB and target group;
   - EC2/ECS room-host service;
   - RDS PostgreSQL;
   - S3 bucket;
   - Secrets Manager/SSM;
   - IAM role/policies;
   - CloudWatch logs/metrics.
8. Run the existing hosted Playwright/smoke flows against the AWS origin.

## Tracked Follow-Ups

- Decide whether the Rust service binary is `runtimed cloud-room-host`,
  `runt cloud serve`, or a separate temporary binary.
- Decide whether HTTP app/API routes and WebSocket rooms live in one binary or
  split after the first deployment.
- Design production session-cookie refresh and OIDC callback handling outside
  Workers.
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
