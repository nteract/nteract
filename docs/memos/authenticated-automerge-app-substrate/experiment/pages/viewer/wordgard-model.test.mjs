import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf, parse } from "wordgard/doc";
import { JSDOM } from "jsdom";
import { enableRich, textPath, validateRich, blockMarkdown } from "../model/richtext.mjs";
import {
  decode,
  encode,
  schema,
  Paragraph,
  CodeBlock,
  PagesLink,
  OpaqueBlock,
  PagesImage,
  PagesHighlight,
  PagesForeignMarks,
  Heading,
  Blockquote,
  BulletList,
  ListItem,
} from "./wordgard-model.mjs";
function fixture(markdown) {
  return A.change(A.from({ blocks: { one: { id: "one", kind: "markdown", markdown } } }), (d) =>
    enableRich(d, "one"),
  );
}
test("Wordgard reads actual Pages spans with implicit paragraphs and UTF-16 positions", () => {
  const doc = fixture("A🌊 **bold**"),
    spans = A.spans(doc, textPath("one"));
  assert.equal(spans[0].type, "text");
  const { doc: tree, map } = decode(spans);
  assert.equal(map.wgToAm[1], 0);
  assert.equal(map.wgToAm[2], 1);
  assert.equal(map.wgToAm[4], 3);
  assert.equal(map.amToWg[0], 1);
  assert.ok(decode(encode(tree)).doc.eq(tree));
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
      tree = decode(A.spans(native, textPath("one"))).doc;
    const rewritten = A.change(native, (d) => A.updateSpans(d, textPath("one"), encode(tree)));
    assert.ok(decode(A.spans(rewritten, textPath("one"))).doc.eq(tree), source);
    validateRich(rewritten.blocks.one);
    assert.equal(blockMarkdown(rewritten.blocks.one), blockMarkdown(native.blocks.one), source);
  }
});
// Older builds stored preserved blocks; this build only reads them.
const preserved = (source) =>
  A.change(A.from({ blocks: { one: { id: "one", kind: "markdown", markdown: source } } }), (d) => {
    enableRich(d, "one");
    A.updateSpans(
      d,
      textPath("one"),
      encode(schema.doc([OpaqueBlock.of({ source, importId: "", kind: "markdown" })])),
    );
  });
test("stored preserved Markdown and instruction nodes retain exact source and kind", () => {
  const source = "<div>preserved unsupported markup</div>";
  // Import never writes one: this HTML is literal text in a paragraph.
  assert.equal(
    decode(A.spans(fixture(source), textPath("one"))).doc.content[0].type,
    Paragraph.type,
  );
  const doc = preserved(source),
    tree = decode(A.spans(doc, textPath("one"))).doc;
  assert.equal(tree.content[0].type, OpaqueBlock);
  assert.equal(tree.content[0].param.source, source);
  assert.ok(decode(encode(tree)).doc.eq(tree));
  const instruction = schema.doc([
    OpaqueBlock.of({ source: "secret <script>", importId: "i", kind: "instruction" }),
  ]);
  assert.ok(decode(encode(instruction)).doc.eq(instruction));
});
test("native positions preserve paragraph ends and opaque leaf endpoints", () => {
  const native = fixture("## 🌊 Heading\n\nNext  \nline"),
    { doc, map } = decode(A.spans(native, textPath("one")));
  let pos = 0;
  for (const block of doc.content) {
    const end = pos + block.length - 1;
    assert.equal(map.amToWg[map.wgToAm[end]], end);
    pos += block.length;
  }
  const table = decode(A.spans(preserved("<div>preserved markup</div>"), textPath("one")));
  assert.deepEqual(table.map.wgToAm, [0, 1]);
  assert.deepEqual(table.map.amToWg, [0, 1]);
});
test("unsupported blocks and unsafe links fail explicitly; code blocks need no language mark", () => {
  assert.throws(
    () => decode([{ type: "block", value: { type: "mystery", parents: [], attrs: {} } }]),
    /Unsupported/,
  );
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
    assert.ok(decode(A.spans(doc, textPath("one"))).doc.eq(tree), String(tree));
    assert.doesNotThrow(() => blockMarkdown(doc.blocks.one));
  }
  // A lone empty paragraph and a non-empty first paragraph stay implicit.
  assert.deepEqual(encode(schema.doc([empty])), []);
  assert.equal(encode(schema.doc([Paragraph.create([Leaf.text("Hope")])]))[0].type, "text");
  assert.deepEqual(
    encode(schema.doc([Blockquote.create([empty])])).map((span) => String(span.value.type)),
    ["blockquote"],
  );
});

test("marks this build doesn't know decode as plain text and encode back unchanged", () => {
  const spans = [
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
    A.updateSpans(d, textPath("one"), encode(decode(A.spans(native, textPath("one"))).doc)),
  );
  assert.deepEqual(A.spans(rewritten, textPath("one")), A.spans(native, textPath("one")));
});

test("highlights decode to palette or custom colors and round trip", () => {
  for (const color of ["yellow", "green", "blue", "pink", "#1f6feb"]) {
    const spans = [{ type: "text", value: "lit", marks: { highlight: color } }];
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
