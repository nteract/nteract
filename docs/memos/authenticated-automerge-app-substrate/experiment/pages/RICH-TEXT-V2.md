# Pages rich text v2

**Status:** approved direction, 2026-11-08. Not built yet. `main` still runs
v1; [REFERENCE.md](REFERENCE.md) describes it. Items under
[Open decisions](#open-decisions) are proposals, not decisions.

Pages has one rich-text model: the Wordgard tree. It's stored as Automerge rich
text. People edit it in the Wordgard editor. Agents read and write the same tree
through the API. Markdown is a convenience format at the agent edge. It is never
the model, and nothing converts through ProseMirror.

v2 ships on fresh targets, so the stored format has no compatibility obligation
to v1 spans.

## Why this is smaller than it sounds

Every writer already stores Wordgard's encoding (since #4729). ProseMirror is an
in-memory step between Markdown and that encoder, plus tolerance for spans
written before that change. Remove those two and ProseMirror is gone.

The real work is a block-level Markdown-to-tree parser. Inline Markdown already
parses straight to Wordgard (`model/markdown-inline.mjs`).

## Three layers

Input Markdown for the example below:

```markdown
Intro with **bold** and a [link](https://nteract.io).

## Tasks

- [ ] write spec
- [x] read code

> Quote with a list:
>
> - one
```

### Layer 1: the Page document (Automerge map)

Blocks live in a map keyed by ID. Order comes from a `position` string, a
fractional index, with the ID as tiebreak (`model/order.mjs`). Today's shape:

```json
{
  "page_id": "p1",
  "title": "Example",
  "schema": { "features": ["comments-doc"] },
  "blocks": {
    "3eafb336-…": {
      "id": "3eafb336-…",
      "position": "a0",
      "kind": "markdown",
      "format": "automerge-rich-text-v1",
      "markdown": "",
      "metadata": {},
      "richText": "<Automerge text object>"
    }
  }
}
```

Proposed v2 shape:

```json
{
  "page_id": "p1",
  "title": "<Automerge Text>",
  "schema": { "features": { "tables": true } },
  "blocks": {
    "3eafb336-…": {
      "position": "<RawString a0>",
      "richText": "<Automerge Text, flat markers>"
    }
  }
}
```

| Field | v2 | Reason |
| --- | --- | --- |
| `title` | Text, written with `A.updateText` | Concurrent title edits merge per character |
| `schema.features` | Map `{id: true}`, created in genesis | Set semantics for free; no conflict-union repair code |
| block `id` | Dropped | The map key is the ID |
| block `position` | `RawString`, scalar | A plain JS string becomes Text in Automerge 3, and concurrent moves would interleave characters |
| block `kind`, `format`, `markdown`, `metadata` | Dropped | Constants or always empty. The format version lives on the host's document descriptor (`pages.page` format 2) |
| `richText` | Text with flat markers | Layer 2 |

### Layer 2: one block's rich text (Automerge spans)

`richText` is one Automerge text sequence. Structure is flat block markers
inline with the text. Characters merge per character, so two people typing in
one block don't conflict. Today's spans for the example:

```json
[
  { "type": "text", "value": "Intro with " },
  { "type": "text", "value": "bold", "marks": { "strong": true } },
  { "type": "text", "value": " and a " },
  { "type": "text", "value": "link",
    "marks": { "link": "{\"href\":\"https://nteract.io\",\"title\":null}" } },
  { "type": "text", "value": "." },
  { "type": "block", "value": { "type": "heading", "parents": [], "attrs": { "level": 2 }, "isEmbed": false } },
  { "type": "text", "value": "Tasks" },
  { "type": "block", "value": { "type": "task-list-item", "parents": [], "attrs": { "checked": false }, "isEmbed": false } },
  { "type": "text", "value": "write spec" },
  { "type": "block", "value": { "type": "task-list-item", "parents": [], "attrs": { "checked": true }, "isEmbed": false } },
  { "type": "text", "value": "read code" },
  { "type": "block", "value": { "type": "blockquote", "parents": [], "attrs": {}, "isEmbed": false } },
  { "type": "text", "value": "Quote with a list:" },
  { "type": "block", "value": { "type": "unordered-list-item", "parents": ["blockquote"], "attrs": {}, "isEmbed": false } },
  { "type": "text", "value": "one" }
]
```

Three warts in that form cause concurrency bugs:

| Wart | Bug |
| --- | --- |
| The first paragraph has no marker | Two peers retyping it each insert one, leaving two. Its `node_id` is null |
| `parents` is an Automerge list | Two peers indenting the same item get a double indent neither wrote |
| The link value is a JSON string in a mark | Hard for agents to read and write; needs a parse per read |

The same list-item marker in v2 (proposed):

```json
{ "type": "block", "value": { "type": "unordered-list-item", "path": "blockquote", "attrs": {} } }
```

### Layer 3: the Wordgard tree (memory only)

`decode(spans)` in `model/wordgard-doc.mjs` builds this. It's never stored. The
editor renders it; reads and Markdown export walk it.

```json
{ "type": "Doc", "content": [
  { "type": "Paragraph", "content": [
    { "type": "Text", "param": "Intro with " },
    { "type": "Text", "param": "bold", "marks": { "Strong": null } },
    { "type": "Text", "param": " and a " },
    { "type": "Text", "param": "link",
      "marks": { "PagesLink": { "href": "https://nteract.io", "title": null } } },
    { "type": "Text", "param": "." } ] },
  { "type": "Heading", "param": 2, "content": [ { "type": "Text", "param": "Tasks" } ] },
  { "type": "PagesTaskList", "content": [
    { "type": "ListItem", "marks": { "PagesTaskChecked": false },
      "content": [ { "type": "Paragraph", "content": [ { "type": "Text", "param": "write spec" } ] } ] },
    { "type": "ListItem", "marks": { "PagesTaskChecked": true },
      "content": [ { "type": "Paragraph", "content": [ { "type": "Text", "param": "read code" } ] } ] } ] },
  { "type": "Blockquote", "content": [
    { "type": "Paragraph", "content": [ { "type": "Text", "param": "Quote with a list:" } ] },
    { "type": "BulletList", "content": [
      { "type": "ListItem", "content": [
        { "type": "Paragraph", "content": [ { "type": "Text", "param": "one" } ] } ] } ] } ] }
] }
```

## Invariants

These hold for every v2 change. A PR that breaks one is wrong, whatever its tests say.

1. **The Wordgard tree is the only in-memory model.** Editor, reads, export,
   validation and agent writes all use it.
2. **Storage is Automerge rich text with flat block markers.** One text sequence
   per block.
3. **Blocks are a map ordered by fractional `position`.** Sort by
   `(position, key)`, code-unit order. Never an Automerge list for movable
   order: a list move is delete plus insert, so concurrent moves duplicate the
   item and edits to the old copy vanish.
4. **Never rebalance positions** in a document peers sync. A rewrite of many
   positions scrambles concurrent inserts and can undo a concurrent move. The
   one allowed rekey is gap-opening inside a tie, which touches only the tied
   blocks to the right.
5. **Writes are minimal.** Text splices, marker inserts, marker deletes, and
   per-key puts on an existing marker. No whole-block rewrites, no
   `A.updateSpans` over existing content, no `A.updateBlock`. Both replace
   markers or re-assert marks over a peer's concurrent change.
6. **`decode` is total and repairs merge leftovers on read, without writing.**
   The host refuses only changes invalid on their own. The editor never
   auto-repairs; the next deliberate edit fixes the shape.
7. **Markdown exists only at the agent edge.** It's a read projection and a
   write input. It is never stored and never the model.
8. **No ProseMirror** in any production module or dependency.
9. **Fresh targets.** No byte compatibility with v1 spans, no adapter-form
   tolerance, no stored-form refusals.
10. **Mark values are scalars.** Automerge refuses object values; `null` unmarks.

## Codec (proposed)

Each text-holding node opens with its own marker. Containers never hold text.
Child markers name their containers in `path`.

| Tree node | Marker | Attrs | Followed by |
| --- | --- | --- | --- |
| Paragraph | `paragraph` | none | inline text, or nothing if empty |
| Heading | `heading` | `level` 1–6, always written | inline text |
| CodeBlock | `code-block` | `language`, omitted when empty | raw text, `\n` per line, no marks |
| Blockquote, Aside | `blockquote`, `aside` | none | first child's marker, always |
| ListItem | `unordered-list-item`, `ordered-list-item`, `task-list-item` | task: `checked`, always written | first child's marker, always |
| Bullet, ordered, task list | none | — | consecutive same-kind items at one path form one list |
| Table, TableRow | `table`, `table-row` | none | first child's marker |
| Cell, HeaderCell | `table-cell`, `table-header` | `align`, omitted when unset | inline text |
| HorizontalRule | `horizontal-rule` | none | next marker, never text |
| Dataframe | `dataframe` | `asset` (64 hex), `media_type`, `title`? | next marker, never text |
| Image (inline) | `image` | `asset`, `alt`?, `title`?, `dark_asset`? | inline text |
| LineBreak | none: the character `\n` | — | — |

Marker fields: `type` (registry name), `path` (container types joined by `/`,
`""` at top level), `attrs` (only keys the registry declares). `isEmbed` is
derived from the registry. An empty block is exactly one `paragraph` marker.
The editor never deletes a block's first marker.

| Mark | Value | Expands |
| --- | --- | --- |
| `strong`, `em`, `strike` | `true` | both sides |
| `code` | `true` | no |
| `highlight` | `yellow`, `green`, `blue`, `pink` or lowercase `#rrggbb` | both sides |
| `link` | href string, checked by `safeUrl` | no |

Embeds store an asset hash. The host derives the URL from the containing Page.

### Read rules

Two honest clients can merge into these shapes. `decode` normalizes them,
deterministically, without writing:

| Merged shape | Read as |
| --- | --- |
| Undeclared attrs after a retype; missing required attrs | Ignore undeclared, default missing |
| Inline image or block leaf inside code or a cell | A "Stray" chip that keeps its marker verbatim and deletes cleanly |
| Text right after a rule or dataframe, or leading text with no marker | Implied paragraph |
| Child marker whose container marker was deleted | Render-only container |
| Marks on `\n`, on markers, or on code text | Ignored |

Why read-normalize: the host accepts whichever change arrives first, so
refusing a merge refuses an honest client's change and forks its history.
Why no repair on write: inserted repair markers race, and two peers leave two.

### Unknown content

Admission refuses unknown types and marks unless the Page's feature stamp names
their feature. A build that lacks a stamped feature opens the Page read-only.
Minimal writes never touch content they don't edit, so the codec needs no
exact-marker preservation for unknown nodes.

## Admission

Per incoming change, in the host's `policy.admit`, from `A.diff` over the
touched paths:

| Check | Rule |
| --- | --- |
| Marker insert or put | Known type; `path` segments are container types, depth ≤ 32; declared attr keys; typed values; no nested objects or Text |
| Mark | Known name; value matches `marks.json` |
| Text | Well-formed UTF-16; block ≤ 256 KiB |
| Position | Scalar, ≤ 512 characters |
| Structure | None. Decode is total |

Cost is O(ops in the change). A keystroke is one splice patch.

## Agent interface (proposed)

| Topic | v2 |
| --- | --- |
| Addressing | One page-unique, opaque `node_id`. No `block_id`, `node_index` or `image_id` in ops |
| Reads | Markdown plus an outline (`node_id`, `type`, `attrs`, `summary`, `heading_path`, `anchor`). Optional `format: "tree"` |
| Content Markdown can't hold | A `pages-node` reference (fence for blocks, `pages-node:ID` image src). Sent back unchanged, it keeps the node; edited, it's refused; removed, it deletes the node |
| Writes | Markdown or a versioned JSON tree (`tree_version: 1`). The host diffs tree to tree and applies the smallest splice |
| Unsupported Markdown | Math and HTML other than highlight tags are refused with `unsupported_markdown` |
| Ops | `write`, `insert`, `delete`, `move`, `set_node`, `replace_match`, `format_match`, in one `edit_page` list |

The `write` algorithm:

1. Parse the input to a Wordgard fragment.
2. Align old and new nodes. `pages-node` references pin by ID; the rest align
   by LCS over `(type, normalized text)` with a similarity threshold.
3. Matched node: keep the marker, put changed attrs, splice changed text,
   `mark`/`unmark` changed runs only.
4. Unmatched old: splice out. Unmatched new: splice in marker, text and marks.
5. Check with `decode` and Wordgard `check()`, then commit. The receipt lists
   kept, inserted and deleted IDs.

Read, then write back unchanged, produces zero ops. Every fixture in
`model/markdown-corpus.json` must pass that test.

`node_id` survives text, mark and attr edits and retypes. Delete ends it.
Moving a node inside text mints a new ID, and the receipt maps old to new.

## Tests

Property tests with fast-check over generated trees and marker sequences:

| Property | Statement |
| --- | --- |
| Tree round trip | `decode(encode(t))` equals `t` |
| Span round trip | `encode(decode(s))` equals `s` when `s` is canonical |
| Totality | Any span sequence that passes admission decodes to a valid tree, never throws |
| Idempotent normalization | `decode(encode(decode(s)))` equals `decode(s)` |
| Merge closure | Two random edits merged in either order decode equally and validly |
| Identity | Retype and attr puts keep the marker's op ID |
| Admission parity | Every editor change passes admission; fuzzed attrs and nested values don't |
| Zero-op write-back | Read then write unchanged emits no ops |

Fixed fixtures: the three-layer example above and each merged shape in
[Read rules](#read-rules).

## Build order

Each PR is green and deployable alone. Each deploys to `pages2` first.

| PR | What | Deploy | Size |
| --- | --- | --- | --- |
| 1 | Delete parity goldens, frozen-base differentials and their helpers. Add a short behavior test where a golden was the only check. No production change | as-is | about −30k lines |
| 2 | v2 stored shape: drop block `kind`, `format`, `markdown`, `metadata`, `id`; compat comment forms; stored-form refusals. Features become baseline. Add a content-format guard to the build receipt and per-target history. Bump `VIEWER_PROTOCOL` | `pages2`, then reset `page10` empty | medium |
| 3 | One codec module (decode, encode, validate, read rules). Markdown tokens to tree. Writers build trees. Delete `model/pm-*.mjs`, the PM parts of `richtext-spans.mjs`, both PM dependencies, and v1 span tolerance | `pages2`, then `page10` | medium; main risk |
| 4 | Docs, agent guide, scripts, a dependency ban test. Rebuild admission (#4922) on the v2 validator | `pages2`, then `page10` | small |

`page10` resets before ProseMirror goes, so the new reader never reads v1 spans.

Effect on open work: close #4940 (native validation with old-byte parity). The
`pages-wordgard-markdown` writer branch is superseded by PR 3. #4939 (comment
labels) ships on the fresh format with no rollout phase.

## Targets

| Target | Role in v2 |
| --- | --- |
| `pages2` (`page2.runtimed.run`) | Fresh, empty. Every v2 build lands here first |
| `page10` | Reset empty after PR 2 qualifies on `pages2`. Export Projects first with the pre-PR-3 `project-transfer` |
| `pages` (`pages.runtimed.run`) | Not reset in place. Its v1 data stays readable by the v1 build. What happens to it after v2 ships is open |

The content-format guard makes `prepare`, `upload` and `install` refuse a v2
build on an un-reset target and a v1 build on a v2 target. See
[DEPLOYMENT.md](DEPLOYMENT.md) for runbooks.

## Open decisions

Proposals are in bold. None of these is decided.

| # | Question | Proposal |
| --- | --- | --- |
| 1 | Marker for every node, including the first paragraph and a container's first child? | **Yes** |
| 2 | Container path as one scalar string instead of the `parents` list? | **Yes** |
| 3 | Link value is the href; drop link titles? | **Yes.** Otherwise keep canonical JSON with fixed key order. Don't split the title into a second mark |
| 4 | Line breaks as `\n` text; drop the `hard-break` marker? | **Yes** |
| 5 | Block granularity | **Agents never see blocks; blocks stay coarse.** Enter and Backspace never cross a block boundary. Finer blocks wait until the editor edits across them |
| 6 | Table rows and list items: cut-and-paste moves, or map entries with `position`? | **Cut and paste for now** |
| 7 | External image URLs, or uploaded assets only? | open |
| 8 | Versioned JSON tree writes alongside Markdown? | **Yes** |
| 9 | Unsupported Markdown refused, not stored as literal text? | **Refuse** |
| 10 | `pages-node` reference as the escape form? | **Yes.** Alternative: refuse Markdown writes over ranges holding such nodes |
| 11 | Comments: same model with a smaller allowed set, or full parity? | **Smaller allowed set** |
| 12 | `pages.runtimed.run` after v2: freeze read-only, or export and import? | open |
| 13 | Loose Pages and comments: `project-transfer` exports Projects only. Accept the loss, move loose Pages into an archive Project, or extend the export? | open |
| 14 | Keep an archive copy of the old `page10` prefix past the bucket's 14-day version window? | open |

## What not to do

These paths look reasonable and are wrong. Agents have taken each of them.

| Wrong path | Why it's wrong | Do this instead |
| --- | --- | --- |
| Add or extend ProseMirror (schema, adapter, `prosemirror-markdown`, PM trees as a check) | A second model with its own normal form. Every conversion is a place to lose content | Build and check Wordgard trees |
| Treat Markdown as the model, or store it | Markdown can't hold dataframes, alignment, highlights or unknown nodes, and a round trip rewrites markers | Markdown in and out at the agent edge only |
| Byte-parity goldens against a frozen base or the PM serializer | They pin v1 bytes v2 deliberately changes, and block every fix | Property tests and the zero-op write-back test |
| Whole-block rewrites (`updateSpans(encode(tree))`, `replace_block_markdown` as a rewrite) | Character LCS replaces markers, strands comment anchors on stray letters, re-marks over a peer's unmark | Align nodes, then splice |
| `A.updateBlock` | Deletes and re-inserts the marker. Concurrent calls leave two | Per-key puts on the existing marker |
| Automerge lists for movable structure (block order, `parents`, sets) | No move op. Concurrent moves duplicate; edits to the moved item vanish | Map plus scalar `position`; scalar `path`; map-as-set |
| Rebalancing positions | Undoes concurrent moves and scrambles concurrent inserts | Insert between neighbours; accept key growth up to the cap |
| Auto-repair writes (editor or host inserting missing markers) | Repairs that insert race; two peers leave two | Read rules in `decode`; the next deliberate edit fixes it |
| Refusing merged shapes at admission | Refuses an honest client's change and forks its history | Refuse only op-local invalidity |
| Compatibility code for v1 spans, legacy comment forms or migrations | v2 targets start empty | Delete it |
