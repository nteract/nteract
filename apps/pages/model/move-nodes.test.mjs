// move_nodes: a run of top-level nodes moved after another node, with the
// comment threads on the moved text re-anchored (model/move-nodes.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyPageOperation, createPageData, initializePage, orderedBlockIds } from "./page.mjs";
import { blockMarkdown } from "./richtext.mjs";
import { blockAddress, nodeAddresses } from "./addresses.mjs";
import { projectComments } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { applyCommentRewrites, moveComments } from "./move-nodes.mjs";

const PAGE = "55555555-5555-4555-8555-555555555555";
const KEY = "main";

const page = (markdown) =>
  A.change(A.from(createPageData({ pageId: PAGE, title: "Plan" })), (draft) =>
    initializePage(draft, markdown, KEY),
  );
/** One edit_page batch with the comment state its moves read. Returns the
 * next Page, the next comments document and the result. */
function edit(doc, operations, comments = newCommentsDoc()) {
  let result;
  const state = moveComments(comments);
  const next = A.change(A.clone(doc), (draft) => {
    result = applyPageOperation(draft, {
      operation: "edit_page",
      arguments: { operations },
      comments: state,
    });
  });
  const nextComments = state.rewrites.size
    ? A.change(comments, (draft) => applyCommentRewrites(draft, state.rewrites))
    : comments;
  return { doc: next, comments: nextComments, result, detached: state.detached };
}
const markdown = (doc, key = KEY) => blockMarkdown(doc.blocks[key], PAGE);
const ids = (doc, key = KEY) => nodeAddresses(doc, key);
const refused = (doc, operations, code, pattern) =>
  assert.throws(
    () => edit(doc, operations),
    (error) => error.code === code && (!pattern || pattern.test(error.message)),
    JSON.stringify(operations),
  );
const contexts = (doc, comments) =>
  projectComments(doc, comments).map(({ selectionContext: { status, text } }) => ({
    status,
    text,
  }));
function withComments(doc, ...selections) {
  let comments = newCommentsDoc();
  for (const selected_text of selections)
    ({ comments } = comment(doc, comments, {
      action: "add",
      block_id: KEY,
      selected_text,
      body: "Note",
    }));
  return comments;
}

test("move_nodes moves a run after a later node; nodes outside keep their ids", () => {
  const doc = page("Alpha\n\nBeta\n\nGamma\n\nDelta");
  const [alpha, beta, gamma, delta] = ids(doc);
  const { doc: after, result } = edit(doc, [
    { op: "move_nodes", node_id: beta, through_node_id: gamma, after_node_id: delta },
  ]);
  assert.equal(markdown(after), "Alpha\n\nDelta\n\nBeta\n\nGamma");
  const now = ids(after);
  assert.deepEqual([now[0], now[1]], [alpha, delta]);
  assert.equal(result.edits[0].op, "move_nodes");
  assert.deepEqual(result.edits[0].nodes, [now[2], now[3]]);
  assert.ok(!now.includes(beta) && !now.includes(gamma));
});

test("move_nodes moves a run before earlier nodes, and to the start with a null anchor", () => {
  const doc = page("Alpha\n\nBeta\n\nGamma\n\nDelta");
  const [alpha, , gamma] = ids(doc);
  assert.equal(
    markdown(edit(doc, [{ op: "move_nodes", node_id: gamma, after_node_id: alpha }]).doc),
    "Alpha\n\nGamma\n\nBeta\n\nDelta",
  );
  assert.equal(
    markdown(edit(doc, [{ op: "move_nodes", node_id: gamma, after_node_id: null }]).doc),
    "Gamma\n\nAlpha\n\nBeta\n\nDelta",
  );
});

test("move_nodes keeps headings, lists and marks as stored", () => {
  const doc = page(
    "# Intro\n\nOpening **bold** line.\n\n# Details\n\n- one\n- two\n\nTail *em* text.",
  );
  const [intro, opening, details, list, tail] = ids(doc);
  const { doc: after } = edit(doc, [
    { op: "move_nodes", node_id: details, through_node_id: tail, after_node_id: null },
  ]);
  assert.equal(
    markdown(after),
    "# Details\n\n- one\n- two\n\nTail *em* text.\n\n# Intro\n\nOpening **bold** line.",
  );
  assert.deepEqual(ids(after).slice(3), [intro, opening]);
  void list;
});

test("comments on the moved text stay attached on the same text; others are untouched", () => {
  const doc = page("Alpha line.\n\nBeta line here.\n\nGamma line.");
  const comments = withComments(doc, "Beta line", "Gamma");
  const [alpha, beta] = ids(doc);
  void alpha;
  const {
    doc: after,
    comments: nextComments,
    result,
  } = edit(doc, [{ op: "move_nodes", node_id: beta, after_node_id: ids(doc)[2] }], comments);
  assert.equal(markdown(after), "Alpha line.\n\nGamma line.\n\nBeta line here.");
  assert.equal(result.edits[0].comments_moved, 1);
  assert.deepEqual(contexts(after, nextComments), [
    { status: "attached", text: "Beta line" },
    { status: "attached", text: "Gamma" },
  ]);
  // Without the rewrite the moved thread would be detached.
  assert.deepEqual(
    contexts(after, comments).map(({ status }) => status),
    ["detached", "attached"],
  );
});

test("a comment that crosses the run's edge is reported as detached", () => {
  const doc = page("Alpha line.\n\nBeta line.");
  let comments = withComments(doc, "Alpha");
  const text = doc.blocks[KEY].richText;
  const path = ["blocks", KEY, "richText"];
  const point = (offset) => ({
    blockId: KEY,
    textObjectId: A.getObjectId(doc.blocks[KEY], "richText"),
    relativePositionBase64: btoa(A.getCursor(doc, path, offset)),
  });
  // From "line." in Alpha through "Beta", across the marker between them.
  const target = {
    kind: "selection",
    anchor: point(text.indexOf("line.")),
    head: point(text.indexOf("Beta") + 3),
  };
  comments = A.change(comments, (draft) => {
    const [id] = Object.keys(draft.threads);
    draft.threads[id].target = target;
  });
  const [id] = Object.keys(comments.threads);
  const [, beta] = ids(doc);
  const { detached } = edit(
    doc,
    [{ op: "move_nodes", node_id: beta, after_node_id: null }],
    comments,
  );
  assert.deepEqual(detached, [id]);
});

test("two moves in one batch carry a thread on a node neither names", () => {
  const doc = page("Alpha\n\nBeta note\n\nGamma\n\nDelta");
  const comments = withComments(doc, "note");
  const [, beta, gamma, delta] = ids(doc);
  const moved = edit(
    doc,
    [
      { op: "move_nodes", node_id: beta, after_node_id: delta },
      { op: "move_nodes", node_id: gamma, after_node_id: null },
    ],
    comments,
  );
  assert.equal(markdown(moved.doc), "Gamma\n\nAlpha\n\nDelta\n\nBeta note");
  assert.deepEqual(contexts(moved.doc, moved.comments), [{ status: "attached", text: "note" }]);
});

test("a second move of the same node carries its thread again", () => {
  const doc = page("Alpha\n\nBeta note\n\nGamma\n\nDelta");
  const comments = withComments(doc, "note");
  const [, beta, , delta] = ids(doc);
  const first = edit(doc, [{ op: "move_nodes", node_id: beta, after_node_id: delta }], comments);
  const moved = first.result.edits[0].nodes[0];
  const second = edit(
    first.doc,
    [{ op: "move_nodes", node_id: moved, after_node_id: null }],
    first.comments,
  );
  assert.equal(markdown(second.doc), "Beta note\n\nAlpha\n\nGamma\n\nDelta");
  assert.deepEqual(contexts(second.doc, second.comments), [{ status: "attached", text: "note" }]);
});

/** A Page of two blocks: KEY holds `first`, a second block holds `second`. */
function twoBlocks(first, second) {
  const doc = A.change(page(first), (draft) =>
    applyPageOperation(draft, {
      operation: "edit_page",
      arguments: { operations: [{ op: "insert_markdown", markdown: second }] },
    }),
  );
  return { doc, second: orderedBlockIds(doc)[1] };
}

test("moving every node of a block into another removes it; its block comment covers the moved text", () => {
  const { doc, second } = twoBlocks("First block.", "Second block.\n\nMore.");
  const [secondFirst, secondLast] = nodeAddresses(doc, second);
  const [first] = ids(doc);
  const { comments } = comment(doc, newCommentsDoc(), {
    action: "add",
    block_id: second,
    body: "On the whole block",
  });
  const {
    doc: after,
    comments: nextComments,
    result,
  } = edit(
    doc,
    [{ op: "move_nodes", node_id: secondFirst, through_node_id: secondLast, after_node_id: first }],
    comments,
  );
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  assert.equal(markdown(after), "First block.\n\nSecond block.\n\nMore.");
  assert.equal(result.edits[0].removed_block, true);
  const [thread] = projectComments(after, nextComments);
  assert.equal(thread.target.kind, "selection");
  assert.equal(thread.selectionContext.status, "attached");
  // From the first node's text, as a person's selection of the run starts.
  assert.equal(thread.selectionContext.text, "Second block.\nMore.");
});

test("a block comment on a moved run keeps an opening rule, image or list inside its selection", () => {
  // These nodes are markers with no text of their own. A selection that
  // started at the run's first text would leave them out of the comment.
  for (const [source, tail] of [
    ["---\n\nAfter rule", "After rule"],
    ["![Cat](https://example.com/cat.png)\n\nTail", "Tail"],
    ["- a\n- b\n\nTail", "Tail"],
  ]) {
    const { doc, second } = twoBlocks("First block.", source);
    const run = nodeAddresses(doc, second);
    const { comments } = comment(doc, newCommentsDoc(), {
      action: "add",
      block_id: second,
      body: "On the whole block",
    });
    const moved = edit(
      doc,
      [
        {
          op: "move_nodes",
          node_id: run[0],
          through_node_id: run.at(-1),
          after_node_id: ids(doc)[0],
        },
      ],
      comments,
    );
    const [thread] = projectComments(moved.doc, moved.comments);
    assert.equal(thread.selectionContext.status, "attached", source);
    // The opening marker reads as a line break ahead of the run's text.
    const { text } = thread.selectionContext;
    assert.ok(text.startsWith("\n") && text.endsWith(tail), `${source}: ${JSON.stringify(text)}`);
  }
});

test("a move inside a large block fits the batch; too many are refused as moves", () => {
  // One block of about 240,000 UTF-16 units, the size one flow makes of a
  // long Page. A move counts its block twice, so one batch takes two moves.
  const paragraph = "word ".repeat(400).trim();
  const doc = page(Array.from({ length: 120 }, (_, i) => `${i} ${paragraph}`).join("\n\n"));
  const { length } = doc.blocks[KEY].richText;
  assert.ok(length > 235_000 && length < 250_000, String(length));
  const all = ids(doc);
  const { doc: after } = edit(
    doc,
    [1, 3].map((i) => ({ op: "move_nodes", node_id: all[i], after_node_id: all.at(-1) })),
  );
  assert.equal(ids(after).length, all.length);
  assert.ok(markdown(after).endsWith(`1 ${paragraph}`));
  assert.throws(
    () =>
      edit(
        doc,
        [1, 3, 5].map((i) => ({ op: "move_nodes", node_id: all[i], after_node_id: all.at(-1) })),
      ),
    (error) =>
      error.code === undefined &&
      error.editReason === "in_place_budget" &&
      /moves nodes inside blocks too many times/.test(error.message) &&
      error.editAt.index === 2,
  );
});

test("a null after_node_id moves the run to the start of the Page, not of its block", () => {
  const { doc, second } = twoBlocks("First block.", "Second block.");
  const [moved] = nodeAddresses(doc, second);
  const { doc: after } = edit(doc, [{ op: "move_nodes", node_id: moved, after_node_id: null }]);
  assert.deepEqual(orderedBlockIds(after), [KEY]);
  assert.equal(markdown(after), "Second block.\n\nFirst block.");
});

test("move_nodes refuses an omitted after_node_id instead of guessing a place", () => {
  const doc = page("Alpha\n\nBeta\n\nGamma");
  const [, , gamma] = ids(doc);
  refused(doc, [{ op: "move_nodes", node_id: gamma }], "invalid_move", /needs after_node_id/);
});

test("text a peer types into a moved node while it moves lands in the node before the run's old place", () => {
  // The move deletes the run's characters and writes copies; a peer's
  // concurrent splice at the end of the deleted node survives at the end of
  // the node before it, as it does for delete_node. Nothing is lost.
  const doc = page("Alpha\n\nBeta\n\nGamma");
  const [, beta, gamma] = ids(doc);
  const peer = A.change(A.clone(doc, { actor: "0d".repeat(16) }), (draft) => {
    const at = draft.blocks[KEY].richText.indexOf("Beta") + 4;
    A.splice(draft, ["blocks", KEY, "richText"], at, 0, " typed by a person");
  });
  const { doc: moved } = edit(doc, [{ op: "move_nodes", node_id: beta, after_node_id: gamma }]);
  assert.equal(markdown(A.merge(moved, peer)), "Alpha typed by a person\n\nGamma\n\nBeta");
});

test("move_nodes refuses an anchor inside the run, a reversed run and a no-op", () => {
  const doc = page("Alpha\n\nBeta\n\nGamma");
  const [alpha, beta, gamma] = ids(doc);
  refused(
    doc,
    [{ op: "move_nodes", node_id: alpha, through_node_id: gamma, after_node_id: beta }],
    "invalid_move",
    /inside the range/,
  );
  refused(
    doc,
    [{ op: "move_nodes", node_id: gamma, through_node_id: alpha, after_node_id: null }],
    "invalid_move",
    /at or after/,
  );
  refused(
    doc,
    [{ op: "move_nodes", node_id: beta, after_node_id: alpha }],
    "invalid_move",
    /nothing to move/,
  );
});

test("move_nodes refuses a move that would join the lists around the run", () => {
  const doc = page("- one\n\nBetween.\n\n- two\n\nTail.");
  const [, between, , tail] = ids(doc);
  refused(doc, [{ op: "move_nodes", node_id: between, after_node_id: tail }], "nodes_would_join");
});

test("move_nodes takes node ids only", () => {
  const doc = page("Alpha\n\nBeta");
  const [alpha] = ids(doc);
  refused(
    doc,
    [{ op: "move_nodes", node_id: blockAddress(doc, KEY), after_node_id: alpha }],
    "wrong_address_kind",
  );
});
