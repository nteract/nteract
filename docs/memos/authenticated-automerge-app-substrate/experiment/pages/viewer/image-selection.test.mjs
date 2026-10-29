import test from "node:test";
import assert from "node:assert/strict";
import { Leaf } from "wordgard/doc";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { schema, Paragraph, PagesImage } from "./wordgard-model.mjs";
import { selectedImage } from "./image-selection.mjs";
import { projectChanges } from "./wordgard-projection.mjs";

const image = PagesImage.of({ src: "/api/pages/test/assets/image", alt: "Cat" });
const doc = (before = "Before ", after = " after") =>
  schema.doc([Paragraph.create([Leaf.text(before), image, Leaf.text(after)])]);
const state = (readOnly = false) =>
  GardState.create({
    doc: doc(),
    config: [
      GardState.readOnly.of(readOnly),
      schema.elements.map((element) => GardState.schemaElement.of(element)),
    ],
    selection: GardSelection.node(8, image),
  });

test("native image selection changes context; text carets and ranges retain text controls", () => {
  for (const readonly of [false, true]) {
    const selected = state(readonly);
    assert.equal(selectedImage(selected)?.node, image);
    for (const selection of [{ anchor: 7 }, { anchor: 9 }, { anchor: 2, head: 12 }]) {
      const text = selected.update({ selection }).state;
      assert.equal(selectedImage(text), null);
      assert.equal(text.doc, selected.doc, "Changing toolbar context must not edit the document");
    }
  }
});

test("peer insertions on either side of an image preserve native node selection", () => {
  let selected = state();
  for (const next of [doc("Peer before "), doc("Peer before ", " peer after")]) {
    selected = selected.update({
      changes: projectChanges(selected.doc, next),
      annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
    }).state;
    assert.ok(selectedImage(selected));
    assert.equal(selectedImage(selected).node.param.src, image.param.src);
    assert.equal(selected.doc.nodeAt(selected.selection.from).type, PagesImage);
  }
});

test("a peer deleting the selected image returns to text selection", () => {
  const selected = state();
  const next = schema.doc([Paragraph.create([Leaf.text("Before  after")])]);
  const deleted = selected.update({
    changes: projectChanges(selected.doc, next),
    annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
  }).state;
  assert.equal(selectedImage(deleted), null);
  assert.ok(deleted.selection instanceof GardSelection.Text);
});
