import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { PAGE_CARDS_BATCH, PageCards, cardKeyOf, pageCardMachine } from "./page-cards.mjs";

const CARD = { v: 1, card_hash: "h", blocks: [{ id: "b", content: [["p", {}, "Hi"]] }] };
const BLANK = { v: 1, card_hash: "h", blocks: [] };
const shown = { name: "shown", card: CARD };
const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });
const fetch = [{ type: "fetch" }];

const rows = [
  { state: { name: "idle" }, event: { type: "visible" }, expect: ok({ name: "requested" }, fetch) },
  {
    state: { name: "requested" },
    event: { type: "visible" },
    expect: no({ name: "requested" }, "already requested"),
  },
  {
    case: "content",
    state: { name: "requested" },
    event: { type: "answered", card: CARD },
    expect: ok(shown),
  },
  {
    case: "blank",
    label: "a card with nothing in it shows the placeholder",
    state: { name: "requested" },
    event: { type: "answered", card: BLANK },
    expect: ok({ name: "empty" }),
  },
  { state: { name: "requested" }, event: { type: "missing" }, expect: ok({ name: "empty" }) },
  { state: { name: "requested" }, event: { type: "failed" }, expect: ok({ name: "failed" }) },
  { state: shown, event: { type: "visible" }, expect: no(shown, "already shown") },
  {
    state: shown,
    event: { type: "answered", card: CARD },
    expect: no(shown, "not waiting for a card"),
  },
  { state: shown, event: { type: "missing" }, expect: no(shown, "not waiting for a card") },
  { state: shown, event: { type: "failed" }, expect: no(shown, "not waiting for a card") },
  {
    state: { name: "empty" },
    event: { type: "visible" },
    expect: no({ name: "empty" }, "already empty"),
  },
  {
    state: { name: "empty" },
    event: { type: "answered", card: CARD },
    expect: no({ name: "empty" }, "not waiting for a card"),
  },
  {
    state: { name: "empty" },
    event: { type: "missing" },
    expect: no({ name: "empty" }, "not waiting for a card"),
  },
  {
    state: { name: "empty" },
    event: { type: "failed" },
    expect: no({ name: "empty" }, "not waiting for a card"),
  },
  {
    label: "a failed card asks again when it scrolls back in",
    state: { name: "failed" },
    event: { type: "visible" },
    expect: ok({ name: "requested" }, fetch),
  },
  {
    state: { name: "failed" },
    event: { type: "answered", card: CARD },
    expect: no({ name: "failed" }, "not waiting for a card"),
  },
  {
    state: { name: "failed" },
    event: { type: "missing" },
    expect: no({ name: "failed" }, "not waiting for a card"),
  },
  {
    state: { name: "failed" },
    event: { type: "failed" },
    expect: no({ name: "failed" }, "not waiting for a card"),
  },
];

test("the page-card machine covers every state and event", async () => {
  assert.deepEqual(await runTable(pageCardMachine, rows), {
    rows: 18,
    pairs: 17,
    unreachable: 3,
    cases: 2,
  });
});

const row = (n, contentUpdatedAt = null) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  contentUpdatedAt,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** A loader over a recorded tool. `answer(ids)` builds each reply. */
function loader({ principal = "me", answer, ...options } = {}) {
  const calls = [];
  const tool = async (operation, args, { signal } = {}) => {
    calls.push({ operation, ids: args.page_ids, signal });
    return answer
      ? answer(args.page_ids, signal)
      : { principal, cards: Object.fromEntries(args.page_ids.map((id) => [id, CARD])) };
  };
  const cards = new PageCards({ tool, principal, observer: null, gatherMs: 0, ...options });
  const stop = cards.connect();
  return { cards, calls, stop };
}

test("visible cards go out in batches of at most 24, each ID once", async (t) => {
  const { cards, calls, stop } = loader();
  t.after(stop);
  const all = Array.from({ length: 30 }, (_, n) => row(n));
  for (const each of all) cards.visible(each);
  cards.visible(all[0]);
  await tick();
  assert.deepEqual(
    calls.map((call) => call.ids.length),
    [PAGE_CARDS_BATCH, 6],
  );
  assert.equal(new Set(calls.flatMap((call) => call.ids)).size, 30);
  for (const each of all)
    assert.deepEqual(cards.state(cardKeyOf(each)), { name: "shown", card: CARD });
  // Shown cards scrolling back in ask nothing.
  cards.visible(all[3]);
  await tick();
  assert.equal(calls.length, 2);
});

test("a fresh content time is a new key and asks again", async (t) => {
  const { cards, calls, stop } = loader();
  t.after(stop);
  cards.visible(row(1, "2026-11-04T10:00:00.000Z"));
  await tick();
  cards.visible(row(1, "2026-11-04T10:00:00.000Z"));
  cards.visible(row(1, "2026-11-04T11:00:00.000Z"));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(cards.state(cardKeyOf(row(1, "2026-11-04T11:00:00.000Z"))).name, "shown");
});

test("null answers and missing IDs are empty; blank cards are empty", async (t) => {
  const { cards, stop } = loader({
    answer: (ids) => ({ principal: "me", cards: { [ids[0]]: null, [ids[1]]: BLANK } }),
  });
  t.after(stop);
  for (const n of [1, 2, 3]) cards.visible(row(n));
  await tick();
  for (const n of [1, 2, 3]) assert.equal(cards.state(cardKeyOf(row(n))).name, "empty");
});

test("an answer for another account is ignored and fails its cards", async (t) => {
  const { cards, stop } = loader({
    answer: (ids) => ({ principal: "someone-else", cards: { [ids[0]]: CARD } }),
  });
  t.after(stop);
  cards.visible(row(1));
  await tick();
  assert.deepEqual(cards.state(cardKeyOf(row(1))), { name: "failed" });
});

test("a failed request fails its cards, and they ask again when they scroll back in", async (t) => {
  let fail = true;
  const { cards, calls, stop } = loader({
    answer: (ids) => {
      if (fail) throw Object.assign(Error("Service unavailable"), { status: 503 });
      return { principal: "me", cards: { [ids[0]]: CARD } };
    },
  });
  t.after(stop);
  cards.visible(row(1));
  await tick();
  assert.equal(cards.state(cardKeyOf(row(1))).name, "failed");
  fail = false;
  cards.visible(row(1));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(cards.state(cardKeyOf(row(1))).name, "shown");
});

test("unmounting aborts the request in flight and its answer changes nothing", async () => {
  let release;
  const { cards, calls, stop } = loader({
    answer: (ids) =>
      new Promise((resolve) => {
        release = () => resolve({ principal: "me", cards: { [ids[0]]: CARD } });
      }),
  });
  cards.visible(row(1));
  await tick();
  assert.equal(calls.length, 1);
  stop();
  assert.equal(calls[0].signal.aborted, true);
  release();
  await tick();
  assert.equal(cards.state(cardKeyOf(row(1))).name, "requested");
});

test("observe asks when a card intersects, with a root margin, and stops on cleanup", async (t) => {
  const observers = [];
  const { cards, calls, stop } = loader({
    observer: (callback, options) => {
      const observer = {
        callback,
        options,
        watched: new Set(),
        observe: (element) => observer.watched.add(element),
        unobserve: (element) => observer.watched.delete(element),
        disconnect: () => observer.watched.clear(),
      };
      observers.push(observer);
      return observer;
    },
  });
  t.after(stop);
  const a = {};
  const b = {};
  const stopA = cards.observe(a, row(1));
  cards.observe(b, row(2));
  assert.equal(observers.length, 1, "one observer per grid");
  assert.equal(observers[0].options.rootMargin, "200px 0px");
  observers[0].callback([
    { target: a, isIntersecting: false },
    { target: b, isIntersecting: true },
  ]);
  await tick();
  assert.deepEqual(calls[0].ids, [row(2).id]);
  stopA();
  assert.equal(observers[0].watched.has(a), false);
  observers[0].callback([{ target: a, isIntersecting: true }]);
  await tick();
  assert.equal(calls.length, 1, "an element no longer observed asks nothing");
});

test("without IntersectionObserver a card asks as soon as it mounts", async (t) => {
  const { cards, calls, stop } = loader();
  t.after(stop);
  cards.observe({}, row(1));
  await tick();
  assert.equal(calls.length, 1);
});

test("a loader connected again after a stop answers again (StrictMode remounts)", async () => {
  const { cards, calls, stop } = loader();
  stop();
  const again = cards.connect();
  cards.visible(row(1));
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(cards.state(cardKeyOf(row(1))).name, "shown");
  again();
});
