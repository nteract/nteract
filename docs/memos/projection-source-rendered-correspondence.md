# Source ↔ Rendered Projection Correspondence

**Status:** Exploration
**Created:** 2026-06-20
**Audience:** Engineering, design, and AI collaborators
**Promotes to:** ADR for the markdown projection contract (run granularity,
fidelity marker, payload version) and a sibling note in
[`markdown-plan-documents.md`](markdown-plan-documents.md) OC-2 / OC-3.

## Why now

Inline comments on rendered markdown surfaced a coordinate-space gap. Selecting
"is some markdown text it is **good**" in the rendered plane captures the right
range. After the comment commits, however, the highlight balloons to the whole
paragraph. The quote preview also reads `me markdown text it is **good**` with
source delimiters showing.

The bug is not styling. We have two coordinate spaces (raw markdown source and
rendered text) and cross between them at inconsistent granularity. A
rich/WYSIWYG editor needs the exact same crossing: map a rendered caret or edit
back to a source offset, mutate the Automerge document, and re-project. Getting
correspondence right for comments builds the editing primitive too. This memo
names the model and the one contract change that makes it robust.

## The asymmetry

The pipeline has two halves, and only one is broken.

**Read (selection → anchor) is character-granular and correct.** A DOM `Range`
maps to source offsets per character. `rendered-markdown-source-comment.ts`
walks up to the enclosing run span (`data-markdown-source-run`). It measures the
rendered-text offset within the run (`textOffsetWithin`, ~line 83) and maps it
to a source offset (`sourceOffsetForRenderedPoint`, ~line 95). When rendered
length equals source length, it interpolates linearly. The selection rectangle
and "Comment" affordance land exactly where the user dragged.

**Write-back (anchor → highlight) is run-granular and balloons.**
`ProjectedMarkdownView.commentHighlightForRun` (~line 729) runs an *overlap*
test between the resolved anchor span and each run's `sourceSpanUtf16`.
`renderRuns` (~line 701) then applies `.comment-highlight` to the **entire run's
`<span>`**. A run cannot be partially highlighted. An anchor starting mid-run
lights the whole run; an anchor spanning a plain run and an adjacent strong run
lights both runs end to end. That causes the visible balloon.

**Quote display is a raw source slice, so it carries syntax.** `exact_quote` is
`source.slice(from, to)` (`comment-source-anchor.ts:133`). Delimiters live
between runs (see below), so any slice spanning them includes `**`, backticks,
or link markup. The composer and rail render `exact_quote` verbatim, showing
source instead of what the user highlighted.

## The three states and the bridge

1. **Source text:** The Automerge document content in UTF-16 offsets. Anchors
   are stored here (`source_range`: line/column + `exact_quote` + prefix/suffix
   context). This lets comments survive edits and re-resolve by quote, and
   should not change.
2. **The projection plan:** The bridge. The Rust projector emits per-run
   `sourceSpanUtf16` ⇄ `renderedTextUtf16` plus `renderedText` and `semantic`
   (`src/lib/markdown-projection.ts:44`). Only this layer knows how source and
   rendered text relate.
3. **The rendered DOM:** What the user sees, selects, and (later) edits.

Each rendering plane already re-projects the stored anchor independently
(CodeMirror decorations in source mode, run overlap in rendered mode). That
single-source-of-truth shape is right. The defect is purely the *granularity* at
which the rendered plane crosses the bridge.

## What the projector already gives us

Inspecting the emit side (`crates/nteract-markdown-wasm/src/lib.rs`,
`crates/nteract-markdown-engine/src/lib.rs`) corrects a tempting but wrong
assumption. The projector does **not** fold delimiters into styled runs:

- **Strong and other styled runs:** For `**good**`, the `Strong` node spans
  `[0,8]`, while the inner text run gets the content-only span `[2,6]` and
  `renderedText` `"good"`. The `**` regions become `syntaxSpans` on the block,
  not runs (`add_run` ~745, `add_outer_syntax_spans` ~585).
- **Inline code:** Delimiters are stripped too (`collect_delimited_inline`
  ~515). The run's source span points at the content inside backticks, matching
  `renderedText`.
- **Inline math:** `$` delimiters are stripped, but the run is NOT
  character-faithful. It renders as KaTeX HTML rather than `renderedText`
  characters, leaving no rendered character to map a source offset onto. Treat
  inline math as atomic.
- **Display math:** `MathBlock` emits a run over the full `$$...$$` span, and
  the host renders it from `block.text` with no run spans
  (`ProjectedMarkdownView.tsx` ~195 and ~891,
  `crates/nteract-markdown-wasm/src/lib.rs:176`). Treat display math as outside
  anchoring scope until a KaTeX-source correspondence is designed.
- **Images and reference links:** Both are opaque. `![alt](url)` emits one run
  whose source span covers the full markup while `renderedText` holds only the
  alt text. Reference-style links and images (`[label][ref]`, `![alt][ref]`)
  behave the same way: source spans the full reference, while `renderedText` is
  just the label. There is no interior correspondence.

For genuinely character-faithful cases (plain text, strong, emphasis, delete,
inline code, and inline links of the `[label]` + `(url)` form), each run is
**transparent**. Its rendered text equals its source slice one to one, so the
host can sub-slice by character with no projector change. Math, images,
reference links, and runs decoding entities or escapes are not transparent and
must be handled as atomic or piecewise. Consumers need to respect that split,
and a small marker lets the host stop guessing.

## Run fidelity classes

Make the distinction explicit rather than inferred. There are three classes, not
two:

- **Transparent run:** `renderedText` is the verbatim source slice of
  `sourceSpan`, one to one. Character offsets interpolate linearly in both
  directions. Covers plain text, strong, emphasis, delete, inline code, and
  inline links (most prose).
- **Piecewise run:** Partly verbatim, partly remapped. Covers text runs that
  decode an entity (`&amp;` to `&`), unescape a character (`\*` to `*`), or
  collapse a soft line break (`\n` to a space). Prefix and suffix correspondence
  survive around the remapped span, so these runs are not opaque. A single
  boolean cannot describe them; character fidelity needs explicit
  `(sourceSpan, renderedSpan)` segments. A soft break is length-preserving (`\n`
  and space are both one code unit), so positions line up one to one even though
  the displayed character differs.
- **Opaque run:** No interior correspondence. Covers images, reference-style
  links and images, inline math (KaTeX HTML), and any host-rendered widget.
  Selection, highlight, and caret snap to run boundaries, which is acceptable
  because no sub-position exists.

Today the host infers fidelity via `renderedLength === sourceLength`. That
heuristic is not ground truth: a run can have equal lengths without being a
verbatim slice (a soft break), or unequal lengths yet be a clean substring.
Checking `plan.source.slice(run.sourceSpan) === run.renderedText` is stronger,
but the host does not always carry `source`. The projector built both strings
and knows the truth, so it should emit it.

**Contract change (the durable decision):** Add an authoritative per-run
fidelity signal to the projection.

- A boolean (`transparent`) is the narrow starter, honest for plain text,
  strong, emphasis, delete, and inline code. Piecewise runs (entities, escapes,
  soft breaks) and reference links need explicit `(sourceSpan, renderedSpan)`
  segments.
- The field is **additive and optional** on `MarkdownProjectionRun`,
  hand-mirrored on both sides (no ts-rs; `markdown-projection.ts:44` and
  `WasmRun::push_json` ~826).
- Because it is additive, keep payload `version: 1`. Old consumers ignore
  unknown fields, so do NOT bump to `version: 2`.
- Reserve a version bump for breaking run-granularity changes. Note the gate is
  asymmetric today: the MIME path rejects `version !== 1`
  (`markdown-projection.ts:279`), while direct `projectMarkdownPlan` skips
  version validation. Any future bump must update both paths together.

## Both consumers, one primitive

With fidelity known, both broken consumers share one walk: *given an anchor
source span, enumerate the covered runs and intersect each at the character
level.*

- **Highlight (source span → rendered):** Compute the intra-run overlap
  `[max(anchorFrom, runStart), min(anchorTo, runEnd)]` for each covered run. On
  a transparent run, map source offsets to rendered offsets linearly and wrap
  only those characters in the highlight element. On piecewise or opaque runs,
  wrap the whole run (never beyond it). Guard the transparent path with a length
  check (or content check when `source` is available) so a remapped run never
  highlights the wrong sub-range. This eliminates the whole-paragraph balloon.
- **Display quote (source span → rendered text):** At creation, prefer the live
  `Selection.toString()`. The browser already collapses CSS whitespace, matching
  what the user saw. When re-deriving later without a selection (in the rail),
  concatenate covered runs' `renderedText`, sub-sliced for partial transparent
  runs, and normalize whitespace to match `white-space: normal` (collapse
  whitespace runs, trim). Deriving from `renderedText` instead of `source.slice`
  keeps `**`, image markup, and `<url>` autolink brackets out of the quote. Raw
  `exact_quote` stays on the anchor for re-resolution, but is no longer
  displayed.
- **Selection → anchor (rendered → source):** Already character-correct for
  transparent runs. Formalize it against the fidelity classes, delete the
  generic snap fallback in `sourceOffsetForRenderedPoint`, and replace it with
  an explicit transparent-interpolate / opaque-snap split.

Deriving from `renderedText` avoids source leakage across edge cases. Image-alt
selections yield alt text (opaque run, full `renderedText`), autolinks yield the
bare URL, and soft breaks yield a space. Sub-run quote fidelity inside piecewise
runs (such as an entity mid-selection) waits on the segment form of the fidelity
marker.

The dominant fix (no highlight ballooning, no syntax in quotes) is **host-side
only** and needs no projector change. Character-faithful runs are already
transparent, and the length guard holds everything else at run granularity. The
fidelity marker lands second to make piecewise runs character-faithful and
remove the host heuristic. Sequence accordingly.

## Why this is the rich-editing primitive

[`markdown-plan-documents.md`](markdown-plan-documents.md) OC-3 commits to
CodeMirror + projection rather than ProseMirror/Lexical. A WYSIWYG layer on this
architecture needs the exact same correspondence, exercised for writes:

- map a rendered caret to a source offset to place the insertion point;
- map a rendered edit to a source range to mutate the Automerge body;
- re-project and map the new source position back to a rendered caret.

Highlight and quote are the read-only consumers of that map. Building it at
character granularity now gives editing a tested correspondence instead of
reinventing it. Naming the opaque-run set (images, math, reference links,
components) also defines the atomic widgets a rich editor must respect.

## Open questions

- **OQ-1 Fidelity granularity.** Ship boolean transparent/opaque first, or jump
  straight to piecewise `(sourceSpan, renderedSpan)` segments so autolinks and
  entities are character-faithful? Boolean fixes the comment bug; segments are
  what editing eventually needs. Lean boolean now, and move to segments when an
  opaque-interior case blocks work.
- **OQ-2 Highlight element shape (required for step 1, not deferred).**
  Character granularity injects highlight `<span>`s inside the run span.
  - Keep the outer run span and its `data-markdown-source-run` / `data-source-*`
    attributes intact, since selection mapping reads them.
  - Nested spans must not change the run's text content, so
    `handleRenderedMarkdownCopy` and context-menu copy (both building the
    clipboard from `exact_quote` via `Selection`/`Range` measurement) keep
    working. Verify copy explicitly.
  - Move the shared `--cm-comment-color` / `.comment-highlight` surface
    (`src/styles/comment-highlight.css`) from the run span to the inner
    highlight span.
- **OQ-3 Overlapping anchors (resolved).** Multiple highlights per run landed in
  commit 1217de09 (`feat(comments): multiple highlights per run + compose
  selection preview (#3796)`). Code computes multiple highlight ranges, splits
  run text across all boundaries
  (`src/components/markdown/ProjectedMarkdownView.tsx:873`), and renders
  highlight pieces at line 904. Non-overlapping and overlapping per-run
  highlights are supported; unresolved stacking semantics, if any, remain open.
- **OQ-4 IsolatedFrame.** Cells falling back to `IsolatedFrame` have no comment
  affordance today. Out of scope here; tracked separately.
- **OQ-5 Marker rollout.** The fidelity marker is additive under `version: 1`,
  needing no daemon or consumer handshake. Only a breaking run-granularity
  change needs a `version` bump. Any bump must update both the MIME path and
  direct `projectMarkdownPlan` together, since the version gate is asymmetric
  today.

## Current Status

Host-side character-granular highlights and display quotes have landed. The
remaining durable design question is whether the projector should expose an
explicit fidelity marker under `version: 1` so consumers stop inferring fidelity
from `renderedLength === sourceLength`.

If that marker holds up, graduate the run fidelity classes and marker shape into
an ADR and cross-link OC-2.
