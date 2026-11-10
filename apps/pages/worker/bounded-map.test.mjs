import assert from "node:assert/strict";
import { test } from "node:test";
import { boundedMap } from "./bounded-map.mjs";
import { catalogSource } from "./catalog-index.mjs";
import { Catalog, sharedCheckBounds } from "./index.mjs";
import { Storage } from "./trash-fixture.mjs";

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

test("a bounded map keeps item order and never runs more than its limit", async () => {
  let running = 0;
  let most = 0;
  const items = Array.from({ length: 40 }, (_, index) => index);
  const results = await boundedMap(items, 6, async (item) => {
    running++;
    most = Math.max(most, running);
    await tick(item % 5);
    running--;
    return item * 2;
  });
  assert.deepEqual(
    results,
    items.map((item) => item * 2),
  );
  assert.equal(most, 6);
  assert.deepEqual(await boundedMap([], 4, async () => 1), []);
  assert.deepEqual(await boundedMap([1, 2], 16, async (item) => item), [1, 2]);
  await assert.rejects(
    boundedMap([1], 0, async () => 1),
    RangeError,
  );
});

test("a failure starts nothing new and rethrows only after the running tasks settle", async () => {
  const started = [];
  const settled = [];
  const failure = boundedMap(
    Array.from({ length: 20 }, (_, index) => index),
    4,
    async (item) => {
      started.push(item);
      await tick(item === 2 ? 1 : 10);
      settled.push(item);
      if (item === 2) throw Error("unavailable");
      return item;
    },
  );
  await assert.rejects(failure, /unavailable/);
  // Items 0–3 were running when 2 failed; nothing started after it.
  assert.deepEqual(started, [0, 1, 2, 3]);
  assert.deepEqual([...settled].sort(), [0, 1, 2, 3]);
});

/** A Catalog with `count` shared entries and a stubbed Page host check. */
async function sharedCatalog(count, verify) {
  const storage = new Storage();
  for (let n = 0; n < count; n++) {
    const pageId = `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`;
    await storage.put(`shared/${pageId}`, {
      page_id: pageId,
      title: `Shared ${n}`,
      created_at: "2026-10-01T00:00:00.000Z",
      updated_at: new Date(Date.UTC(2026, 9, 1, 0, 0, count - n)).toISOString(),
      shared: true,
    });
  }
  const catalog = new Catalog({ id: { name: "user:anaconda:reader" }, storage }, {});
  catalog.verifyShared = verify;
  const options = {
    limit: 50,
    sort: "activity",
    inTrash: false,
    spaceId: null,
    parentId: undefined,
  };
  const scope = { locations: new Map(), located: () => true, exhaustive: false };
  const source = await catalogSource(storage, { sort: "activity" });
  return {
    storage,
    scan: () =>
      catalog.scanCandidates(
        new Request("https://pages.invalid/internal/catalog"),
        { principal: "user:anaconda:reader" },
        source,
        options,
        scope,
        null,
        null,
      ),
  };
}

test("a listing checks shared Pages through a pool of sharedCheckBounds.concurrency", async () => {
  assert.equal(sharedCheckBounds.concurrency, 16);
  let running = 0;
  let most = 0;
  const order = [];
  const { scan } = await sharedCatalog(60, async (request, pageId) => {
    running++;
    most = Math.max(most, running);
    order.push(pageId);
    // Uneven hosts: a slow one holds one slot, not a wave.
    await tick(pageId.endsWith("3") ? 15 : 2);
    running--;
    return {
      status: "ok",
      page: { title: `Checked ${pageId.slice(-2)}`, state: "active", content_updated_at: null },
    };
  });
  const result = await scan();
  assert.equal(most, sharedCheckBounds.concurrency);
  assert.equal(result.pages.length, 50);
  // Rows come back in the source's order whatever order checks finish in.
  const expected = Array.from(
    { length: 50 },
    (_, n) => `44444444-4444-4444-8444-${String(n).padStart(12, "0")}`,
  );
  assert.deepEqual(
    result.pages.map((page) => page.page_id),
    expected,
  );
  assert.ok(result.next, "a 51st verified row continues the listing");
  assert.equal(order.length, 51, "the scan checks one row past the page, no more");
});

test("an unavailable host fails the listing after the checks already running settle", async () => {
  let running = 0;
  let afterFailure = 0;
  let failed = false;
  const { scan, storage } = await sharedCatalog(40, async (request, pageId) => {
    if (failed) afterFailure++;
    running++;
    await tick(pageId.endsWith("05") ? 1 : 8);
    running--;
    if (pageId.endsWith("05")) {
      failed = true;
      return { status: "unavailable" };
    }
    return { status: "denied" };
  });
  await assert.rejects(scan(), (error) => error.status === 503);
  assert.equal(running, 0, "no check outlives the listing");
  assert.equal(afterFailure, 0, "no check starts after the failure");
  // Denied rows checked before the failure were pruned from this Catalog.
  assert.ok((await storage.list({ prefix: "shared/" })).size < 40);
});
