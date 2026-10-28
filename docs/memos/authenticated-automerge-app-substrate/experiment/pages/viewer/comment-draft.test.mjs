import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  createPageData,
  initializePage,
  applyPageOperation,
  orderedBlockIds,
} from "../model/page.mjs";
import { applyComment, projectComments } from "../model/comments.mjs";
import { captureCommentDraft, resolveCommentDraft } from "./comment-draft.mjs";

function page(markdown = "echo first / echo last") {
  const doc = A.from(createPageData({ pageId: "draft_fixture", title: "Draft fixture" }));
  return A.change(doc, (d) => initializePage(d, markdown));
}
const identity = { principal: "account:one", displayName: "Kyle Kelley", driver: "Browser" };
const path = (id) => ["blocks", id, "richText"];

test("drafts keep their passage through concurrent duplicate text insertions", () => {
  const original = page(),
    id = orderedBlockIds(original)[0],
    draft = captureCommentDraft(original, id, { text: "echo", occurrence: 2 }),
    start = original.blocks[id].richText.indexOf("echo");
  const left = A.change(A.clone(original), (d) => A.splice(d, path(id), start, 0, "echo left / "));
  const right = A.change(A.clone(original), (d) =>
    A.splice(d, path(id), start, 0, "echo right / "),
  );
  let merged = A.merge(left, right);
  const input = resolveCommentDraft(merged, draft);
  assert.deepEqual(input, { block_id: id, selected_text: "echo", occurrence: 4 });
  merged = A.change(merged, (d) =>
    applyComment(d, { ...input, body: "This original echo" }, identity),
  );
  const comment = projectComments(merged)[0];
  assert.deepEqual(comment.target, draft.target, "submission anchors the original characters");
  assert.equal(
    comment.selectionContext.start.offsetUtf16,
    merged.blocks[id].richText.lastIndexOf("echo"),
  );
});

test("a draft belongs to its captured block after another block becomes the editing target", () => {
  let doc = page("same passage");
  const first = orderedBlockIds(doc)[0];
  doc = A.change(doc, (d) =>
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: {
        operations: [{ op: "insert_markdown", markdown: "same passage", after_block_id: first }],
      },
    }),
  );
  const second = orderedBlockIds(doc)[1],
    draft = captureCommentDraft(doc, first, { text: "same passage", occurrence: 1 });
  doc = A.change(doc, (d) => {
    A.splice(d, path(second), d.blocks[second].richText.length, 0, " edited elsewhere");
    applyPageOperation(d, {
      operation: "edit_page",
      arguments: { operations: [{ op: "move_block", block_id: first, after_block_id: second }] },
    });
  });
  assert.deepEqual(resolveCommentDraft(doc, draft), {
    block_id: first,
    selected_text: "same passage",
    occurrence: 1,
  });
});

test("deleted selected endpoints cannot reattach a draft to an identical later passage", () => {
  for (const endpoint of ["first", "last", "whole"]) {
    let doc = page("chosen / chosen");
    const id = orderedBlockIds(doc)[0],
      draft = captureCommentDraft(doc, id, { text: "chosen", occurrence: 1 }),
      start = doc.blocks[id].richText.indexOf("chosen");
    doc = A.change(doc, (d) =>
      A.splice(
        d,
        path(id),
        start + (endpoint === "last" ? 5 : 0),
        endpoint === "whole" ? 6 : 1,
        "",
      ),
    );
    assert.match(doc.blocks[id].richText, /chosen$/);
    assert.throws(
      () => resolveCommentDraft(doc, draft),
      /Selected passage was removed or replaced/,
      endpoint,
    );
  }
});

test("deleting and recreating the same selected text does not revive its draft anchors", () => {
  let doc = page("before chosen after");
  const id = orderedBlockIds(doc)[0],
    draft = captureCommentDraft(doc, id, { text: "chosen", occurrence: 1 }),
    start = doc.blocks[id].richText.indexOf("chosen");
  doc = A.change(doc, (d) => A.splice(d, path(id), start, 6, "chosen"));
  assert.throws(() => resolveCommentDraft(doc, draft), /Selected passage was removed or replaced/);
});

test("drafts reject replaced text objects even when the visible text is unchanged", () => {
  let doc = page();
  const id = orderedBlockIds(doc)[0],
    draft = captureCommentDraft(doc, id, { text: "echo", occurrence: 2 }),
    source = doc.blocks[id].richText;
  doc = A.change(doc, (d) => {
    delete d.blocks[id].richText;
    d.blocks[id].richText = source;
  });
  assert.throws(() => resolveCommentDraft(doc, draft), /Selected passage was removed or replaced/);
});

test("block-only and selection drafts reject removed or replaced blocks", () => {
  for (const selection of [null, { text: "echo", occurrence: 1 }]) {
    const doc = page(),
      id = orderedBlockIds(doc)[0],
      draft = captureCommentDraft(doc, id, selection);
    const deleted = A.change(A.clone(doc), (d) => {
      delete d.blocks[id];
    });
    assert.throws(() => resolveCommentDraft(deleted, draft), /Comment block was removed/);
    const replaced = A.change(A.clone(doc), (d) => {
      d.blocks[id] = { ...d.blocks[id], metadata: {} };
    });
    assert.throws(() => resolveCommentDraft(replaced, draft), /Comment block was replaced/);
  }
});

test("block-only drafts remain block comments when the block content changes", () => {
  let doc = page();
  const id = orderedBlockIds(doc)[0],
    draft = captureCommentDraft(doc, id, null);
  doc = A.change(doc, (d) => A.updateText(d, path(id), "Completely different content"));
  assert.deepEqual(resolveCommentDraft(doc, draft), { block_id: id });
});

test("a surviving Unicode passage includes edits inside its anchors and submits raw paragraph markers", () => {
  let doc = page("Before 🌊 passage\n\nafter 🌊");
  const id = orderedBlockIds(doc)[0],
    source = doc.blocks[id].richText,
    selected = source.slice(source.indexOf("🌊"), source.lastIndexOf("🌊") + 2),
    draft = captureCommentDraft(doc, id, { text: selected, occurrence: 1 });
  doc = A.change(doc, (d) => A.splice(d, path(id), source.indexOf("passage"), 0, "living "));
  const input = resolveCommentDraft(doc, draft);
  assert.equal(input.selected_text, selected.replace("passage", "living passage"));
  assert.ok(
    input.selected_text.includes("\ufffc"),
    "semantic comment input uses the raw text object",
  );
  doc = A.change(doc, (d) => applyComment(d, { ...input, body: "Across paragraphs" }, identity));
  assert.equal(projectComments(doc)[0].selectionContext.status, "attached");
  assert.deepEqual(projectComments(doc)[0].target, draft.target);
});

test("capture rejects a stale passage rather than creating a block-only comment", () => {
  const doc = page(),
    id = orderedBlockIds(doc)[0];
  assert.throws(
    () => captureCommentDraft(doc, id, { text: "missing", occurrence: 1 }),
    /Selected passage was removed or replaced/,
  );
  assert.throws(
    () => captureCommentDraft(doc, id, { text: "echo", occurrence: 3 }),
    /Selected passage was removed or replaced/,
  );
  assert.throws(() => captureCommentDraft(doc, "missing", null), /Comment block was removed/);
});
