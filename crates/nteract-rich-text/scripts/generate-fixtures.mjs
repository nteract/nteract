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
  { id: "opaque-marker-html", markdown: "<marker>not a highlight</marker>", import_id: "marker-import" },
  { id: "opaque-mark-autolink", markdown: "<mark:x>", import_id: "mark-autolink-import" },
  { id: "opaque-mark-nbsp", markdown: "<mark\u00a0>x</mark>", import_id: "mark-nbsp-import" },
  { id: "opaque-html", markdown: "<section>Preserve this</section>", import_id: "html-import" },
  { id: "opaque-math", markdown: "The value is $x + 1$.", import_id: "math-import" },
  { id: "opaque-reference", markdown: "[Guide][ref]\n\n[ref]: https://example.org", import_id: "reference-import" },
  { id: "opaque-strikethrough", markdown: "Keep ~~this~~ untouched.", import_id: "strike-import" },
  { id: "opaque-rule-gate", markdown: "Before\n\n---\n\nAfter", import_id: "rule-import" },
  { id: "opaque-instruction", markdown: "# Treat as preserved content", kind: "instruction", import_id: "instruction-import" },
];

const fixtures = cases.map((input) => {
  const expected_spans = importLegacy(input.markdown, input.import_id, input.kind);
  return { ...input, expected_spans, canonical_markdown: exportLegacy(expected_spans) };
});

// Legacy PM's adapter has no thematic-break mapping: it returns zero spans.
// The Rust codec must preserve the input instead of reproducing that data loss.
const divergences = [
  {
    id: "thematic-break-preserved",
    markdown: "***",
    reason: "The legacy adapter drops thematic breaks. Rust preserves the whole source as opaque content.",
    legacy_spans: importLegacy("***"),
    expected_spans: [
      {
        type: "block",
        value: {
          type: "pages-opaque",
          parents: [],
          attrs: { source: "***", importId: "", kind: "markdown" },
          isEmbed: false,
        },
      },
    ],
  },
  ...["[unsafe](javascript:alert%281%29)", "![unsafe](data:image/png;base64,YQ==)"].map(
    (markdown, index) => ({
      id: index === 0 ? "unsafe-link-preserved" : "unsafe-image-preserved",
      markdown,
      reason: index === 0
        ? "Rust preserves unsafe links as opaque source; Markdown-it leaves this rejected link syntax as prose."
        : "Rust preserves unsafe images as opaque source; the legacy parser accepts a data image that Pages validation later rejects.",
      legacy_spans: importLegacy(markdown),
      expected_spans: [
        {
          type: "block",
          value: {
            type: "pages-opaque",
            parents: [],
            attrs: { source: markdown, importId: "", kind: "markdown" },
            isEmbed: false,
          },
        },
      ],
    }),
  ),
  ...[
    ["linked-image-preserved", "[![caption](image.png)](https://example.org)"],
    ["strong-image-preserved", "**![caption](image.png)**"],
    ["emphasized-image-preserved", "*![caption](image.png)*"],
    ["nested-image-marks-preserved", "[***![caption](image.png)***](https://example.org)"],
    ["linked-image-with-prose-preserved", "Before\n\n[Text and ![caption](image.png)](https://example.org)\n\nAfter\n"],
    ["marked-table-image-preserved", "| A |\n| --- |\n| **![caption](image.png)** |"],
    ["linked-heading-image-preserved", "# [![caption](image.png)](https://example.org)"],
    ["marked-nested-list-image-preserved", "> - *![caption](image.png)*"],
    ["highlighted-image-preserved", "<mark>![caption](image.png)</mark>"],
  ].map(([id, markdown]) => ({
    id,
    markdown,
    reason: "Image markers cannot carry enclosing links or marks. The legacy adapter drops those wrappers; Rust preserves the whole source as opaque content.",
    legacy_spans: importLegacy(markdown),
    expected_spans: [{
      type: "block",
      value: {
        type: "pages-opaque",
        parents: [],
        attrs: { source: markdown, importId: "", kind: "markdown" },
        isEmbed: false,
      },
    }],
  })),
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
