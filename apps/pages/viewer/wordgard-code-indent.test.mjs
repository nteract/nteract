import test from "node:test";
import assert from "node:assert/strict";
import { GardSelection } from "wordgard/state";
import { enter } from "wordgard/command";
import { undo } from "wordgard/history";
import * as fixtures from "../test/code-block-fixture.mjs";
import { codeIndentation, dedentCode, indentCode, indentUnit } from "./wordgard-code-indent.mjs";

const fixture = (markdown) => fixtures.fixture(markdown, codeIndentation);
const codeFixture = (language, drawn) => fixtures.codeFixture(language, drawn, codeIndentation);

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
