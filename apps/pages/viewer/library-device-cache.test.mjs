// The library's device cache: what a record holds and for whom, how the
// Listing paints from it and reconciles, the merge order of device-only
// drafts, and the grid cards it keeps.
import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { VirtualTimeScheduler } from "rxjs";
import { LocalStore } from "./local-store.mjs";
import {
  DEVICE_CARD_MAX_BYTES,
  DEVICE_CLOCK_SKEW_MS,
  DEVICE_RECORD_MAX_AGE_MS,
  DEVICE_ROWS_MAX,
  DEVICE_TITLE_MAX,
  LIBRARY_DEVICE_VERSION,
  LibraryDeviceCache,
  deviceKey,
  readRecord,
  storedRows,
} from "./library-device-cache.mjs";
import { ListingCache, deviceView } from "./listing-cache.mjs";
import { Listing, deviceRows, listingView, pageRow } from "./listing.mjs";
import { PAGE_CARDS_GATHER_MS, PageCards, cardKeyOf } from "./page-cards.mjs";

let databases = 0;
const fresh = (options) =>
  new LibraryDeviceCache({
    store: new LocalStore({ database: `library-device-test-${++databases}` }),
    ...options,
  });
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owned = (n, extra = {}) => ({
  page_id: id(n),
  title: `Page ${n}`,
  updated_at: "2026-11-10T10:00:00.000Z",
  content_updated_at: `2026-11-10T10:00:0${n % 10}.000Z`,
  project_id: null,
  shared: false,
  ...extra,
});
const sharedRow = (n) => ({
  page_id: id(n),
  title: `Shared ${n}`,
  updated_at: "2026-11-09T10:00:00.000Z",
  content_updated_at: null,
  project_id: "prj_x",
  shared: true,
});
const CARD = { v: 1, card_hash: "h", blocks: [{ id: "b", content: [["p", {}, "Hi"]] }] };
const settle = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
};

test("a record holds one account's first page, and only that account reads it", async () => {
  const device = fresh();
  await device.write("alice", [owned(1), owned(2)]);
  const read = await device.read("alice");
  assert.deepEqual(
    read.rows.map((row) => row.page_id),
    [id(1), id(2)],
  );
  assert.equal(read.rows[0].title, "Page 1");
  assert.equal(await device.read("bob"), null, "another account reads nothing");
  assert.equal(await device.read(null), null, "no account, no read");
  assert.deepEqual(await device.keys(), [deviceKey("alice")]);
  assert.match(deviceKey("a/b"), new RegExp(`^library/v${LIBRARY_DEVICE_VERSION}/a%2Fb$`));
});

test("a shared row keeps only its place: no title, Project or card", async () => {
  const rows = storedRows([owned(1), sharedRow(2)]);
  assert.deepEqual(rows[1], {
    page_id: id(2),
    shared: true,
    held: true,
    updated_at: "2026-11-09T10:00:00.000Z",
    content_updated_at: null,
  });
  const device = fresh();
  await device.write("alice", [owned(1), sharedRow(2)]);
  await device.writeCards("alice", [
    { id: id(2), at: null, card: CARD },
    { id: id(1), at: owned(1).content_updated_at, card: CARD },
  ]);
  const read = await device.read("alice");
  assert.deepEqual(
    read.cards.map((entry) => entry.id),
    [id(1)],
  );
  assert.equal(JSON.stringify(read).includes("Shared 2"), false);
});

test("a record is bounded: the first page, clipped titles, small cards", async () => {
  const many = Array.from({ length: 80 }, (_, n) => owned(n + 1));
  const rows = storedRows(many);
  assert.equal(rows.length, DEVICE_ROWS_MAX);
  const [long] = storedRows([owned(1, { title: "x".repeat(DEVICE_TITLE_MAX + 50) })]);
  assert.equal(long.title.length, DEVICE_TITLE_MAX);
  const device = fresh();
  await device.write("alice", [owned(1), owned(2)]);
  const huge = {
    ...CARD,
    blocks: [{ id: "b", content: [["p", {}, "y".repeat(DEVICE_CARD_MAX_BYTES)]] }],
  };
  await device.writeCards("alice", [
    { id: id(1), at: owned(1).content_updated_at, card: huge },
    { id: id(2), at: owned(2).content_updated_at, card: CARD },
  ]);
  const read = await device.read("alice");
  assert.deepEqual(
    read.cards.map((entry) => entry.id),
    [id(2)],
    "a card past the bound isn't kept",
  );
});

test("a card is kept for the content time it was asked for, and an edit drops it", async () => {
  const device = fresh();
  await device.write("alice", [owned(1)]);
  await device.writeCards("alice", [{ id: id(1), at: "2026-01-01T00:00:00.000Z", card: CARD }]);
  assert.deepEqual((await device.read("alice")).cards, [], "another content time isn't kept");
  await device.writeCards("alice", [{ id: id(1), at: owned(1).content_updated_at, card: CARD }]);
  assert.equal((await device.read("alice")).cards.length, 1);
  // The next listing names a new content time: the old card goes.
  await device.write("alice", [owned(1, { content_updated_at: "2026-11-11T00:00:00.000Z" })]);
  assert.deepEqual((await device.read("alice")).cards, []);
  // A null card (none now) drops what was kept.
  await device.writeCards("alice", [{ id: id(1), at: "2026-11-11T00:00:00.000Z", card: CARD }]);
  await device.writeCards("alice", [{ id: id(1), at: "2026-11-11T00:00:00.000Z", card: null }]);
  assert.deepEqual((await device.read("alice")).cards, []);
  // Cards never create a record.
  await device.writeCards("bob", [{ id: id(1), at: null, card: CARD }]);
  assert.equal(await device.read("bob"), null);
});

test("a record in another version or for another account reads as nothing", () => {
  const record = {
    v: LIBRARY_DEVICE_VERSION,
    principal: "alice",
    saved_at: Date.now(),
    rows: [owned(1)],
    cards: {},
  };
  assert.equal(readRecord(record, "alice").rows.length, 1);
  assert.equal(readRecord({ ...record, v: LIBRARY_DEVICE_VERSION + 1 }, "alice"), null);
  assert.equal(readRecord(record, "bob"), null);
  assert.equal(readRecord({ ...record, rows: "no" }, "alice"), null);
  assert.equal(readRecord(null, "alice"), null);
});

test("a record paints for 14 days after the server last listed its rows, then goes", async () => {
  let now = Date.UTC(2026, 10, 1);
  const store = new LocalStore({ database: `library-device-test-${++databases}` });
  const device = new LibraryDeviceCache({ store, now: () => now });
  await device.write("alice", [owned(1)]);
  const saved = now;
  now += DEVICE_RECORD_MAX_AGE_MS;
  assert.equal((await device.read("alice")).rows.length, 1, "a record at the limit reads");
  // Cards, Trash and renames don't extend its life.
  await device.writeCards("alice", [{ id: id(1), at: owned(1).content_updated_at, card: CARD }]);
  await device.retitle(id(1), "Renamed");
  await device.forget(id(9));
  const stored = JSON.parse(new TextDecoder().decode(await store.load(deviceKey("alice"))));
  assert.equal(stored.saved_at, saved, "writeCards and patches leave saved_at");
  assert.equal(stored.rows[0].title, "Renamed");
  now += 1;
  assert.equal(await device.read("alice"), null, "14 days and 1 ms reads nothing");
  await settle();
  assert.deepEqual(await device.keys(), [], "and the read removed it");
  // A fresh first page starts a new life.
  await device.write("alice", [owned(1)]);
  assert.equal((await device.read("alice")).rows.length, 1);
});

test("a record whose saved_at is missing, malformed or in the future reads nothing", async () => {
  const now = Date.UTC(2026, 10, 1);
  const base = { v: LIBRARY_DEVICE_VERSION, principal: "alice", rows: [owned(1)], cards: {} };
  assert.equal(readRecord({ ...base, saved_at: now }, "alice", now).rows.length, 1);
  for (const saved_at of [undefined, null, "2026-11-01", Number.NaN, Infinity])
    assert.equal(readRecord({ ...base, saved_at }, "alice", now), null, String(saved_at));
  assert.equal(
    readRecord({ ...base, saved_at: now + DEVICE_CLOCK_SKEW_MS }, "alice", now).rows.length,
    1,
    "a small skew is tolerated",
  );
  assert.equal(
    readRecord({ ...base, saved_at: now + DEVICE_CLOCK_SKEW_MS + 1 }, "alice", now),
    null,
  );
  // Stored that way, the read removes it.
  const store = new LocalStore({ database: `library-device-test-${++databases}` });
  const device = new LibraryDeviceCache({ store, now: () => now });
  await store.save(
    deviceKey("alice"),
    new TextEncoder().encode(JSON.stringify({ ...base, saved_at: now + 60 * 60_000 })),
  );
  assert.equal(await device.read("alice"), null);
  await settle();
  assert.deepEqual(await device.keys(), []);
  // A record past its limit takes no cards.
  await store.save(
    deviceKey("bob"),
    new TextEncoder().encode(JSON.stringify({ ...base, principal: "bob" })),
  );
  assert.equal(
    await device.writeCards("bob", [{ id: id(1), at: owned(1).content_updated_at, card: CARD }]),
    false,
  );
});

test("Trash, a rename and an empty page patch every account's record", async () => {
  const device = fresh();
  await device.write("alice", [owned(1), owned(2)]);
  await device.write("bob", [owned(2), sharedRow(3)]);
  await device.forget(id(2));
  assert.deepEqual(
    (await device.read("alice")).rows.map((row) => row.page_id),
    [id(1)],
  );
  await device.retitle(id(1), "Renamed");
  assert.equal((await device.read("alice")).rows[0].title, "Renamed");
  await device.retitle(id(3), "Revealed");
  assert.equal(JSON.stringify(await device.read("bob")).includes("Revealed"), false);
  await device.write("alice", []);
  assert.equal(await device.read("alice"), null, "an empty first page removes the record");
});

test("clear removes every account's record, and nothing else in the database", async () => {
  const store = new LocalStore({ database: `library-device-test-${++databases}` });
  const device = new LibraryDeviceCache({ store });
  await device.write("alice", [owned(1)]);
  await device.write("bob", [owned(2)]);
  await store.save("library/v0/old", new Uint8Array([1]));
  await store.save("account/other", new Uint8Array([2]));
  assert.equal(await device.clear(), true);
  assert.deepEqual(await device.keys(), []);
  assert.deepEqual(await store.list(""), ["account/other"]);
});

test("a failing or stalled database resolves: reads find nothing, clear gives up", async () => {
  const broken = {
    load: () => Promise.reject(Error("IndexedDB is gone")),
    run: () => Promise.reject(Error("IndexedDB is gone")),
    remove: () => Promise.reject(Error("IndexedDB is gone")),
    list: () => Promise.reject(Error("IndexedDB is gone")),
  };
  const device = new LibraryDeviceCache({ store: broken });
  assert.equal(await device.read("alice"), null);
  assert.equal(await device.write("alice", [owned(1)]), false);
  assert.equal(await device.clear(), false);
  const stalled = { ...broken, run: () => new Promise(() => {}) };
  const slow = new LibraryDeviceCache({ store: stalled, clearDeadlineMs: 5 });
  assert.equal(await slow.clear(), false, "a sign-out doesn't wait on a stalled database");
});

test("the listing cache writes only the default view to the device, under its rules", async () => {
  const device = fresh();
  const cache = new ListingCache({ device });
  const params = { query: "", access: null, sort: "activity", projectId: null };
  assert.equal(deviceView(params), true);
  for (const other of [
    { ...params, query: "plan" },
    { ...params, access: "shared" },
    { ...params, access: "owned" },
    { ...params, sort: "title" },
  ])
    assert.equal(deviceView(other), false);
  const scope = cache.scope("alice");
  scope.write({ ...params, query: "plan" }, [owned(9)], "alice", scope.revision());
  scope.write(params, [owned(1)], "alice", scope.revision() - 1);
  await settle();
  assert.equal(await device.read("alice"), null, "a search or a stale reply writes nothing");
  scope.write(params, [owned(1)], "alice", scope.revision());
  await settle();
  assert.equal((await device.read("alice")).rows.length, 1);
  scope.write(params, [owned(2)], "bob", scope.revision());
  await settle();
  assert.equal(await device.read("alice"), null, "an answer for someone else forgets the view");
  scope.write(params, [owned(1)], "alice", scope.revision());
  await settle();
  cache.clear();
  assert.equal((await device.read("alice")).rows.length, 1, "clear keeps the device record");
  assert.equal(await cache.clearDevice(), true);
  assert.equal(await device.read("alice"), null);
});

// The Listing over a device scope with a controllable read.
function deviceHarness({ memory = null } = {}) {
  const requests = [];
  const reports = [];
  const reads = [];
  const recalled = [];
  let n = 0;
  const scope = {
    read: (params) => (memory && deviceView(params) ? memory : null),
    revision: () => 0,
    write: () => {},
    deviceView,
    device: {
      read: () => {
        const reply = deferred();
        reads.push(reply);
        return reply.promise;
      },
      cards: () => {},
    },
  };
  const listing = new Listing(
    {
      fetch: (request) => {
        const reply = deferred();
        requests.push({ ...request, ...reply });
        return reply.promise;
      },
      report: (message) => reports.push(message),
      idOf: (item) => item.page_id,
      cache: scope,
      onRecalled: (record) => recalled.push(record),
    },
    { newKey: () => `k${++n}`, scheduler: new VirtualTimeScheduler() },
  );
  const disconnect = listing.connect();
  return {
    listing,
    requests,
    reads,
    reports,
    recalled,
    disconnect,
    view: () => listingView(listing.snapshot()),
    ids: () => listing.snapshot().items.map((item) => item.page_id),
  };
}
const record = (rows, cards = []) => ({ rows: storedRows(rows), cards });

test("device rows paint before the server answers, and its answer replaces them in place", async () => {
  const { listing, requests, reads, recalled, view, ids } = deviceHarness();
  listing.load();
  await settle();
  assert.equal(requests.length, 1, "the request goes out first");
  assert.equal(reads.length, 1);
  assert.equal(view().loading, true);
  reads[0].resolve(
    record([owned(1), owned(2), sharedRow(3)], [{ id: id(1), at: null, card: CARD }]),
  );
  await settle();
  assert.equal(listing.snapshot().state.name, "revalidating");
  assert.deepEqual(ids(), [id(1), id(2), id(3)]);
  assert.equal(view().loading, false, "no Loading… over device rows");
  assert.equal(view().refreshing, true);
  assert.equal(recalled.length, 1);
  requests[0].resolve({ items: [owned(1, { title: "New title" }), owned(2)], cursor: null });
  await settle();
  assert.equal(listing.snapshot().state.name, "ready");
  assert.deepEqual(ids(), [id(1), id(2)], "a row no longer listed disappears");
  assert.equal(listing.snapshot().items[0].title, "New title", "a stale row updates in place");
});

test("a device read landing after the server's answer changes nothing", async () => {
  const { listing, requests, reads, recalled, ids } = deviceHarness();
  listing.load();
  await settle();
  requests[0].resolve({ items: [owned(5)], cursor: null });
  await settle();
  reads[0].resolve(record([owned(1)]));
  await settle();
  assert.deepEqual(ids(), [id(5)]);
  assert.equal(recalled.length, 0);
});

test("a failed or empty device read behaves as a library without one", async () => {
  for (const outcome of ["reject", "null", "empty"]) {
    const { listing, requests, reads, view, ids } = deviceHarness();
    listing.load();
    await settle();
    if (outcome === "reject") reads[0].reject(Error("IndexedDB is gone"));
    else reads[0].resolve(outcome === "null" ? null : record([]));
    await settle();
    assert.equal(listing.snapshot().state.name, "loading", outcome);
    assert.equal(view().loading, true);
    requests[0].resolve({ items: [owned(1)], cursor: null });
    await settle();
    assert.deepEqual(ids(), [id(1)]);
  }
});

test("a failed first page over device rows keeps the account's own and drops held slots", async () => {
  const { listing, requests, reads, reports, view } = deviceHarness();
  listing.load();
  await settle();
  reads[0].resolve(record([owned(1), sharedRow(2)]));
  await settle();
  requests[0].reject(Object.assign(Error("Offline"), { code: null }));
  await settle();
  assert.equal(listing.snapshot().state.name, "kept");
  assert.equal(view().failed, true);
  assert.equal(view().kept, true);
  assert.equal(reports.length, 1);
  // Library.jsx shows the store's rows without held slots.
  const shown = listing.snapshot().items.filter((page) => !page.held);
  assert.deepEqual(
    shown.map((page) => page.page_id),
    [id(1)],
  );
  assert.equal(listing.more(), false);
});

test("only the default view reads the device; a view in memory paints from memory", async () => {
  const other = deviceHarness();
  other.listing.load({ query: "plan" });
  other.listing.load({ access: "shared" });
  assert.equal(other.reads.length, 0);
  const remembered = deviceHarness({ memory: [owned(7)] });
  remembered.listing.load();
  await settle();
  assert.equal(remembered.reads.length, 0, "memory wins: no device read");
  assert.deepEqual(remembered.ids(), [id(7)]);
});

test("a device read after a disconnect never reaches the store", async () => {
  const { listing, reads, disconnect, ids } = deviceHarness();
  listing.load();
  await settle();
  disconnect();
  reads[0].resolve(record([owned(1)]));
  await settle();
  assert.deepEqual(ids(), []);
});

test("the ordering rule: a pending copy the server order holds shows once, in place", () => {
  const view = { query: "", access: null, sort: "activity", projectId: null };
  // The device rows paint first, in the server's last order.
  const items = storedRows([owned(1), owned(2), owned(3)]);
  const drafts = [
    { page_id: id(3), title: "Page 3", updated_at: "2026-11-12T00:00:00.000Z", pending: true },
    { page_id: id(9), title: "New", updated_at: "2026-11-12T00:00:00.000Z", pending: true },
  ];
  const order = (rows) => [
    ...deviceRows(drafts, rows, view).map((page) => pageRow(page, new Map(), { local: true }).id),
    ...rows.map((page) => pageRow(page).id),
  ];
  const first = order(items);
  assert.deepEqual(first, [id(9), id(1), id(2), id(3)]);
  // The server answers with the same order: nothing moves.
  const live = [owned(1), owned(2), owned(3)];
  assert.deepEqual(order(live), first);
});

test("kept cards draw at once and are asked for again; answers are kept for next time", async () => {
  const scheduler = new VirtualTimeScheduler();
  const calls = [];
  const kept = [];
  const cards = new PageCards({
    tool: async (operation, args) => {
      calls.push(args.page_ids);
      return {
        principal: "alice",
        cards: Object.fromEntries(args.page_ids.map((page) => [page, CARD])),
      };
    },
    principal: "alice",
    observer: null,
    scheduler,
    onCards: (entries) => kept.push(...entries),
  });
  const stop = cards.connect();
  const rows = [1, 2, 3].map((n) => ({ id: id(n), contentUpdatedAt: `t${n}` }));
  cards.recall([{ id: id(1), at: "t1", card: CARD }]);
  assert.equal(cards.state(cardKeyOf(rows[0])).name, "stale");
  cards.arrange(rows);
  cards.visible(rows[0]);
  assert.equal(cards.state(cardKeyOf(rows[0])).name, "revalidating", "it stays drawn");
  // The first batch goes out without the gather window.
  scheduler.flush();
  assert.equal(scheduler.now(), 0);
  await settle();
  assert.deepEqual(calls, [[id(1), id(2), id(3)]], "topped up with the next cards");
  assert.equal(cards.state(cardKeyOf(rows[0])).name, "shown");
  assert.deepEqual(
    kept.map((entry) => [entry.id, entry.at]),
    [
      [id(1), "t1"],
      [id(2), "t2"],
      [id(3), "t3"],
    ],
  );
  // A later card waits the gather window.
  const later = { id: id(4), contentUpdatedAt: null };
  cards.visible(later);
  scheduler.flush();
  assert.equal(scheduler.now(), PAGE_CARDS_GATHER_MS);
  await settle();
  assert.equal(calls.length, 2);
  stop();
});

test("a grid that doesn't know its account draws no kept card", () => {
  const cards = new PageCards({ tool: async () => ({}), principal: null, observer: null });
  cards.recall([{ id: id(1), at: null, card: CARD }]);
  assert.equal(cards.state(cardKeyOf({ id: id(1), contentUpdatedAt: null })).name, "idle");
});
