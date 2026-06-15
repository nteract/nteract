# CommsDoc Split: Implementation Plan (Phase 1 - Foundation)

- Status: Implementation plan (Draft)
- Implements: [ADR 0002 - CommsDoc split](../adr/0002-comms-document-split.md), Phase 1 of 4
- Date: 2026-06-04

> Status update, 2026-06-15: production CommsDoc sync/projection and the
> deterministic `NotebookDoc.comms_doc_id` pointer have landed. This document
> remains as the historical test-first implementation plan; its expected-failure
> steps describe the original sequence, not the current tree state.

Implement task-by-task, test-first: each task adds a failing test, the minimal code to pass it, and a commit. Checkbox (`- [ ]`) steps track progress. Every task is independently testable and ends green; the two crate lanes (notebook-doc, runtime-doc) are independent and can be built concurrently, joining at the final room task.

**Goal:** Lay the additive foundation for the CommsDoc split from ADR 0002 - a new `CommsDoc` Automerge document type, its frozen genesis seed, and the owner-only `comms_doc_id` identity pointer - with zero behavior change, so it ships green and de-risks the later phases.

**Architecture:** `CommsDoc` mirrors `RuntimeStateDoc`: a thin wrapper over an `AutoCommit` booted from a byte-identical frozen genesis seed, holding widget comm **state** keyed by comm_id. This plan creates the document type, its seed, its canonical-seed authorization helper, and the `comms_doc_id` pointer plumbing (derive / ensure / stamp / pristine-allowlist). Nothing reads or writes CommsDoc in production yet - the daemon dual-write, the carve-out deletion, the kernel-forward gate, and the frontend stream are later phases. CommsDoc lives as a new module in the existing `crates/runtime-doc` crate (same Automerge + automunge deps, same seed-generation harness), giving a clean document boundary without a new crate's wiring.

**Tech Stack:** Rust, automerge (nteract fork), `runtime-doc` / `notebook-doc` / `runtimed` crates, `cargo xtask` for the wasm/genesis build.

---

## Phase roadmap (where this plan sits)

ADR 0002 gates the full CommsDoc split on several invariants landing together. That makes it a four-phase effort, not one PR. This document is **Phase 1**. Phases 2-4 each get their own plan once their predecessor lands, because their task detail depends on the predecessor's outcome.

| Phase | Scope | Atomicity / dependency |
|---|---|---|
| **1. Foundation (this plan)** | CommsDoc type + frozen seed + `is_canonical_comms_seed_change` + `comms_doc_id` pointer (derive/ensure/stamp/pristine-allowlist) + seed registration. Purely additive, green, no behavior change. | None. Independently shippable. |
| 2. Daemon dual-write + invariants | Runtime writes comm state to CommsDoc; membership gate anchored to RuntimeStateDoc topology; re-home the three echo-suppression layers; GC authority + orphan-drop + delete ordering. | Depends on 1. Builds the gate that Phase 4's carve-out deletion is atomic with. |
| 3. Frontend stream + cloud transport | New sync-engine `commsState$` stream, `COMMS_SYNC` frame, room-host `receive_comms_sync`, checkpoint + late-join bootstrap; widget writes target CommsDoc. | Depends on 1 (pointer) and 2 (daemon authority). |
| 4. Flip + delete carve-out | Editors stop writing RuntimeStateDoc comm state; delete the `runtime_state_policy_snapshot` carve-out at **both** sites (`runtimed-wasm/src/lib.rs:696-697`, `peer_runtime_sync.rs:114-115`) and the `RuntimeStateWriteScope::Editor` comm exception; multi-principal integration test. | **Atomic with Phase 2's membership gate** per ADR 0002. Ships last. |

Phase 1 touches no read path and deletes no carve-out, so it cannot regress widgets. Every task below ends green.

---

## File structure (Phase 1)

- `crates/runtime-doc/src/comms_doc.rs` - **new.** The `CommsDoc` type: constructors from the frozen seed, the `comms/` state-map scaffold, `comms_doc_id` self-identity setter, and the canonical-seed helpers. One responsibility: be the CommsDoc document wrapper.
- `crates/runtime-doc/src/lib.rs` - add `mod comms_doc; pub use comms_doc::*;`.
- `crates/runtime-doc/assets/comms_genesis_v1.am` - **new, generated.** The frozen CommsDoc genesis bytes.
- `crates/notebook-doc/src/lib.rs` - add `default_comms_doc_id`, the `comms_doc_id` getter/setter/`ensure_`, extend the `is_pristine` ROOT allowlist, and the constructor-guard test.
- `crates/runtimed/src/notebook_sync_server/room.rs` - stamp `comms_doc_id` when a fresh room pairs its docs.
- `crates/xtask/src/main.rs` - register the comms seed in `GENESIS_SEEDS_IN_WASM`.

---

### Task 1: `default_comms_doc_id` + the `comms_doc_id` pointer on NotebookDoc

Mirror `runtime_state_doc_id` exactly: a stable derivation plus getter/setter/`ensure_`.

**Files:**
- Modify: `crates/notebook-doc/src/lib.rs` (derivation near `:119`; getter/setter/ensure near `:1415-1446`)
- Test: `crates/notebook-doc/src/lib.rs` (in-file `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `crates/notebook-doc/src/lib.rs`:

```rust
#[test]
fn default_comms_doc_id_is_derived_from_notebook_id() {
    assert_eq!(default_comms_doc_id("nb-1"), "comms:nb-1");
}

#[test]
fn ensure_comms_doc_id_derives_then_persists() {
    let mut doc = NotebookDoc::new_with_actor("nb-1", "runtimed");
    assert_eq!(doc.comms_doc_id(), None);
    let id = doc.ensure_comms_doc_id("nb-1").expect("ensure comms_doc_id");
    assert_eq!(id, "comms:nb-1");
    assert_eq!(doc.comms_doc_id(), Some("comms:nb-1".to_string()));
    // Idempotent: a second ensure returns the existing id, does not re-mint.
    assert_eq!(doc.ensure_comms_doc_id("nb-1").unwrap(), "comms:nb-1");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p notebook-doc comms_doc_id`
Expected: FAIL to compile, "cannot find function `default_comms_doc_id`" / "no method named `comms_doc_id`".

- [ ] **Step 3: Implement the derivation and accessors**

Next to `default_runtime_state_doc_id` (near `:119`):

```rust
/// Stable, deterministic CommsDoc id for a notebook. Mirrors
/// `default_runtime_state_doc_id` so the pointer never needs to be persisted
/// to be reconstructible: `comms:{notebook_id}`.
pub fn default_comms_doc_id(notebook_id: &str) -> String {
    format!("comms:{notebook_id}")
}
```

Add the type alias next to `RuntimeStateDocId` (`lib.rs:112`): `pub type CommsDocId = String;` (plain alias, so `read_str`'s `Option<String>` flows through with no conversion).

Next to the `runtime_state_doc_id` accessors (`:1414-1446`), add - mirroring `read_str` (the module-private free fn at `lib.rs:2815`) and `set_runtime_state_doc_id` exactly:

```rust
/// Read the owner-only `comms_doc_id` ROOT pointer, if stamped.
pub fn comms_doc_id(&self) -> Option<CommsDocId> {
    read_str(&self.doc, automerge::ROOT, "comms_doc_id")
}

/// Set the `comms_doc_id` ROOT pointer.
pub fn set_comms_doc_id(&mut self, comms_doc_id: &str) -> Result<(), AutomergeError> {
    self.doc.put(automerge::ROOT, "comms_doc_id", comms_doc_id)?;
    Ok(())
}

/// Read the existing `comms_doc_id`, or derive + write the default. Idempotent;
/// never mints a second id for an already-stamped notebook.
pub fn ensure_comms_doc_id(&mut self, notebook_id: &str) -> Result<CommsDocId, AutomergeError> {
    if let Some(existing) = self.comms_doc_id() {
        return Ok(existing);
    }
    let id = default_comms_doc_id(notebook_id);
    self.set_comms_doc_id(&id)?;
    Ok(id)
}
```

Note (verified against source): `read_str` and `automerge::ROOT` resolve in-module - do **not** add imports for them. There is no bare `ROOT` import; `put` comes from the already-imported `Transactable` trait; `AutomergeError` is already imported at `lib.rs:93`. The inner field is `self.doc: AutoCommit` (`lib.rs:285`). The setter argument is a named `&str`, not a local `id`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p notebook-doc comms_doc_id`
Expected: PASS - both tests ok.

- [ ] **Step 5: Commit**

```bash
git add crates/notebook-doc/src/lib.rs
git commit -m "feat(notebook-doc): add comms_doc_id identity pointer"
```

---

### Task 2: Extend the `is_pristine` allowlist for `comms_doc_id`

A freshly created notebook that stamps `comms_doc_id` must still read pristine, or it never gets its starter cell. ADR 0001's allowlist (`lib.rs:2471-2479`) and its invariant comment must grow by exactly this one scalar identity key.

**Files:**
- Modify: `crates/notebook-doc/src/lib.rs` (`is_pristine` allowlist near `:2471-2479`)
- Test: `crates/notebook-doc/src/lib.rs` (in-file tests)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn notebook_with_comms_doc_id_is_still_pristine() {
    // A fresh notebook that has stamped its comms_doc_id pointer must remain
    // pristine (gets a starter cell). comms_doc_id is a scalar identity put,
    // not structural content.
    let mut doc = NotebookDoc::new_with_actor("nb-1", "runtimed");
    doc.ensure_comms_doc_id("nb-1").expect("stamp comms_doc_id");
    assert!(
        doc.is_pristine(),
        "stamping comms_doc_id must not make a fresh notebook read as initialized"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p notebook-doc notebook_with_comms_doc_id_is_still_pristine`
Expected: FAIL - the `is_pristine` history walk hits the `comms_doc_id` ROOT put, which is not in the allowlist, and returns `false`.

- [ ] **Step 3: Add `comms_doc_id` to the allowlist and update the invariant comment**

The actual binding is named `is_identity_put` (the source was renamed from `is_creation_scaffold_put` before #3342 merged). Update the invariant comment (`lib.rs:2456-2460`) and extend the inner key match (`:2476-2479`). `LegacyKey`/`LegacyObjectId`/`LegacyOpType` are already imported at `lib.rs:87`; no import change.

```rust
// INVARIANT: this allowlist must stay limited to scalar identity
// pointers (notebook_id, runtime_state_doc_id, comms_doc_id) and must
// never grow to include `cells`, `metadata`, or any structural ROOT key.
// Those Maps are admitted only via the exact-hash genesis change, so a
// foreign actor that authors its own cells/metadata skeleton reads
// non-pristine. Allowlisting a structural key would let such a foreign
// skeleton read pristine and be wrongly re-seeded.
let is_identity_put = matches!(op.action, LegacyOpType::Put(_))
    && op.pred.is_empty()
    && matches!(op.obj, LegacyObjectId::Root)
    && matches!(
        &op.key,
        LegacyKey::Map(k)
            if k.as_str() == "notebook_id"
                || k.as_str() == "runtime_state_doc_id"
                || k.as_str() == "comms_doc_id"
    );
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p notebook-doc is_pristine`
Expected: PASS - the existing pristine tests and `notebook_with_comms_doc_id_is_still_pristine` all ok.

- [ ] **Step 5: Commit**

```bash
git add crates/notebook-doc/src/lib.rs
git commit -m "feat(notebook-doc): allow comms_doc_id in is_pristine scaffold allowlist"
```

---

### Task 3: Stamp `comms_doc_id` at construction and on migration load

`runtime_state_doc_id` is written at construction in `new_inner` (`lib.rs:1008-1013`) and backfilled on the forward-tolerant / migration load paths (`lib.rs:1258-1260`, `:1280`), so every notebook carries it whether or not a room ever touches it. Mirror that for `comms_doc_id`. This must land **after** Task 2 (the allowlist), or the existing `new_with_actor_is_pristine` test (`lib.rs:3329`) breaks the moment construction writes a non-allowlisted ROOT key. Do **not** bake the pointer into the frozen genesis seed (`NOTEBOOK_GENESIS_V5_BYTES`); it is a post-genesis put, exactly like `runtime_state_doc_id`.

**Files:**
- Modify: `crates/notebook-doc/src/lib.rs` (`new_inner` near `:1008-1013`; migration backfill near `:1258-1260` and `:1280`)
- Test: `crates/notebook-doc/src/lib.rs` (in-file tests)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn new_with_actor_stamps_comms_doc_id_and_stays_pristine() {
    let mut doc = NotebookDoc::new_with_actor("nb-1", "runtimed");
    assert_eq!(doc.comms_doc_id(), Some("comms:nb-1".to_string()));
    assert!(
        doc.is_pristine(),
        "a freshly constructed notebook stamps comms_doc_id and must still seed"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p notebook-doc new_with_actor_stamps_comms_doc_id`
Expected: FAIL - `comms_doc_id()` is `None` because `new_inner` does not write it yet.

- [ ] **Step 3: Write `comms_doc_id` in `new_inner` and backfill on migration**

In `new_inner`, immediately after the `runtime_state_doc_id` put (`lib.rs:1009-1013`):

```rust
doc.put(
    automerge::ROOT,
    "comms_doc_id",
    default_comms_doc_id(notebook_id),
)?;
```

At each existing `ensure_runtime_state_doc_id` backfill site on the load/migration paths (`lib.rs:1258-1260` and `:1280`), add the sibling call:

```rust
loaded.ensure_comms_doc_id(notebook_id)?;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p notebook-doc comms_doc_id is_pristine`
Expected: PASS - the new test, the Task 1/2 tests, and the existing `new_with_actor_is_pristine` all ok (the allowlist from Task 2 admits the new construction-time put).

- [ ] **Step 5: Commit**

```bash
git add crates/notebook-doc/src/lib.rs
git commit -m "feat(notebook-doc): stamp comms_doc_id at construction and migration"
```

---

### Task 4: The `CommsDoc` type and its frozen genesis seed

CommsDoc wraps an `AutoCommit` booted from a byte-identical frozen seed, mirroring `RuntimeStateDoc::try_new*` (`runtime-doc/src/doc.rs:364-413`). For Phase 1 it holds only the `comms` scaffold map and the `comms_doc_id` self-identity; the state read/write methods move in Phase 2.

Naming caveat: RuntimeStateDoc already has a `comms` sub-map and a `CommDocEntry` type (`doc.rs:276/322`) for the co-located topology+state. The new document deliberately keeps the ADR 0002 vocabulary (`CommsDoc`, `comms_doc_id`, an internal `comms` map of state). There is no Rust collision (distinct module/type), but be aware the two `comms` maps coexist until Phase 2 reduces RuntimeStateDoc's to topology-only. (If reviewers prefer disambiguation, `CommsStateDoc` / `comms_state_doc_id` is the fallback - but that diverges from the merged ADR, so this plan keeps `CommsDoc`.)

**Files:**
- Create: `crates/runtime-doc/src/comms_doc.rs`
- Modify: `crates/runtime-doc/src/lib.rs` (add `mod comms_doc; pub use comms_doc::*;`)
- Create (generated in Step 4): `crates/runtime-doc/assets/comms_genesis_v1.am`
- Test: `crates/runtime-doc/src/comms_doc.rs` (in-file tests)

- [ ] **Step 1: Write the failing tests**

In a new `crates/runtime-doc/src/comms_doc.rs`, add at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_seed_hashes_are_stable_and_nonempty() {
        let hashes = CommsDoc::canonical_seed_change_hashes();
        assert!(
            !hashes.is_empty(),
            "the frozen genesis must contribute at least one canonical change"
        );
    }

    #[test]
    fn comms_scaffold_is_present_after_boot() {
        let doc = CommsDoc::new_empty();
        assert!(doc.has_comms_map(), "the comms map must exist on a fresh CommsDoc");
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p runtime-doc comms_doc`
Expected: FAIL to compile - `CommsDoc` does not exist.

- [ ] **Step 3: Implement `CommsDoc` (seed loaded from a placeholder until Step 4 generates it)**

Create `crates/runtime-doc/src/comms_doc.rs`. Model the constructors on `RuntimeStateDoc` (`doc.rs:364-413`) and the seed loading on `schema_seed_doc()` (`doc.rs:432-434`):

```rust
//! CommsDoc: the document holding widget comm *state*, keyed by comm_id.
//!
//! Comm *topology* (target, model, owning cell, capture routing) stays in
//! RuntimeStateDoc and is daemon-authored. CommsDoc holds only the mutable
//! trait values, so it can be writable by anyone in the room without weakening
//! RuntimeStateDoc's all-or-nothing daemon ownership. See ADR 0002.
//!
//! Phase 1 (this module's first form) is the document shell only: the `comms`
//! scaffold map, the `comms_doc_id` self-identity, and the canonical-seed
//! authorization helpers. State read/write and the kernel-forward gate land in
//! Phase 2.

use automerge::transaction::Transactable;
use automerge::{AutoCommit, ChangeHash, ObjType, ReadDoc, ROOT};
use std::sync::OnceLock;

use crate::RuntimeStateError;

/// The frozen CommsDoc genesis. Generated by `write_comms_genesis_artifact`
/// (see the gated test below) and committed as an asset. Changing these bytes
/// changes the canonical seed hashes and is a schema event - do not edit by hand.
const COMMS_GENESIS_V1_BYTES: &[u8] =
    include_bytes!("../assets/comms_genesis_v1.am");

/// Actor that authors the canonical CommsDoc seed. Authorization keys on this
/// plus the exact frozen change hashes, mirroring NotebookDoc's SCHEMA_SEED_ACTOR.
pub const COMMS_SEED_ACTOR: &str = "nteract:comms-schema:v1";

/// A handle to a CommsDoc Automerge document.
pub struct CommsDoc {
    doc: AutoCommit,
}

impl CommsDoc {
    /// Daemon constructor: loads the frozen seed, sets the daemon actor.
    pub fn try_new() -> Result<Self, RuntimeStateError> {
        Self::try_new_with_actor("runtimed:comms")
    }

    /// Custom-actor constructor (runtime agent / room host).
    pub fn try_new_with_actor(actor_label: &str) -> Result<Self, RuntimeStateError> {
        let mut doc = Self::seed_doc()?;
        doc.set_actor(automerge::ActorId::from(actor_label.as_bytes()));
        Ok(Self { doc })
    }

    /// Read-only client bootstrap: frozen seed, random actor.
    pub fn try_new_empty() -> Result<Self, RuntimeStateError> {
        Ok(Self { doc: Self::seed_doc()? })
    }

    /// Unwrapping wrapper for `try_new_empty`, matching RuntimeStateDoc::new_empty.
    pub fn new_empty() -> Self {
        Self::try_new_empty().expect("canonical comms seed must load")
    }

    /// Wrap a pre-existing doc (snapshots, migrations, tests).
    pub fn from_doc(doc: AutoCommit) -> Self {
        Self { doc }
    }

    fn seed_doc() -> Result<AutoCommit, RuntimeStateError> {
        AutoCommit::load(COMMS_GENESIS_V1_BYTES).map_err(RuntimeStateError::from)
    }

    /// True once the `comms` scaffold map exists.
    pub fn has_comms_map(&self) -> bool {
        matches!(self.doc.get(ROOT, "comms"), Ok(Some((_, _))))
    }

    /// Cached canonical seed change hashes (the frozen genesis changes).
    pub fn canonical_seed_change_hashes() -> &'static [ChangeHash] {
        static HASHES: OnceLock<Vec<ChangeHash>> = OnceLock::new();
        HASHES
            .get_or_init(|| {
                let doc = AutoCommit::load(COMMS_GENESIS_V1_BYTES)
                    .expect("canonical comms seed must load");
                doc.get_heads()
            })
            .as_slice()
    }

    /// Borrow the underlying doc (for sync wiring in later phases).
    pub fn doc_mut(&mut self) -> &mut AutoCommit {
        &mut self.doc
    }
}
```

Add to `crates/runtime-doc/src/lib.rs` near the other `mod`/`pub use` lines:

```rust
mod comms_doc;
pub use comms_doc::*;
```

Note (verified): `RuntimeStateError` lives at `crates/runtime-doc/src/error.rs` and derives `From<automerge::AutomergeError>` via thiserror's `#[from]` (`error.rs:11-12`), so `.map_err(RuntimeStateError::from)` resolves exactly as `doc.rs:433` does. The crate is `runtime_doc`; import within-crate as `crate::RuntimeStateError`.

- [ ] **Step 4: Generate the frozen genesis asset**

The seed cannot be hand-written. Mirror RuntimeStateDoc's generator (`doc.rs:3696-3702`). **Deterministic hashes are mandatory** - every peer must load a byte-identical seed - so the generator pins both the actor (`COMMS_SEED_ACTOR`) and the commit time to 0 via `commit_with`. Add a gated, ignored test to `comms_doc.rs`:

```rust
#[cfg(test)]
#[test]
#[ignore = "regenerates the committed genesis asset; run explicitly"]
fn write_comms_genesis_artifact() {
    use automerge::transaction::CommitOptions;
    let Some(path) = std::env::var_os("COMMS_GENESIS_OUT") else { return };
    let mut doc = AutoCommit::new();
    doc.set_actor(automerge::ActorId::from(COMMS_SEED_ACTOR.as_bytes()));
    // The canonical scaffold: an empty `comms` map keyed by comm_id.
    doc.put_object(ROOT, "comms", ObjType::Map).expect("scaffold comms map");
    // Pin the change time so the genesis change hash is reproducible.
    doc.commit_with(CommitOptions::default().with_time(0));
    std::fs::write(path, doc.save()).expect("write comms genesis");
}
```

Note: `COMMS_SEED_ACTOR` must be a runtime `pub const` (not `cfg(test)`-only) because Task 5's `is_canonical_comms_seed_change` reads it at runtime - this is where CommsDoc diverges from RuntimeStateDoc, which has no canonical-seed helper and keeps its seed actor test-only.

`include_bytes!` needs the file present before `comms_doc.rs` compiles, so generate the bytes out-of-band, then commit the asset and the `include_bytes!` line together:

```bash
mkdir -p crates/runtime-doc/assets
printf '' > crates/runtime-doc/assets/comms_genesis_v1.am   # placeholder so the crate compiles
COMMS_GENESIS_OUT=crates/runtime-doc/assets/comms_genesis_v1.am \
  cargo test -p runtime-doc write_comms_genesis_artifact -- --ignored --exact
test -s crates/runtime-doc/assets/comms_genesis_v1.am        # assert non-empty
```

If the empty placeholder makes `seed_doc()`'s `AutoCommit::load` fail before generation, temporarily fall back to `AutoCommit::new()` when the bytes are empty, generate, then remove the fallback.

Add two guard tests so a future edit to the asset is caught:

```rust
#[test]
fn comms_genesis_matches_expected_scaffold() {
    // Round-trip: a fresh doc has exactly the `comms` map and nothing else.
    let doc = CommsDoc::new_empty();
    assert!(doc.has_comms_map());
}

#[test]
fn comms_genesis_is_a_single_canonical_change() {
    assert_eq!(
        CommsDoc::canonical_seed_change_hashes().len(),
        1,
        "the frozen genesis must be exactly one change; regenerate if this fails"
    );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p runtime-doc comms_doc`
Expected: PASS - `new_empty_boots_from_canonical_seed` and `comms_scaffold_is_present_after_boot` ok.

- [ ] **Step 6: Commit (asset included)**

```bash
git add crates/runtime-doc/src/comms_doc.rs crates/runtime-doc/src/lib.rs crates/runtime-doc/assets/comms_genesis_v1.am
git commit -m "feat(runtime-doc): add CommsDoc type and frozen genesis seed"
```

---

### Task 5: Canonical-seed authorization helper for CommsDoc

CommsDoc is multi-principal (anyone in the room may write it in later phases), so it needs an `is_canonical_comms_seed_change` mirroring `is_canonical_schema_seed_change` (`notebook-doc/src/lib.rs:2496-2504`) - the seed actor may converge the canonical root objects, but only for the exact frozen hashes.

**Files:**
- Modify: `crates/runtime-doc/src/comms_doc.rs`
- Test: `crates/runtime-doc/src/comms_doc.rs` (in-file tests)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn canonical_seed_change_is_recognized_only_for_seed_actor_and_frozen_hash() {
    let frozen = CommsDoc::canonical_seed_change_hashes()[0];
    assert!(
        CommsDoc::is_canonical_comms_seed_change(COMMS_SEED_ACTOR, &frozen),
        "seed actor authoring the frozen change is canonical"
    );
    assert!(
        !CommsDoc::is_canonical_comms_seed_change("some:editor", &frozen),
        "a non-seed actor is never canonical, even on the frozen hash"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p runtime-doc canonical_seed_change_is_recognized`
Expected: FAIL to compile - no `is_canonical_comms_seed_change`.

- [ ] **Step 3: Implement the helper**

In `impl CommsDoc`:

```rust
/// True iff `actor_label` is the canonical comms seed actor AND `hash` is one
/// of the frozen genesis change hashes. Lets the seed actor converge the
/// canonical root objects without granting it arbitrary authority. Mirrors
/// NotebookDoc::is_canonical_schema_seed_change.
pub fn is_canonical_comms_seed_change(actor_label: &str, hash: &ChangeHash) -> bool {
    actor_label == COMMS_SEED_ACTOR
        && Self::canonical_seed_change_hashes().contains(hash)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p runtime-doc canonical_seed_change_is_recognized`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-doc/src/comms_doc.rs
git commit -m "feat(runtime-doc): add is_canonical_comms_seed_change authorization helper"
```

---

### Task 6: `comms_doc_id` self-identity setter on CommsDoc

RuntimeStateDoc carries its own `runtime_state_doc_id` self-identity (`doc.rs:2271-2276`). Mirror it so the room can stamp the CommsDoc's identity when pairing.

**Files:**
- Modify: `crates/runtime-doc/src/comms_doc.rs`
- Test: `crates/runtime-doc/src/comms_doc.rs` (in-file tests)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn comms_doc_id_roundtrips() {
    let mut doc = CommsDoc::new_empty();
    assert_eq!(doc.comms_doc_id(), None);
    doc.set_comms_doc_id(Some("comms:nb-1")).expect("set id");
    assert_eq!(doc.comms_doc_id(), Some("comms:nb-1".to_string()));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p runtime-doc comms_doc_id_roundtrips`
Expected: FAIL to compile - no `set_comms_doc_id` / `comms_doc_id` on CommsDoc.

- [ ] **Step 3: Implement getter and setter**

In `impl CommsDoc`. There is no `Value::into_string()` in this fork; the working pattern (mirroring RuntimeStateDoc's `read_opt_str` / `set_optional_str`, `doc.rs:2271-2276`) matches `Value::Scalar` → `ScalarValue::Str`:

```rust
use automerge::{ScalarValue, Value};

/// Read the CommsDoc's self-identity pointer, if stamped.
pub fn comms_doc_id(&self) -> Option<String> {
    match self.doc.get(ROOT, "comms_doc_id") {
        Ok(Some((Value::Scalar(s), _))) => match s.as_ref() {
            ScalarValue::Str(s) => Some(s.to_string()),
            _ => None,
        },
        _ => None,
    }
}

/// Stamp (or clear) the CommsDoc self-identity. `None` writes an explicit null.
pub fn set_comms_doc_id(&mut self, id: Option<&str>) -> Result<(), RuntimeStateError> {
    match id {
        Some(id) => self.doc.put(ROOT, "comms_doc_id", id)?,
        None => self.doc.put(ROOT, "comms_doc_id", ScalarValue::Null)?,
    }
    Ok(())
}
```

Note: if you instead keep CommsDoc in `doc.rs` alongside RuntimeStateDoc, prefer reusing the existing private `read_opt_str` / `set_optional_str` helpers (`doc.rs:2271-2276`) verbatim rather than re-deriving the match. As a separate module they are out of scope, so the inline match above is correct.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p runtime-doc comms_doc_id_roundtrips`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/runtime-doc/src/comms_doc.rs
git commit -m "feat(runtime-doc): add comms_doc_id self-identity to CommsDoc"
```

---

### Task 7: Register the comms seed in the wasm build

The wasm bundle embeds every frozen seed and verifies it at build time, or an old wasm ships the wrong seed (the #3086 zeroing footgun). Add CommsDoc to `GENESIS_SEEDS_IN_WASM` (`crates/xtask/src/main.rs:1509-1518`); the existing `genesis_seeds_embedded` loop (`:1575`) verifies it with no further code.

**Files:**
- Modify: `crates/xtask/src/main.rs:1509-1518`

- [ ] **Step 1: Add the seed entry**

In the `GENESIS_SEEDS_IN_WASM` array, after the runtime-state entry:

```rust
const GENESIS_SEEDS_IN_WASM: &[(&str, &str)] = &[
    ("notebook genesis", "crates/notebook-doc/assets/notebook_genesis_v5.am"),
    ("runtime-state genesis", "crates/runtime-doc/assets/runtime_state_genesis_v2.am"),
    ("comms genesis", "crates/runtime-doc/assets/comms_genesis_v1.am"),
];
```

- [ ] **Step 2: Rebuild wasm and verify genesis embedding**

Run: `cargo xtask wasm runtimed` then `cargo xtask verify-genesis` (per `cmd_verify_genesis`, `main.rs:1525`).
Expected: verify-genesis passes, reporting all three seeds (including "comms genesis") embedded in the wasm binary.

- [ ] **Step 3: Commit**

```bash
git add crates/xtask/src/main.rs
git commit -m "build(xtask): embed and verify the comms genesis seed in wasm"
```

---

### Task 8: Pair `comms_doc_id` when a fresh room is created

A fresh room derives `runtime_state_doc_id` and stamps it onto both NotebookDoc and RuntimeStateDoc. The production path is `new_fresh_with_trusted_packages` (`room.rs:787`); `new_fresh` (`:764`) is a `#[cfg(test)]` wrapper that delegates to it. The room holds each doc behind a handle (a `RuntimeStateHandle`-style wrapper over the doc + a `broadcast` sender). Add the symmetric `comms_doc_id` stamping and a resident `comms` handle. Still no read/write of comm state - just the pointer.

**Files:**
- Modify: `crates/runtimed/src/notebook_sync_server/room.rs`: the `NotebookRoom` struct (`:682-748`), `new_fresh_with_trusted_packages` (`:787`), the production `Self { ... }` literal (`:924-944`), and the `#[cfg(test)]` `load_or_create` `Self { ... }` literal (near `:1031`)
- Test: `crates/runtimed/src/notebook_sync_server/tests.rs`

- [ ] **Step 1: Write the failing test**

There is no `docs()` accessor; assert via direct field reads, mirroring the existing `runtime_state_doc_id` assertions at `tests.rs:316-328` / `:466-479` (read the room's `doc` and `comms` handles the same way those tests read `doc` and `state`). Pattern:

```rust
#[test]
fn fresh_room_pairs_comms_doc_id() {
    let room = /* build a fresh room exactly as the runtime_state_doc_id pairing test does */;
    let notebook_comms_id = { room.doc.try_read().unwrap().comms_doc_id() };
    assert_eq!(notebook_comms_id, Some(notebook_doc::default_comms_doc_id("test-nb")));
    let comms_self_id = { room.comms.read(/* same lock pattern as room.state */).comms_doc_id() };
    assert_eq!(comms_self_id, Some(notebook_doc::default_comms_doc_id("test-nb")));
}
```

Match the exact lock/read shape used for `room.state` in the cited tests - do not invent a helper. Confirm whether the field is `room.comms` and whether reads go through `.read()` / `.try_read()` against the same wrapper type as `room.state`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p runtimed fresh_room_pairs_comms_doc_id`
Expected: FAIL to compile - `NotebookRoom` has no `comms` field yet.

- [ ] **Step 3: Add the `comms` handle and stamp it in `new_fresh_with_trusted_packages`**

Add a `comms` field to the `NotebookRoom` struct (`:682-748`), typed like the `state` field's handle. In `new_fresh_with_trusted_packages` (`:787`), next to the `runtime_state_doc_id` ensure:

```rust
let runtime_state_doc_id = doc.ensure_runtime_state_doc_id(&notebook_id_str)?;
let comms_doc_id = doc.ensure_comms_doc_id(&notebook_id_str)?;
```

Where the RuntimeStateDoc + its handle are built, build the CommsDoc symmetrically (mirror the `state_doc` + `broadcast::channel` + handle construction exactly):

```rust
let mut comms_doc = CommsDoc::try_new().map_err(/* same error map as state_doc */)?;
comms_doc.set_comms_doc_id(Some(&comms_doc_id)).map_err(/* same */)?;
let (comms_tx, _comms_rx) = tokio::sync::broadcast::channel(/* same capacity as state */);
let comms = /* RuntimeStateHandle-analog wrapping comms_doc + comms_tx */;
```

Populate the new `comms` field in **both** `Self { ... }` literals: the production one (`:924-944`) and the `#[cfg(test)]` `load_or_create` one (near `:1031`). Missing the second breaks the build. The handle is resident and untouched by sync until Phase 3.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p runtimed fresh_room_pairs_comms_doc_id`
Expected: PASS.

- [ ] **Step 5: Run the full crate test suites and lint**

Run:
```bash
cargo test -p notebook-doc -p runtime-doc -p runtimed
cargo xtask lint --fix
```
Expected: all green; lint clean (CI rejects unformatted PRs).

- [ ] **Step 6: Commit**

```bash
git add crates/runtimed/src/notebook_sync_server/room.rs crates/runtimed/src/notebook_sync_server/tests.rs
git commit -m "feat(runtimed): pair comms_doc_id when creating a fresh room"
```

---

## Phase 1 acceptance

- `cargo test -p notebook-doc -p runtime-doc -p runtimed` green.
- `cargo xtask wasm runtimed && cargo xtask verify-genesis` reports the comms seed embedded.
- A fresh notebook is still `is_pristine` after stamping `comms_doc_id` and still gets exactly one starter cell (Task 2 + the existing seeding tests).
- No read path changed, no carve-out deleted: widgets behave exactly as before. The `CommsDoc` is created and paired but inert.

## Subsequent plans (not in this document)

Each is written as its own `docs/adr/` implementation-plan doc once its predecessor merges, because the task detail depends on the predecessor's landed shape:

- **Phase 2 - daemon dual-write + invariants.** Move the comm-state methods (`put_comm`/`set_comm_state_property`/`merge_comm_state_delta`/`remove_comm`/`clear_comms`, `doc.rs:2467-2629`) and the per-field LWW echo helper (`doc.rs:3127-3219`) onto CommsDoc; anchor the kernel-forward membership gate (`runtime_agent.rs:1495-1522`) to RuntimeStateDoc topology; re-home all three echo-suppression layers (LWW-authorship, the `EchoSuppressor` at `runtime_agent/echo_suppression.rs`, the no-op scalar skip) with a CI guard covering actor **and** content-hash echoes; give the daemon CommsDoc write authority and add the orphan-drop GC pass with state-before-topology delete ordering.
- **Phase 3 - frontend stream + cloud transport.** Add the `commsState$` stream (`packages/runtimed/src/sync-engine.ts`), the `COMMS_SYNC` frame type, the room-host `receive_comms_sync` (mirror `runtimed-wasm/src/lib.rs:663-733`), checkpoint + late-join bootstrap (`room-materializer.ts`), and point widget writes at CommsDoc.
- **Phase 4 - flip + delete carve-out (atomic with Phase 2's gate).** Editors stop writing RuntimeStateDoc comm state; delete the `runtime_state_policy_snapshot` carve-out at both sites and the `RuntimeStateWriteScope::Editor` comm exception; add the multi-principal (editor + runtime_peer) integration test for the actor-prefix forward-path blind spot.
