import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf, parse } from "wordgard/doc";
import { JSDOM } from "jsdom";
import { textPath, validateRich, blockMarkdown } from "../model/richtext.mjs";
import { richFromSource } from "../model/richtext-test-support.mjs";
import {
  decode,
  encode,
  schema,
  Paragraph,
  CodeBlock,
  PagesLink,
  PagesImage,
  PagesHighlight,
  PagesForeignMarks,
  Heading,
  Blockquote,
  BulletList,
  ListItem,
  PagesUnknownBlock,
  PagesUnknownEmbed,
} from "./wordgard-model.mjs";
import { readSpans, splitBlockStored } from "../model/richtext-format.mjs";
// The marker a writer puts before a top-level paragraph.
const opening = () => ({
  type: "block",
  value: { type: new A.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false },
});
function fixture(markdown) {
  return A.change(A.from({ blocks: { one: { markdown } } }), (d) => richFromSource(d, "one"));
}
test("Wordgard reads actual Pages spans with UTF-16 positions", () => {
  const doc = fixture("A🌊 **bold**"),
    spans = readSpans(doc, textPath("one"));
  // The first paragraph opens with its marker, so editor positions inside it
  // equal native offsets.
  assert.equal(spans[0].type, "block");
  assert.equal(String(spans[0].value.type), "paragraph");
  const { doc: tree, map } = decode(spans);
  assert.equal(map.wgToAm[1], 1);
  assert.equal(map.wgToAm[2], 2);
  assert.equal(map.wgToAm[4], 4);
  assert.equal(map.amToWg[1], 1);
  assert.ok(decode(encode(tree)).doc.eq(tree));
});

test("unmarked text a merge leaves reads as a paragraph and encodes with its marker", () => {
  const spans = [{ type: "text", value: "Left by a merge", marks: {} }];
  const decoded = decode(spans);
  assert.equal(decoded.lossy, false);
  assert.deepEqual(decoded.unmarked, [{ at: 0, markers: [{ type: "paragraph", parents: [] }] }]);
  assert.equal(decoded.doc.content[0].type, Paragraph.type);
  assert.equal(decoded.map.wgToAm[1], 0);
  const encoded = encode(decoded.doc);
  assert.equal(String(encoded[0].value.type), "paragraph");
  assert.deepEqual(encoded.slice(1), spans);
});
test("Pages headings, nested lists, quotes, hard breaks, code params and links round trip", () => {
  for (const source of [
    "# Heading\n\nText",
    "- One\n- Two\n  - Three\n\nTail",
    "1. First\n2. Second",
    "> Quoted\n>\n> Next",
    "First  \nSecond",
    "```mermaid\ngraph LR\nA-->B\n```",
    "```\nplain\n```",
    '[Pages](https://example.com "A title")',
    '![Diagram](https://example.com/image.png "Image title")',
  ]) {
    const native = fixture(source),
      tree = decode(readSpans(native, textPath("one"))).doc;
    const rewritten = A.change(native, (d) => A.updateSpans(d, textPath("one"), encode(tree)));
    assert.ok(decode(readSpans(rewritten, textPath("one"))).doc.eq(tree), source);
    validateRich(rewritten.blocks.one);
    assert.equal(blockMarkdown(rewritten.blocks.one), blockMarkdown(native.blocks.one), source);
  }
});
// Older builds stored preserved Markdown as a `pages-opaque` marker. This
// build doesn't know that node: it reads as an unknown block, kept as stored.
const preservedSpans = (source) => [
  {
    type: "block",
    value: {
      type: new A.ImmutableString("pages-opaque"),
      parents: [],
      attrs: { source: new A.ImmutableString(source) },
      isEmbed: false,
    },
  },
];
test("a stored preserved Markdown marker reads as an unknown block and keeps its marker", () => {
  const source = "<div>preserved unsupported markup</div>";
  // Import never writes one: this HTML is literal text in a paragraph.
  assert.equal(
    decode(readSpans(fixture(source), textPath("one"))).doc.content[0].type,
    Paragraph.type,
  );
  const tree = decode(preservedSpans(source)).doc;
  assert.equal(tree.content[0].type, PagesUnknownBlock);
  const [marker] = encode(tree);
  assert.equal(String(marker.value.type), "pages-opaque");
  assert.equal(String(marker.value.attrs.source), source);
});
test("native positions preserve paragraph ends and opaque leaf endpoints", () => {
  const native = fixture("## 🌊 Heading\n\nNext  \nline"),
    { doc, map } = decode(readSpans(native, textPath("one")));
  let pos = 0;
  for (const block of doc.content) {
    const end = pos + block.length - 1;
    assert.equal(map.amToWg[map.wgToAm[end]], end);
    pos += block.length;
  }
  const table = decode(preservedSpans("<div>preserved markup</div>"));
  assert.deepEqual(table.map.wgToAm, [0, 1]);
  assert.deepEqual(table.map.amToWg, [0, 1]);
});
test("invalid marks and unsafe links fail explicitly; code blocks need no language mark", () => {
  assert.throws(
    () => decode([{ type: "text", value: "x", marks: { highlight: "red" } }]),
    /Invalid/,
  );
  assert.throws(
    () =>
      decode([
        {
          type: "text",
          value: "x",
          marks: { link: JSON.stringify({ href: "javascript:alert(1)" }) },
        },
      ]),
    /Invalid/,
  );
  const code = schema.doc([CodeBlock.create([Leaf.text("x")])]);
  assert.ok(decode(encode(code)).doc.eq(code));
  const link = schema.doc([
    Paragraph.create([Leaf.text("Link", [PagesLink.of({ href: "/p/page", title: "Title" })])]),
  ]);
  assert.ok(decode(encode(link)).doc.eq(link));
});
test("an empty first paragraph keeps its own native marker when content follows it", () => {
  const empty = Paragraph.create([]);
  const image = PagesImage.of({
    src: "/api/pages/p/assets/" + "a".repeat(64),
    alt: "",
    title: null,
  });
  for (const tree of [
    schema.doc([empty, Paragraph.create([Leaf.text("Hope")])]),
    schema.doc([empty, empty, Paragraph.create([Leaf.text("Hope")])]),
    schema.doc([empty, Heading.of(2).create([Leaf.text("Title")])]),
    schema.doc([Blockquote.create([empty, Paragraph.create([Leaf.text("Quoted")])])]),
    schema.doc([
      BulletList.create([ListItem.create([empty, Paragraph.create([Leaf.text("Item")])])]),
    ]),
    schema.doc([Paragraph.create([Leaf.text("With image!")]), empty, Paragraph.create([image])]),
  ]) {
    const spans = encode(tree);
    assert.ok(decode(spans).doc.eq(tree), String(tree));
    const doc = A.change(fixture(""), (d) => A.updateSpans(d, textPath("one"), spans));
    assert.ok(decode(readSpans(doc, textPath("one"))).doc.eq(tree), String(tree));
    assert.doesNotThrow(() => blockMarkdown(doc.blocks.one));
  }
  // A lone empty paragraph and a non-empty first paragraph have their markers.
  assert.deepEqual(
    encode(schema.doc([empty])).map((span) => String(span.value.type)),
    ["paragraph"],
  );
  assert.equal(
    String(encode(schema.doc([Paragraph.create([Leaf.text("Hope")])]))[0].value.type),
    "paragraph",
  );
  assert.deepEqual(
    encode(schema.doc([Blockquote.create([empty])])).map((span) => String(span.value.type)),
    ["blockquote", "paragraph"],
  );
});

test("marks this build doesn't know decode as plain text and encode back unchanged", () => {
  const spans = [
    opening(),
    { type: "text", value: "a", marks: {} },
    { type: "text", value: "future", marks: { strong: true, underline: true, color: "red" } },
  ];
  const { doc } = decode(spans);
  const text = doc.content[0].content[1];
  assert.ok(text.marks.some((mark) => mark.type === PagesForeignMarks));
  assert.deepEqual(encode(doc), spans);
  // An edit to the same block keeps the foreign marks on untouched text.
  const native = A.change(fixture(""), (d) => A.updateSpans(d, textPath("one"), spans));
  const rewritten = A.change(native, (d) =>
    A.updateSpans(d, textPath("one"), encode(decode(readSpans(native, textPath("one"))).doc)),
  );
  assert.deepEqual(readSpans(rewritten, textPath("one")), readSpans(native, textPath("one")));
});

test("highlights decode to palette or custom colors and round trip", () => {
  for (const color of ["yellow", "green", "blue", "pink", "#1f6feb"]) {
    const spans = [opening(), { type: "text", value: "lit", marks: { highlight: color } }];
    const { doc } = decode(spans);
    assert.equal(PagesHighlight.isInSet(doc.content[0].content[0].marks).value, color);
    assert.deepEqual(encode(doc), spans);
  }
  for (const color of ["red", "#ABCDEF", "#abc", true])
    assert.throws(() => decode([{ type: "text", value: "x", marks: { highlight: color } }]));
});

test("pasted HTML links keep their destination and title; unsafe ones keep only text", () => {
  const { document } = new JSDOM("").window;
  const host = document.createElement("div");
  host.innerHTML =
    '<p>see <a href="https://example.com/x" title="T">abs</a> <a href="/p/abc">rel</a> ' +
    '<a href="javascript:alert(1)">js</a> <a>bare</a></p>';
  const texts = parse.slice(schema, host, {}).content.filter((token) => token.isText);
  const link = (text) => {
    const token = texts.find((entry) => entry.param.includes(text));
    return PagesLink.isInSet(token.marks)?.value ?? null;
  };
  assert.deepEqual(link("abs"), { href: "https://example.com/x", title: "T" });
  assert.deepEqual(link("rel"), { href: "/p/abc", title: null });
  assert.equal(link("js"), null);
  assert.equal(link("bare"), null);
  assert.ok(
    texts
      .map((token) => token.param)
      .join("")
      .includes("js bare"),
  );
});

// A node from a newer build: the Page opens, shows a notice, and an editor
// rewrite writes the stored marker back exactly. Where decode can't draw a
// node as stored, it says so (`lossy`) and the binding refuses writes.
const S = (value) => new A.ImmutableString(value);
function withUnknown(source, marker, at) {
  let doc = fixture(source);
  const path = textPath("one");
  doc = A.change(doc, (d) =>
    splitBlockStored(d, path, at(d.blocks.one.richText), {
      attrs: {},
      ...marker,
      type: S(marker.type),
      parents: marker.parents.map(S),
    }),
  );
  // Rewrite once in the editor's form, so the next rewrite measures only the
  // unknown node. A lossy block is never rewritten, by the editor or here.
  const decoded = decode(readSpans(doc, path));
  if (decoded.lossy) return doc;
  return A.change(doc, (d) => A.updateSpans(d, path, encode(decoded.doc)));
}
const rewriteWrites = (doc) => {
  const path = textPath("one"),
    heads = A.getHeads(doc);
  const after = A.change(A.clone(doc), (d) =>
    A.updateSpans(d, path, encode(decode(readSpans(d, path)).doc)),
  );
  return A.diff(after, heads, A.getHeads(after));
};
const types = (doc) => {
  const found = [];
  decode(readSpans(doc, textPath("one"))).doc.iterate((node) => {
    found.push(node.type);
  });
  return found;
};
const beforeAfter = (text) => text.indexOf("After") - 1;
const insideAfter = (text) => text.indexOf("After") + 2;

test("an unknown block or embed decodes to a notice and encodes back exactly", () => {
  const attrs = {
    title: S("Usage"),
    rows: 3,
    wide: true,
    note: "plain",
    gone: null,
    nested: { list: [1, "x"], deep: { on: false } },
  };
  const block = withUnknown(
    "Before\n\nAfter",
    { type: "future-chart", parents: [], attrs, isEmbed: false },
    beforeAfter,
  );
  const decoded = decode(readSpans(block, textPath("one")));
  assert.equal(decoded.lossy, false);
  const node = decoded.doc.content[1];
  assert.equal(node.type, PagesUnknownBlock);
  assert.equal(node.param.type, "future-chart");
  assert.deepEqual(node.param.immutable, ["title"]);
  assert.deepEqual(node.param.parents, []);
  assert.deepEqual(rewriteWrites(block), []);
  // The unknown block takes one native position, like any leaf block.
  const { wgToAm, amToWg } = decoded.map;
  const at = block.blocks.one.richText.indexOf("After") - 2;
  assert.equal(wgToAm[amToWg[at]], at);
  for (const [label, source, parents] of [
    ["in a paragraph", "Before\n\nAfter", ["paragraph"]],
    [
      "in a table cell",
      "| a | b |\n| --- | --- |\n| After | 2 |",
      ["table", "table-row", "table-cell"],
    ],
    ["in a list item", "- one\n- After", ["unordered-list-item", "paragraph"]],
  ]) {
    const embed = withUnknown(
      source,
      { type: "video", parents, attrs: { src: S("x") }, isEmbed: true },
      insideAfter,
    );
    assert.ok(types(embed).includes(PagesUnknownEmbed), label);
    assert.equal(decode(readSpans(embed, textPath("one"))).lossy, false, label);
    assert.deepEqual(rewriteWrites(embed), [], label);
  }
  const listed = withUnknown(
    "- one\n- After",
    { type: "future-chart", parents: ["unordered-list-item"], isEmbed: false },
    (text) => text.length,
  );
  assert.equal(decode(readSpans(listed, textPath("one"))).lossy, false);
  assert.deepEqual(rewriteWrites(listed), []);
});

test("decode marks a block it can't draw as stored lossy, and keeps the stored marker", () => {
  for (const [label, source, marker, at, drawn] of [
    [
      "a block stored in a table cell",
      "| a | b |\n| --- | --- |\n| After | 2 |",
      { type: "future-chart", parents: ["table", "table-row", "table-cell"], isEmbed: false },
      insideAfter,
      PagesUnknownEmbed,
    ],
    [
      "an embed in a code block",
      "```\nAfter\n```",
      { type: "video", parents: ["code-block"], isEmbed: true },
      insideAfter,
      null,
    ],
    [
      "a container that owns text",
      "Before\n\nAfter",
      { type: "callout", parents: [], isEmbed: false },
      (text) => text.indexOf("After"),
      PagesUnknownBlock,
    ],
    [
      "a paragraph in an unknown container",
      "Before\n\nAfter",
      { type: "paragraph", parents: ["callout"], isEmbed: false },
      beforeAfter,
      null,
    ],
  ]) {
    const doc = withUnknown(source, marker, at);
    const decoded = decode(readSpans(doc, textPath("one")));
    assert.equal(decoded.lossy, true, label);
    if (drawn) assert.ok(types(doc).includes(drawn), label);
    // Where it was drawn as an embed, encode still writes the stored block.
    if (drawn === PagesUnknownEmbed) {
      const spans = encode(decoded.doc);
      const stored = spans.find(
        (span) => span.type === "block" && String(span.value.type) === "future-chart",
      );
      assert.equal(stored.value.isEmbed, false, label);
      assert.deepEqual(
        stored.value.parents.map(String),
        ["table", "table-row", "table-cell"],
        label,
      );
    }
  }
});

test("an unknown node draws only a notice, so copying it copies no text", () => {
  const value = {
    type: "future-chart",
    attrs: { title: "secret" },
    immutable: [],
    parents: [],
    isEmbed: false,
  };
  const element = PagesUnknownBlock.spec.shape.structure(value);
  assert.equal(element.tagName, "section");
  assert.deepEqual(element.children, []);
  const attrs = Object.fromEntries(
    element.attrs.flatMap((_, i, all) => (i % 2 ? [] : [[all[i], all[i + 1]]])),
  );
  assert.equal(attrs["data-pages-node"], "future-chart");
  assert.ok(!JSON.stringify(element).includes("secret"));
  // A malformed value can't be written back.
  assert.throws(
    () => encode(schema.doc([PagesUnknownBlock.of({ type: 3 })])),
    /Invalid unknown Pages node/,
  );
});
