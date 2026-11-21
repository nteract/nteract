# Notebook Schema Evolution and the Frozen Genesis

**Status:** Accepted, 2026-05-30; recovery boundary amended 2026-07-13.

## Context

`NotebookDoc` is an Automerge CRDT. Every notebook document descends from a **genesis seed**: a frozen root change that creates the `cells` and `metadata` maps and stamps `schema_version`. The seed bytes are committed as an asset and loaded verbatim in `crates/notebook-doc/src/lib.rs`:

- `SCHEMA_VERSION: u64 = 5`
- `NOTEBOOK_GENESIS_V5_BYTES` from `crates/notebook-doc/assets/notebook_genesis_v5.am`
- `SCHEMA_SEED_ACTOR = "nteract:notebook-schema:v5"`

Two documents loaded from the same seed bytes share a byte-identical root change and common ancestor, so they merge cleanly. Persistence and cross-peer sync both depend on that shared root. The cloud room host pins the seed by change hash via `NotebookDoc::canonical_schema_seed_change_hashes` in `crates/notebook-doc/src/lib.rs`, admitting only the canonical root into a room.

### The incident this ADR prevents

The v4-to-v5 schema bump regenerated the genesis seed along with the version stamp. The daemon shipped the v5 seed while the gitignored frontend WASM still embedded the v4 seed.

Opening a notebook produced two divergent roots with no common ancestor. Automerge merged them last-write-wins into a document neither side read correctly, and autosave then zeroed the file.

Four safeguards landed to prevent a repeat:

- **Build-time drift guard:** `cargo xtask verify-genesis` and `wasm-ensure` verify that built WASM embeds the current seed bytes. See [Automerge Fork Patches](../memos/automerge-fork-patches.md).
- **Autosave data-loss guard:** `load_failed` set-on-hazard blocks autosave from zeroing a file after a failed load.
- **Canonical seed hash pinning:** Cross-peer sync authorization pins the canonical seed change hashes. See [Hosted Room Authorization](hosted-room-authorization.md).
- **Forward-tolerant schema reader:** Older builds load newer schema versions without downgrading or quarantining them.

## Decision: freeze and layer

**Never regenerate the genesis.** The frozen v5 root is permanent. Schema evolution layers on top of it:

1. **Additive changes** (new metadata keys, cell-metadata keys, or top-level keys) use ordinary principal-authored ops on the frozen root. Unknown keys round-trip through `extras` and `#[serde(default)]` on metadata paths, and survive structurally in `.automerge` dumps. Old readers tolerate them.
2. **Structural changes** (reshaping `cells` or re-keying outputs) never happen in place. Merging two shapes of the same logical data produces an unreadable document. Structural changes require a sidecar document.
3. **`schema_version` bumps** use a normal layered write, never re-rooting. The v4-to-v5 change only modified the version scalar and seed actor label; it never needed a new root, and no future bump does either.

### Why additive is safe and structural is not

Sync exchanges Automerge ops keyed by `ObjId`, not typed notebook structs. A peer that ignores a key still stores and forwards its ops. Additive data from a newer peer lands in an older peer's document and survives intact.

That forward compatibility — *preserve what you do not understand* — holds only while both peers share the frozen root and write to new locations. Once two versions write different shapes to the same location, the merge corrupts the document.

## The forward-tolerant reader

`load_or_create_inner` reads `schema_version` into a tri-state and dispatches:

| `schema_version` | Behavior |
|---|---|
| **Absent** + has v5 skeleton (`cells`/`metadata` Maps) | Load as current (not v1) |
| **Absent** + no v5 skeleton | Reject -> `.corrupt` |
| **Valid(v)** >= `SCHEMA_VERSION` (newer build) | Load tolerantly: no downgrade, no migrate |
| **Valid(3 \| 4)** | Migrate in place (real 2.0.x docs) |
| **Valid(v)** < 3 (v1/v2 prototype) | Reject -> `.corrupt` |
| **Invalid** (non-integer / negative) | Reject -> `.corrupt` |

Tolerant loading of newer builds is the prerequisite for any future schema bump. Until v5 builds tolerate v6 docs, shipping v6 would rename files to `.corrupt` on un-upgraded installs. Older builds must never overwrite a newer `schema_version` (risking a concurrent LWW downgrade) and must never migrate a newer doc.

## Migration

v3 (2.0 launch, Mar 2026) and v4 (May 2026) are real on-disk documents. They migrate in place on load by adding `runtime_state_doc_id` and stamping `schema_version = SCHEMA_VERSION`. v1 and v2 are pre-2.0 prototype formats absent in the field; their reject branch is a harmless guard.

Tests in `crates/notebook-doc/src/lib.rs` cover this path:

- `test_load_v4_doc_migrates_runtime_state_doc_id`: verifies the migration mechanism.
- `test_v4_to_v5_migration_preserves_realistic_notebook`: verifies a realistic v4 doc (mixed cells, sources, cell metadata, conda/uv deps) migrates cleanly with nothing dropped and no `.corrupt`.

Migration is a load-time write. That works on desktop, where one build owns the room, but not in mixed-version rooms.

## Cross-version sync (the cloud topology)

Desktop ships the daemon and frontend as one build, so every peer in a room runs the same schema version. See [Deployment Topology](deployment-topology.md). Cloud rooms let independently versioned peers sync through a room host.

Three behaviors matter in mixed-version rooms, verified by tests in `crates/notebook-doc/src/lib.rs`:

1. **Additive fields survive** (`test_cross_version_sync_preserves_additive_future_fields`). A v5 peer and a future vX peer built from the same frozen genesis sync cleanly. The v5 peer preserves the vX peer's unknown top-level and cell-metadata keys without doubling the root.
2. **`schema_version` resolves to the conflict-set max** (`test_cross_version_schema_version_resolves_to_max_not_lww`). Concurrent version writes leave an Automerge conflict set where a bare `get` can return the older LWW winner. Readers resolve the max over `get_all` instead (details below).
3. **Divergent genesis breaks sync.** Build-time verification (`cargo xtask verify-genesis`) and room-host hash pinning (`canonical_schema_seed_change_hashes`) guard this invariant. Any future version that regenerates the seed breaks mixed-version rooms.

Cell-level asymmetry: notebook metadata has an `extras` bag, so unknown metadata keys round-trip through `.ipynb` export. Cells do not. A bare unknown field on a cell survives `.automerge` storage but drops at `.ipynb` export. Additive cell data must live under `cells/{id}/metadata`, never as a bare cell field.

## Read-side monotonic-max resolution

`schema_version` remains a plain LWW scalar on the wire. Concurrent writes of different versions create an Automerge conflict set where a bare `get` returns the `(lamport, actor)` winner, which can stamp the document backward (for example, v6 -> v4).

Every reader instead inspects the full conflict set (`get_all`) and takes the max. Both read sites implement this rule: the `schema_version()` accessor and the load-time classifier in `load_or_create_inner`.

The classifier preserves its tri-state:

- An empty conflict set is absent (a v5-skeleton doc loads as current).
- A non-empty set with no non-negative integer is malformed (quarantined to `.corrupt`).
- Otherwise, the max integer is the resolved version.

Two alternatives were rejected:

- **Write-back reconciliation** (re-stamping the max on load or merge): mutates documents on load, grows op history on every daemon restart, and injects a daemon-authored change at sync merge that desynchronizes peer sync state.
- **Host-enforced single-writer authorization:** Although the cloud room host enforces sync ingress rules such as genesis hash pinning, relying on host-side write authorization does not protect desktop rooms, offline edits, or already-diverged documents.

Read-side max is deterministic because converged peers hold identical conflict sets. It requires no host authority, heals already-diverged docs on read, and performs zero writes. Keeping the conflict in Automerge recovery state is harmless because every reader resolves the max, and `.ipynb` export records that resolved value at its causal `exported_heads`.

## Invariants

1. The genesis seed is frozen. Never regenerate it on a schema bump.
2. A schema bump is one layered write to `schema_version` plus additive fields.
3. Additive cell data lives under `cells/{id}/metadata`, never as a bare cell field.
4. A v5 build must tolerate a v6 doc (no downgrade, no migrate, no `.corrupt`). A bump cannot ship until that reader has propagated through the fleet.
5. Structural changes use a sidecar document, never an in-place reshape of the root.
6. `.ipynb` is the user-visible exported truth for saved file-backed checkpoints. A file-backed Automerge recovery journal is durable truth for acknowledged heads beyond `exported_heads`; it is never a disposable import cache. Automerge remains the sole copy for untitled notebooks and the live sync substrate for both kinds.
7. File-backed recovery journals and staged imports must descend from the frozen genesis and retain their recorded change hashes. Recovery must reject a divergent root instead of merging it into the room.
8. `schema_version` is read through conflict-set max resolution, never a bare `get`. Every new read site must use `schema_version()` (or equivalent `get_all` + max), or a concurrent stale write can appear as a backward stamp.
