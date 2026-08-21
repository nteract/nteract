# Notebook Room Host Selection

**Status:** Memo / benchmark plan with partial evidence, 2026-08-20. No host is
selected. Do not convert this memo into an ADR until every hard gate has run.

This memo defines how nteract should select a customer-operated notebook room
host without changing the notebook document model or preselecting an
infrastructure vendor. It replaces the CellD 0.1 assumptions in closed PRs
[#4128](https://github.com/nteract/nteract/pull/4128) and
[#4129](https://github.com/nteract/nteract/pull/4129).

Related:

- [Notebook Cloud Host Compatibility Audit](../audits/notebook-cloud-host-compatibility.md)
- [AWS Rust Room Host](aws-rust-room-host.md)
- [Deployment Topology](../adr/deployment-topology.md)
- [Hosted Room Authorization](../adr/hosted-room-authorization.md)

## Decision to Make

Select the smallest production-viable host that can run nteract's existing room
authority inside an operator-controlled deployment:

- one service hosts many named notebook rooms;
- each active room has one authoritative document owner;
- owner, editor, viewer, and runtime-peer authority is enforced at connection
  and mutation boundaries;
- acknowledged edits survive process and node loss;
- snapshots and blobs live in operator-owned S3-compatible storage; and
- typed-frame v4, document schemas, notebook IDs, and blob references remain
  portable.

Cloudflare remains the behavioral control, not a finalist for
customer-operated hosting.

## Candidate Set

| Candidate | Why it remains in the benchmark | Principal risk | Current status |
| --- | --- | --- | --- |
| CellD 0.3 | Reuses the current Worker, three Durable Object classes, D1 schema, WebSockets, alarms, WASM, and assets | Alpha security and operations boundary; separate fleet authority; no R2 binding | Functional local proof passes the documents-first slice; production gates open |
| Native Rust room host | Maximum control and direct reuse of nteract protocol and room-host crates | Largest new service and operations implementation | Existing memo and reusable seams identified; proof not yet run |
| Rivet Actors | Entity lifecycle, persistence, WebSockets, migration, and self-hosting match room semantics | Separate control plane; multi-node Postgres remains experimental; hibernation is beta | Desk evaluation only |
| Cloudflare | Known-good Worker and Durable Object behavior | Not a customer-operated substrate | Control implementation |
| Automerge Repo | Useful storage/network adapters and concurrent repository plumbing | Does not provide nteract ACLs, room authority, runtime documents, artifact policy, or product APIs | Ingredient / desk evaluation |
| Restate | Durable execution and self-hosting comparison | Process-oriented rewrite and separate cluster; source license is not an OSI production baseline | Landscape only |

Rivet's public documentation describes actor lifecycle and sleeping, with
[WebSocket hibernation](https://rivet.dev/actors/docs/websocket-handler/) marked
beta. Its [filesystem self-hosting](https://rivet.dev/docs/self-hosting/filesystem/)
path is production-oriented for a single node, while the multi-node Postgres
path is documented as experimental. That makes it a useful operational
contrast, not an assumed production winner.

[Automerge Repo](https://automerge.org/docs/reference/repositories/) supplies a
repository abstraction with storage and networking adapters. It can be an
implementation ingredient, but adopting it does not remove nteract's room,
identity, authorization, runtime-state, comments/comms, artifact, or API
responsibilities.

Restate remains a landscape comparison. Its current repository license is
[Business Source License 1.1](https://github.com/restatedev/restate/blob/main/LICENSE),
and its durable-execution service shape would require a larger rewrite than an
entity-shaped room host. Either fact is enough to keep it out of the initial
implementation finalists.

## Shared Black-box Contract

Run the same artifact and scenarios against the Cloudflare control and each
finalist:

1. Start one service that hosts multiple named rooms.
2. Create a notebook as an authenticated owner.
3. Grant a second principal editor access and a third principal viewer access.
4. Connect two editors over typed-frame v4 WebSockets and converge concurrent
   changes.
5. Prove the viewer receives changes but cannot alter the authoritative
   document.
6. Checkpoint every room document, terminate the owner, recover elsewhere, and
   reopen the acknowledged state.
7. Terminate a node during an active session and verify bounded reconnect and
   convergence.
8. Reject stale, malformed, oversized, unauthorized, and cross-room frames.
9. Store and resolve notebook artifacts through the S3-compatible application
   store.
10. Export and import without changing notebook IDs, document schemas, blob
    references, or the wire protocol.

The harness builds the actual pnpm workspace once. It records candidate
version, source commit, configuration hash, artifact hashes, scenario timings,
recovery results, and logs. Candidate launchers may adapt deployment metadata;
they may not replace the Worker artifact with an isolated source copy.

## Hard Gates

A candidate is removed regardless of score if it cannot:

- run entirely in the operator-controlled deployment;
- keep operator and peer-management endpoints off the public network;
- use operator-owned S3-compatible storage with an acceptable workload
  credential boundary;
- preserve typed-frame v4 and current Automerge document semantics;
- enforce owner/editor/viewer authority at connection and mutation boundaries;
- recover acknowledged edits after process and node loss;
- provide repeatable backup/export/restore; or
- meet acceptable production and source licensing terms.

## Scoring After Gates

Score passing candidates from 1 to 5:

| Dimension | Weight |
| --- | ---: |
| Correctness and recovery | 30% |
| Security and tenant isolation | 25% |
| Operability, upgrades, and observability | 20% |
| Implementation reuse and delivery risk | 15% |
| Portability and upstreamability | 10% |
| Infrastructure cost | 0% |

Production viability breaks ties. Keep raw evidence, failures, and unresolved
risks alongside the score; a weighted number must not hide a failed gate.

## Current CellD Evidence

The first CellD 0.3 proof now runs the current Worker rather than the isolated
copy attempted in the closed spike. It has demonstrated:

- all current Durable Object classes, D1 migrations, assets, and the compiled
  `runtimed-wasm` module in one deployment;
- separate fleet and application-data buckets and identities;
- multiple notebook rooms in one service;
- owner/editor/viewer grants and an ungranted-principal downgrade;
- real Automerge convergence and actor attribution;
- an authoritative document unchanged by a viewer-local mutation;
- malformed frame rejection;
- process-death recovery after stale-owner fencing and lease expiry;
- same-ID reopen with the acknowledged content; and
- cross-node ingress to a room owned by another node; and
- forced loss of an owning process during a two-editor session, followed by
  takeover on the second node, recovery of the durably acknowledged source,
  and convergence of a new edit. The first repeatable local run reconnected in
  9.85 seconds.

The proof also found two portability seams worth keeping upstream:

1. object storage belongs behind `NotebookObjectStore`, with R2 and S3
   adapters; and
2. `runtimed-wasm` must remain a static compiled-module import, rather than an
   inlined byte array or a runtime dynamic import.

This evidence is sufficient to keep CellD in the benchmark and passes the
first active-failover correctness scenario. It is not sufficient to pass the
security, backup, workload-identity, repeated-churn, or production-operations
gates.

## Native Rust Proof Boundary

The Rust candidate should not port the Worker line by line. Its smallest useful
proof is:

- one actor task per live room;
- existing `notebook-wire`, `notebook-protocol`,
  `notebook-cloud-transport`, and `runtimed-wasm::RoomHostHandle` behavior;
- Postgres catalog and ACL records;
- S3-compatible checkpoints and blobs; and
- the same public routes and typed-frame contract.

The proof should reuse Worker behavior as acceptance tests while avoiding a
broad cross-host abstraction. Channels own actor access; do not make peer tasks
share the room documents through a general-purpose lock.

## Rivet Proof Boundary

The Rivet proof should use one actor per notebook, keep ACL/catalog state
outside actor memory, and store portable snapshots in the application bucket.
Run both the supported single-node configuration and the documented multi-node
configuration. WebSocket hibernation and control-plane failure must be tested,
not inferred from the actor API.

## Decision Sequence

1. Complete the Cloudflare control result bundle.
2. Finish the CellD hard-gate matrix, including backup/export and active-node
   loss.
3. Implement the minimal Rust and Rivet proofs against the same contract.
4. Publish raw results and gate failures.
5. Score only candidates that passed every gate.
6. Select the production-viable winner.
7. Write a public ADR and a mergeable implementation plan.

Until step 6, existing architecture documents remain evidence and constraints;
none of them is permission to call a candidate selected.
