import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { applyComment, projectComments } from "../model/comments.mjs";
import { RICH_FORMAT, setRichMarkdown, textPath } from "../model/richtext.mjs";
import { commentAtPosition, commentRanges, richComments } from "./rich-comments.mjs";

function fixture() {
  let doc = A.from({ blocks: {}, comments: {} });
  const ids = {};
  doc = A.change(doc, (d) => {
    for (const [id, position] of [
      ["first", "a0"],
      ["second", "a1"],
    ]) {
      d.blocks[id] = {
        id,
        position,
        kind: "markdown",
        format: RICH_FORMAT,
        markdown: "",
        richText: "",
      };
      setRichMarkdown(d, id, "Same passage here and more text.");
    }
    for (const [name, block_id, selected_text] of [
      ["wide", "first", "Same passage here"],
      ["narrow", "first", "passage"],
      ["other", "second", "Same passage here"],
    ]) {
      ids[name] = applyComment(d, { action: "add", block_id, selected_text, body: name }).thread_id;
    }
  });
  return { doc, ids };
}

test("passage clicks select a thread in that block, favoring active or specific overlaps", () => {
  let { doc, ids } = fixture();
  let threads = projectComments(doc);
  const narrow = commentRanges(doc, "first", threads).find((range) => range.id === ids.narrow);
  const position = narrow.from + 2;
  assert.equal(commentAtPosition(doc, "first", position, threads), ids.narrow);
  assert.equal(commentAtPosition(doc, "first", position, threads, ids.wide), ids.wide);
  assert.equal(commentAtPosition(doc, "second", position, threads, ids.wide), ids.other);
  assert.equal(commentAtPosition(doc, "first", 0, threads), null);
  doc = A.change(doc, (d) => applyComment(d, { action: "resolve", thread_id: ids.narrow }));
  threads = projectComments(doc);
  assert.equal(commentAtPosition(doc, "first", position, threads, ids.narrow), ids.wide);
  doc = A.change(doc, (d) => A.splice(d, textPath("first"), 1, 0, "Added "));
  threads = projectComments(doc);
  const moved = commentRanges(doc, "first", threads).find((range) => range.id === ids.wide);
  assert.equal(commentAtPosition(doc, "first", moved.from + 2, threads), ids.wide);
});

test("comment navigation preserves normal caret and link/modified-click behavior without writing", () => {
  const { doc, ids } = fixture();
  const threads = projectComments(doc);
  const selected = [];
  const replica = { doc };
  const plugin = richComments(
    replica,
    "first",
    () => threads,
    () => null,
    (id) => selected.push(id),
  );
  const narrow = commentRanges(doc, "first", threads).find((range) => range.id === ids.narrow);
  const position = narrow.from + 2;
  const event = { button: 0, detail: 1, target: { closest: () => null } };
  const heads = A.getHeads(doc);
  assert.equal(
    plugin.props.handleClick({}, position, event),
    false,
    "caret handling remains ProseMirror's",
  );
  assert.deepEqual(selected, [ids.narrow]);
  for (const changed of [
    { button: 2 },
    { detail: 2 },
    { metaKey: true },
    { ctrlKey: true },
    { altKey: true },
    { shiftKey: true },
    { target: { closest: () => ({}) } },
  ])
    plugin.props.handleClick({}, position, { ...event, ...changed });
  assert.deepEqual(
    selected,
    [ids.narrow],
    "links and modified selection gestures do not open comments",
  );
  assert.deepEqual(
    A.getHeads(doc),
    heads,
    "comment navigation never changes shared document state",
  );
});
