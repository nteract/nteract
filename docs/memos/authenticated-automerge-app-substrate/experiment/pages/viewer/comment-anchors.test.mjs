// Comment anchors through real editor transactions: the browser path a
// person's typing takes from Wordgard into the native Page.
import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { GardState } from "wordgard/state";
import { history, undo } from "wordgard/history";
import { captureSelectionTarget, selectionContext } from "../model/comments.mjs";
import { enableRich } from "../model/richtext.mjs";
import { schema } from "./wordgard-model.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";

function page(markdown) {
  let doc = A.change(A.from({ blocks: { one: { id: "one", kind: "markdown", markdown } } }), (d) =>
    enableRich(d, "one"),
  );
  const observers = new Set();
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      const before = doc;
      doc = A.change(doc, fn);
      for (const observe of observers)
        observe({
          remote: false,
          patches: A.diff(doc, A.getHeads(before), A.getHeads(doc)),
          patchInfo: { before, after: doc },
        });
    },
    observeChange(fn) {
      observers.add(fn);
      return () => observers.delete(fn);
    },
  };
  const binding = createWordgardBinding(replica, "one");
  let state = GardState.create({
    doc: binding.current.doc,
    config: [GardState.schemaElement.of(schema.elements), history()],
  });
  const dispatch = (spec) => {
    const tr = state.update(spec);
    binding.applyEditorTransaction(tr);
    state = tr.state;
  };
  // Editor position of a raw text offset in the one paragraph.
  const at = (text) => {
    const offset = replica.doc.blocks.one.richText.indexOf(text);
    assert.ok(offset >= 0, text);
    return binding.current.map.amToWg[offset];
  };
  const comment = (text) => captureSelectionTarget(replica.doc, "one", text);
  const anchored = (target) => selectionContext(replica.doc, target);
  return {
    replica,
    binding,
    dispatch,
    at,
    comment,
    anchored,
    get state() {
      return state;
    },
  };
}

test("a comment anchor follows typing before it and inside it", () => {
  const p = page("The quick brown fox jumps.");
  const target = p.comment("brown fox");
  p.dispatch({ changes: { from: p.at("quick"), insert: [Leaf.text("very ")] } });
  assert.equal(p.anchored(target).text, "brown fox");
  p.dispatch({ changes: { from: p.at(" fox"), insert: [Leaf.text(" little")] } });
  assert.equal(p.anchored(target).text, "brown little fox");
  assert.equal(p.anchored(target).status, "attached");
  p.binding.destroy();
});

test("deleting the whole commented passage detaches its comment", () => {
  const p = page("The quick brown fox jumps.");
  const target = p.comment("brown fox");
  p.dispatch({ changes: { from: p.at("brown fox"), to: p.at(" jumps") } });
  assert.equal(p.anchored(target).status, "detached");
  p.binding.destroy();
});

test(
  "replacing the first word of a commented passage keeps the new word in the anchor",
  { todo: "QA overnight Nov 1: replacing the first word of a commented passage drops it" },
  () => {
    const p = page("The quick brown fox jumps.");
    const target = p.comment("brown fox");
    // Select "brown" and type "red": Wordgard replaces the range.
    p.dispatch({ changes: { from: p.at("brown"), to: p.at(" fox"), insert: [Leaf.text("red")] } });
    assert.equal(p.anchored(target).text, "red fox");
    p.binding.destroy();
  },
);

test(
  "undoing the deletion of a commented passage reattaches its comment",
  { todo: "QA overnight Nov 1: undo after deleting a commented passage leaves it detached" },
  () => {
    const p = page("The quick brown fox jumps.");
    const target = p.comment("brown fox");
    p.dispatch({ changes: { from: p.at("brown fox"), to: p.at(" jumps") } });
    assert.equal(p.anchored(target).status, "detached");
    p.dispatch(undo({ state: p.state }));
    assert.equal(p.replica.doc.blocks.one.richText, "The quick brown fox jumps.");
    assert.equal(p.anchored(target).status, "attached");
    p.binding.destroy();
  },
);
