import assert from "node:assert/strict";
import { test } from "node:test";
import { VirtualTimeScheduler, skip } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";
import {
  PAGE_CARDS_BATCH,
  PAGE_CARDS_CONCURRENCY,
  PAGE_CARDS_GATHER_MS,
  PAGE_CARDS_ROOT_MARGIN,
  PageCards,
  cardKeyOf,
  pageCardBatchMachine,
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
  {
    label: "a card that leaves before its request goes out asks again when seen",
    state: { name: "requested" },
    event: { type: "left" },
    expect: ok({ name: "idle" }),
  },
];

test("the page-card machine covers every state and event", async () => {
  assert.deepEqual(await runTable(pageCardMachine, rows), {
    rows: 24,
    pairs: 23,
    unreachable: 7,
    cases: 2,
  });
});

// Batch limits small enough to read: 3 cards a request, 2 requests at once.
const batches = (name, waiting, busy) => ({ name, waiting, busy, batch: 3, slots: 2 });
const send = (take) => ({ type: "send", take });
const batchRows = [
  {
    label: "the first card to ask starts the window",
    state: batches("quiet", 0, 0),
    event: { type: "wanted" },
    expect: ok(batches("gathering", 1, 0), [{ type: "arm" }]),
  },
  {
    state: batches("quiet", 0, 0),
    event: { type: "elapsed" },
    expect: no(batches("quiet", 0, 0), "no window is running"),
  },
  { state: batches("quiet", 0, 1), event: { type: "settled" }, expect: ok(batches("quiet", 0, 0)) },
  {
    state: batches("quiet", 0, 0),
    event: { type: "settled" },
    expect: no(batches("quiet", 0, 0), "no request is running"),
  },
  {
    case: "gather",
    state: batches("gathering", 1, 0),
    event: { type: "wanted" },
    expect: ok(batches("gathering", 2, 0)),
  },
  {
    case: "gather",
    label: "a full batch with every slot busy waits for a slot or the window",
    state: batches("gathering", 2, 2),
    event: { type: "wanted" },
    expect: ok(batches("gathering", 3, 2)),
  },
  {
    case: "full",
    label: "a full batch goes out before the window ends",
    state: batches("gathering", 2, 0),
    event: { type: "wanted" },
    expect: ok(batches("quiet", 0, 1), [send(3), { type: "disarm" }]),
  },
  {
    case: "sent",
    label: "the window's end sends what waits, however few",
    state: batches("gathering", 2, 1),
    event: { type: "elapsed" },
    expect: ok(batches("quiet", 0, 2), [send(2)]),
  },
  {
    state: batches("quiet", 0, 1),
    event: { type: "dropped" },
    expect: no(batches("quiet", 0, 1), "nothing waits"),
  },
  {
    case: "gather",
    state: batches("gathering", 2, 0),
    event: { type: "dropped" },
    expect: ok(batches("gathering", 1, 0)),
  },
  {
    case: "drained",
    label: "the last waiting card leaving cancels the window",
    state: batches("gathering", 1, 0),
    event: { type: "dropped" },
    expect: ok(batches("quiet", 0, 0), [{ type: "disarm" }]),
  },
  {
    case: "due",
    state: batches("due", 2, 2),
    event: { type: "dropped" },
    expect: ok(batches("due", 1, 2)),
  },
  {
    case: "drained",
    state: batches("due", 1, 2),
    event: { type: "dropped" },
    expect: ok(batches("quiet", 0, 2)),
  },
  {
    case: "due",
    state: batches("gathering", 5, 1),
    event: { type: "elapsed" },
    expect: ok(batches("due", 2, 2), [send(3)]),
  },
  {
    case: "due",
    label: "the window ends with every slot busy",
    state: batches("gathering", 2, 2),
    event: { type: "elapsed" },
    expect: ok(batches("due", 2, 2)),
  },
  {
    case: "full",
    state: batches("gathering", 4, 2),
    event: { type: "settled" },
    expect: ok(batches("gathering", 1, 2), [send(3)]),
  },
  {
    case: "gather",
    label: "a freed slot leaves a part batch to its window",
    state: batches("gathering", 1, 2),
    event: { type: "settled" },
    expect: ok(batches("gathering", 1, 1)),
  },
  {
    case: "stray",
    state: batches("gathering", 1, 0),
    event: { type: "settled" },
    expect: no(batches("gathering", 1, 0), "no request is running"),
  },
  {
    label: "a card that asks while due goes out with the next free slot",
    state: batches("due", 1, 2),
    event: { type: "wanted" },
    expect: ok(batches("due", 2, 2)),
  },
  {
    state: batches("due", 1, 2),
    event: { type: "elapsed" },
    expect: no(batches("due", 1, 2), "no window is running"),
  },
  {
    case: "drained",
    state: batches("due", 2, 2),
    event: { type: "settled" },
    expect: ok(batches("quiet", 0, 2), [send(2)]),
  },
  {
    case: "more",
    state: batches("due", 5, 2),
    event: { type: "settled" },
    expect: ok(batches("due", 2, 2), [send(3)]),
  },
];

test("the page-card-batches machine covers every state and event", async () => {
  assert.deepEqual(await runTable(pageCardBatchMachine, batchRows), {
    rows: 22,
    pairs: 12,
    unreachable: 0,
    cases: 13,
  });
  assert.deepEqual(pageCardBatchMachine.initial, {
    name: "quiet",
    waiting: 0,
    busy: 0,
    batch: PAGE_CARDS_BATCH,
    slots: PAGE_CARDS_CONCURRENCY,
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

/** A grid on virtual time: `page_cards` answers after `rttMs`, and `run(ms)`
 * advances the clock a millisecond at a time, letting each answer's promise
 * settle before the next tick. */
function virtualGrid({ total, rttMs, ...options }) {
  const scheduler = new VirtualTimeScheduler();
  scheduler.maxFrames = 0;
  let fire;
  const calls = [];
  const cards = new PageCards({
    principal: "me",
    scheduler,
    tool: async (_operation, { page_ids: ids }) => {
      calls.push({ at: scheduler.frame, ids });
      await new Promise((resolve) => scheduler.schedule(resolve, rttMs));
      return { principal: "me", cards: Object.fromEntries(ids.map((id) => [id, null])) };
    },
    observer: (callback) => {
      fire = callback;
      return { observe() {}, unobserve() {}, disconnect() {} };
    },
    ...options,
  });
  const stop = cards.connect();
  const rows = Array.from({ length: total }, (_, n) => row(n));
  const elements = rows.map(() => ({}));
  cards.arrange(rows);
  rows.forEach((each, index) => cards.observe(elements[index], each));
  const seenAt = new Map();
  const doneAt = new Map();
  const subscription = cards.store.state$.subscribe((states) => {
    for (const each of rows) {
      const name = states.get(cardKeyOf(each))?.name;
      if ((name === "empty" || name === "shown") && !doneAt.has(each.id))
        doneAt.set(each.id, scheduler.frame);
    }
  });
  /** Cards `from` to `to` come into view, or leave it with `leaving`. */
  const show = (from, to, { leaving = false } = {}) => {
    const shown = rows.slice(from, Math.min(to, total));
    for (const each of shown)
      if (!leaving && !seenAt.has(each.id)) seenAt.set(each.id, scheduler.frame);
    fire(
      elements
        .slice(from, Math.min(to, total))
        .map((target) => ({ target, isIntersecting: !leaving })),
    );
  };
  const at = (ms, work) => scheduler.schedule(work, ms - scheduler.frame);
  const run = async (ms) => {
    const until = scheduler.frame + ms;
    for (let frame = scheduler.frame + 1; frame <= until; frame++) {
      scheduler.maxFrames = frame;
      scheduler.flush();
      scheduler.frame = frame;
      for (let turn = 0; turn < 4; turn++) await Promise.resolve();
    }
  };
  const done = () => {
    subscription.unsubscribe();
    stop();
  };
  return { cards, calls, rows, show, at, run, seenAt, doneAt, done };
}

/** Scroll a row at a time without pausing, then measure each card's wait
 * from coming into view to its answer. */
async function continuousScroll({ columns, firstRows, rowEveryMs, rttMs, total }) {
  const grid = virtualGrid({ total, rttMs });
  grid.at(0, () => grid.show(0, firstRows * columns));
  let last = 0;
  for (let start = firstRows * columns, n = 1; start < total; start += columns, n++) {
    last = n * rowEveryMs;
    grid.at(last, () => grid.show(start, start + columns));
  }
  await grid.run(last + PAGE_CARDS_GATHER_MS + 3 * rttMs);
  grid.done();
  const firstScreen = grid.rows.slice(0, firstRows * columns);
  const waits = grid.rows.map((each) => grid.doneAt.get(each.id) - grid.seenAt.get(each.id));
  return {
    requests: grid.calls.length,
    firstScreenMs: Math.max(...firstScreen.map((each) => grid.doneAt.get(each.id))),
    worstWaitMs: Math.max(...waits),
    firstSentMs: grid.calls[0].at,
  };
}

for (const scroll of [
  { label: "desktop, a row every 150 ms", columns: 5, firstRows: 3, rowEveryMs: 150 },
  { label: "phone, a row every 180 ms", columns: 2, firstRows: 4, rowEveryMs: 180 },
  { label: "phone, a row every 120 ms", columns: 2, firstRows: 4, rowEveryMs: 120 },
])
  test(`a continuous scroll loads cards as it runs (${scroll.label})`, async () => {
    const rttMs = 150;
    const result = await continuousScroll({ ...scroll, rttMs, total: 300 });
    assert.equal(result.firstSentMs, PAGE_CARDS_GATHER_MS, JSON.stringify(result));
    assert.ok(
      result.firstScreenMs <= PAGE_CARDS_GATHER_MS + rttMs + 5,
      `first screen within the window and one round trip: ${JSON.stringify(result)}`,
    );
    assert.ok(
      result.worstWaitMs <= PAGE_CARDS_GATHER_MS + rttMs + 5,
      `no card waits past the window and one round trip: ${JSON.stringify(result)}`,
    );
    assert.ok(result.requests <= 14, `requests stay full: ${JSON.stringify(result)}`);
  });

test("a card waits at most the window for others, and 24 waiting go out at once", async () => {
  const grid = virtualGrid({ total: 100, rttMs: 10 });
  grid.cards.arrange([]);
  // One card every 50 ms: a quiet-time debounce would never fire.
  for (let n = 0; n < 8; n++) grid.at(n * 50, () => grid.show(n, n + 1));
  await grid.run(PAGE_CARDS_GATHER_MS);
  assert.deepEqual(
    grid.calls.map(({ at, ids }) => [at, ids.length]),
    [[PAGE_CARDS_GATHER_MS, 5]],
    "the window runs from the first card",
  );
  await grid.run(PAGE_CARDS_GATHER_MS + 50);
  assert.deepEqual(
    grid.calls.map(({ at, ids }) => [at, ids.length]),
    [
      [PAGE_CARDS_GATHER_MS, 5],
      [2 * PAGE_CARDS_GATHER_MS + 50, 3],
    ],
  );
  grid.at(grid.calls.at(-1).at + 100, () => grid.show(20, 20 + PAGE_CARDS_BATCH));
  const burst = grid.calls.at(-1).at + 100;
  await grid.run(150);
  assert.deepEqual(grid.calls.at(-1), {
    at: burst,
    ids: grid.rows.slice(20, 20 + PAGE_CARDS_BATCH).map((each) => each.id),
  });
  grid.done();
});

test("a card that leaves before its request goes out stops waiting, and asks again when seen", async () => {
  // Two cards a request, both slots held by the first four cards.
  const grid = virtualGrid({ total: 20, rttMs: 100, batchSize: 2 });
  grid.cards.arrange([]);
  grid.at(1, () => grid.show(0, 4));
  await grid.run(5);
  assert.equal(grid.calls.length, 2, "two full requests hold both slots");
  grid.at(10, () => grid.show(4, 5));
  grid.at(20, () => grid.show(5, 6));
  grid.at(30, () => grid.show(4, 5, { leaving: true }));
  grid.at(40, () => grid.show(6, 7));
  grid.at(50, () => grid.show(7, 8));
  await grid.run(35);
  assert.equal(grid.cards.state(cardKeyOf(grid.rows[4])).name, "idle", "card 4 stopped waiting");
  // Past the window card 4 started, which card 5 still waits on.
  await grid.run(PAGE_CARDS_GATHER_MS + 100);
  const ids = (from, to) => grid.rows.slice(from, to).map((each) => each.id);
  assert.deepEqual(
    grid.calls.slice(2).map((call) => call.ids),
    [ids(7, 8).concat(ids(6, 7)), ids(5, 6)],
    "the latest into view go first; the card that left asks for nothing",
  );
  grid.at(grid.calls.at(-1).at + 300, () => grid.show(4, 5));
  await grid.run(600);
  assert.deepEqual(grid.calls.at(-1).ids, ids(4, 5), "back in view, it asks again");
  assert.equal(grid.cards.state(cardKeyOf(grid.rows[4])).name, "empty");
  grid.done();
});

test("every card that asked before connect goes out, however many", async () => {
  for (const total of [10, 30, 60]) {
    const calls = [];
    const cards = new PageCards({
      principal: "me",
      observer: null,
      gatherMs: 5,
      tool: async (_operation, { page_ids: ids }) => {
        calls.push(ids.length);
        return { principal: "me", cards: Object.fromEntries(ids.map((id) => [id, null])) };
      },
    });
    const rows = Array.from({ length: total }, (_, n) => row(n));
    cards.arrange(rows);
    // React runs the cards' effects before the grid's connect effect.
    for (const each of rows) cards.observe({}, each);
    const stop = cards.connect();
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop();
    assert.equal(
      calls.reduce((sum, size) => sum + size, 0),
      total,
      `${total} cards: ${JSON.stringify(calls)}`,
    );
    for (const each of rows) assert.equal(cards.state(cardKeyOf(each)).name, "empty");
  }
});

test("a fling asks only for the cards still in view when their request goes out", async () => {
  // 5 columns, 5 rows in view, a row every 16 ms down 2,000 cards.
  const columns = 5;
  const inView = 5;
  const total = 2000;
  const grid = virtualGrid({ total, rttMs: 150 });
  let top = 0;
  const gone = [];
  const tool = grid.cards.tool;
  grid.cards.tool = (operation, args, options) => {
    const index = new Map(grid.rows.map((each, n) => [each.id, n]));
    gone.push(args.page_ids.filter((id) => index.get(id) < top * columns).length);
    return tool(operation, args, options);
  };
  grid.at(0, () => grid.show(0, inView * columns));
  const lastTop = total / columns - inView;
  for (let next = 1; next <= lastTop; next++)
    grid.at(next * 16, () => {
      top = next;
      grid.show((next - 1) * columns, next * columns, { leaving: true });
      grid.show((next + inView - 1) * columns, (next + inView) * columns);
    });
  const end = lastTop * 16;
  await grid.run(end + 1000);
  grid.done();
  assert.equal(
    gone.reduce((sum, count) => sum + count, 0),
    0,
    "no request carries a card that already left",
  );
  const stoppedOn = grid.rows.slice(lastTop * columns);
  for (const each of stoppedOn)
    assert.ok(
      grid.doneAt.get(each.id) <= end + PAGE_CARDS_GATHER_MS + 150,
      "the screen the fling stops on loads within the window and a round trip",
    );
});
