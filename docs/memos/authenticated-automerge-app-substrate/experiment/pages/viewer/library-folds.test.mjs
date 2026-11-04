import assert from "node:assert/strict";
import test from "node:test";
import {
  FOLDS_KEY,
  FOLD_KINDS,
  MAX_FOLDS,
  MAX_FOLD_ACCOUNTS,
  MAX_FOLD_KEY_LENGTH,
  NO_FOLDS,
  allFolded,
  anyFolded,
  boundFolds,
  foldAll,
  readFolds,
  toggleFold,
  unfoldAll,
  writeFolds,
} from "./library-folds.mjs";

function memoryBrowser(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    localStorage: {
      getItem: (key) => (values.has(key) ? values.get(key) : null),
      setItem: (key, value) => void values.set(key, String(value)),
      removeItem: (key) => void values.delete(key),
    },
  };
}
const blockedBrowser = () => ({
  get localStorage() {
    throw new Error("blocked");
  },
});
const stored = (browser) => JSON.parse(browser.values.get(FOLDS_KEY));
const LAUNCH = "project:prj_2b160b47-6df1-4983-81eb-489ca5a26812";
const NOTES = "project:prj_3b160b47-6df1-4983-81eb-489ca5a26812";

test("the key and the groupings that fold are the stored contract", () => {
  assert.equal(FOLDS_KEY, "nteract.pages.folds");
  assert.deepEqual(FOLD_KINDS, ["project", "date"]);
  assert.deepEqual(NO_FOLDS, { project: [], date: [] });
});

test("toggling folds an open group and opens a folded one, newest last", () => {
  let folds = toggleFold([], LAUNCH);
  assert.deepEqual(folds, [LAUNCH]);
  folds = toggleFold(folds, "shared");
  assert.deepEqual(folds, [LAUNCH, "shared"]);
  folds = toggleFold(folds, LAUNCH);
  assert.deepEqual(folds, ["shared"]);
  assert.ok(Object.isFrozen(folds));
  assert.deepEqual(toggleFold(folds, ""), ["shared"], "an empty key changes nothing");
  assert.deepEqual(toggleFold(folds, null), ["shared"]);
});

test("Fold all folds the shown groups; Unfold all opens every group, shown or not", () => {
  const folds = foldAll([NOTES], [LAUNCH, "items", NOTES]);
  assert.deepEqual(folds, [LAUNCH, "items", NOTES]);
  assert.equal(allFolded(folds, [LAUNCH, "items"]), true);
  assert.equal(allFolded(folds, [LAUNCH, "shared"]), false);
  assert.equal(allFolded(folds, []), false, "nothing shown is nothing to fold");
  assert.equal(anyFolded(folds, ["shared"]), false);
  assert.equal(anyFolded(folds, ["shared", "items"]), true);
  assert.deepEqual(unfoldAll(folds), []);
});

test("a fold list keeps each valid key once and at most the newest MAX_FOLDS", () => {
  assert.deepEqual(boundFolds(["a", "b", "a"]), ["b", "a"], "a repeat moves to its latest place");
  assert.deepEqual(boundFolds(["a", 3, null, "", "x".repeat(MAX_FOLD_KEY_LENGTH + 1)]), ["a"]);
  assert.deepEqual(boundFolds("today"), []);
  const many = Array.from({ length: MAX_FOLDS + 10 }, (_, index) => `m:${index}`);
  const bounded = boundFolds(many);
  assert.equal(bounded.length, MAX_FOLDS);
  assert.equal(bounded[0], "m:10", "the oldest folds go first");
  assert.equal(bounded.at(-1), `m:${MAX_FOLDS + 9}`);
});

test("folds are stored per account and grouping, and read back", () => {
  const browser = memoryBrowser();
  assert.deepEqual(readFolds(browser, "user:alice"), NO_FOLDS);
  assert.deepEqual(writeFolds(browser, "user:alice", "project", [LAUNCH]), [LAUNCH]);
  writeFolds(browser, "user:alice", "date", ["today"]);
  writeFolds(browser, "user:bob", "project", [NOTES]);
  assert.deepEqual(readFolds(browser, "user:alice"), { project: [LAUNCH], date: ["today"] });
  assert.deepEqual(readFolds(browser, "user:bob"), { project: [NOTES], date: [] });
  assert.deepEqual(readFolds(browser, "user:carol"), NO_FOLDS);
  // Opening every group drops the grouping, then the account, then the entry.
  writeFolds(browser, "user:alice", "date", []);
  assert.deepEqual(stored(browser).accounts.find(([name]) => name === "user:alice")[1], {
    project: [LAUNCH],
  });
  writeFolds(browser, "user:alice", "project", []);
  writeFolds(browser, "user:bob", "project", []);
  assert.equal(browser.values.has(FOLDS_KEY), false);
});

test("at most MAX_FOLD_ACCOUNTS accounts are kept, the least recently written going first", () => {
  const browser = memoryBrowser();
  for (let index = 0; index <= MAX_FOLD_ACCOUNTS; index++)
    writeFolds(browser, `user:${index}`, "project", [LAUNCH]);
  assert.equal(stored(browser).accounts.length, MAX_FOLD_ACCOUNTS);
  assert.deepEqual(readFolds(browser, "user:0"), NO_FOLDS);
  assert.deepEqual(readFolds(browser, `user:${MAX_FOLD_ACCOUNTS}`).project, [LAUNCH]);
  // Writing again makes an account the most recent.
  writeFolds(browser, "user:1", "date", ["today"]);
  writeFolds(browser, "user:new", "project", [NOTES]);
  assert.deepEqual(readFolds(browser, "user:1"), { project: [LAUNCH], date: ["today"] });
  assert.deepEqual(readFolds(browser, "user:2"), NO_FOLDS);
});

test("an unknown account, an unknown grouping or blocked storage folds for this visit only", () => {
  const browser = memoryBrowser();
  assert.deepEqual(writeFolds(browser, null, "project", [LAUNCH]), [LAUNCH]);
  assert.equal(browser.values.has(FOLDS_KEY), false);
  assert.deepEqual(readFolds(browser, null), NO_FOLDS);
  assert.equal(writeFolds(browser, "user:alice", "title", [LAUNCH]), null);
  assert.equal(browser.values.has(FOLDS_KEY), false);
  assert.deepEqual(writeFolds(blockedBrowser(), "user:alice", "project", [LAUNCH]), [LAUNCH]);
  assert.deepEqual(readFolds(blockedBrowser(), "user:alice"), NO_FOLDS);
  const full = memoryBrowser();
  full.localStorage.setItem = () => {
    throw new Error("QuotaExceededError");
  };
  assert.deepEqual(writeFolds(full, "user:alice", "date", ["today"]), ["today"]);
  assert.deepEqual(writeFolds(undefined, "user:alice", "date", ["today"]), ["today"]);
});

test("a stored entry this build can't read counts as no folds", () => {
  for (const raw of [
    "not json",
    "null",
    JSON.stringify({ v: 2, accounts: [["user:alice", { project: [LAUNCH] }]] }),
    JSON.stringify({ v: 1, accounts: "user:alice" }),
    JSON.stringify({ v: 1, accounts: [["user:alice", null]] }),
  ])
    assert.deepEqual(readFolds(memoryBrowser({ [FOLDS_KEY]: raw }), "user:alice"), NO_FOLDS, raw);
  const mixed = memoryBrowser({
    [FOLDS_KEY]: JSON.stringify({
      v: 1,
      accounts: [["user:alice", { project: [LAUNCH, 7, ""], date: "today", title: ["x"] }]],
    }),
  });
  assert.deepEqual(readFolds(mixed, "user:alice"), { project: [LAUNCH], date: [] });
});
