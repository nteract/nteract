# Pages Automerge persistence measurements

**Status:** Local application measurements, 2026-10-17. No production storage change.

The [Pages design](../memos/celld-pages.md#persistence-closer-to-the-primitives)
proposes incremental persistence, retaining one authoritative celld storage path.
This experiment measures that proposal's Automerge encoding component and the
metadata that would remain if only document serialization changed. It does not
measure S3/R2 traffic or qualify a new durability adapter.

## Reproduction and scope

```bash
pnpm install --frozen-lockfile
pnpm --dir apps/pages probe:storage > /tmp/pages-storage.json
pnpm --dir apps/pages test
pnpm --dir apps/pages typecheck
```

The [probe](../../apps/pages/scripts/storage-probe.mjs) uses generated data and
`PagesWorkspace` with an in-memory implementation of its storage interface. It
makes no network calls and reads no credentials or existing Pages. Each workload
starts with 96 rich-text blocks, each containing six distinct generated hash
paragraphs, a heading, and Unicode text. It commits 160 operations:

- **Typing:** one admitted browser actor, one sync commit per character edit;
  nine insertions followed by a code-point backspace, including emoji and CJK.
  This deliberately does not batch multiple keystrokes into one commit.
- **Semantic edits:** guarded `patch_page` replacements of a revision phrase in
  one rich block. The service allocates an actor and stores a receipt per call.
- **Comments:** 40 cycles of selection-anchored add, reply, resolve, and reopen.
  Content, comment targets and author identities share the same document.

The probe captures committed full records through the real operation and sync
admission paths, then replays the same snapshots under each encoding policy.
Three repetitions rotate policy order; each reports encoding CPU and elapsed
time, plus five final-record recovery samples. Fixture creation, rich-text
projection, admission, metadata serialization, loading captured snapshots,
assertions, and simulated restart before compaction are outside encoding timings.
This isolates serialization; it is not an end-to-end service latency benchmark.
Encoding runs on loaded committed snapshots, not dirty live documents; internal
cache behavior may differ from production. Recovery is an in-memory decode,
with no disk or network I/O.

| Policy | Write policy | Retained recovery data |
| --- | --- | --- |
| Snapshot | `save()` after every commit | Latest snapshot |
| Incremental | `saveSince(previousDurableHeads)` after every commit | Initial snapshot plus every chunk |
| Checkpoint | Incremental plus `save()` after 64 chunks or 64 KiB of tail | Latest snapshot plus subsequent chunks |

The threshold is illustrative, not a tuned recommendation. The byte threshold is
checked after a commit and can overshoot by one admitted chunk. All policies count
the initial snapshot. Checkpoint totals include both the threshold-triggering
increment and the new snapshot; they do not assume the increment can be skipped.
Metadata and catalog writes remain identical across policies. Their Node V8
serialization size is reported separately, excluding the common initial creation
write, storage key names, incremental manifests, and row framing. No policy writes
one growing array of chunks back to storage; the array is only a recovery model.

## Results and recommendation

Measured against Pages at `9b0de120895cb416568c153e6cc16bb8271043e9`, with
this probe, Node v22.23.1, Automerge 3.4.1,
macOS arm64 / Apple M3 Max. The full run took about nine minutes.
[Raw samples](./pages-automerge-storage-baseline.json) retain every repetition.
Byte totals below use decimal kB, not KiB.

| Workload | Full snapshot writes, kB | Incremental writes, kB | Checkpoint writes, kB | Unchanged metadata/catalog, kB | Combined reduction with checkpoint |
| --- | ---: | ---: | ---: | ---: | ---: |
| typing | 6555.6 | 66.4 | 147.9 | 25905.3 | 19.7% |
| semantic | 7047.8 | 78.7 | 167.5 | 31560.0 | 17.8% |
| comments | 8368.4 | 127.7 | 235.8 | 49882.2 | 14.0% |

Checkpointed increments reduce Automerge write payload by **35–44 times**, but
only reduce the combined modeled payload by **14–20%** while the existing record
metadata remains unchanged. In `workspace.ts`, the creation receipt retains the
full creation result inside every subsequently rewritten Page record. Semantic
and comment commits also rewrite the retained receipt map and event window;
comment receipts include projected threads. These costs dwarf the remaining
incremental document bytes in this fixture.

The next adapter should separate the immutable creation receipt, individual
bounded operation receipts/events, and catalog projections from document chunks,
while committing all facts required for acceptance atomically. Merely swapping
`save()` for incremental bytes inside the same growing aggregate record misses
the larger source of amplification. The figures above do not measure that
metadata redesign, nor SQLite's physical page reuse or LTX compression.

| Workload | Policy | Encoding CPU total, ms | Encoding elapsed total, ms | Final restore median, ms |
| --- | --- | ---: | ---: | ---: |
| typing | snapshot | 328.0 | 327.5 | 62.1 |
| typing | incremental | 10.0 | 10.7 | 96.3 |
| typing | checkpoint | 14.5 | 14.1 | 66.7 |
| semantic | snapshot | 327.0 | 327.0 | 60.4 |
| semantic | incremental | 7.9 | 8.3 | 111.8 |
| semantic | checkpoint | 13.5 | 14.0 | 71.3 |
| comments | snapshot | 373.7 | 373.3 | 68.0 |
| comments | incremental | 15.6 | 16.1 | 137.9 |
| comments | checkpoint | 20.5 | 20.9 | 86.1 |

Encoding totals are the median of three repetitions (160 writes, plus two
checkpoint saves where applicable). Restore values are the median of each
repetition's five-sample median. Timings are illustrative on a shared workstation,
not a controlled performance regression threshold. Checkpoint restore stayed
closer to full-snapshot decode than an unbounded tail; it did not beat loading
only the final full snapshot. No claim about total edit CPU follows because
projection, admission and repeated loads were excluded from these timings.

All three checkpoint workloads triggered twice at 64 chunks and ended with 32
chunks; the 64 KiB condition did not trigger in these fixtures. Peak tail bytes
before checkpoint were 10,364 / 15,400 / 34,926 for typing / semantic / comments.
Final retained snapshot-plus-tail bytes were 46,006 / 53,492 / 75,665, versus
40,835 / 47,061 / 62,614 for full snapshots. Every policy retained 162 Automerge
changes, including initialization. The extra tail trades a little retained size
and restore work for fewer rewritten bytes.

Whole-probe peak RSS was 659.7 MiB. This includes all captured fixture records,
Node, WASM allocations and recovery assertions; it is **not** a per-document
working set or evidence of a memory improvement. A warm-document cache needs its
own eviction/load benchmark and hard memory budget before production adoption.

## Recovery and history boundaries

The [measurement model](../../apps/pages/scripts/storage-model.mjs) reconstructs
from snapshot plus chunks, checks the durable frontier, and compares materialized
content and every change hash with the original document. Tests cover missing
chunks, truncated data, concurrent branches, cursor/text-object identity,
restart before compaction, duplicate covered chunks after publication but before
pruning, and edits arriving after a checkpoint's covered frontier. The latter
must survive pruning; deleting all chunks indiscriminately fails the test.

These are algorithmic crash-boundary simulations, not celld process-kill tests.
They assume atomic publication of the checkpoint/frontier and atomic acceptance
of each chunk with its metadata. They do not prove runtime transaction fencing,
output gates, failed/uncertain commit rollback, or remote replication durability.

After 160 commits the real service retains 128 change events and, for semantic
and comment workloads, 128 edit receipts plus the creation receipt. Asking for
changes from sequence zero requires resync. Those windows are bounded; the
Automerge change history is not. All policies retain every admitted change.
`save()` compresses history but does not garbage-collect it. Replacing a document
with a fresh projection would discard causal ancestry, author operations, stable
cursors, and compatibility with offline replicas; that is a separate product and
migration decision, not checkpointing.

## Runtime boundary and next implementation

Source inspection used celld **v0.6.1** (`f2bf648663a610eefde71f3547ad61e9b896b1f0`):
[`serialize_storage_value`](https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/js/storage_ops.rs#L1009)
serializes values with V8, retaining the supported wire version;
[`storage.rs`](https://github.com/denoland/celld/blob/f2bf648663a610eefde71f3547ad61e9b896b1f0/crates/celld/storage.rs#L442)
uses SQLite WAL and explicitly distinguishes local process recovery from the
LTX replication boundary for node loss. Node's serializer is useful for payload
scale but is not an exact measurement of that runtime or its bucket writes.

The next production slice should implement a small runtime-owned storage adapter
with immutable chunks, an explicit durable frontier, receipts, and bounded event
metadata committed together. Use explicit heads rather than relying on an
in-memory `saveIncremental()` cursor surviving eviction. Snapshot publication and
pruning must retain chunks committed after the captured frontier. Reuse the
[AutomergeDocumentStore contract](../adr/automerge-document-storage.md), not its
standalone SQLite connection inside celld.

Before enabling it, compare warm and cold workloads on pinned celld with equal
remote durability settings, recording commit p50/p95, CPU, resident memory,
SQLite/LTX bytes, and S3 or R2 requests/bytes. Inject process failure before and
after the durability acknowledgment and throughout checkpoint publication/prune.
Verify exact heads, receipts, comments and authors after restart; run an offline
replica merge across the checkpoint. Until that exists, these measurements cannot
establish a cloud bill reduction or justify a second application-level S3 writer.
