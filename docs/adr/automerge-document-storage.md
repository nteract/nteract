# Automerge Document Storage and Durable Acceptance

**Status:** In progress, 2026-08-25.

Related:

- [Room Source Lifecycle and File-Backed Recovery](./room-source-lifecycle-and-file-recovery.md)
- [Local-First Notebook State](./local-first-notebook-state.md)
- [Identity and Trust](./identity-and-trust.md)
- [Hosted Room Authorization](./hosted-room-authorization.md)
- [Blob Storage and Content Addressing](./blob-storage-and-content-addressing.md)

## Context

`NotebookDoc` is the canonical notebook state, while `.ipynb` is an external
checkpoint. The daemon must durably retain accepted Automerge heads before it
acknowledges their author, even when the next `.ipynb` export has not happened.

The first implementation met that contract with a per-room append-only recovery
journal. Every committed record repeated a complete Automerge snapshot beside
file-projection metadata. A legacy debounced `.automerge` mirror remained in
parallel. This preserved acknowledged work, but it made nteract own a custom
document repository, a projection write-ahead log, and a compatibility mirror
as one coupled subsystem. It also duplicated unbounded staged-source and
peer-change hash vectors in recovery metadata before manifest version 2
replaced those vectors with bounded counts. `durable_heads` and
`exported_heads` remain the causal checkpoints; the counts are diagnostic
evidence only.

Automerge repositories conventionally persist immutable incremental chunks and
periodic snapshots under a document identifier. Snapshot keys identify their
causal heads; incremental keys identify immutable change content. Loading merges
all available chunks. Compaction publishes a new snapshot before deleting only
chunks known to be covered by it. This storage convention is independent of
network topology and authorization policy.

## Decision 1: One repository boundary owns durable NotebookDoc bytes

The local `runtimed` daemon routes durable `NotebookDoc` persistence through one
`AutomergeDocumentStore`, initially behind `RoomDurability`. Moving
`RuntimeStateDoc`, `CommsDoc`, and `CommentsDoc` to the same boundary is deferred
until the notebook migration proves the contract. The logical addressing model,
not a public physical schema, follows automerge-repo and samod:

```text
<document-id>/snapshot/<heads-hash>
<document-id>/incremental/<change-or-chunk-hash>
```

The first durable write for a document may be a complete Automerge snapshot.
Subsequent accepted mutations persist only changes not already covered by the
stored heads. Loading applies snapshots first and incremental chunks second,
then verifies that the reconstructed document covers the recorded durable
frontier. Missing dependencies or a frontier mismatch fail closed as a durability
degradation; the daemon never opens a parsed prefix and calls it recovered.

A transitional backend may commit a complete snapshot for each frontier while
the store boundary, crash semantics, and migration are proven. Incremental
chunks and compaction are later optimizations. They must never weaken the
acknowledgment contract or create two writable authorities.

When the adapter has transactions, compaction atomically publishes a full
snapshot keyed by its heads and removes only source chunks represented by that
snapshot. An adapter without a shared transaction must commit the new snapshot
before a separate prune. A crash may leave extra chunks, but it must not leave
the document without a complete recovery path.

The storage adapter is SQLite initially. `runtimed` already ships SQLite, and a
transaction gives the daemon one explicit commit boundary for document chunks,
durable heads, and room recovery metadata. The schema preserves the upstream
logical key space even though the physical adapter is not a directory tree.
Stable storage means the SQLite commit completed under durability settings that
survive process and machine failure; WAL buffering or a later checkpoint is not
the acknowledgment boundary. Tests inject write, sync, commit, and process
failures around that boundary.

One logical repository does not require one process-wide connection mutex or
one physical database. SQLite serializes writers even in WAL mode, so production
activation must measure acknowledgment tail latency across concurrent rooms and
choose the connection and sharding unit deliberately. Reads should not inherit a
global lock merely because the first adapter uses SQLite.

## Decision 2: nteract keeps a stronger acknowledgment contract

Upstream repositories generally schedule persistence and synchronization as
independent asynchronous effects. nteract does not adopt that acknowledgment
behavior.

For every change-bearing ingress path:

1. authorize the source of the mutation: validate the connection's actor and
   capability for peer ingress, or the daemon/source authority for internal
   ingress;
2. apply the accepted changes to a guarded document candidate;
3. commit the new chunks and durable frontier to stable local storage;
4. only then publish the mutation to other peers or return a sync response that
   acknowledges it.

Storage failure rolls back the live document and connection sync state, leaves
the room resident, and moves it to an explicit degraded durability state. Group
commit is allowed only when every included author waits for the same durable
commit.

`await_durable(required_heads)` remains a causal barrier. It does not become a
debounce, a shutdown-only flush, or a timestamp comparison.

This acknowledgment contract is scoped to the local daemon in this decision.
The hosted WebAssembly room host has a different storage adapter and lifecycle;
claiming the same guarantee there requires its own durable-before-fan-out design
and tests rather than silently treating a local SQLite trait as portable.

## Decision 3: Storage does not grant authority

Automerge convergence answers whether valid changes can merge. It does not
answer whether a principal may author those changes in an nteract room.

nteract remains hub-and-spoke at its authorization boundary:

- every connection has a validated principal, operator, role, and capability
  scope;
- the room host validates change actors and stream-specific mutation authority
  before durable acceptance;
- regular clients cannot author daemon-owned `RuntimeStateDoc` facts;
- comment, comm, runtime-agent, and notebook streams retain their distinct
  policies even if they later share the same storage adapter; and
- stored Automerge bytes are inert data on load, not evidence that their author
  is currently authorized.

Per-peer Automerge sync state is session optimization, not document truth. The
daemon does not persist or reuse it across authenticated sessions. Reconnection
may preserve a document handle, but a new connection receives fresh sync state
and passes current authorization again.

## Decision 4: File projection recovery is separate metadata

The `.ipynb` relationship remains nteract-specific. Repository storage owns
Automerge bytes and their durable frontier. Projection recovery metadata owns:

- local notebook identity and canonical path binding;
- `NotebookDoc` schema version and a monotonic save sequence;
- source fingerprint and source generation;
- source lifecycle phase and bounded staged-source and peer-change counts;
- `exported_heads` represented by the committed `.ipynb` bytes; and
- pending file-checkpoint intent needed to resolve a crash around atomic file
  replacement.

Document chunks and projection metadata commit in one database transaction when
an operation changes both. The external `.ipynb` replacement remains a
two-phase operation: commit intent, durably replace the file, then commit the
observed result. Divergent file and repository histories remain preserved as an
explicit source conflict.

The projection record never enumerates the document's full change history.
Heads express causal coverage; counts are diagnostic evidence only.

## Decision 5: Binary outputs remain in the blob store

The Automerge repository does not absorb output and attachment blobs.
`NotebookDoc`, `RuntimeStateDoc`, and related documents retain content-addressed
references while the blob store owns the referenced bytes. Repository chunks
are internal Automerge persistence objects with different lifecycle,
enumeration, transaction, and authorization requirements.

The stores may share atomic-file or hashing utilities, but one is not an alias
for the other.

Blob garbage collection reconstructs a durable materialized `NotebookDoc` for
inactive repository records and enumerates its live content references. Failure
to load or validate any potentially relevant document prevents sweeping blobs
that could be referenced by it in that sweep. Historical repository chunks are
not individually treated as blob roots once a valid durable frontier is
materialized.

## Operational diagnostics

Submitted diagnostics do not currently include journal or repository inventory;
adding redacted repository health is part of this migration. Health includes
format version, document id, chunk and snapshot counts and bytes, head counts,
projection phase, pending-intent presence, migration status, and integrity
result. Notebook bytes and canonical paths remain excluded unless the user
explicitly submits them. A corrupt authoritative repository generation is
reported as degraded durability and never hidden by loading an older source.

## Migration

Migration is read-through and idempotent:

1. Resolve the notebook id and canonical path, then check for a committed
   repository generation.
2. If a repository generation exists, validate and use it. Corruption is an
   explicit durability failure; never fall back to an older journal or mirror.
3. Only when the repository is absent, migrate the latest valid primary recovery
   journal. Preserve notebook UUID, schema version, source fingerprint,
   `exported_heads`, `durable_heads`, pending checkpoint intent, and `Match`
   conflict state. A JSON sidecar is diagnostic evidence, never authority.
4. Only when both repository and journal are absent, consider the legacy
   `.automerge` mirror for a supported non-ephemeral untitled notebook UUID. A
   mirror is never the authority for a file-backed source.
5. Seed document bytes, durable frontier, projection state, path binding, and a
   migration activation marker atomically.
6. After that commit, only the repository receives new writes. Legacy artifacts
   remain forensic inputs, not a rollback authority.
7. Retain legacy artifacts for a bounded compatibility period. Their eventual
   deletion is a separate observable operation.

Journal discovery and diagnostics remain available during migration. Deletion
of legacy files is a separately observable cleanup step, never part of the
first successful open.

The existing notebook registry remains the path-to-id API during the first
migration slice. Repository-backed path lookup may replace its filesystem
journal scan only after store rollout proves the binding and ambiguity rules;
the scan must not become a second identity authority.

Before the legacy `.automerge` mirror stops participating in room eviction,
blob garbage collection must discover content references from repository-backed
documents. Removing the mirror without moving that root scan could collect
blobs still referenced by a closed notebook.

Repository activation also moves exact-head durability barriers to the store.
Mirror enqueue and flush, kernel-teardown emergency save, and eviction-time
mirror persistence remain until repository-backed restart, eviction, shutdown,
promotion, and garbage-collection cases cover their recovery responsibilities.

## Invariants

1. Acknowledged heads survive daemon restart without requiring a successful
   `.ipynb` export.
2. Authorization succeeds before document mutation becomes durable or visible.
3. Durable Automerge history is represented by immutable chunks and heads, not
   an ever-growing metadata list.
4. Compaction can leak obsolete chunks after a crash but cannot delete the only
   recovery path.
5. `durable_heads` and the chunks that cover them commit atomically.
6. `exported_heads` advance only after durable external file replacement.
7. Sync state is connection-local and never substitutes for document truth or
   authorization.
8. Legacy migration is repeatable and never destroys its source during open.
9. If a repository generation exists but is invalid, opening reports a
   durability failure and does not fall back to legacy state.
10. Blob collection cannot sweep until live references for every potentially
    relevant durable frontier have been enumerated successfully.
11. Migration and compaction are idempotent; activation marker, chunks, and
    durable frontier commit atomically.

## Rejected alternatives

- **Adopt automerge-repo or samod acknowledgment behavior wholesale.** Rejected
  because their asynchronous storage model does not provide nteract's stable
  storage before acknowledgment guarantee.
- **Use the output blob store as the document repository.** Rejected because it
  lacks per-document enumeration, an atomic frontier-and-projection transaction,
  and compaction reachability for Automerge chunks.
- **Keep full snapshots in an append-only journal indefinitely.** Rejected
  because every edit rewrites document history and couples document persistence
  to file-projection recovery.
- **Persist authorized sync state and replay it for a later connection.**
  Rejected because peer sync state is session-local and can cross principal or
  policy boundaries incorrectly.
- **Treat `.ipynb` as the repository record.** Rejected because nbformat cannot
  retain unexported Automerge history or concurrent causal branches.

## Done

- Recovery manifest version 2 summarizes causal coverage with heads and bounded
  counts.
- The current peer-ingress path durably commits before acknowledgment and rolls
  back document plus sync state on failure.
- The storage contract has a strict SQLite implementation with immutable,
  head-addressed snapshots, content-addressed incrementals, atomic application
  state, explicit schema admission, and transactional compaction.
- Network-authored notebook changes cross a typed admission boundary before
  they can reach durability. This changes no room authorization policy; it
  makes the existing policy structurally harder to bypass.
- Versioned notebook application state preserves projection and activation
  metadata without duplicating the store-owned sequence or causal frontier.

This foundational slice changes no authorization policy, save, eviction, or
legacy-authority behavior.

## Next

- Add corruption handling and idempotent journal and untitled-mirror migration
  with an atomic activation marker, preserving conflicts and checkpoints.
- Activate repository-backed `RoomDurability` with rollback and pre-acknowledge
  failure tests.
- Add incremental chunks and compaction, then split projection metadata from
  document records.
- Move blob-GC root enumeration and redacted diagnostics to the repository.
- Remove mirror paths only after untitled restart, promotion, eviction,
  shutdown, garbage-collection, and migration tests pass. Retire the journal
  only after its compatibility period.

Verification is semantic rather than schema-only: restart recovery, exact-head
barriers, authorization rejection, commit-failure rollback, migration
idempotence, corruption refusal, file-checkpoint crash windows, eviction,
shutdown, and blob reachability are release gates. The non-negotiable test is:
if an author received an acknowledgment, restart reconstructs those heads.
