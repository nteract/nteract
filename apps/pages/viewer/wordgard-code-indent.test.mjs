import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { GardState, GardSelection, Transaction } from "wordgard/state";
import { Command, enter } from "wordgard/command";
import { history, undo } from "wordgard/history";
import { codeBlock } from "wordgard/schema";
import { textPath, blockMarkdown, validateRich } from "../model/richtext.mjs";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { schema, decode, CodeBlockLanguage } from "./wordgard-model.mjs";
import { createWordgardBinding, wordgardCodeNewlines } from "./wordgard-binding.mjs";
import { codeIndentation, dedentCode, indentCode, indentUnit } from "./wordgard-code-indent.mjs";

// A fixture reads and writes a code block as its source with the selection
// drawn in: ▮ is a caret, « and » are a selection's anchor and head.
const MARKS = /[▮«»]/g;

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Code indent" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  const id = orderedBlockIds(doc)[0];
  const path = textPath(id);
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      doc = A.change(doc, fn);
    },
    observeChange: () => () => {},
  };
  const binding = createWordgardBinding(replica, id);
  let state = GardState.create({
    doc: binding.current.doc,
    config: [
      GardState.schemaElement.of(schema.elements),
      codeBlock(),
      codeIndentation,
      wordgardCodeNewlines,
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
      assert.ok(decode(A.spans(doc, path)).doc.eq(state.doc), "editor and native agree");
      validateRich(doc.blocks[id]);
    },
    run(command) {
      return Command.dispatch(this, command);
    },
  };
  const source = (node) =>
    node.content.map((child) => (child.isText ? String(child.param) : "\n")).join("");
  return {
    editor,
    markdown: () => blockMarkdown(doc.blocks[id]),
    outline: () => state.doc.content.map((node) => [node.type.name, source(node)]),
    language: (index) => state.doc.content[index].mark(CodeBlockLanguage),
    /** The first node's source, with the selection drawn in. */
    code() {
      const text = source(state.doc.content[0]);
      const { anchor, head } = state.selection;
      const marks =
        anchor === head
          ? [[head - 1, "▮"]]
          : [
              [anchor - 1, "«"],
              [head - 1, "»"],
            ];
      return marks
        .sort((a, b) => b[0] - a[0])
        .reduce((out, [at, mark]) => out.slice(0, at) + mark + out.slice(at), text);
    },
    destroy: () => binding.destroy(),
  };
}

/** A code block in `language` holding `drawn`, with its selection set. */
function codeFixture(language, drawn) {
  const f = fixture("```" + language + "\n" + drawn.replace(MARKS, "") + "\n```");
  const caret = drawn.indexOf("▮");
  const anchor = caret < 0 ? drawn.replace("»", "").indexOf("«") : caret;
  const head = caret < 0 ? drawn.replace("«", "").indexOf("»") : caret;
  // The code block is the first node, so its content starts at position 1.
  f.editor.dispatch({
    selection: GardSelection.Text.create({ anchor: anchor + 1, head: head + 1 }),
  });
  assert.equal(f.code(), drawn, "the fixture draws its own selection");
  return f;
}

test("one level is four spaces for Python and Rust, two elsewhere, a tab where the block uses tabs", () => {
  assert.equal(indentUnit("x = 1", "python"), "    ");
  assert.equal(indentUnit("x = 1", "Python title=demo"), "    ");
  assert.equal(indentUnit("fn main() {}", "rs"), "    ");
  assert.equal(indentUnit("let x", "javascript"), "  ");
  assert.equal(indentUnit("plain", ""), "  ");
  assert.equal(indentUnit("plain", undefined), "  ");
  assert.equal(indentUnit("all:\n\tmake", "python"), "\t");
  // A tab inside a line is not indentation.
  assert.equal(indentUnit("a\tb", "python"), "    ");
});

test("Tab at a caret adds spaces up to the next indentation column", () => {
  const cases = [
    ["python", "▮x = 1", "    ▮x = 1"],
    ["python", "if x:\n▮", "if x:\n    ▮"],
    ["python", "ab▮", "ab  ▮"],
    ["python", "     ▮x", "        ▮x"],
    ["javascript", "a▮", "a ▮"],
    ["javascript", "ab▮c", "ab  ▮c"],
    ["", "▮", "  ▮"],
    // The first line is empty: its column is 0, not one before the break.
    ["javascript", "▮\nx", "  ▮\nx"],
    ["python", "all:\n\tmake\n▮", "all:\n\tmake\n\t▮"],
  ];
  for (const [language, before, after] of cases) {
    const f = codeFixture(language, before);
    assert.equal(f.editor.run(indentCode), true, before);
    assert.equal(f.code(), after, before);
    f.destroy();
  }
});

test("Tab with a selection indents each line it touches that has text", () => {
  const cases = [
    // A selection inside one line indents the line and keeps the selection.
    ["javascript", "a«b»c", "  a«b»c"],
    // An end at the start of a line leaves that line alone.
    ["javascript", "«one\ntwo\n»three", "«  one\n  two\n»three"],
    // Empty lines get no trailing spaces.
    ["python", "d«ef f():\n\n    pass»", "    d«ef f():\n\n        pass»"],
    // A backward selection stays backward.
    ["javascript", "o»ne\ntw«o", "  o»ne\n  tw«o"],
  ];
  for (const [language, before, after] of cases) {
    const f = codeFixture(language, before);
    assert.equal(f.editor.run(indentCode), true, before);
    assert.equal(f.code(), after, before);
    f.destroy();
  }
});

test("Shift-Tab removes one level from each line the selection touches", () => {
  const cases = [
    ["python", "        x▮", "    x▮"],
    ["python", "  x▮", "x▮"],
    ["javascript", "    x▮", "  x▮"],
    ["python", "\t\tx▮", "\tx▮"],
    // A caret inside the removed indentation moves to the start of the line.
    ["python", "  ▮  x", "▮x"],
    ["javascript", "«  one\n    two\nthree»", "«one\n  two\nthree»"],
    ["javascript", "  o»ne\n  tw«o", "o»ne\ntw«o"],
  ];
  for (const [language, before, after] of cases) {
    const f = codeFixture(language, before);
    assert.equal(f.editor.run(dedentCode), true, before);
    assert.equal(f.code(), after, before);
    f.destroy();
  }
});

test("Shift-Tab with nothing to remove keeps the key and changes nothing", () => {
  const f = codeFixture("python", "x = 1▮");
  const before = f.markdown();
  assert.equal(f.editor.run(dedentCode), true);
  assert.equal(f.markdown(), before);
  assert.equal(f.code(), "x = 1▮");
  f.destroy();
});

test("Tab and Shift-Tab leave prose, and a selection that leaves the code, alone", () => {
  const prose = fixture("plain words");
  prose.editor.dispatch({ selection: GardSelection.cursor(3) });
  assert.equal(prose.editor.run(indentCode), false);
  assert.equal(prose.editor.run(dedentCode), false);
  assert.equal(prose.markdown(), "plain words");
  prose.destroy();

  const mixed = fixture("```\n  code\n```\n\nafter");
  mixed.editor.dispatch({
    selection: GardSelection.Text.create({ anchor: 2, head: mixed.editor.state.doc.length - 2 }),
  });
  assert.equal(mixed.editor.run(indentCode), false);
  assert.equal(mixed.editor.run(dedentCode), false);
  assert.equal(mixed.editor.run(enter), true, "Wordgard's Enter still replaces the selection");
  mixed.destroy();
});

test("Enter starts the new line at the indentation before the caret", () => {
  const cases = [
    ["python", "    x = 1▮", "    x = 1\n    ▮"],
    ["python", "    foo▮bar", "    foo\n    ▮bar"],
    ["python", "\tx▮", "\tx\n\t▮"],
    // Only the indentation before the caret is copied, so the text after it
    // stays where it was.
    ["python", "  ▮  x", "  \n  ▮  x"],
    // A selection is replaced by the break.
    ["javascript", "  a«bc»d", "  a\n  ▮d"],
    ["javascript", "  a»bc«d", "  a\n  ▮d"],
    // No indentation: Wordgard's own Enter.
    ["python", "x = 1▮", "x = 1\n▮"],
    ["python", "▮    x", "\n▮    x"],
  ];
  for (const [language, before, after] of cases) {
    const f = codeFixture(language, before);
    assert.equal(f.editor.run(enter), true, before);
    assert.equal(f.code(), after, before);
    f.destroy();
  }
});

test("Enter on a line of only indentation leaves an empty line above it", () => {
  const f = codeFixture("python", "def f():\n    x = 1\n    ▮");
  f.editor.run(enter);
  assert.equal(f.code(), "def f():\n    x = 1\n\n    ▮");
  f.destroy();
});

test("three Enters after an indented line leave the code block", () => {
  const f = codeFixture("python", "def f():\n    x = 1▮");
  f.editor.run(enter);
  f.editor.run(enter);
  f.editor.run(enter);
  assert.deepEqual(f.outline(), [
    ["CodeBlock", "def f():\n    x = 1"],
    ["Paragraph", ""],
  ]);
  assert.equal(f.markdown(), "```python\ndef f():\n    x = 1\n```");
  // The caret is in the new paragraph.
  const paragraph = f.editor.state.sel.head.textblockParent;
  assert.equal(paragraph.node.type.name, "Paragraph");
  f.editor.run(undo);
  assert.equal(f.code(), "def f():\n    x = 1\n\n    ▮");
  f.destroy();
});

test("leaving from the middle of a block splits it and keeps its language", () => {
  const f = codeFixture("python", "a = 1\n\n    ▮\nb = 2");
  f.editor.run(enter);
  assert.deepEqual(f.outline(), [
    ["CodeBlock", "a = 1"],
    ["Paragraph", ""],
    ["CodeBlock", "b = 2"],
  ]);
  assert.equal(f.language(0), "python");
  assert.equal(f.language(2), "python");
  f.destroy();
});

test("indenting is one undo step", () => {
  const f = codeFixture("javascript", "«one\ntwo»");
  const before = f.markdown();
  f.editor.run(indentCode);
  assert.equal(f.markdown(), "```javascript\n  one\n  two\n```");
  f.editor.run(undo);
  assert.equal(f.markdown(), before);
  f.destroy();
});
