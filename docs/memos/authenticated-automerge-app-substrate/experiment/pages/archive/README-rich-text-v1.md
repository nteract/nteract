# Pages rich text v1: codec, Markdown import, stored forms

Archived 2026-11-08: superseded by docs/memos/authenticated-automerge-app-substrate/experiment/pages/DIRECTION.md; historical only.

This is the pre-v2 description of the Page rich-text codec, the ProseMirror Markdown path, and the stored forms the v1 build refuses. It was the "Document and editor" section of the Pages README.

## Document and editor (v1)

A Page contains its title, stable ordered block IDs and rich text in Automerge.
Its comments live in a second Automerge document beside it (see [Comments
document](../REFERENCE.md#comments-document)). The native spans are the document. Markdown
is a lossy projection for import, export and agent prose; node operations
(`insert_node`, `insert_image`, `set_node`) write what Markdown can't express,
such as a dataframe (see Dataframes below). A dedicated title
is displayed above the body; agents should not repeat it as an opening heading.
Authoring receipts warn about likely duplicates without removing or hiding text.

Wordgard is the sole editor and applies native text splices, marks, and
structural spans. The shared Markdown codec still uses the ProseMirror schema
and span adapter for import, validation, and the node content outlines and
change reads report. It does not own an editor or mediate Wordgard
keystrokes. Markdown export serializes Wordgard's tree
(`model/markdown-serializer.mjs`); a block's projection reads its spans with
`decode`, except shapes `decode` reads differently from the adapter (a marker
under an unknown container, a newline stored as prose text), which still read
through the adapter. `model/markdown-serializer.test.mjs` pins the output
against frozen Markdown from the ProseMirror serializer it replaced. Page-body Markdown writes and browser structural edits
share one span encoder, Wordgard's `encode` (`model/wordgard-doc.mjs`):

- Browser edits encode the editor's document.
- Page-body Markdown writes parse with the ProseMirror codec, and `pageSpans`
  (`model/richtext-spans.mjs`) re-encodes the adapter's spans with `encode`.

Agent-written comments take the same path: `markdownCommentSpans`
(`model/comment-content.mjs`) stores `pageSpans` of the parsed Markdown.

The codec is split by job; `model/richtext.mjs` lists the modules and
re-exports their public names. Only `model/pm-*.mjs` import ProseMirror
packages, and `model/pm-boundary.test.mjs` fails when another production
module does.

Block types are declared once in `model/node-registry.mjs`: stored names,
ProseMirror names, agent-facing names, settable attrs and insert operations.
The ProseMirror schema, Wordgard's decode and encode, and
`features.json` still define types in their own terms;
`node-registry.test.mjs` fails when one of them disagrees with the registry.
A top-level node's id (`model/node-ids.mjs`) is an Automerge cursor at the
block marker that opens it. Outlines and change reads report it as `node_id`,
and `delete_node` takes it, so an agent can remove a node with no text. A
paragraph that opens its block has no marker and no id. Ids, node ranges,
`node_index` scoping and target-scoped passage addresses come from Wordgard's
decoded tree and its position maps (`model/node-addresses.mjs`), checked
against frozen expectations over the Markdown corpus, random editor trees and
stored shapes (`model/node-addresses.test.mjs`). `set_node` still addresses
nodes through `match_text`. Replacing the codec means, in order: one
span encoder for every writer; node reads by id; Markdown export from that
node tree; then outlines, change reads, validation and parsing on it instead
of ProseMirror.
Existing documents, comment anchors and MCP addresses must survive each step.

Each Pages block has its own continuous editor. Moves update fractional positions without recreating the block or its
text object, preserving comment and selection anchors. Concurrent positions use
block IDs as deterministic ties. Cross-Pages-block selections remain unsupported.
When a block ends in a code block, table, unknown block or an image, ArrowDown
on its last line, Mod-Enter, or a click below it adds an empty paragraph and puts
the caret there. Mod-Enter also leaves a code block anywhere else. The paragraph
is an ordinary edit, written only when someone asks for it, so opening a Page
writes nothing.
The Wordgard binding keeps each block's decoded tree and position maps with
the Automerge heads they describe (`viewer/wordgard-projection-state.mjs`).
Plain typing commits the editor's own tree and shifts the maps, then checks the
native length and the inserted text; remote plain-text insertions and
deletions apply their patches to the tree. Structural and formatting writes
read the block once, as their check, and anything else falls back to a
whole-block read. A failed check discards the projection, so the next write
reads the block. `viewer/wordgard-binding-parity.test.mjs` compares the carried
projection with a fresh decode after every generated step, and runs each local
transaction through a `verify` binding on a twin replica, which must accept or
reject it the same way.
The binding's upstream attribution is in [WORDGARD-NOTICE](../viewer/WORDGARD-NOTICE).

## Markdown import (v1)

- **Markdown import:** every construct Markdown-it reads has a native mapping,
  except math and HTML other than highlight tags (and `<br>` in a table cell).
  Markdown that would parse to less than it says is unsupported too: an image
  inside a link or mark, a table row with more cells than its header, a link
  with no text, and a reference definition no link uses (or a repeated label).
  Behind those named cases is a general check: after parsing, every link href,
  image src and alt, and all visible text (whitespace aside) must be in the
  native spans. Anything else is `unrepresentable`.
  Strikethrough (`~~x~~`) is the `strike` mark, `---` a horizontal rule, and
  reference links resolve to ordinary links at import. Code spans, fenced and
  indented code, escaped characters, and link destinations and titles never
  count as math or HTML.
  - Agent writes (create, insert/replace Markdown, comments with
    `body_format: "markdown"`) refuse these with
    `400 unsupported_markdown` and `unsupported: { construct, line, column,
    excerpt }`, before anything is written. The column counts code points.
  - Stored source and paste keep math and HTML as literal,
    editable text. Lossy source is literal text in full, so nothing is lost.
    Export escapes literal `$` and `<`, so a read is always writable.
  - Export writes lists tight with `-` bullets. The native model doesn't
    record blank lines between items, so a list reads back loose only when an
    item holds a second block, which Markdown can't write tight.
  - Markdown writes store the spans the editor's own encoder writes
    ([`pageSpans`](../model/richtext-spans.mjs) runs Wordgard's `encode`). The
    editor's first structural edit (Enter, a cross-block delete, a block
    paste, a list toggle) in an agent-written block stores the same spans;
    plain typing never rewrites a block.
    [`markdown-projection.test.mjs`](../model/markdown-projection.test.mjs)
    checks every corpus case. Five cases still write on that edit: Automerge
    3.5's `updateSpans` unmarks and marks again any mark that covers more
    than one span, even when the spans are unchanged. Those ops can win over
    a peer's concurrent change to the same mark; the test pins it.
  - The scan masks code per table cell, as Markdown-it splits cells first,
    and recognizes a tag of any length, with `>` inside quoted values, in
    linear time.
  - Nothing writes a preserved block (`pages-opaque`), and the schema has no
    node for one. A stored marker an older build wrote reads as an unknown
    block, as below (see Stored forms).
  - A node this build doesn't know, from a newer build, still opens. Its
    feature stamp makes the Page read-only here and refuses this build's
    writes. The editor draws a notice (`PagesUnknownBlock`,
    `PagesUnknownEmbed` in `model/wordgard-doc.mjs`) whose value is the
    stored marker (type, attrs, parents, isEmbed), so encode writes it back
    exactly. Where `decode` can't draw a node as stored (a block inside a
    table cell or code block, a container that owns text, a parent type it
    doesn't know) it reports `lossy`, the editor opens that block read-only
    and the binding refuses its writes, so a Page that reached this build
    without a stamp still can't be flattened. Reads project
    `[Unsupported node: <type>]`, through a text fallback where the adapter
    can't place the node, and `replace_block_markdown` refuses a block whose
    types or parents include one with `markdownless_node`. Registration still
    refuses an unknown marker.

## Stored forms (v1)

- **Stored forms:** every block is rich text (`format: "automerge-rich-text-v1"`)
  and every Page carries the `comments-doc` stamp. Earlier builds also stored
  Markdown-only blocks, read-only `pages-opaque` preserved blocks and threads
  in the Page document; a one-shot content migration rewrote every stored Page
  before this build stopped reading those forms. A reader that meets one now
  refuses it: tool reads answer `409 stored_form_unsupported`
  ([`model/stored-form.mjs`](../model/stored-form.mjs)), the viewer shows a notice
  in place of a Markdown-only block, and a stored `pages-opaque` marker reads
  as an unknown block, kept as stored. The `preserved-markdown-converted` id
  stays in `features.json`: ids are never dropped.
