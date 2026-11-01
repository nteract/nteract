import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  TITLE_IDLE,
  captureTitleSelection,
  caretAfterTitleChange,
  composingTitle,
  resolveTitleSelection,
  spliceTitle,
  titleChange,
  titleInput,
  titleSnapshot,
  titleSplice,
} from "./title-selection.mjs";

const type = (doc, at, text) => A.change(doc, (d) => A.splice(d, ["title"], at, 0, text));
const remove = (doc, at, count) => A.change(doc, (d) => A.splice(d, ["title"], at, count));

// What main.jsx's commitTitle does: the splice at the input's revision, then
// the caret after it in the merged document.
function commit(doc, base, value, caret) {
  const plan = titleChange(doc, base, value, caret);
  assert.ok(plan, "the value fits one splice");
  let made, next;
  if (plan.heads) {
    const result = A.changeAt(doc, plan.heads, (d) => spliceTitle(d, plan.edit));
    next = result.newDoc;
    made = result.newHeads;
  } else {
    next = A.change(doc, (d) => spliceTitle(d, plan.edit));
    made = A.getHeads(next);
  }
  return { doc: next, caret: caretAfterTitleChange(next, made, plan.edit), plan };
}
const snapshot = (doc, caret) => titleSnapshot(doc, null, doc.title, caret);

test("a title caret keeps its side of a peer typing at the same spot", () => {
  for (const actor of ["00".repeat(16), "ff".repeat(16)]) {
    const base = A.from({ title: "Notes:" });
    // Local typed a space; the peer typed a space at the same spot unseen.
    const local = type(A.clone(base), 6, " ");
    const peer = type(A.clone(base, { actor }), 6, " ");
    const caret = captureTitleSelection(local, 7);
    const merged = A.merge(local, peer);
    const { start } = resolveTitleSelection(merged, caret);
    // Typing at the mapped caret extends the local run, whatever the order.
    const next = type(merged, start, "A");
    const localSpace = A.getCursorPosition(merged, ["title"], A.getCursor(local, ["title"], 6));
    assert.equal(next.title[localSpace + 1], "A", `${actor}: ${JSON.stringify(next.title)}`);
  }
});

test("peer edits before and after a title caret shift it like text", () => {
  const doc = A.from({ title: "Plan B" });
  const caret = captureTitleSelection(doc, 4);
  assert.deepEqual(resolveTitleSelection(type(A.clone(doc), 0, "My "), caret), {
    start: 7,
    end: 7,
  });
  assert.deepEqual(resolveTitleSelection(type(A.clone(doc), 6, "!"), caret), { start: 4, end: 4 });
  // The character before the caret goes away: the caret stays where it was.
  assert.deepEqual(resolveTitleSelection(remove(A.clone(doc), 3, 1), caret), { start: 3, end: 3 });
  // A caret at the start has no character before it and follows the first one.
  const start = captureTitleSelection(doc, 0);
  assert.deepEqual(resolveTitleSelection(type(A.clone(doc), 0, "X"), start), { start: 1, end: 1 });
  const end = captureTitleSelection(A.from({ title: "" }), 0);
  assert.deepEqual(resolveTitleSelection(A.from({ title: "" }), end), { start: 0, end: 0 });
});

test("a title selection keeps both ends through a peer's edit", () => {
  const doc = A.from({ title: "Plan B" });
  const selected = captureTitleSelection(doc, 0, 4);
  assert.deepEqual(resolveTitleSelection(type(A.clone(doc), 0, "My "), selected), {
    start: 3,
    end: 7,
  });
  assert.equal(resolveTitleSelection(doc, null), null);
  assert.equal(captureTitleSelection({}, 0), null);
});

test("a title edit splices where the caret says, even inside repeated characters", () => {
  // A second space typed before the first one, caret after it.
  assert.deepEqual(titleSplice("Notes: x", "Notes:  x", 7), { index: 6, remove: 0, insert: " " });
  assert.deepEqual(titleSplice("Notes: x", "Notes:  x", 8), { index: 7, remove: 0, insert: " " });
  assert.deepEqual(titleSplice("aaa", "aaaa", 1), { index: 0, remove: 0, insert: "a" });
  // Deletion and replacement of a selection.
  assert.deepEqual(titleSplice("Plan B", "Pla B", 3), { index: 3, remove: 1, insert: "" });
  assert.deepEqual(titleSplice("Plan B", "Plan C", 6), { index: 5, remove: 1, insert: "C" });
  assert.deepEqual(titleSplice("Plan B", "Plan B", 6), { index: 6, remove: 0, insert: "" });
  // A caret that can't end the edit falls back to a whole-text update.
  assert.equal(titleSplice("abc", "xyz", 1), null);
  assert.equal(titleSplice("abc", "abcd", 9), null);
});

test("the spliced title keeps the typed character on its writer's side", () => {
  const base = A.from({ title: "Notes:" });
  // The peer's space arrived first; this writer types a space before it.
  const peer = type(A.clone(base, { actor: "ff".repeat(16) }), 6, " ");
  const local = A.merge(A.clone(base, { actor: "00".repeat(16) }), peer);
  const edit = titleSplice(local.title, "Notes:  ", 7);
  const next = A.change(local, (d) => A.splice(d, ["title"], edit.index, edit.remove, edit.insert));
  const peerSpace = A.getCursorPosition(next, ["title"], A.getCursor(peer, ["title"], 6));
  assert.equal(peerSpace, 7, "the peer's space stays after the new one");
});

test("a title caret next to an emoji stays on a code point boundary", () => {
  const doc = A.from({ title: "Wave 🌊" });
  // Caret after the emoji (UTF-16 offset 7) sticks to the whole emoji.
  const caret = captureTitleSelection(doc, 7);
  assert.deepEqual(resolveTitleSelection(type(A.clone(doc), 7, "x"), caret), { start: 7, end: 7 });
  assert.deepEqual(resolveTitleSelection(type(A.clone(doc), 0, "🌍"), caret), { start: 9, end: 9 });
  // The emoji is deleted: the caret stays where the emoji started.
  assert.deepEqual(resolveTitleSelection(remove(A.clone(doc), 5, 2), caret), { start: 5, end: 5 });
});

test("a keystroke typed before React shows a peer's title change keeps both", () => {
  const shown = A.from({ title: "Notes: Bet" });
  const base = snapshot(shown, 10);
  // The peer's text reached the document; the input still shows `shown`.
  const after = commit(type(A.clone(shown), 10, " Alpha"), base, "Notes: Beta", 11);
  assert.equal(after.doc.title, "Notes: Beta Alpha");
  assert.equal(after.caret, 11);
  const before = commit(type(A.clone(shown), 0, "My "), base, "Notes: Beta", 11);
  assert.equal(before.doc.title, "My Notes: Beta");
  assert.equal(before.caret, 14);
  // A peer deleting the word this writer extends leaves the new character.
  const removed = commit(remove(A.clone(shown), 7, 3), base, "Notes: Beta", 11);
  assert.equal(removed.doc.title, "Notes: a");
  assert.equal(removed.caret, 8);
});

test("without a usable base the edit reads against the current title", () => {
  const doc = A.from({ title: "Plan" });
  const expected = { heads: null, edit: { index: 4, remove: 0, insert: "s" } };
  assert.deepEqual(titleChange(doc, null, "Plans", 5), expected);
  assert.deepEqual(
    titleChange(doc, { value: "Other", heads: A.getHeads(doc) }, "Plans", 5),
    expected,
  );
  assert.deepEqual(
    titleChange(doc, { value: "Plan", heads: ["0".repeat(64)] }, "Plans", 5),
    expected,
  );
  assert.equal(titleChange(doc, null, "xyz", 1), null);
});

test("a replacement never deletes a peer's unseen text", () => {
  // "AB": the writer replaces "A" with "日" (input "日B", caret 1).
  const shown = A.from({ title: "AB" });
  const base = snapshot(shown, 1);
  // A peer prepends.
  const prepend = commit(type(A.clone(shown), 0, "X"), base, "日B", 1);
  assert.ok(prepend.doc.title === "X日B" || prepend.doc.title === "日XB", prepend.doc.title);
  assert.equal(prepend.doc.title[prepend.caret - 1], "日");
  // A peer inserts inside the replaced range.
  const wide = A.from({ title: "ABC" });
  const inside = commit(type(A.clone(wide), 1, "x"), snapshot(wide, 2), "日C", 1);
  assert.ok(inside.doc.title.includes("x") && inside.doc.title.endsWith("C"), inside.doc.title);
  assert.ok(!/[AB]/.test(inside.doc.title), inside.doc.title);
  assert.equal(inside.doc.title[inside.caret - 1], "日");
  // A peer appends.
  const append = commit(type(A.clone(shown), 2, "!"), base, "日B", 1);
  assert.equal(append.doc.title, "日B!");
  assert.equal(append.caret, 1);
});

test("a stale title splice next to an emoji keeps the peer's emoji whole", () => {
  const shown = A.from({ title: "Go 🌊" });
  const after = commit(type(A.clone(shown), 5, "🌍"), snapshot(shown, 5), "Go 🌊!", 6);
  assert.equal(after.doc.title, "Go 🌊!🌍");
  assert.equal(after.caret, 6);
  // Replacing one emoji with another that shares its high surrogate.
  assert.deepEqual(titleSplice("a🌊", "a🌍", 3), { index: 1, remove: 2, insert: "🌍" });
});

test("the caret follows the applied splice when a stale edit kept a peer's text", () => {
  const shown = A.from({ title: "Plan" });
  const base = snapshot(shown, 4);
  const doc = type(A.clone(shown), 0, "My ");
  // The input lags, so a selection change captures against what it shows.
  const lagging = titleSnapshot(doc, base, "Plan", 4);
  assert.deepEqual(lagging.heads, base.heads);
  assert.deepEqual(resolveTitleSelection(doc, lagging.cursors), { start: 7, end: 7 });
  const after = commit(doc, lagging, "Plans", 5);
  assert.equal(after.doc.title, "My Plans");
  assert.equal(after.caret, 8);
  // An input value that matches no known revision keeps the last snapshot.
  const shownNow = titleSnapshot(after.doc, lagging, after.doc.title, after.caret);
  assert.equal(titleSnapshot(after.doc, shownNow, "unrelated", 2), shownNow);
});

// The input lifecycle: events in, state and effect out.
const run = (events, state = TITLE_IDLE) => {
  const effects = [];
  for (const event of events) {
    const step = titleInput(state, event);
    state = step.state;
    effects.push(step.effect);
  }
  return { state, effects };
};
const base = { value: "Notes", heads: [] };

test("a composition commits once, on compositionend, against its first base", () => {
  const { state, effects } = run([
    { type: "compositionstart", session: "s", base, value: "Notes" },
    { type: "input", session: "s", composing: true, base: { value: "other" }, value: "Notes か" },
    { type: "compositionstart", session: "s", base: { value: "later" }, value: "Notes か" },
    { type: "input", session: "s", composing: true, base: null, value: "Notes 漢" },
    { type: "compositionend", session: "s" },
  ]);
  assert.equal(state, TITLE_IDLE);
  assert.deepEqual(effects, [null, null, null, null, { type: "commit", base }]);
});

test("a composition with no compositionend ends on the next plain input", () => {
  const { state, effects } = run([
    { type: "input", session: "s", composing: true, base, value: "Notes か" },
    { type: "input", session: "s", composing: true, base: null, value: "Notes 漢" },
    // No compositionend: the browser sends a plain input event instead.
    { type: "input", session: "s", composing: false, base: { value: "x" }, value: "Notes 漢" },
    // The next keystroke is an ordinary splice with its own base.
    {
      type: "input",
      session: "s",
      composing: false,
      base: { value: "Notes 漢" },
      value: "Notes 漢!",
    },
  ]);
  assert.equal(state, TITLE_IDLE);
  assert.deepEqual(effects, [
    null,
    null,
    { type: "commit", base },
    { type: "commit", base: { value: "Notes 漢" } },
  ]);
});

test("a composition with no compositionend ends on blur", () => {
  const start = { type: "compositionstart", session: "s", base, value: "Notes" };
  const composed = run([
    start,
    { type: "input", session: "s", composing: true, value: "Notes 漢" },
    { type: "blur", session: "s", value: "Notes 漢" },
  ]);
  assert.equal(composed.state, TITLE_IDLE);
  assert.deepEqual(composed.effects.at(-1), { type: "commit", base });
  // Nothing composed: blur only clears the state; React shows the doc again.
  const empty = run([start, { type: "blur", session: "s", value: "Notes" }]);
  assert.equal(empty.state, TITLE_IDLE);
  assert.equal(empty.effects.at(-1), null);
  // Blur and compositionend while idle do nothing.
  assert.deepEqual(
    run([{ type: "blur", session: "s", value: "x" }, { type: "compositionend" }]).effects,
    [null, null],
  );
});

test("composition events from another Page and resets leave the right state", () => {
  let { state } = run([{ type: "compositionstart", session: "one", base, value: "Notes" }]);
  assert.equal(composingTitle(state, "one"), true);
  assert.equal(composingTitle(state, "two"), false);
  // Another Page's input starts its own composition only if it composes.
  const other = titleInput(state, {
    type: "input",
    session: "two",
    composing: false,
    base: null,
    value: "q",
  });
  assert.deepEqual(other.effect, { type: "commit", base: null });
  assert.equal(titleInput(state, { type: "reset" }).state, TITLE_IDLE);
});

test("a peer's title edit during a composition merges when the composition ends", () => {
  let doc = A.from({ title: "Notes" });
  const shown = snapshot(doc, 5);
  let { state } = run([{ type: "compositionstart", session: "s", base: shown, value: "Notes" }]);
  for (const value of ["Notes k", "Notes か", "Notes 漢"])
    state = titleInput(state, { type: "input", session: "s", composing: true, value }).state;
  doc = type(doc, 0, "My ");
  const ended = titleInput(state, { type: "compositionend" });
  const after = commit(doc, ended.effect.base, "Notes 漢", 7);
  assert.equal(after.doc.title, "My Notes 漢");
  assert.equal(after.caret, 10);
  // A composed replacement mid-title with a peer appending.
  const ab = A.from({ title: "AB" });
  const mid = commit(type(A.clone(ab), 2, "!"), snapshot(ab, 1), "A日B", 2);
  assert.equal(mid.doc.title, "A日B!");
  assert.equal(mid.caret, 2);
});
