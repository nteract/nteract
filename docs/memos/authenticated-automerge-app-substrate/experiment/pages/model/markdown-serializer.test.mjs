// The Markdown projection against frozen expectations.
// model/markdown-serializer.golden.json holds, for every input below, the
// Markdown the ProseMirror serializer (prosemirror-markdown plus the Pages
// rules) wrote before the serializer moved to the Wordgard tree: a block's
// projection, read_page's block, outline byte counts and one-node slices, a
// comment message holding the same spans, and the parser's tree exported
// directly. The serializer must keep producing these bytes: agents write back
// what they read, so any change turns a read->write into a rewrite.
//
// Inputs: the stored shapes, the Markdown corpus as rich text and the seeded
// random editor trees of test/address-inputs.mjs; the corpus in the
// ProseMirror adapter's span form; deeper random trees; and the shapes below.
//
// Regenerate only when an input or an intended projection changes:
// PAGES_UPDATE_MARKDOWN=1 npm exec -- tsx --tsconfig tsconfig.json --test model/markdown-serializer.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import * as A from "@automerge/automerge";
import markdownCorpus from "./markdown-corpus.json" with { type: "json" };
import { commentBodyProjection } from "./comment-content.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { parseAgentMarkdown, parseMarkdown } from "./markdown-import.mjs";
import { projectReadContent } from "./read-content.mjs";
import { RICH_FORMAT, textPath } from "./richtext-format.mjs";
import { exportMarkdown } from "./richtext.mjs";
import { blockMarkdown } from "./richtext-page.mjs";
import { adapterSpans } from "./richtext-spans.mjs";
import {
  PAGE_ID,
  pageWithSpans,
  randomInputs,
  shapeInputs,
  corpusInputs,
  spansToJSON,
} from "../test/address-inputs.mjs";

const GOLDEN = new URL("./markdown-serializer.golden.json", import.meta.url);
const update = process.env.PAGES_UPDATE_MARKDOWN === "1";

const S = (value) => new A.ImmutableString(value);
const block = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: {
    type: S(type),
    parents: parents.map(S),
    attrs: Object.fromEntries(
      Object.entries(attrs).map(([key, value]) => [
        key,
        typeof value === "string" ? S(value) : value,
      ]),
    ),
    isEmbed,
  },
});
const text = (value, marks = {}) => ({ type: "text", value, marks });
const link = (href, title = null) => JSON.stringify({ href, title });
const dataframe = (pageId, extra = {}) => ({
  src: `/api/pages/${pageId}/assets/${"b".repeat(64)}`,
  media_type: "application/vnd.apache.parquet",
  ...extra,
});
const OTHER_PAGE = "66666666-6666-4666-8666-666666666666";
const cell = ["table", "table-row", "table-cell"];
const header = ["table", "table-row", "table-header"];

/** Stored shapes beyond test/address-inputs.mjs: content from peers, older
 * builds and newer builds, and edge cases of the Pages rules. */
const SHAPES = {
  "unknown-block": [text("a"), block("future-thing", [], { x: "1" }), text("b")],
  "unknown-block-last": [text("a"), block("future-thing")],
  "unknown-embed": [text("a"), block("future-embed", ["paragraph"], {}, true), text("b")],
  "unknown-embed-in-code": [
    block("code-block", [], { params: "" }),
    text("x"),
    block("future-embed", ["code-block"], {}, true),
    text("y"),
  ],
  "unknown-parent": [
    text("a"),
    block("paragraph", ["future-box"]),
    text("in box"),
    block("paragraph"),
    text("after"),
  ],
  "unknown-parent-list": [block("unordered-list-item", ["future-box"]), text("li")],
  "unknown-block-in-cell": [
    block("table"),
    block("table-row", ["table"]),
    block("table-header", ["table", "table-row"]),
    text("h"),
    block("future-thing", header),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("c"),
  ],
  "unknown-mark": [text("a "), text("b", { future: true }), text(" c")],
  "unknown-mark-splits-run": [text("a_"), text("b", { future: true })],
  "unknown-mark-in-code-span": [text("a_b", { code: true, future: 1 })],
  "unknown-mark-in-strong": [
    text("a", { strong: true }),
    text("b", { strong: true, future: "x" }),
    text("c", { strong: true }),
  ],
  opaque: [text("a"), block("pages-opaque", [], { source: "**x**" }), text("b")],
  "foreign-dataframe": [text("a"), block("dataframe", [], dataframe(OTHER_PAGE)), text("b")],
  "dataframe-title": [
    text("a"),
    block("dataframe", [], dataframe(PAGE_ID, { title: "  Usage\n by  day " })),
    block("paragraph"),
    text("b"),
  ],
  "dataframe-extra-attrs": [block("dataframe", [], dataframe(PAGE_ID, { future: "1" }))],
  "dataframe-unreadable": [block("dataframe", [], { src: "nope", media_type: "x" })],
  "dataframe-in-cell": [
    block("table"),
    block("table-row", ["table"]),
    block("table-header", ["table", "table-row"]),
    text("h"),
    block("dataframe", header, dataframe(PAGE_ID)),
  ],
  "dataframe-before-nested-list": [
    block("task-list-item", [], { checked: false }),
    block("dataframe", ["task-list-item"], dataframe(PAGE_ID)),
    block("unordered-list-item", ["task-list-item"]),
    block("heading", ["task-list-item", "unordered-list-item"], { level: 1 }),
    text("a"),
  ],
  "dataframe-then-paragraph-in-item": [
    block("unordered-list-item"),
    block("dataframe", ["unordered-list-item"], dataframe(PAGE_ID)),
    block("paragraph", ["unordered-list-item"]),
    text("after"),
    block("ordered-list-item", ["unordered-list-item"]),
    text("n"),
  ],
  // The adapter's form keeps a newline in prose as text; it projects as a
  // line inside the paragraph, not as a hard break.
  "newline-in-prose": [block("paragraph"), text("a\nb")],
  "newline-in-prose-block-syntax": [block("paragraph"), text("a\n# b\n> c\n=d")],
  "image-extra-attrs": [
    text("a"),
    block(
      "image",
      ["paragraph"],
      { src: "https://x.org/i.png", alt: "x", title: null, future: "z" },
      true,
    ),
  ],
  "image-between-links": [
    text("a", { link: link("https://x.org") }),
    block(
      "image",
      ["paragraph"],
      { src: "https://x.org/i(1).png", alt: "x [y]", title: 't"' },
      true,
    ),
    text("b", { link: link("https://x.org") }),
  ],
  "trailing-hard-breaks": [
    text("a"),
    block("hard-break", ["paragraph"], {}, true),
    block("hard-break", ["paragraph"], {}, true),
  ],
  "hard-break-before-block-syntax": [
    text("a"),
    block("hard-break", ["paragraph"], {}, true),
    text("=b"),
    block("hard-break", ["paragraph"], {}, true),
    text("# c"),
    block("hard-break", ["paragraph"], {}, true),
    text("> d", { strong: true }),
  ],
  "marks-on-code-text": [block("code-block", [], { params: "" }), text("x", { strong: true })],
  "code-fences": [
    block("code-block", [], { params: "js`x" }),
    text("~~~~ a ```"),
    block("code-block", [], { params: "" }),
    text("````\n```"),
  ],
  "quote-without-marker": [
    block("heading", ["blockquote"], { level: 2 }),
    text("h"),
    block("paragraph", ["blockquote"]),
    text("p"),
  ],
  "ragged-table": [
    block("table"),
    block("table-row", ["table"]),
    block("table-header", ["table", "table-row"], { align: "center" }),
    text("a|b"),
    block("table-header", ["table", "table-row"], { align: "left" }),
    text("b", { code: true }),
    block("table-header", ["table", "table-row"], { align: "right" }),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("<mark> & &amp; - x"),
    block("hard-break", cell, {}, true),
    text("z"),
    block("image", cell, { src: "https://x.org/i.png", alt: "i" }, true),
  ],
  "empty-first-paragraph": [block("paragraph"), block("heading", [], { level: 1 }), text("h")],
  "nested-only-item": [
    block("unordered-list-item"),
    block("unordered-list-item", ["unordered-list-item"]),
    text("inner"),
  ],
  "link-titles": [
    text("x", { link: link("https://e.org", "") }),
    text("y", { link: link("https://e.org") }),
    text(" "),
    text("t", { link: link("https://e.org/(a)", 'say "hi"') }),
  ],
  autolink: [
    text("https://e.org", { link: link("https://e.org") }),
    text(" !"),
    text("x", { link: link("/rel") }),
  ],
  "mark-whitespace": [
    text(" a ", { strong: true, em: true }),
    text("b ", { em: true }),
    text(" c", { strike: true, highlight: "#a1b2c3" }),
    text("d", { highlight: "yellow", strong: true }),
  ],
  "code-spans": [
    text("a`b", { code: true }),
    text(" "),
    text("``", { code: true, link: link("https://e.org") }),
  ],
  "literal-syntax": [text("$x$ <b> &copy; <mark> 1. # * _a_b_ ~~")],
  "task-without-checked": [block("task-list-item"), text("x")],
  "heading-level-out-of-range": [block("heading", [], { level: 9 }), text("x")],
  aside: [block("aside"), block("paragraph", ["aside"]), text("x")],
};

function localShapeInputs() {
  return Object.entries(SHAPES).map(([name, spans]) => {
    const { doc, id } = pageWithSpans(spans);
    return { name: `serializer-shape/${name}`, spans: A.spans(doc, textPath(id)) };
  });
}
/** The corpus in the ProseMirror adapter's span form. */
function adapterInputs() {
  const inputs = [];
  for (const { id, markdown } of markdownCorpus.cases) {
    let tree;
    try {
      tree = parseAgentMarkdown(markdown);
    } catch {
      tree = parseMarkdown(markdown);
    }
    inputs.push({ name: `adapter/${id}`, spans: adapterSpans(tree) });
  }
  return inputs;
}
const storedInputs = () => [
  ...shapeInputs(),
  ...localShapeInputs(),
  ...corpusInputs(),
  ...adapterInputs(),
  ...randomInputs({ count: 200 }),
  ...randomInputs({ seed: 0x5eee, count: 40, maxDepth: 3 }),
];
// Automerge doesn't fix the key order of a block marker it reads back.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const digest = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
const hash = (value) => digest(JSON.stringify(canonical(spansToJSON(value))));
const attempt = (f) => {
  try {
    return f();
  } catch (error) {
    return { error: error.message };
  }
};

/** Every projection of one stored input. read_page's block and a comment's
 * body are `true` when they equal the block's projection. Random trees keep
 * a digest of each projection, not its text, to keep the file small. */
function observe(spans, digested) {
  const { doc, id } = pageWithSpans(spans);
  const read = attempt(() => projectReadContent(doc, {}));
  const nodes = read.error
    ? []
    : read.outline.map((_entry, index) =>
        attempt(
          () =>
            projectReadContent(doc, {
              node_range: { block_id: id, from: index, to: index + 1 },
              expected_heads: A.getHeads(doc),
            }).blocks[0].markdown,
        ),
      );
  let message = A.from({ format: RICH_FORMAT, richText: "" });
  message = A.change(message, (draft) =>
    A.updateSpans(draft, ["richText"], spans, updateSpansConfig),
  );
  const markdown = attempt(() => blockMarkdown(doc.blocks[id], doc.page_id));
  const readMarkdown = read.error ? read : read.blocks[0].markdown;
  const comment = attempt(() => commentBodyProjection(message));
  const keep = (value) => (digested && typeof value === "string" ? digest(value) : value);
  return {
    block: keep(markdown),
    read: readMarkdown === markdown || keep(readMarkdown),
    bytes: read.error ? null : read.outline.map((entry) => entry.markdown_bytes),
    nodes: nodes.map(keep),
    comment:
      (comment.body === markdown && comment.body_format === "markdown") ||
      (comment.body === undefined ? comment : { ...comment, body: keep(comment.body) }),
  };
}
/** The parser's tree for each corpus case, exported directly. */
function parsedObservations() {
  return markdownCorpus.cases.map(({ id, markdown }) => ({
    name: `parsed/${id}`,
    hash: hash(markdown),
    literal: attempt(() => exportMarkdown(parseMarkdown(markdown))),
    agent: attempt(() => exportMarkdown(parseAgentMarkdown(markdown))),
  }));
}
const observeAll = () => [
  ...storedInputs().map(({ name, spans }) => ({
    name,
    hash: hash(spans),
    ...observe(spans, name.startsWith("random/")),
  })),
  ...parsedObservations(),
];

// One input per line, so a change shows up as a readable diff.
const serialize = (entries) =>
  `[\n${entries.map((entry) => JSON.stringify(entry)).join(",\n")}\n]\n`;

if (update) writeFileSync(GOLDEN, serialize(observeAll()));

test("every projection matches the frozen Markdown", () => {
  const golden = JSON.parse(readFileSync(GOLDEN, "utf8"));
  const observed = observeAll();
  assert.deepEqual(
    observed.map(({ name, hash }) => ({ name, hash })),
    golden.map(({ name, hash }) => ({ name, hash })),
    "An input changed: regenerate model/markdown-serializer.golden.json (see the header).",
  );
  const mismatches = observed.filter(
    (entry, i) => JSON.stringify(entry) !== JSON.stringify(golden[i]),
  );
  for (const entry of mismatches.slice(0, 5)) {
    const expected = golden.find(({ name }) => name === entry.name);
    assert.deepEqual(entry, expected, entry.name);
  }
  assert.equal(mismatches.length, 0);
});
