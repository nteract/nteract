import * as A from "@automerge/automerge/slim";

const path = ["title"];

// One end of the title input's selection as a native cursor. A caret sticks to
// the character before it, so a peer typing at the same spot lands after the
// caret and each person keeps an unbroken run. A selection end, and a caret at
// the start of the title, stick to the character after them.
function capture(doc, offset, caret) {
  const length = doc.title?.length ?? 0;
  if (caret && offset > 0) return { cursor: A.getCursor(doc, path, offset - 1), before: true };
  return { cursor: A.getCursor(doc, path, offset >= length ? "end" : offset), before: false };
}

function resolve(doc, { cursor, before }) {
  const at = A.getCursorPosition(doc, path, cursor);
  if (!before) return at;
  // The character a caret sticks to can be deleted; the caret then stays put.
  let alive = false;
  try {
    alive = at < (doc.title?.length ?? 0) && A.getCursor(doc, path, at) === cursor;
  } catch {
    /* The title text object was replaced. */
  }
  return alive ? at + 1 : at;
}

/** Capture the title input's selection against the document it shows. */
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

/** The splice that turns `previous` into `next`, given where the input's
 * caret sits after the edit. A text diff alone can't place an edit inside a
 * run of repeated characters: typing a space after "Notes: " reads the same
 * as typing it before. The caret ends the inserted text, so the edit keeps
 * the position the person typed at. Returns null when the caret doesn't fit
 * a single splice. */
export function titleSplice(previous, next, caret) {
  if (!Number.isInteger(caret) || caret < 0 || caret > next.length) return null;
  const after = next.slice(caret);
  if (after.length > previous.length || !previous.endsWith(after)) return null;
  const end = previous.length - after.length;
  let index = 0;
  while (index < end && index < caret && previous[index] === next[index]) index++;
  return { index, remove: end - index, insert: next.slice(index, caret) };
}

/** The splice for a title input's edit, in the current document. `base` is
 * the value the input showed before the keystroke and the heads it came from.
 * A peer's change can reach the document before React shows it, so the input
 * can be behind: diffing against the current title would undo the peer's
 * text. The edit is read against `base` and its ends are carried to the
 * current document through native cursors. */
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
  // The position just after a character of the shown title, now. A character
  // a peer deleted leaves the position where the character was.
  const after = (offset) => {
    const cursor = A.getCursor(shown, path, offset);
    const at = A.getCursorPosition(doc, path, cursor);
    let alive = false;
    try {
      alive = at < current.length && A.getCursor(doc, path, at) === cursor;
    } catch {
      /* past the end */
    }
    return alive ? at + 1 : at;
  };
  const from = edit.index ? after(edit.index - 1) : 0;
  const to = edit.remove ? after(edit.index + edit.remove - 1) : from;
  return { index: from, remove: Math.max(0, to - from), insert: edit.insert };
}
