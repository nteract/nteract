// Native Markdown behavior, serialization stability and stored-content preservation.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf, Mark, Node, Plot } from "wordgard/doc";
import markdownCorpus from "./markdown-corpus.json" with { type: "json" };
import { parseAgentMarkdown, parseMarkdown } from "./markdown-import.mjs";
import { exportMarkdown } from "./markdown-serializer.mjs";
import { projectReadChanges } from "./read-changes.mjs";
import { projectReadContent } from "./read-content.mjs";
import { RICH_FORMAT, textPath } from "./richtext-format.mjs";
import { blockMarkdown } from "./richtext-page.mjs";
import { readTree } from "./richtext-spans.mjs";
import { updateSpansConfig } from "./marks.mjs";
import { nativeRead, readMarkdown } from "./native-read.mjs";
import {
  decode,
  encode,
  Aside,
  Blockquote,
  BulletList,
  HorizontalRule,
  ListItem,
  Paragraph,
  CodeBlock,
  CodeBlockLanguage,
  PagesLink,
  Strong,
  PagesHighlight,
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

test("the refusal readTree reports for unreadable spans is the only one blockMarkdown reads around", () => {
  const { doc, id } = pageWithSpans([block("heading", [], { level: 9 }), text("x")]);
  assert.throws(() => readTree(doc.blocks[id], doc.page_id), /heading level/);
  // The adapter still reads it, as it always did.
  assert.equal(blockMarkdown(doc.blocks[id], doc.page_id), "######### x");
  // Anything else readTree throws is not a refusal and propagates.
  assert.throws(() => blockMarkdown({ format: RICH_FORMAT, richText: "plain" }, PAGE_ID));
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

// The serializer is total over the editor tree: a node or mark it has no
// rule for reads as a notice (or as plain text), never as an error.
const para = (value, marks) => Paragraph.create(value ? [Leaf.text(value, marks)] : []);
const Callout = Plot.define("TestCallout", {
  group: Node.Group.Content,
  blockContent: Node.Group.Content,
  shape: { element: "section" },
});

test("an aside reads as a notice, then its paragraph and list", () => {
  const aside = Aside.create([
    para("note"),
    BulletList.create([ListItem.create([para("one")]), ListItem.create([para("two")])]),
  ]);
  assert.equal(
    exportMarkdown({ content: [para("before"), aside, para("after")] }),
    "before\n\n\\[Unsupported node: aside\\]\n\nnote\n\n- one\n- two\n\nafter",
  );
});

test("a block with no Markdown rule reads as a notice, then its content", () => {
  const Line = Plot.define("TestLine", {
    group: Node.Group.Content,
    inlineContent: true,
    shape: { element: "div" },
  });
  assert.equal(
    exportMarkdown({
      content: [Callout.create([para("inside")]), Line.create([Leaf.text("a line")])],
    }),
    "\\[Unsupported node\\]\n\ninside\n\n\\[Unsupported node\\]\n\na line",
  );
});

test("an inline leaf with no Markdown rule reads as a notice in its line", () => {
  const Chip = Leaf.define("TestChip", { inline: true, shape: { element: "span" } });
  assert.equal(
    exportMarkdown({ content: [Paragraph.create([Leaf.text("a "), Chip, Leaf.text(" b")])] }),
    "a \\[Unsupported node\\] b",
  );
});

// markName already dropped a mark type it doesn't know; this pins that.
test("a mark with no Markdown rule reads as its text (existing behaviour)", () => {
  const Underline = Mark.define("TestUnderline", { shape: { element: "u" } });
  assert.equal(
    exportMarkdown({
      content: [
        Paragraph.create([
          Leaf.text("plain "),
          Leaf.text("under", Underline.addToSet(Strong.addToSet(Mark.none))),
        ]),
      ],
    }),
    "plain **under**",
  );
});

test("a notice separates from the block after it as a paragraph does", () => {
  const headings = (markdown) => {
    let count = 0;
    parseMarkdown(markdown).iterate((node) => {
      if (node.name === "Heading") count++;
    });
    return count;
  };
  const list = (...items) =>
    BulletList.create(items.map((value) => ListItem.create([para(value)])));
  const inItem = (node) => ({ content: [BulletList.create([ListItem.create([node])])] });
  for (const [wrap, notice] of [
    [Aside, "\\[Unsupported node: aside\\]"],
    [Callout, "\\[Unsupported node\\]"],
  ]) {
    // In a tight list item, a list whose empty first item can't interrupt a
    // paragraph needs a blank line, or its `-` underlines the notice.
    const nested = exportMarkdown(inItem(wrap.create([list("", "b")])));
    assert.equal(nested, `- \n  ${notice}\n\n  - \n  - b`);
    assert.equal(headings(nested), 0, nested);
    for (const [child, expected] of [
      [HorizontalRule, 0],
      [Blockquote.create([para("q")]), 0],
      [parseMarkdown("## h").content[0], 1],
    ]) {
      const out = exportMarkdown(inItem(wrap.create([child])));
      assert.equal(headings(out), expected, out);
    }
  }
  // A stored node this build doesn't know reads the same way.
  const item = "unordered-list-item";
  const { doc, id } = pageWithSpans([
    block(item),
    block("callout", [item]),
    block(item, [item, "callout"]),
    block(item, [item, "callout"]),
    text("b"),
  ]);
  assert.equal(
    blockMarkdown(doc.blocks[id], doc.page_id),
    "- \n  \\[Unsupported node: callout\\]\n\n  - \n  - b",
  );
  A.free(doc);
});
