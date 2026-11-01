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

/** A title input's edit, written at the revision the input showed. `base`
 * is the snapshot of what the input showed before the keystroke. A peer's
 * change can reach the document before React shows it, so the input can be
 * behind. The edit is read against the input's revision and applied there
 * (`changeAt` with `heads`), and Automerge merges it with everything since:
 * it can only delete characters the input showed, never a peer's unseen
 * text. `heads` is null when the input shows the current title or its
 * revision is unknown. `edit` is one splice placed by the caret, or null
 * when the value doesn't fit one splice; the caller then diffs the shown
 * title into the value with updateText, still at `heads`. */
export function titleChange(doc, base, next, caret) {
  if (typeof doc?.title !== "string") return null;
  let shown = null;
  if (base && typeof base.value === "string" && Array.isArray(base.heads)) {
    try {
      const view = A.view(doc, base.heads);
      if (view.title === base.value && view.title !== doc.title) shown = view;
    } catch {
      /* Unknown heads: read against the current title. */
    }
  }
  return { heads: shown ? base.heads : null, edit: titleSplice((shown ?? doc).title, next, caret) };
}

/** Apply a titleChange inside a change callback: its splice, or a diff of
 * the title into `value`. */
export function writeTitle(doc, edit, value) {
  if (!edit) A.updateText(doc, path, value);
  else if (edit.remove || edit.insert) A.splice(doc, path, edit.index, edit.remove, edit.insert);
}

/** The input's caret after a title change, in `doc`, which contains the
 * change that produced `changeHeads`. In that change's own revision the
 * title is exactly what the input shows, so `caret` sticks to the code point
 * before it there, and lands after it wherever peers' merged text put it. */
export function caretAfterTitleChange(doc, changeHeads, caret) {
  if (caret <= 0) return 0;
  const view = A.view(doc, changeHeads);
  return stickyCaretPosition(doc, path, doc.title, stickyCaret(view, path, view.title, caret));
}

// The title input's event lifecycle, as one transition function. An IME owns
// the input's value and its replacement range while it composes, so nothing
// may write the document, the value or the selection then.
//
// States:
// - idle: an input event is one splice into the document.
// - composing: input events only update the value React shows. `base` is the
//   snapshot of the revision the input showed when composition began. Peer
//   edits reach the document but not the input.
//
// Events: compositionstart, input ({ composing }), compositionend, blur, and
// reset (the Page changed). A composition ends on compositionend, on an input
// event that is no longer composing (some browsers never send
// compositionend), or on blur. Ending commits the input's value against
// `base` as one splice; a blur with nothing composed only clears the state,
// and React then shows the document's title again.
//
// Effects for the caller: null, or { type: "commit", base }.
export const TITLE_IDLE = Object.freeze({ phase: "idle" });

const composingIn = (state, session) => state.phase === "composing" && state.session === session;

export function titleInput(state, event) {
  const commit = (base) => ({ state: TITLE_IDLE, effect: { type: "commit", base } });
  const stay = { state, effect: null };
  switch (event.type) {
    case "compositionstart":
      return composingIn(state, event.session)
        ? stay
        : {
            state: {
              phase: "composing",
              session: event.session,
              base: event.base,
              value: event.value,
            },
            effect: null,
          };
    case "input":
      if (composingIn(state, event.session))
        return event.composing
          ? { state: { ...state, value: event.value }, effect: null }
          : commit(state.base);
      if (event.composing)
        return {
          state: {
            phase: "composing",
            session: event.session,
            base: event.base,
            value: event.value,
          },
          effect: null,
        };
      return commit(event.base);
    case "compositionend":
      return state.phase === "composing" ? commit(state.base) : stay;
    case "blur":
      if (state.phase !== "composing") return stay;
      return event.value === state.base?.value
        ? { state: TITLE_IDLE, effect: null }
        : commit(state.base);
    case "reset":
      return { state: TITLE_IDLE, effect: null };
    default:
      return stay;
  }
}

/** Whether `state` is composing in this Page. */
export const composingTitle = composingIn;
