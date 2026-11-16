import assert from "node:assert/strict";
import test from "node:test";
import { Decoration } from "wordgard/editor";
import { Leaf } from "wordgard/doc";
import { schema, Paragraph, PagesView, Blockquote } from "./wordgard-model.mjs";
import { rangeHighlights } from "./range-highlights.mjs";

test("mixed selections preserve prose wrappers but apply attributes directly to views", () => {
  const doc = schema.doc([
    Paragraph.create([Leaf.text("Before")]),
    PagesView.of({ view_id: "one" }),
    Blockquote.create([PagesView.of({ view_id: "two" })]),
    Paragraph.create([Leaf.text("After")]),
  ]);
  const positions = [];
  doc.iterate((node, pos) => {
    if (node.type === PagesView) positions.push(pos);
  });
  const attributes = {
    class: "peer-selection",
    title: "A collaborator",
    style: "--peer-color: teal",
  };
  const entries = rangeHighlights(doc, 0, doc.length, attributes);
  assert.equal(positions.length, 2);
  for (const pos of positions) {
    const covering = entries.filter(([, from, to]) => from <= pos && to > pos);
    assert.equal(covering.length, 3);
    for (const [deco, from, to] of covering) {
      assert.equal(from, pos);
      assert.equal(to, pos + 1);
      assert.ok(
        Object.entries(attributes).some(([name, value]) =>
          deco.eq(Decoration.Range.attribute(name, value, { query: PagesView })),
        ),
      );
    }
  }
  const prose = entries.filter(([d]) => d.eq(Decoration.Range.wrapper("span", { attributes })));
  assert.equal(prose.length, 3);

  assert.deepEqual(rangeHighlights(doc, 0, 0, attributes), []);
});
