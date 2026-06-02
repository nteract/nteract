# ADR 0001: How a fresh notebook gets its starter cell

- Status: Proposed
- Date: 2026-06-02
- Deciders: nteract maintainers
- Supersedes the implicit invariant introduced in #3328

## Context

A brand-new notebook should arrive with exactly one starter code cell. That cell must be created **once**, by the **host authority** (daemon for daemon-hosted notebooks, the in-browser wasm room host for cloud rooms), and we must never seed a notebook that already has content or that a user deliberately emptied.

Today that decision is made by reading materialized projections of the document:

```rust
// crates/runtimed/src/notebook_sync_server/load.rs:1063
pub fn is_uninitialized_notebook_doc(doc: &NotebookDoc) -> bool {
    doc.cell_count() == 0 && doc.get_metadata_snapshot().is_none()
}
```

The cloud host uses a different, weaker test:

```rust
// crates/runtimed-wasm/src/lib.rs — seed_initial_code_cell_if_empty
if self.doc.cell_count() > 0 { return Ok(false); }
```

### What the document model already knows

A notebook document is not an opaque blob. It has a precise, content-addressed notion of "new" that the seeding path does not use:

- Every notebook boots from a **byte-identical frozen genesis**, `notebook_genesis_v5.am` (`crates/notebook-doc/src/lib.rs:85`), pinned to `SCHEMA_VERSION = 5` and authored by `SCHEMA_SEED_ACTOR = "nteract:notebook-schema:v5"`.
- The genesis change hashes are computed and cached: `NotebookDoc::canonical_schema_seed_change_hashes()` (`lib.rs:2401`).
- Authorization already keys on them: `is_canonical_schema_seed_change(actor, hash)` (`lib.rs:2421`) lets the seed actor converge canonical root objects, but only for the exact frozen hashes.
- A freshly constructed doc (`new_inner`, `lib.rs:989`) is exactly: the frozen genesis (authored by `SCHEMA_SEED_ACTOR`) plus two identity puts, `notebook_id` and `runtime_state_doc_id`, authored by the creating actor. Nothing else.
- The heads / change-graph API is available: `get_heads()` (`lib.rs:362`), `get_heads_hex()`.

So "genesis" is a first-class causal concept everywhere except the one place this ADR is about.

## Problem

`cell_count() == 0 && metadata.is_none()` is an **observational proxy** standing in for a fact about **history**. Four concrete problems:

1. **It infers intent from a snapshot.** "Uninitialized" means *no one has done anything to this notebook yet* - a statement about the change graph. We reconstruct it from a point-in-time materialized view. In a CRDT those are not the same thing.
2. **`cell_count() == 0` is not convergence-safe.** A materialized count reflects only what has arrived. A peer can observe zero cells transiently mid-sync, before changes land. The current code is correct only because the daemon seeds under a doc write lock *before* the sync handoff. The safety lives in that choreography, not in the invariant. The boolean reads as if it were self-sufficient; it is not.
3. **`metadata.is_none()` is load-bearing coupling, not logic.** It distinguishes "pristine" from "user emptied it" only because `create_empty_notebook` happens to always write metadata. Two modules with no stated contract keep that proxy true. Change either side and the invariant silently lies.
4. **The hosts disagree.** Daemon: `cell_count == 0 && metadata.is_none()`. Cloud: `cell_count > 0`. There is no single definition of "uninitialized," which is exactly the kind of cloud-vs-desktop divergence we are trying to retire.

## Forces

A good answer should be:

- **Convergence-safe** - never misfire on a transient empty view during sync.
- **Monotonic** - once a notebook has been touched, it is never "new" again, including after a user deletes every cell.
- **Single definition** - daemon and cloud host evaluate the same predicate.
- **Double-seed proof** - combined with host authority, exactly one starter cell.
- **Low blast radius** - avoid a schema-version bump if we can.
- **Flexible** - keep the door open to varying the starter cell by context (runtime, settings, deps) later. Today it is always one empty code cell, but baking that in is a one-way door.

## Options

### A. Keep the proxy, unify the two hosts

Make the cloud host use `cell_count == 0 && metadata.is_none()` too, so there is one definition.

- **Pros:** smallest change; removes the daemon/cloud divergence.
- **Cons:** keeps every problem above except (4). The invariant is still a materialized proxy with metadata coupling and no convergence story of its own. This does not address the actual objection.

### B. Causal pristine-check (recommended)

Define "uninitialized" against history, not projections:

> A notebook is **pristine** iff its change graph contains nothing beyond the canonical schema seed and the notebook-identity scaffold - i.e. no change has ever touched the `cells` or `metadata` objects.

Sketch:

```rust
pub fn is_pristine_notebook_doc(doc: &NotebookDoc) -> bool {
    // Every change is either a canonical seed change, or the identity
    // bootstrap (puts to notebook_id / runtime_state_doc_id only).
    // Any change that touches `cells` or `metadata` => initialized, forever.
}
```

- **Pros:**
  - Monotonic and convergence-safe: history only grows, the seed hashes are fixed and shared, so no transient-empty misfire.
  - One predicate for daemon and cloud (lives in `notebook-doc`, callable from both `runtimed` and `runtimed-wasm`).
  - Subsumes the "user emptied it" case for free: an emptied notebook carries add + delete changes on `cells`, so it is non-pristine. No metadata proxy needed.
  - No schema bump; uses machinery that already exists (`canonical_schema_seed_change_hashes`, `get_heads`).
  - Preserves the freedom to vary the starter cell later (seeding stays an explicit, runtime-side step).
- **Cons:**
  - Must pin down the identity-scaffold boundary precisely: the two identity puts are authored by the creating actor, not the seed actor, so "pristine" is "seed changes + at most the identity-only change," not "heads == seed heads." This is the one subtlety to nail in the plan.
  - Slightly more than an O(1) count: needs a causal check ("has any cells/metadata change ever applied"). Bounded and cheap for a fresh doc, but not a field read. Mitigation: short-circuit on `get_metadata_snapshot().is_some()` before walking history.

### C. Seed the starter cell into genesis

Bake one code cell into `notebook_genesis_v5.am`. A "new" notebook then already has a cell on load; delete the runtime seeding path entirely.

- **Pros:** conceptually cleanest - the invariant disappears because there is nothing to decide; the starter cell is part of the schema, content-addressed, identical for every peer, so no seeding race can exist.
- **Cons (decisive):**
  - **Schema-version bump.** Changing the genesis bytes changes `canonical_schema_seed_change_hashes()`, which feeds `is_canonical_schema_seed_change()` authorization. That is a v5 -> v6 change with a migration/compat path for every existing v5 document. Heavy and ramified.
  - **Freezes the starter cell.** It can no longer vary by runtime/settings/deps without per-variant genesis assets. A one-way door.
  - **Shared initial cell id** across all notebooks (doc-scoped, so not a correctness bug, but a property to reason about for templates/publishing).
  - Removes the ability to represent a genuinely 0-cell *initial* state (a deliberately emptied notebook is still reachable by deletion).

### D. Explicit `initialized` marker

When the host seeds, write a marker (e.g. `ROOT.initialized = true`) in the same change as the cell. Pristine-check becomes `!initialized`.

- **Pros:** O(1) read; records the fact we care about directly, instead of inferring it; convergent under host-authority single-writer.
- **Cons:** still a stored proxy whose truth depends on a writer doing the right thing (a buggy client could set or clear it); adds a field to maintain; ignores the genesis machinery that already encodes "newness" immutably. It is a better proxy than cell-count, but it is still a proxy.

## Decision

**Recommended: Option B (causal pristine-check).**

It is the option that actually answers the objection - it replaces an inferred snapshot proxy with a fact derived from immutable history - while staying convergence-safe, giving daemon and cloud a single shared predicate, and avoiding a schema bump. It also keeps starter-cell flexibility open, which C forecloses.

**D is the pragmatic fallback** if, during planning, the identity-scaffold boundary in B proves fussier than expected or the history walk is unwelcome on a hot path: a host-authority-written `initialized` marker is still a clear improvement over the current proxy and is convergent under single-writer seeding.

**C is rejected** for now: the schema-version bump and the loss of runtime-varying starter cells outweigh its conceptual tidiness. Revisit only if we are bumping the schema for other reasons.

**A is insufficient:** unifying the hosts is necessary regardless, but on its own it leaves the invariant unprincipled. Whichever of B/D we pick, the predicate moves into `notebook-doc` so both hosts share it - that absorbs A.

## Consequences

- The pristine-check moves into `crates/notebook-doc` so `runtimed` and `runtimed-wasm` call one definition. This is the cloud-converges-on-desktop direction applied to the document model.
- Host authority (daemon under the doc write lock; wasm room host before handoff) remains the single-writer guarantee. The new predicate makes the *decision* sound; host authority keeps the *write* singular. Both are needed.
- `is_uninitialized_notebook_doc` and the cloud `cell_count > 0` guard are removed.
- Existing notebooks are unaffected: any notebook with content or history is non-pristine under B, so nothing gets re-seeded on upgrade.

## Open questions (resolve in the implementation plan)

1. **Exact pristine predicate for B.** Define it against `get_changes(&[])`: allow the canonical seed hashes plus a single identity-bootstrap change touching only `notebook_id` / `runtime_state_doc_id`; treat any `cells` or `metadata` op as initialized. Confirm op-batching does not split the identity puts in a way that breaks the check.
2. **Cost.** Is the history walk acceptable on every connect, or do we short-circuit on `metadata.is_some()` first and only walk for the metadata-absent case?
3. **Cloud parity.** `runtimed-wasm` must call the same `notebook-doc` predicate, not a reimplementation.
4. **Test surface.** Unit-test the predicate across: fresh doc (pristine), metadata-stamped (not), one cell (not), emptied-after-content (not). Integration-test: empty a notebook, reconnect, expect zero cells (the headline behavior currently only covered indirectly).
