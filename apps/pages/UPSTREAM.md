# Upstream integration lane

[Pages](README.md) builds the `automerge-repo` package at Repo revision
`afec0444191a5a662e065f24193bef58ab07122a`, with Automerge `3.5.0`. It requires
Node >=22.13, Git, and npm.

```sh
npm run setup
npm test
```

Run from this directory. Setup fetches the exact public upstream commit into
`.source-cache`, copies the package into ignored `upstream/`, applies the
source-hash-checked patches in `patch-upstream.mjs`, installs from
`package-lock.json` without dependency lifecycle scripts, and builds the
TypeScript package. `upstream-provenance.json` records the revision and before /
after hashes of every patched file. Existing dirty source caches are rejected.
No canonical upstream checkout, global installation, or live service is changed.

For a controller that separates online acquisition from offline execution,
`node setup.mjs --acquire-only` requires a regular `package-lock.json` matching
HEAD and stops after installation and patching, before compilation. It never
falls back to `npm install`. Run `npm run build:upstream`, then `npm run build`,
in the offline phase. The flag does not isolate networking itself; the host must
enforce a private network namespace. `test/setup.test.mjs` covers both modes and
`test/patch-wordgard.test.mjs` the editor patches.

Pages syncs with plain Automerge sync messages through its own
`SedimentreeBackend`, `AutomergeSyncBackend` (`sync/backend.mjs`).
`npm run test:contract` runs Repo 3's backend contract against it.

## DocumentDelegate

`patch-document-delegate.mjs` changes `DocumentDelegate` twice.

Readiness is the guarantee. When `local-load-complete` arrives, every local
record has already been applied. If a local checkpoint head has not
materialized, it needs a change this replica does not store, and upstream
waited for it forever. The patched delegate becomes ready on the document's
materialized frontier (`A.getHeads`), not on filtered checkpoint tips:
checkpoint construction drops stored records that other stored commits
reference, so in a diamond with one branch lost the only tip is the unapplied
merge. If nothing applied, the lookup becomes unavailable once no source can
supply more. Unapplied changes stay queued in the Automerge document and apply
if a peer or journaled intent supplies their dependencies; nothing stored is
discarded. Network checkpoints keep upstream semantics.

An incoming `records` event rescans the document's record metadata only when it
moves the heads. The covering representation is a function of the applied
history, which the heads name, so records the replica already holds, or that
wait on a missing dependency, leave it unchanged and skip the whole-document
`getRecordMetadata` rescan.

## Document records

The document record patch in `patch-document-record.mjs` adds a third record
kind a backend may deliver to Repo: `{ kind: "document", heads, blob }`, where
`blob` is one complete Automerge document chunk (`A.save()`). Pages' plain
Automerge sync backend (`sync/`) holds whole documents in that form, and
the sync reply to a cold client already carries one. Without the kind, the
document reached Repo as a fragment bundle: Repo validates a bundle by decoding
every change, then replays it. On the Feedback Page of October 31 that was 65 ms
plus 77 ms, against 21 ms to load the save chunk, and the cold open missed its
100 ms target at 259 ms; with the kind it was ready in 60 ms. Validation checks
the chunk type and checksum; `applyRecords` loads the chunk with the rest of the
batch, then refuses the batch unless the record's claimed heads are in the
result. Repo never stores document records: `extractRecords` still produces
only commits and fragments, and `SedimentreeRecord` and `RecordBatch` are
unchanged, so `MemoryBackend` behaves as before. The new `DeliveredRecord` type, `copyDeliveredRecord` and
`validateDeliveredRecord` name the wider set. `test/document-record.test.mjs` covers
loading, mixing with loose commits, refused heads, a bad checksum or chunk type,
and a real Repo opening a document delivered as one record. Pages carries this
patch rather than proposing it upstream.
