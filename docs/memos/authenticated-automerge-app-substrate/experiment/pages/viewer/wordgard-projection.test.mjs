import test from "node:test";
import assert from "node:assert/strict";
import { Leaf } from "wordgard/doc";
import { schema, Paragraph, Strong, PagesLink, OpaqueBlock } from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
const doc = (...nodes) => schema.doc([Paragraph.create(nodes)]);
test("mark-only projections preserve text positions without replacement", () => {
  const before = doc(Leaf.text("hello 🌊 world")),
    after = doc(Leaf.text("hello 🌊", [Strong]), Leaf.text(" world"));
  const changes = projectChanges(before, after);
  let replacements = 0;
  changes.iterChanges(() => replacements++);
  assert.equal(replacements, 0);
  assert.equal(changes.mapPos(9), 9);
  assert.ok(changes.apply(before).eq(after));
});
test("disjoint changes map untouched selections and preserve link titles", () => {
  const before = doc(Leaf.text("one 🌊 two three"));
  const after = doc(
    Leaf.text("ONE 🌊 two "),
    Leaf.text("THREE", [PagesLink.of({ href: "https://example.com", title: "Named" })]),
  );
  const changes = projectChanges(before, after);
  assert.ok(changes.apply(before).eq(after));
  assert.equal(changes.mapPos(8), 8);
});
test("opaque source updates project as intact leaf changes", () => {
  const before = schema.doc([OpaqueBlock.of({ source: "old", importId: "", kind: "markdown" })]);
  const after = schema.doc([OpaqueBlock.of({ source: "new", importId: "", kind: "markdown" })]);
  assert.ok(projectChanges(before, after).apply(before).eq(after));
});
