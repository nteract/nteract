import test from "node:test";
import assert from "node:assert/strict";
import { markdownPasteSlice } from "../paste.mjs";
import { parseMarkdown } from "../model.mjs";
import { EditorState } from "prosemirror-state";
test("inline Markdown paste preserves spaces and formatting without creating paragraphs", () => {
  const state = EditorState.create({ doc: parseMarkdown("hello world") });
  const next = state.apply(state.tr.replace(6, 6, markdownPasteSlice(" **bright** ")));
  assert.equal(next.doc.childCount, 1);
  assert.equal(next.doc.textContent, "hello bright  world");
  assert.ok(next.doc.firstChild.child(1).marks.some((m) => m.type.name === "strong"));
});
test("multiline paste retains structure", () => {
  const state = EditorState.create({ doc: parseMarkdown("hello") });
  const next = state.apply(state.tr.replace(6, 6, markdownPasteSlice("one\n\ntwo")));
  assert.equal(next.doc.childCount, 2);
});
