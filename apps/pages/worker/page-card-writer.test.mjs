import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import { PAGE_CARD_KEY, PageCardWriter, pageCardWriterMachine } from "./page-card-writer.mjs";
import { cardBucket } from "./card-bucket-fixture.mjs";
import { cardKey } from "../model/page-card.mjs";
import {
  cardImageMetadata,
  cardImagePointerKey,
  cardImageRecordOf,
  cardObjectStore,
  storeCardImage,
} from "./card-images.mjs";

const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const idle = (stored = H1) => ({ name: "idle", stored });
const queued = (stored = H1) => ({ name: "queued", stored });
const writing = (again = false, stored = H1) => ({ name: "writing", stored, again });
const stopped = { name: "stopped", deleting: false };
const deleted = { name: "stopped", deleting: true };
const stop = { type: "stop", deleting: false };
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
  { state: { name: "unread" }, event: stop, expect: ok(stopped) },
  {
    label: "a deleting stop remembers the deletion",
    state: { name: "unread" },
    event: { type: "stop", deleting: true },
    expect: ok(deleted),
  },
  // idle
  {
    state: idle(),
    event: { type: "restored", stored: H2 },
    expect: no(idle(), "the stored hash was already read"),
  },
  { state: idle(), event: { type: "requested" }, expect: ok(queued()) },
  { state: idle(), event: { type: "start" }, expect: no(idle(), "no write is queued") },
  { state: idle(), event: stop, expect: ok(stopped) },
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
  { state: queued(), event: stop, expect: ok(stopped) },
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
  { state: writing(), event: stop, expect: ok(stopped) },
  { state: writing(), event: { type: "stop", deleting: true }, expect: ok(deleted) },
  // stopped
  ...[
    { type: "restored", stored: null },
    { type: "requested" },
    { type: "start" },
    { type: "written", hash: H1 },
    { type: "failed" },
  ].map((event) => ({ state: stopped, event, expect: no(stopped, "the Page host stopped") })),
  {
    case: "deleting",
    label: "a retired host's Page can still be deleted",
    state: stopped,
    event: { type: "stop", deleting: true },
    expect: ok(deleted),
  },
  { case: "again", state: stopped, event: stop, expect: no(stopped, "the Page host stopped") },
  {
    case: "again",
    state: deleted,
    event: { type: "stop", deleting: true },
    expect: no(deleted, "the Page host stopped"),
  },
  {
    case: "again",
    label: "a deletion stays a deletion",
    state: deleted,
    event: stop,
    expect: no(deleted, "the Page host stopped"),
  },
];

test("the page-card-writer machine covers every state and event", async () => {
  const result = await runTable(pageCardWriterMachine, rows);
  assert.equal(result.unreachable, 6);
});

/** The card's object store over a bucket, as the Page host adapts it
 * (card-images.mjs cardObjectStore, without its deadlines). */
const PAGE = "p";
const KEY = cardKey(PAGE);
function storeOver(bucket) {
  return { ...cardObjectStore(bucket, PAGE), delete: () => bucket.delete(KEY) };
}

/** A writer over in-memory storage and bucket, with its holds collected. */
function harness({ cards, bucket = cardBucket(), now } = {}) {
  const values = new Map();
  const holds = [];
  const errors = [];
  const skips = [];
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
    onSkip: () => skips.push(true),
    ...(now && { now }),
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
  // The card hashes this writer tried to put, refused ones included.
  const store = writer.store;
  const put = store.put;
  store.put = async (bundle, options) => {
    puts.push(bundle.card_hash);
    return put(bundle, options);
  };
  return {
    writer,
    bucket,
    values,
    errors,
    skips,
    puts,
    settle,
    flush,
    object: () => bucket.card(KEY),
    built: () => built,
  };
}

const card = (hash, contentUpdatedAt) => ({
  v: 1,
  card_hash: hash,
  blocks: [],
  ...(contentUpdatedAt && { content_updated_at: contentUpdatedAt }),
});
const T1 = "2026-11-04T10:00:00.000Z";
const T2 = "2026-11-04T10:01:00.000Z";
const T3 = "2026-11-04T10:02:00.000Z";
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
  // A later write of the same card trusts host/card: no read, no put.
  h.bucket.heads.length = 0;
  await h.flush();
  assert.deepEqual(h.puts, [H2]);
  assert.deepEqual(h.bucket.heads, []);
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

/** Run `write` once, between the writer's next read and its put. */
function betweenReadAndPut(h, write) {
  h.bucket.beforePut = async (key) => {
    if (key !== KEY) return;
    h.bucket.beforePut = null;
    await write();
  };
}

test("a put refused by its condition reads the etag again and retries once", async () => {
  const h = harness({ cards: [card(H1), card(H2)] });
  await h.writer.restore();
  await h.flush();
  // Someone else writes between this host's read and put.
  betweenReadAndPut(h, () => h.bucket.seed(KEY, card("3".repeat(64))));
  h.puts.length = 0;
  await h.flush();
  assert.equal(h.puts.length, 2, "refused, then written");
  assert.deepEqual(h.object(), card(H2));
  assert.equal(h.errors.length, 0);
});

test("a writer that was never stopped can't overwrite a newer card after its put is refused", async () => {
  const bucket = cardBucket();
  const old = harness({ bucket, cards: [card(H1, T1), card("3".repeat(64), T3)] });
  const { release, putting } = heldPut(old);
  await old.writer.restore();
  old.writer.request();
  old.writer.pump();
  await putting;
  // A second host writes a newer card while the first is still live.
  bucket.beforePut = null;
  const next = harness({ bucket, cards: [card(H2, T2)] });
  await next.writer.restore();
  await next.flush();
  release();
  await old.settle();
  assert.deepEqual(next.object(), card(H2, T2), "the newer card stays");
  assert.equal(bucket.refused, 1, "refused once, and not retried");
  assert.deepEqual(old.writer.state, { name: "idle", stored: null }, "nothing of its own landed");
  assert.equal(old.errors.length, 0, "a newer card is not a failure to log");
  assert.equal(old.skips.length, 1, "the skip is logged");
  // Its next write reads the object again, and a later card writes.
  await old.flush();
  assert.deepEqual(old.object(), card("3".repeat(64), T3));
  assert.equal(bucket.refused, 1);
});

test("a host's first write leaves a newer card alone", async () => {
  const h = harness({ cards: [card(H1, T1), card(H1, T3)] });
  await h.bucket.put(KEY, JSON.stringify(card(H2, T2)), {
    customMetadata: { card_hash: H2, content_updated_at: T2 },
  });
  h.puts.length = 0;
  await h.writer.restore();
  await h.flush();
  assert.deepEqual(h.puts, []);
  assert.deepEqual(h.object(), card(H2, T2));
  assert.deepEqual(h.writer.state, { name: "idle", stored: null });
  assert.equal(h.errors.length, 0);
  await h.flush();
  assert.deepEqual(h.puts, [H1], "a later card writes");
});

test("equal content times with different hashes still put; the later put wins", async () => {
  const h = harness({ cards: [card(H1, T2)] });
  await h.bucket.put(KEY, JSON.stringify(card(H2, T2)), {
    customMetadata: { card_hash: H2, content_updated_at: T2 },
  });
  h.puts.length = 0;
  await h.writer.restore();
  await h.flush();
  assert.deepEqual(h.puts, [H1]);
  assert.deepEqual(h.object(), card(H1, T2));
});

test("a stop during the refused put's second read puts nothing", async () => {
  const h = harness({ cards: [card(H1, T1), card("4".repeat(64), T3)] });
  await h.writer.restore();
  await h.flush();
  // A newer host writes between this host's read and put, without a later
  // time; the host stops during the read after the refusal.
  betweenReadAndPut(h, () => h.bucket.seed(KEY, card(H2)));
  const head = h.bucket.head.bind(h.bucket);
  let reads = 0;
  h.bucket.head = async (key) => {
    if (key === KEY && ++reads === 2) h.writer.stop();
    return head(key);
  };
  h.puts.length = 0;
  await h.flush();
  assert.equal(reads, 2);
  assert.deepEqual(h.puts, ["4".repeat(64)], "the refused put, and no retry");
  assert.deepEqual(h.object(), card(H2));
  assert.equal(h.writer.state.name, "stopped");
  assert.equal(h.errors.length, 0);
});

test("an object time past the clock-skew limit never blocks a write; one within it does", async () => {
  const now = Date.parse(T2);
  const at = (ms) => new Date(now + ms).toISOString();
  for (const [label, ahead, expected] of [
    ["10 minutes ahead counts as missing", 10 * 60_000, [H1]],
    ["4 minutes ahead is a newer card", 4 * 60_000, []],
  ]) {
    const h = harness({ cards: [card(H1, T2)], now: () => now });
    await h.bucket.put(KEY, JSON.stringify(card(H2, at(ahead))), {
      customMetadata: { card_hash: H2, content_updated_at: at(ahead) },
    });
    h.puts.length = 0;
    await h.writer.restore();
    await h.flush();
    assert.deepEqual(h.puts, expected, label);
    assert.equal(h.skips.length, expected.length ? 0 : 1, label);
    assert.equal(h.errors.length, 0, label);
  }
});

test("a refused put retries over an object time past the clock-skew limit", async () => {
  const now = Date.parse(T2);
  const ahead = new Date(now + 10 * 60_000).toISOString();
  const h = harness({ cards: [card(H1, T1), card("4".repeat(64), T2)], now: () => now });
  await h.writer.restore();
  await h.flush();
  // A node whose clock ran 10 minutes fast writes between this host's read
  // and put.
  betweenReadAndPut(h, () =>
    h.bucket.put(KEY, JSON.stringify(card(H2, ahead)), {
      customMetadata: { card_hash: H2, content_updated_at: ahead },
    }),
  );
  h.puts.length = 0;
  await h.flush();
  assert.equal(h.puts.length, 2, "refused, then written");
  assert.deepEqual(h.object(), card("4".repeat(64), T2));
  assert.equal(h.skips.length, 0);
});

// The card object is shared with card image uploads (card-images.mjs): the
// writer copies their record, and they copy its card.

/** A 3x2 WebP (the card-images.test.mjs fixture). */
const WEBP = new Uint8Array(
  Buffer.from(
    "UklGRjgAAABXRUJQVlA4ICwAAADwAQCdASoDAAIAAUAmJaACdLoB+AAEyAAA/q4X/yU1/jblq/+QXq3zbGgAAA==",
    "base64",
  ),
);
/** Both themes of an owner's capture of first screen `hash`. */
async function capture(bucket, hash, revision = 1) {
  for (const theme of ["light", "dark"])
    await storeCardImage(bucket, { pageId: PAGE, hash, theme, bytes: WEBP, revision });
}
/** What page_cards would answer: the card's hash and the hash of the image
 * it shows (null: none). */
function answer(h) {
  const record = cardImageRecordOf(h.bucket.objects.get(KEY)?.customMetadata);
  const hash = h.object()?.card_hash ?? null;
  const complete = record?.themes.light && record?.themes.dark;
  return { card: hash, image: complete && record.card_hash === hash ? hash : null };
}

test("a card write copies the image record: an upload for its hash shows with it", async () => {
  const h = harness({ cards: [card(H1), card(H2)] });
  await h.writer.restore();
  await h.flush();
  // The owner's tab captures H2 before the host's next flush writes it.
  await capture(h.bucket, H2);
  assert.deepEqual(answer(h), { card: H1, image: null }, "an image for another hash never shows");
  await h.flush();
  assert.deepEqual(answer(h), { card: H2, image: H2 });
  assert.equal(h.bucket.refused, 0, "the read before the put saw the upload");
});

test("a card write racing an upload ends consistent, in either order", async () => {
  // The upload lands between the card write's read and put: the put is
  // refused, reads again and copies the record.
  const first = harness({ cards: [card(H1), card(H2)] });
  await first.writer.restore();
  await first.flush();
  betweenReadAndPut(first, () => capture(first.bucket, H2));
  await first.flush();
  assert.equal(first.bucket.refused, 1);
  assert.deepEqual(first.puts, [H1, H2, H2]);
  assert.deepEqual(answer(first), { card: H2, image: H2 });

  // The card write lands between the upload's read and put: the upload's
  // put is refused, reads again and keeps the new card.
  const second = harness({ cards: [card(H1), card(H2)] });
  await second.writer.restore();
  await second.flush();
  betweenReadAndPut(second, () => second.flush());
  await capture(second.bucket, H2);
  assert.equal(second.bucket.refused, 1);
  assert.deepEqual(answer(second), { card: H2, image: H2 });

  // An upload for the first screen the card write just replaced is stored
  // but never shown on the newer card.
  const stale = harness({ cards: [card(H1), card(H2)] });
  await stale.writer.restore();
  await stale.flush();
  betweenReadAndPut(stale, () => stale.flush());
  await capture(stale.bucket, H1);
  assert.equal(stale.bucket.refused, 1);
  assert.equal(stale.object().card_hash, H2, "the card write was kept");
  assert.deepEqual(answer(stale), { card: H2, image: null });
});

test("a card write over a legacy object copies the legacy pointer's record", async () => {
  const h = harness({ cards: [card(H2), card("3".repeat(64))] });
  await h.bucket.seed(KEY, card(H1), { legacy: true });
  await h.bucket.put(cardImagePointerKey(PAGE), "", {
    customMetadata: { card_hash: H2, revision: "4", light: "webp", dark: "png" },
  });
  await h.writer.restore();
  await h.flush();
  const metadata = h.bucket.objects.get(KEY).customMetadata;
  assert.deepEqual(metadata, {
    card_hash: H2,
    content_updated_at: "",
    ...cardImageMetadata({ card_hash: H2, revision: 4, themes: { light: "webp", dark: "png" } }),
  });
  assert.deepEqual(answer(h), { card: H2, image: H2 }, "the picture survives the rewrite");
  // The record now lives in card.json: the next write never reads the pointer.
  h.bucket.heads.length = 0;
  await h.flush();
  assert.deepEqual(h.bucket.heads, [KEY]);
  assert.equal(cardImageRecordOf(h.bucket.objects.get(KEY).customMetadata).card_hash, H2);
});
