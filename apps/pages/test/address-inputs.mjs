// Stored rich-text shapes for node addressing tests (model/node-addresses.test.mjs):
// the Markdown corpus written as rich text, random editor trees through the
// editor encoder, and hand-written stored shapes, including ones only a peer
// or an older build writes. Each input is `{ name, spans }`, spans as stored.
import * as A from "@automerge/automerge";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { applyPageOperation, createPageData, orderedBlockIds } from "../model/page.mjs";
import { textPath } from "../model/richtext-format.mjs";
import { setRichMarkdown } from "../model/richtext-page.mjs";
import { updateSpansConfig } from "../model/marks.mjs";
import { stampFeatures, stampSpans } from "../model/schema-features.mjs";
import { encode } from "../model/wordgard-doc.mjs";
import { PAGE_ID, pageTreeArbitrary, toWordgardTree } from "./random-page-tree.mjs";

export { PAGE_ID };
// One actor for every input, so cursors (node ids) are reproducible.
const ACTOR = "0123456789abcdef0123456789abcdef";
const S = (value) => new A.ImmutableString(value);

function emptyPage() {
  let doc = A.from(createPageData({ pageId: PAGE_ID, title: "Addresses" }), { actor: ACTOR });
  return { doc, id: orderedBlockIds(doc)[0] };
}

/** A Page whose one block holds `spans`, stored as a native peer would. */
export function pageWithSpans(spans) {
  let { doc, id } = emptyPage();
  doc = A.change(doc, (draft) => {
    draft.blocks[id].richText = "";
    A.updateSpans(draft, textPath(id), spans, updateSpansConfig);
    stampSpans(draft, spans);
    stampFeatures(draft, ["comments-doc"]);
  });
  return { doc, id };
}

function markdownSpans(markdown, literal) {
  let { doc, id } = emptyPage();
  doc = A.change(doc, (draft) => {
    draft.blocks[id].richText = "";
    setRichMarkdown(draft, id, markdown, { literal });
  });
  return A.spans(doc, textPath(id));
}

const corpus = JSON.parse(
  readFileSync(new URL("../model/markdown-corpus.json", import.meta.url)),
).cases;

/** Every corpus case written as rich text, literal (math and HTML kept as
 * text) and, where the agent import accepts it, as an agent would. */
export function corpusInputs() {
  const inputs = [];
  for (const { id, markdown } of corpus) {
    inputs.push({ name: `corpus/${id}`, spans: markdownSpans(markdown, true) });
    try {
      inputs.push({ name: `corpus-agent/${id}`, spans: markdownSpans(markdown, false) });
    } catch {
      // The agent import refuses math and raw HTML.
    }
  }
  return inputs;
}

/** `count` random editor trees from `seed`, written by the editor encoder. */
export function randomInputs({ seed = 0x5eed, count = 100, maxDepth = 2 } = {}) {
  const trees = fc.sample(pageTreeArbitrary({ maxDepth }), { seed, numRuns: count });
  const hostile = fc.sample(pageTreeArbitrary({ maxDepth, hostile: true }), {
    seed: seed + 1,
    numRuns: Math.ceil(count / 4),
  });
  return [...trees, ...hostile].map((description, index) => ({
    name: `random/${seed}/${index}`,
    spans: encode(toWordgardTree(description)),
  }));
}

const block = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed },
});
const text = (value, marks = {}) => ({ type: "text", value, marks });
const ASSET = `/api/pages/${PAGE_ID}/assets/${"a".repeat(64)}`;
const FOREIGN = `/api/pages/66666666-6666-4666-8666-666666666666/assets/${"b".repeat(64)}`;
const dataframe = (src, parents = []) =>
  block("dataframe", parents, { src: S(src), media_type: S("application/vnd.apache.parquet") });
const image = (parents = ["paragraph"]) =>
  block("image", parents, { src: S("https://example.org/i.png"), alt: S("alt") }, true);

/** Stored shapes the encoders never write but a peer, an older build or a
 * newer build can. */
export const SHAPES = {
  empty: [],
  "editor-form": [
    text("Intro"),
    block("heading", [], { level: 2 }),
    text("H"),
    block("paragraph"),
    text("tail"),
  ],
  "adapter-form-first-marker": [
    block("paragraph"),
    text("one"),
    block("heading", [], { level: 1 }),
  ],
  "empty-explicit-first-paragraph": [
    block("paragraph"),
    block("heading", [], { level: 1 }),
    text("H"),
  ],
  "image-first": [image([]), text(" after"), block("paragraph"), text("next")],
  "hard-break-first": [block("hard-break", [], {}, true), text("x"), block("paragraph"), text("y")],
  "newline-in-text": [text("a\nb"), image([]), block("paragraph"), text("c\nd")],
  "quote-own-marker": [
    text("p"),
    block("blockquote"),
    block("paragraph", ["blockquote"]),
    text("q"),
    block("paragraph"),
    text("r"),
  ],
  "quote-no-marker": [
    text("p"),
    block("paragraph", ["blockquote"]),
    text("q"),
    block("paragraph"),
    text("r"),
  ],
  "quote-no-marker-list": [
    text("p"),
    block("unordered-list-item", ["blockquote"]),
    text("item"),
    block("paragraph"),
    text("r"),
  ],
  "list-item-opens-with-heading": [
    block("unordered-list-item"),
    block("heading", ["unordered-list-item"], { level: 2 }),
    text("Head"),
    block("unordered-list-item"),
    text("two"),
    block("paragraph"),
    text("after"),
  ],
  "nested-lists": [
    block("ordered-list-item"),
    text("one"),
    block("unordered-list-item", ["ordered-list-item"]),
    text("inner"),
    block("task-list-item", ["ordered-list-item", "unordered-list-item"], { checked: true }),
    text("task"),
    block("ordered-list-item"),
    text("two"),
  ],
  "adjacent-list-kinds": [
    block("unordered-list-item"),
    text("a"),
    block("ordered-list-item"),
    text("b"),
    block("task-list-item", [], { checked: false }),
    text("c"),
  ],
  "ragged-table": [
    block("table"),
    block("table-row", ["table"]),
    block("table-header", ["table", "table-row"], { align: S("right") }),
    text("h1"),
    block("table-header", ["table", "table-row"]),
    text("h2"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("c1"),
    block("paragraph"),
    text("after"),
  ],
  "rule-first": [block("horizontal-rule"), block("paragraph"), text("x"), block("horizontal-rule")],
  "code-with-newlines": [
    text("p"),
    block("code-block", [], { params: S("js") }),
    text("let a\nlet b", { strong: true }),
    block("paragraph"),
    text("q"),
  ],
  dataframe: [text("before"), dataframe(ASSET), block("paragraph"), text("after")],
  "dataframe-last": [text("before"), dataframe(ASSET)],
  "foreign-dataframe": [text("before"), dataframe(FOREIGN), block("paragraph"), text("after")],
  "dataframe-in-cell": [
    block("table"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("c"),
    dataframe(ASSET, ["table", "table-row", "table-cell"]),
    block("paragraph"),
    text("after"),
  ],
  "unknown-block": [
    text("a"),
    block("future-chart", [], { spec: S("x") }),
    block("paragraph"),
    text("b"),
  ],
  "unknown-block-then-text": [
    text("a"),
    block("future-callout", [], { tone: S("info") }),
    text("callout text"),
    block("heading", [], { level: 2 }),
    text("H"),
    block("paragraph"),
    text("c"),
  ],
  "unknown-block-then-image": [
    text("a"),
    block("future-callout"),
    image([]),
    text("x"),
    block("paragraph"),
    text("c"),
  ],
  "unknown-block-last-with-text": [text("a"), block("future-callout"), text("tail")],
  "pages-opaque-then-text": [
    text("a"),
    block("pages-opaque", [], { source: S("<div>x</div>"), importId: S("i"), kind: S("markdown") }),
    text("b"),
    block("paragraph"),
    text("c"),
  ],
  "unknown-embed": [text("a"), block("future-mention", ["paragraph"], {}, true), text("b")],
  "unknown-embed-in-code": [
    block("code-block"),
    text("x"),
    block("future-mention", ["code-block"], {}, true),
    text("y"),
    block("paragraph"),
    text("z"),
  ],
  "unknown-in-cell": [
    block("table"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("c"),
    block("future-chart", ["table", "table-row", "table-cell"]),
    block("paragraph"),
    text("after"),
  ],
  "unknown-parent": [
    text("a"),
    block("paragraph", ["future-aside"]),
    text("inside"),
    block("paragraph"),
    text("b"),
  ],
  "unknown-mark": [
    text("a"),
    text("marked", { "future-mark": "v" }),
    block("paragraph"),
    text("b"),
  ],
  aside: [
    text("a"),
    block("aside"),
    block("paragraph", ["aside"]),
    text("in"),
    block("paragraph"),
    text("b"),
  ],
  "image-unknown-attrs": [
    text("a"),
    block("image", [], { src: S("https://example.org/i.png"), alt: S(""), width: 3 }, true),
    block("paragraph"),
    text("b"),
  ],
  "rule-in-list": [
    block("unordered-list-item"),
    block("horizontal-rule", ["unordered-list-item"]),
    block("unordered-list-item"),
    text("a"),
    block("paragraph"),
    text("b"),
  ],
  "dataframe-in-quote": [
    block("blockquote"),
    dataframe(ASSET, ["blockquote"]),
    block("paragraph", ["blockquote"]),
    text("q"),
    block("paragraph"),
    text("b"),
  ],
  "image-last": [text("a"), image([])],
  "image-in-cell": [
    block("table"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("c"),
    image(["table", "table-row", "table-cell"]),
    block("paragraph"),
    text("after"),
  ],
  "image-in-code": [
    block("code-block"),
    text("x"),
    image(["code-block"]),
    text("y"),
    block("paragraph"),
    text("z"),
  ],
  "unknown-embed-in-cell": [
    block("table"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("c"),
    block("future-mention", ["table", "table-row", "table-cell"], {}, true),
    block("paragraph"),
    text("after"),
  ],
  "paragraph-attrs": [text("a"), block("paragraph", [], { future: S("x") }), text("b")],
  "astral-text": [text("😀 a 👩‍💻"), block("paragraph"), text("東京 e\u0301")],
};

export function shapeInputs() {
  return Object.entries(SHAPES).map(([name, spans]) => {
    const { doc, id } = pageWithSpans(spans);
    return { name: `shape/${name}`, spans: A.spans(doc, textPath(id)) };
  });
}

export function allInputs(random) {
  return [...shapeInputs(), ...corpusInputs(), ...randomInputs(random)];
}

/** JSON for stored spans: immutable strings tagged so they round-trip, keys
 * sorted so the text does not depend on the order Automerge materializes a
 * map's keys, which follows operation ids. */
export function spansToJSON(value) {
  if (A.isImmutableString(value)) return { $immutable: String(value) };
  if (Array.isArray(value)) return value.map(spansToJSON);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => [k, spansToJSON(v)]),
    );
  return value;
}

/** Apply one page operation to a clone of `doc`. */
export function applied(doc, operation, operations) {
  return A.change(A.clone(doc), (draft) => {
    applyPageOperation(draft, { operation, arguments: { operations } });
  });
}
