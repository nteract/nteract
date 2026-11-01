import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  createPageData,
  initializePage,
  orderedBlockIds,
  projectPage,
  applyPageOperation,
} from "./page.mjs";
import { projectComments } from "./comments.mjs";
import { comment, newCommentsDoc } from "./comments-test-support.mjs";
import { textPath, richDoc } from "./richtext.mjs";
import { guardPassageEdits } from "./passage-edits.mjs";

function fixture(markdown = "First passage.\n\nKeep **target** unchanged.\n\nLast passage.") {
  let doc = A.from(createPageData({ pageId: "passage_test", title: "Passages" }));
  doc = A.change(doc, (draft) => initializePage(draft, markdown));
  return { doc, id: orderedBlockIds(doc)[0], heads: A.getHeads(doc) };
}
const op = (id, extra = {}) => ({
  op: "replace_match",
  block_id: id,
  match_text: "target",
  replacement: "result",
  ...extra,
});
function edit(current, baseHeads, operations) {
  const plan = guardPassageEdits(current, baseHeads, operations);
  const after = A.change(A.clone(current), (draft) =>
    applyPageOperation(draft, {
      operation: "patch_page",
      arguments: { operations: plan.operations },
    }),
  );
  return { after, plan };
}
function rejects(current, heads, operations, reason) {
  const bytes = A.save(current),
    oldHeads = A.getHeads(current);
  assert.throws(
    () => guardPassageEdits(current, heads, operations),
    (error) => {
      assert.equal(error.status, 409, error.message);
      assert.equal(error.code, "edit_conflict");
      assert.equal(error.details.conflicts.length, 1);
      if (reason) assert.equal(error.details.conflicts[0].reason, reason);
      return true;
    },
  );
  assert.deepEqual(A.save(current), bytes);
  assert.deepEqual(A.getHeads(current), oldHeads);
}
function paragraph() {
  return { type: new A.ImmutableString("paragraph"), parents: [], attrs: {}, isEmbed: false };
}

test("node_index scopes repeated text at the same revision without whole-block replacement", () => {
  const { doc, id, heads } = fixture("apple\n\n## apple\n\napple");
  const object = A.getObjectId(doc.blocks[id], "richText");
  const { after, plan } = edit(doc, heads, [
    op(id, { match_text: "apple", replacement: "pear", node_index: 2 }),
  ]);
  assert.equal(plan.rebased, false);
  assert.equal(projectPage(after).blocks[0].markdown, "apple\n\n## apple\n\npear");
  assert.equal(A.getObjectId(after.blocks[id], "richText"), object);
  assert.equal(projectPage(doc).blocks[0].markdown, "apple\n\n## apple\n\napple");
});

test("node-scoped matching supports list/table/code nodes but never crosses native segments", () => {
  const { doc, id, heads } = fixture(
    "apple\n\n- apple\n- other\n\n| Name |\n| --- |\n| apple |\n\n```text\napple\n```",
  );
  for (const node_index of [1, 2, 3]) {
    const { after } = edit(doc, heads, [
      op(id, { match_text: "apple", replacement: "pear", node_index }),
    ]);
    assert.equal(richDoc(after.blocks[id]).child(node_index).textContent.includes("pear"), true);
    assert.equal(richDoc(after.blocks[id]).child(0).textContent, "apple");
  }
  assert.throws(
    () => edit(doc, heads, [op(id, { match_text: "appleother", node_index: 1 })]),
    /exactly one/,
  );
});

test("unrelated edits in the same rich block preserve both contributions, marks and comment anchors", () => {
  let { doc, id } = fixture();
  const { comments } = comment(
    doc,
    newCommentsDoc(),
    { action: "add", block_id: id, selected_text: "Last passage.", body: "Keep this" },
    { principal: "human", displayName: "Human", driver: "Browser" },
  );
  const heads = A.getHeads(doc),
    path = textPath(id);
  const current = A.change(A.clone(doc), (draft) => {
    A.splice(draft, path, draft.blocks[id].richText.indexOf("First"), 0, "New ");
    A.splice(draft, path, draft.blocks[id].richText.indexOf("Last"), 0, "Still ");
  });
  const { after, plan } = edit(current, heads, [op(id, { node_index: 1 })]);
  assert.equal(plan.rebased, true);
  assert.match(projectPage(after).blocks[0].markdown, /New First passage/);
  assert.match(projectPage(after).blocks[0].markdown, /\*\*result\*\*/);
  assert.match(projectPage(after).blocks[0].markdown, /Still Last passage/);
  assert.equal(projectComments(after, comments)[0].selectionContext.text, "Last passage.");
  assert.equal(projectComments(after, comments)[0].selectionContext.status, "attached");
});

test("native cursors map a scoped node past an inserted paragraph without selecting duplicate text", () => {
  const { doc, id, heads } = fixture("apple\n\napple");
  const current = A.change(A.clone(doc), (draft) => {
    A.splitBlock(draft, textPath(id), 0, paragraph());
    A.splice(draft, textPath(id), 1, 0, "apple");
  });
  const { after, plan } = edit(current, heads, [
    op(id, { match_text: "apple", replacement: "pear", node_index: 1 }),
  ]);
  assert.equal(plan.operations[0].node_index, 2);
  assert.equal(projectPage(after).blocks[0].markdown, "apple\n\napple\n\npear");
});

test("unscoped matching retains whole-block uniqueness after an unrelated duplicate is added", () => {
  const { doc, id, heads } = fixture("target\n\nOther.");
  const current = A.change(A.clone(doc), (draft) =>
    A.splice(draft, textPath(id), draft.blocks[id].richText.length, 0, " target"),
  );
  rejects(current, heads, [op(id)], "target_no_longer_unique");
  const { after } = edit(current, heads, [op(id, { node_index: 0 })]);
  assert.equal(projectPage(after).blocks[0].markdown, "result\n\nOther. target");
});

test("Unicode targets and shifts use UTF-16 coordinates without splitting emoji", () => {
  const { doc, id, heads } = fixture("🌞 Before 🌊 target 🪴 after.");
  const current = A.change(A.clone(doc), (draft) =>
    A.splice(draft, textPath(id), draft.blocks[id].richText.indexOf("Before"), 0, "🌱 "),
  );
  const { after } = edit(current, heads, [
    op(id, { match_text: "🌊 target 🪴", replacement: "🌳 garden" }),
  ]);
  assert.equal(projectPage(after).blocks[0].markdown, "🌞 🌱 Before 🌳 garden after.");
});

test("text changes, interior identical replacement and restored text identity all conflict", () => {
  const { doc, id, heads } = fixture("Keep target here.");
  const start = doc.blocks[id].richText.indexOf("target");
  for (const [at, count, value] of [
    [start + 2, 1, "R"],
    [start + 2, 1, "r"],
    [start, 6, "target"],
    [start + 3, 0, "new"],
  ]) {
    const current = A.change(A.clone(doc), (draft) =>
      A.splice(draft, textPath(id), at, count, value),
    );
    rejects(current, heads, [op(id)], "target_text_changed");
  }
  let current = A.change(A.clone(doc), (draft) => A.splice(draft, textPath(id), start, 6, "other"));
  current = A.change(current, (draft) => A.splice(draft, textPath(id), start, 5, "target"));
  rejects(current, heads, [op(id)], "target_text_changed");
});

test("remaining target mark/link changes conflict; unrelated and toggled-back formatting do not", () => {
  const { doc, id, heads } = fixture("Before target after.");
  const start = doc.blocks[id].richText.indexOf("target"),
    path = textPath(id);
  const marked = A.change(A.clone(doc), (draft) =>
    A.mark(draft, path, { start, end: start + 6 }, "strong", true),
  );
  rejects(marked, heads, [op(id)], "target_formatting_changed");
  const restored = A.change(marked, (draft) =>
    A.unmark(draft, path, { start, end: start + 6 }, "strong"),
  );
  assert.equal(
    projectPage(edit(restored, heads, [op(id)]).after).blocks[0].markdown,
    "Before result after.",
  );
  const other = A.change(A.clone(doc), (draft) =>
    A.mark(draft, path, { start: 1, end: 7 }, "em", true),
  );
  assert.match(projectPage(edit(other, heads, [op(id)]).after).blocks[0].markdown, /result/);
});

test("paragraph type conversion, embeds and deleted boundaries conflict with target structure", () => {
  const { doc, id, heads } = fixture("Keep target here.\n\nOther.");
  const converted = A.change(A.clone(doc), (draft) =>
    A.updateBlock(draft, textPath(id), 0, {
      ...paragraph(),
      type: new A.ImmutableString("heading"),
      attrs: { level: 2 },
    }),
  );
  rejects(converted, heads, [op(id)], "target_structure_changed");
  const split = A.change(A.clone(doc), (draft) =>
    A.splitBlock(draft, textPath(id), draft.blocks[id].richText.indexOf("here"), paragraph()),
  );
  rejects(split, heads, [op(id)], "target_structure_changed");
});

test("deleted or replaced historical blocks and text objects conflict instead of resolving latest paths", () => {
  const { doc, id, heads } = fixture();
  for (const mutation of [
    (draft) => delete draft.blocks[id],
    (draft) => {
      draft.blocks[id] = JSON.parse(JSON.stringify(draft.blocks[id]));
    },
    (draft) => {
      draft.blocks[id].richText = String(draft.blocks[id].richText);
    },
  ]) {
    const current = A.change(A.clone(doc), mutation);
    rejects(current, heads, [op(id)], "text_object_changed");
  }
});

test("disjoint batches work sequentially and overlapping or retargeting batches fail atomically", () => {
  const { doc, id, heads } = fixture("Keep first and second.");
  const { after } = edit(doc, heads, [
    op(id, { match_text: "first", replacement: "longer first result" }),
    op(id, { match_text: "second", replacement: "last" }),
  ]);
  assert.equal(projectPage(after).blocks[0].markdown, "Keep longer first result and last.");
  rejects(
    doc,
    heads,
    [
      op(id, { match_text: "first and", replacement: "X" }),
      op(id, { match_text: "and second", replacement: "Y" }),
    ],
    "overlapping_batch_targets",
  );
  const f = fixture("first apple; second apple");
  rejects(
    f.doc,
    f.heads,
    [
      op(f.id, { match_text: "first apple; second", replacement: "second apple; first" }),
      op(f.id, { match_text: "apple", replacement: "pear", context_before: "second" }),
    ],
    "batch_changes_target_resolution",
  );
});

test("unknown revisions require resync and malformed selectors cannot invoke a broad fallback", () => {
  const { doc, id, heads } = fixture();
  assert.throws(
    () => guardPassageEdits(doc, ["0".repeat(64)], [op(id)]),
    (error) => error.status === 409 && error.code === "resync_required",
  );
  for (const bad of [
    [],
    [...heads, ...heads],
    ["bad"],
    Array.from({ length: 129 }, (_, i) => i.toString(16).padStart(64, "0")),
  ])
    assert.throws(
      () => guardPassageEdits(doc, bad, [op(id)]),
      (error) => error.status === 400 && error.code === "invalid_edit_selector",
    );
  for (const operations of [
    [],
    [{ op: "set_title", title: "No" }],
    [op(id, { node_index: -1 })],
    [op(id, { node_index: 999 })],
    [op(id, { match_text: "\ud800" })],
    [op(id, { replacement: undefined })],
  ])
    assert.throws(
      () => guardPassageEdits(doc, heads, operations),
      (error) => error.status === 400 && error.code === "invalid_edit_selector",
    );
});

const fmt = (id, extra = {}) => ({
  op: "format_match",
  block_id: id,
  match_text: "target",
  add: { highlight: "green" },
  ...extra,
});
const spansOf = (doc, id) =>
  A.spans(doc.blocks[id], ["richText"])
    .filter((span) => span.type === "text")
    .map((span) => [span.value, span.marks ?? {}]);

test("format_match accepts an older read when its target is unchanged", () => {
  const { doc, id, heads } = fixture();
  // Someone types elsewhere in the same block after the agent read.
  const moved = A.change(doc, (d) => A.splice(d, ["blocks", id, "richText"], 1, 0, "Edited: "));
  const { after, plan } = edit(moved, heads, [
    fmt(id),
    op(id, { match_text: "Last", replacement: "Final" }),
  ]);
  assert.equal(plan.rebased, true);
  const spans = spansOf(after, id);
  assert.ok(
    spans.some(([text, marks]) => text === "target" && marks.highlight === "green" && marks.strong),
  );
  assert.match(spans.map(([text]) => text).join(""), /^Edited: First passage\..*Final passage\.$/s);
});

test("format_match conflicts when its target text or formatting changed since the read", () => {
  const { doc, id, heads } = fixture();
  const path = ["blocks", id, "richText"];
  const start = doc.blocks[id].richText.indexOf("target");
  const retyped = A.change(doc, (d) => A.splice(d, path, start, 6, "target"));
  rejects(retyped, heads, [fmt(id)], "target_text_changed");
  const restyled = A.change(A.clone(doc), (d) =>
    A.mark(d, path, { start, end: start + 6, expand: "both" }, "em", true),
  );
  rejects(restyled, heads, [fmt(id)], "target_formatting_changed");
});

test("invalid format_match input and code text are the caller's error, not a conflict", () => {
  const { doc, id, heads } = fixture();
  for (const bad of [
    { add: { underline: true } },
    { add: { highlight: "red" } },
    { add: undefined },
  ])
    assert.throws(
      () => guardPassageEdits(doc, heads, [fmt(id, bad)]),
      (error) => error.status === 400 && error.code === "invalid_edit_selector",
    );
  const code = fixture("```python\ntarget = 1\n```");
  assert.throws(
    () => guardPassageEdits(code.doc, code.heads, [fmt(code.id)]),
    (error) => error.status === 400 && /code block/.test(error.message),
  );
});
