import { Leaf } from "wordgard/doc";
import { Command, deleteUnit, insertText } from "wordgard/command";
import { GardSelection, GardState, Transaction } from "wordgard/state";
import { CodeBlock, CodeBlockLanguage } from "./wordgard-model.mjs";
import { languageFor } from "./code-highlight.mjs";
import { lineEnd, lineStart, selectedCode, sourceOf } from "./wordgard-code-indent.mjs";

// Closing brackets and quotes in a code block, following CodeMirror's
// closeBrackets (@codemirror/autocomplete). Typing an opener before
// whitespace, a closer or the end of the line inserts the pair. Typing the
// closer the editor inserted moves over it. Backspace between an empty pair
// deletes both. With a selection, the pair wraps it. Outside a code block
// every command here returns false, so typing and Backspace stay Wordgard's.
//
// CodeMirror reads the syntax tree to tell a quote that opens a string from
// one that ends it. Wordgard's highlighter keeps no tree, so a quote pairs
// only when it doesn't follow a word character and the line before the caret
// holds an even number of that quote.

const DEFAULT_BRACKETS = ["(", "[", "{", "'", '"'];
// An opener pairs only before one of these, whitespace, or the end of a line.
const CLOSE_BEFORE = ")]}:;>";
// Rust's ' starts a lifetime or a char, not a string.
const BRACKETS = { Rust: ["(", "[", "{", '"'] };
// From @codemirror/lang-python: f"", r"" and b"" pair like "".
const STRING_PREFIXES = {
  Python: ["f", "fr", "rf", "r", "u", "b", "br", "rb", "F", "FR", "RF", "R", "U", "B", "BR", "RB"],
};

/** What closes in a code block of `stored` language: the brackets, with
 * triple quotes where the language has them, the prefixes that can start a
 * string, and the characters besides letters, digits and _ that make words. */
export function bracketConfig(stored) {
  const language = languageFor(stored);
  const data = language?.parser.languageData ?? {};
  return {
    brackets: BRACKETS[language?.name] ?? data.closeBrackets?.brackets ?? DEFAULT_BRACKETS,
    prefixes: STRING_PREFIXES[language?.name] ?? data.closeBrackets?.stringPrefixes ?? [],
    wordChars: data.wordChars ?? "",
  };
}

const PAIRS = { "(": ")", "[": "]", "{": "}" };
const closing = (open) => PAIRS[open] ?? open;
const isWord = (ch, { wordChars }) => !!ch && (/[\p{L}\p{N}_]/u.test(ch) || wordChars.includes(ch));

/** Where a string typed at `at` would start: `at` after a non-word character,
 * before a string prefix such as Python's f, or -1. */
function stringStart(source, at, config) {
  if (!isWord(source[at - 1], config)) return at;
  for (const prefix of config.prefixes) {
    const from = at - prefix.length;
    if (source.slice(from, at) === prefix && !isWord(source[from - 1], config)) return from;
  }
  return -1;
}

/** Whether the line before `at` leaves a `quote` string open: it holds an odd
 * number of unescaped `quote`s. */
function insideString(source, at, quote) {
  let open = false;
  for (let i = lineStart(source, at); i < at; i++) {
    if (source[i] === "\\") i++;
    else if (source[i] === quote) open = !open;
  }
  return open;
}

// Closers the editor inserted, by document position. Typing a closer moves
// over one of these, never over a closer someone typed. They are forgotten
// when the caret leaves their line, as in CodeMirror.
const trackCloser = Transaction.Effect.define({
  map: (pos, mapping) => mapping.mapPos(pos, -1, "after") ?? undefined,
});
const passCloser = Transaction.Effect.define({
  map: (pos, mapping) => mapping.mapPos(pos, -1, "after") ?? undefined,
});

/** The positions in `positions` on the caret's line of its code block. */
function onCaretLine(positions, doc, selection) {
  if (!(selection instanceof GardSelection.Text)) return [];
  const block = doc.resolve(selection.head).textblockParent;
  if (block?.node.type !== CodeBlock.type) return [];
  const source = sourceOf(block.node);
  const head = selection.head - block.start;
  const from = block.start + lineStart(source, head);
  const to = block.start + lineEnd(source, head);
  return positions.filter((pos) => pos >= from && pos < to);
}

const insertedClosers = GardState.Field.define({
  create: () => [],
  update(value, tr) {
    if (!value.length && !tr.effects.length) return value;
    let closers = value;
    if (tr.docChanged && closers.length) {
      // A closer deleted by the change is no longer tracked.
      closers = closers.flatMap((pos) => tr.changes.mapPos(pos, 1, "after") ?? []);
    }
    for (const effect of tr.effects) {
      if (effect.is(trackCloser)) closers = [...closers, effect.value];
      else if (effect.is(passCloser)) closers = closers.filter((pos) => pos !== effect.value);
    }
    if (closers.length && (tr.selection || tr.docChanged)) {
      closers = onCaretLine(closers, tr.newDoc, tr.newSelection);
    }
    return closers;
  },
});

const typed = (spec) => ({ ...spec, scrollIntoView: true, userEvent: "input.type" });

/** `open` and `close` at the caret, with the caret between them. */
function insertPair(at, open, close) {
  return typed({
    changes: { from: at, insert: [Leaf.text(open + close)] },
    selection: GardSelection.cursor(at + open.length),
    effects: trackCloser.of(at + open.length),
  });
}

/** `open` and `close` around the selection, which stays on the same text. */
function wrapSelection(state, open, close) {
  const { anchor, head, from, to } = state.selection;
  return typed({
    changes: [
      { from, insert: [Leaf.text(open)] },
      { from: to, insert: [Leaf.text(close)] },
    ],
    selection: GardSelection.Text.create({
      anchor: anchor + open.length,
      head: head + open.length,
    }),
    effects: trackCloser.of(to + open.length),
  });
}

/** Move over `length` characters of an inserted closer at the caret.
 *
 * A select event, not an input one: until the view flushes, Wordgard places
 * the next typed key at the DOM caret unless a pending transaction moved the
 * selection with a non-input event. Typed fast, the key after the closer would
 * otherwise land in front of it. */
function passOver(at, length) {
  return {
    selection: GardSelection.cursor(at + length),
    effects: passCloser.of(at),
    scrollIntoView: true,
    userEvent: "select",
  };
}

function typeOpen(state, code, open) {
  const { start, source, from, to } = code;
  if (from !== to) return wrapSelection(state, open, closing(open));
  const next = source[from];
  if (next && !/\s/.test(next) && !CLOSE_BEFORE.includes(next)) return false;
  return insertPair(start + from, open, closing(open));
}

function typeQuote(state, code, quote, config) {
  const { start, source, from, to } = code;
  if (from !== to) return wrapSelection(state, quote, quote);
  const at = start + from;
  const next = source[from];
  if (next === quote) {
    if (!state.field(insertedClosers).includes(at)) return false;
    const triple = config.brackets.includes(quote.repeat(3));
    return passOver(at, triple && source.startsWith(quote.repeat(3), from) ? 3 : 1);
  }
  // A third quote after an empty '' opens a triple-quoted string.
  if (
    config.brackets.includes(quote.repeat(3)) &&
    from >= 2 &&
    source.endsWith(quote + quote, from)
  ) {
    const opens = stringStart(source, from - 2, config);
    if (opens >= 0 && source[opens - 1] !== quote) {
      return typed({
        changes: { from: at, insert: [Leaf.text(quote.repeat(4))] },
        selection: GardSelection.cursor(at + 1),
        effects: trackCloser.of(at + 1),
      });
    }
  }
  if (isWord(next, config)) return false;
  if (stringStart(source, from, config) < 0 || insideString(source, from, quote)) return false;
  return insertPair(at, quote, quote);
}

/** Typed text in a code block. Returns false for anything that isn't one
 * bracket or quote typed over the selection, which Wordgard then inserts. */
export function typeBracket({ state }, { from, to, insert, userEvent }) {
  if (userEvent !== "input.type" || [...insert].length !== 1) return false;
  const code = selectedCode(state);
  if (!code || from !== state.selection.from || to !== state.selection.to) return false;
  const config = bracketConfig(code.block.node.mark(CodeBlockLanguage));
  for (const token of config.brackets) {
    if (token.length !== 1) continue;
    const close = closing(token);
    if (insert === token) {
      return close === token ? typeQuote(state, code, token, config) : typeOpen(state, code, token);
    }
    if (
      insert === close &&
      code.from === code.to &&
      code.source[code.from] === close &&
      state.field(insertedClosers).includes(code.start + code.from)
    ) {
      return passOver(code.start + code.from, 1);
    }
  }
  return false;
}

/** Backspace between an opener and its closer deletes both. */
export function deleteBracketPair({ state }, direction) {
  if (direction !== "backward") return false;
  const code = selectedCode(state);
  if (!code || code.from !== code.to) return false;
  const { start, source, from } = code;
  const open = source[from - 1];
  const { brackets } = bracketConfig(code.block.node.mark(CodeBlockLanguage));
  if (!open || !brackets.includes(open) || source[from] !== closing(open)) return false;
  return {
    changes: { from: start + from - 1, to: start + from + 1 },
    selection: GardSelection.cursor(start + from - 1),
    scrollIntoView: true,
    userEvent: "delete.backward",
  };
}

// Ahead of Pages' Markdown input rules: in code, a backtick is a quote, not
// inline code.
export const codeBrackets = [
  insertedClosers,
  GardState.prec.high(Command.handler(insertText, typeBracket)),
  Command.handler(deleteUnit, deleteBracketPair),
];
