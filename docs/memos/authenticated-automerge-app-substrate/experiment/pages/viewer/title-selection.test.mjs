import test from "node:test";
import assert from "node:assert/strict";
import * as A from "@automerge/automerge";
import {
  TITLE_IDLE,
  TITLE_MAX_LENGTH,
  captureTitleSelection,
  composingTitle,
  resolveTitleSelection,
  titleChange,
  titleInput,
  titleSnapshot,
  titleSplice,
  writeTitle,
} from "./title-selection.mjs";

const type = (doc, at, text) => A.change(doc, (d) => A.splice(d, ["title"], at, 0, text));
const remove = (doc, at, count) => A.change(doc, (d) => A.splice(d, ["title"], at, count));

// Fixed actors: the writer's tab, and peers that sort before and after it,
// so concurrent inserts at one spot are covered in both orders.
const WRITER = "88".repeat(16);
const PEERS = ["00".repeat(16), "ff".repeat(16)];
const writer = (title) => A.from({ title }, { actor: WRITER });
// A peer's edit made in its own replica (its own actor) and merged into the
// writer's. Reusing the writer's actor would make two concurrent changes
// from one actor, which Automerge can't represent.
const peerEdit = (doc, actor, fn) =>
  A.merge(A.clone(doc, { actor: WRITER }), A.change(A.clone(doc, { actor }), fn));
const peerType = (doc, actor, at, text) =>
  peerEdit(doc, actor, (d) => A.splice(d, ["title"], at, 0, text));
const peerRemove = (doc, actor, at, count) =>
  peerEdit(doc, actor, (d) => A.splice(d, ["title"], at, count));

// What main.jsx's commitTitle does: the edit read at the input's revision
// and written to the current document. The result must read the same after
// a save and load.
function commit(doc, base, value, caret) {
  const plan = titleChange(doc, base, value, caret);
  assert.ok(plan);
  const next = A.change(A.clone(doc, { actor: WRITER }), (d) => writeTitle(d, plan.edits));
  assert.equal(A.load(A.save(next)).title, next.title, "the result survives save and load");
  return { doc: next, caret: plan.caret, plan };
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
  for (const peer of PEERS) {
    const shown = writer("Notes: Bet");
    const base = snapshot(shown, 10);
    const after = commit(peerType(shown, peer, 10, " Alpha"), base, "Notes: Beta", 11);
    assert.equal(after.doc.title, "Notes: Beta Alpha");
    assert.equal(after.caret, 11);
    const before = commit(peerType(shown, peer, 0, "My "), base, "Notes: Beta", 11);
    assert.equal(before.doc.title, "My Notes: Beta");
    assert.equal(before.caret, 14);
    // A peer deleting the word this writer extends leaves the new character.
    const removed = commit(peerRemove(shown, peer, 7, 3), base, "Notes: Beta", 11);
    assert.equal(removed.doc.title, "Notes: a");
    assert.equal(removed.caret, 8);
  }
});

test("without a usable base the edit reads against the current title", () => {
  const doc = writer("Plan");
  const expected = { edits: [{ index: 4, remove: 0, insert: "s" }], caret: 5, work: 0 };
  assert.deepEqual(titleChange(doc, null, "Plans", 5), expected);
  assert.deepEqual(
    titleChange(doc, { value: "Other", heads: A.getHeads(doc) }, "Plans", 5),
    expected,
  );
  assert.deepEqual(
    titleChange(doc, { value: "Plan", heads: ["0".repeat(64)] }, "Plans", 5),
    expected,
  );
  // A value the caret can't place is read as a diff that keeps shared text.
  const rewritten = commit(doc, null, "xyz", 1);
  assert.equal(rewritten.doc.title, "xyz");
  assert.equal(rewritten.caret, 1);
  const kept = commit(doc, null, "aPlanb", 1);
  assert.equal(kept.doc.title, "aPlanb");
  assert.deepEqual(titleChange(doc, null, "aPlanb", 1).edits, [
    { index: 4, remove: 0, insert: "b" },
    { index: 0, remove: 0, insert: "a" },
  ]);
  assert.equal(titleChange({}, null, "xyz", 1), null);
});

test("a replacement never deletes a peer's unseen text", () => {
  for (const peer of PEERS) {
    // "AB": the writer replaces "A" with "日" (input "日B", caret 1).
    const shown = writer("AB");
    const base = snapshot(shown, 1);
    const prepend = commit(peerType(shown, peer, 0, "X"), base, "日B", 1);
    assert.ok(["X日B", "日XB"].includes(prepend.doc.title), prepend.doc.title);
    assert.equal(prepend.doc.title[prepend.caret - 1], "日");
    // A peer inserts inside the replaced range.
    const wide = writer("ABC");
    const inside = commit(peerType(wide, peer, 1, "x"), snapshot(wide, 2), "日C", 1);
    assert.ok(["x日C", "日xC"].includes(inside.doc.title), inside.doc.title);
    assert.equal(inside.doc.title[inside.caret - 1], "日");
    const append = commit(peerType(shown, peer, 2, "!"), base, "日B", 1);
    assert.equal(append.doc.title, "日B!");
    assert.equal(append.caret, 1);
  }
});

test("an edit that fits no splice still never deletes a peer's unseen text", () => {
  // The input shows "AB". A composition with no compositionend makes it
  // "A日B"; a peer prepends "X"; the writer presses Home and types "Q". The
  // next plain input commits "QA日B" with the caret at 1, which no single
  // splice from "AB" produces.
  for (const peer of PEERS) {
    const shown = writer("AB");
    const base = snapshot(shown, 1);
    const doc = peerType(shown, peer, 0, "X");
    const after = commit(doc, base, "QA日B", 1);
    assert.ok(["XQA日B", "QXA日B"].includes(after.doc.title), after.doc.title);
    assert.equal(after.doc.title[after.caret - 1], "Q");
    // With unknown heads the diff runs against the current title.
    const unknown = commit(doc, { value: "AB", heads: ["0".repeat(64)] }, "QA日B", 1);
    assert.equal(unknown.doc.title, "QA日B");
  }
});

test("a stale edit around this tab's own later changes merges cleanly", () => {
  for (const peer of PEERS) {
    const shown = writer("AB");
    const base = snapshot(shown, 1);
    // After the snapshot this tab wrote elsewhere in the Page, then a peer
    // prepended to the title.
    const own = A.change(A.clone(shown, { actor: WRITER }), (d) => {
      d.body = "typed in the body";
    });
    const doc = peerType(own, peer, 0, "X");
    for (const [value, expected] of [
      ["日B", "X日B"],
      ["QA日B", "XQA日B"],
    ]) {
      const after = commit(doc, base, value, 1);
      assert.equal(after.doc.title, expected);
      assert.equal(after.doc.body, "typed in the body");
    }
  }
});

test("a stale edit maps the caret before, inside and after its inserted text", () => {
  for (const peer of PEERS) {
    const shown = writer("one two");
    const base = snapshot(shown, 7);
    const doc = peerType(shown, peer, 0, ">> ");
    // A plain diff "one two" -> "one 2 two" inserts "2 " at 4.
    for (const [caret, landed] of [
      [2, 5],
      [5, 8],
      [6, 9],
      [9, 12],
    ])
      assert.equal(commit(doc, base, "one 2 two", caret).caret, landed, `caret ${caret}`);
    assert.equal(commit(doc, base, "one 2 two", 6).doc.title, ">> one 2 two");
  }
});

test("a stale title splice next to an emoji keeps the peer's emoji whole", () => {
  for (const peer of PEERS) {
    const shown = writer("Go 🌊");
    const after = commit(peerType(shown, peer, 5, "🌍"), snapshot(shown, 5), "Go 🌊!", 6);
    assert.equal(after.doc.title, "Go 🌊!🌍");
    assert.equal(after.caret, 6);
  }
  // Replacing one emoji with another that shares its high surrogate.
  assert.deepEqual(titleSplice("a🌊", "a🌍", 3), { index: 1, remove: 2, insert: "🌍" });
});

test("the caret follows the applied splice when a stale edit kept a peer's text", () => {
  for (const peer of PEERS) {
    const shown = writer("Plan");
    const base = snapshot(shown, 4);
    const doc = peerType(shown, peer, 0, "My ");
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
  }
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
  let doc = writer("Notes");
  const shown = snapshot(doc, 5);
  let { state } = run([{ type: "compositionstart", session: "s", base: shown, value: "Notes" }]);
  for (const value of ["Notes k", "Notes か", "Notes 漢"])
    state = titleInput(state, { type: "input", session: "s", composing: true, value }).state;
  doc = peerType(doc, PEERS[0], 0, "My ");
  const ended = titleInput(state, { type: "compositionend" });
  const after = commit(doc, ended.effect.base, "Notes 漢", 7);
  assert.equal(after.doc.title, "My Notes 漢");
  assert.equal(after.caret, 10);
  // A composed replacement mid-title with a peer appending.
  const ab = writer("AB");
  const mid = commit(peerType(ab, PEERS[1], 2, "!"), snapshot(ab, 1), "A日B", 2);
  assert.equal(mid.doc.title, "A日B!");
  assert.equal(mid.caret, 2);
});

test("random stale edits keep every peer insertion and every typed character", () => {
  // A small seeded generator, so a failure names its case.
  let seed = 7;
  const random = (n) => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const pick = (text) => text[random(text.length)];
  for (let round = 0; round < 300; round++) {
    const peer = PEERS[round % 2];
    const shownText = Array.from({ length: 1 + random(6) }, () => pick(["a", "b", "🌊"])).join("");
    const shown = writer(shownText);
    const units = Array.from(shownText);
    // The writer deletes some characters and types lowercase "q" and "日".
    const kept = units.filter(() => random(4) !== 0);
    const typed = [];
    const value = [];
    for (let k = 0; k <= kept.length; k++) {
      if (random(3) === 0) {
        const c = pick(["q", "日"]);
        typed.push(c);
        value.push(c);
      }
      if (k < kept.length) value.push(kept[k]);
    }
    const valueText = value.join("");
    // The peer inserts distinct capitals the writer never types.
    let doc = shown;
    const inserted = [];
    for (let k = 0; k < 1 + random(3); k++) {
      const c = "XYZ"[k];
      inserted.push(c);
      doc = peerType(doc, peer, random(doc.title.length + 1), c);
    }
    const caret = random(valueText.length + 1);
    const label = `round ${round}: "${shownText}" -> "${valueText}" with peer "${doc.title}"`;
    const after = commit(doc, snapshot(shown, 0), valueText, caret);
    for (const c of inserted)
      assert.equal(
        after.doc.title.split(c).length - 1,
        1,
        `${label}: peer ${c} -> "${after.doc.title}"`,
      );
    // Without the peer's characters, the title is exactly what the writer
    // typed, in the writer's order.
    assert.equal(
      after.doc.title.replace(/[XYZ]/g, ""),
      valueText,
      `${label} -> "${after.doc.title}"`,
    );
    const count = (text, c) => Array.from(text).filter((x) => x === c).length;
    for (const c of ["q", "日"])
      assert.equal(count(after.doc.title, c), count(valueText, c), `${label}: typed ${c}`);
    for (const c of ["a", "b", "🌊"])
      assert.equal(count(after.doc.title, c), count(valueText, c), `${label}: kept ${c}`);
    assert.ok(after.caret >= 0 && after.caret <= after.doc.title.length, label);
    // The caret follows the code point before it in the input.
    const before = (text, at) => (at > 0 ? Array.from(text.slice(0, at)).at(-1) : null);
    if (caret > 0)
      assert.equal(
        before(after.doc.title, after.caret),
        before(valueText, caret),
        `${label}: caret ${caret} -> ${after.caret} in "${after.doc.title}"`,
      );
  }
});

test("a peer deleting the characters between runs collapses their anchors in order", () => {
  for (const peer of PEERS) {
    // The writer typed "1", "2" and "3" between the input's "abcd"; the
    // caret is after "2".
    const shown = writer("abcd");
    const base = snapshot(shown, 4);
    // The peer deleted "bc", the anchors of "2" and "3".
    const middle = commit(peerRemove(shown, peer, 1, 2), base, "a1b2c3d", 4);
    assert.equal(middle.doc.title, "a123d");
    assert.equal(middle.caret, 3);
    // The peer deleted every character: all three runs land at the start.
    const all = commit(peerRemove(shown, peer, 0, 4), base, "a1b2c3d", 4);
    assert.equal(all.doc.title, "123");
    assert.equal(all.caret, 2);
    // The writer also deleted "d" while the peer deleted "bc".
    const both = commit(peerRemove(shown, peer, 1, 2), base, "a1b2c3", 4);
    assert.equal(both.doc.title, "a123");
    assert.equal(both.caret, 3);
  }
});

test("two long unrelated titles skip the quadratic diff", () => {
  for (const peer of PEERS) {
    const length = 10_000;
    const fromText = "ab".repeat(length / 2),
      valueText = "xy".repeat(length / 2);
    const shown = writer(fromText);
    // A peer prepends while the input still shows the old title.
    const doc = peerType(shown, peer, 0, "P");
    const started = performance.now();
    const plan = titleChange(doc, snapshot(shown, 0), valueText, 3);
    const elapsed = performance.now() - started;
    assert.equal(plan.work, 0, "no diff table");
    const after = commit(doc, snapshot(shown, 0), valueText, 3);
    assert.equal(after.doc.title, "P" + valueText);
    assert.equal(after.caret, 4);
    assert.ok(elapsed < 2000, `${elapsed} ms`);
  }
  // At the title limit, unrelated titles still get the full diff.
  const near = writer("ab".repeat(TITLE_MAX_LENGTH / 2));
  const plan = titleChange(near, null, "ba".repeat(TITLE_MAX_LENGTH / 2), 1);
  assert.ok(plan.work > 0 && plan.work <= TITLE_MAX_LENGTH * TITLE_MAX_LENGTH, `${plan.work}`);
});

test("equal title text with different characters reads the shown revision", () => {
  for (const peer of PEERS) {
    // The input shows "AAA". A peer deleted the first A and appended one,
    // so the text is "AAA" again, with different characters.
    const shown = writer("AAA");
    const base = snapshot(shown, 1);
    const doc = peerEdit(shown, peer, (d) => {
      A.splice(d, ["title"], 0, 1);
      A.splice(d, ["title"], 2, 0, "A");
    });
    assert.equal(doc.title, "AAA");
    // The writer deleted that same first A: the peer already removed it, so
    // nothing more is deleted and the peer's new A stays.
    const after = commit(doc, base, "AA", 0);
    assert.equal(after.doc.title, "AAA");
    assert.equal(after.caret, 0);
    // The writer deleted the last shown A instead: that one goes.
    const last = commit(doc, snapshot(shown, 3), "AA", 2);
    assert.equal(last.doc.title, "AA");
    assert.equal(last.caret, 1);
  }
});
