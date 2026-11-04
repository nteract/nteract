import assert from "node:assert/strict";
import { test } from "node:test";
import { skip } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";
import {
  PAGE_CARDS_BATCH,
  PAGE_CARDS_GATHER_MS,
  PAGE_CARDS_ROOT_MARGIN,
  PageCards,
  cardKeyOf,
  pageCardMachine,
} from "./page-cards.mjs";

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
  {
    label: "a batch with room takes the next idle card",
    state: { name: "idle" },
    event: { type: "ahead" },
    expect: ok({ name: "requested" }),
  },
  {
    state: { name: "requested" },
    event: { type: "ahead" },
    expect: no({ name: "requested" }, "already requested"),
  },
  { state: shown, event: { type: "ahead" }, expect: no(shown, "already shown") },
  {
    state: { name: "empty" },
    event: { type: "ahead" },
    expect: no({ name: "empty" }, "already empty"),
  },
  {
    label: "a failed card waits until it's seen again",
    state: { name: "failed" },
    event: { type: "ahead" },
    expect: no({ name: "failed" }, "already failed"),
  },
];

test("the page-card machine covers every state and event", async () => {
  assert.deepEqual(await runTable(pageCardMachine, rows), {
    rows: 23,
    pairs: 22,
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
  assert.equal(observers[0].options.rootMargin, PAGE_CARDS_ROOT_MARGIN);
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

test("a grid without an account asks for nothing", async () => {
  const { cards, calls, stop } = loader({ principal: null });
  cards.visible(row(1));
  cards.observe({}, row(2));
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(cards.state(cardKeyOf(row(1))).name, "idle");
  stop();
});

test("one answer is one store update, however many cards it carries", async (t) => {
  const { cards, stop } = loader({ gatherMs: 5 });
  t.after(stop);
  const more = Array.from({ length: PAGE_CARDS_BATCH }, (_, n) => row(100 + n));
  for (const each of more) cards.visible(each);
  let updates = 0;
  // state$ replays the current value first; count what follows.
  const subscription = cards.store.state$.pipe(skip(1)).subscribe(() => updates++);
  await new Promise((resolve) => setTimeout(resolve, 30));
  subscription.unsubscribe();
  assert.equal(updates, 1, "24 answers, one update");
  for (const each of more) assert.equal(cards.state(cardKeyOf(each)).name, "shown");
});

test("a request keeps the signal of the connection that sent it", async () => {
  let release;
  const { cards, calls, stop } = loader({
    answer: (ids) =>
      new Promise((resolve) => {
        release = () => resolve({ principal: "me", cards: { [ids[0]]: CARD } });
      }),
  });
  cards.visible(row(1));
  await tick();
  stop();
  const again = cards.connect();
  release();
  await tick();
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(cards.state(cardKeyOf(row(1))).name, "requested", "a stale answer changes nothing");
  again();
});

/** Scroll a 100-card grid a row at a time, as the IntersectionObserver
 * reports it, and count page_cards requests. */
async function scroll({ columns, firstRows, rowEveryMs, gatherMs }) {
  let fire;
  const { cards, calls, stop } = loader({
    gatherMs,
    answer: async (ids) => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { principal: "me", cards: Object.fromEntries(ids.map((id) => [id, null])) };
    },
    observer: (callback) => {
      fire = callback;
      return { observe() {}, unobserve() {}, disconnect() {} };
    },
  });
  const rows = Array.from({ length: 100 }, (_, n) => row(n));
  const elements = rows.map(() => ({}));
  cards.arrange(rows);
  rows.forEach((each, index) => cards.observe(elements[index], each));
  const show = (from, to) =>
    fire(elements.slice(from, to).map((target) => ({ target, isIntersecting: true })));
  show(0, firstRows * columns);
  for (let start = firstRows * columns; start < 100; start += columns) {
    await new Promise((resolve) => setTimeout(resolve, rowEveryMs));
    show(start, start + columns);
  }
  await new Promise((resolve) => setTimeout(resolve, gatherMs * 3 + 30));
  stop();
  return { calls: calls.map((call) => call.ids.length), cards, rows };
}

test("a slow phone scroll of 100 cards fills batches: 5 requests, not one per row", async () => {
  // A row every 3 gather windows: each row lands in a window of its own.
  const { calls, cards, rows } = await scroll({
    columns: 2,
    firstRows: 4,
    rowEveryMs: 15,
    gatherMs: 5,
  });
  assert.deepEqual(calls, [24, 24, 24, 24, 4]);
  for (const each of rows) assert.equal(cards.state(cardKeyOf(each)).name, "empty");
});

test("a desktop fling of 100 cards sends full batches", async () => {
  const { calls } = await scroll({ columns: 5, firstRows: 3, rowEveryMs: 1, gatherMs: 20 });
  assert.ok(calls.length <= 5, JSON.stringify(calls));
  assert.equal(
    calls.reduce((sum, size) => sum + size, 0),
    100,
  );
  assert.equal(PAGE_CARDS_GATHER_MS >= 150, true, "the default window gathers a fling");
});
