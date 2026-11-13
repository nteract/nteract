import assert from "node:assert/strict";
import { test } from "node:test";
import { BehaviorSubject, Subject, VirtualTimeScheduler } from "rxjs";
import { runTable } from "../shared/machine-test.mjs";
import {
  CARD_CAPTURE_IDLE_MS,
  CARD_CAPTURE_REST_MS,
  CARD_HASH_DEBOUNCE_MS,
  CardCapture,
  captureAllowed,
  captureCards,
  cardCaptureMachine,
} from "./card-capture.mjs";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const base = { hash: A, stored: null, known: true, visible: true, resting: false };
const idle = (fields = {}) => ({ name: "idle", ...base, ...fields });
const waiting = (fields = {}) => ({ name: "waiting", ...base, ...fields });
const capturing = (fields = {}) => ({
  name: "capturing",
  ...base,
  resting: true,
  target: A,
  ...fields,
});
const stopped = (fields = {}) => ({ name: "stopped", ...base, visible: false, ...fields });
const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });
const arm = { type: "arm" };
const disarm = { type: "disarm" };
const cancel = { type: "cancel" };

const rows = [
  // idle
  {
    case: "holds",
    label: "a new hash before the stored one is known waits for it",
    state: idle({ known: false, hash: null }),
    event: { type: "changed", hash: A },
    expect: ok(idle({ known: false })),
  },
  {
    case: "wants",
    state: idle({ hash: null }),
    event: { type: "changed", hash: A },
    expect: ok(waiting(), [arm]),
  },
  {
    case: "holds",
    label: "a stored image of the local hash leaves nothing to do",
    state: idle({ known: false }),
    event: { type: "stored", hash: A },
    expect: ok(idle({ stored: A })),
  },
  {
    case: "wants",
    state: idle({ known: false }),
    event: { type: "stored", hash: B },
    expect: ok(waiting({ stored: B }), [arm]),
  },
  {
    case: "holds",
    label: "a visible tab with an empty first screen has nothing to draw",
    state: idle({ hash: null, visible: false }),
    event: { type: "visible" },
    expect: ok(idle({ hash: null })),
  },
  {
    case: "wants",
    state: idle({ visible: false }),
    event: { type: "visible" },
    expect: ok(waiting(), [arm]),
  },
  { state: idle(), event: { type: "hidden" }, expect: ok(idle({ visible: false })) },
  {
    state: idle({ resting: true }),
    event: { type: "elapsed" },
    expect: no(idle({ resting: true }), "no quiet timer is running"),
  },
  {
    state: idle({ resting: true }),
    event: { type: "captured", target: A, stored: A },
    expect: no(idle({ resting: true }), "not this capture"),
  },
  {
    state: idle({ resting: true }),
    event: { type: "failed", target: A },
    expect: no(idle({ resting: true }), "not this capture"),
  },
  {
    case: "holds",
    state: idle({ resting: true, stored: A }),
    event: { type: "rested" },
    expect: ok(idle({ stored: A })),
  },
  {
    case: "wants",
    label: "the rest ends with a new first screen waiting: it captures after quiet",
    state: idle({ resting: true }),
    event: { type: "rested" },
    expect: ok(waiting(), [arm]),
  },
  {
    case: "unrested",
    state: idle(),
    event: { type: "rested" },
    expect: no(idle(), "not resting"),
  },
  { state: idle(), event: { type: "stop" }, expect: ok(stopped()) },
  {
    state: idle({ resting: true }),
    event: { type: "input" },
    expect: no(idle({ resting: true }), "nothing waits for quiet"),
  },
  // waiting
  {
    case: "rearm",
    label: "any change restarts the quiet time",
    state: waiting(),
    event: { type: "changed", hash: B },
    expect: ok(waiting({ hash: B }), [arm]),
  },
  {
    case: "settles",
    label: "an edit back to the stored first screen drops the wait",
    state: waiting({ stored: B }),
    event: { type: "changed", hash: B },
    expect: ok(idle({ hash: B, stored: B }), [disarm]),
  },
  {
    case: "wants",
    state: waiting(),
    event: { type: "stored", hash: C },
    expect: ok(waiting({ stored: C })),
  },
  {
    case: "current",
    label: "another tab stored this hash: nothing to draw",
    state: waiting(),
    event: { type: "stored", hash: A },
    expect: ok(idle({ stored: A }), [disarm]),
  },
  { state: waiting(), event: { type: "visible" }, expect: ok(waiting()) },
  {
    state: waiting(),
    event: { type: "hidden" },
    expect: ok(idle({ visible: false }), [disarm]),
  },
  {
    label: "quiet time passed: capture the local hash and start the rest",
    state: waiting(),
    event: { type: "elapsed" },
    expect: ok(capturing(), [{ type: "capture", hash: A }, { type: "rest" }]),
  },
  {
    state: waiting(),
    event: { type: "captured", target: A, stored: A },
    expect: no(waiting(), "not this capture"),
  },
  {
    state: waiting(),
    event: { type: "failed", target: A },
    expect: no(waiting(), "not this capture"),
  },
  { state: waiting(), event: { type: "rested" }, expect: no(waiting(), "not resting") },
  { state: waiting(), event: { type: "stop" }, expect: ok(stopped(), [disarm]) },
  {
    label: "input restarts the quiet time",
    state: waiting(),
    event: { type: "input" },
    expect: ok(waiting(), [arm]),
  },
  // capturing
  {
    case: "same",
    label: "an edit below the fold keeps the capture",
    state: capturing(),
    event: { type: "changed", hash: A },
    expect: ok(capturing()),
  },
  {
    case: "moved",
    label: "the first screen changed mid-capture: cancel, and wait out the rest",
    state: capturing(),
    event: { type: "changed", hash: B },
    expect: ok(idle({ hash: B, resting: true }), [cancel]),
  },
  {
    state: capturing(),
    event: { type: "stored", hash: C },
    expect: ok(capturing({ stored: C })),
  },
  { state: capturing(), event: { type: "visible" }, expect: no(capturing(), "already visible") },
  {
    state: capturing(),
    event: { type: "hidden" },
    expect: ok(idle({ visible: false, resting: true }), [cancel]),
  },
  {
    state: capturing(),
    event: { type: "elapsed" },
    expect: no(capturing(), "no quiet timer is running"),
  },
  {
    case: "mine",
    state: capturing(),
    event: { type: "captured", target: A, stored: A },
    expect: ok(idle({ stored: A, resting: true })),
  },
  {
    case: "stale",
    label: "a capture's answer after a newer one started changes nothing",
    state: capturing({ target: B, hash: B }),
    event: { type: "captured", target: A, stored: A },
    expect: no(capturing({ target: B, hash: B }), "not this capture"),
  },
  {
    case: "mine",
    state: capturing(),
    event: { type: "failed", target: A },
    expect: ok(idle({ resting: true })),
  },
  {
    case: "stale",
    state: capturing({ target: B, hash: B }),
    event: { type: "failed", target: A },
    expect: no(capturing({ target: B, hash: B }), "not this capture"),
  },
  {
    label: "a slow capture outlives the rest: the next waits only for quiet",
    state: capturing(),
    event: { type: "rested" },
    expect: ok(capturing({ resting: false })),
  },
  { state: capturing(), event: { type: "stop" }, expect: ok(stopped({ resting: true }), [cancel]) },
  {
    label: "input stops the capture and gives back the rest: it tries again after quiet",
    state: capturing(),
    event: { type: "input" },
    expect: ok(waiting(), [cancel, { type: "unrest" }, arm]),
  },
  // stopped
  ...[
    { type: "changed", hash: B },
    { type: "stored", hash: B },
    { type: "visible" },
    { type: "hidden" },
    { type: "input" },
    { type: "elapsed" },
    { type: "captured", target: A, stored: A },
    { type: "failed", target: A },
    { type: "rested" },
    { type: "stop" },
  ].map((event) => ({ state: stopped(), event, expect: no(stopped(), "stopped") })),
];

test("the card-capture machine covers every state and event", async () => {
  assert.deepEqual(await runTable(cardCaptureMachine, rows), {
    rows: 50,
    pairs: 40,
    unreachable: 0,
    cases: 19,
  });
});

/** A CardCapture on virtual time, with a capture the test settles. */
function harness({ stored = null } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const hashes = new Subject();
  const visible = new BehaviorSubject(true);
  const input = new Subject();
  const captures = [];
  const capture = new CardCapture({
    hashes$: hashes,
    visible$: visible,
    input$: input,
    scheduler,
    readStored: async () => stored,
    capture: (hash, signal) =>
      new Promise((resolve, reject) => {
        const entry = { hash, signal, resolve, reject };
        captures.push(entry);
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  });
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  // A capture starts after the previous one settles, a microtask later.
  const advance = async (ms) => {
    // A no-op at the target time moves the clock there, so timers armed
    // after this start from it.
    scheduler.schedule(() => {}, ms);
    scheduler.maxFrames = scheduler.frame + ms;
    scheduler.flush();
    await tick();
  };
  return { scheduler, hashes, visible, input, captures, capture, advance, tick };
}

test("a new first screen captures once after quiet time, then rests", async () => {
  const h = harness();
  await h.tick();
  assert.equal(h.capture.state.known, true);
  h.hashes.next(A);
  assert.equal(h.capture.state.name, "waiting");
  await h.advance(CARD_CAPTURE_IDLE_MS - 1);
  h.hashes.next(A); // typing below the fold restarts the quiet time
  await h.advance(CARD_CAPTURE_IDLE_MS - 1);
  assert.equal(h.captures.length, 0);
  await h.advance(1);
  assert.equal(h.captures.length, 1);
  assert.equal(h.captures[0].hash, A);
  h.captures[0].resolve(A);
  await h.tick();
  await h.tick();
  assert.equal(h.capture.state.name, "idle");
  assert.equal(h.capture.state.stored, A);
  // A new screen during the rest waits for the rest to end.
  h.hashes.next(B);
  await h.advance(CARD_CAPTURE_IDLE_MS * 5);
  assert.equal(h.captures.length, 1);
  // The rest began when the first capture started; quiet time follows it.
  await h.advance(CARD_CAPTURE_REST_MS - CARD_CAPTURE_IDLE_MS * 5);
  assert.equal(h.capture.state.name, "waiting");
  assert.equal(h.captures.length, 1);
  await h.advance(CARD_CAPTURE_IDLE_MS);
  assert.equal(h.captures.length, 2);
  assert.equal(h.captures[1].hash, B);
});

test("a stored image of the local hash means no capture", async () => {
  const h = harness({ stored: A });
  await h.tick();
  h.hashes.next(A);
  await h.advance(CARD_CAPTURE_REST_MS);
  assert.equal(h.captures.length, 0);
  assert.equal(h.capture.state.name, "idle");
});

test("a hidden tab or a changed first screen cancels; captures never overlap", async () => {
  const h = harness();
  await h.tick();
  h.hashes.next(A);
  h.visible.next(false);
  await h.advance(CARD_CAPTURE_IDLE_MS * 2);
  assert.equal(h.captures.length, 0, "a hidden tab never starts one");
  h.visible.next(true);
  await h.advance(CARD_CAPTURE_IDLE_MS);
  assert.equal(h.captures.length, 1);
  h.hashes.next(B);
  assert.equal(h.captures[0].signal.aborted, true);
  // The rest started with the cancelled capture, so the next waits for it.
  await h.advance(CARD_CAPTURE_REST_MS + CARD_CAPTURE_IDLE_MS);
  await h.tick();
  assert.equal(h.captures.length, 2);
  assert.equal(h.captures[1].hash, B);
  h.visible.next(false);
  assert.equal(h.captures[1].signal.aborted, true);
  h.capture.stop();
  await h.advance(CARD_CAPTURE_REST_MS * 3);
  assert.equal(h.captures.length, 2, "nothing runs after stop");
});

test("input holds a capture back, and stops one that started without spending the rest", async () => {
  const h = harness();
  await h.tick();
  h.hashes.next(A);
  await h.advance(CARD_CAPTURE_IDLE_MS - 1);
  h.input.next();
  await h.advance(CARD_CAPTURE_IDLE_MS - 1);
  assert.equal(h.captures.length, 0, "a click restarted the quiet time");
  await h.advance(1);
  assert.equal(h.captures.length, 1);
  h.input.next();
  assert.equal(h.captures[0].signal.aborted, true);
  assert.equal(h.capture.state.name, "waiting");
  assert.equal(h.capture.state.resting, false);
  // The next try waits for quiet only, not the two-minute rest.
  await h.advance(CARD_CAPTURE_IDLE_MS);
  assert.equal(h.captures.length, 2);
  // The rest timer from the stopped capture never fires into the new one.
  h.captures[1].resolve(A);
  await h.tick();
  await h.tick();
  assert.equal(h.capture.state.stored, A);
  assert.equal(h.capture.state.resting, true);
  await h.advance(CARD_CAPTURE_REST_MS - 1);
  assert.equal(h.capture.state.resting, true, "the rest started with the second capture");
});

test("a failed capture rests, then tries again", async () => {
  const h = harness();
  await h.tick();
  h.hashes.next(A);
  await h.advance(CARD_CAPTURE_IDLE_MS);
  h.captures[0].reject(Error("upload answered 409"));
  await h.tick();
  await h.tick();
  assert.equal(h.capture.state.name, "idle");
  await h.advance(CARD_CAPTURE_REST_MS);
  await h.advance(CARD_CAPTURE_IDLE_MS);
  assert.equal(h.captures.length, 2);
});

test("Save-Data and low-memory devices never capture", () => {
  assert.equal(captureAllowed({}), true);
  assert.equal(captureAllowed({ connection: { saveData: true } }), false);
  assert.equal(captureAllowed({ deviceMemory: 1 }), false);
  assert.equal(captureAllowed({ deviceMemory: 8 }), true);
  let subscribed = false;
  const stop = captureCards(
    { pageId: "p", subscribe: () => ((subscribed = true), () => {}) },
    {
      browser: { document: {}, navigator: { connection: { saveData: true } } },
      fetch: () => assert.fail("nothing is fetched"),
    },
  );
  stop();
  assert.equal(subscribed, false);
});

/** captureCards over a fake session and document on virtual time. */
function tab({ role = "owner" } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const listeners = new Set();
  const session = {
    pageId: "11111111-1111-4111-8111-111111111111",
    access: { role },
    canWrite: true,
    hidden: false,
    doc: { version: 1 },
    views: { name: "views" },
    pageSources: { name: "sources" },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const document = new EventTarget();
  document.visibilityState = "visible";
  const browser = new EventTarget();
  Object.assign(browser, { document, navigator: {} });
  const requests = [];
  const drawn = [];
  const hashed = [];
  const stop = captureCards(session, {
    browser,
    fetch: async (url, init = {}) => {
      requests.push([init.method ?? "GET", url]);
      return Response.json({ card_hash: init.method === "PUT" ? A : null });
    },
    scheduler,
    loadModel: async () => ({
      pageCard: async (doc) => {
        hashed.push(doc);
        return { card_hash: A, blocks: doc.version ? [{}] : [] };
      },
    }),
    loadShell: async () => ({
      renderCardImages: async ({ signal, views, sources }) => {
        drawn.push({ signal, views, sources });
        return ["light", "dark"].map((theme) => ({
          theme,
          blob: new Blob([theme], { type: "image/webp" }),
        }));
      },
    }),
  });
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  const advance = async (ms) => {
    scheduler.schedule(() => {}, ms);
    scheduler.maxFrames = scheduler.frame + ms;
    scheduler.flush();
    await settle();
  };
  const emit = () => listeners.forEach((fn) => fn());
  return {
    session,
    document,
    browser,
    requests,
    drawn,
    hashed,
    stop,
    settle,
    advance,
    emit,
    listeners,
  };
}

test("captureCards: editors' and viewers' tabs never hash, read the stored hash or draw", async () => {
  for (const role of ["editor", "viewer", "commenter"]) {
    const t = tab({ role });
    await t.settle();
    for (let version = 2; version < 5; version++) {
      t.session.doc = { version };
      t.emit();
      await t.advance(CARD_HASH_DEBOUNCE_MS + CARD_CAPTURE_IDLE_MS);
    }
    assert.deepEqual(t.requests, [], `${role}: no request`);
    assert.deepEqual(t.hashed, [], `${role}: no hashing`);
    assert.equal(t.drawn.length, 0);
    t.stop();
    assert.equal(t.listeners.size, 0);
  }
});

test("captureCards: the owner's tab starts once its access shows, then captures after quiet", async () => {
  const t = tab({ role: "editor" });
  await t.settle();
  await t.advance(CARD_CAPTURE_IDLE_MS * 2);
  assert.deepEqual(t.requests, []);
  // Access arrives later, as a PageSession's does.
  t.session.access = { role: "owner" };
  t.emit();
  await t.advance(CARD_HASH_DEBOUNCE_MS);
  // A click during the quiet time restarts it.
  t.document.dispatchEvent(new Event("pointerdown"));
  await t.advance(CARD_CAPTURE_IDLE_MS - 1);
  assert.equal(t.drawn.length, 0);
  await t.advance(1);
  assert.equal(t.drawn.length, 1);
  // The shell draws charts from the session's own views and sources.
  assert.equal(t.drawn[0].views, t.session.views);
  assert.equal(t.drawn[0].sources, t.session.pageSources);
  assert.deepEqual(t.requests, [
    ["GET", `/api/pages/${t.session.pageId}/card-image`],
    ["PUT", `/api/pages/${t.session.pageId}/card-image?hash=${A}&theme=light`],
    ["PUT", `/api/pages/${t.session.pageId}/card-image?hash=${A}&theme=dark`],
  ]);
  t.stop();
  assert.equal(t.listeners.size, 0);
});

test("captureCards: pagehide into the back/forward cache keeps the capture; a real unload stops it", async () => {
  const t = tab();
  await t.settle();
  await t.advance(CARD_HASH_DEBOUNCE_MS);
  t.browser.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: true }));
  await t.advance(CARD_CAPTURE_IDLE_MS);
  assert.equal(t.drawn.length, 1, "a cached page keeps its schedule");
  const u = tab();
  await u.settle();
  await u.advance(CARD_HASH_DEBOUNCE_MS);
  u.browser.dispatchEvent(Object.assign(new Event("pagehide"), { persisted: false }));
  await u.advance(CARD_CAPTURE_IDLE_MS * 3);
  assert.equal(u.drawn.length, 0, "an unloading page stops");
  t.stop();
  u.stop();
});
