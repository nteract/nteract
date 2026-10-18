# Pages editor workbench

A local, generated-content workbench retained alongside the Pages service.
Its editor approach and remote paragraph-join repair are integrated in
`apps/pages`. This fixture keeps two in-memory replicas for isolated experiments;
it has no authentication or persistent document access. The Pages build can
optionally serve its static bundle (see `apps/pages/README.md`).

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

This fixture preserves the original exploration and regression tests. The
current authenticated transport, persistence, agent operations, and comment
integration live in `apps/pages`; use its tests to qualify service behavior.

## Wordgard and the document boundary

The product clarification is that Pages should offer WYSIWYG editing and may
use Markdown only at export. Its editable storage does not need to be Markdown.
This experiment owns editor and binding research; the Pages implementation owns
service integration and deployment. Notebook Markdown requirements remain a
separate consumer of shared parsing/rendering capabilities.

Evaluate three choices independently:

| Choice | What we gain | What we still own |
| --- | --- | --- |
| Adopt Wordgard's editor and built-in collaboration | Browser input, document model, history and versioned change protocol | A deliberate replacement or separation of the existing Automerge collaboration authority; this is not a drop-in binding |
| Adopt Wordgard's editor with an Automerge binding | Browser input and rendering, while keeping app document and sync ownership | Transaction/patch translation, schema semantics, cursor mapping, selective undo, presence, and merge repair policy |
| Learn from Wordgard and extend our crates/renderer | Control over shared projection and edit contracts | Input, selection navigation, IME, clipboard, accessibility and browser maintenance if we also replace the editor |

The second is the leading hypothesis to test against the ProseMirror fixture.
This updates the earlier source-versus-rich comparison above; it is a research
direction, not an adoption decision. Learning from Wordgard's transaction and
rendering design can proceed under either outcome.

### Source findings

Inspected upstream commit `ece17b815ac0263f2f9efb967fa938eefa2ff4b9` on
2026-10-17; its package manifest says 0.6.0. This is source inspection, not a
claim about the current npm release or a tested dependency in this fixture.

- `ChangeSet.iterChanges` exposes replaced token ranges and preserved ranges
  with mark modifications. `mapPos` carries affinity and optional deletion
  tracking. This is a concrete adapter boundary, but its positions count editor
  tokens; they are not automatically Automerge text offsets or stable cursors.
- `Wordgard.dispatch` applies transaction appenders, updates state, notifies
  transaction listeners, and defers DOM work. A binding must consume all emitted
  transactions in order, including appended ones, and handle mutation failure;
  observing an edit does not make it atomic with CRDT mutation.
- The collaboration module keeps a server-confirmed version and rebases pending
  changes against a central authority. Using its editor does not require using
  that protocol. An Automerge binding should not run two independent merge
  authorities over the same document.
- Corrections enforce schema constraints locally but skip remote transactions.
  The built-in collaboration protocol integrates them explicitly. An Automerge
  adapter must define deterministic projection/repair behavior for merged
  structure; simply setting the remote annotation is insufficient.
- History maps earlier events through transactions marked `addToHistory=false`.
  Remote origin and history inclusion are separate annotations. Peer-preserving
  undo must be qualified through our binding rather than inferred from that API.
- Wordgard handles selection movement and draws the caret itself. Its input
  source still contains composition and Safari-specific handling. These are
  substantial capabilities to adopt or maintain, not benefits Rust parsing
  provides automatically.

### Binding experiment and decision gates

Keep stable Page block identity, kind and metadata outside editor-specific
objects. First compare the editors over the same supported Automerge rich-text
schema and generated fixture. Native marks and block markers are a starting
point; nested structures and split/join behavior still need explicit semantics.
Storing a whole editor JSON snapshot in Automerge would not establish useful
character-level or structural merging.

The binding should translate local replacement/format/structure transactions
into scoped Automerge operations, turn remote patches into incremental editor
transactions without echo, and map editor selections to stable CRDT positions.
Presence remains ephemeral application/session state; the editor provides its
visual representation. Agent edits should mutate the same document model.
Markdown parsing and export become adapters over this model, with explicit
handling for unsupported syntax and metadata.

Use a shared conformance corpus for ProseMirror and Wordgard: concurrent text
and formatting-boundary edits; nested list split/join versus peer insertion;
local undo after remote changes; deleted selection/comment anchors; reordered
and delayed delivery; save/load and reconnect; and exact projection agreement
once replicas converge. Cross-Page-block replacement needs a later document-wide
transaction and undo contract. Qualify real iOS/Android composition, selection,
clipboard and accessibility separately from headless transaction tests.

The useful Rust work should follow behavior proven by that corpus: shared
schema validation, edit/patch receipts, projection identity and position mapping,
plus Markdown import/export. Keep DOM geometry and browser composition in the
browser adapter. Notebook Markdown can remain source-native while Pages is rich;
share semantic projection capabilities where they fit rather than forcing one
storage representation onto both.

Sources:

- [Wordgard differences from ProseMirror](https://wordgard.net/docs/prosemirror/)
- [Pinned change model](https://code.haverbeke.berlin/wordgard/wordgard/src/commit/ece17b815ac0263f2f9efb967fa938eefa2ff4b9/src/doc/change.ts)
- [Pinned editor dispatch and listeners](https://code.haverbeke.berlin/wordgard/wordgard/src/commit/ece17b815ac0263f2f9efb967fa938eefa2ff4b9/src/editor/editor.ts)
- [Pinned corrections](https://code.haverbeke.berlin/wordgard/wordgard/src/commit/ece17b815ac0263f2f9efb967fa938eefa2ff4b9/src/state/correction.ts)
- [Pinned collaboration](https://code.haverbeke.berlin/wordgard/wordgard/src/commit/ece17b815ac0263f2f9efb967fa938eefa2ff4b9/src/collab/collab.ts)
- [Pinned history](https://code.haverbeke.berlin/wordgard/wordgard/src/commit/ece17b815ac0263f2f9efb967fa938eefa2ff4b9/src/history/history.ts)

No Wordgard binding or browser fixture has been implemented or qualified yet.
