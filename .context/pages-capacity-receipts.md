# Pages capacity and receipt checkpoint — 2026-10-25

Base: `3de9d4cf482efae0d52e7b0fe126e82752a4fafb`.
Branch: `quod/pages-capacity-investigation`. Intended incorporation: PR #4469.
This checkpoint adds characterization tests, not a production admission fix.
No public runtime, tunnel, storage, deployment, or document was changed.

## Findings and responsibility

Paths below are relative to
`docs/memos/authenticated-automerge-app-substrate/experiment/`.

| Contract | Evidence | Responsibility |
| --- | --- | --- |
| History capped at 16 MiB | `pages/model/limits.mjs` sets `BACKEND_LIMITS.maxSnapshotBytes`; Page initialization passes it to the backend, as does the viewer. | Our configuration, not an Automerge document-format requirement. |
| Upstream also has configurable admission budgets | Pinned Repo revision `afec0444191a5a662e065f24193bef58ab07122a`, `packages/automerge-repo-subduction/src/index.ts`, constructor: default snapshot 64 MiB, record 16 MiB, count 10,000, ordinary batch 128 records. | Upstream adapter policy, not a fixed Rust/WASM Automerge cap. |
| Stored frames capped separately | `pages/model/limits.mjs`: 900 KiB native record, 1,900,000 bytes for key + stored frame; adapter hex-encodes payloads. | Our compatibility policy for SQLite DO storage; distinct from aggregate history. |
| Native writes respect the aggregate budget | Upstream `storage.ts`, `savePrepared`, queues check + save and charges the union of records. `index.ts`, `storeRecords`, checks the batch union too. | Upstream enforcement works. Our storage-index patch preserves this check. |
| API intent has no capacity reservation | `pages/worker/mutations.mjs`, `documentMutation`: validate fork, flush base, put intent, update handle. `Page.fetch` queues HTTP mutations but native frames bypass that queue. | Our admission/recovery bug at an integration boundary. |
| Failed persistence leaves optimistic content | Upstream `Document.applyMutation` adopts the new doc before awaiting commit; `DocumentDelegate` retains exact failed batches and retries on flush. | Documented upstream semantics. Treating rejection as rollback would be our integration error. |
| Pending replay prevents all Page initialization | `Page` constructor awaits `recoverDocumentMutations` inside `blockConcurrencyWhile`; recovery uses the same bounded backend. | Our availability bug. Upstream is correctly rejecting an over-budget union. |
| Receipt count capped at 1,000 | `reserveCapacity` lists `host/operation/` and rejects when size >= 1,000; all pending and completed records count. | Entirely our application policy. No native/Automerge role. |

The aggregate measure is `extractRecords` / `recordBytes`, not JSON content size,
the size of `A.save`, or physical hex storage bytes. Repeated overwrites/deletions
retain history. Recreating a document from its visible JSON would lose history,
actor/operation IDs, anchors, and retry identity; it is not a compaction fix.

Source separation was checked against the untouched `.source-cache` checkout as
well as generated `upstream/`. Authorization forwarding, storage indexing, and
snapshot import are our explicit patches. None provides an intent reservation.
The adapter's `LocalByteStore` contract requires atomic replacement of one value,
exclusive namespace ownership, and **does not** require atomic batches. Native
batch failure may leave an accepted prefix. The JS `StorageBridge` enforces these
budgets for incoming native writes; this is not a cap baked into Subduction WASM.
No new upstream defect is established here. A typed capacity error and shared
reservation API would be useful upstream capabilities, but are not existing
guarantees that Pages can assume.

## Deterministic reproduction

`pages/worker/capacity-race.test.mjs` uses real Repo, Automerge 3.5.0,
Subduction 0.23.0, signed records, and native peer admission. It preloads identical
base history on both peers, then exchanges the competing edit over the existing
in-process authenticated byte wire. Storage is a copying Map with a fault hook.
There are no credentials, random payloads, sleeps to win the race, or lowered
production limits. A seeded byte generator creates 31 overwrite changes of
512 KiB each. The API and competing native change each add 300 KiB.

Measured record totals in this run:

| State | Bytes |
| --- | ---: |
| Base | 16,263,778 |
| Base + API candidate | 16,571,238 |
| Base + accepted native change | 16,571,241 |
| Union | 16,878,701 |
| Configured cap | 16,777,216 |

The hook pauses after the pending intent is stored, sends the native edit, waits
for host observation and backend flush, and then either lets API application run
or injects a crash before application. Both cases assert:

1. Each candidate fits individually; the union does not.
2. The pending API entry remains and no successful receipt is manufactured.
3. Reopening a copy of accepted storage restores the native change, without the
   API change, and preserves the existing object's CRDT identity.
4. The actual Page constructor rejects at replay. Only `initializeRepo` is
   substituted to attach that real backend without unrelated ACL setup.
5. A separate diagnostic copy with an extra 1 MiB replays exactly the recorded
   API change bytes and preserves native heads and object identity. Retrying the
   original request returns the recovered receipt without reauthoring. This is a
   control proving the cause; it is **not** a production cap increase.

The apply-rejected variant also asserts that the live handle already contains
the rejected API edit. Do not catch startup errors and simply serve that handle:
it could expose undurable content as restored state. Expected shutdown diagnostics
report unsaved history because upstream shutdown retries those optimistic edits.
Payload bytes are seeded; keys/actor IDs still use library-generated identities.

`pages/worker/receipt-capacity.test.mjs` seeds 999 historical journal entries,
performs the 1,000th actual mutation, and proves exact retry works, a changed
payload conflicts, and a new key fails without another edit. Old timestamps and
pending/completed status do not release capacity. Generated auth fixtures prove a
catalog containing 1,000 completed deletion receipts rejects both create and
delete before contacting a Page. These are boundary tests, not a 1,000-request
end-to-end workload benchmark.

The journal has no expiry/GC path. The comment about retention until deletion is
not physical cleanup: Page deletion removes repo history and stores a tombstone,
but does not delete `host/operation/*`. Catalog deletion removes the Page index
row and retains its own operation receipt plus `host/deleted/<pageId>`. The 100
active-Page limit therefore does not prevent hitting the 1,000-operation ceiling.

## Bounded admission and recovery design (not implemented)

The invariant should be **stored unique records union reserved exact records
fits all budgets**, checked at the same ordered admission boundary used by both
native writes and API writes. A reservation must cover bytes, record count,
per-record/frame limits, and the number/bytes of pending intents. Merely checking
the candidate again after a flush or serializing HTTP requests cannot enforce it.

A viable next implementation is an adapter reservation operation keyed by the
exact request fingerprint and record identities. It must atomically persist the
replayable intent/reservation before native admission can spend that space. The
dependency base must already be durable. When exact reserved records arrive,
convert reservation to stored accounting without double-charging duplicates;
retain the reservation for any missing suffix. Release it only after accepted
history and terminal status cross their durability barriers. A crash must restore
reservations before opening native connections. Pending count and bytes must be
bounded independently of completed receipt retention.

Local mode could implement this inside the storage bridge's ordered writer with
a durable admission journal. Buffered mode needs an explicit owner/protocol:
PageRecords currently receives opaque frames while the Page's intent is in a
different DO. A Map reservation in the Page, or a transaction spanning only its
host keys, does not coordinate the separate record owner. Move admission state to
one authoritative owner or implement a durable reservation handshake with idempotent
reconciliation before claiming the same guarantee for both modes.

| Crash window | Required recovery |
| --- | --- |
| Before durable reservation | No replay promise; ordinary retry may be newly admitted. No accepted native changes are removed. |
| Reservation persisted, caller uncertain | Retry finds the same fingerprint/records; never repeat text editing or generate a replacement intent. An orphan reservation must be reconcilable, not released merely by age. |
| Partial native batch stored | Restore actual accepted prefix, charge the union once, replay the missing exact records. No atomic-batch assumption. |
| History durable, receipt not durable | Check requested heads are present, finish the same receipt/barrier; never reapply the semantic operation. |
| Receipt put succeeded but sync failed | Retry sync before returning the cached receipt; existing code already handles this. |

Existing stranded intents need a separate migration path. Restore accepted history
and inspect pending changes on a clone before mutating the serving handle. If the
union cannot fit, retain the intent and expose an explicit recovery-blocked state,
with accepted-history read/export access and new writes gated. Do not mark the
intent successful, evict it, retry forever at startup, silently raise all budgets,
or reconstruct the Page from JSON. Since this intent never got a durable success
receipt, its status must remain pending/blocked. To actually complete it requires
bounded additional storage capacity or an explicit archival/migration decision;
there is no lossless way to fit an arbitrary over-budget union under the same cap.

This migration needs a fresh accepted-history handle if an attempted replay has
already made the old handle optimistic. Capacity must be a structured admission
result; current `invalid-record`/generic error strings also cover other failures,
so production recovery must not classify errors with the regex used in this
characterization test. Storage/corruption failures must remain distinct.

## Bounded receipt retention and expired retries (not implemented)

Blind TTL/LRU eviction is unsafe with today's arbitrary 8–128 character keys.
After deleting a receipt, the server cannot distinguish an old replay from a new
request using the same key. Stale-head checks are insufficient: catalog create has
no base heads, and a completed no-op can leave the same heads. A retry after a lost
response must not create another Page or repeat a side effect.

Use a versioned key protocol with a server-issued, resource/principal-bound epoch
or signed expiry token, plus the existing request fingerprint. Keep a durable
minimum accepted epoch and a bounded receipt window. Within the window: exact key
and fingerprint returns the same receipt after its barrier; mismatched fingerprint
returns conflict. Below the durable floor: return a typed expired/unknown-outcome
response (for example HTTP 410), **without executing**, even if the receipt is gone.
Never automatically replace an expired key and resend. The client must reconcile
the Page/catalog and explicitly formulate a new operation with fresh guards.

Advance and durably sync the floor before deleting any terminal receipt it covers.
Crash before that barrier leaves all old receipts valid; crash after the barrier
but during GC leaves excess rows that can be collected again safely. Reject old
tokens consistently even if their rows remain. Accept no future/unissued epoch.
Publish the retry deadline in receipts and client behavior. Bound active windows
by bytes as well as count; if a window fills before its promised retry deadline,
apply backpressure rather than shortening that promise silently.

Pending intents are not terminal cache entries: keep their exact bytes and
reservations, and provide status/reconciliation even if their request token is old.
Do not advance a retirement floor over unresolved operations unless a separate
bounded pending-status path retains them. Cross-DO catalog operations need the
same coordinated retention contract: retain the create-to-page-ID mapping and
deletion/tombstone semantics until their retries can no longer be admitted. The
existing `host/deleted/*` map is a separate lifetime growth concern, not fixed by
receipt GC. Legacy unversioned keys require a compatibility policy (retain their
receipts or freeze new legacy admissions); silently evicting them is not safe.

## Validation and adoption

From the experiment directory, after `npm run setup`:

```sh
TSX_TSCONFIG_PATH=pages/tsconfig.json node --import tsx --test pages/worker/capacity-race.test.mjs pages/worker/receipt-capacity.test.mjs
TSX_TSCONFIG_PATH=pages/tsconfig.json node --import tsx --test pages/worker/*.test.mjs
TSX_TSCONFIG_PATH=tsconfig.test.json node --import tsx --test storage-index.test.mjs snapshot-store.test.mjs persistence.test.mjs
```

The `node --import tsx` form avoids the tsx CLI's sandbox-blocked IPC pipe while
using the same loader and tsconfig. Worker suite: **124/124 passed**. Upstream
storage/snapshot/persistence regressions: **24/24 passed**. The two real-cap tests
take about 42 seconds together on this workstation; they pass by reproducing the
known defect and must change their expected outcome when admission is repaired.

Built the Pages Worker/viewer and ran the existing smoke against isolated local
celld 0.6.1 on `localhost:19974`, generated local OIDC only. It passed account
isolation, create/edit/delete retries, stale-head rejection, anchored comments,
and MCP read/move. This is a runtime baseline, **not** the deterministic capacity
race through a live WebSocket or a proof of object-store/power-loss durability.
The local process restart check also restored the saved content and anchored
comment. The fixture was stopped after validation. `cargo xtask lint --fix`
passed Rust formatting, JS/TS formatting/lint, Python ruff, and Python ty.
The fault-injection regression uses in-process native transport and copied
storage snapshots. No browser UI, public deployment, or remote CI was qualified.

Adopt the two tests and this checkpoint on top of the rebased consolidated branch;
there are no production code or dependency changes to reconcile. Keep the public
deployments frozen. Follow-up implementation should first establish the shared
admission owner and typed failures, then non-poisoning recovery, then versioned
receipt expiry. Qualify local and buffered persistence separately, including
record-prefix failures and floor/GC crash windows, before promoting a fix.
