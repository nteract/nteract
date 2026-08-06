# Self-hosted nteract with celld

**Status:** Memo / exploratory spike, 2026-08-06. This is not an accepted
deployment decision or a production-readiness claim.

## Outcome

celld is a promising way to preserve the current Worker and Durable Object room
model in a customer-controlled environment. It does not change the compute
model: kernels remain on customer-managed BYOC workstations, and those
workstations connect outbound to the hosted room as `runtime_peer`s.

For a company deployment, the reference shape should currently be:

- celld for the live Worker, `NotebookRoom`, `WorkstationEvents`, and
  `OwnerComputeIndex` objects;
- a small private nteract control service backed by Postgres for catalog,
  authorization, sharing, and workstation records;
- S3-compatible object storage for notebook snapshots and output blobs;
- a separate S3-compatible bucket for celld's own fleet state; and
- company ingress and identity in front of the application.

Do not add Redis by default. celld already owns room placement, single-writer
fencing, WebSocket fanout, object-local state, and alarms. Postgres owns
relational control-plane state, while object storage owns immutable bytes.

An all-celld deployment is still worth testing as a small evaluation profile.
It should not be the enterprise reference architecture until celld ships D1 or
the catalog has proved that a deliberately temporary catalog object is enough.

## Correction: `CatalogDb` is not a product

`CatalogDb` was a name introduced in the initial spike for a hypothetical
deployment-scoped Durable Object containing the current D1 SQLite schema. It is
not an existing nteract component or celld feature.

There are only two reasons to build it:

1. prove a single-server or private pilot without operating Postgres; or
2. bridge a short, explicit gap while waiting for celld's planned D1 support.

Those benefits are mostly fewer deployable components and less initial porting.
The costs are more important for an enterprise deployment:

- the catalog becomes one application-defined cell and a likely serialization
  point;
- backup, point-in-time recovery, inspection, reporting, and repair are less
  familiar to company database operators;
- it creates a throwaway API and migration unless celld D1 is compatible with
  the chosen shape; and
- identity, audit, and administration integrations still need a conventional
  control-plane boundary.

The recommendation is therefore **not** to build `CatalogDb` as the durable
architecture. Use Postgres unless native celld D1 arrives before implementation
and passes the acceptance checks below.

## D1 decision checkpoint

As of 2026-08-06, celld's compatibility documentation lists D1 as planned and
describes it as a thin SQL layer over Durable Objects. The public repository has
no D1 issue, milestone, or delivery date. R2 is explicitly not planned as a
celld service.

Recheck celld immediately before starting the catalog port:

| Choice | Use when | Main advantage | Main risk |
| --- | --- | --- | --- |
| Native celld D1 | It is released, documented, and passes nteract's catalog and recovery tests | Closest to the current Worker and one fewer service | Young operational surface; portability and recovery must be proved |
| Postgres plus a private control service | A customer-deployable topology is needed before then | Familiar transactions, HA, backup/PITR, inspection, and enterprise operations | One more service and a D1-to-Postgres port |
| Temporary catalog Durable Object | A disposable evaluation must avoid Postgres | Fastest all-celld experiment | Bespoke bottleneck and migration work; not the production default |

Waiting for D1 should mean delaying the backend choice until this checkpoint,
not blocking the rest of the spike. The room host, artifact store, ingress,
identity, BYOC attachment, and recovery tests can all proceed independently.

Native celld D1 is acceptable only if it can demonstrate:

- the current catalog queries and cross-row constraints without weakened
  semantics;
- documented backup, restore, upgrade, and migration procedures;
- recovery after node loss with no acknowledged catalog writes lost;
- a supported path to inspect and repair customer data;
- acceptable listing and authorization latency at the intended tenant size;
  and
- an export path that does not trap notebook ownership and ACL data inside the
  celld fleet.

## On-prem reference topology

```text
browser / desktop / agent
          |
          | HTTPS + typed-frame WebSocket
          v
company ingress: F5 / HAProxy / Envoy / equivalent
  - TLS and three browser origins
  - OIDC or company session integration
  - strips untrusted identity headers
          |
          v
celld Worker ------------------------------------------+
  |-- NotebookRoom DO, one per notebook                |
  |-- WorkstationEvents DO                             | private HTTPS
  |-- OwnerComputeIndex DO                             |
  `-- viewer and application assets                    v
                                               nteract-control
                                                 |-- catalog and ACL API
                                                 |-- sharing/invites API
                                                 |-- workstation registry
                                                 `-- artifact API
                                                   |             |
                                                   v             v
                                               Postgres     S3-compatible
                                                            app-data bucket

celld nodes ---------------- dedicated S3-compatible fleet bucket
  - deployments
  - cell SQLite/LTX state
  - leases and peer secret

NotebookRoom <----- outbound WSS runtime_peer ----- BYOC workstation
                                                     `-- daemon + kernels
```

`nteract-control` is a placeholder name for a new component, not shipped code.
It should expose named domain operations rather than arbitrary SQL or a generic
D1-over-HTTP proxy. Examples include:

- create, list, and authorize access to a notebook;
- grant, revoke, invite, and resolve access requests;
- record and retrieve revision and blob metadata;
- register, pair, and select a workstation; and
- create, claim, expire, and inspect workstation attach jobs.

This boundary keeps SQL dialect and transaction details out of the Worker. It
also makes a future `D1CatalogStore` or another company database backend
possible without pretending every database is D1.

celld currently does not provide TCP sockets, so the Worker cannot use a normal
Postgres driver directly. The private HTTPS boundary is required unless celld's
runtime capabilities change. It should be reachable only from the application
network and authenticate celld requests independently of end-user sessions.

## State ownership

| State | Durable owner | Notes |
| --- | --- | --- |
| Live `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and `CommentsDoc` | `NotebookRoom` on celld | One active room cell owns peer sync state and room authority. |
| Catalog, ACLs, principals, invites, access requests | Postgres through `nteract-control` | Queryable and recoverable independently of active rooms. |
| Workstation registry, credentials, defaults, pairing, attach jobs | Postgres through `nteract-control` | BYOC metadata only; kernels do not move into the control plane. |
| Published snapshots, output blobs, renderer blobs, room summaries | Application-data object bucket | Separate retention and credentials from celld fleet state. |
| celld deployments, cell databases, leases, peer secret | celld fleet bucket | Bucket credentials are fleet-administrator authority. |
| Kernel processes, packages, data access, secrets | BYOC workstation | Governed by the customer's workstation and data perimeter. |

Use separate fleet and application-data buckets even when one S3-compatible
service supplies both. The Worker or control service must never receive the
fleet-administrator credentials.

Redis does not own an unclaimed invariant in this design. Reconsider it only
for a measured feature that cannot be expressed through the room objects,
Postgres, or the artifact store; do not introduce it for locks, presence,
pub/sub, or queues by habit.

## Request and execution flow

1. Company ingress authenticates a browser session and preserves the separate
   app, renderer-asset, and output-document origins.
2. The Worker resolves the application principal through the existing
   host-session/userinfo boundary.
3. The Worker asks `nteract-control` for notebook authorization before upgrading
   the room WebSocket or performing a catalog mutation.
4. `NotebookRoom` owns Automerge sync and live runtime state for authorized
   peers.
5. A customer-managed workstation registers and pairs through the application,
   then opens an outbound connection. It does not require inbound firewall
   access.
6. The workstation attaches to a room as a fenced `runtime_peer`. Execution
   still references a synced cell ID, and kernels remain on that workstation.
7. The room checkpoints notebook state and output references through the
   artifact boundary into the application-data bucket.

exe.dev can host an externally reachable proof when useful, but it is neither a
kernel provider nor part of the customer deployment contract.

## Identity and company integration

celld deliberately does not authenticate application users or terminate public
TLS. The company deployment must supply those layers.

The first integration should use the existing host-session adapter shape:

- ingress or an identity proxy handles OIDC and the company IdP;
- the Worker receives an opaque session and resolves it through a trusted
  userinfo endpoint;
- ingress strips client-supplied identity headers; and
- nteract still enforces tenant admission, notebook ACLs, sharing, and
  runtime-session fencing.

This can fit Keycloak, an existing access proxy, or a company-specific identity
bridge without embedding each provider into the room host. PAM, Active
Directory group mapping, SCIM, enterprise audit export, and administrator
workflows remain product and integration work; this memo does not claim they
already exist.

## Deployment profiles

### Evaluation

A single Linux host may run ingress, one celld node, `nteract-control`,
Postgres, and a company-provided or local S3-compatible endpoint under systemd,
Podman, or Compose. One separate workstation proves BYOC execution. This is a
functional evaluation profile, not an HA claim.

For an explicitly disposable all-celld evaluation, Postgres and
`nteract-control` catalog operations may be replaced by one temporary catalog
object. Artifact storage is still required because celld does not implement R2
bindings.

### Company production candidate

- redundant company ingress;
- at least two celld nodes on a private or encrypted peer network;
- at least two stateless `nteract-control` instances;
- company-standard Postgres HA, backup, and point-in-time recovery;
- redundant S3-compatible storage with separate fleet and application-data
  buckets;
- central secret management, logs, metrics, and alerting; and
- offsite or separate-failure-domain recovery for catalog and object data.

Kubernetes is not required. Conventional VM services are the first packaging
target; an OpenShift operator or Helm packaging can follow if a customer
requires it. The same application boundaries should survive either packaging
choice.

celld is currently alpha and explicitly says it is unsafe for hostile
multi-tenant use. This production shape is therefore a candidate to validate,
not something this memo endorses for general availability.

## Backup, restore, and disaster recovery

The deployment is not recoverable unless all three durable stores have a tested
procedure:

1. Postgres: schema migrations, scheduled backups, PITR, and restore validation.
2. Application-data bucket: versioning or immutable retention as required,
   inventory, lifecycle policy, and restoration of snapshots and blobs.
3. celld fleet bucket: scoped credentials, replicated backup, and a documented
   fleet reconstruction procedure that preserves or deliberately rehomes cell
   ownership.

Restoring only Postgres loses notebook documents; restoring only celld loses
catalog and ACL state; restoring only published snapshots may lose newer live
room state. A recovery exercise must define a common recovery point and verify
that room materialization, ACLs, blob references, and workstation attachment
remain coherent.

## celld compatibility and spike evidence

The existing cloud application maps naturally onto celld's implemented
Durable Object surface:

- Worker `fetch`, service bindings, SQLite-backed Durable Objects, alarms,
  inbound and outbound WebSockets, static assets, and WebAssembly are present;
- the current `NotebookRoom`, `WorkstationEvents`, and `OwnerComputeIndex`
  classes align with that model; and
- one application deployment per fleet is compatible with a single-customer
  deployment.

The current application does not deploy unchanged:

| Current dependency | celld status | Required response |
| --- | --- | --- |
| D1 `DB` binding | Planned, not shipped | Use Postgres/control service now, or re-evaluate native D1 at the checkpoint. |
| R2 `NOTEBOOK_SNAPSHOTS` binding | Binding methods throw; service is not planned | Introduce an application artifact boundary backed by S3-compatible storage. |
| `runtimed-wasm` bundling | V8 supports WebAssembly; stock celld bundling did not select a `.wasm` loader | Prebundle or configure celld's esbuild wrapper, then prove runtime initialization. |
| Custom domains and TLS | Not supplied | Use company ingress. |
| Direct RS256 verification | Current Web Crypto verification is HMAC-only | Use the host-session/userinfo bridge behind the identity proxy. |
| `wrangler.toml`, routes, observability keys | Not supported by `celld deploy` | Maintain a minimal celld JSON configuration; put routing and telemetry at ingress/platform layers. |

A local celld v0.1.0 dry run found one concrete packaging issue. The stock
command failed on `runtimed_wasm_bg.wasm`; adding only
`--loader:.wasm=binary` through celld's esbuild override bundled the current
Worker entry and all three Durable Object bindings successfully. The resulting
bundle was 6,429.91 KiB raw and 1,869.62 KiB gzip. No node was started and
nothing was deployed to object storage, so runtime initialization and behavior
remain unproved.

celld's current security boundary also requires:

- peer traffic on a trusted private network or encrypted overlay because peer
  HTTP is authenticated but not encrypted;
- public TLS and user authentication outside celld;
- fleet-scoped bucket credentials treated as administrator secrets; and
- an explicit rollout/rollback procedure for every node.

## Suggested next proof

1. Add `CatalogStore` and `ArtifactStore` domain boundaries without changing
   behavior on Cloudflare.
2. Specify the named control-service operations and map the current 13 D1
   tables and storage functions to Postgres constraints and transactions.
3. Boot the Worker on one celld node, including `runtimed-wasm` initialization,
   static assets, and all three browser origins.
4. Prove the application-data S3 path for notebook snapshots and representative
   large outputs.
5. Run registration, pairing, attach-job, execution, interrupt, output, and
   stale-session tests with the kernel on a BYOC workstation.
6. Add a second celld node and kill the active room owner during edits and
   execution. Require reconnection, Automerge convergence, intact ACLs, and no
   acknowledged document loss.
7. Restore Postgres, the application-data bucket, and the celld fleet into a
   clean environment and measure the recovery point and recovery time.

Before step 2 begins, recheck whether native celld D1 has shipped. If it has,
run the same catalog contract and recovery suite against both D1 and Postgres;
choose from evidence rather than API similarity.

## Go/no-go gates

Proceed beyond the spike only if:

- room collaboration and workstation execution pass without weakening peer
  roles or runtime-session fencing;
- node loss recovers edited rooms without acknowledged state loss;
- catalog and artifact backups restore into a clean deployment;
- operators can inspect failures, roll forward, and roll back using supported
  procedures;
- the app, renderer, and output-document origin contract remains intact;
- cold room materialization, reconnect time, checkpoint throughput, active-room
  memory, and catalog authorization latency meet agreed targets; and
- the customer can identify ownership for ingress, identity, Postgres, object
  storage, celld upgrades, secrets, monitoring, and disaster recovery.

## Related documents and sources

- [Deployment Topology](../adr/deployment-topology.md)
- [Remote Workstation Document Agents](../adr/remote-workstation-doc-agents.md)
- [Hosted Room Authorization](../adr/hosted-room-authorization.md)
- [AWS Rust Room Host](./aws-rust-room-host.md)
- [Hosted Notebook Federation](./hosted-notebook-federation.md)
- [celld Cloudflare compatibility](https://github.com/denoland/celld/blob/main/docs/cloudflare-compat.md)
- [celld security](https://github.com/denoland/celld/blob/main/docs/security.md)
- [celld limitations](https://github.com/denoland/celld/blob/main/docs/limitations.md)

