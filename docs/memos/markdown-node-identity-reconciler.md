# Carried-forward node identity for the markdown plan

**Status:** Implemented in #3862, 2026-06-02. Engine and tests landed; snapshot
encoding uses serde_json; cross-WASM snapshot transport remains unexposed.

## Objective

The markdown plan projector mints every node's id from byte offsets:

```rust
// crates/nteract-markdown-engine/src/lib.rs:586
fn node_id(kind: NodeKind, span: &SourceSpan) -> String {
    format!("node:{kind:?}:{}:{}", span.start, span.end)
}
```

Anchors, isolated regions, and inline runs all clone that id, so any edit above
or inside a block renames it and every node after it. A consumer that keys on the
id sees the whole tail of the document turn over on a one-character edit. This
memo proposes replacing offset-derived identity with stable ids that carry across
reparses, assigned by a sequence-alignment reconciler that takes the previous
plan as input.

## What this buys nteract

Be honest about the payoff. Inside nteract, the plan ids matter in exactly one
place:

- React keys in the host renderer (`key={block.blockId}`, `key={run.inlineId}`
  in `ProjectedMarkdownView`). These churn on every edit-above and remount the
  rendered subtree. The host-rendered path is stateless presentational components
  (headings, lists, code blocks, math); stateful and executable regions route to
  `IsolatedFrame` and are keyed separately. So the churn is a cheap, visually
  invisible remount today, not a state-loss or correctness bug.

Everything else is already insulated from offset churn:

- Rendered-markdown comments anchor on source offsets plus an exact quote
  (`comments-doc` `SourceRange`), re-resolved by quote search over the Automerge
  `Text` source CRDT. They never key on plan node ids.
- Active-source and presence highlighting compare ids within a single freshly
  projected plan, so cross-edit stability is irrelevant.
- Scroll and outline anchors resolve cell-level ids and heading slugs, not offset
  node ids.

So for nteract as it stands, stable identity mostly buys cheaper remounts. The
cases where it becomes genuinely useful:

- **Collaborative selection survival.** A remote collaborator editing above while
  a local user drags a selection in the rendered view re-projects the plan,
  churns every id, and remounts the subtree, which can collapse the in-progress
  DOM selection. Stable ids plus patch-not-remount keep the untouched nodes and
  the selection alive. Present, narrow, real.
- **Id-based change tracking.** A "this block changed since you last looked"
  feature needs a node to keep identity across reparses. nteract has none today;
  stable identity is the prerequisite if it grows one.

The stronger pull is a downstream vendored consumer of the markdown wasm that
keys React on these ids and hosts live component state inside the rendered
document, where a remount is a real state loss. Putting identity in the plan
keeps it shared rather than re-derived per surface.

**Relationship to Automerge.** This is read-side projection identity, not source
identity. Automerge owns the source `Text` CRDT and merges concurrent edits; the
plan is a disposable projection parsed fresh from source. The reconciler
stabilizes the projection's node handles across reparses. It does not replace,
duplicate, or interact with Automerge's source identity.

## Design (Implemented)

`project_markdown_reconciled(source, options, &prev) -> (MarkdownPlan, ReconcilerSnapshot)`
runs three phases (`crates/nteract-markdown-engine/src/lib.rs:393-506`):

1. **Build.** Run `project_node`, but leave `ProjectedNode.id` empty and defer
   anchor and isolated-region emission. This drops the provisional-id remap and
   the `SourceSpan::empty()` id collision.
2. **Reconcile.** Assign ids top-down. One recursive `reconcile_children` runs
   at every children list (blocks, then list items / table rows / cells, then
   inline runs), so block and inline ids fall out of the same pass. Root keeps
   the literal `"root"`; only its children align.
3. **Finalize.** A document-order DFS over the now-id-stable tree rebuilds
   anchors (`block_id = node.id`), isolated regions (`id = "isolation:" +
   node.id`), and the heading-slug counter, then serializes the new snapshot
   from `MarkdownPlan.root` (never from the flattened block/run view).

Identity is a two-tier predicate:

- `eq(a, b)` = `(kind, lane, iso, isolation_tag, island_tag, island_inline)`
  equal **and** `content_hash` equal. The unchanged-anchor test that trim and
  LCS anchor on.
- `compat(a, b)` = `(kind, lane, iso, isolation_tag, island_tag,
  island_inline)` equal, content may differ. The edit-inside-vs-replace gate.

Content decides changed-vs-unchanged, never identity. Identity is alignment
position plus `compat`. Duplicates disambiguate by order, which alignment
gives for free.

`reconcile_children` is: ambiguity-guarded two-ended trim under `eq`, then LCS on
the residual middle under `eq` with match-late backtrack, then a
`content_hash`-keyed in-order move match on the leftovers, then a
front-surplus-aware positional zip under `compat`, then mint fresh for anything
left. A node matched under `eq` has an equal `content_hash`, so its subtree is
byte-identical and its ids are preserved without recursing. Only `compat` carries
(content differs) recurse to re-align changed children.

Edit-scenario requirements:

- **`content_hash` is a recursive Merkle digest** over `kind, lane, iso,
  isolation_tag, island_tag, island_inline`
  (`crates/nteract-markdown-engine/src/lib.rs:830-848`), the rendering-salient
  attrs, `copy_text` for leaves, and each child's hash in document order. A
  flat `copy_text` scalar would compare a formatting-only edit (`the cat sat`
  to `the *cat* sat`) equal at the parent, silently dropping the edit. "Equal
  `content_hash` implies subtree byte-identical" is what the subtree
  short-circuit and the `eq` anchor depend on.
- **The structural tuple includes `isolation_tag`, `island_tag`, and
  `island_inline`** (`crates/nteract-markdown-engine/src/lib.rs:96-109`), so
  two isolated nodes of the same `IsolationKind` (`<video>` to `<iframe>`) are
  not `compat` and remount instead of aliasing. `island_tag` covers MDX
  components (`<Frog />` to `<Chart />`); `island_inline` distinguishes block
  vs inline JSX islands for the same component tag.

The front-surplus zip hard-codes an insert-above preference: surplus leading
nodes with no `eq` match mint fresh before the remainder zips, so a block inserted
above an edited block does not steal the edited block's id. This sacrifices the
symmetric insert-below-adjacent-to-edit direction; both are pinned by tests.

The previous plan rides in as an opaque snapshot threaded through the projector.
The existing stateless `project_markdown` is kept as the cold path: it calls the
reconciled entry with an empty snapshot and discards the returned one, so every
node is fresh and existing call sites are unchanged. A consumer that wants
stability threads the snapshot back in. The whole identity matrix runs as FFI-free
`cargo` tests because the engine stays a pure function of `(source, prev-snapshot)`.

## Behavioral coverage (Implemented tests)

| Test | Pins |
| --- | --- |
| `insert_above_keeps_following_ids` | Following ids byte-for-byte stable while spans shift; one fresh id at the top. |
| `insert_above_with_duplicates_no_misassign` | The ambiguity guard stops trim preempting LCS; one remount in a duplicate run, existing ids preserved in order. |
| `insert_below_with_duplicates_pins_direction` | The sacrificed insert-below direction, regression-locked. |
| `edit_inside_text_keeps_id` | `compat` carries the id; content_hash differs; one run re-aligns. |
| `edit_inside_formatting_only_merkle` | The Merkle hash catches a `copy_text`-invariant edit a flat hash drops. |
| `reorder_tracks_moved_block` | LCS anchor plus keyed move; neither id stays positional. |
| `reorder_same_copytext_diff_structure` | Merkle differs at the boundary; no positional no-op, no inline-subtree graft. |
| `replace_cross_kind_new_id` | Cross-kind replace mints fresh; retired id never reused. |
| `replace_isolated_component_remounts` | `isolation_tag` makes a same-kind component swap remount; region id is fresh. |
| `lane_flip_deliberate_remount` | A block crossing into Isolated mints fresh; neighbors preserved. |
| `inline_insert_before_identical_math` | Two identical `$x$` runs keep order. |
| `offset_decoupling_nonheading` | All later block and inline ids equal while every span shifts. |
| `offset_decoupling_heading_slug_renumber` | Node id stable; only the slug-derived anchor own-id renumbers, by design. |
| `cold_start_all_fresh` | Empty snapshot and the stateless path both mint fresh from 1; root is `"root"`. |
| `snapshot_wire_roundtrip_total` | Round-trip is faithful; malformed or skewed bytes return `Default`, never panic. |
| Island identity tests (from #3859/#3878) | `island_tag` and `island_inline` remount behavior for MDX components. |

## Open decisions

- **Cross-WASM snapshot transport.** Engine snapshot encoding uses `serde_json`
  (`crates/nteract-markdown-engine/src/lib.rs:71`), but the WASM bridge
  exposes only stateless `project_markdown` JSON
  (`crates/nteract-markdown-wasm/src/lib.rs:60`). Cross-WASM snapshot
  transport remains unexposed; mark this decided if not planned.
- **Id representation.** Keep `String` ids (`node:{n}`) so the JSON contract is
  unchanged, vs integers with a consumer-side stringify.
- **Merkle hash function and attr set.** FNV-1a vs xxhash, and which attrs
  beyond `copy_text` feed the digest (depth, lang, meta, url, ordered, checked,
  align, isolation_tag, island_tag, island_inline).

## Risks and why it stays safe for nteract

- The stateless `project_markdown` path is preserved and unchanged, so existing
  nteract call sites keep their exact behavior; the reconciled path is opt-in.
- The Phase-3 DFS that rebuilds anchors, isolated regions, and slugs must preserve
  document-order slug numbering and region emission order. Re-run the existing
  heading-anchor and isolated-region tests to confirm the non-id output is
  byte-identical.
- Everything downstream depends on the Merkle `content_hash` being recursive. If
  it is flat, the subtree short-circuit and the `eq` anchor both break.
- The snapshot must serialize from `MarkdownPlan.root`, never the wasm block/run
  flattening, which folds the safe-html triplet three-into-one and clears MDX
  children.
- `from_wire` must be total: a version skew or malformed bytes return `Default`
  (cold start, every node fresh), never a panic.
- The LCS middle is O(m*n) per sibling level; a pathological flat list or a huge
  table wants a length-threshold fallback or a Myers O(ND) upgrade before very
  large documents.

## Scope

Engine plus FFI-free tests. The stateless entry is preserved, so this is additive
for nteract and a no-op for its current surfaces beyond cheaper remounts. The
identity matrix is the gate; ship it green before any consumer opts into the
reconciled path.
