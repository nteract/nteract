# Pages editor workbench

A local, generated-content experiment on main `655b66d89`, branch
`quod/pages-editor-spike`. It is separate from Pages PR #4451 and has no service,
authentication, persistence, or deployment integration.

From this directory, run:

```sh
npm ci && npm run dev
```

Open <http://127.0.0.1:4318>. The server binds only to loopback. Reload resets the
two in-memory replicas. `npm test` runs the model and transaction regressions;
`npm run build` creates the static bundle. Restart/rebuild and reload after edits.
Dependencies and their lockfile are intentionally isolated from the production
pnpm workspace. Node 22 was used for verification.

## Try it

- Select text, use Bold/Italic/Code, or paste Markdown or rich HTML.
- The first observation has two paragraphs inside one stable Page block. Select
  across them and type a replacement. Undo restores the structure.
- Enter splits a paragraph; Backspace at its start joins it. Page block IDs do
  not change. Lists support Enter, Tab and Shift-Tab.
- Pause automatic delivery. Insert different words in Alice and Bob's versions
  of the same block. Sync now. Undo Alice's edit and sync again: Bob's insertion
  should remain. This is actual Automerge merging, not copying one editor value.
- Select text in Alice. Bob shows a purple selection and labeled caret. Presence
  is separate from document changes, scoped to the Page block, and expires after
  30 seconds without a new selection event. Manual sync also delivers presence.
- Anchor a selection, insert text before it from the other replica, and inspect
  the resolved quote. Deletion can collapse an anchor; changed quotes are flagged.
- Try emoji and Japanese text. Real platform IME composition remains a manual
  qualification item; inserting Unicode is not proof of IME correctness.

## State and deliberate limits

`blockOrder` and `blocks[id]` preserve Page identity, kind, and arbitrary metadata.
Each block has one canonical Automerge rich-text field. ProseMirror state is its
input/render projection; the published binding translates transactions to
Automerge operations and applies remote patches without adding them to local
history. Each editor gets its own history. This does not establish page-wide undo.

Markdown is an import/export boundary in this experiment. `originalMarkdown` is
immutable import provenance: export returns those exact bytes while the current
semantic export matches the original; edited supported blocks serialize to
normalized Markdown. The provenance is not a second editable document. A
production design must define agent Markdown edits against the same canonical
state instead of allowing independent Markdown and rich-text authorities.

The prototype importer is ProseMirror's CommonMark parser, **not** nteract's Rust
parser. The latter was inspected as the intended import/render/source-map
integration boundary; no Rust editing API or fidelity parity is claimed here.
Unsupported Markdown (including the sample table/math block), HTML, and
instructions are visibly opaque. The gate is conservative and is not a complete
Markdown dialect validator. Rich HTML paste uses the editor schema; unsupported
complex HTML is kept as an opaque source block. This is not arbitrary HTML/MDX
execution. Fonts are local and the fixture has no application network adapter.

Cross-Page-block selection/replacement, Page block reorder/split/join, table/math
editing, persistent comments, trusted authorship, real transport failures,
multi-device IME, and screen-reader qualification are out of scope. Keyboard
input and labeled textbox accessibility were exercised in Chromium, not a full
accessibility audit. The composition gate delays replica delivery while an editor
reports composition; this is an unqualified mitigation, not an IME guarantee.

## What the experiment found

The `@automerge/prosemirror` 0.2.0 remote translation can leave a stale paragraph
split after a join, although the Automerge documents converge. `binding.mjs`
checks the remote transaction against canonical spans and applies a minimal
projection repair inside the binding's echo-suppressed inbound transaction.
The repair is excluded from local history and counted in the inspector. The
split/join regression failed before this wrapper and passes with it. This needs
an upstream report and broader qualification before production adoption.

The adapter also relies on the binding's internal traversal exports for position
mapping. It is pinned deliberately. A production integration needs an owned,
tested adapter API or upstream public exports.

## Comparison and recommendation

| Approach | Canonical state | Fit and main cost |
| --- | --- | --- |
| Source-native CodeMirror with rendered decorations | Markdown Automerge text per Page block | Closest to existing nteract source bridge and exact source preservation. Rich input and hidden-syntax selection behavior still need an editing design. |
| Rich editor translated into Markdown edits | Markdown Automerge text per Page block | Preserves the current Pages contract. Needs precise transaction-to-source patches, syntax-aware selection mapping and concurrent formatting semantics; whole-block serialize/diff is not a sufficient correctness argument. |
| ProseMirror with Automerge rich text (this fixture) | Rich text marks/block markers per stable Page block | Existing browser editing and collaboration primitives; requires explicit schema/import/export policy and adaptation of Pages' Markdown operations. The binding's join defect shows why integration testing matters. |

Continue comparing the latter two at the **per-Page-block** boundary. The native
rich-text fixture is a useful interaction baseline, not a decision to migrate
Pages. Our parser's blocks/spans are valuable for import, render, opaque regions
and source anchoring; they do not by themselves define rich edit transactions.
Quill's Delta model is a useful older example of separating content and edits,
while Peritext supplies concrete formatting-intent cases. Neither is a reason
to introduce a second collaboration system.

Primary references:

- [Automerge ProseMirror binding and schema adapter](https://github.com/automerge/automerge-prosemirror)
- [ProseMirror Markdown import/export](https://github.com/ProseMirror/prosemirror-markdown)
- [Automerge rich text primitives](https://automerge.org/docs/reference/documents/rich-text/)
- [Peritext formatting-intent examples](https://www.inkandswitch.com/peritext/)
- [Quill's Delta document/change format](https://quilljs.com/docs/delta)

The detailed checkout evidence and integration questions live in this worktree's
`.context/pages-editor-research.md`. No code was copied from the Pages branch or
modified in its reference worktree. Its uncommitted state was evolving during
this experiment, so its deployment/API must be rechecked before integration.
