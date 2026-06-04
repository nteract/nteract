# Notebook Pristine-Seeding Implementation Plan

- Status: Implemented (shipped in #3342)
- Implements: [ADR 0001 - Notebook seeding invariant](0001-notebook-seeding-invariant.md)

Task-by-task, test-first breakdown; checkbox (`- [ ]`) steps track progress. Retained as the implementation record for ADR 0001.

**Goal:** Replace the cell-count/metadata proxy that decides whether a fresh notebook gets a starter cell with a single causal predicate (`NotebookDoc::is_pristine`) shared by the daemon and the cloud wasm host.

**Architecture:** A notebook document boots from a byte-identical frozen genesis plus exactly two identity puts (`notebook_id`, `runtime_state_doc_id`). "Pristine" means the change graph contains nothing beyond that: every change is either a canonical schema-seed change or an identity put to ROOT. Any cell insert or metadata write makes it non-pristine, forever. This is Option B from `docs/adr/0001-notebook-seeding-invariant.md`.

**Tech Stack:** Rust, automerge (nteract fork), `notebook-doc` / `runtimed` / `runtimed-wasm` crates.

---

## Background the implementer needs

- `NotebookDoc` wraps an automerge `AutoCommit` in `self.doc` (private field, so the predicate is a method on `NotebookDoc`).
- A fresh doc is built by `NotebookDoc::new_with_actor` (`crates/notebook-doc/src/lib.rs:983`), which loads the frozen genesis (`notebook_genesis_v5.am`, authored by `SCHEMA_SEED_ACTOR`) then does two `put(ROOT, ...)` ops: `notebook_id` and `runtime_state_doc_id`. Both the daemon and the cloud room host create docs this way (`RoomHostHandle::create_empty` -> `new_with_actor`).
- `NotebookDoc::canonical_schema_seed_change_hashes()` (`lib.rs:2401`) returns the genesis change hashes (cached).
- automerge API confirmed for this fork (rev f22752b): `AutoCommit::get_changes(&mut self, &[]) -> Vec<Change>`; `Change::decode(&self) -> automerge::ExpandedChange`; `ExpandedChange.operations: Vec<automerge::legacy::Op>`; `Op { action: automerge::legacy::OpType, obj: automerge::legacy::ObjectId, key: automerge::legacy::Key, pred: SortedVec<OpId>, insert: bool }`; `ObjectId::{Root, Id(OpId)}`; `Key::{Map(SmolStr), Seq(ElementId)}`; `OpType::{Put(ScalarValue), Delete, Increment(i64), Make(ObjType), ..}`; `pred.is_empty()` is public. `legacy` is a public module.
- The predicate matches on `op.action` and `op.pred`, not only `obj`/`key`: a creation-scaffold write is an initial `Put` (`OpType::Put(_)` with empty `pred`). A later *delete* or *overwrite* of an identity key is `OpType::Delete` or a `Put` with non-empty `pred`, and must be rejected - otherwise post-creation identity edits would be misclassified as pristine.
- `get_changes` takes `&mut self`, so `is_pristine` is `&mut self`. All three daemon call sites already hold `let mut doc = room.doc.write().await`, and the wasm caller is `&mut self`, so this is not a constraint.

## File structure

- `crates/notebook-doc/src/lib.rs` - add `pub fn is_pristine(&mut self) -> bool` (the shared predicate) + unit tests. One responsibility: answer "has anything beyond creation happened to this document?"
- `crates/runtimed/src/notebook_sync_server/load.rs` - delete the daemon-local `is_uninitialized_notebook_doc`.
- `crates/runtimed/src/daemon.rs` - 3 call sites switch to `doc.is_pristine()`.
- `crates/runtimed/src/notebook_sync_server/tests.rs` - remove the now-dead daemon predicate test; add the empty-then-reconnect integration coverage.
- `crates/runtimed-wasm/src/lib.rs` - `seed_initial_code_cell_if_empty` guard switches to `!self.doc.is_pristine()`; update its idempotency test.
- `docs/adr/0001-notebook-seeding-invariant.md` - flip Status to Accepted once merged.

---

### Task 1: Add `NotebookDoc::is_pristine` with unit tests

**Files:**
- Modify: `crates/notebook-doc/src/lib.rs` (add method near `canonical_schema_seed_change_hashes`, around `lib.rs:2400`; add import near the top automerge `use` at `lib.rs:92`)
- Test: `crates/notebook-doc/src/lib.rs` (the in-file `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/notebook-doc/src/lib.rs`:

```rust
#[test]
fn fresh_notebook_doc_is_pristine() {
    // genesis + the two identity puts, nothing else
    let mut doc = NotebookDoc::new_with_actor("nb-1", "runtimed");
    assert!(doc.is_pristine());
}

#[test]
fn notebook_with_a_cell_is_not_pristine() {
    let mut doc = NotebookDoc::new_with_actor("nb-1", "runtimed");
    doc.add_cell(0, "cell-a", "code").expect("add cell");
    assert!(!doc.is_pristine());
}

#[test]
fn emptied_notebook_is_not_pristine() {
    // add then delete every cell — current cell_count is 0, but history remains
    let mut doc = NotebookDoc::new_with_actor("nb-1", "runtimed");
    doc.add_cell(0, "cell-a", "code").expect("add cell");
    doc.delete_cell("cell-a").expect("delete cell");
    assert_eq!(doc.cell_count(), 0);
    assert!(
        !doc.is_pristine(),
        "an emptied notebook has cell history and must never be re-seeded"
    );
}

#[test]
fn notebook_with_metadata_is_not_pristine() {
    let mut doc = NotebookDoc::new_with_actor("nb-1", "runtimed");
    doc.set_metadata("trust", "trusted").expect("set metadata");
    assert!(!doc.is_pristine());
}

#[test]
fn overwritten_or_deleted_identity_key_is_not_pristine() {
    // A Put/Delete on an identity key AFTER creation is post-creation history,
    // not the creation scaffold: the predicate checks action + empty pred, so
    // these must read non-pristine even though obj==Root and the key matches.
    let mut overwritten = NotebookDoc::new_with_actor("nb-1", "runtimed");
    overwritten
        .doc
        .put(automerge::ROOT, "notebook_id", "nb-2")
        .expect("overwrite notebook_id");
    assert!(
        !overwritten.is_pristine(),
        "an overwrite of notebook_id has a non-empty pred and is not scaffold"
    );

    let mut deleted = NotebookDoc::new_with_actor("nb-1", "runtimed");
    deleted
        .doc
        .delete(automerge::ROOT, "runtime_state_doc_id")
        .expect("delete runtime_state_doc_id");
    assert!(
        !deleted.is_pristine(),
        "a delete of an identity key is an OpType::Delete, not a Put"
    );
}

#[test]
fn every_fresh_constructor_is_pristine() {
    // Guard: the allowlist is sound only while every creation path writes
    // nothing to ROOT except the two identity puts. Enumerate the public fresh
    // constructors so a future ROOT scaffolding put trips here instead of
    // silently shipping a notebook that never seeds.
    assert!(NotebookDoc::new("nb-1").is_pristine());
    assert!(NotebookDoc::new_with_actor("nb-1", "runtimed").is_pristine());
    assert!(
        NotebookDoc::new_with_encoding("nb-1", TextEncoding::UnicodeCodePoint).is_pristine()
    );
    // The cloud room host path: RoomHostHandle::create_empty -> new_with_actor.
    // Covered in runtimed-wasm (Task 3) where RoomHostHandle is in scope.
}
```

Note: `new` / `new_with_actor` / `new_with_encoding` return `NotebookDoc` (not `&mut`), and `is_pristine` is `&mut self`; bind to a `let mut` (as the other tests do) or call on a temporary `let mut d = ...; d.is_pristine()`. `NotebookDoc.doc` is a crate-private field, so the overwrite/delete tests reaching into `.doc.put` / `.doc.delete` only compile inside the `notebook-doc` crate's own test module - which is where these live. Confirm the exact helper names against the file before running - `delete_cell`, `set_metadata`, `new_with_encoding`, and `TextEncoding` all exist in this crate (`set_metadata` is exercised at `crates/runtimed-wasm/src/lib.rs:1906`); if a signature differs, use the in-crate equivalent, do not invent one.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p notebook-doc is_pristine -- --include-ignored`
Expected: FAIL to compile with "no method named `is_pristine`".

- [ ] **Step 3: Implement `is_pristine`**

Add the import alongside the existing automerge `use` at `crates/notebook-doc/src/lib.rs:92`:

```rust
use automerge::legacy::{Key as LegacyKey, ObjectId as LegacyObjectId, OpType as LegacyOpType};
```

Add the method inside `impl NotebookDoc`, next to `canonical_schema_seed_change_hashes` (around `lib.rs:2414`):

```rust
/// True when nothing beyond document creation has been applied: the change
/// graph contains only the canonical schema seed and the identity puts
/// (`notebook_id`, `runtime_state_doc_id`) that `new_with_actor` writes.
///
/// This is the host-authority seeding gate. Unlike a `cell_count()` check it
/// is derived from immutable history, so it is convergence-safe (no transient
/// empty view during sync misfires) and monotonic: once any cell or metadata
/// op lands, the document is never pristine again, including after a user
/// deletes every cell. See `docs/adr/0001-notebook-seeding-invariant.md`.
///
/// If document creation ever writes a new ROOT scaffolding key, add it to the
/// allowlist below (and to the constructor guard test).
pub fn is_pristine(&mut self) -> bool {
    // Sound fast path: a populated metadata snapshot means the document was
    // initialized (`get_metadata_snapshot` returns `Some` only for non-empty
    // metadata, so it never misfires on a fresh doc whose metadata Map is
    // empty). This is a pure optimization for the common already-seeded case;
    // the history walk below is what actually backstops metadata mutations.
    if self.doc.get_metadata_snapshot().is_some() {
        return false;
    }

    let seed: std::collections::HashSet<automerge::ChangeHash> =
        Self::canonical_schema_seed_change_hashes().into_iter().collect();

    for change in self.doc.get_changes(&[]) {
        if seed.contains(&change.hash()) {
            continue;
        }
        for op in change.decode().operations {
            // Only the *initial creation* of an identity key is allowed beyond
            // genesis: an inserting `Put` (empty `pred`) to ROOT's
            // `notebook_id` / `runtime_state_doc_id`. A delete or an overwrite
            // of those keys is post-creation history and must fail the gate.
            let is_creation_scaffold_put = matches!(op.action, LegacyOpType::Put(_))
                && op.pred.is_empty()
                && matches!(op.obj, LegacyObjectId::Root)
                && matches!(
                    &op.key,
                    LegacyKey::Map(k)
                        if k.as_str() == "notebook_id"
                            || k.as_str() == "runtime_state_doc_id"
                );
            if !is_creation_scaffold_put {
                return false;
            }
        }
    }
    true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p notebook-doc -- pristine`
Expected: PASS - `fresh_notebook_doc_is_pristine`, `notebook_with_a_cell_is_not_pristine`, `emptied_notebook_is_not_pristine`, `notebook_with_metadata_is_not_pristine`, `overwritten_or_deleted_identity_key_is_not_pristine`, `every_fresh_constructor_is_pristine` all ok.

- [ ] **Step 5: Commit**

```bash
git add crates/notebook-doc/src/lib.rs
git commit -m "feat(notebook-doc): add causal is_pristine seeding gate"
```

---

### Task 2: Switch the daemon to `is_pristine`

**Files:**
- Modify: `crates/runtimed/src/notebook_sync_server/load.rs:1063` (delete `is_uninitialized_notebook_doc`)
- Modify: `crates/runtimed/src/daemon.rs:2606`, `:2979`, `:3167` (call sites)
- Modify: `crates/runtimed/src/notebook_sync_server/tests.rs:3922` (delete dead test)

- [ ] **Step 1: Delete the daemon-local predicate**

Remove this function from `crates/runtimed/src/notebook_sync_server/load.rs` (lines 1063-1065):

```rust
pub fn is_uninitialized_notebook_doc(doc: &NotebookDoc) -> bool {
    doc.cell_count() == 0 && doc.get_metadata_snapshot().is_none()
}
```

- [ ] **Step 2: Update the three call sites**

In `crates/runtimed/src/daemon.rs`, each site holds `let mut doc = room.doc.write().await;`:

At `:2606` and `:2979`:
```rust
// was: if crate::notebook_sync_server::is_uninitialized_notebook_doc(&doc) {
if doc.is_pristine() {
```

At `:3167`:
```rust
// was: if !crate::notebook_sync_server::is_uninitialized_notebook_doc(&doc) {
if !doc.is_pristine() {
```

- [ ] **Step 3: Remove the dead daemon test**

Delete `test_is_uninitialized_notebook_doc` from `crates/runtimed/src/notebook_sync_server/tests.rs` (starts at line 3922). The predicate is now unit-tested in `notebook-doc` (Task 1); the daemon behavior is covered by the integration test in Task 4.

- [ ] **Step 4: Build and run the daemon sync tests**

Run: `cargo test -p runtimed --lib notebook_sync_server`
Expected: PASS, no reference to `is_uninitialized_notebook_doc` remains.

If the build fails with `Missing renderer plugin asset: ...sift.js` in a fresh worktree, copy the gitignored volatile bundle from a built checkout first: `cp <built-checkout>/apps/notebook/src/renderer-plugins/sift.js apps/notebook/src/renderer-plugins/sift.js` (and `crates/sift-wasm/pkg/sift_wasm_bg.wasm` if also required), then retry. Do not commit those assets.

- [ ] **Step 5: Commit**

```bash
git add crates/runtimed/src/notebook_sync_server/load.rs crates/runtimed/src/daemon.rs crates/runtimed/src/notebook_sync_server/tests.rs
git commit -m "refactor(runtimed): gate seeding on NotebookDoc::is_pristine"
```

---

### Task 3: Switch the cloud wasm host to `is_pristine`

**Files:**
- Modify: `crates/runtimed-wasm/src/lib.rs:480` (the guard) and the idempotency test around `lib.rs:3110`

- [ ] **Step 1: Update the guard**

In `seed_initial_code_cell_if_empty` (`crates/runtimed-wasm/src/lib.rs:479`):

```rust
pub fn seed_initial_code_cell_if_empty(&mut self, cell_id: &str) -> Result<bool, JsError> {
    // was: if self.doc.cell_count() > 0 {
    if !self.doc.is_pristine() {
        return Ok(false);
    }
    self.doc
        .add_cell_after(cell_id, "code", None)
        .map_err(|e| JsError::new(&format!("seed initial code cell failed: {e}")))?;
    Ok(true)
}
```

- [ ] **Step 2: Verify the existing idempotency test still holds**

The test `room_host_seeds_initial_code_cell_idempotently` (around `crates/runtimed-wasm/src/lib.rs:3110`) creates a host via `RoomHostHandle::create_empty`, seeds once (pristine -> seeds, returns true), then seeds again (now has a cell -> not pristine -> returns false). This matches `is_pristine`. No test change expected; confirm by reading it. If it asserted on `cell_count` semantics that diverge, adjust the assertion to the seed return values only.

Add one assertion to that test (or a sibling) completing the constructor-guard coverage from Task 1: a freshly created room host is pristine before any seed.

```rust
let mut host = RoomHostHandle::create_empty("demo", "system/schema:notebook-cloud-room")
    .expect("create room host");
assert!(host.doc.is_pristine(), "a brand-new room host is pristine");
```

(`host.doc` is accessible inside `runtimed-wasm`'s own test module; `is_pristine` is `&mut self`, so `host` must be `let mut`.)

- [ ] **Step 3: Run the wasm tests**

Run: `cargo test -p runtimed-wasm room_host_seeds_initial_code_cell_idempotently`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/runtimed-wasm/src/lib.rs
git commit -m "refactor(runtimed-wasm): gate room seeding on NotebookDoc::is_pristine"
```

---

### Task 4: Integration test - empty a notebook, reconnect, expect zero cells

**Files:**
- Test: `crates/runtimed/src/notebook_sync_server/tests.rs` (add near the existing `test_untitled_notebook_persists_through_eviction`)

This is the headline behavior the ADR calls out as only-indirectly-covered: a notebook a user empties must not be re-seeded on reconnect.

- [ ] **Step 1: Write the failing/asserting test**

Add a test mirroring the existing eviction/reconnect harness in this file (read `test_untitled_notebook_persists_through_eviction` for the exact daemon-room setup helpers; reuse them rather than constructing a daemon by hand):

```rust
#[tokio::test]
async fn emptied_untitled_notebook_is_not_reseeded_on_reconnect() {
    // 1. Create an untitled notebook room (daemon seeds one starter cell).
    // 2. Delete every cell so cell_count == 0 but history records the cells.
    // 3. Evict / drop the room, then reconnect (the NotebookSync path that
    //    calls doc.is_pristine()).
    // 4. Assert the reconnected room still has 0 cells — the daemon must NOT
    //    treat an emptied notebook as pristine.
    //
    // Use the same room/eviction helpers as
    // test_untitled_notebook_persists_through_eviction.
}
```

Fill the body using this file's existing helpers (the test above demonstrates room creation, cell access, eviction, and reconnect). Assert `connection_info.cell_count == 0` (or the doc's `cell_count()`) after reconnect.

- [ ] **Step 2: Run it to verify it passes against the Task 2 change**

Run: `cargo test -p runtimed --lib emptied_untitled_notebook_is_not_reseeded_on_reconnect`
Expected: PASS (the `is_pristine` walk sees the delete history and refuses to re-seed). If it FAILS by re-seeding, the predicate or the connect-path wiring regressed - debug before proceeding.

- [ ] **Step 3: Commit**

```bash
git add crates/runtimed/src/notebook_sync_server/tests.rs
git commit -m "test(runtimed): emptied notebook is not re-seeded on reconnect"
```

---

### Task 5: Promote the ADR and run the full gate

**Files:**
- Modify: `docs/adr/0001-notebook-seeding-invariant.md`

- [ ] **Step 1: Flip ADR status**

Change the header `- Status: Proposed` to `- Status: Accepted` and add a line under Consequences: "Implemented in <plan date>: `NotebookDoc::is_pristine` is the shared gate; `is_uninitialized_notebook_doc` and the cloud `cell_count > 0` guard are removed."

- [ ] **Step 2: Run the required pre-commit gate**

Run: `cargo xtask lint --fix`
Expected: "All checks passed" (or it auto-fixes formatting; re-stage if so).

- [ ] **Step 3: Run the touched crates' tests once more together**

Run: `cargo test -p notebook-doc -p runtimed-wasm && cargo test -p runtimed --lib notebook_sync_server`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/adr/0001-notebook-seeding-invariant.md
git commit -m "docs(adr): mark 0001 accepted"
```

---

## Self-review notes

- **Spec coverage:** ADR Decision (Option B) -> Task 1 (predicate in `notebook-doc`). ADR Consequence "one predicate for daemon and cloud" -> Tasks 2+3. ADR Consequence "remove `is_uninitialized_notebook_doc` and the cloud `cell_count > 0` guard" -> Tasks 2+3. ADR Open Question #1 (exact predicate / identity boundary) -> resolved: `{notebook_id, runtime_state_doc_id}` allowlist, verified both hosts create via `new_with_actor`. Open Question #2 (cost) -> resolved: `metadata.is_some()` fast path. Open Question #4 (test surface) -> Tasks 1 + 4.
- **Type consistency:** `is_pristine(&mut self) -> bool` used identically in Tasks 1-4. `LegacyKey`/`LegacyObjectId`/`LegacyOpType` aliases used only in Task 1.
- **Review fixes folded in (PR #3335):** the predicate matches `op.action` (`OpType::Put(_)`) and `op.pred.is_empty()`, not just `obj`/`key`, so a post-creation delete or overwrite of an identity key fails the gate (rgbkrk). Negative test `overwritten_or_deleted_identity_key_is_not_pristine` and constructor-guard test `every_fresh_constructor_is_pristine` cover the unenforced creation-path invariant (pullfrog). The metadata fast-path is documented as a pure optimization, not the metadata-case soundness mechanism (pullfrog).
- **Known verification point:** helper names (`delete_cell`, `set_metadata`, `add_cell_after`, `new_with_encoding`, `TextEncoding`, room/eviction test helpers) must be confirmed against the current files at implementation time; the plan flags each spot rather than guessing a signature.
