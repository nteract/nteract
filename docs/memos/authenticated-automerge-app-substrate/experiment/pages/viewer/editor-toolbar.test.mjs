import test from "node:test";
import assert from "node:assert/strict";
import { AllSelection, EditorState, NodeSelection, TextSelection } from "prosemirror-state";
import { history } from "prosemirror-history";
import { schema, parseMarkdown, exportMarkdown } from "../model/richtext.mjs";
import { createToolbarCommands, observeToolbar, toolbarSnapshot } from "./editor-toolbar.mjs";

const commands = createToolbarCommands(schema);
function fixture(markdown, observe = () => {}) {
  const plugin = observeToolbar(observe, commands);
  const view = {
    state: EditorState.create({
      schema,
      doc: parseMarkdown(markdown),
      plugins: [history(), plugin],
    }),
    dispatch(tr) {
      this.state = this.state.apply(tr);
      observer.update(this);
    },
  };
  const observer = plugin.spec.view(view);
  return {
    view,
    snapshot: () => toolbarSnapshot(view.state, commands),
    run: (command) => command(view.state, (tr) => view.dispatch(tr)),
    select(from, to = from) {
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
    },
    markdown: () => exportMarkdown(view.state.doc),
  };
}

test("toolbar observes stored-mark-only shortcuts before typing, then cursor mark changes", () => {
  const updates = [];
  const editor = fixture("**Bold** plain", (snapshot) => updates.push(snapshot));
  editor.select(2);
  assert.equal(editor.snapshot().controls.bold.pressed, true);
  const originalDoc = editor.view.state.doc;
  assert.equal(editor.run(commands.bold), true);
  assert.equal(editor.view.state.doc, originalDoc, "a cursor toggle need not change the document");
  assert.equal(
    updates.at(-1).controls.bold.pressed,
    false,
    "an explicit empty storedMarks set overrides marks at the cursor",
  );
  assert.equal(editor.run(commands.bold), true);
  assert.equal(updates.at(-1).controls.bold.pressed, true);
  editor.select(8);
  assert.equal(
    updates.at(-1).controls.bold.pressed,
    false,
    "moving into plain prose clears the active button",
  );
  editor.select(2);
  assert.equal(updates.at(-1).controls.bold.pressed, true);
});

test("range formatting reports mixed marks and updates from remote transactions", () => {
  const updates = [];
  const editor = fixture("**Bold** plain", (snapshot) => updates.push(snapshot));
  editor.select(1, 11);
  assert.equal(editor.snapshot().controls.bold.pressed, "mixed");
  editor.view.dispatch(
    editor.view.state.tr
      .addMark(1, 11, schema.marks.strong.create())
      .setMeta("addToHistory", false),
  );
  assert.equal(updates.at(-1).controls.bold.pressed, true);
  assert.equal(
    updates.at(-1).controls.undo.enabled,
    false,
    "received formatting is not local undo history",
  );
  editor.view.dispatch(
    editor.view.state.tr.removeMark(1, 11, schema.marks.strong).setMeta("addToHistory", false),
  );
  assert.equal(updates.at(-1).controls.bold.pressed, false);
});

test("undo and redo availability follows ProseMirror history, not click counts", () => {
  const editor = fixture("Original");
  assert.equal(editor.snapshot().controls.undo.enabled, false);
  assert.equal(editor.snapshot().controls.redo.enabled, false);
  editor.view.dispatch(editor.view.state.tr.insertText("New ", 1));
  assert.equal(editor.snapshot().controls.undo.enabled, true);
  assert.equal(editor.snapshot().controls.redo.enabled, false);
  assert.equal(editor.run(commands.undo), true);
  assert.equal(editor.markdown(), "Original");
  assert.equal(editor.snapshot().controls.undo.enabled, false);
  assert.equal(editor.snapshot().controls.redo.enabled, true);
  assert.equal(editor.run(commands.redo), true);
  assert.equal(editor.markdown(), "New Original");
  assert.equal(editor.snapshot().controls.redo.enabled, false);
});

test("lists wrap, change kind without nesting, and toggle selected items back to paragraphs", () => {
  const editor = fixture("First\n\nSecond");
  editor.select(1, editor.view.state.doc.content.size - 1);
  assert.equal(editor.run(commands.bullet_list), true);
  assert.equal(editor.snapshot().controls.bullet_list.pressed, true);
  assert.equal(editor.view.state.doc.firstChild.type.name, "bullet_list");
  assert.equal(editor.run(commands.ordered_list), true);
  assert.equal(editor.snapshot().controls.ordered_list.pressed, true);
  assert.equal(editor.snapshot().controls.bullet_list.pressed, false);
  assert.equal(editor.view.state.doc.firstChild.type.name, "ordered_list");
  assert.equal(editor.view.state.doc.firstChild.childCount, 2);
  assert.equal(editor.view.state.doc.firstChild.firstChild.firstChild.type.name, "paragraph");
  assert.equal(editor.run(commands.ordered_list), true);
  assert.equal(editor.snapshot().controls.ordered_list.pressed, false);
  assert.equal(editor.markdown(), "First\n\nSecond");
});

test("turning off one list item preserves the surrounding items and text", () => {
  const editor = fixture("* First\n* Second\n* Third");
  let second;
  editor.view.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === "Second") second = pos;
  });
  editor.select(second + 2);
  assert.equal(editor.run(commands.bullet_list), true);
  assert.deepEqual(
    Array.from(
      { length: editor.view.state.doc.childCount },
      (_, i) => editor.view.state.doc.child(i).type.name,
    ),
    ["bullet_list", "paragraph", "bullet_list"],
  );
  assert.equal(editor.view.state.doc.child(1).textContent, "Second");
  assert.equal(editor.snapshot().controls.bullet_list.pressed, false);
});

test("text-style changes exit quotes in a single undoable transaction", () => {
  const editor = fixture("> A quoted paragraph");
  assert.equal(editor.snapshot().style, "quote");
  assert.equal(editor.run(commands.styles.heading2), true);
  assert.equal(editor.markdown(), "## A quoted paragraph");
  assert.equal(editor.snapshot().style, "heading2");
  assert.equal(editor.run(commands.undo), true);
  assert.equal(editor.markdown(), "> A quoted paragraph");
  assert.equal(editor.snapshot().style, "quote");
  assert.equal(
    editor.snapshot().controls.undo.enabled,
    false,
    "lift and heading change share one history event",
  );
});

test("mixed text styles and code-block command availability are derived from the selection", () => {
  const editor = fixture("# Heading\n\nParagraph");
  editor.select(1, editor.view.state.doc.content.size - 1);
  assert.equal(editor.snapshot().style, "mixed");
  assert.equal(editor.run(commands.styles.code_block), true);
  assert.equal(editor.snapshot().style, "code_block");
  assert.equal(editor.snapshot().controls.bold.enabled, false);
  assert.equal(editor.snapshot().controls.italic.enabled, false);
  assert.equal(editor.snapshot().controls.code.enabled, false);
  assert.equal(editor.run(commands.styles.paragraph), true);
  assert.equal(editor.snapshot().style, "paragraph");
  assert.equal(editor.snapshot().controls.bold.enabled, true);
});

test("capability checks never dispatch live transactions or destroy preserved Markdown atoms", () => {
  const editor = fixture("<custom>Preserve me</custom>");
  editor.view.dispatch(
    editor.view.state.tr.setSelection(NodeSelection.create(editor.view.state.doc, 0)),
  );
  const original = editor.view.state;
  const snapshot = editor.snapshot();
  assert.equal(editor.view.state, original);
  assert.equal(snapshot.controls.bold.enabled, false);
  assert.deepEqual(Object.values(snapshot.styles), [false, false, false, false, false, false]);
  assert.equal(editor.run(commands.styles.paragraph), false);
  assert.equal(editor.markdown(), "<custom>Preserve me</custom>");
});

test("select-all can turn a quoted document into ordinary paragraphs", () => {
  const editor = fixture("> First\n>\n> Second");
  editor.view.dispatch(editor.view.state.tr.setSelection(new AllSelection(editor.view.state.doc)));
  assert.equal(editor.snapshot().style, "quote");
  assert.equal(editor.snapshot().styles.paragraph, true);
  assert.equal(editor.run(commands.styles.paragraph), true);
  assert.equal(editor.markdown(), "First\n\nSecond");
});

test("select-all reflects and toggles an entire list without nesting it", () => {
  const editor = fixture("* First\n* Second");
  editor.view.dispatch(editor.view.state.tr.setSelection(new AllSelection(editor.view.state.doc)));
  assert.equal(editor.snapshot().controls.bullet_list.pressed, true);
  assert.equal(editor.snapshot().controls.bullet_list.enabled, true);
  assert.equal(editor.run(commands.ordered_list), true);
  assert.equal(editor.markdown(), "1. First\n\n2. Second");
  editor.view.dispatch(editor.view.state.tr.setSelection(new AllSelection(editor.view.state.doc)));
  assert.equal(editor.snapshot().controls.ordered_list.pressed, true);
  assert.equal(editor.run(commands.ordered_list), true);
  assert.equal(editor.markdown(), "First\n\nSecond");
});
