# Upstream integration lane

The maintained [integration fixture](README.md) and [Pages experiment](pages/README.md)
build the two packages at Repo revision
`afec0444191a5a662e065f24193bef58ab07122a`, with Automerge `3.5.0` and
Subduction `0.26.0`. It requires Node >=22.13, Git, and npm.

```sh
npm run setup
npm test
```

Run from this directory. Setup fetches the exact public upstream commit into
`.source-cache`, copies the two packages into ignored `upstream/`, verifies the
backend source hash, applies the explicit patch in `patch-upstream.mjs`, installs
from `package-lock.json` without dependency lifecycle scripts, and builds both
TypeScript packages. `upstream-provenance.json` records the revision and before /
after hashes. Existing dirty source caches are rejected. No canonical upstream
checkout, global installation, or live service is changed.

The test command selects `tsconfig.test.json`, which resolves the production
identity module's `runtimed` capability re-export directly to the real
`packages/runtimed/src/scope-capabilities.ts`. This avoids loading the unrelated
package barrel or relying on a root dependency installation; it does not replace
credential verification. The focused CI job uses the same standalone setup.

The published native version is pinned by `native-version.mjs` in the experiment,
Pages, and the generated Repo adapter manifest; setup overrides the pinned Repo
source's older 0.23.0 dependency before installing. The lockfile contains one
Subduction runtime. Its npm tarball integrity and release WASM SHA-256 are checked
in `native-version.test.mjs` and recorded in setup provenance. The npm SLSA
attestation binds 0.26.0 to upstream tag `subduction-js-v0.26.0`, commit
`dce952aac6d85506eeb0235facbb8132b39bb95c`.

That published build includes upstream fixes for
[fragment ancestry coverage](https://github.com/inkandswitch/subduction/pull/319),
[branch-local minimization and fragment boundaries](https://github.com/inkandswitch/subduction/pull/325),
and [boundary fingerprint advertisement](https://github.com/inkandswitch/subduction/pull/326).
On 0.23.0, a four-commit diamond plus a fragment covering its root incorrectly
omits an uncovered sibling from the native sync set. Real mixed-actor Automerge
histories reproduce missing dependencies without running our compactor. The
regression tests exercise both the minimal graph and a complete multi-actor cold
sync. This is a published upstream repair, not a private WASM fork. The original Page7
qualification used a fresh namespace without upgrading existing deployments;
mixed-version peers and migration of old deployed data are not qualified here.

The authorization patch forwards `policy` and `ephemeralPolicy`
from `SubductionBackend` into the existing native constructor. Published
Subduction 0.23.0 already contains these interfaces; this experiment does not
need a Rust/WASM fork, custom binary, wire-format change, or replacement Repo.
Option properties are retained across native engine resets. The policy bridge
normalizes signing keys and generated Repo document IDs to 32-byte hexadecimal
IDs. Repo 3 reserves native IDs with a zeroed final 16 bytes for short legacy
IDs; the bridge mirrors that normalization and rejects ambiguous long-form ACL
registrations. Integration tests use generated 32-byte IDs. Legacy 16-byte
document interoperability remains unqualified.

The storage-index patch in `patch-storage-index.mjs` removes repeated byte-store
history scans from the adapter's write, checkpoint and native hydration paths.
The bridge retains validated plain records and owned serialized signed-envelope
bytes under its existing ordered queue, within the byte-store
contract that grants it exclusive namespace ownership. First access and reopening
still validate stored envelopes, native identities, checksums and limits. Resolved
writes update the index; failed operations and deletes invalidate it before reuse.
Conflict checks, aggregate caps, persisted history and failure/flush receipts are
unchanged. Returned records are copied. Native reads construct fresh wrappers
from the validated envelope bytes; owning WASM wrappers and full encoded
storage frames are never cached. Startup and reset validate both record kinds.
This adds a bounded-by-document-history memory copy for each accessed tree; it is
not safe to share its storage namespace with an independent writer. The pinned
WASM constructors copy the borrowed record blobs into native memory; regression
tests exercise that ownership boundary.

Inventory on connect/reconnect and individual point reads still validate storage
directly. Expected conflict/capacity rejections conservatively invalidate indexes
along with ambiguous I/O failures. Those remaining scans and full-record copies
in the adapter are follow-up optimization work, not a claim of constant work
per edit. Pages uses one backend/tree per Page; a generic multi-tree service would
also need an aggregate cache budget.

`storage-index.test.mjs` exercises actual signed native records, warm-read counts,
conflicting/duplicate saves, concurrent caps, ambiguous partial batches, deletion,
returned-byte ownership and corruption detection on reopening. Read counts show
less storage work; live propagation latency still needs separate measurement.

The record-codec patch in `patch-record-codec.mjs` writes a versioned binary
compound record: a fixed 112-byte header followed by the unchanged native signed
envelope and blob. Tree, record kind/key, and the signed-envelope checksum remain
in the header; lengths, version, reserved bytes, and record limits are checked
before slicing payloads. Existing hexadecimal JSON v1 records remain readable,
including mixed stores, with no eager rewrite. The source template is embedded
in the patch module so the build fingerprint covers it, and provenance records
its generated hash. Existing admission limits and atomic single-value writes
are unchanged. This changes stored framing, not native signatures, history,
wire messages, or authentication. Stored-envelope checks detect corruption;
native authenticated ingress remains responsible for signer verification.
The package entry re-exports `decodeRecordFrame` and `RECORD_HEADER_BYTES`, so
Pages reads saved commit records for authorship with this codec rather than a
copy of the layout; provenance records that `index.ts` change with the codec.
`record-codec.test.mjs` covers native commit/fragment round trips, legacy reads,
malformed lengths, binding/digest failures, ownership, and uncertain atomic saves.

The snapshot-store patch in `patch-snapshot-store.mjs` adds an explicit local
checkpoint import path. It validates the incoming records and their full union
with existing storage before one queued native operation, bounded by the existing
history count, total bytes and individual record limits. Ordinary edit and replay
batches retain their 128-record limit. Native storage is not a batch transaction:
a failed import can leave a persisted prefix, so Pages opens the document only
after success and retries the same snapshot and document ID after failure.
`snapshot-store.test.mjs` covers 602 real changes, divergent histories, interrupted
prefix recovery, conflicts and capacity rejection before new writes.

Pages uses this capability for cached checkpoints before `repo.find()`. Generic
upstream `Repo.import()` still routes large imports and its conflict-merge fallback
through ordinary batch admission; it remains unsuitable for this prototype's
large checkpoints without an equivalent explicit snapshot path.

The opt-in `patch-compaction.mjs` adds `backend.compact(tree, { durable })`.
It reclaims only stored records omitted from the native minimal tree whose full
Automerge change-hash sets occur in a retained fragment. It reads bundles directly
and recomputes change hashes; it does not infer payload coverage from boundary
metadata, rebuild a document from JSON, or remove CRDT history. Retained signed
records remain byte-for-byte unchanged.

The caller supplies the real persistence barrier. The bridge freezes the proof,
releases its writer while awaiting durable publication, then rechecks exact
records and pending intent reservations before removing anything. A second
barrier acknowledges cleanup. Native ingress remains available during both
remote barriers; local backend operations are ordered with compaction. Removal
orders covered ancestors before descendants so an interrupted cleanup can still
make progress after native tree reconstruction. `compaction.test.mjs` covers
partial deletion, buffered crash cuts, stale peers, false coverage, and competing
reservations. This is storage reclamation of existing fragments, not a new
fragment builder or an arbitrary history-expiry facility.

The admission patch in `patch-admission.mjs` adds exact-record reservations to
that same storage writer. Before journaling an API edit, Pages validates the
union of stored records, existing reservations, and the candidate's exact
records. It holds native admission while the immutable intent crosses its host
storage barrier. Incoming native records count reserved identities exactly once;
ambiguous journal or record failures retain the reservation. A live retry reuses
its cached intent bytes, and startup restores pending reservations before opening
connections. Successful receipts release reservations only after record and
receipt durability barriers. Browser edits without a pending reservation retain
the indexed admission path. Capacity errors have a distinct typed marker, so
corruption or storage failures cannot accidentally become a read-only recovery.

For buffered persistence, the Page remains the single admission owner and
PageRecords is an ordered sink. A new Page incarnation acquires a durable
generation before taking its snapshot. Every later record read/write includes
that generation; late writes from an older incarnation are fenced out. A sink
never silently reacquires its generation while retrying. This closes the gap
between a restarted Page's loaded history and delayed requests from the previous
Page. Local and buffered tests cover native interleaving, journal failures before
and after their storage effect, partial record persistence, exact replay, and
preservation of CRDT identities. Existing over-capacity intents remain pending;
Pages serves accepted history read-only instead of applying the rejected edit to
its serving handle or retrying forever during initialization.

`admission.test.mjs` tests the shared bridge directly with native signed records;
`pages/worker/history-admission.test.mjs` additionally runs real Repo/native peers
and the buffered persistence protocol. The two original 16 MiB scenarios in
`pages/worker/capacity-race.test.mjs` now require readable recovery of stranded
legacy intents. In-process fault injection is not a proof of host power-loss or
object-store failover behavior.

The causal-history patch in `patch-causal-history.mjs` changes two upstream
files. Storage may persist only a prefix of one flush: Pages splits a flush
into PageRecords batches of 128 keys or 2 MB, and a crash can land between any
two saves. Upstream `saveBatchAll` wrote every commit before any fragment, so a
child commit could be durable without the fragment holding its parent, and
`DocumentDelegate` then waited forever for a checkpoint head that could not
materialize.

Readiness is the guarantee. When `local-load-complete` arrives, every local
record has already been applied. If a local checkpoint head has not
materialized, it needs a change this replica does not store. The patched
delegate becomes ready on the document's materialized frontier
(`A.getHeads`), not on filtered checkpoint tips: checkpoint construction drops
stored records that other stored commits reference, so in a diamond with one
branch lost the only tip is the unapplied merge. If nothing applied, the
lookup becomes unavailable once no source can supply more. Unapplied changes
stay queued in the Automerge document and apply if a peer or journaled intent
supplies their dependencies; nothing stored is discarded. Network checkpoints
keep upstream semantics.

Ordering is best effort but correct. The bridge orders each native batch by
what records actually hold and need: a loose commit holds its change and needs
its parents; a fragment holds every change in its bundle and needs the
bundle's external dependencies, decoded with `A.readBundle`. Sedimentree
boundaries are not a dependency set. A need held by no batch record is already
stored or missing and adds no edge. Records in one strongly connected
component cannot be ordered; the bridge writes such a group through the
optional `LocalByteStore.saveMany`, which persists every entry or none. Pages
implements it as one `storage.put({...})`: celld v0.6.3 (`8702f6d`) queues a
multi-key put and applies it in one SQLite `IMMEDIATE` transaction
(`crates/celld/storage.rs` `put_many_serialized`, `crates/celld/js/storage_ops.rs`).
celld sets no key-count limit there; Pages keeps Cloudflare's documented 128
keys per put and its own 2 MB request cap. A group over those limits, or a byte
store without `saveMany`, is written in sequence and readiness covers an
interrupted prefix. Stored keys, frames and signatures are unchanged.
`causal-history.test.mjs` covers real bundles whose boundary omits their
dependencies, an atomic cycle group, a reversed compacted history, and
readiness for a lost merge branch, a lost middle and a lost root. The upstream
fix belongs in `StorageBridge.saveBatchAll` and `DocumentDelegate`'s
`local-load-complete` handling.

The catch-up batching patch in `patch-catch-up-batching.mjs` changes three
upstream files so a replica far behind its peers applies the missing history
in a few loads. The bridge persisted a native batch one record at a time and
notified after each save; each notification was its own live `records` event.
The delegate applied every event with an incremental load, patch generation,
a whole-document `getRecordMetadata` rescan and a change notification. The
event consumer drained each event before the next save resolved, so no backlog
formed that a consumer could merge, in Node or with IndexedDB.

A native batch now notifies its resolved saves in chunks bounded by the
backend's `batchRecords` and `batchBytes`, the same bounds as initial replay.
As in initial replay, a record that would cross the byte bound starts the next
chunk, and a record larger than the bound is notified alone, so no notification
exceeds the watch's replay byte budget on its own account. The bridge queue runs one mutation at a time, so one pending notification
suffices. Each resolved save notifies exactly once, in save order, before the
batch's transaction ends. A failed batch notifies its resolved prefix before
the owner sees the failure. Single commit and fragment saves notify alone, as
before. The bridge callback takes an array of records. `DocumentDelegate`
rescans record metadata only when an incoming event moves the document's heads:
the covering representation is a function of the applied history, which the
heads name. Records already held, or queued behind a missing dependency, leave
it unchanged. Native also saves some catch-up records one call at a time; most
of those hold history the replica already applied, and they now skip the rescan.

`catch-up-batching.test.mjs` covers chunked notification in save order, byte
crossings and an oversized record, the notified prefix of a failed batch, and a real catch-up with listener and timer
edits interleaved: both peers converge, change events form one unbroken chain
of heads from the cached copy to the final document, and local edits submit
exactly the records a whole-document rescan before each edit would select.
`pages/scripts/catch-up-benchmark.mjs` measures the client path in Node with
`MemoryByteStore`; it does not measure IndexedDB or editor work. Stored keys,
frames, signatures and wire messages are unchanged. The upstream fix belongs in
`StorageBridge.saveBatchAll` and the delegate's `records` handling.

The outbound sync patch in `patch-outbound-sync.mjs` adds an optional
`scheduleLocalSync(id, start)` option to `SubductionBackend`. Every successful
local store started a native sync round with each peer: a request, the peer's
reply, then the commits it asked for. Pages makes one Automerge change per
editor transaction, so that was a round per keystroke. With the hook, the
application decides when a local store's round starts and can give a run of
stores one round. `start` is the existing coalescing `scheduleSync`: a round in
flight still absorbs it, and it does nothing after close, during deletion, or
once the connection generation stopped. A hook that throws starts the round at
once. Durability is unchanged: the store has persisted before the hook runs.
Reconnect replay and session opens still start their rounds immediately, and
without the hook the backend behaves as before. `outbound-sync.test.mjs` shows
three stores reaching a peer only when `start` runs, in one round. Native still
sends one frame per commit. Stored keys, frames, signatures and wire messages
are unchanged. Upstream, this belongs in the backend options next to the
existing sync timeout.

## Runtime evidence

`upstream.test.mjs` runs real upstream Repo handles, Automerge WASM, Subduction
WASM, Ed25519 handshakes, signed records, native authorization, and ephemeral
pubsub. Only the framed byte wire is an in-process test transport. The hosted
application's production OIDC/API-key verifier is exercised with generated
credentials and a local provider-response fixture; no real provider is contacted.

- Concurrent edits preserve unknown extension fields and an unsupported block.
- OIDC and API-key credentials can map to one account with distinct signing keys
  and drivers, after proof of key possession.
- Readers receive history and publish presence but cannot mutate the host copy.
  A `none` peer's read is denied; its store remains empty.
- A live reader changed to `none` receives neither subsequent content nor
  presence. An authorized peer receives the same edit and presence as a positive
  control; native fetch/subscriber-policy calls confirm the denied peer is gated.
- Revoking an already-connected signing key rejects synchronization at the
  native fetch gate and denies presence publication. The pending edit stays
  local; a current writer still updates the same host document as a positive
  control. Cached data already received cannot be recalled.
- An ordinary writer cannot mutate a runtime-profile document without separate
  runtime authority. This tests the authority gate, not real RuntimeStateDoc
  schema validation or field-level role enforcement.
- Presence retains its verified signing sender. Display identity and driver are
  projected through the registry, ignoring forged payload identity fields.

`persistence.test.mjs` uses atomic per-key filesystem replacement, a generated
signer seed, and a separate Node process to reopen the persisted document. A
sustained injected disk failure rejects change and flush; optimistic memory still
contains the unaccepted edit. Restart recovers only accepted history, a subsequent
write persists, and reopening does not rewrite loaded history. This does not
claim fsync/power-loss durability, batch transactions, or remote durable receipts.

A second persistence test clears the storage fault and retries `flush()` without
calling `change()` again. The exact same optimistic document and heads persist
and are recovered by another Node process, with no repair writes. This pins the
failed-flush-is-not-rollback behavior separately from the sustained-failure
recovery test. Callers still need explicit receipt/idempotency semantics before
using flush outcomes as an application transaction protocol.

`relay.test.mjs` uses an author, intermediate writer, and enforcing host. Native
`authorizePut` receives distinct requestor and original-author keys. After the
author signs an edit and the relay stores it, expiring only the author lease
causes the host to reject that relayed history while the relay remains authorized.

## Remaining qualification

The Node integration fixtures do not establish browser/IndexedDB/WebSocket
deployment, cross-version custom WASM/editor compatibility, production cost or
performance, S3/R2 failover durability, concurrent schema migration, or a full
production attribution design. The persistence suites above exercise partial
writes and recovery through injected failures; they do not establish host
power-loss durability. Application qualification is documented separately in
[Pages](pages/README.md). Unknown-field survival here is shown for in-place edits,
not every editor projection or Markdown export/import round trip.

The policy conservatively requires current admission for both requesting peer
and signed record author. Historical records from an expired or revoked author
can therefore fail admission even when a current writer relays them. A durable
authorship/acceptance record needs its own design; do not weaken this by treating
the relay as author or accepting arbitrary historical keys. The native sender
and record signer do not automatically attest every inner Automerge change actor.
The registry is process-local test state and must not be used as a production
account/ACL store. Revoked keys cannot enroll again within this registry; a real
host must persist revocation state across restart. Driver attribution is host enrollment metadata, not proof of
a software vendor.

Enrollment proofs in this fixture sign host-constructed JSON inside one process.
A real client must validate the expected protocol, origin, challenge ID, public
key, principal, driver, and expiry before signing; it must not expose the same
transport/record key as a signer for arbitrary bytes from a remote endpoint.
Hostile enrollment endpoints and client-side challenge validation remain
unqualified here.

Policy denial leaves optimistic edits on the client. The user-facing rollback,
export, or reauthorization workflow remains to be designed. Repo3's deprecated
`handle.isReady()` does not indicate lookup admission; the negative lookup test
uses query progress, cancellation, policy evidence, and stored records instead.


## Measured persistence boundaries

These measurements were collected during the Page7 persistence work. They are
bounded local evidence, not a benchmark of the current deployment. The maintained
fixtures reproduce the workload; [Pages](pages/README.md) documents current
application limits and deployment qualification.

The deterministic fixtures in `persistence-workload.mjs` separate ordinary prose
from an intentionally incompressible typed-value history. The latter overwrites
72 versions of a 256 KiB field; it is a stress control, not a model for storing
Parquet bulk data inside a CRDT. `persistence-amplification.mjs` counts actual
PageRecords HTTP bodies and JavaScript storage calls under identical native
0.26.0 histories:

| 18 MiB typed-history fixture | Legacy hex | Binary v2 | Binary + cleanup |
| --- | ---: | ---: | ---: |
| Owner stored value bytes, including generation | 38,223,544 | 19,104,422 | 19,097,114 |
| Record POSTs under the fixture's flush cadence | 28 | 15 | 16 |
| Cold record GETs | 24 | 11 | 11 |
| Bytes returned by storage list calls | 152,198,379 | 33,934,618 | 34,978,356 |

Each cold open also acquires its generation lease. Cleanup adds one deletion
batch for nine records. Snapshot retries preserve exact signed records and write
only the backend ID marker. These are logical calls and value bytes, not physical
S3/R2 requests, SQLite pages, billing units, or provider durability evidence.
PageRecords currently lists up to 64 values before trimming a response to 2 MB;
subsequent pages re-list values that did not fit. That explains the read
amplification and remains a distinct optimization opportunity.

A separate loopback celld 0.6.3 control with an explicit test-only 32 MiB history
budget persisted and reopened the 18 MiB fixture with exact identities. Initial
native catch-up produced a **19,054,445-byte BatchSyncResponse**. The original
Pages 4 MiB transport guard rejected it. Raising only the diagnostic frame/queue
allowance to 32 MiB on both peers allowed exact cold convergence, bidirectional
edits and presence, and another process restart retaining both edits. This
isolates the observed failure to our transport allowance rather than storage or
an inherent 16 MiB Automerge limit.

The control measured roughly 3.1 seconds to ingest, 0.4 seconds to acknowledge
local durable storage, 2.0 seconds to reopen and 5.2 seconds for initial native
catch-up. Celld dev and its server together peaked around 554 MiB RSS during
ingest; that includes multiple workers, native memory and runtime overhead. It
is not per-document heap or Cloudflare memory qualification. Timing is a single
local sample; the small edit request also included a full-history diagnostic
summary and durable response, so it is not a live-fanout latency benchmark.

Native 0.26.0 has no response-chunking option: its handler constructs one full
sync diff, and the pending request resolves once. Sending several responses
with the same ID would need new completion semantics. Cloudflare documents a
[32 MiB WebSocket message ceiling](https://developers.cloudflare.com/workers/runtime-apis/websockets/).
A long-term larger-document design needs bounded catch-up, not repeated increases
to guards or silent CRDT history truncation. The Pages 16 MiB admission budget is
retained while broader resource qualification is pending; it is an application
budget, not an Automerge or object-store limit. Test-only overrides never change
the deployed admission contract.
