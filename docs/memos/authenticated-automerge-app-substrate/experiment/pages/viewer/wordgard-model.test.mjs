import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { enableRich, textPath, validateRich, blockMarkdown } from "../model/richtext.mjs";
import {
  decode,
  encode,
  schema,
  Paragraph,
  CodeBlock,
  PagesLink,
  OpaqueBlock,
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
test("preserved unsupported Markdown and instruction nodes retain exact source and kind", () => {
  const source = "<div>preserved unsupported markup</div>";
  const doc = fixture(source),
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
  const table = decode(A.spans(fixture("<div>preserved markup</div>"), textPath("one")));
  assert.deepEqual(table.map.wgToAm, [0, 1]);
  assert.deepEqual(table.map.amToWg, [0, 1]);
});
test("unsupported schema and unsafe links fail explicitly; code blocks need no language mark", () => {
  assert.throws(
    () => decode([{ type: "block", value: { type: "mystery", parents: [], attrs: {} } }]),
    /Unsupported/,
  );
  assert.throws(
    () => decode([{ type: "text", value: "x", marks: { unknown: true } }]),
    /Unsupported/,
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
