// Native Markdown behavior, serialization stability and stored-content preservation.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import markdownCorpus from "./markdown-corpus.json" with { type: "json" };
import { parseAgentMarkdown, parseMarkdown } from "./markdown-import.mjs";
import fc from "fast-check";
import { Leaf, Mark, Node, Plot } from "wordgard/doc";
import { exportMarkdown, noticeNode } from "./markdown-serializer.mjs";
import { pageTreeArbitrary, toWordgardTree } from "../test/random-page-tree.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { projectReadContent } from "./read-content.mjs";
import { textPath } from "./richtext-format.mjs";
import { blockMarkdown } from "./richtext-page.mjs";
import { readTree, validateRich } from "./richtext-spans.mjs";
import { PagesUnknownBlock } from "./wordgard-doc.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { nativeRead, readMarkdown } from "./native-read.mjs";
import {
  decode,
  encode,
  CodeBlock,
  CodeBlockLanguage,
  PagesLink,
  Strong,
  PagesHighlight,
  Aside,
  Blockquote,
  Paragraph,
} from "./wordgard-doc.mjs";
import { PAGE_ID, pageWithSpans, randomInputs, shapeInputs } from "../test/address-inputs.mjs";
const S = (value) => new A.ImmutableString(value);
const block = (type, parents = [], attrs = {}, isEmbed = false) => ({
  type: "block",
  value: { type: S(type), parents: parents.map(S), attrs, isEmbed },
});
const text = (value, marks = {}) => ({ type: "text", value, marks });

test("code fences preserve backticks, language and newlines as native code", () => {
  const content = "```literal\n~~~still literal\n# not a heading\n";
  const tree = parseAgentMarkdown(`\`\`\`\`python\n${content}\`\`\`\``);
  const restored = decode(encode(parseAgentMarkdown(exportMarkdown(tree)))).doc.firstChild;
  assert.equal(restored.type, CodeBlock.type);
  assert.equal(restored.mark(CodeBlockLanguage), "python");
  assert.equal(restored.textContent({ leafText: "\n" }), content.slice(0, -1));
});

test("overlapping marks and link titles survive native serialization as separate runs", () => {
  const tree = parseAgentMarkdown('<mark>**one</mark> two** [three](/x "link title")');
  const after = decode(encode(parseAgentMarkdown(exportMarkdown(tree)))).doc;
  const runs = after.firstChild.content.filter((node) => node.isText);
  assert.equal(after.firstChild.textContent(), "one two three");
  assert.ok(
    runs.find((node) => node.param === "one").marks.some((mark) => mark.type === Strong.type),
  );
  assert.equal(runs.find((node) => node.param === "one").mark(PagesHighlight), "yellow");
  assert.ok(
    runs.find((node) => node.param === " two").marks.some((mark) => mark.type === Strong.type),
  );
  assert.deepEqual(runs.find((node) => node.param === "three").mark(PagesLink), {
    href: "/x",
    title: "link title",
  });
});

test("ragged native tables retain every cell's text through Markdown export", () => {
  const { doc, id } = pageWithSpans([
    block("table"),
    block("table-row", ["table"]),
    block("table-header", ["table", "table-row"]),
    text("a"),
    block("table-row", ["table"]),
    block("table-cell", ["table", "table-row"]),
    text("b"),
    block("table-cell", ["table", "table-row"]),
    text("c"),
  ]);
  const output = blockMarkdown(doc.blocks[id], PAGE_ID);
  const roundtrip = parseAgentMarkdown(output).firstChild;
  assert.deepEqual(
    roundtrip.content.map((row) => row.content.map((cell) => cell.textContent())),
    [
      ["a", ""],
      ["b", "c"],
    ],
  );
  A.free(doc);
});

test("foreign dataframe read isolation preserves its stored marker and future attributes", () => {
  const foreign = "/api/pages/99999999-9999-4999-8999-999999999999/assets/" + "c".repeat(64);
  const { doc, id } = pageWithSpans([
    block("dataframe", [], {
      src: S(foreign),
      media_type: S("application/vnd.apache.parquet"),
      title: S("Foreign"),
      future: S("kept"),
    }),
  ]);
  const before = A.save(doc),
    heads = A.getHeads(doc);
  const output = readMarkdown(nativeRead(doc.blocks[id], PAGE_ID).nodes);
  assert.match(output, /Unsupported node: dataframe/);
  assert.ok(!output.includes(foreign));
  assert.deepEqual(A.save(doc), before);
  assert.deepEqual(A.getHeads(doc), heads);
  assert.equal(String(A.spans(doc, textPath(id))[0].value.attrs.future), "kept");
  A.free(doc);
});

test("Markdown corpus exports reimport without changing its visible rich content", () => {
  for (const { id, markdown } of markdownCorpus.cases) {
    const parsed = parseMarkdown(markdown);
    const output = exportMarkdown(parsed);
    assert.equal(exportMarkdown(parseAgentMarkdown(output)), output, id);
  }
});

test("stored shapes and generated native trees have consistent whole and partial reads", () => {
  for (const { name, spans } of [...shapeInputs(), ...randomInputs({ count: 200 })]) {
    const { doc, id } = pageWithSpans(spans);
    try {
      const bytes = A.save(doc),
        heads = A.getHeads(doc),
        object = A.getObjectId(doc.blocks[id], "richText");
      let markdown;
      try {
        markdown = blockMarkdown(doc.blocks[id], doc.page_id);
      } catch {
        assert.throws(() => projectReadContent(doc, {}));
        continue;
      }
      const read = projectReadContent(doc, {});
      assert.equal(read.blocks[0].markdown, markdown, name);
      for (const entry of read.outline) {
        const one = projectReadContent(doc, {
          node_range: { block_id: id, from: entry.node_index, to: entry.node_index + 1 },
        });
        assert.equal(entry.markdown_bytes, Buffer.byteLength(one.blocks[0].markdown), name);
      }
      assert.deepEqual(A.save(doc), bytes, name);
      assert.deepEqual(A.getHeads(doc), heads, name);
      assert.equal(A.getObjectId(doc.blocks[id], "richText"), object, name);
    } finally {
      A.free(doc);
    }
  }
});

test("a hard break stored in a code block reads as a line of the code", () => {
  // The ProseMirror read can't place it and refused the block.
  const { doc, id } = pageWithSpans([
    block("code-block", [], { params: "js" }),
    text("a"),
    block("hard-break", ["code-block"], {}, true),
    text("b"),
  ]);
  assert.equal(blockMarkdown(doc.blocks[id], doc.page_id), "```js\na\nb\n```");
});

test("a heading level this build doesn't write reads as a notice in every reader", () => {
  const { doc, id } = pageWithSpans([block("heading", [], { level: 9 }), text("x")]);
  // Registration refuses it; a peer's stored marker still reads.
  assert.throws(() => validateRich(doc.blocks[id]), /heading level/);
  assert.equal(readTree(doc.blocks[id], doc.page_id).content[0].type, PagesUnknownBlock);
  assert.equal(blockMarkdown(doc.blocks[id], doc.page_id), "\\[Unsupported node: heading\\]\n\nx");
});

test("read_page and read_page_changes read a hard break stored in a code block", () => {
  const spans = [
    block("code-block", [], { params: "js" }),
    text("a"),
    block("hard-break", ["code-block"], {}, true),
    text("b"),
  ];
  const { doc, id } = pageWithSpans(spans);
  const read = projectReadContent(doc, {});
  assert.equal(read.blocks[0].markdown, "```js\na\nb\n```");
  assert.deepEqual(
    read.outline.map((entry) => entry.type),
    ["code-block"],
  );
  const slice = projectReadContent(doc, {
    node_range: { block_id: id, from: 0, to: 1 },
    expected_heads: A.getHeads(doc),
  });
  assert.equal(slice.blocks[0].markdown, "```js\na\nb\n```");
  const before = A.getHeads(doc);
  const after = A.change(A.clone(doc), (draft) =>
    A.updateSpans(draft, textPath(id), [...spans, text("c")], updateSpansConfig),
  );
  const changes = projectReadChanges(after, { since_heads: before });
  assert.deepEqual(
    changes.changes.map(({ scope, markdown }) => ({ scope, markdown })),
    [{ scope: "node", markdown: "```js\na\nbc\n```" }],
  );
});

// Node and mark types the serializer has no renderer or projection for, as a
// newer editor build could hand it.
const Box = Plot.define("TestBox", {
  group: Node.Group.Content,
  blockContent: Node.Group.Content,
  shape: { element: "div" },
});
const Line = Plot.define("TestLine", {
  group: Node.Group.Content,
  inlineContent: true,
  shape: { element: "p" },
});
const Chip = Leaf.Type.define("TestChip", { inline: true, shape: { element: "span" } });
const Glow = Mark.Type.define("TestGlow", { shape: { element: "b" } });
const para = (...content) => Paragraph.create(content);
const NOTICE = "\\[Unsupported node\\]";

test("a block node with no renderer reads as the notice, then its content", () => {
  const content = [Box.create([para(Leaf.text("inside"))]), para(Leaf.text("after"))];
  assert.equal(exportMarkdown({ content }), `${NOTICE}\n\ninside\n\nafter`);
  assert.equal(noticeNode({ content }), "TestBox");
  const line = [Line.create([Leaf.text("words")])];
  assert.equal(exportMarkdown({ content: line }), `${NOTICE}\n\nwords`);
  const quoted = [Blockquote.create([Box.create([para(Leaf.text("q"))])])];
  assert.equal(exportMarkdown({ content: quoted }), `> ${NOTICE}\n>\n> q`);
});

test("an inline leaf with no renderer reads as the notice inline", () => {
  const content = [para(Leaf.text("a"), Chip.of(null), Leaf.text("b"))];
  assert.equal(exportMarkdown({ content }), `a${NOTICE}b`);
  assert.equal(noticeNode({ content }), "TestChip");
});

test("a mark with no Markdown projection reads as its text, unmarked", () => {
  const text = Leaf.text("glow", Glow.of(true).addToSet(Mark.none));
  assert.equal(text.marks.length, 1);
  const content = [para(Leaf.text("a "), text, Leaf.text(" b"))];
  assert.equal(exportMarkdown({ content }), "a glow b");
  assert.equal(noticeNode({ content }), undefined);
});

test("noticeNode names an aside, and nothing in a tree with no notice", () => {
  assert.equal(noticeNode({ content: [Aside.create([para(Leaf.text("x"))])] }), "aside");
  assert.equal(noticeNode({ content: [para(Leaf.text("x"))] }), undefined);
});

test("generated trees with a node, leaf or mark the serializer can't draw still serialize", () => {
  const cases = fc.sample(
    fc.tuple(
      pageTreeArbitrary({ maxDepth: 2 }),
      fc.constantFrom("box", "line", "chip", "glow"),
      fc.nat(),
    ),
    { seed: 0x5eed, numRuns: 200 },
  );
  for (const [description, kind, at] of cases) {
    const content = [...toWordgardTree(description).content];
    const index = content.length ? at % content.length : 0;
    if (kind === "box" && content.length) content[index] = Box.create([content[index]]);
    else if (kind === "glow")
      content.splice(index, 0, para(Leaf.text("glow", Glow.of(true).addToSet(Mark.none))));
    else
      content.splice(
        index,
        0,
        kind === "chip" ? para(Leaf.text("a"), Chip.of(null)) : Line.create([Leaf.text("words")]),
      );
    const markdown = exportMarkdown({ content });
    if (kind === "glow") {
      assert.match(markdown, /glow/);
      continue;
    }
    assert.ok(markdown.includes(NOTICE), markdown);
    assert.notEqual(noticeNode({ content }), undefined);
  }
});
