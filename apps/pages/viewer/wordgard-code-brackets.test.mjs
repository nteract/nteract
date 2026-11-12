import test from "node:test";
import assert from "node:assert/strict";
import { Leaf } from "wordgard/doc";
import { GardSelection } from "wordgard/state";
import { deleteUnit, insertText } from "wordgard/command";
import { undo } from "wordgard/history";
import * as fixtures from "../test/code-block-fixture.mjs";
import { bracketConfig, codeBrackets } from "./wordgard-code-brackets.mjs";

const fixture = (markdown) => fixtures.fixture(markdown, codeBrackets);
const codeFixture = (language, drawn) => fixtures.codeFixture(language, drawn, codeBrackets);

/** Type `text` one character at a time over the selection, as a keyboard
 * does. */
function type(f, text, userEvent = "input.type") {
  for (const insert of text) {
    const { from, to } = f.editor.state.selection;
    f.editor.run(insertText, { from, to, insert, userEvent });
  }
}

/** Each case is [language, before, typed, after]. */
function typing(cases) {
  for (const [language, before, text, after] of cases) {
    const f = codeFixture(language, before);
    type(f, text);
    assert.equal(f.code(), after, `${JSON.stringify(text)} in ${before}`);
    f.destroy();
  }
}

test("brackets come from the highlighter's language data", () => {
  assert.deepEqual(bracketConfig("python").brackets, ["(", "[", "{", "'", '"', "'''", '"""']);
  assert.ok(bracketConfig("python").prefixes.includes("f"));
  assert.deepEqual(bracketConfig("javascript").brackets, ["(", "[", "{", "'", '"', "`"]);
  assert.equal(bracketConfig("r").wordChars, ".");
  // Rust's ' is a lifetime or a char.
  assert.deepEqual(bracketConfig("rust").brackets, ["(", "[", "{", '"']);
  assert.deepEqual(bracketConfig("").brackets, ["(", "[", "{", "'", '"']);
  assert.deepEqual(bracketConfig("mermaid").brackets, ["(", "[", "{", "'", '"']);
});

test("an opener before whitespace, a closer or the line's end inserts the pair", () => {
  typing([
    ["python", "▮", "(", "(▮)"],
    ["python", "print▮", "(", "print(▮)"],
    ["python", "a ▮ b", "[", "a [▮] b"],
    ["python", "▮\nnext", "{", "{▮}\nnext"],
    ["javascript", "x = ▮;", "{", "x = {▮};"],
    ["javascript", "f(▮)", "[", "f([▮])"],
    ["python", "((▮", "((", "((((▮))"],
  ]);
});

test("an opener before a word character inserts only itself", () => {
  typing([
    ["python", "▮x", "(", "(▮x"],
    ["python", "▮_x", "[", "[▮_x"],
    ["javascript", "▮'a'", "(", "(▮'a'"],
  ]);
});

test("typing an inserted closer moves over it", () => {
  typing([
    ["python", "▮", "()", "()▮"],
    ["python", "f▮", "(x)", "f(x)▮"],
    ["python", "▮", "([{}])", "([{}])▮"],
    ["python", "▮", '""', '""▮'],
    // A closer someone typed is never passed over.
    ["python", "f(▮)", ")", "f()▮)"],
    // Another closer inserts itself.
    ["python", "(▮)", "]", "(]▮)"],
  ]);
});

test("an inserted closer is forgotten when the caret leaves its line", () => {
  const f = codeFixture("python", "▮\nnext");
  type(f, "(");
  f.editor.dispatch({ selection: GardSelection.cursor(5) });
  f.editor.dispatch({ selection: GardSelection.cursor(2) });
  assert.equal(f.code(), "(▮)\nnext");
  type(f, ")");
  assert.equal(f.code(), "()▮)\nnext");
  f.destroy();
});

test("an inserted closer is still passed over after an edit before it", () => {
  const f = codeFixture("python", "▮");
  type(f, "f(");
  // Text added at the start of the line, as a peer's edit would be.
  f.editor.dispatch({ changes: { from: 1, insert: [Leaf.text("x = ")] } });
  assert.equal(f.code(), "x = f(▮)");
  type(f, ")");
  assert.equal(f.code(), "x = f()▮");
  f.destroy();
});

test("a quote pairs where a string can start", () => {
  typing([
    ["python", "x = ▮", '"', 'x = "▮"'],
    ["python", "x = ▮", "'", "x = '▮'"],
    ["python", "(▮)", "'", "('▮')"],
    // After a word character it is an apostrophe or a closing quote.
    ["python", "# don▮", "'", "# don'▮"],
    // Python's string prefixes start a string.
    ["python", "f▮", '"', 'f"▮"'],
    ["python", "rb▮", "'", "rb'▮'"],
    ["javascript", "f▮", '"', 'f"▮'],
    // A quote that closes an open string on the line inserts only itself.
    ["python", "x = 'abc▮", "'", "x = 'abc'▮"],
    ["python", "x = 'it\\'s ▮", "'", "x = 'it\\'s '▮"],
    // Before a word character.
    ["python", "▮abc", '"', '"▮abc'],
    // Language lists: JavaScript pairs backticks, Python doesn't, Rust leaves '.
    ["javascript", "▮", "`", "`▮`"],
    ["python", "▮", "`", "`▮"],
    ["rust", "fn f<▮", "'", "fn f<'▮"],
    ["rust", "let s = ▮", '"', 'let s = "▮"'],
  ]);
});

test("a third quote opens a triple-quoted string in Python", () => {
  typing([
    ["python", "▮", '"""', '"""▮"""'],
    ["python", "x = ▮", "'''", "x = '''▮'''"],
    // One quote moves over all three closing quotes, as in CodeMirror.
    ["python", "▮", '"""doc"', '"""doc"""▮'],
    // JavaScript has no triple quotes: the third quote starts another pair.
    ["javascript", "▮", '"""', '"""▮"'],
  ]);
});

test("a selection is wrapped and stays on the same text", () => {
  typing([
    ["javascript", "«abc»", "(", "(«abc»)"],
    ["javascript", "»abc«", "[", "[»abc«]"],
    ["python", "x = «name»", '"', 'x = "«name»"'],
    ["python", "«a\nb»", "{", "{«a\nb»}"],
  ]);
});

test("Backspace between an empty pair deletes both", () => {
  const cases = [
    ["python", "(▮)", "▮"],
    ["python", "f[▮]", "f▮"],
    ["python", '"▮"', "▮"],
    ["javascript", "`▮`", "▮"],
    // Anything else is Wordgard's Backspace.
    ["python", "(▮x)", "▮x)"],
    ["python", "(x▮)", "(▮)"],
    ["python", "(▮]", "▮]"],
    ["rust", "'▮'", "▮'"],
  ];
  for (const [language, before, after] of cases) {
    const f = codeFixture(language, before);
    assert.equal(f.editor.run(deleteUnit, "backward"), true, before);
    assert.equal(f.code(), after, before);
    f.destroy();
  }
});

test("prose, composition and pasted text are left to Wordgard", () => {
  const prose = fixture("plain words");
  prose.editor.dispatch({ selection: GardSelection.cursor(6) });
  type(prose, "(");
  assert.equal(prose.markdown(), "plain( words");
  prose.destroy();

  const composing = codeFixture("python", "▮");
  type(composing, "(", "input.type.compose");
  assert.equal(composing.code(), "(▮");
  composing.destroy();

  const pasted = codeFixture("python", "▮");
  pasted.editor.run(insertText, { from: 1, to: 1, insert: "(a", userEvent: "input.type" });
  assert.equal(pasted.code(), "(a▮");
  pasted.destroy();
});

test("a pair inserts and wraps in one undo step", () => {
  const f = codeFixture("python", "x = «name»");
  type(f, "(");
  assert.equal(f.markdown(), "```python\nx = (name)\n```");
  f.editor.run(undo);
  assert.equal(f.markdown(), "```python\nx = name\n```");
  f.destroy();
});
