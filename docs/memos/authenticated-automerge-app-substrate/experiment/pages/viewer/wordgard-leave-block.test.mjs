import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { Leaf } from "wordgard/doc";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { Command } from "wordgard/command";
import { history, undo } from "wordgard/history";
import { codeBlock } from "wordgard/schema";
import { tables } from "wordgard/table";
import { textPath, blockMarkdown, validateRich } from "../model/richtext.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { schema, decode, CodeBlock, CodeBlockLanguage, Paragraph } from "./wordgard-model.mjs";
import { createWordgardBinding, wordgardCodeNewlines } from "./wordgard-binding.mjs";
import { exitBlock, finalBlock, leaveFinalBlock } from "./wordgard-leave-block.mjs";

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Leave block" }));
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
  const binding = createWordgardBinding(replica, id);
  let state = GardState.create({
    doc: binding.current.doc,
    config: [
      GardState.schemaElement.of(schema.elements),
      codeBlock(),
      tables({ cellContent: "inline", cellSpanning: false }),
      wordgardCodeNewlines,
      history(),
    ],
  });
  const editor = {
    // Vertical motion needs layout; tests say where ArrowDown would land.
    nextLine: null,
    moveVertically() {
      return this.nextLine === null ? null : GardSelection.cursor(this.nextLine);
    },
    get state() {
      return state;
    },
    dispatch(spec) {
      for (const tr of Transaction.append(state.update(spec))) {
        binding.applyEditorTransaction(tr);
        state = tr.state;
      }
      assert.ok(decode(A.spans(doc, path)).doc.eq(state.doc), "editor and native agree");
      validateRich(doc.blocks[id]);
    },
    select(anchor, head = anchor) {
      this.dispatch({ selection: GardSelection.Text.create({ anchor, head }) });
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
    run(command) {
      return Command.dispatch(this, command);
    },
  };
  return {
    editor,
    markdown: () => blockMarkdown(doc.blocks[id]),
    types: () => state.doc.content.map((node) => node.type.name),
    changes: () => changes,
  };
}

/** The last text position inside the final node. */
const finalEnd = (doc) => doc.length - 2;
const image = "![Diagram](https://example.invalid/diagram.png)";

test("opening a Page that ends in a code block, table or image writes nothing", () => {
  for (const markdown of [
    "```js\nlet x = 1\n```",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    `Caption ${image}`,
    "<div>preserved markup</div>",
  ]) {
    const f = fixture(markdown);
    assert.ok(finalBlock(f.editor.state.doc), markdown);
    assert.equal(f.changes(), 0, markdown);
  }
  assert.equal(finalBlock(fixture("Just prose").editor.state.doc), null);
});

test("ArrowDown on the last line of a final code block, table or image adds a paragraph", () => {
  for (const [markdown, expected] of [
    ["Intro\n\n```js\nlet x = 1\n```", "Intro\n\n```js\nlet x = 1\n```\n\nAfter"],
    ["| a | b |\n| --- | --- |\n| 1 | 2 |", "| a | b |\n| --- | --- |\n| 1 | 2 |\n\nAfter"],
    [`Caption ${image}`, `Caption ${image}\n\nAfter`],
  ]) {
    const f = fixture(markdown);
    f.editor.select(finalEnd(f.editor.state.doc));
    assert.equal(f.editor.run(leaveFinalBlock), true, markdown);
    assert.equal(f.types().at(-1), Paragraph.type.name, markdown);
    assert.equal(f.editor.state.selection.head, f.editor.state.doc.length - 1, markdown);
    f.editor.type("After");
    assert.equal(f.markdown(), expected);
    // The new line is an ordinary edit: one undo takes the text, the next the line.
    f.editor.run(undo);
    f.editor.run(undo);
    assert.equal(f.markdown(), markdown);
  }
});

test("ArrowDown moves as usual when there is another line, or outside the final node", () => {
  const code = fixture("```js\nlet x = 1\nlet y = 2\n```");
  code.editor.select(3);
  code.editor.nextLine = 14;
  assert.equal(code.editor.run(leaveFinalBlock), false);
  code.editor.nextLine = null;
  code.editor.select(3, 5);
  assert.equal(code.editor.run(leaveFinalBlock), false, "a range selection keeps its default");

  const middle = fixture("```js\nlet x = 1\n```\n\nAfter");
  middle.editor.select(3);
  assert.equal(middle.editor.run(leaveFinalBlock), false);

  const prose = fixture("Just prose");
  prose.editor.select(3);
  assert.equal(prose.editor.run(leaveFinalBlock), false);
  assert.equal(prose.changes(), 0);
});

test("ArrowDown from the added line doesn't add another", () => {
  const f = fixture("```js\nlet x = 1\n```");
  f.editor.select(finalEnd(f.editor.state.doc));
  f.editor.run(leaveFinalBlock);
  const after = f.changes();
  assert.equal(f.editor.run(leaveFinalBlock), false);
  assert.equal(f.changes(), after);
});

test("Mod-Enter leaves a code block for the next empty line or a new paragraph", () => {
  const final = fixture("```js\nlet x = 1\n```");
  final.editor.select(3);
  assert.equal(final.editor.run(exitBlock), true);
  final.editor.type("Out");
  assert.equal(final.markdown(), "```js\nlet x = 1\n```\n\nOut");

  const middle = fixture("```js\nlet x = 1\n```\n\nAfter");
  middle.editor.select(3);
  assert.equal(middle.editor.run(exitBlock), true);
  middle.editor.type("Between");
  assert.equal(middle.markdown(), "```js\nlet x = 1\n```\n\nBetween\n\nAfter");

  // A code block already followed by an empty line moves there and writes nothing.
  const empty = fixture("```js\nlet x = 1\n```");
  empty.editor.select(3);
  empty.editor.run(exitBlock);
  const written = empty.changes();
  empty.editor.select(3);
  assert.equal(empty.editor.run(exitBlock), true);
  assert.equal(empty.editor.state.selection.head, empty.editor.state.doc.length - 1);
  assert.equal(empty.changes(), written);

  const table = fixture("| a | b |\n| --- | --- |\n| 1 | 2 |");
  table.editor.select(5);
  assert.equal(table.editor.run(exitBlock), true);
  assert.equal(table.types().at(-1), Paragraph.type.name);

  const prose = fixture("Just prose");
  prose.editor.select(3);
  assert.equal(prose.editor.run(exitBlock), false);
});

test("a real empty paragraph after a final code block survives a language change", () => {
  const f = fixture("Intro\n\n```js\nlet x = 1\n```");
  f.editor.select(finalEnd(f.editor.state.doc));
  f.editor.run(leaveFinalBlock);
  assert.deepEqual(f.types(), [Paragraph.type.name, CodeBlock.type.name, Paragraph.type.name]);
  const code = f.editor.state.doc.content[0].length;
  const block = f.editor.state.doc.content[1];
  f.editor.dispatch({
    changes: [
      { from: code, remove: CodeBlockLanguage.isInSet(block.tag.marks) },
      { from: code, add: CodeBlockLanguage.of("python") },
    ],
  });
  assert.deepEqual(f.types(), [Paragraph.type.name, CodeBlock.type.name, Paragraph.type.name]);
  assert.equal(f.editor.state.doc.content[1].mark(CodeBlockLanguage), "python");
  // The caret stays on the empty line, and typing there writes after the code.
  f.editor.type("Still here");
  assert.equal(f.markdown(), "Intro\n\n```python\nlet x = 1\n```\n\nStill here");
});
