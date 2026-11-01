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

/** The longest Page title the host accepts (worker/index.mjs and
 * worker/registration.mjs refuse longer ones). The title input stops there. */
export const TITLE_MAX_LENGTH = 500;

// The most cells the LCS diff below fills: two unrelated titles at the
// length limit. A longer middle becomes one replacement instead.
const LCS_BUDGET = TITLE_MAX_LENGTH * TITLE_MAX_LENGTH;

/** `from` turned into `next` as deletions of `from`'s code points and
 * insertion runs at gaps between them (UTF-16 offsets into `from`). The
 * caret's single splice is preferred: it places an edit inside repeated
 * characters where a diff can't. Otherwise the common prefix and suffix are
 * kept, and a longest-common-subsequence diff over the middle's code points
 * keeps every character the two share, as updateText does. A middle larger
 * than LCS_BUDGET is replaced whole. `at` describes the caret: inside an
 * insertion run (`run`, `into`), or at a gap between kept characters
 * (`gap`). `work` counts the diff cells filled. */
function titleOps(from, next, caret) {
  const splice = titleSplice(from, next, caret);
  if (splice) {
    const deleted = [];
    for (let offset = splice.index; offset < splice.index + splice.remove; ) {
      const width = from.codePointAt(offset) > 0xffff ? 2 : 1;
      deleted.push({ offset, width });
      offset += width;
    }
    const runs = splice.insert ? [{ gap: splice.index, text: splice.insert }] : [];
    return {
      deleted,
      runs,
      at: runs.length ? { run: runs[0], into: splice.insert.length } : { gap: splice.index },
      work: 0,
    };
  }
  const a = Array.from(from),
    b = Array.from(next);
  let start = 0,
    tail = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (
    tail < a.length - start &&
    tail < b.length - start &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const n = a.length - tail,
    m = b.length - tail;
  const deleted = [],
    runs = [];
  let offset = a.slice(0, start).reduce((sum, c) => sum + c.length, 0),
    valueAt = offset,
    // A caret inside the common prefix sits at that gap.
    at = caret < offset ? { gap: caret } : null;
  const keep = (c) => {
    if (!at && caret === valueAt) at = { gap: offset };
    offset += c.length;
    valueAt += c.length;
  };
  const remove = (c) => {
    deleted.push({ offset, width: c.length });
    offset += c.length;
  };
  const insert = (c) => {
    let run = runs.at(-1);
    if (run?.gap === offset) run.text += c;
    else runs.push((run = { gap: offset, text: c }));
    if (!at && caret >= valueAt && caret <= valueAt + c.length)
      at = { run, into: run.text.length - c.length + caret - valueAt };
    valueAt += c.length;
  };
  const cells = (n - start) * (m - start);
  if (cells > LCS_BUDGET) {
    for (let i = start; i < n; i++) remove(a[i]);
    for (let j = start; j < m; j++) insert(b[j]);
  } else {
    // Suffix LCS lengths for a[i..n) and b[j..m) within the middle.
    const cols = m - start + 1,
      table = new Uint32Array((n - start + 1) * cols);
    for (let i = n - 1; i >= start; i--)
      for (let j = m - 1; j >= start; j--) {
        const cell = (i - start) * cols + (j - start);
        table[cell] =
          a[i] === b[j]
            ? table[cell + cols + 1] + 1
            : Math.max(table[cell + cols], table[cell + 1]);
      }
    const lcs = (i, j) => table[(i - start) * cols + (j - start)];
    let i = start,
      j = start;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) {
        keep(a[i++]);
        j++;
      } else if (j >= m || (i < n && lcs(i + 1, j) >= lcs(i, j + 1))) remove(a[i++]);
      else insert(b[j++]);
    }
  }
  if (!at) at = { gap: caret - valueAt + offset };
  return { deleted, runs, at, work: cells > LCS_BUDGET ? 0 : cells };
}

const sameHeads = (a, b) => a.length === b.length && a.every((head) => b.includes(head));

/** A title input's edit, as splices on the current document, and where the
 * input's caret lands. `base` is the snapshot of what the input showed
 * before the keystroke. A peer's change can reach the document before React
 * shows it, so the input can be behind. The edit is read against the input's
 * revision and carried to the current document by native cursors: it deletes
 * only characters the input showed that still exist, and each inserted run
 * goes after the code point that preceded it in the input (a run at the start
 * goes before the first one). A peer's unseen text is never deleted, and
 * every step is an ordinary change on the current document. `work` counts
 * the diff cells filled. Returns null when the document has no title. */
export function titleChange(doc, base, next, caret) {
  const current = doc?.title;
  if (typeof current !== "string") return null;
  let shown = doc;
  if (base && typeof base.value === "string" && Array.isArray(base.heads)) {
    try {
      const view = A.view(doc, base.heads);
      // Equal text is not equal characters: a peer can delete an "A" and add
      // another. The live document stands in only for the same revision.
      // Otherwise the view is read through a clone: a cursor lookup on a view
      // walks the text at its heads each time, while a clone is a document at
      // them, with the same cursor ids, built once. It is only read.
      if (view.title === base.value)
        shown = sameHeads(base.heads, A.getHeads(doc)) ? doc : A.clone(view);
    } catch {
      /* Unknown heads: read against the current title. */
    }
  }
  const from = shown.title;
  const { deleted, runs, at, work } = titleOps(from, next, caret);
  // Where a shown character is now, and whether it is still there.
  const locate = (offset) => {
    const cursor = A.getCursor(shown, path, offset);
    const position = A.getCursorPosition(doc, path, cursor);
    let alive = false;
    try {
      alive = position < current.length && A.getCursor(doc, path, position) === cursor;
    } catch {
      /* past the end */
    }
    return { position, alive };
  };
  // Where a gap between shown characters is now.
  const place = (gap) => {
    if (gap > 0)
      return stickyCaretPosition(doc, path, current, stickyCaret(shown, path, from, gap));
    return from.length ? locate(0).position : 0;
  };
  const inserts = runs.map((run) => ({ run, position: place(run.gap) }));
  const insertAt = new Set(inserts.map((r) => r.position));
  // Characters that are still there, merged into ranges where they are
  // adjacent now. A range never spans an insertion point.
  const removals = [];
  for (const { offset, width } of deleted) {
    const { position, alive } = locate(offset);
    if (!alive) continue;
    const last = removals.at(-1);
    if (last && last.position + last.width === position && !insertAt.has(position))
      last.width += width;
    else removals.push({ position, width });
  }
  const removedBefore = (position) =>
    removals.reduce(
      (sum, r) => (r.position < position ? sum + Math.min(r.width, position - r.position) : sum),
      0,
    );
  const insertedBefore = (position, gap) =>
    inserts.reduce(
      (sum, r) =>
        r.position < position || (r.position === position && r.run.gap < gap)
          ? sum + r.run.text.length
          : sum,
      0,
    );
  // From the end of the document backwards, so earlier indexes stay valid. At
  // one position a deletion comes before an insertion there, and a later
  // run before an earlier one, so runs keep their order.
  const edits = [
    ...removals.map((r) => ({
      position: r.position,
      rank: 2,
      gap: 0,
      edit: { index: r.position, remove: r.width, insert: "" },
    })),
    ...inserts.map((r) => ({
      position: r.position,
      rank: 1,
      gap: r.run.gap,
      edit: { index: r.position, remove: 0, insert: r.run.text },
    })),
  ]
    .toSorted((x, y) => y.position - x.position || y.rank - x.rank || y.gap - x.gap)
    .map(({ edit }) => edit);
  let landed;
  if (at.run) {
    const position = inserts.find((r) => r.run === at.run).position;
    landed = position - removedBefore(position) + insertedBefore(position, at.run.gap) + at.into;
  } else {
    const position = place(at.gap);
    landed = position - removedBefore(position) + insertedBefore(position, at.gap);
  }
  return { edits, caret: landed, work };
}

/** Apply titleChange's splices inside a change callback. */
export function writeTitle(doc, edits) {
  for (const { index, remove, insert } of edits)
    if (remove || insert) A.splice(doc, path, index, remove, insert);
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
