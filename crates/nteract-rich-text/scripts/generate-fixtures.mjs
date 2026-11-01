import { readFile, writeFile } from "node:fs/promises";
import { deepStrictEqual } from "node:assert";
import { importLegacy, exportLegacy, javaScriptDocumentFixture } from "./legacy-codec.mjs";

const cases = [
  { id: "empty", markdown: "" },
  { id: "paragraph", markdown: "A shared document." },
  { id: "paragraphs", markdown: "First paragraph.\n\nSecond paragraph." },
  { id: "soft-break", markdown: "First line\nsecond line" },
  { id: "crlf-soft-break", markdown: "First line\r\nsecond line" },
  { id: "hard-break", markdown: "First line  \nsecond line" },
  { id: "heading-levels", markdown: "# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six" },
  { id: "setext-heading", markdown: "Heading\n=======\n\nParagraph." },
  { id: "marks", markdown: "Plain **strong**, *emphasis*, `code`, and ***both***." },
  { id: "marked-code", markdown: "**`code`** and [`code`](https://x.test)" },
  { id: "mark-boundaries", markdown: "**bold *and italic* bold** then *italic **and bold** italic*." },
  { id: "literal-markers", markdown: "Escaped \\*stars\\*, \\_underscores\\_, \\`ticks\\`, and \\[brackets\\]." },
  { id: "link-title", markdown: '[A **strong** link](https://example.org/a "A title") and [mail](mailto:reader@example.org).' },
  { id: "relative-link", markdown: "[Section](#section) and [asset](/api/assets/example)" },
  { id: "bare-url", markdown: "https://example.org and reader@example.org remain prose." },
  { id: "unicode", markdown: "👩🏽‍💻 **café é** 中文 Ελληνικά 🇳🇿 🧑‍🚀." },
  { id: "image", markdown: '![A cat](/api/assets/cat "Cat portrait")' },
  { id: "image-alt", markdown: 'Before ![Cat \\[meow\\] &amp; **friends**](/api/assets/cat "Portrait") after.' },
  { id: "image-beside-marks", markdown: '**Before** ![**caption**](image.png) [after](https://example.org)' },
  { id: "image-empty-alt", markdown: "![](/api/assets/cat)" },
  { id: "image-alt-break", markdown: "![one  \ntwo](x)" },
  { id: "mermaid", markdown: "```mermaid\ngraph TD\n  A[Write] --> B[Share]\n```" },
  { id: "code-info", markdown: "```rust title=demo\nfn main() {}\n```" },
  { id: "code-backticks", markdown: "A `` `quoted` `` value.\n\n````text\n```inside```\n````" },
  { id: "indented-code", markdown: "    a < b\n    next()" },
  { id: "quote", markdown: "> First paragraph.\n>\n> Second paragraph." },
  { id: "nested-quote", markdown: "> Outer\n>\n> > Inner\n> >\n> > Last" },
  { id: "bullet-list", markdown: "- First\n- Second" },
  { id: "numbered-list", markdown: "3. Third\n4. Fourth" },
  { id: "nested-list", markdown: "- Parent\n  - Child\n  - Other\n- Sibling" },
  { id: "nested-only-bullet-siblings", markdown: "-\n  - a\n-\n  - b\n" },
  { id: "nested-only-ordered-siblings", markdown: "1.\n   1. a\n2.\n   1. b\n" },
  { id: "nested-only-mixed-siblings", markdown: "-\n  1. a\n-\n  1. b\n" },
  { id: "quoted-nested-only-bullets", markdown: "> -\n>   - a\n> -\n>   - b\n" },
  { id: "quoted-nested-only-ordered", markdown: "> 1.\n>    - a\n> 2.\n>    - b\n" },
  { id: "list-paragraphs", markdown: "- First paragraph\n\n  Second paragraph\n\n- Another item" },
  { id: "tasks", markdown: "- [ ] Pending\n- [x] Complete\n- [X] Also complete" },
  { id: "mixed-tasks", markdown: "- Ordinary\n- [ ] Pending\n- [x] Done\n- Ordinary again" },
  { id: "nested-tasks", markdown: "- [ ] Parent\n  - [x] Child\n  - Ordinary child\n- [x] Sibling" },
  { id: "nested-only-task-siblings", markdown: "- [ ]\n  - [x] a\n- [x]\n  - [ ] b\n" },
  { id: "task-link", markdown: "- [ ] [Read the guide](https://example.org/guide)" },
  { id: "literal-task", markdown: "- \\[ \\] Literal\n- `[x]` Code\n\nProse [ ] remains literal." },
  { id: "ordered-literal-task", markdown: "1. [ ] This is an ordinary numbered item" },
  { id: "table", markdown: "| Capability | Meaning |\n| --- | --- |\n| **Native** | Shared state |\n| Editing | `splice` |" },
  { id: "table-alignment", markdown: "| Left | Center | Right |\n| :--- | :---: | ---: |\n| a | b | c |" },
  { id: "table-empty", markdown: "| A | B |\n| --- | --- |\n| | |\n| x | |" },
  { id: "table-ragged-import", markdown: "| A | B | C |\n| --- | --- | --- |\n| only |\n| x | y | z | extra |" },
  { id: "table-pipes", markdown: "| Text | Code |\n| --- | --- |\n| a\\|b | `c\\|d` |" },
  { id: "table-breaks", markdown: "| A | B |\n| --- | --- |\n| first<br>second | third<BR />fourth |" },
  { id: "table-literal-breaks", markdown: "| Escaped | Entity | Code |\n| --- | --- | --- |\n| \\<br> | &lt;br&gt; | `<br>` |" },
  { id: "table-in-quote", markdown: "> | A | B |\n> | --- | --- |\n> | x | y |" },
  { id: "sibling-tables-in-quote", markdown: "> | A |\n> | --- |\n> | a |\n>\n> | B |\n> | --- |\n> | b |\n" },
  { id: "table-in-list", markdown: "- Introduction\n\n  | A | B |\n  | --- | --- |\n  | x | y |" },
  { id: "inline-html-literal", markdown: "Literal <b>text</b> stays visible." },
  { id: "highlight-strong", markdown: 'Set the **<mark data-color="green">launch date</mark>** today.' },
  { id: "highlight-custom", markdown: "A <mark data-color=\"#1a2b3c\">custom</mark> and <MARK DATA-COLOR=' #ABCDEF '>uppercase</MARK> color." },
  { id: "highlight-bare-line-start", markdown: "<mark>Bare</mark> highlight starts the line." },
  { id: "highlight-heading-quote", markdown: "# <mark data-color='pink'>Heading</mark>\n\n> - <mark>quoted\n> item</mark>" },
  { id: "highlight-code-link", markdown: '<mark data-color="blue">see `code`</mark> and [<mark>linked</mark>](https://example.org)' },
  { id: "highlight-across-strong", markdown: "<mark>a **b</mark> c**" },
  { id: "highlight-table", markdown: '| A | B |\n| --- | --- |\n| <mark data-color="blue">x</mark> | y<br><mark>z</mark> |' },
  { id: "highlight-nested-literal", markdown: '<mark>a <mark data-color="pink">b</mark> c</mark>' },
  { id: "highlight-unbalanced-literal", markdown: "Close </mark> first, then <mark>never closed." },
  { id: "highlight-invalid-color-literal", markdown: 'An <mark data-color="red">invalid</mark>, <mark data-color="">empty</mark> and <mark data-color=green>unquoted</mark> color.' },
  { id: "highlight-escaped-literal", markdown: "Write \\<mark> tags as text." },
  { id: "highlight-image-alt", markdown: "![<mark>x</mark> y](cat.png)" },
  { id: "literal-marker-html", markdown: "<marker>not a highlight</marker>", import_id: "marker-import" },
  { id: "literal-mark-autolink", markdown: "<mark:x>", import_id: "mark-autolink-import" },
  { id: "literal-mark-nbsp", markdown: "<mark\u00a0>x</mark>", import_id: "mark-nbsp-import" },
  { id: "literal-html", markdown: "<section>Preserve this</section>", import_id: "html-import" },
  { id: "literal-math", markdown: "The value is $x + 1$.", import_id: "math-import" },
  { id: "literal-display-math-spaced", markdown: "Before $$ \\{x\\} $$ after.", import_id: "display-spaced-import" },
  { id: "literal-display-math-inline", markdown: "Inline $$x$$ math.", import_id: "display-inline-import" },
  { id: "literal-display-math-block", markdown: "Before\n\n$$\n\\{x\\}\n$$\n\nAfter", import_id: "display-block-import" },
  { id: "literal-display-math-escapes", markdown: "Escapes $$\\frac{a}{b} \\_ \\{x\\}$$ stay.", import_id: "display-escapes-import" },
  { id: "literal-display-opener-lf", markdown: "Before\n$$\n\\{x\\}", import_id: "opener-lf-import" },
  { id: "literal-display-opener-cr", markdown: "Before\r$$\n\\{x\\}", import_id: "opener-cr-import" },
  { id: "literal-display-opener-crlf", markdown: "Before\r\n$$\r\n\\{x\\}", import_id: "opener-crlf-import" },
  { id: "literal-display-opener-cr-indented", markdown: "Before\r\r \t$$\r\\{x\\}", import_id: "opener-cr-indented-import" },
  { id: "literal-display-opener-feff", markdown: "Before\n\ufeff$$\n\\{x\\}", import_id: "opener-feff-import" },
  { id: "literal-display-opener-leading-bom", markdown: "\ufeff$$\n\\{x\\}", import_id: "opener-leading-bom-import" },
  { id: "literal-display-opener-nbsp", markdown: "Before\r\u00a0$$\n\\{x\\}", import_id: "opener-nbsp-import" },
  { id: "literal-display-opener-line-separator", markdown: "Before\u2028$$\n\\{x\\}", import_id: "opener-line-separator-import" },
  { id: "literal-display-opener-paragraph-separator", markdown: "Before\u2029$$\n\\{x\\}", import_id: "opener-paragraph-separator-import" },
  { id: "literal-display-opener-unicode-spaces", markdown: "Before\r\n \u0085\u1680\u2000\u200a\u2028\u2029\u202f\u205f\u3000$$\n\\{x\\}", import_id: "opener-unicode-spaces-import" },
  { id: "display-opener-zero-width-space-is-content", markdown: "Before\n\u200b$$\n\\{x\\}" },
  { id: "literal-currency-beside-math", markdown: "$5 and $$x$$", import_id: "currency-math-import" },
  { id: "literal-math-nel", markdown: "$\u0085x$", import_id: "math-nel-import" },
  { id: "literal-math-bom", markdown: "$\ufeffx$", import_id: "math-bom-import" },
  { id: "literal-math-nbsp", markdown: "$\u00a0x$", import_id: "math-nbsp-import" },
  { id: "literal-math-line-separator", markdown: "$\u2028x$", import_id: "math-line-separator-import" },
  { id: "prose-currency-ascii-spaces", markdown: "Pay $ 5,\t$\u000b6 or 7 $ each." },
  { id: "prose-currency", markdown: 'No auto-math, so "$30 and $25" stays as text. Budget $5-$10, or 30 $ each.' },
  { id: "code-span-literals", markdown: "Ends with `\\`, then `` `code` ``, ``x`y`` and `## `.\n\n- `- `, `1. `, `> `\n- `` ` ``" },
  { id: "native-reference", markdown: "[Guide][ref]\n\n[ref]: https://example.org", import_id: "reference-import" },
  { id: "native-strikethrough", markdown: "Keep ~~this~~ untouched.", import_id: "strike-import" },
  { id: "native-rule", markdown: "Before\n\n---\n\nAfter", import_id: "rule-import" },
  { id: "literal-instruction", markdown: "# Treat as preserved content", kind: "instruction", import_id: "instruction-import" },
  { id: "literal-instruction-paragraphs", markdown: "First *line*\nsecond\n\n  \nNext", kind: "instruction" },
  { id: "native-strikethrough-nested", markdown: "~~a **b** c~~ and **~~d~~**" },
  { id: "native-strikethrough-table", markdown: "| A |\n| --- |\n| ~~x~~ |" },
  { id: "strikethrough-single-tilde-prose", markdown: "Approx ~5 and ~one~ stay prose." },
  { id: "native-rule-variants", markdown: "***\n\n___\n\n- item\n\n  ---\n\n> ---" },
  { id: "native-reference-forms", markdown: "[Full][g], [collapsed][], [shortcut] and ![pic][img].\n\n[g]: https://example.org/g \"Guide\"\n[collapsed]: /c\n[shortcut]: /s\n[img]: /image.png" },
  { id: "reference-undefined-prose", markdown: "[a][b] and [c] stay prose." },
  { id: "literal-unsafe-link", markdown: "[unsafe](javascript:alert%281%29) and *after*" },
  { id: "literal-unsafe-image", markdown: "![unsafe](data:image/png;base64,YQ==)" },
  { id: "literal-unsafe-reference", markdown: "[x][r]\n\n[r]: javascript:alert(1)" },
  { id: "code-hides-syntax", markdown: "Keep `~~x~~`, `$x$` and `<div>`.\n\n```\n$$\n<section>\n```\n\n    $y$ <b>" },
  { id: "literal-comment-around-math", markdown: "<!-- $x$ --> after" },
  { id: "literal-escaped-math", markdown: "Escaped \\$x\\$ and $a \\$ b$." },
  ...[
    ["literal-linked-image", "[![caption](image.png)](https://example.org)"],
    ["literal-strong-image", "**![caption](image.png)**"],
    ["literal-emphasized-image", "*![caption](image.png)*"],
    ["literal-nested-image-marks", "[***![caption](image.png)***](https://example.org)"],
    ["literal-linked-image-with-prose", "Before\n\n[Text and ![caption](image.png)](https://example.org)\n\nAfter\n"],
    ["literal-marked-table-image", "| A |\n| --- |\n| **![caption](image.png)** |"],
    ["literal-linked-heading-image", "# [![caption](image.png)](https://example.org)"],
    ["literal-marked-nested-list-image", "> - *![caption](image.png)*"],
    ["literal-highlighted-image", "<mark>![caption](image.png)</mark>"],
    ["literal-extra-table-cells", "| A |\n| --- |\n| b | c |"],
    ["literal-extra-table-cells-quoted", "> | A | B |\n> | --- | --- |\n> | 1 | 2 | 3 |"],
    ["literal-empty-link", "Before [](https://example.org) after"],
    ["literal-unused-definition", "Prose.\n\n[unused]: https://example.org"],
    ["literal-repeated-definition", "[a][r]\n\n[r]: /one\n[r]: /two"],
    ["escaped-pipe-cell-is-native", "| A |\n| --- |\n| b \\| c |"],
    ["short-row-is-native", "| A | B |\n| --- | --- |\n| c |"],
    ["literal-math-across-cells", "| a | b |\n| - | - |\n| `$x | y$` |"],
    ["literal-html-across-cells", "| a | b |\n| - | - |\n| `<i> | </i>` |"],
    ["code-within-one-cell", "| a |\n| - |\n| `$x$ <i>` |"],
    ["literal-long-tag", `<a title="${"x".repeat(600)}">t</a>`],
    ["literal-quoted-gt-tag", '<a href="x>y">t</a> and <b c=\'>\'>d'],
    ["literal-comment-with-gt", "<!-- a > b --> and <?php x > y ?>"],
    ["literal-multiline-tag", 'text <a\nb="c">'],
    ["not-a-tag-nbsp", "<mark\u00a0>x</mark>"],
    ["not-a-tag-unspaced-attribute", "<a b='x'c>"],
    ["literal-definition-then-setext", "[r]: x\n==="],
  ].map(([id, markdown]) => ({ id, markdown })),
  { id: "destinations-are-not-syntax", markdown: '[a](<x> "<b> $t$") and ![p](</$y$/i.png>) then $z$\n\n[r]: <x>' },
];

const fixtures = cases.map((input) => {
  const expected_spans = importLegacy(input.markdown, input.import_id, input.kind);
  return { ...input, expected_spans, canonical_markdown: exportLegacy(expected_spans) };
});

// Differences from the JavaScript codec, each with its exact Rust result.
const divergences = [
  {
    id: "nested-quote-siblings-preserved",
    markdown: "> > a\n\n> > b",
    reason: "The legacy span adapter omits both outer quote markers and merges sibling quotes. Rust retains the second outer marker to preserve the boundary.",
    legacy_spans: importLegacy("> > a\n\n> > b"),
    legacy_export_spans: importLegacy("> > a\n\n> > b"),
    expected_spans: [
      { type: "block", value: { type: "blockquote", parents: ["blockquote"], attrs: {}, isEmbed: false } },
      { type: "text", value: "a", marks: {} },
      { type: "block", value: { type: "blockquote", parents: [], attrs: {}, isEmbed: false } },
      { type: "block", value: { type: "blockquote", parents: ["blockquote"], attrs: {}, isEmbed: false } },
      { type: "text", value: "b", marks: {} },
    ],
  },
];

const ragged = structuredClone(fixtures.find((item) => item.id === "table-empty").expected_spans);
// Drop the last empty cell: exported Markdown has to pad that row, rather than
// discarding the longer rows when imported again.
ragged.pop();
// Highlight states a native editor can produce: literal tag text, padded and
// overlapping ranges, and adjacent colors.
const text = (value, marks = {}) => ({ type: "text", value, marks });
const nativeCases = [
  ["ragged-native-table", ragged],
  ["highlight-literal-tag-text", [text("use <mark> tags and </MARK> too")]],
  ["highlight-padded", [text("Note:"), text(" padded ", { highlight: "pink" }), text("end")]],
  [
    "highlight-overlaps-strong",
    [
      text("bold ", { strong: true }),
      text("both", { strong: true, highlight: "green" }),
      text(" high", { highlight: "green" }),
    ],
  ],
  ["highlight-adjacent-colors", [text("a", { highlight: "blue" }), text("b", { highlight: "#ff00aa" })]],
];
const export_cases = nativeCases.map(([id, spans]) => ({
  id,
  spans,
  expected_spans: importLegacy(exportLegacy(spans)),
  canonical_markdown: exportLegacy(spans),
}));

const document = {
  profile: "pages-markdown-v1",
  oracle: "docs/memos/authenticated-automerge-app-substrate/experiment/pages/model/richtext.mjs",
  fixtures,
  divergences,
  export_cases,
};
const target = new URL("../fixtures/compatibility.json", import.meta.url);
const javascriptTarget = new URL("../fixtures/javascript-automerge.json", import.meta.url);
const coreMarkdown = '## Shared café 🦀\n\nA **strong** *shared* [link](https://example.org "site") and `code`.\n\n- [ ] Read\n- [x] Write\n\n| A | B |\n| :--- | ---: |\n| one | two |';
const imageMarkdown = '![Cat](/api/assets/cat "cat")';
const javascriptDocument = {
  documents: [
    { id: "legacy-core", ...javaScriptDocumentFixture(coreMarkdown) },
    { id: "wordgard-rich", ...javaScriptDocumentFixture(`${coreMarkdown}\n\n${imageMarkdown}`, true) },
    { id: "legacy-image-text", ...javaScriptDocumentFixture(imageMarkdown) },
  ],
};
if (process.argv.includes("--check")) {
  deepStrictEqual(JSON.parse(await readFile(target, "utf8")), document);
  deepStrictEqual(JSON.parse(await readFile(javascriptTarget, "utf8")), javascriptDocument);
  console.log(`Legacy oracle matches ${fixtures.length} imports, ${divergences.length} declared divergences, and ${export_cases.length} exports.`);
  console.log(`JavaScript Automerge fixtures match ${javascriptDocument.documents.length} persisted documents.`);
} else {
  await writeFile(target, `${JSON.stringify(document, null, 2)}\n`);
  await writeFile(javascriptTarget, `${JSON.stringify(javascriptDocument, null, 2)}\n`);
  console.log(`Wrote ${target.pathname}`);
  console.log(`Wrote ${javascriptTarget.pathname}`);
}
