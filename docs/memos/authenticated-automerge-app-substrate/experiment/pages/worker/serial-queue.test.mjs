import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog } from "./index.mjs";
import { serialQueue, serialQueueBounds } from "./serial-queue.mjs";
import { Space } from "./spaces.mjs";

const turns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};
const never = () => new Promise(() => {});

/** An object state whose abort records its reason and throws, as celld does. */
function objectState(extra = {}) {
  const aborts = [];
  return {
    aborts,
    abort(reason) {
      aborts.push(reason);
      throw reason;
    },
    ...extra,
  };
}

function quietLogs(t) {
  const logged = [];
  t.mock.method(console, "error", (...args) => logged.push(args));
  return logged;
}

test("requests run one at a time in arrival order", async () => {
  const ctx = objectState();
  const queue = serialQueue(ctx, "test-queue");
  const order = [];
  let release;
  const first = queue(async () => {
    order.push("first:start");
    await new Promise((resolve) => (release = resolve));
    order.push("first:end");
    return 1;
  });
  const second = queue(async () => (order.push("second"), 2));
  await turns();
  assert.deepEqual(order, ["first:start"]);
  release();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  assert.equal(ctx.aborts.length, 0);
});

test("a failed request does not stop the next one", async () => {
  const queue = serialQueue(objectState(), "test-queue");
  await assert.rejects(
    queue(async () => {
      throw Error("boom");
    }),
    /boom/,
  );
  assert.equal(await queue(async () => "next"), "next");
});

test("a request that never settles resets the object at the bound", async (t) => {
  const logged = quietLogs(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = objectState();
  const queue = serialQueue(ctx, "test-queue");
  queue(never);
  await turns();
  t.mock.timers.tick(serialQueueBounds.runMs - 1);
  assert.equal(ctx.aborts.length, 0);
  t.mock.timers.tick(1);
  assert.equal(ctx.aborts.length, 1);
  assert.match(ctx.aborts[0].message, /Try again/);
  const [, entry] = logged.at(-1);
  assert.equal(entry.stage, "test-queue");
  assert.equal(entry.status, 503);
  assert.equal(entry.reason, "request_timeout");
});

test("an arriving request resets a stuck object even when the stuck request's timer is gone", async (t) => {
  quietLogs(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = objectState();
  const queue = serialQueue(ctx, "test-queue");
  queue(never);
  await turns();
  // Model a lost timer: move the clock without firing scheduled callbacks.
  t.mock.timers.setTime(Date.now() + serialQueueBounds.runMs);
  assert.equal(ctx.aborts.length, 0);
  assert.throws(() => queue(async () => "late"), /Try again/);
  assert.equal(ctx.aborts.length, 1);
});

test("a request that settles before the bound never resets the object", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = objectState();
  const queue = serialQueue(ctx, "test-queue");
  let release;
  const slow = queue(() => new Promise((resolve) => (release = resolve)));
  await turns();
  t.mock.timers.tick(serialQueueBounds.runMs - 1);
  release("done");
  assert.equal(await slow, "done");
  t.mock.timers.tick(serialQueueBounds.runMs * 2);
  assert.equal(await queue(async () => "next"), "next");
  assert.equal(ctx.aborts.length, 0);
});

test("the bound counts from when a request starts, not when it queues", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = objectState();
  const queue = serialQueue(ctx, "test-queue");
  let release;
  queue(() => new Promise((resolve) => (release = resolve)));
  const second = queue(() => new Promise((resolve) => setTimeout(() => resolve("second"), 10)));
  await turns();
  t.mock.timers.tick(serialQueueBounds.runMs - 10);
  release();
  await turns();
  t.mock.timers.tick(10);
  assert.equal(await second, "second");
  assert.equal(ctx.aborts.length, 0);
});

test("a Catalog stuck on a Page fetch resets, and listings queued behind it do not run", async (t) => {
  quietLogs(t);
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const values = new Map();
  const storage = {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => void values.set(key, structuredClone(value)),
    delete: async (key) => void values.delete(key),
    list: async ({ prefix = "" } = {}) =>
      new Map([...values].filter(([key]) => key.startsWith(prefix))),
    sync: async () => {},
  };
  const ctx = objectState({ id: { name: `user:anaconda-fixture:${auth.subject}` }, storage });
  let pageRequests = 0;
  const catalog = new Catalog(ctx, {
    ...auth.env,
    PAGES: { getByName: () => ({ fetch: () => (pageRequests++, never()) }) },
  });
  const token = auth.apiKey();
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: Date.now() });
  const request = (operation, args) =>
    new Request("https://pages.invalid/internal/catalog", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ operation, arguments: args }),
    });
  catalog.fetch(request("create_page", { title: "Stuck", idempotency_key: "stuck-create" }));
  for (let i = 0; i < 200 && pageRequests === 0; i++) await turns(1);
  assert.equal(pageRequests, 1, "the create reached its Page fetch");
  let listed = false;
  catalog.fetch(request("list_pages", {})).then(() => (listed = true));
  t.mock.timers.tick(serialQueueBounds.runMs);
  assert.equal(ctx.aborts.length, 1);
  await turns();
  assert.equal(listed, false, "the reset instance answers no queued request");
});

test("a Space queue resets the same way", async (t) => {
  quietLogs(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ctx = objectState();
  const space = new Space(ctx, {});
  t.mock.method(space, "run", never);
  space.fetch(new Request("https://pages.internal/internal/space/read"));
  await turns();
  t.mock.timers.tick(serialQueueBounds.runMs);
  assert.equal(ctx.aborts.length, 1);
});
