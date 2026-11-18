import assert from "node:assert/strict";
import { test } from "node:test";
import { BehaviorSubject, Subject, VirtualTimeScheduler, of } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";
import {
  CARD_SHRINK_GAP_MS,
  CardShrink,
  cardShrinkMachine,
  shrinkCard,
  smallerCard,
  startCardShrink,
} from "./card-shrink.mjs";
import { CardShrinkOffers, largerThanCapture } from "./card-shrink-offers.mjs";

const A = "a".repeat(64);
const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";
const candidate = (pageId, ext = "webp", hash = A) => ({
  page_id: pageId,
  card_hash: hash,
  light: `/api/pages/${pageId}/card-image/${hash}-light.${ext}`,
  dark: `/api/pages/${pageId}/card-image/${hash}-dark.${ext}`,
});
const c1 = candidate(P1);
const c2 = candidate(P2, "png");
const base = { visible: true, queue: [], done: [] };
const idle = (fields = {}) => ({ name: "idle", ...base, ...fields });
const waiting = (fields = {}) => ({ name: "waiting", ...base, queue: [c1], ...fields });
const shrinking = (fields = {}) => ({ name: "shrinking", ...base, target: c1, ...fields });
const stopped = (fields = {}) => ({ name: "stopped", ...base, visible: false, ...fields });
const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });
const arm = { type: "arm" };
const disarm = { type: "disarm" };
const cancel = { type: "cancel" };
const refusedP1 = { page_id: P1, outcome: "refused" };

const rows = [
  // idle
  {
    case: "known",
    label: "a Page whose turn ended this visit is never offered again",
    state: idle({ done: [refusedP1] }),
    event: { type: "offered", candidate: c1 },
    expect: no(idle({ done: [refusedP1] }), "offered this visit"),
  },
  {
    case: "held",
    label: "a hidden tab queues the Page and waits",
    state: idle({ visible: false }),
    event: { type: "offered", candidate: c1 },
    expect: ok(idle({ visible: false, queue: [c1] })),
  },
  {
    case: "wants",
    state: idle(),
    event: { type: "offered", candidate: c1 },
    expect: ok(waiting(), [arm]),
  },
  {
    case: "already",
    state: idle(),
    event: { type: "visible" },
    expect: no(idle(), "already visible"),
  },
  {
    case: "holds",
    state: idle({ visible: false }),
    event: { type: "visible" },
    expect: ok(idle()),
  },
  {
    case: "wants",
    state: idle({ visible: false, queue: [c1] }),
    event: { type: "visible" },
    expect: ok(waiting(), [arm]),
  },
  {
    case: "already",
    state: idle({ visible: false }),
    event: { type: "hidden" },
    expect: no(idle({ visible: false }), "already hidden"),
  },
  {
    case: "hides",
    state: idle(),
    event: { type: "hidden" },
    expect: ok(idle({ visible: false })),
  },
  {
    state: idle(),
    event: { type: "elapsed" },
    expect: no(idle(), "no gap timer is running"),
  },
  {
    state: idle(),
    event: { type: "finished", page_id: P1, outcome: "shrunk" },
    expect: no(idle(), "not this Page's turn"),
  },
  {
    label: "leaving the library drops what waits and keeps what ended",
    state: idle({ visible: false, queue: [c2], done: [refusedP1] }),
    event: { type: "stop" },
    expect: ok(stopped({ done: [refusedP1] })),
  },
  // waiting
  {
    case: "known",
    state: waiting(),
    event: { type: "offered", candidate: c1 },
    expect: no(waiting(), "offered this visit"),
  },
  {
    case: "queued",
    label: "a later offer waits its turn; the gap timer keeps running",
    state: waiting(),
    event: { type: "offered", candidate: c2 },
    expect: ok(waiting({ queue: [c1, c2] })),
  },
  {
    state: waiting(),
    event: { type: "visible" },
    expect: no(waiting(), "already visible"),
  },
  {
    state: waiting(),
    event: { type: "hidden" },
    expect: ok(idle({ visible: false, queue: [c1] }), [disarm]),
  },
  {
    label: "the gap passed on an idle thread: the first Page's turn",
    state: waiting({ queue: [c1, c2] }),
    event: { type: "elapsed" },
    expect: ok(shrinking({ queue: [c2] }), [{ type: "shrink", candidate: c1 }]),
  },
  {
    state: waiting(),
    event: { type: "finished", page_id: P1, outcome: "shrunk" },
    expect: no(waiting(), "not this Page's turn"),
  },
  {
    state: waiting(),
    event: { type: "stop" },
    expect: ok(stopped(), [disarm]),
  },
  // shrinking
  {
    case: "known",
    state: shrinking(),
    event: { type: "offered", candidate: c1 },
    expect: no(shrinking(), "offered this visit"),
  },
  {
    case: "queued",
    state: shrinking(),
    event: { type: "offered", candidate: c2 },
    expect: ok(shrinking({ queue: [c2] })),
  },
  {
    state: shrinking(),
    event: { type: "visible" },
    expect: no(shrinking(), "already visible"),
  },
  {
    label: "a hidden tab cancels the turn and puts the Page back in front",
    state: shrinking({ queue: [c2] }),
    event: { type: "hidden" },
    expect: ok(idle({ visible: false, queue: [c1, c2] }), [cancel]),
  },
  {
    state: shrinking(),
    event: { type: "elapsed" },
    expect: no(shrinking(), "no gap timer is running"),
  },
  {
    case: "mine",
    label: "the last Page's turn ends",
    state: shrinking(),
    event: { type: "finished", page_id: P1, outcome: "shrunk" },
    expect: ok(idle({ done: [{ page_id: P1, outcome: "shrunk" }] })),
  },
  {
    case: "mine",
    label: "a refusal ends the turn; the next Page waits its gap",
    state: shrinking({ queue: [c2] }),
    event: { type: "finished", page_id: P1, outcome: "refused" },
    expect: ok(waiting({ queue: [c2], done: [refusedP1] }), [arm]),
  },
  {
    case: "stale",
    state: shrinking(),
    event: { type: "finished", page_id: P2, outcome: "current" },
    expect: no(shrinking(), "not this Page's turn"),
  },
  {
    state: shrinking({ queue: [c2] }),
    event: { type: "stop" },
    expect: ok(stopped(), [cancel]),
  },
  // stopped
  ...[
    { type: "offered", candidate: c1 },
    { type: "visible" },
    { type: "hidden" },
    { type: "elapsed" },
    { type: "finished", page_id: P1, outcome: "shrunk" },
    { type: "stop" },
  ].map((event) => ({ state: stopped(), event, expect: no(stopped(), "stopped") })),
];

test("the card-shrink machine covers every state and event", async () => {
  assert.deepEqual(await runTable(cardShrinkMachine, rows), {
    rows: 33,
    pairs: 24,
    unreachable: 0,
    cases: 14,
  });
});

test("the machine refuses a candidate whose URLs aren't its card image route", () => {
  const foreign = { ...c1, light: "https://elsewhere.invalid/x.webp" };
  assert.throws(
    () => cardShrinkMachine.step(idle(), { type: "offered", candidate: foreign }),
    /light URL/,
  );
});

/** A CardShrink on virtual time, with turns the test settles. `idle` is the
 * idle signal: a Subject the test fires, or an Observable that fires at once. */
function harness({ idle = () => of(undefined) } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const visible = new BehaviorSubject(true);
  const turns = [];
  const shrink = new CardShrink({
    visible$: visible,
    scheduler,
    idle,
    shrink: (candidate, signal) =>
      new Promise((resolve, reject) => {
        turns.push({ candidate, signal, resolve, reject });
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const advance = async (ms) => {
    scheduler.schedule(() => {}, ms);
    scheduler.maxFrames = scheduler.frame + ms;
    scheduler.flush();
    await tick();
  };
  return { scheduler, visible, turns, shrink, advance, tick };
}

test("one Page at a time, each after its gap, in offer order", async () => {
  const h = harness();
  h.shrink.offer(c1);
  h.shrink.offer(c2);
  await h.advance(CARD_SHRINK_GAP_MS - 1);
  assert.equal(h.turns.length, 0);
  await h.advance(1);
  assert.deepEqual(
    h.turns.map((turn) => turn.candidate.page_id),
    [P1],
  );
  // The next Page waits for this turn to end, then for its own gap.
  await h.advance(CARD_SHRINK_GAP_MS * 3);
  assert.equal(h.turns.length, 1);
  h.turns[0].resolve("shrunk");
  await h.tick();
  assert.equal(h.shrink.state.name, "waiting");
  await h.advance(CARD_SHRINK_GAP_MS);
  assert.deepEqual(
    h.turns.map((turn) => turn.candidate.page_id),
    [P1, P2],
  );
  h.turns[1].resolve("current");
  await h.tick();
  assert.deepEqual(h.shrink.state, {
    name: "idle",
    visible: true,
    queue: [],
    done: [
      { page_id: P1, outcome: "shrunk" },
      { page_id: P2, outcome: "current" },
    ],
  });
});

test("a turn starts only once the main thread is idle", async () => {
  const idle = new Subject();
  const h = harness({ idle: () => idle });
  h.shrink.offer(c1);
  await h.advance(CARD_SHRINK_GAP_MS * 4);
  assert.equal(h.turns.length, 0, "the gap passed, the thread is busy");
  idle.next();
  await h.tick();
  assert.equal(h.turns.length, 1);
});

test("a hidden tab holds the pass and cancels a running turn, which runs again later", async () => {
  const h = harness();
  h.visible.next(false);
  h.shrink.offer(c1);
  await h.advance(CARD_SHRINK_GAP_MS * 2);
  assert.equal(h.turns.length, 0);
  h.visible.next(true);
  await h.advance(CARD_SHRINK_GAP_MS);
  assert.equal(h.turns.length, 1);
  h.visible.next(false);
  assert.equal(h.turns[0].signal.aborted, true);
  await h.tick();
  assert.deepEqual(h.shrink.state, { name: "idle", visible: false, queue: [c1], done: [] });
  h.visible.next(true);
  await h.advance(CARD_SHRINK_GAP_MS);
  assert.equal(h.turns.length, 2);
  assert.equal(h.turns[1].candidate, c1);
});

test("a refusal or a failure ends the Page's turn for the visit: no retry timer", async () => {
  const h = harness();
  h.shrink.offer(c1);
  h.shrink.offer(c2);
  await h.advance(CARD_SHRINK_GAP_MS);
  h.turns[0].resolve("refused");
  await h.tick();
  await h.advance(CARD_SHRINK_GAP_MS);
  h.turns[1].reject(Error("network down"));
  await h.tick();
  await h.advance(CARD_SHRINK_GAP_MS * 100);
  assert.equal(h.turns.length, 2);
  assert.deepEqual(h.shrink.state.done, [
    { page_id: P1, outcome: "refused" },
    { page_id: P2, outcome: "refused" },
  ]);
  // The grid offers them again as their images load again: nothing runs.
  assert.equal(h.shrink.offer(c1).rejected, "offered this visit");
  assert.equal(h.shrink.offer(c2).rejected, "offered this visit");
  await h.advance(CARD_SHRINK_GAP_MS * 2);
  assert.equal(h.turns.length, 2);
});

test("stop cancels the running turn and every timer", async () => {
  const h = harness();
  h.shrink.offer(c1);
  h.shrink.offer(c2);
  await h.advance(CARD_SHRINK_GAP_MS);
  h.shrink.stop();
  assert.equal(h.turns[0].signal.aborted, true);
  await h.advance(CARD_SHRINK_GAP_MS * 4);
  assert.equal(h.turns.length, 1);
  assert.equal(h.shrink.state.name, "stopped");
});

/** A fetch over a stored record: `sizes[url]` is each stored image's width,
 * and an upload answers `answer(theme)`. */
function host({ answer = (theme) => ({ themes: { [theme]: "webp" } }), status = {} } = {}) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({
      method: init.method ?? "GET",
      url,
      cache: init.cache,
      type: init.headers?.["Content-Type"],
    });
    const code = status[`${init.method ?? "GET"} ${url}`] ?? (init.method === "PUT" ? 201 : 200);
    if (init.method === "PUT") {
      const theme = new URL(url, "https://pages.invalid").searchParams.get("theme");
      return Response.json(code < 300 ? answer(theme) : { code: "card_image_stale" }, {
        status: code,
      });
    }
    return new Response(url, { status: code });
  };
  return { calls, fetch };
}
/** A redraw that reads a stored "image" (its URL as text) as large unless
 * the URL is in `small`. */
const redrawing =
  (small = []) =>
  async (blob) => {
    const url = await blob.text();
    return small.includes(url) ? null : new Blob(["small"], { type: "image/webp" });
  };

test("a turn redraws each larger theme, uploads it, and refreshes the cache for the URL the record names", async () => {
  const png = candidate(P1, "png");
  const { calls, fetch } = host();
  const outcome = await shrinkCard(png, {
    fetch,
    signal: new AbortController().signal,
    redraw: redrawing(),
  });
  assert.equal(outcome, "shrunk");
  const route = `/api/pages/${P1}/card-image`;
  assert.deepEqual(calls, [
    { method: "GET", url: png.light, cache: "reload", type: undefined },
    { method: "PUT", url: `${route}?hash=${A}&theme=light`, cache: undefined, type: "image/webp" },
    // A PNG redrawn as WebP: the record names the .webp URL now.
    { method: "GET", url: `${route}/${A}-light.webp`, cache: "reload", type: undefined },
    { method: "GET", url: png.dark, cache: "reload", type: undefined },
    { method: "PUT", url: `${route}?hash=${A}&theme=dark`, cache: undefined, type: "image/webp" },
    { method: "GET", url: `${route}/${A}-dark.webp`, cache: "reload", type: undefined },
  ]);
});

test("an image already at the capture's size uploads nothing", async () => {
  const { calls, fetch } = host();
  const outcome = await shrinkCard(c1, {
    fetch,
    signal: new AbortController().signal,
    redraw: redrawing([c1.light, c1.dark]),
  });
  assert.equal(outcome, "current");
  assert.deepEqual(
    calls.map((call) => [call.method, call.url, call.cache]),
    [
      ["GET", c1.light, "reload"],
      ["GET", c1.dark, "reload"],
    ],
  );
  // One theme small, the other not: only that one uploads.
  const mixed = host();
  assert.equal(
    await shrinkCard(c1, {
      fetch: mixed.fetch,
      signal: new AbortController().signal,
      redraw: redrawing([c1.light]),
    }),
    "shrunk",
  );
  assert.deepEqual(
    mixed.calls.filter((call) => call.method === "PUT").map((call) => call.url),
    [`/api/pages/${P1}/card-image?hash=${A}&theme=dark`],
  );
});

test("the host's refusal or a failed read ends the turn at once", async () => {
  const route = `/api/pages/${P1}/card-image`;
  for (const [key, status] of [
    [`PUT ${route}?hash=${A}&theme=light`, 409],
    [`PUT ${route}?hash=${A}&theme=light`, 429],
    [`PUT ${route}?hash=${A}&theme=light`, 403],
    [`GET ${c1.light}`, 404],
  ]) {
    const { calls, fetch } = host({ status: { [key]: status } });
    const outcome = await shrinkCard(c1, {
      fetch,
      signal: new AbortController().signal,
      redraw: redrawing(),
    });
    assert.equal(outcome, "refused", key);
    assert.equal(
      calls.some((call) => call.url.includes("dark")),
      false,
      `${key} ${status}: the dark theme is never tried`,
    );
  }
  // A refusal after one theme landed still ends the turn.
  const later = host({ status: { [`PUT ${route}?hash=${A}&theme=dark`]: 429 } });
  assert.equal(
    await shrinkCard(c1, {
      fetch: later.fetch,
      signal: new AbortController().signal,
      redraw: redrawing(),
    }),
    "refused",
  );
});

test("a cancelled turn stops before its next request", async () => {
  const abort = new AbortController();
  const { calls, fetch } = host();
  await assert.rejects(
    shrinkCard(c1, {
      fetch: async (url, init) => {
        const response = await fetch(url, init);
        abort.abort();
        return response;
      },
      signal: abort.signal,
      redraw: redrawing(),
    }),
  );
  assert.equal(calls.length, 1);
});

test("smallerCard draws a larger image into a 640×480 canvas with high smoothing", async () => {
  const drawn = [];
  const canvases = [];
  const document = {
    createElement: (name) => {
      assert.equal(name, "canvas");
      const context = {
        drawImage: (...args) => drawn.push({ args, quality: context.imageSmoothingQuality }),
      };
      const canvas = { getContext: () => context, context };
      canvases.push(canvas);
      return canvas;
    },
  };
  let closed = 0;
  const bitmap = (width, height) => ({ width, height, close: () => closed++ });
  const encoded = new Blob(["x"], { type: "image/webp" });
  const large = await smallerCard(new Blob(), {
    document,
    decode: async () => bitmap(1280, 960),
    encode: async (canvas) => {
      assert.equal(canvas, canvases[0]);
      return encoded;
    },
  });
  assert.equal(large, encoded);
  assert.deepEqual([canvases[0].width, canvases[0].height], [640, 480]);
  assert.equal(canvases[0].context.imageSmoothingEnabled, true);
  assert.equal(drawn[0].quality, "high");
  assert.deepEqual(drawn[0].args.slice(1), [0, 0, 640, 480]);
  for (const [width, height] of [
    [640, 480],
    [320, 240],
  ])
    assert.equal(
      await smallerCard(new Blob(), {
        document,
        decode: async () => bitmap(width, height),
        encode: () => assert.fail("nothing to encode"),
      }),
      null,
    );
  assert.equal(canvases.length, 1);
  assert.equal(closed, 3, "every decoded bitmap is released");
});

test("startCardShrink does nothing on Save-Data or a low-memory device", () => {
  for (const navigator of [{ connection: { saveData: true } }, { deviceMemory: 1 }]) {
    const pass = startCardShrink({
      browser: { document: new EventTarget(), navigator },
      fetch: () => assert.fail("nothing is fetched"),
    });
    assert.equal(pass.state, null);
    pass.offer(c1);
    pass.stop();
  }
});

test("startCardShrink follows the document's visibility", async () => {
  const scheduler = new VirtualTimeScheduler();
  const document = new EventTarget();
  document.visibilityState = "hidden";
  const requests = [];
  const pass = startCardShrink({
    browser: { document, navigator: {} },
    fetch: async (url, init = {}) => {
      requests.push(url);
      return new Response("", { status: init.method === "PUT" ? 409 : 404 });
    },
    scheduler,
    idle: () => of(undefined),
  });
  assert.equal(pass.state.visible, false);
  pass.offer(c1);
  scheduler.schedule(() => {}, CARD_SHRINK_GAP_MS * 2);
  scheduler.flush();
  assert.equal(requests.length, 0);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(pass.state.name, "waiting");
  scheduler.maxFrames = Infinity;
  scheduler.schedule(() => {}, CARD_SHRINK_GAP_MS);
  scheduler.flush();
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requests, [c1.light]);
  assert.deepEqual(pass.state.done, [refusedP1]);
  pass.stop();
});

test("largerThanCapture: wider or taller than 640×480", () => {
  assert.equal(largerThanCapture(1280, 960), true);
  assert.equal(largerThanCapture(641, 480), true);
  assert.equal(largerThanCapture(640, 481), true);
  assert.equal(largerThanCapture(640, 480), false);
  assert.equal(largerThanCapture(0, 0), false);
});

/** CardShrinkOffers over a fake module whose passes record offers. */
function offers({ allowed = true } = {}) {
  const passes = [];
  let loads = 0;
  const shrink = new CardShrinkOffers({
    allowed: () => allowed,
    load: async () => {
      loads++;
      return {
        startCardShrink: () => {
          const pass = { offered: [], stopped: false };
          pass.offer = (candidate) => pass.offered.push(candidate);
          pass.stop = () => (pass.stopped = true);
          passes.push(pass);
          return pass;
        },
      };
    },
  });
  const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { shrink, passes, loads: () => loads, settle };
}
const image = { card_hash: A, light: c1.light, dark: c1.dark };

test("CardShrinkOffers loads the pass only for an image larger than a capture", async () => {
  const o = offers();
  const stop = o.shrink.connect();
  o.shrink.offer(P1, image, 640, 480);
  await o.settle();
  assert.equal(o.loads(), 0, "a capture-sized library never downloads the pass");
  o.shrink.offer(P1, image, 1280, 960);
  o.shrink.offer(P2, { ...image, ...candidate(P2) }, 1280, 960);
  await o.settle();
  assert.equal(o.loads(), 1);
  assert.equal(o.passes.length, 1);
  assert.deepEqual(o.passes[0].offered, [c1, candidate(P2)]);
  stop();
  await o.settle();
  assert.equal(o.passes[0].stopped, true);
});

test("CardShrinkOffers: an offer before connecting waits for it; a new connection is a new visit", async () => {
  const o = offers();
  o.shrink.offer(P1, image, 1280, 960);
  await o.settle();
  assert.equal(o.loads(), 0);
  const stop = o.shrink.connect();
  await o.settle();
  assert.deepEqual(o.passes[0].offered, [c1]);
  stop();
  o.shrink.connect();
  o.shrink.offer(P1, image, 1280, 960);
  await o.settle();
  assert.equal(o.passes.length, 2);
  assert.deepEqual(o.passes[1].offered, [c1]);
});

test("CardShrinkOffers offers nothing on a device that doesn't draw cards", async () => {
  const o = offers({ allowed: false });
  o.shrink.connect();
  o.shrink.offer(P1, image, 1280, 960);
  await o.settle();
  assert.equal(o.loads(), 0);
});
