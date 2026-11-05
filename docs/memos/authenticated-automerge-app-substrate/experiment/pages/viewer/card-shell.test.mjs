import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createPageData, initializePage } from "../model/page.mjs";
import { firstScreenSpans, shellBlocks } from "./card-shell.mjs";

const page = (markdown) =>
  A.change(
    A.from(createPageData({ pageId: "11111111-1111-4111-8111-111111111111", title: "T" })),
    (d) => initializePage(d, markdown),
  );
const topLevel = (spans) =>
  spans.filter((span) => span.type === "block" && !(span.value?.parents?.length > 0)).length;

test("the shell renders the card's blocks, cut to the first screen's nodes", () => {
  const doc = page(Array.from({ length: 60 }, (_, i) => `Paragraph ${i}`).join("\n\n"));
  const blocks = shellBlocks(doc);
  assert.equal(blocks.length, 1);
  // The first paragraph has no marker: 23 markers are 24 nodes.
  assert.equal(topLevel(blocks[0].spans), 23);
  assert.match(String(blocks[0].spans.at(-1).value), /Paragraph 23/);
});

test("a long text cuts at the next node boundary, and one huge node in its text", () => {
  const spans = [
    { type: "block", value: { type: "paragraph", parents: [] } },
    { type: "text", value: "x".repeat(3_000) },
    { type: "block", value: { type: "paragraph", parents: [] } },
    { type: "text", value: "y".repeat(3_000) },
    { type: "block", value: { type: "paragraph", parents: [] } },
    { type: "text", value: "never" },
  ];
  const kept = firstScreenSpans(spans);
  assert.equal(topLevel(kept), 2);
  assert.equal(
    kept.some((span) => span.value === "never"),
    false,
  );
  const huge = firstScreenSpans([
    { type: "block", value: { type: "code-block", parents: [] } },
    { type: "text", value: "z".repeat(50_000) },
  ]);
  assert.equal(huge[1].value.length, 12_000);
});

test("an empty Page has no shell blocks", () => {
  assert.deepEqual(shellBlocks(page("")), []);
});
