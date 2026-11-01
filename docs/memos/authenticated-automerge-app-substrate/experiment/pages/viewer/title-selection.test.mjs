import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  captureTitleSelection,
  resolveTitleSelection,
  titleEdit,
  titleSplice,
} from "./title-selection.mjs";

const type = (doc, at, text) => A.change(doc, (d) => A.splice(d, ["title"], at, 0, text));
const remove = (doc, at, count) => A.change(doc, (d) => A.splice(d, ["title"], at, count));

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

const apply = (doc, edit) =>
  A.change(doc, (d) => A.splice(d, ["title"], edit.index, edit.remove, edit.insert));

test("a keystroke typed before React shows a peer's title change keeps both", () => {
  const shown = A.from({ title: "Notes: Bet" });
  const base = { value: shown.title, heads: A.getHeads(shown) };
  // The peer's text reached the document; the input still shows `shown`.
  const doc = type(A.clone(shown), 10, " Alpha");
  const edit = titleEdit(doc, base, "Notes: Beta", 11);
  assert.equal(apply(doc, edit).title, "Notes: Beta Alpha");
  // A peer's text before the caret moves the edit with it.
  const before = type(A.clone(shown), 0, "My ");
  assert.equal(apply(before, titleEdit(before, base, "Notes: Beta", 11)).title, "My Notes: Beta");
  // A peer deleting the word this writer extends leaves the new character.
  const removed = remove(A.clone(shown), 7, 3);
  assert.equal(apply(removed, titleEdit(removed, base, "Notes: Beta", 11)).title, "Notes: a");
});

test("without a usable base the edit reads against the current title", () => {
  const doc = A.from({ title: "Plan" });
  assert.deepEqual(titleEdit(doc, null, "Plans", 5), { index: 4, remove: 0, insert: "s" });
  const stale = { value: "Other", heads: A.getHeads(doc) };
  assert.deepEqual(titleEdit(doc, stale, "Plans", 5), { index: 4, remove: 0, insert: "s" });
  assert.deepEqual(titleEdit(doc, { value: "Plan", heads: ["0".repeat(64)] }, "Plans", 5), {
    index: 4,
    remove: 0,
    insert: "s",
  });
});
