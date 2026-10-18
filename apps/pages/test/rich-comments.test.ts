import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as A from "@automerge/automerge/slim";
import { EditorState, TextSelection } from "prosemirror-state";
import { createPage } from "../src/document.ts";
import { prepareComment, projectComments } from "../src/comments.ts";
import { enableRich, richDoc, textPath } from "../src/richtext.mjs";
import {
  commentRanges,
  commentsForSelection,
  richComments,
  revealCommentPassage,
} from "../viewer/rich-comments.mjs";
await A.initializeWasm(
  await readFile(new URL(import.meta.resolve("@automerge/automerge/automerge.wasm"))),
);
function fixture() {
  let doc = createPage(
    "page_" + "1".repeat(32),
    "Comments",
    ["A **café 🌍** passage. Another café 🌍 passage."],
    "a".repeat(64),
  );
  const id = doc.order[0];
  doc = A.change(doc, (d) => enableRich(d, id));
  doc = A.change(
    doc,
    prepareComment(doc, {
      action: "add",
      block_id: id,
      selected_text: "café 🌍",
      occurrence: 2,
      body: "The second passage",
    }).apply,
  );
  return { doc, id };
}
test("comment passages follow CRDT anchors through edits and distinguish repeated Unicode text", () => {
  let { doc, id } = fixture();
  const threads = projectComments(doc);
  const initial = commentRanges(doc, id, threads)[0];
  assert.equal(richDoc(doc.blocks[id]).textBetween(initial.from, initial.to), "café 🌍");
  assert.deepEqual(commentsForSelection(doc, id, { text: "café 🌍", occurrence: 1 }, threads), []);
  assert.equal(
    commentsForSelection(doc, id, { text: "café 🌍", occurrence: 2 }, threads)[0].id,
    threads[0].id,
  );
  doc = A.change(doc, (d) => A.splice(d, textPath(id), 1, 0, "New "));
  const moved = commentRanges(doc, id, threads)[0];
  assert.equal(moved.from, initial.from + 4);
  assert.equal(moved.to, initial.to + 4);
  // Even a stale projection must resolve anchors against the current document.
  const start = doc.blocks[id].richText!.lastIndexOf("café 🌍");
  doc = A.change(doc, (d) => A.splice(d, textPath(id), start, "café 🌍".length, ""));
  assert.deepEqual(commentRanges(doc, id, threads), []);
  assert.deepEqual(commentsForSelection(doc, id, { text: "café 🌍", occurrence: 1 }, threads), []);
});
test("resolved ranges only illuminate when revealed; metadata repaint preserves the editing selection", () => {
  let { doc, id } = fixture();
  const threadId = projectComments(doc)[0].id;
  doc = A.change(doc, prepareComment(doc, { action: "resolve", thread_id: threadId }).apply);
  const threads = projectComments(doc);
  let active: string | undefined;
  const plugin = richComments(
    { doc },
    id,
    () => threads,
    () => active,
  );
  let state = EditorState.create({ doc: richDoc(doc.blocks[id]), plugins: [plugin] });
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 3, 6)));
  const decorations = () => plugin.props.decorations!.call(plugin, state) as any;
  assert.equal(decorations().find().length, 0);
  assert.deepEqual(commentsForSelection(doc, id, { text: "café 🌍", occurrence: 2 }, threads), []);
  active = threadId;
  const before = state.selection;
  state = state.apply(state.tr.setMeta("addToHistory", false));
  assert.equal(decorations().find().length, 1);
  assert.ok(state.selection.eq(before));
  assert.ok(decorations().find()[0].type.attrs.class.includes("comment-passage-active"));
  doc = A.change(doc, (d) => {
    d.order.splice(0, 1);
  });
  assert.deepEqual(commentRanges(doc, id, threads), []);
});
test("revealing a passage only scrolls its decoration and leaves composition alone", () => {
  let scrolled = 0;
  const view = {
    composing: true,
    dom: { querySelector: () => ({ scrollIntoView: () => scrolled++ }) },
  };
  revealCommentPassage(view);
  assert.equal(scrolled, 0);
  view.composing = false;
  revealCommentPassage(view);
  assert.equal(scrolled, 1);
});
