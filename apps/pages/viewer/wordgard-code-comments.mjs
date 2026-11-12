import { Leaf } from "wordgard/doc";
import { KeyBinding } from "wordgard/editor";
import { CodeBlockLanguage } from "./wordgard-model.mjs";
import { languageData } from "./code-highlight.mjs";
import { lineEnd, selectedCode, selectionAfter, touchedLines } from "./wordgard-code-indent.mjs";

// Mod-/ comments or uncomments the lines a code block selection touches,
// following CodeMirror's toggleComment (@codemirror/commands). Languages with
// a line comment get one on each line; CSS and HTML, which have only block
// comments, get one block comment around the lines. The tokens come from the
// CodeMirror language data on Wordgard's highlighter. A block with no known
// language, or JSON, has no comment syntax: the key does nothing there.
// Outside a code block the command returns false.

/** The comment syntax of a code block in `stored` language:
 * `{ line?, block?: { open, close } }`. */
export function commentTokens(stored) {
  return languageData(stored).commentTokens ?? {};
}

const toggled = (spec) => ({ ...spec, scrollIntoView: true, userEvent: "input.comment" });

/** Line comments. If any line with text lacks the token, add `token ` to every
 * line with text, at the smallest indentation among them. Otherwise remove the
 * token, and one space after it, from every line. A single blank line gets a
 * comment too. */
function toggleLines(state, code, token) {
  const { start, source, from, to } = code;
  const lines = touchedLines(source, from, to).map((at) => {
    const text = source.slice(at, lineEnd(source, at));
    const indent = /^\s*/.exec(text)[0].length;
    const commented = text.startsWith(token, indent);
    return { at, text, indent, blank: indent === text.length, commented };
  });
  const single = lines.length === 1;
  if (lines.some((line) => !line.commented && (!line.blank || single))) {
    const indent = Math.min(...lines.filter((line) => !line.blank).map((line) => line.indent));
    const edits = lines
      .filter((line) => single || !line.blank)
      .map((line) => ({
        at: line.at + (line.blank ? line.indent : indent),
        removed: 0,
        inserted: token.length + 1,
      }));
    return toggled({
      changes: edits.map(({ at }) => ({ from: start + at, insert: [Leaf.text(token + " ")] })),
      selection: selectionAfter(state, start, edits, 1),
    });
  }
  const edits = lines
    .filter((line) => line.commented)
    .map(({ at, text, indent }) => {
      const space = text[indent + token.length] === " " ? 1 : 0;
      return { at: at + indent, removed: token.length + space, inserted: 0 };
    });
  return toggled({
    changes: edits.map(({ at, removed }) => ({ from: start + at, to: start + at + removed })),
    selection: selectionAfter(state, start, edits),
  });
}

/** A block comment around the touched lines, from the first line's text to
 * the last line's end, or its removal when they already open and close one. */
function toggleBlock(state, code, { open, close }) {
  const { start, source, from, to } = code;
  const lines = touchedLines(source, from, to);
  const first = lines[0] + /^[ \t]*/.exec(source.slice(lines[0]))[0].length;
  const last = Math.max(first, lineEnd(source, lines[lines.length - 1]));
  const text = source.slice(first, last).trimEnd();
  if (text.length >= open.length + close.length && text.startsWith(open) && text.endsWith(close)) {
    const opened = open.length + (text[open.length] === " " ? 1 : 0);
    const end = first + text.length;
    const closed = close.length + (text[text.length - close.length - 1] === " " ? 1 : 0);
    const edits = [
      { at: first, removed: opened, inserted: 0 },
      { at: end - closed, removed: closed, inserted: 0 },
    ];
    return toggled({
      changes: edits.map(({ at, removed }) => ({ from: start + at, to: start + at + removed })),
      selection: selectionAfter(state, start, edits),
    });
  }
  const edits = [
    { at: first, removed: 0, inserted: open.length + 1 },
    { at: last, removed: 0, inserted: close.length + 1 },
  ];
  return toggled({
    changes: [
      { from: start + first, insert: [Leaf.text(open + " ")] },
      { from: start + last, insert: [Leaf.text(" " + close)] },
    ],
    selection: selectionAfter(state, start, edits),
  });
}

/** Mod-/. Toggle a comment on every line the selection touches. */
export function toggleCodeComment({ state }) {
  const code = selectedCode(state);
  if (!code) return false;
  const tokens = commentTokens(code.block.node.mark(CodeBlockLanguage));
  if (tokens.line) return toggleLines(state, code, tokens.line);
  if (tokens.block) return toggleBlock(state, code, tokens.block);
  return true;
}

// Outside a code block the command returns false, and allowDefault leaves the
// key to the browser.
export const codeComments = [
  KeyBinding.of({ key: "Mod-/", run: toggleCodeComment, allowDefault: true }),
];
