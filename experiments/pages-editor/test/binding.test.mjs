import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "prosemirror-state";
import { history, undo, redo } from "prosemirror-history";
import { checkedInit } from "../binding.mjs";
import { pair, synchronize, projected } from "../model.mjs";
function editor(replica, id = "first-observation") {
  const { schema, pmDoc, plugin } = checkedInit(replica, id);
  const view = {
    state: EditorState.create({ schema, doc: pmDoc, plugins: [plugin, history()] }),
    dispatch(tr) {
      view.state = view.state.apply(tr);
    },
  };
  plugin.spec.view(view);
  return view;
}
test("binding split and join project identically on remote replica", () => {
  const [a, b] = pair(),
    alice = editor(a),
    bob = editor(b);
  alice.dispatch(alice.state.tr.split(21));
  synchronize(a, b);
  assert.ok(
    bob.state.doc.eq(projected(b.doc(), "first-observation")),
    "remote split matches canonical",
  );
  alice.dispatch(alice.state.tr.join(22));
  synchronize(a, b);
  assert.ok(
    bob.state.doc.eq(projected(b.doc(), "first-observation")),
    "remote join matches canonical",
  );
});
test("binding undo preserves a concurrent peer insertion", () => {
  const [a, b] = pair(),
    alice = editor(a),
    bob = editor(b);
  alice.dispatch(alice.state.tr.insertText("quick ", 5));
  bob.dispatch(bob.state.tr.insertText("quiet ", 21));
  synchronize(a, b);
  undo(alice.state, alice.dispatch);
  synchronize(a, b);
  assert.ok(!bob.state.doc.textContent.includes("quick"));
  assert.ok(bob.state.doc.textContent.includes("quiet"));
  redo(alice.state, alice.dispatch);
  synchronize(a, b);
  assert.ok(bob.state.doc.textContent.includes("quick"));
});
