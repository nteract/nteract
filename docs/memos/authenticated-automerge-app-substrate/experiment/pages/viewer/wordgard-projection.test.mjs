import test from "node:test";
import assert from "node:assert/strict";
import { Leaf } from "wordgard/doc";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { schema, Paragraph, Strong, PagesLink, PagesImage } from "./wordgard-model.mjs";
import { projectChanges } from "./wordgard-projection.mjs";
const doc = (...nodes) => schema.doc([Paragraph.create(nodes)]);
test("reordered image attrs beside remote text preserve the image and its node selection", () => {
  for (const opaque of [{}, { future: "opaque", count: 2, enabled: false, empty: null }]) {
    const attrs = { src: "https://example.com/image.png", alt: "Diagram", title: null, ...opaque };
    const image = PagesImage.of(attrs);
    const reordered = PagesImage.of(Object.fromEntries(Object.entries(attrs).reverse()));
    assert.ok(image.eq(reordered));
    const before = doc(Leaf.text("Before"), image);
    const after = doc(Leaf.text("Before"), reordered, Leaf.text("After"));
    const changes = projectChanges(before, after);
    const ranges = [];
    changes.iterChanges((from, to, fromB, toB) => ranges.push([from, to, fromB, toB]));
    assert.deepEqual(ranges, [[8, 8, 8, 13]], "only adjacent text is inserted");
    const state = GardState.create({
      doc: before,
      selection: GardSelection.node(7, image),
      config: schema.elements.map((e) => GardState.schemaElement.of(e)),
    });
    const updated = state.update({ changes, annotations: [Transaction.remote.of(true)] }).state;
    assert.ok(updated.selection.eq(state.selection), "remote text keeps the selected image");
    assert.ok(updated.doc.eq(after));
  }
});
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
test("a changed opaque image attr still replaces the image", () => {
  const attrs = { src: "https://example.com/image.png", alt: "Diagram", future: "before" };
  const before = doc(PagesImage.of(attrs));
  const after = doc(PagesImage.of({ ...attrs, future: "after" }));
  const changes = projectChanges(before, after);
  const ranges = [];
  changes.iterChanges((from, to) => ranges.push([from, to]));
  assert.deepEqual(ranges, [[1, 2]]);
  assert.ok(changes.apply(before).eq(after));
});
