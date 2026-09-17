# Runtime writer decomposition

**Status:** Memo, 2026-09-17. Direction for the next structural move. Not a
decision, and not authorization to split the daemon process.

Related:

- [The Document Split](../adr/document-split.md) — the split principle. The
  original three-document count is historical.
- [ADR 0002: CommsDoc](../adr/0002-comms-document-split.md) — rejected shipping
  a further document split as one program.
- [Room source lifecycle and file recovery](../adr/room-source-lifecycle-and-file-recovery.md)
  — the recovery authority. Clients observe it. They do not own it.
- [Runtime principal promotion](../adr/runtime-principal-promotion.md) — still
  Draft. Hosted authority is not settled.
- [MCP session lifecycle](../adr/mcp-session-lifecycle.md) — the agent client
  contract. It is not a second room model.
- [Runtime writer decomposition plan](../plans/runtime-writer-decomposition.md)
  — the sequenced work.

## Diagnosis

The documents already encode authority. The process that writes them does not.

A notebook room syncs four documents: `NotebookDoc`, `RuntimeStateDoc`,
`CommsDoc`, and `CommentsDoc`. `PoolDoc` is daemon-scoped and fanned out. That
split is an authority boundary. Regular clients read runtime state. They do not
author it. Execution names a synced `cell_id`. The `.ipynb` file is a
checkpoint, not the live record.

`runtimed` is still one writer for almost all of that. Room lifecycle, recovery,
save, the environment pool, kernel launch, output commit, and hosted attach
live in the same process, mostly under `crates/runtimed/src/daemon.rs` and
`crates/runtimed/src/notebook_sync_server/`. The crate split around wire,
document schema, and protocol is real. It does not split the writer.

Hosted rooms already stretch the desktop sentence "the daemon owns runtime."
Locally, one daemon writes runtime state. In a hosted room, the room host, the
runtime agent, and a workstation can each write a policy-scoped slice. That
policy exists. It is not a module boundary both hosts are forced to share.

MCP is a peer of the document model, and it is growing client machinery:
handles, parked sessions, subscriptions, request-scoped cancellation. That
machinery has to rejoin a room. It must not become a second room.

## What to decompose

Decompose the writer along the authority lines the documents already have.
Do not add a document to express a boundary the current documents already have.

| Authority | Document | Who may commit | Where the code lives today |
| --- | --- | --- | --- |
| Notebook content | `NotebookDoc` | Editor and owner clients, after ingress checks | WASM peer; daemon ingress in `peer_notebook_sync.rs` |
| Execution intent, path, save, trust, environment, schema and root facts | `RuntimeStateDoc` | Local daemon or hosted room host | `daemon.rs`, `notebook_sync_server/` |
| Accepted runtime progress, outputs, topology | `RuntimeStateDoc` | Runtime peer, policy-scoped | `runtime_agent.rs`, `peer_runtime_sync.rs`, output committers |
| Widget values | `CommsDoc` | Runtime agent and authorized frontend deltas | `peer_comms_sync.rs`, `runtime_agent/` |
| Comments | `CommentsDoc` | Authorized editors; attribution from admitted actors | `peer_comments_sync.rs`, `comments-doc` |
| Pool counters | `PoolDoc` | Daemon only | `warm_env.rs`, `peer_pool_sync.rs` |
| Recovery and file checkpoint | Not a fifth document | Room source lifecycle | `recovery.rs`, `file_checkpoint.rs`, `persist.rs` |

The first extraction is a module boundary inside the current process: coordinator
facts versus runtime progress. Both the local daemon and the hosted room host
must reject the same unauthorized write. A process split is a later decision,
after that shared rejection exists.

## Holds

These are sequencing constraints, not new product decisions.

- No fifth room document. ADR 0002 already rejected shipping a further document
  split as one program. Its gated `NotebookDoc` cells-versus-metadata move stays
  gated.
- No new client surface. MCP handles and subscriptions stay a client of the
  room lifecycle. They do not own recovery, execution intent, or another
  document set.
- `PoolDoc` stays daemon-scoped.
- Do not start a substrate rewrite, a new execution engine, or a new host shell
  as a substitute for this split. Those memos stay research.
  [celld](celld-hosted-room-substrate.md),
  [the AWS room host](aws-rust-room-host.md), and
  [execution engines](execution-engines-and-marimo.md) are not the next move.
- Execute by synced `cell_id`. A client that sends a code string has introduced
  a correctness bug.
- One recovery story. [Room source lifecycle](../adr/room-source-lifecycle-and-file-recovery.md)
  is the authority. Document-split Decision 4 is not.

## Open questions

1. The hosted room host is TypeScript. The daemon policy is Rust. The first
   shared boundary can be a Rust library both call, or a Rust policy with a
   tested TypeScript mirror. Which one can fail closed when the two drift is
   not decided here.
2. A process split may still be right after the module boundary exists. It is
   not the first slice. Shipping it first concentrates failure in process
   supervision instead of in the write policy.
3. [Runtime principal promotion](../adr/runtime-principal-promotion.md) asks
   what a local runtime becomes when it attaches to a hosted room. That ADR
   stays Draft until this writer boundary can name the promoted principal's
   commit rights without a field-level carve-out.

## What would make this an ADR

An ADR is justified after one shared ingress boundary has landed, with a test
that local and hosted reject the same unauthorized write, and after the open
question about Rust-versus-mirror is answered by that implementation. Until
then this memo is the direction, and the plan is the sequence.
