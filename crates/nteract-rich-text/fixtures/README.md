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
bare URLs remain prose, for example.

`divergences` explicitly records intentional differences from the old codec:
thematic breaks must be preserved rather than dropped, and unsafe destinations
are preserved as opaque source; the legacy parser literalizes a rejected link
and accepts a data image that later Pages validation rejects. Each includes observed
legacy spans and the exact required Rust result. There is no blanket exception
for parser differences.

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

To deliberately refresh the oracle after reviewing a Pages codec change, run
the generator without `--check` and inspect the fixture diff. Do not regenerate
goldens just to make a Rust discrepancy pass. Production cutover requires its
own compatibility review and document-preservation checks.
