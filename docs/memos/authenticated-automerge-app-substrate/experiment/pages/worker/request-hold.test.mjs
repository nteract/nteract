import assert from "node:assert/strict";
import { test } from "node:test";
import { Catalog, Page, PageRecords } from "./index.mjs";
import { holdUntilSettled } from "./request-hold.mjs";
import { serialQueue } from "./serial-queue.mjs";

const turns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};
/** "settled" once `promise` settles, or "pending" after a few turns. */
const state = (promise) =>
  Promise.race([promise.then(() => "settled"), turns().then(() => "pending")]);
/** A deferred promise: settle it with `resolve` or `reject`. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
/** Object state that records every waitUntil promise. */
const holding = () => {
  const held = [];
  return { held, ctx: { waitUntil: (promise) => held.push(promise) } };
};
/** Fail the test on an unhandled rejection raised while `body` runs. */
async function noUnhandledRejection(t, body) {
  const unhandled = [];
  const record = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", record);
  t.after(() => process.off("unhandledRejection", record));
  await body();
  await turns();
  assert.deepEqual(unhandled, []);
}

test("a hold never rejects and leaves the caller's rejection to the caller", async (t) => {
  await noUnhandledRejection(t, async () => {
    const { held, ctx } = holding();
    const work = Promise.reject(Error("boom"));
    holdUntilSettled(ctx, work);
    await assert.rejects(work, /boom/);
    assert.equal(await state(held[0]), "settled");
    // Partial objects without a ctx hold nothing.
    holdUntilSettled(undefined, Promise.resolve());
  });
});

test("each queued request holds its object request until its work settles", async () => {
  const { held, ctx } = holding();
  const queue = serialQueue(ctx, "q");
  const first = deferred();
  const running = queue(() => first.promise);
  const failing = queue(async () => {
    throw Error("boom");
  });
  // Registered when queued, while the caller's request is still live.
  assert.equal(held.length, 2);
  assert.deepEqual(await Promise.all(held.map(state)), ["pending", "pending"]);
  first.resolve("first");
  assert.equal(await running, "first");
  await assert.rejects(failing, /boom/);
  assert.deepEqual(await Promise.all(held.map(state)), ["settled", "settled"]);
});

/** A partial Page whose `run` answers when the test says so. */
function page() {
  const { held, ctx } = holding();
  const runs = [];
  const value = Object.assign(Object.create(Page.prototype), {
    ctx,
    tail: Promise.resolve(),
    run: () => {
      const run = deferred();
      runs.push(run);
      return run.promise;
    },
  });
  return { page: value, held, runs };
}

test("a Page holds each queued HTTP request until it settles", async () => {
  const { page: host, held, runs } = page();
  const response = host.fetch(new Request("https://pages.test/internal/tool", { method: "POST" }));
  assert.equal(held.length, 1);
  await turns();
  assert.equal(await state(held[0]), "pending");
  runs[0].resolve("answered");
  assert.equal(await response, "answered");
  assert.equal(await state(held[0]), "settled");
});

for (const [path, method] of [
  ["/api/saved", "POST"],
  ["/api/sync", "GET"],
]) {
  test(`a Page holds ${path}, which bypasses its queue, until it settles`, async (t) => {
    await noUnhandledRejection(t, async () => {
      const { page: host, held, runs } = page();
      const response = host.fetch(new Request(`https://pages.test${path}`, { method }));
      assert.equal(runs.length, 1, "runs at once, outside the queue");
      assert.equal(held.length, 1, "held in the same step");
      assert.equal(await state(held[0]), "pending");
      runs[0].reject(Error("disconnected"));
      await assert.rejects(response, /disconnected/);
      assert.equal(await state(held[0]), "settled");
    });
  });
}

test("PageRecords holds each queued write until it settles", async () => {
  const { held, ctx } = holding();
  const records = new PageRecords({ ...ctx, storage: {} });
  const write = deferred();
  records.run = () => write.promise;
  const response = records.fetch(new Request("https://records.test/records", { method: "POST" }));
  assert.equal(held.length, 1);
  await turns();
  assert.equal(await state(held[0]), "pending");
  write.resolve(new Response(null, { status: 204 }));
  assert.equal((await response).status, 204);
  assert.equal(await state(held[0]), "settled");
});

test("a Catalog holds a shared lifecycle read after its caller stops waiting", async () => {
  const { held, ctx } = holding();
  const read = deferred();
  const catalog = Object.assign(Object.create(Catalog.prototype), {
    ctx,
    readLifecycle: () => read.promise,
  });
  await assert.rejects(catalog.pageLifecycle("page-a", 1), /timed out/);
  assert.equal(held.length, 1);
  assert.equal(await state(held[0]), "pending", "the read outlives the caller");
  read.resolve({ state: "active" });
  assert.equal(await state(held[0]), "settled");
  assert.equal(catalog.lifecycleReads.size, 0);
});
