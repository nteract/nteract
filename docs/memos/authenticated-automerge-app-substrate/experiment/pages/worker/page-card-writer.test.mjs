import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { PAGE_CARD_KEY, PageCardWriter, pageCardWriterMachine } from "./page-card-writer.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";

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

/** The card's object store over a bucket, as the Page host adapts it. */
const KEY = "pages/p/card.json";
function storeOver(bucket) {
  return {
    head: async () => {
      const object = await bucket.head(KEY);
      return object
        ? { etag: object.etag, card_hash: object.customMetadata.card_hash ?? null }
        : null;
    },
    put: async (bundle, { etag }) => {
      const object = await bucket.put(KEY, JSON.stringify(bundle), {
        customMetadata: { card_hash: bundle.card_hash },
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: "*" },
      });
      return object ? { etag: object.etag } : null;
    },
    delete: () => bucket.delete(KEY),
  };
}

/** A writer over in-memory storage and bucket, with its holds collected. */
function harness({ cards, bucket = cardBucket() } = {}) {
  const values = new Map();
  const holds = [];
  const errors = [];
  let built = 0;
  const queue = [...(cards ?? [])];
  const writer = new PageCardWriter({
    build: async () => {
      built++;
      return queue.length > 1 ? queue.shift() : queue[0];
    },
    store: storeOver(bucket),
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
  const flush = async () => {
    writer.request();
    writer.pump();
    await settle();
  };
  const puts = [];
  const put = bucket.put.bind(bucket);
  bucket.put = async (key, value, options) => {
    puts.push(JSON.parse(value).card_hash);
    return put(key, value, options);
  };
  return {
    writer,
    bucket,
    values,
    errors,
    puts,
    settle,
    flush,
    object: () => bucket.card(KEY),
    built: () => built,
  };
}

const card = (hash) => ({ v: 1, card_hash: hash, blocks: [] });
/** A promise and its resolver. */
const gate = () => {
  let open;
  const promise = new Promise((resolve) => (open = resolve));
  return { promise, open };
};

test("restoring starts nothing; a request waits for a live request's pump", async () => {
  const h = harness({ cards: [card(H1)] });
  await h.writer.restore();
  assert.deepEqual(h.writer.state, { name: "idle", stored: null });
  h.writer.request();
  assert.equal(h.writer.state.name, "queued");
  assert.equal(h.built(), 0, "a request starts nothing");
  h.writer.pump();
  await h.settle();
  assert.deepEqual(h.object(), card(H1));
  assert.deepEqual(h.values.get(PAGE_CARD_KEY), { card_hash: H1 });
  assert.deepEqual(h.writer.state, { name: "idle", stored: H1 });
});

test("an unchanged hash skips the put; a changed one writes", async () => {
  const h = harness({ cards: [card(H1), card(H1), card(H2)] });
  await h.bucket.seed(KEY, card(H1));
  h.puts.length = 0;
  h.values.set(PAGE_CARD_KEY, { card_hash: H1 });
  await h.writer.restore();
  assert.deepEqual(h.writer.state, { name: "idle", stored: H1 });
  await h.flush();
  await h.flush();
  assert.deepEqual(h.puts, []);
  await h.flush();
  assert.deepEqual(h.puts, [H2]);
  assert.deepEqual(h.values.get(PAGE_CARD_KEY), { card_hash: H2 });
  assert.equal(h.bucket.refused, 0);
});

test("a failed put is logged, keeps the stored hash, and the next request retries", async () => {
  const h = harness({ cards: [card(H2)] });
  h.values.set(PAGE_CARD_KEY, { card_hash: H1 });
  await h.writer.restore();
  h.bucket.fail = true;
  await h.flush();
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.writer.state, { name: "idle", stored: H1 });
  h.bucket.fail = false;
  await h.flush();
  assert.deepEqual(h.writer.state, { name: "idle", stored: H2 });
  assert.deepEqual(h.object(), card(H2));
});

test("a request during a write runs one more write in the same request", async () => {
  const hold = gate();
  const h = harness({ cards: [card(H1), card(H2)] });
  let first = true;
  h.bucket.beforePut = async () => {
    if (first) {
      first = false;
      await hold.promise;
    }
  };
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  await Promise.resolve();
  h.writer.request();
  h.writer.request();
  hold.open();
  await h.settle();
  assert.deepEqual(h.puts, [H1, H2]);
  assert.deepEqual(h.writer.state, { name: "idle", stored: H2 });
});

/** A writer whose first put waits for `release`, and a promise that
 * resolves once that put is running. */
function heldPut(h) {
  const hold = gate();
  const entered = gate();
  h.bucket.beforePut = async () => {
    entered.open();
    await hold.promise;
  };
  return { release: hold.open, putting: entered.promise };
}

test("a deleting stop during a put removes the object it landed and stores no hash", async () => {
  const h = harness({ cards: [card(H1)] });
  const { release, putting } = heldPut(h);
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  await putting;
  h.writer.stop({ deleting: true });
  release();
  await h.settle();
  assert.deepEqual(h.puts, [H1], "the put ran to the end");
  assert.equal(h.object(), undefined);
  assert.equal(h.values.has(PAGE_CARD_KEY), false);
  assert.equal(h.errors.length, 0);
});

test("a deleting stop during a put that lands and then times out still removes the object", async () => {
  const h = harness({ cards: [card(H1)] });
  const { release, putting } = heldPut(h);
  const store = h.writer.store;
  const put = store.put;
  store.put = async (...args) => {
    await put(...args);
    throw Error("Page card write timed out");
  };
  let deletes = 0;
  const remove = store.delete;
  store.delete = async () => {
    deletes++;
    return remove();
  };
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  await putting;
  h.writer.stop({ deleting: true });
  release();
  await h.settle();
  assert.equal(h.object(), undefined, "no orphan card");
  assert.equal(deletes, 1);
  assert.equal(h.errors.length, 0, "a stopped writer logs nothing");
  // A delete that fails as well is swallowed: the orphan is never served.
  const again = harness({ cards: [card(H1)] });
  const hold = gate();
  const entered = gate();
  let tried = 0;
  again.writer.store.put = async () => {
    entered.open();
    await hold.promise;
    throw Error("Page card write timed out");
  };
  again.writer.store.delete = async () => {
    tried++;
    throw Error("object store unavailable");
  };
  await again.writer.restore();
  again.writer.request();
  again.writer.pump();
  await entered.promise;
  again.writer.stop({ deleting: true });
  hold.open();
  await again.settle();
  assert.equal(tried, 1, "the stopped writer tried the delete");
  assert.equal(again.errors.length, 0);
});

test("nothing to build (no document, a Page that isn't active) writes nothing", async () => {
  const h = harness({ cards: [null] });
  await h.writer.restore();
  await h.flush();
  assert.equal(h.object(), undefined);
  assert.deepEqual(h.writer.state, { name: "idle", stored: null });
});

test("a retiring stop during a put keeps the object and stores no hash", async () => {
  const h = harness({ cards: [card(H1)] });
  const { release, putting } = heldPut(h);
  await h.writer.restore();
  h.writer.request();
  h.writer.pump();
  await putting;
  // An abandoned boot, a closed policy or a storage migration: the Page
  // lives on under the next host.
  h.writer.stop();
  release();
  await h.settle();
  assert.deepEqual(h.object(), card(H1));
  assert.equal(h.values.has(PAGE_CARD_KEY), false);
  assert.equal(h.errors.length, 0);
});

test("a retiring host's late put can't overwrite the next host's newer card", async () => {
  const bucket = cardBucket();
  const old = harness({ bucket, cards: [card(H1)] });
  const { release, putting } = heldPut(old);
  await old.writer.restore();
  old.writer.request();
  old.writer.pump();
  await putting;
  // The old host retires with its put in flight; the next host boots on the
  // same storage and bucket and writes the newer card first.
  old.writer.stop();
  bucket.beforePut = null;
  const next = harness({ bucket, cards: [card(H2)] });
  await next.writer.restore();
  await next.flush();
  assert.deepEqual(next.object(), card(H2));
  release();
  await old.settle();
  assert.deepEqual(next.object(), card(H2), "the late put was refused");
  assert.equal(bucket.refused, 1);
});

test("a host's first write rewrites a stale object even when host/card matches", async () => {
  const h = harness({ cards: [card(H2)] });
  // host/card says H2, but a late put from an older host left H1 behind.
  h.values.set(PAGE_CARD_KEY, { card_hash: H2 });
  await h.bucket.seed(KEY, card(H1));
  h.puts.length = 0;
  await h.writer.restore();
  await h.flush();
  assert.deepEqual(h.puts, [H2]);
  assert.deepEqual(h.object(), card(H2));
  // Later writes trust host/card and the etag they hold: no read, no put.
  await h.flush();
  assert.deepEqual(h.puts, [H2]);
});

test("a host's first write adopts a matching object without a put", async () => {
  const h = harness({ cards: [card(H1)] });
  await h.bucket.seed(KEY, card(H1));
  h.puts.length = 0;
  await h.writer.restore();
  await h.flush();
  assert.deepEqual(h.puts, []);
  assert.deepEqual(h.values.get(PAGE_CARD_KEY), { card_hash: H1 }, "host/card catches up");
});

test("a put refused by its condition reads the etag again and retries once", async () => {
  const h = harness({ cards: [card(H1), card(H2)] });
  await h.writer.restore();
  await h.flush();
  // Someone else writes between this host's writes.
  await h.bucket.seed(KEY, card("3".repeat(64)));
  h.puts.length = 0;
  await h.flush();
  assert.equal(h.puts.length, 2, "refused, then written");
  assert.deepEqual(h.object(), card(H2));
  assert.equal(h.errors.length, 0);
});
