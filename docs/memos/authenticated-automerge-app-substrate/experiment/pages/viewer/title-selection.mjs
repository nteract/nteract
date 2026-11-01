import * as A from "@automerge/automerge/slim";
import { stickyCaret, stickyCaretPosition } from "../model/sticky-caret.mjs";

const path = ["title"];
const isHigh = (unit) => unit >= 0xd800 && unit <= 0xdbff;

// The title input's selection as native cursors. A caret sticks to the code
// point before it, so a peer typing at the same spot lands after the caret and
// each person keeps an unbroken run. A selection end, and a caret at the start
// of the title, stick to the character after them.
function capture(doc, offset, caret) {
  const text = doc.title;
  if (caret && offset > 0) return { cursor: stickyCaret(doc, path, text, offset), before: true };
  return { cursor: A.getCursor(doc, path, offset >= text.length ? "end" : offset), before: false };
}

function resolve(doc, { cursor, before }) {
  return before
    ? stickyCaretPosition(doc, path, doc.title, cursor)
    : A.getCursorPosition(doc, path, cursor);
}

/** Capture a selection against `doc`, the revision whose title the input
 * shows. Offsets are UTF-16, as the input reports them. */
export function captureTitleSelection(doc, start, end = start) {
  if (typeof doc?.title !== "string" || end > doc.title.length) return null;
  const caret = start === end;
  try {
    return { start: capture(doc, start, caret), end: caret ? null : capture(doc, end, false) };
  } catch {
    return null;
  }
}

/** Where a captured title selection lands in a later document. */
export function resolveTitleSelection(doc, captured) {
  if (!captured || typeof doc?.title !== "string") return null;
  try {
    const start = resolve(doc, captured.start);
    const end = captured.end ? Math.max(start, resolve(doc, captured.end)) : start;
    return { start, end };
  } catch {
    return null;
  }
}

/** What the title input shows, as a revision: its value, the heads of a
 * revision with that title, and its selection captured against that
 * revision. The input can lag the document by a peer's change React hasn't
 * rendered yet, so the current document is used only when its title is what
 * the input shows; otherwise the last remembered revision is reused if it
 * still matches. With neither, the previous snapshot stands. */
export function titleSnapshot(doc, previous, value, start, end = start) {
  let shown = null,
    heads = null;
  if (doc?.title === value) {
    shown = doc;
    heads = A.getHeads(doc);
  } else if (previous?.value === value && Array.isArray(previous.heads)) {
    try {
      const view = A.view(doc, previous.heads);
      if (view.title === value) {
        shown = view;
        heads = previous.heads;
      }
    } catch {
      /* Unknown heads. */
    }
  }
  if (!shown) return previous ?? null;
  return { value, heads, cursors: captureTitleSelection(shown, start, end) };
}

/** The splice that turns `previous` into `next`, given where the input's
 * caret sits after the edit. A text diff alone can't place an edit inside a
 * run of repeated characters: typing a space after "Notes: " reads the same
 * as typing it before. The caret ends the inserted text, so the edit keeps
 * the position the person typed at. The splice never starts inside a
 * surrogate pair. Returns null when the caret doesn't fit a single splice. */
export function titleSplice(previous, next, caret) {
  if (!Number.isInteger(caret) || caret < 0 || caret > next.length) return null;
  const after = next.slice(caret);
  if (after.length > previous.length || !previous.endsWith(after)) return null;
  const end = previous.length - after.length;
  let index = 0;
  while (index < end && index < caret && previous[index] === next[index]) index++;
  // A shared high surrogate before a differing low one: start at the pair.
  if (index > 0 && isHigh(previous.charCodeAt(index - 1))) index--;
  return { index, remove: end - index, insert: next.slice(index, caret) };
}

/** The splice for a title input's edit, in the current document. `base` is
 * the snapshot of what the input showed before the keystroke. A peer's change
 * can reach the document before React shows it, so the input can be behind:
 * diffing against the current title would undo the peer's text. The edit is
 * read against `base`, and its ends are carried to the current document as
 * sticky carets. */
export function titleEdit(doc, base, next, caret) {
  const current = doc.title;
  if (typeof current !== "string") return null;
  let shown = null;
  if (base && typeof base.value === "string" && Array.isArray(base.heads)) {
    try {
      const view = A.view(doc, base.heads);
      if (view.title === base.value) shown = view;
    } catch {
      /* Unknown heads: read against the current title. */
    }
  }
  if (!shown || shown.title === current) return titleSplice(current, next, caret);
  const edit = titleSplice(shown.title, next, caret);
  if (!edit) return null;
  const carry = (offset) =>
    offset > 0
      ? stickyCaretPosition(doc, path, current, stickyCaret(shown, path, shown.title, offset))
      : 0;
  const from = carry(edit.index);
  const to = edit.remove ? carry(edit.index + edit.remove) : from;
  return { index: from, remove: Math.max(0, to - from), insert: edit.insert };
}

/** What the input should show after this tab's splice: the merged title and
 * the caret after the applied splice, when a peer's change React hadn't shown
 * yet was kept. Null when the input already shows the document's title. */
export function mergedTitle(doc, edit, value) {
  if (!edit || typeof doc?.title !== "string" || doc.title === value) return null;
  return { value: doc.title, caret: edit.index + edit.insert.length };
}

// The title input's composition lifecycle. An IME owns the input's value and
// its replacement range while it composes, so nothing may rewrite either:
//
// - idle: each input event is one splice into the document.
// - composing: input events only update the text the input shows; the
//   document is untouched, and `base` keeps the snapshot of the revision the
//   input showed when composition began. Peer edits reach the document but
//   not the input.
// - end: back to idle. The caller commits the composed text against `base`
//   as one splice and shows the merged title.
//
// `session` scopes a composition to the Page it began on.
export const TITLE_IDLE = Object.freeze({ phase: "idle" });

export function titleComposition(state, event) {
  switch (event.type) {
    case "start":
      return state.phase === "composing" && state.session === event.session
        ? state
        : { phase: "composing", session: event.session, base: event.base, value: event.value };
    case "input":
      return state.phase === "composing" && state.session === event.session
        ? { ...state, value: event.value }
        : state;
    case "end":
    case "reset":
      return TITLE_IDLE;
    default:
      return state;
  }
}

/** Whether a title input event belongs to a composition in `state`. */
export const composingTitle = (state, session) =>
  state.phase === "composing" && state.session === session;
