import test from "node:test";
import assert from "node:assert/strict";
import { GardState } from "wordgard/state";
import { Leaf } from "wordgard/doc";
import { schema, decode } from "./wordgard-model.mjs";
const text = (value) => [Leaf.text(value)];
import { setUploadPreview, uploadPreview, uploadPreviews } from "./upload-preview.mjs";

const state = (text) =>
  GardState.create({
    doc: decode([{ type: "text", value: text }]).doc,
    config: [GardState.schemaElement.of(schema.elements), uploadPreviews],
  });

test("the pending upload preview follows its insertion point through edits", () => {
  let s = state("before after");
  const at = 1 + "before ".length;
  s = s.update({
    effects: setUploadPreview.of({ pos: at, src: "blob:x", name: "photo.png" }),
  }).state;
  assert.equal(s.field(uploadPreview).pos, at);
  // Text typed before the point pushes it along; text after doesn't move it.
  s = s.update({ changes: { from: 1, insert: text("Plan: ") } }).state;
  assert.equal(s.field(uploadPreview).pos, at + 6);
  s = s.update({ changes: { from: s.doc.length - 1, insert: text("!") } }).state;
  assert.equal(s.field(uploadPreview).pos, at + 6);
  // Typing exactly at the point keeps the preview after the new text.
  const p = s.field(uploadPreview).pos;
  s = s.update({ changes: { from: p, insert: text("X") } }).state;
  assert.equal(s.field(uploadPreview).pos, p + 1);
  // Clearing removes it.
  s = s.update({ effects: setUploadPreview.of(null) }).state;
  assert.equal(s.field(uploadPreview), null);
});

test("deleting the text around the insertion point keeps a valid position or clears it", () => {
  let s = state("one two three");
  const at = 1 + "one two".length;
  s = s.update({ effects: setUploadPreview.of({ pos: at, src: "", name: "" }) }).state;
  s = s.update({ changes: { from: 1 + "one ".length, to: 1 + "one two three".length } }).state;
  const value = s.field(uploadPreview);
  assert.ok(value === null || (value.pos >= 1 && value.pos <= s.doc.length - 1));
});
