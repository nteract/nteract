import test from "node:test";
import assert from "node:assert/strict";
import { GardSelection } from "wordgard/state";
import { undo } from "wordgard/history";
import * as fixtures from "../test/code-block-fixture.mjs";
import { codeComments, commentTokens, toggleCodeComment } from "./wordgard-code-comments.mjs";

const fixture = (markdown) => fixtures.fixture(markdown, codeComments);
const codeFixture = (language, drawn) => fixtures.codeFixture(language, drawn, codeComments);

/** Each case is [language, before, after one toggle]. */
function toggling(cases) {
  for (const [language, before, after] of cases) {
    const f = codeFixture(language, before);
    assert.equal(f.editor.run(toggleCodeComment), true, before);
    assert.equal(f.code(), after, before);
    f.destroy();
  }
}

test("comment tokens come from the highlighter's language data", () => {
  assert.deepEqual(commentTokens("python"), { line: "#" });
  assert.deepEqual(commentTokens("Python title=demo"), { line: "#" });
  assert.equal(commentTokens("javascript").line, "//");
  assert.equal(commentTokens("ts").line, "//");
  assert.equal(commentTokens("rust").line, "//");
  assert.equal(commentTokens("go").line, "//");
  assert.equal(commentTokens("sql").line, "--");
  assert.equal(commentTokens("r").line, "#");
  assert.equal(commentTokens("bash").line, "#");
  assert.equal(commentTokens("yaml").line, "#");
  assert.equal(commentTokens("css").line, undefined);
  assert.deepEqual(commentTokens("css").block, { open: "/*", close: "*/" });
  assert.deepEqual(commentTokens("html"), { block: { open: "<!--", close: "-->" } });
  assert.deepEqual(commentTokens("json"), {});
  assert.deepEqual(commentTokens(""), {});
  assert.deepEqual(commentTokens("mermaid"), {});
});

test("a line gets a comment at its indentation, and the caret keeps its place in the text", () => {
  toggling([
    ["python", "x = 1▮", "# x = 1▮"],
    ["python", "▮x = 1", "# ▮x = 1"],
    ["python", "if x:\n    y▮", "if x:\n    # y▮"],
    ["javascript", "  f(▮)", "  // f(▮)"],
    ["sql", "select 1▮", "-- select 1▮"],
    // A blank line on its own gets one too.
    ["python", "▮", "# ▮"],
  ]);
});

test("a commented line loses the token and one space after it", () => {
  toggling([
    ["python", "# x = 1▮", "x = 1▮"],
    ["python", "#x = 1▮", "x = 1▮"],
    ["python", "    #  y▮", "     y▮"],
    ["javascript", "// ▮f()", "▮f()"],
    // A caret inside the token moves to where it was.
    ["python", "#▮ x", "▮x"],
  ]);
});

test("lines get comments at their smallest indentation, skipping blank lines", () => {
  toggling([
    [
      "python",
      "«def f():\n    x = 1\n\n    return x»",
      "# «def f():\n#     x = 1\n\n#     return x»",
    ],
    ["python", "    «a\n      b»", "    # «a\n    #   b»"],
    // A selection that ends at the start of a line leaves that line alone.
    ["python", "«a\n»b", "# «a\n»b"],
    // One line without a comment comments every line.
    ["python", "«# a\nb»", "# «# a\n# b»"],
    // A backward selection stays backward.
    ["javascript", "a»b\nc«d", "// a»b\n// c«d"],
  ]);
});

test("lines that all have comments lose them", () => {
  toggling([
    ["python", "«# a\n  # b»", "«a\n  b»"],
    ["python", "«# a\n\n# b»", "«a\n\nb»"],
    ["javascript", "  // o«ne\n  // two»", "  o«ne\n  two»"],
  ]);
});

test("CSS and HTML lines get one block comment around them", () => {
  toggling([
    ["css", "«a {}\nb {}»", "«/* a {}\nb {}» */"],
    ["css", "«/* a {}\nb {} */»", "«a {}\nb {}»"],
    ["css", "  «a {}»", "  «/* a {}» */"],
    ["html", "<p>x▮</p>", "<!-- <p>x▮</p> -->"],
    ["html", "<!--<p>x▮</p>-->", "<p>x▮</p>"],
    // An empty comment's one space goes once.
    ["css", "/* */▮", "▮"],
    ["html", "«<!-- -->»", "▮"],
    // Delimiters on their own lines around the touched lines.
    ["css", "/*\na▮\n*/", "a▮"],
    ["css", "/*\n  «a {}\n  b {}»\n*/", "  «a {}\n  b {}»"],
    ["html", "<!--\n<p>x▮</p>\n-->", "<p>x▮</p>"],
    // The whole comment selected, delimiters on their own lines.
    ["css", "«/*\na\n*/»", "«a»"],
  ]);
});

test("toggling twice restores the source", () => {
  for (const [language, drawn] of [
    ["python", "«def f():\n    x = 1\n\n    return x»"],
    ["javascript", "  «a\n    b»"],
    ["css", "«a {}\nb {}»"],
  ]) {
    const f = codeFixture(language, drawn);
    const before = f.markdown();
    f.editor.run(toggleCodeComment);
    f.editor.run(toggleCodeComment);
    assert.equal(f.markdown(), before, drawn);
    f.destroy();
  }
});

test("a code block with no comment syntax keeps the key and changes nothing", () => {
  for (const language of ["json", "", "mermaid"]) {
    const f = codeFixture(language, "{}▮");
    const before = f.markdown();
    assert.equal(f.editor.run(toggleCodeComment), true, language);
    assert.equal(f.markdown(), before, language);
    f.destroy();
  }
});

test("prose, and a selection that leaves the code, are left alone", () => {
  const prose = fixture("plain words");
  prose.editor.dispatch({ selection: GardSelection.cursor(3) });
  assert.equal(prose.editor.run(toggleCodeComment), false);
  assert.equal(prose.markdown(), "plain words");
  prose.destroy();

  const mixed = fixture("```python\nx = 1\n```\n\nafter");
  mixed.editor.dispatch({
    selection: GardSelection.Text.create({ anchor: 2, head: mixed.editor.state.doc.length - 2 }),
  });
  assert.equal(mixed.editor.run(toggleCodeComment), false);
  mixed.destroy();
});

test("each toggle is its own undo step", () => {
  const f = codeFixture("python", "«a\nb»");
  f.editor.run(toggleCodeComment);
  f.editor.run(toggleCodeComment);
  f.editor.run(toggleCodeComment);
  assert.equal(f.markdown(), "```python\n# a\n# b\n```");
  f.editor.run(undo);
  assert.equal(f.markdown(), "```python\na\nb\n```");
  f.editor.run(undo);
  assert.equal(f.markdown(), "```python\n# a\n# b\n```");
  f.destroy();
});
