import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { GardState, Transaction } from "wordgard/state";
import { Command, enter, toggleList } from "wordgard/command";
import { bulletList, orderedList } from "wordgard/schema";
import { history, undo, redo } from "wordgard/history";
import { textPath, blockMarkdown, validateRich } from "../model/richtext.mjs";
import { richFromSource } from "../model/richtext-test-support.mjs";
import {
  schema,
  TaskList,
  TaskChecked,
  ListItem,
  BulletList,
  Paragraph,
} from "./wordgard-model.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import { indentTask, outdentTask, taskLists, toggleTaskItem } from "./wordgard-task-lists.mjs";

const path = textPath("one");

function fixture(markdown, readOnly = false) {
  let doc = A.change(A.from({ blocks: { one: { markdown } } }), (d) => richFromSource(d, "one"));
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

test("indenting and outdenting a checked task preserve its subtree, caret and native text identity", () => {
  for (const nested of ["", "  - [x] Earlier child\n"]) {
    const source = "- [ ] Parent\n" + nested + "- [x] Move me\n  - [ ] Grandchild\n- [ ] Later";
    const { binding, editor, replica } = fixture(source);
    const original = editor.state.doc;
    const caret = textPosition(original, "Move me") + 3;
    editor.dispatch({ selection: { anchor: caret } });
    const cursor = A.getCursor(replica.doc, path, binding.current.map.wgToAm[caret]);

    assert.equal(Command.dispatch(editor, indentTask), true);
    const [parent, later] = editor.state.doc.content[0].content;
    assert.equal(later.textContent(), "Later");
    const moved = parent.content.at(-1).content.at(-1);
    assert.equal(moved.mark(TaskChecked), true);
    assert.equal(moved.content[1].content[0].textContent(), "Grandchild");
    assert.equal(parent.content.at(-1).content.length, nested ? 2 : 1);
    const movedCaret = editor.state.selection.head;
    assert.equal(movedCaret, textPosition(editor.state.doc, "Move me") + 3);
    assert.equal(
      A.getCursorPosition(replica.doc, path, cursor),
      binding.current.map.wgToAm[movedCaret],
    );
    assert.equal(Command.dispatch(editor, outdentTask), true);
    assert.ok(editor.state.doc.eq(original));
    assert.equal(editor.state.selection.head, caret);
    binding.destroy();
  }
});

test("outdenting a middle task keeps later children in reading order", () => {
  const { editor, binding } = fixture(
    "- [ ] Parent\n  - [ ] First\n  - [x] Middle\n    - [x] Grandchild\n  - [ ] Last",
  );
  editor.dispatch({ selection: { anchor: textPosition(editor.state.doc, "Middle") } });
  assert.equal(Command.dispatch(editor, outdentTask), true);
  const [parent, middle] = editor.state.doc.content[0].content;
  assert.equal(parent.content[1].textContent(), "First");
  assert.equal(middle.mark(TaskChecked), true);
  assert.deepEqual(
    middle.content[1].content.map((child) => child.textContent()),
    ["Grandchild", "Last"],
  );
  binding.destroy();
});

test("Tab falls through on the first sibling, at the top level, and outside an editable task label", () => {
  for (const [source, label, readOnly] of [
    ["- [ ] First", "First", false],
    ["- [ ] First\n- [x] Second", "Second", true],
    ["- Ordinary\n- Bullet", "Bullet", false],
    ["- Ordinary\n  - [x] Nested", "Nested", false],
    ["- [ ] First\n- [x] Second\n\n  Notes", "Notes", false],
  ]) {
    const { binding, editor } = fixture(source, readOnly);
    editor.dispatch({ selection: { anchor: textPosition(editor.state.doc, label) } });
    assert.equal(Command.dispatch(editor, indentTask), false);
    assert.equal(Command.dispatch(editor, outdentTask), false);
    binding.destroy();
  }
});

test("outdent keeps native text positions when parent notes follow a nested list", () => {
  for (const following of ["", "  - [ ] Sibling\n"]) {
    const { editor, binding, replica } = fixture(
      "- [ ] Parent\n  - [x] Child\n" + following + "\n  Parent notes\n- [ ] Next",
    );
    const before = A.getHeads(replica.doc);
    editor.dispatch({ selection: { anchor: textPosition(editor.state.doc, "Child") + 2 } });
    assert.equal(Command.dispatch(editor, outdentTask), false);
    assert.deepEqual(A.getHeads(replica.doc), before);
    binding.destroy();
  }
});
