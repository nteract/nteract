import assert from "node:assert/strict";
import { test } from "node:test";
import { LIST, groupByHeading, navigate, position } from "./comment-nav.mjs";

const ids = ["a", "b", "c"];

test("open drills in and back restores the list scroll", () => {
  const thread = navigate({ name: "list", scroll: 0 }, { type: "open", id: "b", scroll: 240 });
  assert.deepEqual(thread, { name: "thread", id: "b", listScroll: 240 });
  assert.deepEqual(navigate(thread, { type: "back" }), { name: "list", scroll: 240 });
});

test("show from a passage keeps the list scroll saved before the first drill-in", () => {
  const first = navigate({ name: "list", scroll: 90 }, { type: "show", id: "a" });
  const second = navigate(first, { type: "show", id: "c" });
  assert.deepEqual(second, { name: "thread", id: "c", listScroll: 90 });
  assert.equal(navigate(second, { type: "show", id: "c" }), second, "same thread is a no-op");
});

test("step moves within ids and stops at either end", () => {
  const at = (id) => ({ name: "thread", id, listScroll: 0 });
  assert.equal(navigate(at("a"), { type: "step", by: 1, ids }).id, "b");
  assert.equal(navigate(at("c"), { type: "step", by: 1, ids }).id, "c");
  assert.equal(navigate(at("a"), { type: "step", by: -1, ids }).id, "a");
  assert.equal(navigate(LIST, { type: "step", by: 1, ids }), LIST);
});

test("sync drops to the list when the open thread disappears", () => {
  const state = { name: "thread", id: "b", listScroll: 12 };
  assert.equal(navigate(state, { type: "sync", ids }), state);
  assert.deepEqual(navigate(state, { type: "sync", ids: ["a"] }), { name: "list", scroll: 12 });
});

test("every state ignores events that don't apply", () => {
  for (const state of [LIST, { name: "thread", id: "a", listScroll: 0 }]) {
    assert.equal(navigate(state, { type: "unknown" }), state);
    assert.equal(navigate(state, { type: "open" }), state);
    assert.equal(navigate(state, { type: "show" }), state);
  }
  assert.equal(navigate(LIST, { type: "back" }), LIST);
});

test("position reports n of m only for a known thread", () => {
  assert.deepEqual(position({ name: "thread", id: "b" }, ids), { index: 2, total: 3 });
  assert.equal(position({ name: "thread", id: "z" }, ids), null);
  assert.equal(position(LIST, ids), null);
});

test("groupByHeading orders by document and groups consecutive headings", () => {
  const where = {
    t1: { order: [3, 0], headings: ["Intro"] },
    t2: { order: [1, 5], headings: ["Intro"] },
    t3: { order: [7, 0], headings: ["Intro", "Details"] },
    t4: { order: [9, 0], headings: [], blockSurvives: false },
    t5: { order: [0, 0], headings: [] },
  };
  const groups = groupByHeading(
    Object.keys(where).map((id) => ({ id })),
    (t) => where[t.id],
  );
  assert.deepEqual(
    groups.map((g) => [g.heading, g.threads.map((t) => t.id)]),
    [
      ["", ["t5"]],
      ["Intro", ["t2", "t1"]],
      ["Details", ["t3"]],
      [null, ["t4"]],
    ],
  );
});

test("review enters from any state, keeps its mode while moving, and exits to the thread", () => {
  const review = navigate({ name: "list", scroll: 40 }, { type: "review", id: "a" });
  assert.deepEqual(review, { name: "review", id: "a", listScroll: 40 });
  assert.equal(navigate(review, { type: "step", by: 1, ids }).name, "review");
  assert.deepEqual(navigate(review, { type: "go", id: "c" }), { ...review, id: "c" });
  assert.deepEqual(navigate(review, { type: "show", id: "b" }), { ...review, id: "b" });
  assert.deepEqual(navigate(review, { type: "exit" }), { name: "thread", id: "a", listScroll: 40 });
  assert.deepEqual(navigate(review, { type: "back" }), { name: "list", scroll: 40 });
  assert.deepEqual(navigate(review, { type: "sync", ids: [] }), { name: "list", scroll: 40 });
  assert.equal(navigate(LIST, { type: "go", id: "a" }), LIST);
  assert.equal(navigate(LIST, { type: "exit" }), LIST);
  const thread = { name: "thread", id: "b", listScroll: 7 };
  assert.deepEqual(navigate(thread, { type: "review", id: "b" }), { ...thread, name: "review" });
});

test("afterResolve prefers the next open thread, then the previous", async () => {
  const { afterResolve } = await import("./comment-nav.mjs");
  assert.equal(afterResolve("a", ids), "b");
  assert.equal(afterResolve("c", ids), "b");
  assert.equal(afterResolve("a", ["a"]), null);
  assert.equal(afterResolve("z", ids), "a");
});

test("reviewKey maps J/K/R/E/Escape and ignores keys while typing", async () => {
  const { reviewKey } = await import("./comment-nav.mjs");
  const key = (key, extra = {}) => ({ key, target: { closest: () => null }, ...extra });
  assert.equal(reviewKey(key("j")), "next");
  assert.equal(reviewKey(key("K")), "previous");
  assert.equal(reviewKey(key("r")), "reply");
  assert.equal(reviewKey(key("e")), "resolve");
  assert.equal(reviewKey(key("Escape")), "exit");
  assert.equal(reviewKey(key("x")), null);
  assert.equal(reviewKey(key("j", { metaKey: true })), null);
  assert.equal(reviewKey(key("j", { defaultPrevented: true })), null);
  const typing = { closest: () => ({}) };
  assert.equal(reviewKey(key("r", { target: typing })), null);
  assert.equal(reviewKey(key("Escape", { target: typing })), null, "Escape belongs to the editor");
});
