// Nodes this build doesn't know, written by a newer build: reads show them,
// and no write can drop them by accident.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import {
  blockMarkdown,
  markdownlessNode,
  textPath,
  unknownNodeNotice,
  validateRichSpans,
} from "./richtext.mjs";
import { projectReadContent } from "./read-content.mjs";
import { pagePreview } from "./page-preview.mjs";
import { readSpans, splitBlockStored } from "./richtext-format.mjs";

const S = (value) => new A.ImmutableString(value);
function withUnknown(source, marker, at) {
  let doc = A.from(createPageData({ pageId: "unknown_nodes", title: "Unknown" }));
  doc = A.change(doc, (draft) => initializePage(draft, source));
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) =>
    splitBlockStored(draft, textPath(id), at(draft.blocks[id].richText), {
      ...marker,
      type: S(marker.type),
      parents: marker.parents.map(S),
    }),
  );
  return { doc, id };
}
const futureChart = (source = "Before\n\nAfter") =>
  withUnknown(
    source,
    { type: "future-chart", parents: [], attrs: { title: S("Usage") }, isEmbed: false },
    (text) => text.indexOf("After") - 1,
  );
const video = (source = "Before\n\nAfter", parents = ["paragraph"]) =>
  withUnknown(
    source,
    { type: "video", parents, attrs: { src: S("x") }, isEmbed: true },
    (text) => text.indexOf("After") + 2,
  );
const apply = (doc, operations) =>
  A.change(A.clone(doc), (draft) =>
    applyPageOperation(draft, { operation: "patch_page", arguments: { operations } }),
  );

test("a read shows an unknown block or embed as a notice instead of hiding it", () => {
  const block = futureChart();
  assert.equal(
    blockMarkdown(block.doc.blocks[block.id]),
    "Before\n\n\\[Unsupported node: future-chart\\]\n\nAfter",
  );
  const inline = video();
  assert.equal(
    blockMarkdown(inline.doc.blocks[inline.id]),
    "Before\n\nAf\\[Unsupported node: video\\]ter",
  );
  const cell = video("| a | b |\n| --- | --- |\n| After | 2 |", [
    "table",
    "table-row",
    "table-cell",
  ]);
  assert.match(
    blockMarkdown(cell.doc.blocks[cell.id]),
    /\| Af\\\[Unsupported node: video\\\]ter \| 2 \|/,
  );
  assert.ok(projectReadContent(block.doc, {}).outline.some((entry) => entry.type === "unknown"));
  // read_page projects and outlines the block.
  for (const { doc } of [block, inline, cell]) {
    const read = projectReadContent(doc, {});
    assert.ok(read.blocks[0].markdown.includes("Unsupported node"));
    assert.ok(read.outline.length > 0);
  }
});

test("the notice quotes only a short identifier", () => {
  assert.equal(unknownNodeNotice("future-chart"), "[Unsupported node: future-chart]");
  assert.equal(unknownNodeNotice("<script>]"), "[Unsupported node]");
  assert.equal(unknownNodeNotice("x".repeat(65)), "[Unsupported node]");
  assert.equal(unknownNodeNotice(undefined), "[Unsupported node]");
});

test("replace_block_markdown refuses a block holding an unknown node; text edits keep it", () => {
  const { doc, id } = futureChart();
  assert.equal(markdownlessNode(doc.blocks[id]), "future-chart");
  assert.throws(
    () => apply(doc, [{ op: "replace_block_markdown", block_id: id, markdown: "Before\n\nAfter" }]),
    (error) => error.code === "markdownless_node" && /holds a future-chart/.test(error.message),
  );
  const edited = apply(doc, [
    { op: "replace_match", block_id: id, match_text: "After", replacement: "Later" },
    { op: "format_match", block_id: id, match_text: "Before", add: { strong: true } },
  ]);
  const types = readSpans(edited, textPath(id))
    .filter((span) => span.type === "block")
    .map((span) => String(span.value.type));
  assert.ok(types.includes("future-chart"));
  assert.match(
    blockMarkdown(edited.blocks[id]),
    /\*\*Before\*\*[\s\S]*Unsupported node: future-chart[\s\S]*Later/,
  );
});

test("markdownlessNode names unknown types and unknown parents, never known ones", () => {
  let plain = A.from(createPageData({ pageId: "known_only", title: "Known" }));
  plain = A.change(plain, (draft) =>
    initializePage(
      draft,
      "# Head\n\n- [ ] task\n\n> quote\n\n| a |\n| --- |\n| b |\n\n```py\nx\n```\n\n---",
    ),
  );
  assert.equal(markdownlessNode(plain.blocks[orderedBlockIds(plain)[0]]), null);
  const nested = withUnknown(
    "Before\n\nAfter",
    { type: "paragraph", parents: ["callout"], attrs: {}, isEmbed: false },
    (text) => text.indexOf("After") - 1,
  );
  assert.equal(markdownlessNode(nested.doc.blocks[nested.id]), "callout");
  assert.throws(
    () => apply(nested.doc, [{ op: "replace_block_markdown", block_id: nested.id, markdown: "x" }]),
    (error) => error.code === "markdownless_node",
  );
});

test("the refusal quotes only a short identifier", () => {
  const odd = withUnknown(
    "Before\n\nAfter",
    { type: "<b>bad</b>", parents: [], attrs: {}, isEmbed: false },
    (text) => text.indexOf("After") - 1,
  );
  assert.throws(
    () => apply(odd.doc, [{ op: "replace_block_markdown", block_id: odd.id, markdown: "x" }]),
    (error) =>
      /a node this version of Pages doesn't know/.test(error.message) &&
      !error.message.includes("<b>"),
  );
});

test("reads project unknown nodes the adapter can't place", () => {
  const cell = withUnknown(
    "| a | b |\n| --- | --- |\n| After | 2 |",
    {
      type: "future-chart",
      parents: ["table", "table-row", "table-cell"],
      attrs: {},
      isEmbed: false,
    },
    (text) => text.indexOf("After") + 2,
  );
  assert.ok(
    blockMarkdown(cell.doc.blocks[cell.id]).includes(
      "| Af\\[Unsupported node: future-chart\\]ter | 2 |",
    ),
  );
  const code = withUnknown(
    "```\nAfter\n```",
    { type: "video", parents: ["code-block"], attrs: {}, isEmbed: true },
    (text) => text.indexOf("After") + 2,
  );
  assert.equal(blockMarkdown(code.doc.blocks[code.id]), "```\nAf[Unsupported node: video]ter\n```");
  for (const { doc } of [cell, code]) {
    assert.ok(projectReadContent(doc, {}).outline.length > 0);
    assert.equal(pagePreview(doc).blocks.length, 1);
  }
});

test("registration still refuses a marker this build doesn't know", () => {
  const { doc, id } = futureChart();
  assert.throws(
    () => validateRichSpans(readSpans(doc, textPath(id))),
    /Unsupported rich block marker/,
  );
});
