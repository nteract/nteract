import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { PAGE_CARD_KEY, PageCardWriter, pageCardWriterMachine } from "./page-card-writer.mjs";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const idle = (stored = H1) => ({ name: "idle", stored });
const queued = (stored = H1) => ({ name: "queued", stored });
const writing = (again = false, stored = H1) => ({ name: "writing", stored, again });
const stopped = { name: "stopped" };
const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });

const rows = [
  // unread
  { state: { name: "unread" }, event: { type: "restored", stored: H1 }, expect: ok(idle()) },
  {
    label: "a flush before the read writes whatever builds",
    state: { name: "unread" },
    event: { type: "requested" },
    expect: ok(queued(null)),
  },
  {
    state: { name: "unread" },
    event: { type: "start" },
    expect: no({ name: "unread" }, "no write is queued"),
  },
  { state: { name: "unread" }, event: { type: "stop" }, expect: ok(stopped) },
  // idle
  {
    state: idle(),
    event: { type: "restored", stored: H2 },
    expect: no(idle(), "the stored hash was already read"),
  },
  { state: idle(), event: { type: "requested" }, expect: ok(queued()) },
  { state: idle(), event: { type: "start" }, expect: no(idle(), "no write is queued") },
  { state: idle(), event: { type: "stop" }, expect: ok(stopped) },
  // queued
  {
    state: queued(),
    event: { type: "restored", stored: H2 },
    expect: no(queued(), "the stored hash was already read"),
  },
  {
    state: queued(),
    event: { type: "requested" },
    expect: no(queued(), "a write is already queued"),
  },
  {
    state: queued(),
    event: { type: "start" },
    expect: ok(writing(), [{ type: "write", stored: H1 }]),
  },
  { state: queued(), event: { type: "stop" }, expect: ok(stopped) },
  // writing
  {
    state: writing(),
    event: { type: "restored", stored: H2 },
    expect: no(writing(), "the stored hash was already read"),
  },
  {
    label: "a flush during a write asks for one more",
    state: writing(),
    event: { type: "requested" },
    expect: ok(writing(true)),
  },
  {
    state: writing(true),
    event: { type: "requested" },
    expect: no(writing(true), "another write is already asked for"),
  },
  { state: writing(), event: { type: "start" }, expect: no(writing(), "no write is queued") },
  { case: "done", state: writing(), event: { type: "written", hash: H2 }, expect: ok(idle(H2)) },
  {
    case: "again",
    state: writing(true),
    event: { type: "written", hash: H2 },
    expect: ok(queued(H2)),
  },
  {
    case: "done",
    label: "a failed write keeps the old hash; the next flush retries",
    state: writing(),
    event: { type: "failed" },
    expect: ok(idle()),
  },
  { case: "again", state: writing(true), event: { type: "failed" }, expect: ok(queued()) },
  { state: writing(), event: { type: "stop" }, expect: ok(stopped) },
  // stopped
  ...[
    { type: "restored", stored: null },
    { type: "requested" },
    { type: "start" },
    { type: "written", hash: H1 },
    { type: "failed" },
    { type: "stop" },
  ].map((event) => ({ state: stopped, event, expect: no(stopped, "the Page host stopped") })),
];

test("the page-card-writer machine covers every state and event", async () => {
  const result = await runTable(pageCardWriterMachine, rows);
  assert.equal(result.unreachable, 6);
});

/** A writer over in-memory storage and bucket, with its holds collected. */
function harness({ cards, put } = {}) {
  const values = new Map();
  const objects = new Map();
  const holds = [];
  const errors = [];
  let built = 0;
  const queue = [...(cards ?? [])];
  const writer = new PageCardWriter({
    build: async () => {
      built++;
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    store: {
      put: put ?? (async (bundle) => objects.set("card", bundle)),
      delete: async () => objects.delete("card"),
    },
    storage: {
      get: async (key) => values.get(key),
      put: async (key, value) => values.set(key, value),
    },
    hold: (work) => holds.push(work),
    onError: (error) => errors.push(error),
  });
  const settle = async () => {
    while (holds.length) await Promise.all(holds.splice(0));
  };
  return { writer, values, objects, errors, settle, built: () => built };
}

const card = (hash) => ({ v: 1, card_hash: hash, blocks: [] });

test("restoring starts nothing; a request waits for a live request's pump", async () => {
  const h = harness({ cards: [card(H1)] });
  await h.writer.restore();
  assert.deepEqual(h.writer.state, { name: "idle", stored: null });
  h.writer.request();
  assert.equal(h.writer.state.name, "queued");
  assert.equal(h.built(), 0, "a request starts nothing");
  h.writer.pump();
  await h.settle();
  assert.deepEqual(h.objects.get("card"), card(H1));
  assert.deepEqual(h.values.get(PAGE_CARD_KEY), { card_hash: H1 });
  assert.deepEqual(h.writer.state, { name: "idle", stored: H1 });
});

test("an unchanged hash skips the put; a changed one writes", async () => {
  const puts = [];
  const h = harness({
    cards: [card(H1), card(H1), card(H2)],
    put: async (bundle) => puts.push(bundle.card_hash),
  });
  h.values.set(PAGE_CARD_KEY, { card_hash: H1 });
  await h.writer.restore();
  assert.deepEqual(h.writer.state, { name: "idle", stored: H1 });
  h.writer.request();
  h.writer.pump();
  await h.settle();
  assert.deepEqual(puts, []);
  h.writer.request();
  h.writer.pump();
  await h.settle();
  assert.deepEqual(puts, []);
  h.writer.request();
  h.writer.pump();
  await h.settle();
  assert.deepEqual(puts, [H2]);
  assert.deepEqual(h.values.get(PAGE_CARD_KEY), { card_hash: H2 });
});

test("a failed put is logged, keeps the stored hash, and the next request retries", async () => {
  let fail = true;
  const h = harness({
    cards: [card(H2)],
    put: async () => {
      if (fail) throw Error("object store down");
    },
  });
  h.values.set(PAGE_CARD_KEY, { card_hash: H1 });
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  await h.settle();
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.writer.state, { name: "idle", stored: H1 });
  fail = false;
  h.writer.request();
  h.writer.pump();
  await h.settle();
  assert.deepEqual(h.writer.state, { name: "idle", stored: H2 });
});

test("a request during a write runs one more write in the same request", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const puts = [];
  const h = harness({
    cards: [card(H1), card(H2)],
    put: async (bundle) => {
      puts.push(bundle.card_hash);
      if (puts.length === 1) await gate;
    },
  });
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  await Promise.resolve();
  h.writer.request();
  h.writer.request();
  release();
  await h.settle();
  assert.deepEqual(puts, [H1, H2]);
  assert.deepEqual(h.writer.state, { name: "idle", stored: H2 });
});

test("a stop during a put removes the object it landed and stores no hash", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const h = harness({ cards: [card(H1)] });
  h.writer.store.put = async (bundle) => {
    await gate;
    h.objects.set("card", bundle);
  };
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  h.writer.stop();
  release();
  await h.settle();
  assert.equal(h.objects.has("card"), false);
  assert.equal(h.values.has(PAGE_CARD_KEY), false);
  assert.equal(h.errors.length, 0);
});

test("nothing to build (no document, a Page that isn't active) writes nothing", async () => {
  const h = harness({ cards: [null] });
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  await h.settle();
  assert.equal(h.objects.size, 0);
  assert.deepEqual(h.writer.state, { name: "idle", stored: null });
});
