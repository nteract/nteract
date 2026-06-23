# Compute Session Index

**Status:** RFC, 2026-06-23.

## Context

The hosted notebook dashboard should show which notebooks have active compute:
no compute, starting, active runtime, stale/needs attention, and last active
workstation. The information users care about is partly document state and
partly live transport state:

- `RuntimeStateDoc` is notebook-visible durable truth for selected
  workstation, runtime session id, queue/execution state, kernel lifecycle, and
  recovery status.
- The `NotebookRoom` Durable Object is live room truth for connected peers,
  including whether any `runtime_peer` WebSocket is attached right now.
- The `/api/workstations` registry is workstation availability truth, not
  per-notebook compute truth. It answers "which machines can I use?", not "what
  is currently running for this notebook?".
- `/api/n` and the `/n` dashboard list notebooks from D1 catalog rows without
  waking every notebook room.

The product need is Redis-like: a cheap owner-scoped index of live-ish compute
sessions for dashboards and workstation pages. The index must not become
execution authority. It should be a projection maintained by room hosts and
repair paths, and it should tolerate staleness.

## Source-Grounded Current State

- `apps/notebook-cloud/src/index.ts` `routeListNotebooks` returns catalog rows
  from `listNotebooksForPrincipal`; rows include id, title, owner, scope,
  timestamps, revision, viewer URL, and endpoints, but no compute status.
- `apps/notebook-cloud/src/notebook-room.ts` keeps a live peer map. It can count
  runtime peers with `runtimePeerCount()` and reconciles missing runtime peers
  through `refreshRuntimePeerWatch()` / `alarm()`.
- `apps/notebook-cloud/src/room-materializer.ts` exposes the room-owned
  workstation attachment snapshot from `RuntimeStateDoc`.
- `apps/notebook-cloud/src/storage.ts` has D1 tables for workstations,
  workstation defaults, attach jobs, pairing codes, and credentials. These are
  owner/workstation and job records, not a current notebook-compute summary.
- `packages/runtimed/src/notebook-workstation-attachment.ts` already projects
  attach-job status into `WorkstationAttachmentState` for notebook-visible
  state.
- `apps/notebook-cloud/viewer/notebook-dashboard.ts` projects `/api/n` rows
  into dashboard rows and facts. This is the natural frontend seam for adding
  a compute fact once the API exposes one.

## Design Principles

1. **RuntimeStateDoc remains durable notebook truth.** Collaborators inside a
   notebook should see selected workstation, starting/ready/error state, queue,
   and stale recovery state through the normal sync document.
2. **Live WebSocket membership remains room-local truth.** A live runtime peer
   is known to the room host. Dashboards should not fan out to every room to ask
   that question on load.
3. **The compute index is a projection, not authority.** It can be stale and
   must be overwritten by room truth. Execution, interrupt, restart, comms, and
   output authority still go through the room host and RuntimeStateDoc policy.
4. **Writes happen on lifecycle edges, not heartbeats.** Update the index when
   a runtime peer joins/leaves, workstation attachment changes, queued work is
   repaired, or a grace timer expires. Avoid per-frame or per-presence writes.
5. **Use provider-neutral nouns.** Prefer "compute session" for dashboard and
   workstation pages. Avoid "attachment" in user-facing surfaces except where
   discussing implementation.

## Proposed Model

Introduce a platform-neutral `ComputeSessionIndex` projection and an
owner-scoped compute-session summary:

```ts
interface NotebookComputeSessionSummary {
  notebook_id: string;
  owner_principal: string;
  state:
    | "none"
    | "starting"
    | "active"
    | "busy"
    | "queued"
    | "stale"
    | "error";
  workstation_id: string | null;
  workstation_display_name: string | null;
  job_id: string | null;
  runtime_session_id: string | null;
  runtime_peer_count: number;
  kernel_status: string | null;
  activity: "busy" | "idle" | "unknown";
  executing_cell_id: string | null;
  queued_cell_count: number;
  status_message: string | null;
  updated_at: string;
  last_runtime_seen_at: string | null;
  stale_after: string | null;
}
```

Dashboard rows only need a subset: state, workstation label, kernel/running
hint, and whether attention is needed. The larger shape is intentionally room
and workstation-page friendly.

### State Derivation

The room host should derive each summary from two inputs:

1. `RuntimeStateDoc` / workstation attachment snapshot:
   selected workstation, status, runtime session id, kernel status, queue, and
   executing cell.
2. Live room membership:
   runtime peer count and latest runtime-peer join/leave time.

Rules:

- `active` requires a connected runtime peer and ready/busy kernel state.
- `busy`/`queued` are refinements of active/starting when queue fields are
  non-empty.
- `starting` covers a selected workstation/accepted job where no runtime peer
  has joined yet.
- `stale` covers queued/running or ready-looking RuntimeStateDoc state with no
  live runtime peer after the room's grace window.
- `error` covers explicit failed attachment, kernel error, or repaired runtime
  loss.
- `none` means no selected compute target and no queued/running runtime state.

The dashboard may collapse `active`, `busy`, and `queued` into one compact
"Compute active" affordance until the UI needs more detail.

## Cloudflare Implementation Options

### Option A: OwnerComputeIndex Durable Object

Add a new SQLite-backed Durable Object class keyed by canonical owner
principal, for example:

```text
OwnerComputeIndex("compute:v1:<owner-principal>")
```

It exposes internal methods such as:

```ts
upsertSession(summary, guard)
markGone(notebookId, guard, reason)
listForNotebooks(notebookIds)
listForWorkstation(workstationId)
cleanupExpired(now)
```

The object stores summaries in private SQLite-backed DO storage and may keep a
short-lived in-memory map while active. `/api/n` remains D1-first for notebook
catalog and ACL rows, then makes one owner-index lookup for the visible
notebook ids and merges advisory summaries into those rows.

Pros:

- Closest Cloudflare equivalent to the Redis-like owner index we want.
- One owner lookup on `/n`, not one room lookup per notebook.
- Strongly consistent owner-scoped storage plus alarms/cleanup in the same
  coordination atom.
- Keeps the D1 notebook catalog relational and avoids overloading workstation
  tables with notebook liveness concerns.

Cons:

- More Cloudflare-specific than a D1/Postgres table.
- Adds DO-to-DO communication from room lifecycle edges.
- Hibernation resets memory, so summaries that matter must still be persisted
  in DO storage.
- Requires guard tokens so a stale disconnect from session A cannot clear a
  newer session B.

### Option B: D1 Materialized Table

Add a D1 table:

```sql
notebook_compute_sessions(
  owner_principal TEXT NOT NULL,
  notebook_id TEXT NOT NULL,
  state TEXT NOT NULL,
  workstation_id TEXT,
  workstation_display_name TEXT,
  job_id TEXT,
  runtime_session_id TEXT,
  runtime_peer_count INTEGER NOT NULL DEFAULT 0,
  kernel_status TEXT,
  activity TEXT,
  executing_cell_id TEXT,
  queued_cell_count INTEGER NOT NULL DEFAULT 0,
  status_message TEXT,
  updated_at TEXT NOT NULL,
  last_runtime_seen_at TEXT,
  stale_after TEXT,
  PRIMARY KEY (owner_principal, notebook_id)
)
```

Room hosts update this table through Worker-internal routes or direct storage
helpers on lifecycle edges. `/api/n` joins or separately fetches summaries for
the listed notebooks.

Pros:

- Simple to query with the notebook catalog.
- Easy to test with existing D1 route tests.
- Closest shape to the Rust/Postgres target.
- Survives room hibernation and process churn.

Cons:

- D1 row writes still count against storage/write usage; must avoid
  per-heartbeat churn.
- Requires stale-entry expiry or repair because D1 cannot know when a room DO
  dies without a lifecycle edge.
- Less Redis-like for future live dashboard updates.
- May tempt broader catalog joins before the projection contract is stable.

### Option C: Fan Out To Notebook Rooms On `/n`

For each notebook listed, call its room DO and ask for live compute status.

Rejected for now:

- Wakes many room DOs on dashboard load.
- Multiplies Worker/DO requests and cold-starts.
- Couples dashboard latency to the slowest room.
- Fails the portability model: a dashboard should query an index, not all live
  actors.

## Recommended Cloudflare Slice

Define the projection contract first, then use **Option A:
`OwnerComputeIndex` Durable Object** for the Cloudflare prototype. It matches
the Redis-like mental model, avoids dashboard fan-out, gives one owner-scoped
lookup per `/n` load, and keeps expiry/cleanup close to the cache.

D1 remains acceptable as a backend behind the same `ComputeSessionIndex`
interface if the first implementation needs the absolute smallest code surface,
but the public API and shared TypeScript/Rust projection names should not expose
that storage choice. The Rust/Postgres deployment can implement the same
contract with a Postgres table and optionally add Redis/Valkey/NATS as an
acceleration layer.

Implementation slices:

1. Add a pure projection helper in `packages/runtimed`:
   `projectNotebookComputeSessionSummary({ runtimeState, workstationAttachment,
   runtimePeerCount, now })`.
2. Add a Cloudflare `OwnerComputeIndex` DO binding/class with SQLite-backed
   storage and internal-only `upsert`, `markGone`, and `list` methods.
3. Have `NotebookRoom` publish a summary on:
   runtime peer join/restore, runtime-peer-watch reconcile after the grace
   window, workstation attachment control publish, and runtime-state repair.
4. Extend `/api/n` response rows with optional `compute_session`.
5. Extend `apps/notebook-cloud/viewer/notebook-dashboard.ts` facts with compact
   compute state. Keep rows useful without large cards or noisy labels.
6. Add owner-scoped workstation page/panel grouping by workstation:
   active compute sessions, starting sessions, needs-attention sessions.
7. Add expiry/repair:
   summaries older than a threshold are displayed as stale unless refreshed;
   opening the notebook room reconciles RuntimeStateDoc and republishes truth.

## Non-Cloudflare Shape

The platform-neutral model is:

```text
RoomActor owns live docs + peer membership
  -> publishes lifecycle events
  -> ComputeSessionIndex(owner, notebook)
  -> dashboard/workstation pages query index
```

On Rust + Postgres/S3:

- `RoomActor` is the native hosted room actor described in
  `docs/adr/aws-rust-room-host.md`.
- `Postgres` owns `notebook_compute_sessions`, notebook catalog, ACLs,
  workstation registry, attach jobs, and revision metadata.
- `S3` owns snapshots and blobs.
- `Redis`, `Valkey`, or in-process ETS-like cache is optional. It can speed up
  dashboards, SSE fanout, and pub/sub, but Postgres remains the durable
  projection table.
- `NOTIFY/LISTEN`, NATS, or a Tokio broadcast bus can deliver live dashboard
  updates. The base dashboard should still work by querying Postgres.

Mapping:

| Concept | Cloudflare prototype | Rust/Postgres host |
|---------|----------------------|--------------------|
| Room actor | NotebookRoom Durable Object | Tokio task / actor per notebook |
| Live runtime peer count | DO peer map | RoomActor peer registry |
| Durable runtime state | RuntimeStateDoc snapshot in room | RuntimeStateDoc in RoomActor + S3 checkpoint |
| Dashboard compute index | Per-owner DO, optionally D1 table | Postgres table, optional Redis cache |
| Stale expiry | DO alarm or query-time timestamp check | RoomActor timer + Postgres timestamp check |
| Wake/notify dashboards | Poll `/api/n`, future SSE | Poll/API, Postgres NOTIFY/NATS/SSE |

Avoid baking Cloudflare into the model:

- API fields should not mention Durable Objects, D1, alarms, or Worker routes.
- `compute_session` should be a projection shape, not a serialized
  `WorkstationAttachmentState`.
- Use explicit timestamps, `runtime_session_id`, `job_id`, and optionally a
  room-issued generation/connected-at token so late peers and stale cache
  entries can be rejected independent of platform.
- Keep repair idempotent: publishing the same summary twice is a no-op.

## Failure Modes And Guards

- **Stale active session after room crash or deploy.** Use `updated_at` and
  `last_runtime_seen_at`; dashboard displays stale/unknown after a threshold.
- **Late runtime peer writes.** Runtime session fencing remains enforced in the
  room host; index mutations compare `runtime_session_id`/`job_id` before
  clearing active state.
- **Index write failure.** Do not fail execution because the dashboard index
  write failed. Log and let the next lifecycle edge repair the projection.
- **Noisy runtime state updates.** Do not write on every RuntimeStateDoc sync
  frame. Coalesce to lifecycle/status boundary updates.
- **ACL leakage.** `/api/n` only includes summaries for notebooks already
  visible to the requester. Owner/workstation pages only show summaries for the
  owner principal.
- **Shared editor confusion.** If an editor can execute but does not own the
  workstation, the summary should say compute is active for the notebook, but
  management controls remain owner/workstation-authorized.
- **Expired workstation registry vs active room peer.** Room peer truth wins
  for active compute; workstation registry truth wins for "can I start new
  compute?".
- **Scope confusion.** `runtime_peer` is orthogonal to `viewer`/`editor`/`owner`.
  The index must not treat scopes as a total order or infer management rights
  from runtime presence.

## Open Questions

1. Should shared editors see active compute summaries on `/n`, or only notebook
   owners? Product likely wants editors to see "this notebook has compute",
   but controls may differ.
2. Should the first slice include a workstation page at `/workstations`, or only
   enrich `/n` and the existing rail?
3. How much queue detail belongs on `/n`? A compact "running" fact may be enough
   initially.
4. Should stale summaries be deleted, marked stale, or hidden? For demos,
   "Needs attention" is better than disappearing state.
5. Should public/view-only notebooks expose active compute? Probably no by
   default; compute liveness may leak owner activity.

## Proposed Next PR

Create the projection helper and Cloudflare owner index, publish summaries on
room runtime peer join/leave and runtime-peer-watch reconcile, and add a compact
dashboard fact. Defer live dashboard push, workstation grouping, and richer
management controls until the read-only summary proves correct.

## References

- Cloudflare Durable Objects rules:
  `https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/`
- Cloudflare Durable Objects WebSocket hibernation:
  `https://developers.cloudflare.com/durable-objects/best-practices/websockets/`
- Cloudflare Durable Objects SQLite storage:
  `https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/`
- Cloudflare Durable Objects limits:
  `https://developers.cloudflare.com/durable-objects/platform/limits/`
