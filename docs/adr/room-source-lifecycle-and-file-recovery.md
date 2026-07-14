# Room Source Lifecycle and File-Backed Recovery

**Status:** Accepted, 2026-07-13.

Related:

- [Local-First Notebook State](./local-first-notebook-state.md)
- [Notebook Schema Evolution and the Frozen Genesis](./schema-evolution-and-genesis.md)
- [MCP Session Lifecycle and Daemon Supervision](./mcp-session-lifecycle.md)
- [Notebook Identity and Path Binding](./notebook-identity-and-path-binding.md)
- [Automerge Fork Patches](../memos/automerge-fork-patches.md)

## Context

A daemon room has to reconcile three representations of one notebook:

1. the `.ipynb` file users exchange and inspect;
2. the live Automerge `NotebookDoc` shared by humans, kernels, and agents; and
3. recovery state that must survive a crash before the next successful
   `.ipynb` export.

Treating the file as the only durable copy loses accepted peer edits between
exports. Treating an Automerge mirror as a replaceable import cache has the
same failure mode after a failed load or room reaping. Conversely, treating a
stale mirror as unconditionally authoritative can overwrite an externally
edited `.ipynb` file.

Cold loading was also coupled to the first attaching peer. That made peer
delivery part of room creation, allowed a room to be visible before any task
owned its non-terminal load state, and encouraged clients to use one broad
"ready" boolean for source loading, document sync, and runtime readiness.

The room needs a durable source lifecycle of its own. Client sessions observe
that lifecycle but do not own it.

## Decision 1: Source state and room availability are separate axes

Every source generation has a `RoomSourceState`:

| State | Meaning |
| --- | --- |
| `Preparing` | The room is reading, parsing, resolving assets, and producing a staged Automerge change stream. |
| `Publishing` | Durable staged changes are being applied to the live document in bounded batches. |
| `Ready` | The generation's staged changes have been durably published. |
| `Failed` | The generation ended with a structured error and retry information. |

Every state carries the generation, source identity and content fingerprint,
progress, and its most recent transition time. `Failed` is terminal for that
generation, not permanently sticky for the room. A retry starts or resumes a
generation according to the recovery rules below.

Separately, every room has a `RoomAvailability`:

| State | Meaning |
| --- | --- |
| `Attached` | Room identity and canonical path, if any, are known. |
| `ProjectionReady` | A bounded, heads-qualified initial projection is available. |
| `Interactive` | The live document is ready for normal user-facing reads and mutations. |
| `Degraded` | A usable document or projection remains available, but a source, journal, conflict, or sync failure restricts capabilities; the state records the highest safe milestone retained. |

Availability carries the relevant document heads, projection completeness,
and explicit read, mutate, and execute capabilities. The axes are independent:
a failed source generation may leave a durable room `Degraded`, and a source
may be `Ready` while journal or peer-sync failure makes the room `Degraded`.
`Degraded` with a retained projection satisfies projection reads but does not
implicitly permit mutation or execution.
Waiters observe bounded state transitions and receive the current structured
state on timeout or failure; they do not wait indefinitely for a boolean.

## Decision 2: The room owns an immutable staged import

A room is never published in a non-terminal source state without a claimed
source-task lease. Registry insertion and lease ownership are one logical
operation. If the task is cancelled, aborted, or panics, dropping the lease
transitions its generation to `Failed` and wakes all waiters.

Cold import has two phases:

1. **Prepare.** Read and parse the source, resolve blobs and assets, and build a
   bounded projection outside the live document lock. Starting from the
   canonical frozen genesis, author an immutable sequence of Automerge changes
   with a generation-owned actor.
2. **Publish.** Persist each staged batch and its change hashes, then apply
   those exact changes to the room document and notify peers. Publishing uses
   short document mutations and yields between bounded batches.

The immutable hashes make replay idempotent. Retrying a partial publication
applies the same changes rather than generating a second import. Peer-authored
changes may arrive while publication is in progress; Automerge merges them
because both histories descend from the canonical genesis. Source failure does
not justify rolling the room back over peer-authored history.

The initial projection is a generation-owned artifact, not a cache of guessed
authority. It records document heads, schema version, completeness, stable cell
IDs, cell types, and bounded previews. Projection construction uses narrow
accessors and must not clone full cell sources or assets merely to truncate
them afterward.

The room reaches `ProjectionReady` only after the immutable staged stream, its
change hashes, and the matching projection are durable. The projection heads
name that staged document revision; while source state is `Publishing`, the live
room may still be applying toward those heads. Interactive local operations
therefore wait for the room and peer to cover the required heads.

## Decision 3: The recovery journal is the durable acceptance boundary

File-backed rooms keep an append-only Automerge recovery journal. Complete
batches become visible through an atomic manifest/marker that records at least:

- notebook identity and canonical path binding;
- source fingerprint and journal schema version;
- source generation and staged change hashes;
- `durable_heads`, whose changes are recoverable after restart; and
- `exported_heads`, whose snapshot has been committed to the `.ipynb` file.

Source and peer changes become room-visible only after the corresponding
journal batch is durable. Group commit is allowed, but success acknowledgements
wait for the durable marker. `await_durable(required_heads)` is therefore a
causal barrier, not a timer or "last saved" timestamp.

Room reaping and clean daemon shutdown require that barrier for the room's
current heads. A journal failure leaves the room resident and changes
availability to `Degraded`; it cannot silently evict acknowledged work.
Reaping snapshots the heads, awaits their durability, then revalidates peer
count, room generation, and current heads before removal.

The journal is recovery state, not a replacement user file. `.ipynb` remains
the user-visible exported representation. Automerge remains the live document
model and the only representation that can retain unexported causal history.

## Decision 4: File saves advance a causal checkpoint

A `FileCheckpoint` records path, exported heads, source fingerprint, ordered
save sequence, and commit time. A file save snapshots the document at specific
Automerge heads, writes and flushes a temporary file, and atomically replaces
the target. Only then may the room advance the checkpoint's `exported_heads`
and emit a saved event.

`SaveOutcome` distinguishes:

- `Saved`, with path, exported heads, source fingerprint, and timestamp;
- `AlreadyCurrent`, with the same checkpoint facts; and
- `Blocked`, with a structured reason and the heads still safe in the journal.

Concurrent saves receive an ordered save sequence. A completion from an older
sequence cannot regress the exported checkpoint. `last_saved` may remain as
display metadata, but it is updated only after a committed file checkpoint and
is never the dirty-state source of truth.

## Decision 5: Recovery preserves both sides of a conflict

On room creation or daemon restart:

- If the journal's file fingerprint matches the current file, restore the
  journal and resume the exact staged generation.
- If no journal exists, import the `.ipynb` file into a new generation.
- If staged publication was partial, resume its recorded change hashes even
  when peer-authored changes have joined the room.
- Regenerate an import only when no peer-authored changes exist beyond its
  known base.
- If the journal and current file fingerprints diverge, preserve both and mark
  the room `Degraded` with a `source_conflict`. Never silently prefer either.

File-watcher changes use the same fingerprint comparison. Conflict recovery is
explicit: save recovered state to another path, deliberately export recovered
state over the source, or archive the journal and deliberately reload disk.

## Decision 6: Progressive clients use capability gates

The desktop UI and MCP mutation tools remain read-only until room availability
is `Interactive`. This is product policy, not a restriction on Automerge:
low-level peer sync continues to accept and journal concurrent or offline
changes while the source is loading.

`connect_notebook` remains one call and returns after projection readiness,
either `ProjectionReady` or `Degraded` with a retained projection, with stable
cell IDs and the projection heads. Session activation, local NotebookDoc
convergence, RuntimeStateDoc convergence, and runtime readiness continue in the
background. Later operations use the narrowest gate they need:

- daemon projection reads require `ProjectionReady`;
- local CRDT reads and mutations require `Interactive` and the relevant heads;
- execution additionally requires runtime readiness and preserves
  `required_heads` ordering.

Session generations prevent a stale async connect from installing or operating
on a superseded target. Concurrent connects for the same normalized target
share one attach/projection operation. Failure is structured as
`notebook_not_ready`, `source_degraded`, `source_conflict`,
`session_superseded`, or `sync_failed`, not collapsed into a generic timeout.

## Decision 7: Subduction is guidance, not a production dependency

The draft [`automerge-repo` Subduction
work](https://github.com/automerge/automerge-repo/pull/601) is useful evidence
for source-owned lifecycle, initialization versus running, concurrent storage
merge, causal saved heads, surfaced flush failures, attach-storm handling, and
shutdown-race tests. We adopt those semantics where they fit this room model
and encode them in nteract conformance tests.

Production does not depend on the draft Subduction branch or its unstable API.
Fork maintenance, upstreaming the stale-orphan sync correction, and evaluating
future released `automerge-repo` APIs remain separate delivery work.

## Invariants

1. Every non-terminal source generation has one room-owned task lease.
2. Source state never stands in for room availability or peer-sync readiness.
3. Published imports replay immutable, durably recorded Automerge changes.
4. Acknowledged changes are covered by `durable_heads` before eviction or clean
   shutdown.
5. File save success means `exported_heads` advanced after atomic replacement.
6. Disk/journal divergence preserves both histories and becomes an explicit
   conflict.
7. User-facing mutation waits for `Interactive`; Automerge sync itself remains
   local-first during loading.
8. Progressive MCP connection never converts a source or sync failure into
   cached success.

## Rejected alternatives

- **Keep failed-load save as a successful no-op.** Rejected because it advances
  user-visible save state without making work durable.
- **Delete file-backed Automerge state on reaping.** Rejected because accepted
  heads may not yet be represented in `.ipynb`.
- **Block all Automerge writes until import completes.** Rejected because it
  turns a product editability gate into a server limitation and gives up the
  local-first merge model.
- **Always prefer the journal or always prefer disk after divergence.** Rejected
  because either rule silently destroys one side of an externally observable
  conflict.
- **Adopt draft Subduction directly.** Rejected until its upstream API and
  storage contract stabilize.
