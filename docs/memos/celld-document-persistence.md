# Measured simplification of hosted document checkpoints

**Status:** Proposal with a compatible first slice and an isolated storage probe, 2026-10-17.
Probe baseline (v6 KV): `655b66d89a841953925d58ca38b4daa75c29ec17`.
Implementation base (v7 objects, #4441): `974ca988303a3800fb5fde1dbe574323cf6abce6`.

## Recommendation

Apply head-based serialization suppression to the v7 object checkpoint path.
Keep all four immutable body references in the manifest, upload changed bodies
before committing it, and preserve integrity checks and fail-closed recovery.
Compare causal heads before serializing; skip an identical checkpoint when the
documents, publication metadata, and references are unchanged. Only reuse a
checkpoint successfully written by this activation whose metadata still matches
storage. Fresh activation and recovery serialize all four documents; committed
hashes can still avoid redundant object uploads. Failed writes do not advance
the saved frontier.

This removes unnecessary serialization, hashing, and manifest writes without
changing the v7 format. It does not remove the full save/upload of a changed
document or bound retained immutable objects. The measurements below compare
historical v6 KV strategies, **not v7 object storage**. They establish neither
v7 latency nor bucket request/cost savings. Incremental persistence remains an
experiment requiring separate qualification.

The Pages experiment motivated the comparison; its source at
`578773171d5752e34a9f0bbf29040f205496d95e` is a reference, not the implementation
base. No private Page content or live deployment data is used here.

## Existing paths and contracts

- [`RoomMaterializer`](../../apps/notebook-cloud/src/room-materializer.ts)
  already caches `RoomHostHandle` in `hostReady` and serializes operations through
  `operationQueue`. Loading once per active room is existing behavior.
- The measured v6 full-snapshot baseline saves all four complete Automerge
  documents, copies their bytes into ArrayBuffers, fetches all four frontiers,
  and writes four records plus metadata. `NotebookRoom` schedules checkpoints
  after changed materialized frames and several compute/lifecycle transitions.
  An execution output burst can change only RuntimeStateDoc while repeatedly
  saving NotebookDoc, CommsDoc, and CommentsDoc. Queued checkpoint requests can
  observe the same final heads; there is no need to write each identical set.
- [`NotebookRoom`](../../apps/notebook-cloud/src/notebook-room.ts) delivers
  materialized frames before its asynchronous checkpoint in the general sync
  path. `waitForNotebookHeads()` tests materialized causal coverage, not a stored
  durable frontier. The daemon's durable-before-fan-out ADR explicitly excludes
  this hosted adapter. Neither this optimization nor a chunk format by itself
  establishes durable-before-acknowledgment for hosted edits or execution.
- Hydration accepts checkpoint versions 2–7, repairs older document shapes, and
  reconciles the seeded published revision. Unpublished checkpoint changes and
  newer legacy checkpoints can take precedence over a different published
  revision. Recoverable Automerge boundary failures can reload a published
  bundle for legacy checkpoints; v7 host recovery preserves the committed object
  generation. Manifest-read failures, future versions, and missing/corrupt v7
  bodies fail closed. The optimization retains these guarantees.
- [`index.ts`](../../apps/notebook-cloud/src/index.ts) publishes immutable
  document snapshots through authorized upload routes; it verifies sidecar
  availability before recording the revision. [`storage.ts`](../../apps/notebook-cloud/src/storage.ts)
  batches the revision/catalog changes. Pinned revisions, portability, catalog
  recovery, output blobs, attachments, and exports have purposes distinct from
  ordinary live-room checkpoints. Selective checkpointing preserves them.
- Browser-local NotebookDoc chunk persistence and the RuntimeStateDoc paint cache
  in [`notebook-persistence.ts`](../../apps/notebook-cloud/viewer/notebook-persistence.ts)
  have separate offline and authority contracts. They are not this server store.

## Atomicity and platform boundaries

The v6 baseline's `Promise.all` is not evidence of non-atomic storage. In celld
**v0.5.1**, `DurableObjectStorage.put` synchronously queues serialized values,
yields a microtask, then flushes the pending batch. `flush_pending_puts` calls
`put_many_serialized`, which uses a SQLite transaction or a savepoint. See
[harness.js](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/js/harness.js),
[storage_ops.rs](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/js/storage_ops.rs),
and [storage.rs](https://github.com/denoland/celld/blob/v0.5.1/crates/celld/storage.rs).
The probe preserves that synchronous batch with no intervening await. The v7
implementation instead uploads immutable objects before one manifest commit;
its bucket durability and rollback requirements are described in
[DEPLOY.md](../../apps/notebook-cloud/DEPLOY.md#room-checkpoint-format-and-rollout).

Cloudflare also documents [automatic atomic write coalescing](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#put).
Its current [limits](https://developers.cloudflare.com/durable-objects/platform/limits/)
distinguish SQLite's 2 MB key/value limit from legacy KV's 128 KiB value limit;
the checked-in NotebookRoom migration uses `new_sqlite_classes`. These limits
must not be inferred from old free-plan workarounds, and neither limit should be
assigned to celld by analogy. This probe does not qualify maximum record size.

On celld, completed local storage operations and configured durability are
different boundaries. `storage.sync()` requests the same durability proof used
by the runtime output gate. The probe waits for it in **every** mode. Production
checkpoint scheduling/acknowledgment behavior is unchanged. Native ownership
and activation-generation fencing remain celld responsibilities; metadata
replacement checks in JavaScript are only defense in depth.

## Reproduce the comparison

Use an isolated checkout, installed locked JS dependencies, Cargo, and an
official celld **0.5.1** binary. The runner binds only loopback and creates new
private `.context` directories. It does not consume cloud credentials or a
remote bucket. It stops only processes it starts and their descendants.

```sh
mkdir -p .context
cargo run --release -p notebook-room-host --example storage_probe > .context/storage-fixture.json
CELLD_PROBE_BIN=/absolute/path/to/celld-0.5.1 node apps/notebook-cloud/scripts/probe-celld-storage.mjs
```

The [Rust fixture generator](../../crates/notebook-room-host/examples/storage_probe.rs)
uses the real four document crates and Automerge 0.12.0: 96 generated code cells,
50 Unicode single-character edits, 50 generated output manifests, 20 paired
widget/comment changes, and 50 unchanged checkpoint attempts. No code executes.
The [runner](../../apps/notebook-cloud/scripts/probe-celld-storage.mjs) measures
three modes with the same generated history and local bucket durability:

1. Full snapshots and metadata for every attempt, using the existing put batch.
2. Only changed snapshots and metadata; unchanged attempts perform no writes.
3. Incremental chunks with a transactional frontier/sequence, compacting each
   document at 32 chunks or 64 KiB of deltas. These are exploratory bounds, not
   tuned production thresholds.

The [probe Worker](../../apps/notebook-cloud/scripts/storage-probe-worker.mjs)
receives only fixture indexes. It is not imported by the application. It
preloads serialized fixture payloads, so HTTP measurements isolate storage and
exclude Automerge serialization/admission. All modes share probe metadata
(sequence and frontiers), not byte-identical production checkpoint metadata.
RSS includes that fixture overhead
and the celld supervisor. CPU comes from coarse process-tree `ps` samples;
it is not per-operation profiling. Rust serialization timings are native,
ordered full-save-before-delta samples, not WASM CPU measurements.

Retained SQLite/WAL/LTX file sizes and local bucket objects are measured, not
physical disk writes, remote requests, or network bytes. Cold restore includes
supervisor start and deployment bundle load after moving the experiment's
runtime cache aside while retaining its local dev bucket. The health check
does not activate or read the document; `firstRestoreMs` separately measures
the first document request after startup. Both warm and cold requests include
hex encoding and HTTP transfer of recovered bytes. Expected snapshot bytes
are added by the runner after timing. Rust independently
checks restored heads, all change hashes (including actors/history), and absent
missing dependencies for all four documents. Warm byte reconstruction excludes
Automerge materialization; neither timing is a production cold-room latency.

The portable measurement report records individual trials; raw local run
directories remain ignored. No savings claim should be made from application
payload ratios alone. The 50 unchanged attempts deliberately exercise
deduplication. Their frequency in real rooms is unmeasured: ordinary unchanged
sync frames do not themselves schedule checkpoints, though queued checkpoints
can observe already-saved heads.

## Local results

[Individual measurements](../measurements/celld-document-storage.json) contain
three sequential trials per mode on an Apple M3 Max, macOS 25.6.0, celld 0.5.1,
two Tokio threads, bucket durability, and the local development bucket. Values
below exclude the seed except retained file size and restore measurements.
Ranges span trials; they are not confidence intervals.

| Measurement | Full snapshots | Changed snapshots | Bounded incrementals |
| --- | ---: | ---: | ---: |
| Application bytes submitted | 2,219,166 | 635,216 | 52,287 |
| Retained bucket LTX growth, bytes | 1,221,848 | 1,083,048 | 643,064–643,069 |
| New LTX objects / successful local bucket puts | 173 / 173 | 123 / 123 | 123 / 123 |
| Process CPU during workload, seconds | 0.57–0.58 | 0.42–0.46 | 0.41–0.48 |
| Sampled peak process-tree RSS, MiB | 144.2–146.4 | 143.1–143.6 | 135.2–146.5 |
| Edit HTTP median per trial, ms | 11.7–12.0 | 11.0–11.7 | 10.8–12.0 |
| Unchanged HTTP median per trial, ms | 10.6–11.8 | 2.12–2.20 | 2.17–2.32 |
| Warm byte reconstruction, ms | 3.05–4.17 | 4.15–4.72 | 6.46–7.40 |
| First document request after cache removal, ms | 219–221 | 206–210 | 209–210 |
| Startup plus first document request, ms | 810–839 | 788–798 | 794–806 |
| Retained SQLite / WAL bytes after workload | 6,230,016 / 234,872 | 6,017,024 / 28,872 | 5,599,232 / 214,272 |
| Additional local bucket puts in 15 seconds idle | 9 | 9 | 7–9 |

Selective snapshots reduced submitted bytes by **71.4%**, but LTX growth by
only **11.4%**. In all three trials, the first 124 LTX objects had identical size
sequences in the full and changed modes. The remaining 50 unchanged full
checkpoints added exactly 138,800 bytes. Thus the measured LTX saving came
entirely from avoiding those attempts; skipping unchanged sidecar writes during
actual edits produced no additional LTX size saving in this fixture.

Selective snapshots still avoid real serialization: native fixture full-save
samples totalled 110.115 ms versus 31.899 ms for changed documents. Delta samples
totalled 1.771 ms, excluding compaction saves. These are one fixture generation,
not repeated WASM benchmarks. The production tests separately prove that
unchanged document serializers are not called.

Incrementals reduced LTX growth a further **40.6%** versus selective snapshots,
including two compactions. They did not reduce successful bucket writes or show
a clear edit-latency advantage. Idle writes persisted in every mode; none added
LTX objects during the short idle window. Local successful puts do not count
remote attempts, retries, reads, or billed operations. No S3 cost estimate or
memory improvement follows from these measurements.

All nine trials recovered the exact heads and complete change history of all
four documents from both warm storage and the retained bucket after runtime
cache removal. The incremental probe also passed transaction rollback,
lost-response retry, concurrent duplicate, sequence-gap rejection, compaction
rollback, paired widget/comment rollback, and native process termination during
an open transaction. Its rollback/idempotency scheme is experimental and is not
connected to production room admission or execution.

The production regressions cover selective notebook/runtime/widget/comment
checkpoints, unchanged serialization, first checkpoints after hydration,
uncertain-write retries, a queued checkpoint across recovery, and full
serialization after v7 recovery.

## Next adapter and release gates

If the next measurements justify incremental storage, use one runtime-owned
adapter with `load`, `commit`, and `compact`. Reuse the invariants from
[`automerge-store`](../../crates/automerge-store/src/lib.rs), not its rusqlite
connection. Commit admitted chunks, exact durable heads, sequence, and required
application metadata/receipts together. Keep each document's identity and
authority separate. The active materialized host is a discardable cache.

Before routing production through it, introduce a candidate/commit/publish
boundary that can restore document **and peer sync state** after failed or
uncertain commits. A failed durability proof must not expose speculative heads
as durable, release execution gates, or replay already executed code/external
effects. Reconcile interrupted runtime work on recovery as today. Do not adopt
the probe's fixture index as a real idempotency/admission scheme.

Compaction must publish a complete historical snapshot and delete only included
chunks atomically. Never discard missing-dependency chunks merely because
`save()` omits unresolved work; reject missing dependencies at admission or
retain/defer compaction using the store contract. Compaction preserves Automerge
history and actors; it is not causal history garbage collection.

Production gates still include authenticated concurrent editors, missing
dependencies, uncertain durability proofs, eviction, deployment/ownership
generation replacement, required-head execution gates, and comment/output/widget
compatibility through the real room ingress. Fixture-level failure tests and
existing room tests do not substitute for that integrated qualification.

## Migration, rollback, and cost evidence

The optimization adds no migration beyond the v7 object format introduced by
#4441. Reverting only this optimization to a v7-capable build restores full
serialization without changing the selected generation. **Do not roll v7 rooms
back to v6 readers**: legacy body keys are not a current backup. Older checkpoint
imports and v7 fail-closed recovery remain covered by the room tests. Deployment
qualification, object retention, and a v7-capable rollback build remain required.

A future incremental migration must import the selected v6 or v7 snapshot set
into one committed generation, retain the legacy input, and distinguish absent
generations from corrupt committed generations. A rollback after new chunk-only
edits needs a verified current full snapshot set, or an older binary must refuse
to open it. Simply retaining a stale pre-migration snapshot is not safe rollback.

Cost reasoning must include active CPU/memory, read/commit/recovery latency,
fleet heartbeat/lease/catalog traffic while idle, uploads and retries, and
retained LTX epochs. Application chunk compaction does not automatically delete
superseded celld epochs. v0.5.1 exposes `CELLD_LTX_RETENTION_SECS`; leaving it unset
does not qualify bounded long-term bucket growth. This task changes no retention.

An optional next remote experiment would use **a new disposable local celld
0.5.1 fleet**, one explicitly approved empty S3 prefix, generated fixtures only,
`CELLD_DURABILITY=bucket`, unchanged output gate and identical settings per mode.
Run three trials per mode plus a 30-minute idle window, cap it at one hour and
100 MiB of generated application data, and record GET/LIST/PUT/DELETE attempts,
retries, bytes, latency, epoch growth, and CPU/RSS. Predeclare retention and
cleanup of that prefix. It needs explicit remote authorization; no shared lab
service, Pages deployment, notebook account, or production runtime is involved.
