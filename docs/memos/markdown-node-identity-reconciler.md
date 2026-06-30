# Stable Node Identity: a sequence-alignment reconciler for the markdown plan

**Status:** Proposed. Step 1 of mid's node-granular render (mid ADR 0002).

## Objective

Node identity in the markdown plan is derived from byte offsets, so any edit
above or inside a block renames that block and every block after it. The plan
mints ids at one chokepoint:

```rust
// crates/nteract-markdown-engine/src/lib.rs:586
fn node_id(kind: NodeKind, span: &SourceSpan) -> String {
    format!("node:{kind:?}:{}:{}", span.start, span.end)
}
```

Anchors, isolated regions, and inline runs all clone that id, so the offset
leaks everywhere. Type one character at the top of a document and the projected
plan reports every downstream block as new. A consumer that keys on the id (mid
keys React on it) unmounts and remounts the whole subtree and resets component
state.

That is the single thing blocking node-granular render. The goal on mid's side
is that a prose or math edit re-projects, diffs at block granularity, and
re-renders just the changed node while live component state around it survives.
That is only possible if a node keeps its identity across a reparse. This memo
covers the engine half: replace offset-derived identity with stable, plan-owned
ids that carry forward.

This is step 1 and the load-bearing risk. The reconciler is greenfield and
everything downstream (change-highlight correctness, patch-not-remount, the
future `data-mdxid` correlation) is correct only if alignment is correct. It
gets proven first, in isolation, before any consumer wires up.

## Why identity lives in the plan

The markdown plan is shared surface area. Notebooks, Markdown Plan work, and mid
all consume the same projector. Identity for the markdown half belongs in the
plan so it travels to every surface, rather than each one re-deriving it. mid
consumes plan-assigned ids. The executable-MDX half (JSX, components,
expressions) stays consumer-specific and never crosses into the plan.

## Decision

Identity becomes position-after-alignment, carried across reparses. The previous
plan is handed back in as a consumer-owned, engine-opaque snapshot through one
additive C-ABI export. The five existing wasm exports and `LAST_OUTPUT` stay
byte-for-byte, so consumers opt in rather than being force-migrated. The engine
stays a pure function of `(source, previous-snapshot)`, which means the whole
identity matrix runs as FFI-free `cargo` tests.

### Three phases

A new `project_markdown_reconciled(source, options, &prev) -> (MarkdownPlan, ReconcilerSnapshot)`:

1. **Build.** Run `project_node` as today, but leave `ProjectedNode.id` empty and
   defer anchor and isolated-region emission. This drops the provisional-id
   remap and the `SourceSpan::empty()` id collision.
2. **Reconcile.** Assign ids top-down. One recursive `reconcile_children` runs at
   every children list (blocks, then list items / table rows / cells, then inline
   runs), so block and inline ids fall out of the same pass. Root keeps the
   literal `"root"`; only its children align.
3. **Finalize.** A document-order DFS over the now-id-stable tree rebuilds
   anchors (`block_id = node.id`), isolated regions (`id = "isolation:" + node.id`),
   and the heading-slug counter, then serializes the new snapshot from
   `MarkdownPlan.root`. The snapshot is built from the projected tree the aligner
   walks, never from the flattened block/run view.

### The identity policy is a two-tier predicate

- `eq(a, b)` = `(kind, lane, iso, isolation_tag)` equal **and** `content_hash`
  equal. This is the unchanged-anchor test that trim and LCS anchor on.
- `compat(a, b)` = `(kind, lane, iso, isolation_tag)` equal, content may differ.
  This is the edit-inside-vs-replace gate only.

Content decides changed-vs-unchanged, never identity. Identity is always
alignment position plus `compat`. Duplicates (two `---`, two `## Notes`, two
identical `$x$`) are disambiguated by order, which alignment gives for free, not
by content.

### The aligner

`reconcile_children` is: ambiguity-guarded two-ended trim under `eq`, then LCS on
the residual middle under `eq` with match-late backtrack, then a
`content_hash`-keyed in-order move match on the LCS leftovers, then a
front-surplus-aware positional zip under `compat`, then mint fresh for anything
left. A node matched under `eq` has an equal `content_hash`, so its subtree is
byte-identical and its ids are preserved without recursing. Only `compat` carries
(content differs) recurse to re-align changed children. The common keystroke
trims to unchanged anchors and recurses into exactly one edited block.

### Two corrections the adversarial pass forced

The first design broke on four of eight edit scenarios. Both fixes are now
load-bearing:

1. **`content_hash` must be a recursive Merkle digest**, folding
   `kind, lane, iso, isolation_tag`, the rendering-salient attrs, `copy_text` for
   leaves, and each child's hash in document order. A flat `copy_text`-plus-attrs
   scalar made a formatting-only edit (`the cat sat` to `the *cat* sat`) and a
   same-text reorder (`**alpha**` vs `alpha`) compare equal at the parent, which
   silently dropped the edit and collapsed the reorder to a positional no-op. The
   invariant "equal `content_hash` implies subtree byte-identical" is exactly what
   the subtree short-circuit and the `eq` anchor depend on.
2. **The structural tuple widens to include `isolation_tag`**, a new
   `NodeAttrs.isolation_tag` carrying the MDX component name or active-HTML
   element tag. Without it, `<Frog/>` to `<Banana/>` and `<video>` to `<iframe>`
   (same `IsolationKind`) are `compat` and alias a portal node through a shared
   id instead of remounting.

### Insert-direction bias

The front-surplus zip hard-codes an insert-above preference: when the new
children have surplus leading nodes with no `eq` match, those mint fresh before
the remainder zips under `compat`, so a block inserted above an edited block does
not steal the edited block's id. This provably sacrifices the symmetric
insert-below-adjacent-to-edit direction. Both directions are pinned with tests,
so the bias is accepted, regression-locked behavior, not emergent.

### FFI threading

The snapshot rides out inside the existing result JSON under one new
`"reconciler"` field (a base64-wrapped, hand-rolled wire blob: magic and version,
`next_id`, then preorder records reconstructed by child count). It rides back in
through a second consumer-owned buffer on the new export
`nteract_markdown_project_reconcile`. `from_wire` is total: a version skew or
malformed bytes return `Default` (cold start, every node fresh), never a panic,
mirroring the `from_utf8` discipline already in the wasm layer. The consumer
treats the token as opaque and never parses it.

## Behavioral coverage

The whole matrix is FFI-free. Each test calls `project_markdown_reconciled`
twice, threading the first snapshot into the second call.

| Test | Pins |
| --- | --- |
| `insert_above_keeps_following_ids` | Offsets shift, following block and inline ids byte-for-byte equal, one fresh id at the top. |
| `insert_above_with_duplicates_no_misassign` | The ambiguity guard stops trim preempting LCS; exactly one remount in a duplicate run, existing ids preserved in order. |
| `insert_below_with_duplicates_pins_direction` | The sacrificed insert-below direction, regression-locked. |
| `edit_inside_text_keeps_id` | `compat` carries the block id; content_hash differs; one run re-aligns. |
| `edit_inside_formatting_only_merkle` | Merkle hash catches a `copy_text`-invariant edit a flat hash drops. |
| `reorder_tracks_moved_block` | LCS anchor plus keyed move; neither id stays positional. |
| `reorder_same_copytext_diff_structure` | Merkle differs at the boundary; no positional no-op, no inline-subtree graft. |
| `replace_cross_kind_new_id` | Cross-kind replace mints fresh; retired id never reused. |
| `replace_isolated_component_remounts` | `isolation_tag` makes `<Frog/>` to `<Banana/>` non-compat; region id is fresh. |
| `lane_flip_deliberate_remount` | A block crossing into Isolated mints fresh; neighbors preserved. |
| `inline_insert_before_identical_math` | Two identical `$x$` runs keep order, no crossing. |
| `offset_decoupling_nonheading` | All later block and inline ids equal while spans shift. |
| `offset_decoupling_heading_slug_renumber` | Node id stable; only the slug-derived anchor own-id renumbers, by design. |
| `link_reference_definition_insert_above_variant_b` | A new link-ref def above does not steal the downstream paragraph's id. |
| `cold_start_all_fresh` | Empty token and the stateless path both mint fresh from 1; root is `"root"`. |
| `snapshot_wire_roundtrip_total` | Round-trip is faithful; malformed or skewed bytes return `Default`, never panic. |

## Open decisions to ratify

- **FFI shape.** The additive `nteract_markdown_project_reconcile` with an opaque
  snapshot in the result JSON, over widening `project()` to four args (breaks the
  frozen ABI) or a wasm session handle (long-lived mutable state, leak surface,
  breaks pure-function testability). Recommended: the additive export.
- **Id representation.** Keep `String` ids (`node:{n}`); consumers treat them as
  opaque keys, so the wire shape is free. Integers save a few bytes per node at
  the cost of a consumer-side stringify.
- **Snapshot encoding.** Hand-rolled little-endian `to_wire`/`from_wire` (no new
  dep, new parser surface to fuzz) vs adding `serde_json` to the engine (de-risks
  the parser, costs wasm binary size). The crate has no JSON reader today either
  way.
- **Merkle hash function and attr set.** FNV-1a vs xxhash, and which attrs beyond
  `copy_text` feed the digest (depth, lang, meta, url, ordered, checked, align,
  isolation_tag). Under-hash misses a real change; over-hash adds spurious
  changed-region churn (the id still carries via `compat`).
- **`isolation_tag` extraction.** How to parse the component name / element tag
  out of `html.value`, and whether expression-kind MDX nodes need a finer
  discriminator than one tag string.
- **Docs graduation.** This stays a memo until the identity decision is ratified,
  then graduates to a numbered ADR.

## Risks

- The Merkle `content_hash` is the new load-bearing invariant. If it is not
  recursive, the subtree short-circuit and the `eq` anchor both break.
- The snapshot must serialize from `MarkdownPlan.root`, never the wasm
  block/run flattening, which folds the safe-html triplet three-into-one and
  clears MDX children. A snapshot from the flattened view misaligns block-vs-inline
  granularity.
- `from_wire` must be total. An old-engine snapshot fed to a new engine must
  degrade to a full remount, not poison the projection.
- Counter monotonicity depends on the consumer round-tripping `next_id` inside
  the opaque token. A lost token mints from 1 and can collide with a still-mounted
  key; treat a missing or bad token as a fresh document and reset the consumer's
  render baseline.
- Deferring anchor / isolated-region / slug collection into the Phase-3 DFS is a
  side-effect-ordering refactor. It must preserve document-order slug numbering
  and isolated-region emission order; re-run the existing tests to confirm.
- The LCS middle is O(m*n) per sibling level. A pathological flat list or a
  thousand-row table needs a length-threshold fallback or a Myers O(ND) upgrade
  before shipping to very large documents.

## Rebuild and re-vendor

The artifact ships to mid as a vendored wasm. mid currently vendors the build
from `06692a3`; this advances it.

1. `rustup target add wasm32-unknown-unknown` (idempotent; already installed).
2. `cargo test -p nteract-markdown-engine && cargo test -p nteract-markdown-wasm`.
   The identity matrix is FFI-free, so this is the real gate.
3. `cargo build -p nteract-markdown-wasm --release --target wasm32-unknown-unknown`.
4. Copy `target/wasm32-unknown-unknown/release/deps/nteract_markdown_wasm.wasm`
   into mid's `vendor/nteract-markdown-wasm/`, bump the README source commit, and
   bump both crate versions (the id format and JSON sidecar are a breaking change
   for the vendored artifact).
5. Confirm the artifact still exports the original five symbols plus
   `nteract_markdown_project_reconcile` before the vendored consumer relies on it.

## Consumer follow-on (separate, not in this branch)

mid wires up in its own steps once the engine ids are stable: re-vendor the
artifact (inert until opt-in), widen the TS projector to pass and persist the
prev snapshot per file, teach change-highlights to emit "changed" when the id
matches but content differs, and only later inject a `data-mdxid` attribute with
portal placement for the executable half. The first reconciled render after the
re-vendor remounts the whole document once, because every id string shape changes
at once. That is expected, not a reconciler defect.
