import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { Command, setTextblockType, deleteUnit } from "wordgard/command";
import { history, undo } from "wordgard/history";
import { codeBlock } from "wordgard/schema";
import { tables } from "wordgard/table";
import { textPath, blockMarkdown, validateRich } from "../model/richtext.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { schema, decode, encode, CodeBlock, Paragraph } from "./wordgard-model.mjs";
import { createWordgardBinding, wordgardCodeNewlines } from "./wordgard-binding.mjs";
import { exitCodeBlock, trailingLine } from "./wordgard-trailing-line.mjs";

const DOCUMENT = { trailingLine: true };

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Trailing line" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  const id = orderedBlockIds(doc)[0];
  const path = textPath(id);
  let changes = 0;
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      const before = A.getHeads(doc).join();
      doc = A.change(doc, fn);
      if (A.getHeads(doc).join() !== before) changes++;
    },
    observeChange: () => () => {},
  };
  const binding = createWordgardBinding(replica, id, DOCUMENT);
  let state = GardState.create({
    doc: binding.current.doc,
    config: [
      GardState.schemaElement.of(schema.elements),
      codeBlock(),
      tables({ cellContent: "inline", cellSpanning: false }),
      wordgardCodeNewlines,
      trailingLine,
      history(),
    ],
  });
  const editor = {
    get state() {
      return state;
    },
    dispatch(spec) {
      for (const tr of Transaction.append(state.update(spec))) {
        binding.applyEditorTransaction(tr);
        state = tr.state;
      }
      assert.ok(
        decode(A.spans(doc, path), DOCUMENT).doc.eq(state.doc),
        "editor and native document agree",
      );
      validateRich(doc.blocks[id]);
    },
    select(anchor) {
      this.dispatch({ selection: GardSelection.Text.create({ anchor }) });
    },
    type(text) {
      for (const character of text) {
        const { from, to } = state.selection;
        this.dispatch({
          changes: { from, to, insert: [Leaf.text(character, state.sel.activeMarks)] },
          selection: { anchor: from + character.length },
          userEvent: "input.type",
        });
      }
    },
    run(command, param) {
      return Command.dispatch(this, command, param);
    },
  };
  return {
    editor,
    binding,
    markdown: () => blockMarkdown(doc.blocks[id]),
    native: () => A.spans(doc, path),
    changes: () => changes,
  };
}

const types = (doc) => doc.content.map((node) => node.type.name);
const codeEnd = (doc) => {
  let pos = 0;
  for (const node of doc.content) {
    if (node.type === CodeBlock.type) return pos + node.length - 1;
    pos += node.length;
  }
  return -1;
};

test("a final code block, table or preserved block gets an editor-only trailing line", () => {
  for (const markdown of [
    "Intro\n\n```js\nlet x = 1\n```",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "<div>preserved markup</div>",
  ]) {
    const { binding, native, changes } = fixture(markdown);
    const { doc, map } = binding.current;
    assert.equal(types(doc).at(-1), Paragraph.type.name, markdown);
    assert.equal(doc.content.at(-1).content.length, 0, markdown);
    assert.equal(map.trailing, doc.length - 2, markdown);
    // The native end maps before the line, and nothing was written.
    assert.ok(map.amToWg.at(-1) <= map.trailing, markdown);
    assert.equal(changes(), 0, markdown);
    // Without the option (comment editors, the shared codec) nothing changes.
    const plain = decode(native());
    assert.equal(plain.map.trailing, null);
    assert.ok(plain.doc.content.length === doc.content.length - 1, markdown);
    assert.deepEqual(encode(doc, DOCUMENT), encode(plain.doc));
  }
});

test("a final paragraph needs no trailing line", () => {
  const { binding } = fixture("```js\nlet x = 1\n```\n\nAfter");
  assert.deepEqual(types(binding.current.doc), [CodeBlock.type.name, Paragraph.type.name]);
  assert.equal(binding.current.map.trailing, null);
});

test("typing on the trailing line writes one paragraph after the code block", () => {
  const { editor, markdown, changes } = fixture("```js\nlet x = 1\n```");
  // Edits inside the code block leave the trailing line unwritten.
  editor.select(codeEnd(editor.state.doc));
  editor.type(";");
  assert.equal(markdown(), "```js\nlet x = 1;\n```");
  const before = changes();
  editor.select(editor.state.doc.length - 1);
  editor.type("Next");
  assert.equal(markdown(), "```js\nlet x = 1;\n```\n\nNext");
  assert.equal(changes(), before + 4);
  assert.equal(types(editor.state.doc).length, 2, "no second trailing line after a paragraph");
  // Undo takes the paragraph back out of the native document.
  editor.run(undo);
  assert.doesNotMatch(markdown(), /Next/);
  assert.match(markdown(), /```$/);
  assert.equal(types(editor.state.doc).at(-1), Paragraph.type.name);
});

test("deleting the trailing line or making the last paragraph code keeps a line", () => {
  const { editor, markdown } = fixture("Intro\n\nlast");
  const end = editor.state.doc.length - 1;
  editor.select(end);
  editor.run(setTextblockType, CodeBlock);
  assert.deepEqual(types(editor.state.doc), [
    Paragraph.type.name,
    CodeBlock.type.name,
    Paragraph.type.name,
  ]);
  assert.equal(markdown(), "Intro\n\n```\nlast\n```");
  editor.select(editor.state.doc.length - 1);
  editor.run(deleteUnit, "backward");
  assert.equal(types(editor.state.doc).at(-1), Paragraph.type.name);
  assert.equal(markdown(), "Intro\n\n```\nlast\n```");
});

test("Mod-Enter leaves a code block for the trailing line or a new paragraph", () => {
  const final = fixture("```js\nlet x = 1\n```");
  final.editor.select(codeEnd(final.editor.state.doc) - 3);
  assert.equal(final.editor.run(exitCodeBlock), true);
  assert.equal(final.editor.state.selection.head, final.editor.state.doc.length - 1);
  assert.equal(final.markdown(), "```js\nlet x = 1\n```", "moving there writes nothing");
  final.editor.type("Out");
  assert.equal(final.markdown(), "```js\nlet x = 1\n```\n\nOut");

  const middle = fixture("```js\nlet x = 1\n```\n\nAfter");
  middle.editor.select(codeEnd(middle.editor.state.doc));
  assert.equal(middle.editor.run(exitCodeBlock), true);
  middle.editor.type("Between");
  assert.equal(middle.markdown(), "```js\nlet x = 1\n```\n\nBetween\n\nAfter");

  const prose = fixture("Just prose");
  prose.editor.select(3);
  assert.equal(prose.editor.run(exitCodeBlock), false);
});
