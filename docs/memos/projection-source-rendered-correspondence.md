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
- Inline code and inline math strip their delimiters too
  (`collect_delimited_inline` ~515): a run's source span points at the content
  inside the ticks or dollars.
- The exception is images. `![alt](url)` emits one run whose source span covers
  the full markup but whose `renderedText` is just the alt text. There is no
  interior correspondence.

So for the common cases (plain text, strong, emphasis, delete, inline code,
math) a run is already **transparent**: its rendered text equals its source
slice, one to one. The host can sub-slice it by character with no projector
change. The work is to make the consumers do that, plus a small marker so the
host stops guessing which runs are transparent.

## Run fidelity classes

Make the distinction explicit rather than inferred:

- **Transparent run**. `renderedText` is the verbatim source slice of
  `sourceSpan`. Character offsets interpolate linearly in both directions. The
  majority of runs.
- **Opaque run**. `renderedText` differs from the source slice (images today;
  future: entities like `&amp;`, escapes like `\*`, autolinks where the label
  differs from the target, hard breaks). No meaningful interior mapping.
  Selection, highlight, and caret snap to run boundaries, which is acceptable
  because there is no sub-position to land on.

Today the host infers this with `renderedLength === sourceLength`. That is a
heuristic, not ground truth: a run can have equal lengths yet not be a verbatim
slice, or unequal lengths yet be a clean substring. The projector knows the
truth (it built both strings). It should say so.

**Contract change (the durable decision):** add an authoritative per-run
fidelity signal to the projection. Smallest form is a boolean (`linearMap` /
`transparent`); a richer form emits explicit `(sourceSpan, renderedSpan)`
segments for runs that are piecewise-linear. Start with the boolean. It is an
additive field on `MarkdownProjectionRun`, hand-mirrored on both sides (no
ts-rs; `markdown-projection.ts:44` and `WasmRun::push_json` ~826). Bump the
payload envelope `version` to `2` so prerendered
`application/vnd.nteract.markdown+json` consumers do not silently misread it
(`markdownProjectionPlanFromMimeData` ~279 currently rejects anything but `1`).

## Both consumers, one primitive

With fidelity known, both broken consumers derive from the same walk: *given an
anchor source span, enumerate the covered runs and, for each, intersect at the
character level.*

- **Highlight (source span → rendered):** for each covered run, compute the
  intra-run overlap `[max(anchorFrom, runStart), min(anchorTo, runEnd)]`. For a
  transparent run, map those source offsets to rendered offsets linearly and
  wrap only those characters in the highlight element. For an opaque run, wrap
  the whole run. No more whole-paragraph balloon.
- **Display quote (source span → rendered text):** concatenate the covered
  runs' `renderedText`, sub-sliced for partial transparent runs. The reader sees
  "is some markdown text it is good", not `me markdown text it is **good**`. The
  raw-source `exact_quote` stays on the anchor for re-resolution; it is just no
  longer what we display.
- **Selection → anchor (rendered → source):** already character-correct for
  transparent runs. Formalize it against the fidelity classes and delete the
  generic snap fallback in `sourceOffsetForRenderedPoint`, replacing it with the
  explicit transparent-interpolate / opaque-snap split.

Note that the dominant fix (highlight no longer balloons, quote no longer shows
syntax) is **host-side only** and needs no projector change, because the common
runs are already transparent. The fidelity marker is what makes the opaque cases
correct and removes the host heuristic. Sequence accordingly.

## Why this is the rich-editing primitive

A WYSIWYG layer over the same source/projection architecture (the direction
[`markdown-plan-documents.md`](markdown-plan-documents.md) OC-3 commits to,
staying on CodeMirror + projection rather than ProseMirror/Lexical) needs
exactly this correspondence, just exercised for writes:

- map a rendered caret to a source offset to place the insertion point
- map a rendered edit to a source range to mutate the Automerge body
- re-project and map the new source position back to a rendered caret

Highlight and quote are the read-only consumers of that map. Building it at
character granularity now, with an authoritative fidelity marker, means the
editing work inherits a tested correspondence instead of reinventing it. The
opaque-run set is also the set a rich editor must treat as atomic widgets
(images, entities, components), so naming it here pays forward.

## Open questions

- **OQ-1 Fidelity granularity.** Boolean transparent/opaque first, or go
  straight to piecewise `(sourceSpan, renderedSpan)` segments so autolinks and
  entities are also character-faithful? Boolean covers the comment bug; segments
  are what editing eventually wants. Lean boolean now, segments when the first
  opaque-interior case actually blocks something.
- **OQ-2 Highlight element shape.** Sub-wrapping a run means injecting highlight
  spans inside the run span. Confirm this does not fight selection, copy
  (`handleRenderedMarkdownCopy`), or the shared `--cm-comment-color` /
  `.comment-highlight` surface used by both planes
  (`src/styles/comment-highlight.css`).
- **OQ-3 Overlapping anchors.** Two comments overlapping the same characters
  need nested or layered highlights. Run-granular code sidestepped this by
  picking the shortest overlapping highlight; character-granular has to decide
  stacking.
- **OQ-4 IsolatedFrame.** Cells that fall back to `IsolatedFrame` have no
  comment affordance at all today. Out of scope here, tracked separately.
- **OQ-5 Version handshake.** Confirm every `application/vnd.nteract.markdown+json`
  producer and consumer moves to `version: 2` together; no older-daemon
  fallback (repo policy is ship-together schema changes).

## Suggested next steps

1. Host-side character-granular highlight in `ProjectedMarkdownView`
   (`commentHighlightForRun` / `renderRuns`): wrap only the overlapping
   characters of each covered run. Fixes the balloon with no projector change.
2. Host-side run-derived display quote: build the preview from covered runs'
   rendered text; keep `exact_quote` as the anchor's re-resolution key.
3. Projector fidelity marker (boolean) + payload `version: 2`; replace the host
   `renderedLength === sourceLength` heuristic. Update the WASM delimiter-span
   tests (`projects_multi_character_delimiter_source_spans` ~1347).
4. Fold the read path onto the same fidelity classes; delete the generic snap.
5. If this holds up, graduate the contract (run granularity, fidelity marker,
   payload version) into an ADR and cross-link OC-2.
