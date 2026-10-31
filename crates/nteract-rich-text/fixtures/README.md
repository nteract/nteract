# Pages compatibility corpus

`compatibility.json` records the current JavaScript Pages codec's span output.
The generator imports `model/richtext.mjs` and the installed Pages dependencies;
it is a test oracle, not a production runtime dependency of the Rust crate.
`canonical_markdown` is exported from those spans, rather than the initial
Markdown parse tree, so it includes existing span-normalization behavior such
as ordered lists starting at one.

The corpus covers marks, links, Unicode, images, code/Mermaid, headings,
paragraphs, nested lists and quotes, tasks, native tables and alignment, empty
cells, ragged rows, pipes, and table hard breaks. Unsupported HTML, math,
reference links, strikethrough, and non-Markdown input retain opaque source and
import provenance. General GFM support is not the Pages compatibility profile:
bare URLs remain prose, for example. A `$$` pair anywhere on a line is
preserved, with or without surrounding spaces. Single-dollar math follows
Pandoc's dollar rule, so currency such as "$30 and $25" stays prose. Both
codecs treat only ASCII whitespace as a space in that rule; fixtures with
U+0085, U+FEFF, U+00A0 and U+2028 pin the shared set. Code spans keep
backslashes, nested backticks, and trailing spaces literal.

Highlights project as `<mark data-color="…">` tags. Fixtures cover marks around
and inside the tag, palette and hex colors, bare `<mark>` at a line start, table
cells, tags that cross emphasis boundaries, and nested, unbalanced, escaped, or
invalid-color tags that stay literal text. `<marker>` at a line start remains
opaque. Both codecs read mark names and value rules from the Pages
`model/marks.json` registry.

Structural-only sibling list items retain explicit parent markers even when
their first content is another list. Bullet, ordered, mixed, task, and quoted
variants ensure that adjacent items cannot collapse into one container.

`divergences` explicitly records intentional differences from the old codec:
thematic breaks must be preserved rather than dropped, and unsafe destinations
are preserved as opaque source; the legacy parser literalizes a rejected link
and accepts a data image that later Pages validation rejects. Each includes observed
legacy spans and the exact required Rust result. There is no blanket exception
for parser differences.

Linked, emphasized, or highlighted images also retain the whole original source as opaque
content: native image markers cannot carry those enclosing marks. Fixtures
cover nested wrappers, surrounding prose, headings, lists, and table cells.
Ordinary images, formatting inside alt text, adjacent marked prose, and text
links keep their existing native mappings.

The nested-quote sibling case preserves the boundary between two outer quotes;
the legacy span adapter merges them. Its `legacy_export_spans` records that exact
legacy reimport result, while native and Wordgard round trips must preserve both
outer quotes. This exception does not relax other structural comparisons.

`export_cases` covers structure that can arise from native edits, including a
ragged table. Markdown must pad missing cells to retain all rows on reimport.
This is a bounded compatibility corpus, not proof that every CommonMark input
or arbitrary editor state is losslessly representable in Markdown. A table
directly at the start of a list item cannot round-trip through the current
legacy span adapter; the nested table fixture includes an initial paragraph.

From the repository root, after installing the Pages experiment dependencies:

```sh
node crates/nteract-rich-text/scripts/generate-fixtures.mjs --check
cargo build -p nteract-rich-text --example codec
cargo build -p nteract-rich-text --target wasm32-unknown-unknown
node crates/nteract-rich-text/scripts/check-parity.mjs
```

The parity check runs identical requests through the native executable and WASM,
checks imported spans against the oracle, and reparses Rust exports through both
codecs. It also verifies rejection paths return matching errors. Only adjacent
text spans with identical marks are coalesced; structural markers, attributes,
checked state, and opaque provenance are compared without normalization.

The same corpus also crosses the headless Wordgard model: decode, encode, Rust
export/import, then decode again must yield an equal Wordgard document. Wordgard
omits the initial paragraph marker in the `paragraphs` and `code-backticks`
fixtures, and adds an explicit quote marker in `table-in-quote`. Document
equality validates those different representations without relaxing the separate
strict import assertions. This checks the model boundary, not browser editing,
selection mapping, or IME behavior.

`javascript-automerge.json` contains actual JavaScript-authored Automerge saves,
encoded as hex for native tests without another dependency. A fixed actor and
zero timestamps make regeneration deterministic. `--check` compares the persisted
bytes and heads as well as the Markdown and input spans. `legacy-core` exercises
the existing parser's marks, headings, tasks and tables. `wordgard-rich` also
includes an image and uses Wordgard's encoder. Native reconciliation must retain
their heads and object identity. This catches differences such as signed versus
unsigned integer attributes that plain JSON parity cannot detect. Generation
uses the package's ESM exports, as Pages does.

`legacy-image-text` records an adoption gate: the legacy parser stores image alt
and title as nested Automerge Text objects, while Wordgard uses immutable strings.
The current native adapter rejects those Text attributes instead of silently
changing their identity or discarding history. JSON span equality alone does not
expose that storage difference. Resolving it requires a separate compatibility
decision before using the native adapter against existing Pages documents.

To deliberately refresh the oracle after reviewing a Pages codec change, run
the generator without `--check` and inspect the fixture diff. Do not regenerate
goldens just to make a Rust discrepancy pass. Production cutover requires its
own compatibility review and document-preservation checks.
