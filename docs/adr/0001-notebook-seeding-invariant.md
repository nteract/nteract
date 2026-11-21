# ADR 0001: How a fresh notebook gets its starter cell

**Status:** Accepted (2026-06-02). Implemented across `notebook-doc`, `runtimed`, and `runtimed-wasm`.

## Context

A brand-new notebook must start with exactly one empty code cell. The host authority (the daemon for daemon-hosted notebooks, or the in-browser WASM room host for cloud rooms) creates that cell once. Neither host may re-seed a notebook that already has content or that a user deliberately emptied.

Previously, the two hosts made that decision from materialized document projections and disagreed with each other:

```rust
// Previous daemon check (removed) - crates/runtimed/src/notebook_sync_server/load.rs (is_uninitialized_notebook_doc)
pub fn is_uninitialized_notebook_doc(doc: &NotebookDoc) -> bool {
    doc.cell_count() == 0 && doc.get_metadata_snapshot().is_none()
}
```

```rust
// Previous cloud host check (removed) — crates/runtimed-wasm/src/lib.rs (seed_initial_code_cell_if_empty)
if self.doc.cell_count() > 0 { return Ok(false); }
```

Using `cell_count() == 0 && metadata.is_none()` as a proxy for history caused four problems:

1. **Snapshot inference instead of causal history.** "Uninitialized" means no one has edited the notebook yet. In a CRDT, a point-in-time projection is not equivalent to change-graph history.
2. **Not convergence-safe.** `cell_count() == 0` reflects only arrived changes, so a peer can observe zero cells mid-sync. Safety relied on choreography (seeding under a daemon write lock before sync handoff), not on the predicate itself.
3. **Undocumented cross-module coupling.** `metadata.is_none()` separated pristine notebooks from user-emptied ones only because `create_empty_notebook` always wrote metadata. Changing either module silently broke classification.
4. **Host divergence.** Daemon and cloud evaluated different predicates, violating the goal of converging both hosts on one document model.

Meanwhile, the document model already encodes genesis as a causal concept:

- Every notebook boots from the frozen, byte-identical `notebook_genesis_v5.am` (`NOTEBOOK_GENESIS_V5_BYTES` in `crates/notebook-doc/src/lib.rs`), pinned to `SCHEMA_VERSION = 5` and authored by `SCHEMA_SEED_ACTOR = "nteract:notebook-schema:v5"`.
- `NotebookDoc::canonical_schema_seed_change_hashes()` (in `crates/notebook-doc/src/lib.rs`) computes and caches the genesis hash (`canonical_schema_seed_change_is_hash_bound` asserts `hashes.len() == 1`).
- Authorization checks `is_canonical_schema_seed_change(actor, hash)` (in `crates/notebook-doc/src/lib.rs`) so the seed actor converges canonical root objects only for exact frozen hashes.
- A newly created doc (`NotebookDoc::new_inner` in `crates/notebook-doc/src/lib.rs`) contains only the frozen genesis plus three identity puts at `ROOT` (`notebook_id`, `runtime_state_doc_id`, `comms_doc_id`) authored by the creating actor.
- Change-graph APIs (`NotebookDoc::get_heads()` and `NotebookDoc::get_heads_hex()` in `crates/notebook-doc/src/lib.rs`) are already available.

## Decision

Define "uninitialized" directly from causal history in `NotebookDoc::is_pristine` inside `crates/notebook-doc`. Both `runtimed` and `runtimed-wasm` call this single predicate; `is_uninitialized_notebook_doc` and the cloud `cell_count > 0` guard are removed.

> A notebook is **pristine** iff its change graph contains only the canonical schema seed and the creation scaffold: no change has ever touched `cells`, other `metadata` keys, or overwritten or deleted an identity key.

### The predicate

Both daemon and cloud rooms construct fresh documents through `NotebookDoc::new_with_actor`. The cloud room host's schema label sets the actor, not a `ROOT` key, so both hosts produce identical identity puts (`notebook_id`, `runtime_state_doc_id`, `comms_doc_id`). For untitled or ephemeral rooms, the daemon also stamps `metadata.ephemeral` before seeding runs (export excludes it so it does not persist).

Because `change.decode().operations` yields `automerge::legacy` op types, the predicate inspects `op.action`, `op.pred`, `op.obj`, and `op.key`. Requiring `OpType::Put(_)` with empty `op.pred` rejects any post-creation delete or overwrite of an identity key:

```rust
use automerge::legacy::{Key, ObjectId, OpType}; // decode() yields legacy ops

pub fn is_pristine(&mut self) -> bool {
    // Fast path (pure optimization, see below): a *populated* metadata
    // snapshot means initialized. The history walk is the real backstop.
    if self.doc.get_metadata_snapshot().is_some() { return false; }
    let seed = NotebookDoc::canonical_schema_seed_change_hashes();
    for change in self.doc.get_changes(&[]) {
        if seed.contains(&change.hash()) { continue; }
        for op in change.decode().operations {
            // Identity puts at ROOT (notebook_id, runtime_state_doc_id, comms_doc_id)
            let is_identity_put = matches!(op.action, OpType::Put(_))
                && op.pred.is_empty()
                && matches!(op.obj, ObjectId::Root)
                && matches!(
                    &op.key,
                    Key::Map(k)
                        if k == "notebook_id"
                            || k == "runtime_state_doc_id"
                            || k == "comms_doc_id"
                );
            // The daemon's ephemeral room-lifecycle flag, stamped into the metadata map
            // at room creation for untitled/ephemeral rooms. Export deliberately excludes it
            // so it does not persist, but it is present here before the seeding check runs.
            let is_ephemeral_flag = matches!(op.action, OpType::Put(_))
                && op.pred.is_empty()
                && matches!(&op.key, Key::Map(k) if k.as_str() == "ephemeral");
            if !(is_identity_put || is_ephemeral_flag) { return false; }
        }
    }
    true
}
```

Any cell insert, other metadata write, or post-creation identity edit fails the check. A notebook a user emptied carries add-and-delete history on `cells`, so it is never re-seeded and needs no metadata proxy.

### Fast-path, cost, and constructor invariants

- **Metadata fast-path is an optimization only.** `get_metadata_snapshot()` returns `Some` only for populated metadata (the empty genesis `metadata` map returns `None`), so it never misfires on a fresh doc. A metadata mutation that leaves no populated snapshot is still caught by the history walk. Removing the fast-path changes cost, not verdicts.
- **Bounded walk cost.** The walk runs only on the metadata-absent path and scales as O(number of changes). A fresh doc has two changes: the single canonical seed change plus the identity batch.
- **Local constructor invariant.** Removing the cross-module `create_empty_notebook` coupling introduces one crate-local invariant: every creation path (`new`, `new_with_encoding`, `new_with_actor`, `RoomHostHandle::create_empty`) writes only the allowed identity puts to `ROOT`. A constructor-guard unit test enforces this in CI so any new `ROOT` key fails fast instead of silently breaking seeding.
- **Test coverage.** Unit tests cover fresh docs, metadata-stamped docs, one-cell docs, emptied-after-content docs, overwritten or deleted identity keys, and every fresh constructor. An integration test empties a notebook, reconnects, and asserts zero cells remain.

## Consequences

- **One shared definition.** `runtimed` and `runtimed-wasm` call `NotebookDoc::is_pristine` directly with no reimplementation.
- **Host authority still prevents double-seeding.** `is_pristine` makes the decision convergence-safe and monotonic; host authority (daemon under doc write lock; WASM room host before handoff) keeps the write singular.
- **No schema bump and no migration.** Existing notebooks with content or history are non-pristine and are never re-seeded on upgrade.
- **Starter-cell flexibility preserved.** Seeding stays a runtime-side step, so the starter cell can vary by runtime, settings, or dependencies later.

## Rejected Alternatives

### A. Keep the projection proxy and unify both hosts

Making the cloud host check `cell_count() == 0 && metadata.is_none()` removes host divergence, which the chosen design already solves in `notebook-doc`. It leaves the snapshot proxy, cross-module metadata coupling, and lack of convergence safety intact.

### C. Bake the starter cell into genesis

Embedding one starter code cell in `notebook_genesis_v5.am` would remove runtime seeding and make the starter cell content-addressed for every peer. Rejected for four reasons:

- **Schema-version bump.** Changing genesis bytes changes `canonical_schema_seed_change_hashes()` and `is_canonical_schema_seed_change()` authorization, forcing a `v5 -> v6` migration and compatibility path for all existing v5 notebooks.
- **One-way door on starter cells.** Varying the initial cell by runtime, settings, or dependencies would require per-variant genesis assets.
- **Shared initial cell ID.** Every notebook would start with the same cell ID (doc-scoped, so not a correctness bug, but extra complexity for templates and publishing).
- **No 0-cell initial state.** A notebook could reach zero cells only by deleting the baked-in cell.

Revisit only if the schema bumps for other reasons.

### D. Explicit `ROOT.initialized` marker

Writing `ROOT.initialized = true` in the same change as the starter cell gives an O(1) read that converges under single-writer host authority. Rejected because it remains a mutable proxy that a buggy client could set or clear, adds a schema field to maintain, and ignores immutable genesis history when the history walk costs only ~2 changes on a fresh doc.

## Open Follow-ups

- Decide whether a metadata-stamped, zero-cell notebook should remain treated as initialized (not seeded). `NotebookDoc::is_pristine` preserves that existing product behavior until revisited.
