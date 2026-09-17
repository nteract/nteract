# AWS Rust Room Host

**Status:** Memo / proposal, 2026-06-10. Trimmed 2026-06-29.

This memo explores what it would look like to run hosted notebook rooms outside
Cloudflare with a native Rust room host. It is not an accepted deployment ADR.
The Cloudflare Worker/Durable Object stack remains the current prototype and
evidence source.

Related:

- [Deployment Topology](../adr/deployment-topology.md)
- [Hosted Room Authorization](../adr/hosted-room-authorization.md)
- [Hosted Credential Transport](../adr/hosted-credential-transport.md)
- [Hosted Notebook Artifacts](../adr/hosted-notebook-artifacts.md)

## Why Consider This

The Cloudflare prototype proved the product loop:

- browsers, agents, and runtime/workstation peers connect to a hosted room over
  typed-frame v4 WebSockets;
- the room host owns `NotebookDoc`, `RuntimeStateDoc`, `CommsDoc`, and
  `CommentsDoc`;
- runtime peers can attach from a workstation and publish execution/output
  state;
- sharing, public snapshots, widgets, and workstation attach flows can all sit
  on the same document model.

It also exposed a deployment pressure point. Durable Objects are convenient for
one-object-per-room coordination, but a long-running collaborative runtime
surface needs direct control over scaling, observability, persistence, queue
behavior, and operational limits.

## Target Shape

The candidate production shape is a native Rust service:

```text
browser / desktop / agent / workstation runtime peer
        |
        | wss://host/n/:notebook_id/sync
        | one WS binary message = [NotebookFrameType byte][payload]
        v
Rust hosted room service
        |
        | active room actor owns NotebookDoc + RuntimeStateDoc + CommsDoc + CommentsDoc
        v
Postgres catalog/ACL/workstations + S3 snapshots/blobs
```

This should be `runtimed`-adjacent hosted code, not a line-by-line port of the
TypeScript Worker. The Worker remains useful for route contracts, ACL behavior,
workstation attach jobs, snapshot validation, and output isolation. The daemon
remains useful for room-loop mechanics, request authority, peer writer lanes,
and runtime-state handling.

## Reusable Seams

- `crates/notebook-wire` defines frame bytes and frame limits.
- `crates/notebook-protocol` defines the frame transport abstractions.
- `crates/notebook-cloud-transport` already speaks the hosted WebSocket frame
  shape for runtime/workstation peers.
- `crates/runtimed-wasm::RoomHostHandle` is the closest reference for hosted
  room behavior: per-peer sync state, scope validation, execution queue
  handling, workstation attachment publication, and runtime-peer gone
  reconciliation.
- `apps/notebook-cloud` is the reference for API routes, app sessions, ACLs,
  sharing, workstation metadata, and materialization policy.

## Candidate Decisions

1. **One active actor owns each live room.** Do not share room documents or
   per-peer Automerge sync state across peer tasks through `Arc<RwLock<_>>`.
   Peer tasks communicate with the room actor through channels.
2. **Postgres owns catalog and authorization state.** Notebook rows, ACLs,
   sharing, app sessions, workstation registration, and attach jobs should be
   queryable outside the live room actor.
3. **S3 owns durable snapshot bundles and blobs.** The live actor checkpoints
   document bytes and blob references; materialization rebuilds from the latest
   valid snapshot.
4. **The wire protocol stays host-neutral.** Browsers and runtime peers should
   continue speaking typed-frame v4 payloads. Host-specific URLs, cookies, and
   storage details stay outside shared components and protocol crates.
5. **Runtime peers remain scoped room participants.** Workstations attach as
   `runtime_peer`; execution intent still comes from authorized room requests.

## Migration Question

The main architectural question is not whether Rust can host a room. The daemon
and WASM room host already prove the shape. The real question is which hosted
state should move first:

- **room loop first:** replace Durable Object room ownership while keeping
  existing Cloudflare APIs around it;
- **catalog first:** move ACL/session/workstation state to Postgres while the
  live room remains on Durable Objects; or
- **parallel host:** stand up a separate Rust-backed environment and migrate
  selected notebooks through snapshot import/export.

Each path should preserve the same user-visible room URL and document/protocol
contract.

## Open Questions

- What is the smallest Rust-hosted vertical slice that proves room actor,
  checkpoint, ACL, and runtime-peer attachment together?
- Should the service use one process with in-memory room actors, or a supervisor
  plus sharded room workers from the start?
- Which managed WebSocket/load-balancing layer gives the least surprising
  backpressure and idle-connection behavior?
- How should Cloudflare-hosted snapshots migrate into S3 without weakening blob
  reference validation?
- Which operational signals are required before this can replace the prototype:
  room count, peer count, queue depth, checkpoint latency, blob transfer, and
  runtime-peer liveness are the likely minimum set.
