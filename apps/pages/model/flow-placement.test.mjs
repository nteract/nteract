// Inserts with no node anchor write into the Page's first or last block, so
// a Page an agent builds in pieces stays one flow (model/flow-placement.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { blockMarkdown } from "./richtext.mjs";
import { blockAddress, nodeAddresses } from "./addresses.mjs";
import { projectComments } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { MAX_PASSAGE_BLOCK_LENGTH } from "./replace-match.mjs";

const PAGE = "66666666-6666-4666-8666-666666666666";
const KEY = "main";
const ASSET = "a".repeat(64);

const page = (markdown) =>
  A.change(A.from(createPageData({ pageId: PAGE, title: "Flow" })), (draft) =>
    initializePage(draft, markdown, KEY),
  );
function edit(doc, operations) {
  let result;
  const next = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, { operation: "edit_page", arguments: { operations } });
  });
  return { doc: next, result };
}
const all = (doc) =>
  orderedBlockIds(doc)
    .map((key) => blockMarkdown(doc.blocks[key], PAGE))
    .join("\n\n");

test("an omitted after_node_id appends after the last node, in the last block", () => {
  const doc = page("Alpha\n\nBeta");
  const before = nodeAddresses(doc, KEY);
  const { doc: after, result } = edit(doc, [{ op: "insert_markdown", markdown: "Gamma\n\nDelta" }]);
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  assert.equal(all(after), "Alpha\n\nBeta\n\nGamma\n\nDelta");
  const [entry] = result.edits;
  assert.equal(entry.block, blockAddress(doc, KEY));
  assert.equal(entry.node_id, undefined);
  assert.deepEqual(nodeAddresses(after, KEY), [...before, ...entry.nodes]);
});

test("a null after_node_id writes before the first node, in the first block", () => {
  const doc = page("Alpha\n\nBeta");
  const before = nodeAddresses(doc, KEY);
  const { doc: after, result } = edit(doc, [
    { op: "insert_markdown", markdown: "# Title", after_node_id: null },
  ]);
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  assert.equal(all(after), "# Title\n\nAlpha\n\nBeta");
  assert.deepEqual(nodeAddresses(after, KEY), [...result.edits[0].nodes, ...before]);
});

test("a Page built in pieces by appends is one block", () => {
  let doc = page("Intro");
  for (const markdown of ["## One", "Body one.", "## Two", "- a\n- b", "Closing."])
    ({ doc } = edit(doc, [{ op: "insert_markdown", markdown }]));
  doc = edit(doc, [{ op: "insert_image", asset_id: ASSET, alt: "Chart" }]).doc;
  doc = edit(doc, [
    { op: "insert_node", node: { type: "dataframe", attrs: { asset_id: ASSET } } },
  ]).doc;
  assert.deepEqual(orderedBlockIds(doc), [KEY]);
  assert.equal(nodeAddresses(doc, KEY).length, 8);
});

test("appends in one batch land in order", () => {
  const doc = page("Start");
  const { doc: after } = edit(doc, [
    { op: "insert_markdown", markdown: "One" },
    { op: "insert_markdown", markdown: "Two" },
    { op: "insert_markdown", markdown: "Three", after_node_id: null },
  ]);
  assert.equal(all(after), "Three\n\nStart\n\nOne\n\nTwo");
  assert.deepEqual(orderedBlockIds(after), [KEY]);
});

test("a new Page's blank block takes the first insert in place of its empty paragraph", () => {
  const doc = page("");
  const { doc: after, result } = edit(doc, [{ op: "insert_markdown", markdown: "First words." }]);
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  assert.equal(all(after), "First words.");
  assert.equal(result.edits[0].block, blockAddress(after, KEY));
  assert.deepEqual(result.edits[0].nodes, nodeAddresses(after, KEY));
});

test("comments on the last block stay attached through an append", () => {
  const doc = page("Alpha line.\n\nBeta line.");
  const { comments } = comment(doc, newCommentsDoc(), {
    action: "add",
    block_id: KEY,
    selected_text: "Beta line",
    body: "Note",
  });
  const { doc: after } = edit(doc, [{ op: "insert_markdown", markdown: "Gamma." }]);
  const [thread] = projectComments(after, comments);
  assert.equal(thread.selectionContext.status, "attached");
  assert.equal(thread.selectionContext.text, "Beta line");
});

test("a block's id still puts the content in a block of its own", () => {
  const doc = page("Alpha");
  const { doc: after, result } = edit(doc, [
    { op: "insert_markdown", markdown: "Own block", after_node_id: blockAddress(doc, KEY) },
  ]);
  assert.equal(orderedBlockIds(after).length, 2);
  assert.ok(result.edits[0].node_id);
});

test("content that would join a list at the edge goes in a new block instead", () => {
  const doc = page("Intro\n\n- one\n- two");
  const { doc: after, result } = edit(doc, [{ op: "insert_markdown", markdown: "- three" }]);
  const keys = orderedBlockIds(after);
  assert.equal(keys.length, 2);
  assert.equal(keys[0], KEY);
  assert.ok(result.edits[0].node_id);
  assert.equal(blockMarkdown(after.blocks[KEY], PAGE), "Intro\n\n- one\n- two");
  // A list of another kind joins nothing and goes in place.
  const ordered = edit(doc, [{ op: "insert_markdown", markdown: "1. first" }]).doc;
  assert.deepEqual(orderedBlockIds(ordered), [KEY]);
});

test("a last block too long to search with a passage operation is left as it is", () => {
  const long = "x".repeat(MAX_PASSAGE_BLOCK_LENGTH - 5);
  const doc = page(long);
  const { doc: after, result } = edit(doc, [{ op: "insert_markdown", markdown: "Tail." }]);
  assert.equal(orderedBlockIds(after).length, 2);
  assert.ok(result.edits[0].node_id);
});

test("with blocks deleted, a batch's appends make one new block and fill it", () => {
  const doc = page("Old");
  const { doc: after } = edit(doc, [
    { op: "delete_block", node_id: blockAddress(doc, KEY) },
    { op: "insert_markdown", markdown: "One" },
    { op: "insert_markdown", markdown: "Two" },
  ]);
  const keys = orderedBlockIds(after);
  assert.equal(keys.length, 1);
  assert.equal(all(after), "One\n\nTwo");
});

test("an append never lands in a block a later operation deletes or rewrites", () => {
  const doc = page("Old body");
  const block = blockAddress(doc, KEY);
  for (const operations of [
    [
      { op: "insert_markdown", markdown: "Kept" },
      { op: "delete_block", node_id: block },
    ],
    [
      { op: "delete_block", node_id: block },
      { op: "insert_markdown", markdown: "Kept" },
    ],
  ]) {
    const { doc: after } = edit(doc, operations);
    assert.equal(all(after), "Kept", JSON.stringify(operations.map((op) => op.op)));
  }
  const { doc: rewritten } = edit(doc, [
    { op: "insert_markdown", markdown: "Kept", after_node_id: null },
    { op: "replace_block_markdown", node_id: block, markdown: "New body" },
  ]);
  assert.equal(all(rewritten), "Kept\n\nNew body");
  // A rewrite earlier in the batch is followed by the appends, in its block.
  const { doc: first } = edit(doc, [
    { op: "replace_block_markdown", node_id: block, markdown: "New body" },
    { op: "insert_markdown", markdown: "Then this" },
  ]);
  assert.deepEqual(orderedBlockIds(first), [KEY]);
  assert.equal(all(first), "New body\n\nThen this");
});

test("an append stays out of a block a later operation moves or inserts after", () => {
  // The Page holds two blocks: KEY, then `last`.
  let doc = page("First");
  doc = edit(doc, [
    { op: "insert_markdown", markdown: "> Quote", after_node_id: blockAddress(doc, KEY) },
  ]).doc;
  const last = orderedBlockIds(doc).at(-1);
  // A later move of the last block leaves the append at the end of the Page.
  const moved = edit(doc, [
    { op: "insert_markdown", markdown: "Tail" },
    { op: "move_block", node_id: blockAddress(doc, last), after_node_id: null },
  ]).doc;
  assert.equal(all(moved), "> Quote\n\nFirst\n\nTail");
  // A later insert after the last block's id goes after it, then the append.
  const after = edit(doc, [
    { op: "insert_markdown", markdown: "Appended" },
    { op: "insert_markdown", markdown: "After the block", after_node_id: blockAddress(doc, last) },
  ]).doc;
  assert.equal(all(after), "First\n\n> Quote\n\nAfter the block\n\nAppended");
});

test("an agent's first append and a person's first keystrokes in a blank Page both survive", () => {
  const doc = page("");
  const person = A.change(A.clone(doc, { actor: "0e".repeat(16) }), (draft) => {
    A.splice(draft, ["blocks", KEY, "richText"], draft.blocks[KEY].richText.length, 0, "Typed");
  });
  const { doc: agent } = edit(doc, [{ op: "insert_markdown", markdown: "Agent text." }]);
  const merged = all(A.merge(agent, person));
  assert.match(merged, /Typed/);
  assert.match(merged, /Agent text\./);
});

test("an append and a person typing at the end of the last paragraph both survive", () => {
  const doc = page("Alpha\n\nBeta");
  const person = A.change(A.clone(doc, { actor: "0e".repeat(16) }), (draft) => {
    A.splice(draft, ["blocks", KEY, "richText"], draft.blocks[KEY].richText.length, 0, " typed");
  });
  const { doc: agent } = edit(doc, [{ op: "insert_markdown", markdown: "Gamma" }]);
  const merged = A.merge(agent, person);
  assert.match(all(merged), /typed/);
  assert.match(all(merged), /Gamma/);
  assert.deepEqual(orderedBlockIds(merged), [KEY]);
});
