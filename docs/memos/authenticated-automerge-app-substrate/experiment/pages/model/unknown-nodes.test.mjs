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

const S = (value) => new A.ImmutableString(value);
function withUnknown(source, marker, at) {
  let doc = A.from(createPageData({ pageId: "unknown_nodes", title: "Unknown" }));
  doc = A.change(doc, (draft) => initializePage(draft, source));
  const id = orderedBlockIds(doc)[0];
  doc = A.change(doc, (draft) =>
    A.splitBlock(draft, textPath(id), at(draft.blocks[id].richText), {
      ...marker,
      type: S(marker.type),
      parents: marker.parents.map(S),
    }),
  );
  return { doc, id };
}
const dataframe = (source = "Before\n\nAfter") =>
  withUnknown(
    source,
    { type: "dataframe", parents: [], attrs: { title: S("Usage") }, isEmbed: false },
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
  const block = dataframe();
  assert.equal(
    blockMarkdown(block.doc.blocks[block.id]),
    "Before\n\n\\[Unsupported node: dataframe\\]\n\nAfter",
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
  assert.ok(
    projectReadContent(block.doc, {}).outline.some((entry) => entry.type === "unknownBlock"),
  );
  // read_page projects and outlines the block.
  for (const { doc } of [block, inline, cell]) {
    const read = projectReadContent(doc, {});
    assert.ok(read.blocks[0].markdown.includes("Unsupported node"));
    assert.ok(read.outline.length > 0);
  }
});

test("the notice quotes only a short identifier", () => {
  assert.equal(unknownNodeNotice("dataframe"), "[Unsupported node: dataframe]");
  assert.equal(unknownNodeNotice("<script>]"), "[Unsupported node]");
  assert.equal(unknownNodeNotice("x".repeat(65)), "[Unsupported node]");
  assert.equal(unknownNodeNotice(undefined), "[Unsupported node]");
});

test("replace_block_markdown refuses a block holding an unknown node; text edits keep it", () => {
  const { doc, id } = dataframe();
  assert.equal(markdownlessNode(doc.blocks[id]), "dataframe");
  assert.throws(
    () => apply(doc, [{ op: "replace_block_markdown", block_id: id, markdown: "Before\n\nAfter" }]),
    (error) => error.code === "markdownless_node" && /holds a dataframe/.test(error.message),
  );
  const edited = apply(doc, [
    { op: "replace_match", block_id: id, match_text: "After", replacement: "Later" },
    { op: "format_match", block_id: id, match_text: "Before", add: { strong: true } },
  ]);
  const types = A.spans(edited, textPath(id))
    .filter((span) => span.type === "block")
    .map((span) => String(span.value.type));
  assert.ok(types.includes("dataframe"));
  assert.match(
    blockMarkdown(edited.blocks[id]),
    /\*\*Before\*\*[\s\S]*Unsupported node: dataframe[\s\S]*Later/,
  );
  // A block with only known nodes rewrites as before.
  assert.equal(
    markdownlessNode(apply(doc, [{ op: "delete_block", block_id: id }]).blocks?.[id]),
    null,
  );
});

test("registration still refuses a marker this build doesn't know", () => {
  const { doc, id } = dataframe();
  assert.throws(
    () => validateRichSpans(A.spans(doc, textPath(id))),
    /Unsupported rich block marker/,
  );
});
