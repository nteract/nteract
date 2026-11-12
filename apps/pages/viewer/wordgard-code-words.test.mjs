import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import { GardState, GardSelection } from "wordgard/state";
import { codeBlock } from "wordgard/schema";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { schema, CodeBlock } from "./wordgard-model.mjs";
import { createWordgardBinding } from "./wordgard-binding.mjs";
import {
  codeWordAt,
  codeWordBoundary,
  codeWordDeletion,
  codeWordMouseSelection,
  codeWordSelection,
  deleteCodeWord,
  moveByCodeWord,
} from "./wordgard-code-words.mjs";

/** The word at ▮ in `marked`, or null. */
function word(marked, options) {
  const offset = marked.indexOf("▮");
  const source = marked.replace("▮", "");
  const found = codeWordAt(source, offset, options);
  return found && source.slice(found.from, found.to);
}

test("a word is a whole identifier", () => {
  assert.equal(word("CREATE TABLE pages_cat▮alog_tags ("), "pages_catalog_tags");
  assert.equal(word("▮pages_catalog_tags"), "pages_catalog_tags");
  assert.equal(word("pages_catalog_tags▮"), "pages_catalog_tags");
  assert.equal(word("x = __in▮it__(v2)"), "__init__");
  assert.equal(word("total = row_count2▮ + 1"), "row_count2");
  assert.equal(word("naïve_ca▮fé = 1"), "naïve_café");
});

test("punctuation and line ends bound a word", () => {
  assert.equal(word("store.pa▮ges.get(id)"), "pages");
  assert.equal(word("call(▮arg)"), "arg");
  assert.equal(word("call(arg▮)"), "arg");
  assert.equal(word("first\nsec▮ond\nthird"), "second");
  assert.equal(word("first\n▮second"), "second");
  assert.equal(word("first▮\nsecond"), "first");
});

test("no word touches whitespace or punctuation alone", () => {
  assert.equal(word("a = ( ▮ )"), null);
  assert.equal(word("a ==▮= b"), null);
  assert.equal(word("one\n▮\ntwo"), null);
  assert.equal(word("▮"), null);
});

test("a language adds its own identifier characters", () => {
  assert.equal(word("const $sc▮ope = 1", { language: "javascript" }), "$scope");
  assert.equal(word("const $sc▮ope = 1", { language: "tsx" }), "$scope");
  assert.equal(word("echo $HO▮ME", { language: "bash" }), "HOME");
  assert.equal(word("font-si▮ze: 12px", { language: "css" }), "font-size");
  assert.equal(word("  --accent-co▮lor: red", { language: "css" }), "--accent-color");
  assert.equal(word("gh pr create --body-fi▮le x", { language: "bash" }), "file");
  assert.equal(word("total-co▮unt", { language: "python title=x.py" }), "count");
  assert.equal(word("snake_ca▮se", { language: "brainfuck" }), "snake_case");
});

test("a script without spaces keeps its own word boundaries", () => {
  assert.equal(word("# 日本▮語のテキスト"), "日本語");
  assert.equal(word("# 日本語のテ▮キスト"), "テキスト");
  // Between two words, the bias picks one.
  assert.equal(word("# 日本語▮のテキスト", { bias: 1 }), "の");
  assert.equal(word("# 日本語▮のテキスト", { bias: -1 }), "日本語");
});

/** `marked` with its caret (▮) moved by one word, or null when it can't move. */
function moved(marked, forward, language) {
  const source = marked.replace("▮", "");
  const to = codeWordBoundary(source, marked.indexOf("▮"), forward, language);
  return to === null ? null : `${source.slice(0, to)}▮${source.slice(to)}`;
}

test("word motion stops at the far end of the next identifier", () => {
  assert.equal(moved("▮pages_catalog_tags (", true), "pages_catalog_tags▮ (");
  assert.equal(moved("pages_cat▮alog_tags (", true), "pages_catalog_tags▮ (");
  assert.equal(moved("store▮.pages.get(id)", true), "store.pages▮.get(id)");
  assert.equal(moved("tags▮ (\n\n  page_id TEXT", true), "tags (\n\n  page_id▮ TEXT");
  assert.equal(moved("pages_catalog_tags▮ (", false), "▮pages_catalog_tags (");
  assert.equal(moved("store.pages.▮get(id)", false), "store.▮pages.get(id)");
  assert.equal(moved("tags (\n\n  ▮page_id", false), "▮tags (\n\n  page_id");
  assert.equal(moved("a.$sc▮ope", false, "js"), "a.▮$scope");
  assert.equal(moved("▮font-size: 1px", true, "css"), "font-size▮: 1px");
});

test("word motion has nowhere to go past the last identifier", () => {
  assert.equal(moved("tags▮ (\n);\n", true), null);
  assert.equal(moved("  -- ▮tags", false), null);
  assert.equal(moved("▮", true), null);
});

/** `marked` after word deletion at its caret (▮), or null when nothing goes. */
function deleted(marked, forward, language) {
  const source = marked.replace("▮", "");
  const range = codeWordDeletion(source, marked.indexOf("▮"), forward, language);
  return range && `${source.slice(0, range.from)}▮${source.slice(range.to)}`;
}

test("word deletion takes a whole identifier, or a run of punctuation", () => {
  assert.equal(deleted("ON pages_catalog_tags▮ (tag)", false), "ON ▮ (tag)");
  assert.equal(deleted("ON ▮pages_catalog_tags (tag)", true), "ON ▮ (tag)");
  assert.equal(deleted("ON pages_cat▮alog_tags", false), "ON ▮alog_tags");
  assert.equal(deleted("total   ▮= 1", false), "▮= 1");
  assert.equal(deleted("total▮   = 1", true), "total▮ 1");
  assert.equal(deleted("a !==▮ b", false), "a ▮ b");
  assert.equal(deleted("x.$sc▮ope", false, "ts"), "x.▮ope");
  assert.equal(deleted("x.$sc▮ope", false, "python"), "x.$▮ope");
});

test("word deletion stays inside the line", () => {
  assert.equal(deleted("one\n   ▮two", false), "one\n▮two");
  assert.equal(deleted("one\n▮two", false), null);
  assert.equal(deleted("one▮\ntwo", true), null);
  assert.equal(deleted("one  ▮\ntwo", true), null);
});

const sourceText = (node) =>
  node.content.map((child) => (child.isText ? String(child.param) : "\n")).join("");

function fixture(markdown) {
  let doc = A.from(createPageData({ pageId: "page_fixture", title: "Code words" }));
  doc = A.change(doc, (d) => initializePage(d, markdown));
  const replica = {
    get doc() {
      return doc;
    },
    change(fn) {
      doc = A.change(doc, fn);
    },
    observeChange: () => () => {},
  };
  const binding = createWordgardBinding(replica, orderedBlockIds(doc)[0]);
  const state = GardState.create({
    doc: binding.current.doc,
    config: [GardState.schemaElement.of(schema.elements), codeBlock()],
  });
  const textblocks = [];
  state.doc.iterate((node, pos) => {
    if (!node.type.inlineContent) return true;
    textblocks.push({ code: node.type === CodeBlock.type, start: pos + 1, text: sourceText(node) });
    return false;
  });
  /** The document position of ▮ in `marked`, a piece of one textblock. */
  const at = (marked) => {
    const piece = marked.replace("▮", "");
    const block = textblocks.find((candidate) => candidate.text.includes(piece));
    return block.start + block.text.indexOf(piece) + marked.indexOf("▮");
  };
  /** A selection as its text with the anchor («) and head (») drawn in. */
  const drawn = ({ anchor, head }) => {
    const block = textblocks.findLast((candidate) => candidate.start <= Math.min(anchor, head));
    const marks = [
      [anchor - block.start, "«"],
      [head - block.start, "»"],
    ].sort((a, b) => b[0] - a[0] || (a[1] === "»" ? 1 : -1));
    const out = marks.reduce((s, [i, mark]) => s.slice(0, i) + mark + s.slice(i), block.text);
    return out.slice(out.lastIndexOf("\n", out.indexOf("«")) + 1).split("\n")[0];
  };
  return { state, at, drawn };
}

const SQL = [
  "```sql",
  "CREATE TABLE pages_catalog_tags (",
  "  page_id TEXT NOT NULL",
  ");",
  "```",
  "",
  "Prose names snake_case too.",
].join("\n");

test("a position in a code block selects its identifier", () => {
  const { state, at, drawn } = fixture(SQL);
  const selection = codeWordSelection(state, at("pages_cat▮alog_tags"));
  assert.equal(drawn(selection), "CREATE TABLE «pages_catalog_tags» (");
  assert.equal(selection.directional, false);
  assert.equal(
    drawn(codeWordSelection(state, at("page▮_id"))),
    "  «page_id» TEXT NOT NULL",
    "the caret may sit beside the underscore",
  );
});

test("a position with no word is a caret, and prose is not code", () => {
  const { state, at } = fixture(SQL);
  const blank = at("▮  page_id");
  const caret = codeWordSelection(state, blank + 1);
  assert.ok(caret.empty);
  assert.equal(caret.head, blank + 1);
  assert.equal(codeWordSelection(state, at("snake▮_case")), null);
});

/** An editor that reads a pointer's clientX as a document position. */
const editorAt = (state) => ({
  state,
  posAtCoords: ({ x }) => ({ pos: x, side: 1, target: null }),
});
const press = (pos, init = {}) => ({ button: 0, detail: 2, clientX: pos, clientY: 0, ...init });

test("a double-click in a code block selects the identifier", () => {
  const { state, at, drawn } = fixture(SQL);
  const down = press(at("pages_cat▮alog_tags"));
  const style = codeWordMouseSelection(editorAt(state), down);
  assert.equal(drawn(style.get(down, false)), "CREATE TABLE «pages_catalog_tags» (");
});

test("other presses stay Wordgard's", () => {
  const { state, at } = fixture(SQL);
  const editor = editorAt(state);
  const inCode = at("pages_cat▮alog_tags");
  assert.equal(codeWordMouseSelection(editor, press(inCode, { detail: 1 })), null);
  assert.equal(codeWordMouseSelection(editor, press(inCode, { detail: 3 })), null);
  assert.equal(codeWordMouseSelection(editor, press(inCode, { button: 2 })), null);
  assert.equal(codeWordMouseSelection(editor, press(at("snake▮_case"))), null);
});

test("dragging a double-click extends by whole identifiers", () => {
  const { state, at, drawn } = fixture(SQL);
  const editor = editorAt(state);
  const forward = codeWordMouseSelection(editor, press(at("TA▮BLE")));
  assert.equal(
    drawn(forward.get(press(at("pages_cat▮alog_tags")), false)),
    "CREATE «TABLE pages_catalog_tags» (",
  );
  const backward = codeWordMouseSelection(editor, press(at("pages_cat▮alog_tags")));
  assert.equal(
    drawn(backward.get(press(at("CRE▮ATE")), false)),
    "»CREATE TABLE pages_catalog_tags« (",
  );
});

test("a Shift double-click extends the selection to the identifier", () => {
  const { state, at, drawn } = fixture(SQL);
  const from = at("▮CREATE");
  const selected = state.update({ selection: GardSelection.cursor(from) }).state;
  const down = press(at("pages_cat▮alog_tags"), { shiftKey: true });
  const style = codeWordMouseSelection(editorAt(selected), down);
  assert.equal(drawn(style.get(down, true)), "«CREATE TABLE pages_catalog_tags» (");
});

const caretAt = (state, pos) => state.update({ selection: GardSelection.cursor(pos) }).state;

test("word motion in a code block moves by identifier", () => {
  const { state, at, drawn } = fixture(SQL);
  const start = caretAt(state, at("▮pages_catalog_tags"));
  const right = moveByCodeWord({ state: start }, { dir: "right" });
  assert.equal(right.selection.head, at("pages_catalog_tags▮"));
  assert.ok(right.selection.empty);
  const extended = moveByCodeWord({ state: start }, { dir: "right", extend: true });
  assert.equal(drawn(extended.selection), "CREATE TABLE «pages_catalog_tags» (");
  const left = moveByCodeWord(
    { state: caretAt(state, at("page_id▮")) },
    { dir: "left", extend: true },
  );
  assert.equal(drawn(left.selection), "  »page_id« TEXT NOT NULL");
});

test("word motion moves an undirected selection from its facing end", () => {
  const { state, at, drawn } = fixture(SQL);
  const word = state.update({ selection: codeWordSelection(state, at("TA▮BLE")) }).state;
  const right = moveByCodeWord({ state: word }, { dir: "right", extend: true });
  assert.equal(drawn(right.selection), "CREATE «TABLE pages_catalog_tags» (");
  const left = moveByCodeWord({ state: word }, { dir: "left", extend: true });
  assert.equal(drawn(left.selection), "»CREATE TABLE« pages_catalog_tags (");
});

test("word motion past the last identifier, or in prose, stays Wordgard's", () => {
  const { state, at } = fixture(SQL);
  assert.equal(moveByCodeWord({ state: caretAt(state, at("NULL▮")) }, { dir: "right" }), false);
  assert.equal(moveByCodeWord({ state: caretAt(state, at("▮CREATE")) }, { dir: "left" }), false);
  assert.equal(
    moveByCodeWord({ state: caretAt(state, at("snake▮_case")) }, { dir: "right" }),
    false,
  );
});

test("word deletion in a code block removes the identifier", () => {
  const { state, at } = fixture(SQL);
  const start = caretAt(state, at("pages_catalog_tags▮"));
  const after = start.update(deleteCodeWord({ state: start }, "backward")).state;
  assert.equal(sourceText(after.doc.content[0]).split("\n")[0], "CREATE TABLE  (");
  assert.equal(after.selection.head, at("▮pages_catalog_tags"));
});

test("word deletion of a selection, at a line edge, or in prose stays Wordgard's", () => {
  const { state, at } = fixture(SQL);
  const selected = state.update({ selection: codeWordSelection(state, at("TA▮BLE")) }).state;
  assert.equal(deleteCodeWord({ state: selected }, "backward"), false);
  assert.equal(deleteCodeWord({ state: caretAt(state, at("▮  page_id")) }, "backward"), false);
  assert.equal(deleteCodeWord({ state: caretAt(state, at("snake_case▮")) }, "backward"), false);
});
