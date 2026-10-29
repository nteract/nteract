import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { GardState, Transaction } from "wordgard/state";
import { Command, enter, toggleList } from "wordgard/command";
import { bulletList, orderedList } from "wordgard/schema";
import { history, undo, redo } from "wordgard/history";
import { enableRich, textPath, blockMarkdown, validateRich } from "../model/richtext.mjs";
import {
  schema,
  TaskList,
  TaskChecked,
  ListItem,
  BulletList,
  Paragraph,
} from "./wordgard-model.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { taskLists, toggleTaskItem } from "./wordgard-task-lists.mjs";

const path = textPath("one");

function fixture(markdown, readOnly = false) {
  let doc = A.change(A.from({ blocks: { one: { id: "one", kind: "markdown", markdown } } }), (d) =>
    enableRich(d, "one"),
  );
  const observers = new Set();
  const publish = (before, remote) => {
    for (const listener of observers) listener({ remote, patchInfo: { before, after: doc } });
  };
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      const before = doc;
      doc = A.change(doc, fn);
      publish(before, false);
    },
    receive(remote) {
      const before = doc;
      doc = A.merge(doc, remote);
      publish(before, true);
    },
    observeChange(listener) {
      observers.add(listener);
      return () => observers.delete(listener);
    },
  };
  const binding = createWordgardBinding(replica, "one");
  let state = GardState.create({
    doc: binding.current.doc,
    config: [
      GardState.schemaElement.of(schema.elements),
      GardState.readOnly.of(readOnly),
      bulletList(),
      orderedList(),
      taskLists(),
      history(),
    ],
  });
  binding.observe((event) => {
    if (event.remote)
      state = state.update({
        changes: event.changes,
        annotations: [Transaction.remote.of(true), Transaction.addToHistory.of(false)],
      }).state;
  });
  const editor = {
    get state() {
      return state;
    },
    get editable() {
      return !state.readOnly;
    },
    dispatch(spec) {
      for (const tr of Transaction.append(state.update(spec))) {
        binding.applyEditorTransaction(tr);
        state = tr.state;
        assert.ok(binding.current.doc.eq(state.doc), "editor and native document agree");
      }
      validateRich(doc.blocks.one);
    },
    focus() {},
  };
  return { replica, binding, editor };
}

function textPosition(doc, text) {
  let found;
  doc.iterate((node, position) => {
    if (node.isText && String(node.param).includes(text))
      found = position + String(node.param).indexOf(text);
  });
  assert.notEqual(found, undefined, text);
  return found;
}

function items(doc) {
  const result = [];
  doc.iterate((node, position) => {
    if (node.type === ListItem.type) result.push({ node, position });
  });
  return result;
}

test("checking an item preserves the text object and unaffected character identities", () => {
  const { replica, binding, editor } = fixture("- [ ] Review design\n- [ ] Keep 🌊 notes");
  const object = A.getObjectId(replica.doc.blocks.one, "richText");
  const nativeOffset = binding.current.map.wgToAm[textPosition(editor.state.doc, "Keep 🌊")];
  const cursor = A.getCursor(replica.doc, path, nativeOffset);
  const first = items(editor.state.doc)[0];
  assert.equal(toggleTaskItem(editor, first.position), true);
  assert.equal(items(editor.state.doc)[0].node.mark(TaskChecked), true);
  assert.equal(A.getObjectId(replica.doc.blocks.one, "richText"), object);
  assert.equal(
    replica.doc.blocks.one.richText[A.getCursorPosition(replica.doc, path, cursor)],
    "K",
  );
  assert.match(blockMarkdown(replica.doc.blocks.one), /\[x\] Review design/);
  assert.match(blockMarkdown(replica.doc.blocks.one), /\[ \] Keep 🌊 notes/);
  binding.destroy();
});

test("a concurrent checkbox toggle and text edit merge, and local undo retains the remote prose", () => {
  const { replica, binding, editor } = fixture("- [ ] Review design");
  const text = binding.current.map.wgToAm[textPosition(editor.state.doc, "Review design")];
  const remote = A.change(A.clone(replica.doc), (d) => A.splice(d, path, text, 0, "Together: "));
  assert.equal(toggleTaskItem(editor, items(editor.state.doc)[0].position), true);
  const local = A.clone(replica.doc);
  replica.receive(remote);
  assert.equal(items(editor.state.doc)[0].node.mark(TaskChecked), true);
  assert.equal(editor.state.doc.textContent(), "Together: Review design");
  assert.deepEqual(A.getHeads(replica.doc), A.getHeads(A.merge(remote, local)));
  assert.equal(Command.dispatch(editor, undo), true);
  assert.equal(items(editor.state.doc)[0].node.mark(TaskChecked), false);
  assert.equal(editor.state.doc.textContent(), "Together: Review design");
  assert.equal(Command.dispatch(editor, redo), true);
  assert.equal(items(editor.state.doc)[0].node.mark(TaskChecked), true);
  assert.equal(editor.state.doc.textContent(), "Together: Review design");
  binding.destroy();
});

test("Enter after a checked item starts unchecked, and Enter on that empty item exits the list", () => {
  const { binding, editor } = fixture("- [x] Done");
  editor.dispatch({ selection: { anchor: textPosition(editor.state.doc, "Done") + 4 } });
  assert.equal(Command.dispatch(editor, enter), true);
  assert.deepEqual(
    items(editor.state.doc).map(({ node }) => node.mark(TaskChecked)),
    [true, false],
  );
  assert.equal(Command.dispatch(editor, enter), true);
  assert.equal(editor.state.doc.content[0].type, TaskList.type);
  assert.equal(items(editor.state.doc).length, 1);
  assert.equal(editor.state.doc.content[1].type, Paragraph.type);
  assert.equal(editor.state.doc.content[1].textContent(), "");
  binding.destroy();
});

test("toolbar conversion removes checkbox state from bullets and restores unchecked task items", () => {
  const { binding, editor } = fixture("- [x] First\n- [ ] Second");
  editor.dispatch({
    selection: {
      anchor: textPosition(editor.state.doc, "First"),
      head: textPosition(editor.state.doc, "Second") + 6,
    },
  });
  assert.equal(Command.dispatch(editor, toggleList, BulletList), true);
  assert.equal(editor.state.doc.content[0].type, BulletList.type);
  assert.ok(items(editor.state.doc).every(({ node }) => node.mark(TaskChecked) === undefined));
  assert.equal(Command.dispatch(editor, toggleList, TaskList), true);
  assert.equal(editor.state.doc.content[0].type, TaskList.type);
  assert.ok(items(editor.state.doc).every(({ node }) => node.mark(TaskChecked) === false));
  binding.destroy();
});

test("Markdown task shortcuts create native checkboxes while ordinary prose remains prose", () => {
  for (const [prefix, checked] of [
    ["- [ ] ", false],
    ["* [ ] ", false],
    ["- [x] ", true],
    ["- [X] ", true],
  ]) {
    const { replica, binding, editor } = fixture("");
    editor.dispatch({ selection: { anchor: 1 } });
    for (const character of prefix + "Ship it") {
      const from = editor.state.selection.head;
      editor.dispatch({
        changes: { from, insert: [Leaf.text(character)] },
        selection: { anchor: from + character.length },
        userEvent: "input.type",
      });
    }
    assert.equal(editor.state.doc.content[0].type, TaskList.type, prefix);
    assert.equal(items(editor.state.doc)[0].node.mark(TaskChecked), checked, prefix);
    assert.equal(editor.state.doc.textContent(), "Ship it", prefix);
    assert.match(
      blockMarkdown(replica.doc.blocks.one),
      checked ? /\[x\] Ship it/ : /\[ \] Ship it/,
    );
    binding.destroy();
  }
  const { binding, editor } = fixture("Discuss [ ] as text");
  assert.equal(editor.state.doc.content[0].type, Paragraph.type);
  binding.destroy();
});

test("read-only task controls reject a toggle without changing document heads", () => {
  const { replica, binding, editor } = fixture("- [ ] Read only", true);
  const heads = A.getHeads(replica.doc);
  assert.equal(toggleTaskItem(editor, items(editor.state.doc)[0].position), false);
  assert.equal(Command.dispatch(editor, toggleList, TaskList), false);
  assert.deepEqual(A.getHeads(replica.doc), heads);
  assert.equal(items(editor.state.doc)[0].node.mark(TaskChecked), false);
  binding.destroy();
});
