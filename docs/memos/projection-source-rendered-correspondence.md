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
range, but after the comment commits, the highlight balloons to the whole
paragraph, and the quote preview reads `me markdown text it is **good**` with
the source delimiters showing.

The bug is not styling. It is that we have two coordinate spaces (raw markdown
source and rendered text) and we cross between them at inconsistent granularity.
The same crossing is the primitive a rich/WYSIWYG editor will need: map a
rendered caret or edit back to a source offset, mutate the Automerge document,
re-project. Getting the correspondence right for comments builds the thing
editing needs anyway. This memo names the model and the one contract change that
makes it robust.

## The asymmetry

The pipeline has two halves and only one is broken.

**Read (selection → anchor) is character-granular and correct.** A DOM `Range`
is mapped to source offsets per character.
`rendered-markdown-source-comment.ts` walks up to the enclosing run span
(`data-markdown-source-run`), measures the rendered-text offset within the run
(`textOffsetWithin`, ~line 83), and maps it to a source offset
(`sourceOffsetForRenderedPoint`, ~line 95). For runs where rendered length
equals source length it interpolates linearly. The selection rectangle and the
"Comment" affordance land exactly where the user dragged.

**Write-back (anchor → highlight) is run-granular and balloons.**
`ProjectedMarkdownView.commentHighlightForRun` (~line 729) does an *overlap*
test between the resolved anchor span and each run's `sourceSpanUtf16`, then
`renderRuns` (~line 701) applies the `.comment-highlight` class to the **entire
run's `<span>`**. A run cannot be partially highlighted. An anchor that starts
mid-run lights the whole run; an anchor spanning a plain run plus an adjacent
strong run lights both runs end to end. That is the visible balloon.

**Quote display is a raw source slice, so it carries syntax.** `exact_quote` is
`source.slice(from, to)` (`comment-source-anchor.ts:133`). Delimiters live
between runs (see below), so any slice spanning them includes the `**`,
backticks, or link markup. The composer and rail render `exact_quote` verbatim,
so the user sees source, not what they highlighted.

## The three states and the bridge

1. **Source text**. The Automerge document content, UTF-16 offsets. Anchors
   are stored here (`source_range`: line/column + `exact_quote` + prefix/suffix
   context) and must be, so a comment survives edits and re-resolves by quote.
   This is correct and should not change.
2. **The projection plan**. The bridge. The Rust projector emits per-run
   `sourceSpanUtf16` ⇄ `renderedTextUtf16` plus `renderedText` and `semantic`
   (`src/lib/markdown-projection.ts:44`). This is the only thing that knows how
   source and rendered relate.
3. **The rendered DOM**. What the user sees, selects, and (later) edits.

Each rendering plane already re-projects the stored anchor independently
(CodeMirror decorations in source mode, run overlap in rendered mode). That
single-source-of-truth shape is right. The defect is purely the *granularity* at
which the rendered plane crosses the bridge.

## What the projector already gives us

Grounding the emit side (`crates/nteract-markdown-wasm/src/lib.rs`,
`crates/nteract-markdown-engine/src/lib.rs`) corrects a tempting but wrong
assumption. The projector does **not** fold delimiters into styled runs:

- For `**good**`, the `Strong` node spans the whole `[0,8]`, but the inner text
  run is emitted with the content-only span `[2,6]` and `renderedText` `"good"`.
  The `**` regions become `syntaxSpans` on the block, not runs (`add_run` ~745,
  `add_outer_syntax_spans` ~585).
- Inline code strips its delimiters too (`collect_delimited_inline` ~515): the
  run's source span points at the content inside the ticks, and `renderedText`
  is that same content.
- Inline math also strips its `$` delimiters, but it is NOT character-faithful:
  the run renders as KaTeX HTML, not as `renderedText` characters, so there is no
  rendered character to map a source offset onto. Display math is further out:
  `MathBlock` emits a run over the full `$$...$$` span and the host renders it
  from `block.text` with no run spans at all (`ProjectedMarkdownView.tsx` ~195
  and ~891, `crates/nteract-markdown-wasm/src/lib.rs:176`). Treat inline math as
  atomic and display math as outside anchoring scope until a KaTeX-source
  correspondence is designed.
- Images are opaque. `![alt](url)` emits one run whose source span covers the
  full markup but whose `renderedText` is just the alt text. Reference-style
  links and images (`[label][ref]`, `![alt][ref]`) are the same: the source span
  covers `[label][ref]` while `renderedText` is only the label. No interior
  correspondence.

So for the genuinely character-faithful cases (plain text, strong, emphasis,
delete, inline code, and inline links of the `[label]` + `(url)` form) a run is
**transparent**: its rendered text equals its source slice, one to one. The host
can sub-slice those by character with no projector change. Math, images,
reference links, and runs that decode entities or escapes are not transparent and
must be handled as atomic or piecewise. The work is to make the consumers respect
that split, plus a small marker so the host stops guessing.

## Run fidelity classes

Make the distinction explicit rather than inferred. There are three kinds, not
two:

- **Transparent run**. `renderedText` is the verbatim source slice of
  `sourceSpan`, one to one. Character offsets interpolate linearly in both
  directions. Plain text, strong, emphasis, delete, inline code, inline links.
  The majority of prose.
- **Piecewise run**. Partly verbatim, partly remapped: a text run that decodes an
  entity (`&amp;` to `&`), unescapes a character (`\*` to `*`), or collapses a
  soft line break (`\n` to a space). These keep useful prefix/suffix
  correspondence around the remapped span, so they are not opaque, but a single
  boolean cannot describe them; they need explicit `(sourceSpan, renderedSpan)`
  segments to be character-faithful. A soft break is length-preserving (the `\n`
  and the space are both one code unit), so positions still line up one to one
  even though the displayed character differs.
- **Opaque run**. No interior correspondence at all: images, reference-style
  links and images, inline math (KaTeX HTML), and any host-rendered widget.
  Selection, highlight, and caret snap to run boundaries, which is acceptable
  because there is no sub-position to land on.

Today the host infers fidelity with `renderedLength === sourceLength`. That is a
heuristic, not ground truth: a run can have equal lengths yet not be a verbatim
slice (a soft break), or unequal lengths yet be a clean substring. A stronger
host-only guard is the content check `plan.source.slice(run.sourceSpan) ===
run.renderedText`, but the host does not always carry `source`. The projector
built both strings and knows the truth, so it should say so.

**Contract change (the durable decision):** add an authoritative per-run fidelity
signal to the projection. A boolean (`transparent`) is the narrow starter, honest
only for plain text and strong/emphasis/delete/inline-code; piecewise runs
(entities, escapes, soft breaks) and reference links need the richer form,
explicit `(sourceSpan, renderedSpan)` segments. The field is **additive and
optional** on `MarkdownProjectionRun`, hand-mirrored on both sides (no ts-rs;
`markdown-projection.ts:44` and `WasmRun::push_json` ~826). Because it is
additive it stays under payload `version: 1`: old consumers ignore an unknown
field, so do NOT bump to `version: 2` for it. A bump is only warranted by a
breaking run-granularity change, and even then note the gate is asymmetric, the
MIME path rejects `version !== 1` (`markdown-projection.ts:279`) but direct
`projectMarkdownPlan` does not validate version at all, so a bump must update both
paths together.

## Both consumers, one primitive

With fidelity known, both broken consumers derive from the same walk: *given an
anchor source span, enumerate the covered runs and, for each, intersect at the
character level.*

- **Highlight (source span → rendered):** for each covered run, compute the
  intra-run overlap `[max(anchorFrom, runStart), min(anchorTo, runEnd)]`. For a
  transparent run, map those source offsets to rendered offsets linearly and wrap
  only those characters in the highlight element. For a piecewise or opaque run,
  wrap the whole run (acceptable, never beyond the run). Guard the transparent
  path with a length (or, where `source` is available, content) check so a
  remapped run never produces a wrong sub-range. No more whole-paragraph balloon.
- **Display quote (source span → rendered text):** at creation, prefer the live
  `Selection.toString()`; the browser already collapses CSS whitespace, so it is
  exactly what the user saw. When re-deriving later without a selection (the
  rail), concatenate the covered runs' `renderedText`, sub-sliced for partial
  transparent runs, then normalize whitespace to match `white-space: normal`
  (collapse runs of whitespace, trim). Deriving from `renderedText` rather than
  `source.slice` is what keeps `**`, image markup, and `<url>` autolink brackets
  out of the quote. The raw-source `exact_quote` stays on the anchor for
  re-resolution; it is just no longer what we display.
- **Selection → anchor (rendered → source):** already character-correct for
  transparent runs. Formalize it against the fidelity classes and delete the
  generic snap fallback in `sourceOffsetForRenderedPoint`, replacing it with the
  explicit transparent-interpolate / opaque-snap split.

Deriving from `renderedText` handles the cases that would otherwise leak source:
an image-alt selection yields the alt text (opaque run, whole `renderedText`), an
autolink yields the bare URL, and a soft-break selection yields a space. The
residual imprecision is sub-run quote fidelity inside a piecewise run (an entity
mid-selection), which waits on the segment form of the fidelity marker.

The dominant fix (highlight no longer balloons, quote no longer shows syntax) is
**host-side only** and needs no projector change, because the character-faithful
runs are already transparent and the length guard keeps everything else at run
granularity. The fidelity marker is what later makes piecewise runs
character-faithful and removes the host heuristic. Sequence accordingly.

## Why this is the rich-editing primitive

A WYSIWYG layer over the same source/projection architecture (the direction
[`markdown-plan-documents.md`](markdown-plan-documents.md) OC-3 commits to,
staying on CodeMirror + projection rather than ProseMirror/Lexical) needs
exactly this correspondence, just exercised for writes:

- map a rendered caret to a source offset to place the insertion point
- map a rendered edit to a source range to mutate the Automerge body
- re-project and map the new source position back to a rendered caret

Highlight and quote are the read-only consumers of that map. Building it at
character granularity now means the editing work inherits a tested correspondence
instead of reinventing it. The opaque-run set is also the set a rich editor must
treat as atomic widgets (images, math, reference links, components), so naming it
here pays forward.

## Open questions

- **OQ-1 Fidelity granularity.** Boolean transparent/opaque first, or go
  straight to piecewise `(sourceSpan, renderedSpan)` segments so autolinks and
  entities are also character-faithful? Boolean covers the comment bug; segments
  are what editing eventually wants. Lean boolean now, segments when the first
  opaque-interior case actually blocks something.
- **OQ-2 Highlight element shape (required for step 1, not deferred).** Character
  granularity means injecting highlight `<span>`s inside the run span. This is a
  step-1 design item: the outer run span and its `data-markdown-source-run` /
  `data-source-*` attributes must stay intact (selection mapping reads them), and
  the nested spans must not change the run's text content, so
  `handleRenderedMarkdownCopy` and the context-menu copy (both build the
  clipboard from `exact_quote` via a `Selection`/`Range` measurement) keep
  working. Verify copy explicitly. The shared `--cm-comment-color` /
  `.comment-highlight` surface (`src/styles/comment-highlight.css`) moves from the
  run span to the inner highlight span.
- **OQ-3 Overlapping anchors.** Two comments overlapping the same characters
  need nested or layered highlights. Run-granular code sidestepped this by
  picking the shortest overlapping highlight; character-granular has to decide
  stacking. Step 1 keeps the single-best-highlight-per-run choice and highlights
  only that sub-range; multiple-per-run is deferred.
- **OQ-4 IsolatedFrame.** Cells that fall back to `IsolatedFrame` have no
  comment affordance at all today. Out of scope here, tracked separately.
- **OQ-5 Marker rollout.** The fidelity marker is additive under `version: 1`, so
  there is no daemon or consumer handshake to coordinate for it. Only a breaking
  run-granularity change would need a `version` bump, and that bump must cover
  both the MIME path and direct `projectMarkdownPlan` together (the version gate
  is asymmetric today).

## Current Status

Host-side character-granular highlights and display quotes have landed. The
remaining durable design question is whether the projector should expose an
explicit fidelity marker under `version: 1` so consumers stop inferring fidelity
from `renderedLength === sourceLength`.

If that marker holds up, graduate the run fidelity classes and marker shape into
an ADR and cross-link OC-2.
