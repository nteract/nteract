# Notebook Schema Evolution and the Frozen Genesis

**Status:** Draft, 2026-05-30.

## Context

A `NotebookDoc` is an Automerge CRDT. Every notebook document descends from a
**genesis seed**: a frozen root change that creates the `cells` and `metadata`
maps and stamps `schema_version`. The seed bytes are committed as an asset and
loaded verbatim:

- `SCHEMA_VERSION: u64 = 5` (`crates/notebook-doc/src/lib.rs:74`)
- `NOTEBOOK_GENESIS_V5_BYTES` from `assets/notebook_genesis_v5.am` (`:85`)
- attributed to `SCHEMA_SEED_ACTOR = "nteract:notebook-schema:v5"` (`:81`)

Two documents that load the same seed bytes share a byte-identical root change,
so they share a common ancestor and merge cleanly. That shared ancestor is the
load-bearing property behind both persistence and cross-peer sync. The cloud
room host pins the seed by change hash (`canonical_schema_seed_change_hashes`,
`:2370`, from #3192) so only the canonical root is accepted into a room.

### The incident this register entry exists to prevent

The schema bump v4 -> v5 (#3086) **regenerated the genesis seed** along with the
version stamp. The daemon shipped the v5 seed; the gitignored frontend wasm
still embedded the v4 seed. A notebook opened by the frontend started from the
v4 root while the daemon worked from the v5 root, two **divergent roots** with
no common ancestor. They did not hard-fail; Automerge merged them last-write-
wins into a doc that neither side read correctly, and an autosave footgun then
zeroed the file. The fixes that landed:

- #3134: `cargo xtask verify-genesis` + `wasm-ensure` assert the built wasm
  embeds the current seed bytes. The drift guard that keeps daemon and frontend
  seeds matched. See [Automerge Fork Patches](automerge-fork-patches.md) for the
  related validation work.
- #3179: autosave-zeroing data-loss guard (`load_failed` set-on-hazard). The
  safety net for failed loads.
- #3192: canonical seed cross-peer sync auth, hash-pinned. See
  [Hosted Room Authorization](hosted-room-authorization.md).
- #3195: forward-tolerant schema reader (below).

## Decision: freeze and layer

**Never regenerate the genesis.** The frozen v5 root is permanent. Schema
evolution layers on top of it:

1. **Additive changes** (new metadata keys, new cell-metadata keys, new
   top-level keys) are written by ordinary principal-authored ops on the frozen
   root. Unknown keys round-trip through `extras` / `#[serde(default)]` on the
   metadata path, and survive structurally on the `.automerge` path because save
   is a raw CRDT dump. Old readers tolerate them.
2. **Structural changes** (reshaping `cells`, re-keying outputs) do **not** go
   in place. A CRDT merge of two different shapes of the same logical data
   produces a document neither version reads correctly. Structural change needs
   a sidecar document, never an in-place reshape of the frozen root.
3. **`schema_version`** is bumped by a normal layered write, not by re-rooting.
   The v4 -> v5 diff (`git show e385d806`) changed only the version scalar and
   the seed actor label; it never needed a new root. No future bump does either.

### Why "additive" is safe and "structural" is not

Sync exchanges Automerge ops keyed by `ObjId`, not typed notebook structs. A
peer that cannot interpret a key still stores and forwards its ops. So additive
data authored by a newer peer lands in an older peer's document and survives,
even though the old peer's code never reads it. That is real forward
compatibility: *preserve what you do not understand.* It holds only while both
peers share the frozen root and only write **new** locations. The moment two
versions write **different shapes** of the same location, the merge is garbage.

## The forward-tolerant reader (#3195)

`load_or_create_inner` reads the raw `schema_version` into a tri-state and
dispatches:

| `schema_version` | Behavior |
|---|---|
| **Absent** + has v5 skeleton (`cells`/`metadata` Maps) | load as current (not v1) |
| **Absent** + no v5 skeleton | reject -> `.corrupt` |
| **Valid(v)** >= `SCHEMA_VERSION` (newer build) | load tolerantly: no downgrade, no migrate |
| **Valid(3 \| 4)** | migrate in place (real 2.0.x docs) |
| **Valid(v)** < 3 (v1/v2 prototype) | reject -> `.corrupt` |
| **Invalid** (non-integer / negative) | reject -> `.corrupt` |

The "newer build loads tolerantly" row is the prerequisite for ever bumping the
schema: until v5 builds tolerate a v6 doc, a bump would `.corrupt`-rename files
on every not-yet-updated install. We must **not** write our older
`SCHEMA_VERSION` over a newer one (loses the version, risks a concurrent LWW
downgrade) and must **not** migrate a newer doc.

## Migration

v3 (2.0 launch, Mar 2026) and v4 (#2760, mid-May) are real on-disk documents.
They migrate in place on load: add `runtime_state_doc_id`, stamp
`schema_version = SCHEMA_VERSION`. v1/v2 are pre-2.0 prototype formats that do
not exist in the field; their reject branch is a harmless guard.

`crates/notebook-doc/src/lib.rs` tests:

- `test_load_v4_doc_migrates_runtime_state_doc_id`: the migration mechanism.
- `test_v4_to_v5_migration_preserves_realistic_notebook` (#3199): a realistic
  v4 doc (mixed cells, sources, cell metadata, conda/uv deps) survives the
  migrate-in-place with nothing dropped and no `.corrupt`. The confidence check
  for the stable v4 -> v5 release.

Migration is a **load-time write**. That is fine on desktop, where a room has a
single version. It is **not** fine in a mixed-version room (below).

## Cross-version sync (the cloud topology)

Desktop ships the daemon and frontend as one build, so every peer in a room runs
the same schema version. See [Deployment Topology](deployment-topology.md).
Cloud (prototype) lets independently-versioned peers share a room through the
host. Three behaviors then matter, demonstrated by tests in
`crates/notebook-doc/src/lib.rs`:

1. **Additive fields survive** (`test_cross_version_sync_preserves_additive_future_fields`).
   A current (v5) peer and a future (vX) peer build from the same frozen genesis,
   sync, and the v5 peer keeps the vX peer's unknown top-level key and unknown
   cell-metadata key. Cells merge cleanly; the root is not doubled.

2. **`schema_version` is LWW, not monotonic**
   (`test_cross_version_schema_version_is_lww_not_monotonic`). Two peers writing
   different versions concurrently converge to a single value, but it is an LWW
   pick decided by `(lamport, actor)`, unrelated to which schema is newer. In the
   test the *stale* peer wins and stamps the shared doc backward (v6 -> v4). This
   is single-writer by **convention** only (the migrate-on-load path is the lone
   writer, and desktop rooms are single-version). Cloud breaks the convention.
   Tracked as **SE-1** in [cleanup-punchlist.md](cleanup-punchlist.md).

3. **Divergent genesis breaks sync.** The original incident, at the sync layer.
   Guarded by #3134 (build-time drift) and #3192 (host hash-pinning). Any future
   vX that regenerates the seed re-breaks every mixed-version room.

The cell-level asymmetry: notebook metadata has an `extras` bag, so unknown
metadata keys round-trip through `.ipynb` export. Cells do **not**: a bare
unknown field directly on a cell survives the `.automerge` round-trip but is
dropped at the `.ipynb` boundary. Additive cell data must live under
`cells/{id}/metadata`, never as a bare cell field.

## Invariants

1. The genesis seed is frozen. Do not regenerate it on a schema bump.
2. A schema bump is one layered write to `schema_version` plus additive fields.
3. Additive cell data goes under `cells/{id}/metadata`, never a bare cell field.
4. A v5 build must tolerate a v6 doc (no downgrade, no migrate, no `.corrupt`).
   The bump cannot ship until that reader has propagated through the fleet.
5. Structural change uses a sidecar, never an in-place reshape of the root.
6. `.ipynb` is the truth on disk for saved notebooks; the `.automerge` is the
   sole copy for untitled notebooks and the live sync substrate.

## Open question

`schema_version` as a single LWW scalar has no mixed-version semantics. Before
cloud ships mixed versions in one room it needs either host-enforced
single-writer auth (does #3192's room-host auth let a peer update
`schema_version`?) or monotonic-max merge semantics. See SE-1.
