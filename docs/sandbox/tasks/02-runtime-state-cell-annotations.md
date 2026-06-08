# Task 02: Add `cell_annotations` to RuntimeStateDoc

## Framing

The error enrichment pipeline (task 08) needs a place to store sandbox events without polluting cell output. This task adds a `cell_annotations` map to `RuntimeStateDoc`, follows the existing `workstation` precedent, and provides Rust setter/reader APIs plus matching TypeScript bindings.

This is a small, scoped CRDT schema change. It blocks tasks 08, 09, and 11.

## Context to read

- `docs/sandbox/decisions.md` — especially **D-7** (error enrichment storage)
- `docs/sandbox/error-routing-design.md` — section "Where enrichment annotations live" and "Decision 3"
- `crates/runtime-doc/AGENTS.md` if it exists; otherwise read the schema comment at the top of `crates/runtime-doc/src/doc.rs` (lines 7–86)

**Do not read** other task files in `docs/sandbox/tasks/`.

## Background

`RuntimeStateDoc` is an Automerge CRDT document. Two patterns exist for adding fields:

- **Pattern A (genesis fields):** part of the genesis scaffold, present in every fresh doc. Requires updating `scaffold_runtime_state_schema`, regenerating genesis bytes, and bumping `RUNTIME_STATE_SCHEMA_VERSION`.
- **Pattern B (post-genesis fields):** written lazily by the daemon via `get_or_create_root_map(...)`. No genesis change, no version bump, no migration. Old clients see `None`/`{}`.

`cell_annotations` follows **Pattern B**, identical to the existing `workstation` field (commit `5ae25e58` is the canonical precedent).

Each annotation is keyed by `execution_id` and contains:
- `kind`: short machine-readable tag (e.g. `"sandbox_http_block"`, `"sandbox_credential_missing"`, `"sandbox_proxy_degraded"`)
- `message`: human-readable enrichment string
- `details`: optional structured JSON payload

## Technical steps

### 1. Add the Rust types

In `crates/runtime-doc/src/doc.rs` (or a new types submodule if cleaner):

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CellAnnotation {
    pub kind: String,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}
```

Add to `RuntimeState`:

```rust
#[serde(default)]
pub cell_annotations: HashMap<String, CellAnnotation>,
```

### 2. Add reader and writer methods on `RuntimeStateDoc`

```rust
pub fn set_cell_annotation(
    &mut self,
    execution_id: &str,
    annotation: &CellAnnotation,
) -> Result<(), RuntimeStateError>;

pub fn remove_cell_annotation(
    &mut self,
    execution_id: &str,
) -> Result<(), RuntimeStateError>;

fn read_cell_annotations(&self) -> HashMap<String, CellAnnotation>;
```

The setter must use `get_or_create_root_map("cell_annotations")` exactly like `workstation` does. The reader must return `HashMap::new()` when the map is absent (old documents).

### 3. Wire into `read_state()`

Add `cell_annotations: self.read_cell_annotations()` to the `RuntimeState` constructed in `read_state()` (around `doc.rs:3075`).

### 4. Clean up on execution trim

In `trim_executions_preserving` (around `doc.rs:2188`), call `self.remove_cell_annotation(&exec_id)` for each trimmed execution to avoid orphan entries.

### 5. Decide on fingerprint inclusion

In `crates/runtime-doc/src/projection.rs`, the `execution_fingerprint()` function determines whether the frontend re-renders when a value changes. Sandbox annotations **should** trigger re-renders (the cell needs to show the overlay when the annotation arrives), so include the annotation hash in the fingerprint for the matching execution_id.

If unsure, follow what `submitted_by_actor_label` does (added in commit `802dbe93`).

### 6. TypeScript bindings

In `packages/runtimed/src/runtime-state.ts` (hand-written, no codegen):

```typescript
export interface CellAnnotation {
  kind: string;
  message: string;
  details?: unknown;
}

// Add to RuntimeState interface:
cell_annotations: Record<string, CellAnnotation>;

// Add to DEFAULT_RUNTIME_STATE:
cell_annotations: {},
```

### 7. Tests

- Unit test: round-trip a single annotation through set/get
- Unit test: setting twice overwrites
- Unit test: `read_state()` on a doc with no annotations returns `{}` (backward compat)
- Unit test: `trim_executions_preserving` removes annotations for trimmed executions
- Unit test: fingerprint changes when annotation is added/changed

## Interfaces produced

- `runtime_doc::CellAnnotation` Rust type
- `RuntimeStateDoc::set_cell_annotation`, `remove_cell_annotation`
- `RuntimeState.cell_annotations: HashMap<String, CellAnnotation>` field
- `CellAnnotation` TS type and `cell_annotations` field on `RuntimeState`

These are consumed by tasks 08 (writes), 09 (reads via MCP), and 11 (reads via UI).

## Success criteria

- `cargo xtask lint --fix` passes
- All existing `runtime-doc` tests pass
- New tests cover round-trip, backward compat (old genesis), trim cleanup, and fingerprint behavior
- TypeScript types compile and the frontend builds without changes outside the bindings file
- A doc with no annotations field deserializes to `cell_annotations: {}` in both Rust and TypeScript

## In scope

- The CRDT schema additions (Rust + TS)
- Reader, writer, and trim cleanup
- Fingerprint integration in `projection.rs`
- Unit tests for the new APIs

## Out of scope

- Any code that *writes* annotations from the daemon — that is task 08
- Any UI rendering of annotations — that is task 11
- Any MCP tool surface — that is task 09
- Modifying genesis bytes or `RUNTIME_STATE_SCHEMA_VERSION` (Pattern B does not require this)
- Adding annotation kinds beyond defining the open string field — task 08 owns the taxonomy
- Persisting annotations to the notebook export — annotations are ephemeral runtime state, never written to `.ipynb`
