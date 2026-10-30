import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { GardState, GardSelection } from "wordgard/state";
import { history, undo } from "wordgard/history";
import { Command, insertLineBreak, insertText, toggleMark } from "wordgard/command";
import { enableRich, textPath, blockMarkdown } from "../model/richtext.mjs";
import { schema, decode, Strong } from "./wordgard-model.mjs";
import {
  createWordgardBinding,
  insertPlainLineBreak,
  wordgardCodeNewlines,
} from "./wordgard-binding.mjs";
import { clearHighlight, selectionHighlight, setHighlight, toggleHighlight } from "./highlight.mjs";

function setup(markdown) {
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
      for (const observer of observers)
        observer({
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
    config: [GardState.schemaElement.of(schema.elements), wordgardCodeNewlines, history()],
  });
  const editor = {
    get state() {
      return state;
    },
    select(anchor, head = anchor) {
      state = state.update({ selection: GardSelection.Text.create({ anchor, head }) }).state;
    },
    dispatch(spec) {
      const tr = state.update({ ...spec, annotations: history.isolate.of(true) });
      binding.applyEditorTransaction(tr);
      state = tr.state;
      assert.ok(decode(A.spans(replica.doc, textPath("one"))).doc.eq(state.doc));
    },
  };
  const spans = () =>
    A.spans(replica.doc, textPath("one")).map((span) => [span.value, span.marks ?? {}]);
  return { replica, binding, editor, spans };
}

test("the toolbar highlights, recolors and clears a selection in the native spans", () => {
  const { replica, binding, editor, spans } = setup("alpha **beta** gamma");
  const object = A.getObjectId(replica.doc.blocks.one, "richText");
  editor.select(1, 11);
  assert.equal(Command.dispatch(editor, setHighlight, "yellow"), true);
  assert.deepEqual(spans(), [
    ["alpha ", { highlight: "yellow" }],
    ["beta", { highlight: "yellow", strong: true }],
    [" gamma", {}],
  ]);
  assert.equal(selectionHighlight(editor.state).color, "yellow");
  editor.select(7, 11);
  Command.dispatch(editor, setHighlight, "#1F6FEB");
  assert.deepEqual(spans(), [
    ["alpha ", { highlight: "yellow" }],
    ["beta", { highlight: "#1f6feb", strong: true }],
    [" gamma", {}],
  ]);
  editor.select(1, 11);
  assert.equal(selectionHighlight(editor.state).color, null);
  assert.deepEqual(selectionHighlight(editor.state).colors.sort(), ["#1f6feb", "yellow"]);
  assert.equal(Command.dispatch(editor, clearHighlight), true);
  assert.deepEqual(spans(), [
    ["alpha ", {}],
    ["beta", { strong: true }],
    [" gamma", {}],
  ]);
  assert.equal(A.getObjectId(replica.doc.blocks.one, "richText"), object);
  assert.equal(blockMarkdown(replica.doc.blocks.one), "alpha **beta** gamma");
  editor.dispatch(undo({ state: editor.state }));
  assert.deepEqual(spans()[1], ["beta", { highlight: "#1f6feb", strong: true }]);
  binding.destroy();
});

test("typing at the end of a highlight continues it; the shortcut toggles", () => {
  const { binding, editor, spans } = setup("note");
  editor.select(1, 5);
  Command.dispatch(editor, toggleHighlight, "green");
  editor.select(5);
  Command.dispatch(editor, insertText, { from: 5, to: 5, insert: "s" });
  assert.deepEqual(spans(), [["notes", { highlight: "green" }]]);
  editor.select(1, 6);
  Command.dispatch(editor, toggleHighlight, "green");
  assert.deepEqual(spans(), [["notes", {}]]);
  binding.destroy();
});

test("a collapsed selection sets the highlight for the next typed text", () => {
  const { binding, editor, spans } = setup("ab");
  editor.select(2);
  Command.dispatch(editor, setHighlight, "pink");
  Command.dispatch(editor, insertText, { from: 2, to: 2, insert: "X" });
  assert.deepEqual(spans(), [
    ["a", {}],
    ["X", { highlight: "pink" }],
    ["b", {}],
  ]);
  binding.destroy();
});

function native(spans) {
  let doc = A.change(
    A.from({ blocks: { one: { id: "one", kind: "markdown", markdown: "" } } }),
    (d) => enableRich(d, "one"),
  );
  return A.change(doc, (d) => A.updateSpans(d, textPath("one"), spans));
}
function editorFor(doc) {
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      doc = A.change(doc, fn);
    },
    observeChange: () => () => {},
  };
  const binding = createWordgardBinding(replica, "one");
  let state = GardState.create({
    doc: binding.current.doc,
    config: [GardState.schemaElement.of(schema.elements), wordgardCodeNewlines, history()],
  });
  const editor = {
    get state() {
      return state;
    },
    select(anchor, head = anchor) {
      state = state.update({ selection: GardSelection.Text.create({ anchor, head }) }).state;
    },
    dispatch(spec) {
      const tr = state.update(spec);
      binding.applyEditorTransaction(tr);
      state = tr.state;
      assert.ok(decode(A.spans(replica.doc, textPath("one"))).doc.eq(state.doc));
    },
  };
  const spans = () =>
    A.spans(replica.doc, textPath("one"))
      .filter((span) => span.type === "text")
      .map((span) => [span.value, span.marks ?? {}]);
  return { binding, editor, spans };
}

test("typing at either edge of a foreign-marked run leaves the new text unmarked", () => {
  for (const [at, expected] of [
    [
      1,
      [
        ["X", {}],
        ["mid", { underline: true }],
      ],
    ],
    [
      4,
      [
        ["mid", { underline: true }],
        ["X", {}],
      ],
    ],
  ]) {
    const doc = native([{ type: "text", value: "mid", marks: { underline: true } }]);
    const { binding, editor, spans } = editorFor(doc);
    editor.select(at);
    Command.dispatch(editor, insertText, { from: at, to: at, insert: "X" });
    assert.deepEqual(spans(), expected, `typed at ${at}`);
    binding.destroy();
  }
});

test("code text stays unformatted through toolbar marks and structural edits", () => {
  const code = {
    type: "block",
    value: { type: "code-block", parents: [], attrs: { params: "" }, isEmbed: false },
  };
  const { binding, editor, spans } = editorFor(native([code, { type: "text", value: "one\ntwo" }]));
  const end = editor.state.doc.length - 1;
  editor.select(1, end);
  Command.dispatch(editor, setHighlight, "green");
  Command.dispatch(editor, toggleMark, Strong);
  assert.deepEqual(spans(), [["one\ntwo", {}]]);
  editor.select(end);
  Command.dispatch(editor, insertLineBreak);
  Command.dispatch(editor, insertText, { from: end + 1, to: end + 1, insert: "three" });
  assert.deepEqual(spans(), [["one\ntwo\nthree", {}]]);
  binding.destroy();
});

test("marks a writer left on code text are not decoded", () => {
  const code = {
    type: "block",
    value: { type: "code-block", parents: [], attrs: { params: "" }, isEmbed: false },
  };
  const { doc } = decode([
    code,
    { type: "text", value: "a\nb", marks: { highlight: "green", strong: true } },
  ]);
  assert.ok(doc.content[0].content.every((node) => !node.marks.length));
});

test("Shift+Enter inside bold prose inserts an unmarked break and keeps bold for typing", () => {
  const { binding, editor, spans } = editorFor(
    native([{ type: "text", value: "bold", marks: { strong: true } }]),
  );
  editor.select(3);
  assert.equal(Command.dispatch(editor, insertPlainLineBreak), true);
  const at = editor.state.selection.head;
  Command.dispatch(editor, insertText, { from: at, to: at, insert: "X" });
  assert.deepEqual(spans(), [
    ["bo", { strong: true }],
    ["Xld", { strong: true }],
  ]);
  binding.destroy();
});
