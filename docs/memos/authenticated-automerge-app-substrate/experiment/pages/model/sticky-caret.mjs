import * as A from "@automerge/automerge/slim";

// A caret that sticks to the code point before it. When a peer types at the
// caret, their text lands after it, so each person keeps an unbroken run.
// Offsets are UTF-16, as in Automerge text and DOM inputs; a cursor names a
// whole code point, so an emoji counts once and resolves to its first unit.

const isHigh = (unit) => unit >= 0xd800 && unit <= 0xdbff;
const isLow = (unit) => unit >= 0xdc00 && unit <= 0xdfff;

/** Start of the code point that ends at `offset`. */
export function codePointBefore(text, offset) {
  return offset >= 2 && isLow(text.charCodeAt(offset - 1)) && isHigh(text.charCodeAt(offset - 2))
    ? offset - 2
    : offset - 1;
}

/** UTF-16 width of the code point starting at `at`. */
export const codePointWidth = (text, at) => ((text.codePointAt(at) ?? 0) > 0xffff ? 2 : 1);

/** The cursor a caret at `offset` sticks to, or null at the start of the text. */
export function stickyCaret(doc, path, text, offset) {
  return offset > 0 ? A.getCursor(doc, path, codePointBefore(text, offset)) : null;
}

/** Where a sticky caret lands in `doc`, whose text at `path` is `text`: just
 * after its code point, or, if a peer deleted that code point, where it was. */
export function stickyCaretPosition(doc, path, text, cursor) {
  const at = A.getCursorPosition(doc, path, cursor);
  let alive = false;
  try {
    alive = at < text.length && A.getCursor(doc, path, at) === cursor;
  } catch {
    /* `at` is past the end: the code point is gone. */
  }
  return alive ? at + codePointWidth(text, at) : at;
}
