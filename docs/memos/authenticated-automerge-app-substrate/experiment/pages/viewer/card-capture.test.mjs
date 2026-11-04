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
  // stopped
  ...[
    { type: "changed", hash: B },
    { type: "stored", hash: B },
    { type: "visible" },
    { type: "hidden" },
    { type: "elapsed" },
    { type: "captured", target: A, stored: A },
    { type: "failed", target: A },
    { type: "rested" },
    { type: "stop" },
  ].map((event) => ({ state: stopped(), event, expect: no(stopped(), "stopped") })),
];

test("the card-capture machine covers every state and event", async () => {
  assert.deepEqual(await runTable(cardCaptureMachine, rows), {
    rows: 46,
    pairs: 36,
    unreachable: 0,
    cases: 19,
  });
});

/** A CardCapture on virtual time, with a capture the test settles. */
function harness({ stored = null } = {}) {
  const scheduler = new VirtualTimeScheduler();
  const hashes = new Subject();
  const visible = new BehaviorSubject(true);
  const captures = [];
  const capture = new CardCapture({
    hashes$: hashes,
    visible$: visible,
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
  return { scheduler, hashes, visible, captures, capture, advance, tick };
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

test("captureCards: only the owner's visible tab captures, from the debounced hash", async () => {
  const scheduler = new VirtualTimeScheduler();
  const listeners = new Set();
  const session = {
    pageId: "11111111-1111-4111-8111-111111111111",
    access: { role: "editor" },
    canWrite: true,
    hidden: false,
    doc: { version: 1 },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  const emit = () => listeners.forEach((fn) => fn());
  const document = new EventTarget();
  document.visibilityState = "visible";
  const requests = [];
  const fetch = async (url, init = {}) => {
    requests.push([init.method ?? "GET", url]);
    return Response.json({ card_hash: init.method === "PUT" ? A : null });
  };
  const drawn = [];
  const stop = captureCards(session, {
    browser: { document, navigator: {}, addEventListener() {}, removeEventListener() {} },
    fetch,
    scheduler,
    loadModel: async () => ({
      pageCard: async (doc) => ({ card_hash: A, blocks: doc.version ? [{}] : [] }),
    }),
    loadShell: async () => ({
      renderCardImages: async ({ signal }) => {
        drawn.push(signal);
        return ["light", "dark"].map((theme) => ({
          theme,
          blob: new Blob([theme], { type: "image/webp" }),
        }));
      },
    }),
  });
  const advance = (ms) => {
    scheduler.schedule(() => {}, ms);
    scheduler.maxFrames = scheduler.frame + ms;
    scheduler.flush();
  };
  const settle = async () => {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  };
  await settle();
  advance(CARD_HASH_DEBOUNCE_MS);
  await settle();
  advance(CARD_CAPTURE_IDLE_MS * 2);
  await settle();
  assert.equal(drawn.length, 0, "an editor's tab never captures");
  session.access = { role: "owner" };
  emit();
  advance(CARD_CAPTURE_IDLE_MS);
  await settle();
  assert.equal(drawn.length, 1);
  assert.deepEqual(requests, [
    ["GET", `/api/pages/${session.pageId}/card-image`],
    ["PUT", `/api/pages/${session.pageId}/card-image?hash=${A}&theme=light`],
    ["PUT", `/api/pages/${session.pageId}/card-image?hash=${A}&theme=dark`],
  ]);
  stop();
  assert.equal(listeners.size, 0);
});
