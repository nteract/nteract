import test from "node:test";
import assert from "node:assert/strict";
import { openPageWithRetry } from "./page-open.mjs";

function clock() {
  const timers = new Map(),
    scheduledDelays = [];
  let id = 0;
  return {
    timers,
    scheduledDelays,
    setTimeout(fn, delay) {
      scheduledDelays.push(delay);
      timers.set(++id, fn);
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    async tick() {
      const [id, fn] = [...timers][0];
      timers.delete(id);
      fn();
      await settle();
    },
  };
}

async function settle() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("cold opening retries after a temporary outage without an identity change or reload", async () => {
  const time = clock(),
    controller = new AbortController(),
    identity = { principal: "one" },
    session = { identity };
  let attempts = 0;
  const result = openPageWithRetry(
    async () => {
      attempts++;
      if (attempts < 3) throw Object.assign(Error("Temporarily unavailable"), { status: 503 });
      return session;
    },
    { signal: controller.signal, ...time },
  );
  await settle();
  assert.equal(attempts, 1);
  await time.tick();
  assert.equal(attempts, 2);
  await time.tick();
  assert.equal(await result, session);
  assert.deepEqual(time.scheduledDelays, [1000, 2000]);
  assert.equal(time.timers.size, 0);
});

test("only transient network, timeout, proxy, and server failures retry", async (t) => {
  for (const code of ["NETWORK_ERROR", "REQUEST_TIMEOUT", "INVALID_RESPONSE"]) {
    await t.test(code, async () => {
      const time = clock(),
        controller = new AbortController();
      let attempts = 0;
      const result = openPageWithRetry(
        async () => {
          if (++attempts === 1) throw Object.assign(Error("Connection interrupted"), { code });
          return "opened";
        },
        { signal: controller.signal, ...time },
      );
      await settle();
      await time.tick();
      assert.equal(await result, "opened");
      assert.equal(attempts, 2);
    });
  }
  for (const status of [400, 401, 403, 404, 409, 429, undefined]) {
    await t.test(String(status ?? "document invariant"), async () => {
      const time = clock(),
        controller = new AbortController(),
        error = Object.assign(Error("Do not retry"), { status });
      let attempts = 0;
      await assert.rejects(
        openPageWithRetry(
          async () => {
            attempts++;
            throw error;
          },
          { signal: controller.signal, ...time },
        ),
        (actual) => actual === error,
      );
      assert.equal(attempts, 1);
      assert.equal(time.timers.size, 0);
    });
  }
});

test("a sustained outage exhausts the bounded retry budget", async () => {
  const time = clock(),
    controller = new AbortController(),
    error = Object.assign(Error("Unavailable"), { status: 503 });
  let attempts = 0;
  const result = openPageWithRetry(
    async () => {
      attempts++;
      throw error;
    },
    { signal: controller.signal, ...time },
  );
  const rejected = assert.rejects(result, (actual) => actual === error);
  await settle();
  for (let i = 0; i < 5; i++) await time.tick();
  await rejected;
  assert.equal(attempts, 6);
  assert.deepEqual(time.scheduledDelays, [1000, 2000, 4000, 8000, 10000]);
  assert.equal(time.timers.size, 0);
});

test("an application rejection takes precedence over any transient-looking code", async () => {
  const time = clock(),
    controller = new AbortController(),
    error = Object.assign(Error("Sign in"), { status: 401, code: "REQUEST_TIMEOUT" });
  await assert.rejects(
    openPageWithRetry(
      async () => {
        throw error;
      },
      { signal: controller.signal, ...time },
    ),
    (actual) => actual === error,
  );
  assert.equal(time.timers.size, 0);
});

test("navigation, account change, or unmount cancels a scheduled retry", async () => {
  const time = clock(),
    controller = new AbortController();
  let attempts = 0;
  const result = openPageWithRetry(
    async () => {
      attempts++;
      throw Object.assign(Error("Network unavailable"), { code: "NETWORK_ERROR" });
    },
    { signal: controller.signal, ...time },
  );
  await settle();
  assert.equal(time.timers.size, 1);
  controller.abort();
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(time.timers.size, 0);
  assert.equal(attempts, 1);
});

test("a late open from the previous route or account closes instead of being installed", async () => {
  const controller = new AbortController();
  let resolve,
    closed = 0;
  const result = openPageWithRetry(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    { signal: controller.signal },
  );
  controller.abort();
  resolve({
    close: async () => {
      closed++;
    },
  });
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(closed, 1);
});

test("a late failed open cannot schedule another attempt after cancellation", async () => {
  const time = clock(),
    controller = new AbortController();
  let reject;
  const result = openPageWithRetry(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    { signal: controller.signal, ...time },
  );
  controller.abort();
  reject(Object.assign(Error("Unavailable"), { status: 503 }));
  await assert.rejects(result, { name: "AbortError" });
  assert.equal(time.timers.size, 0);
});

test("an already canceled open never calls the session factory", async () => {
  const controller = new AbortController();
  controller.abort();
  let attempts = 0;
  await assert.rejects(
    openPageWithRetry(
      async () => {
        attempts++;
      },
      { signal: controller.signal },
    ),
    { name: "AbortError" },
  );
  assert.equal(attempts, 0);
});

test("slow native cleanup must finish before retry backoff can start another replica", async () => {
  const time = clock(),
    controller = new AbortController(),
    cleanup = deferred();
  let attempts = 0,
    released = false;
  const result = openPageWithRetry(
    async () => {
      if (++attempts === 1)
        throw Object.assign(Error("Server unavailable"), {
          status: 503,
          cleanupPromise: cleanup.promise,
        });
      assert.equal(released, true, "the old native identity must be released before reopening");
      return "opened";
    },
    { signal: controller.signal, ...time, delays: [1], cleanupTimeoutMs: 100 },
  );
  await settle();
  assert.equal(attempts, 1);
  assert.deepEqual(time.scheduledDelays, [100], "a 1ms backoff must not bypass the pending drain");
  released = true;
  cleanup.resolve();
  await settle();
  assert.equal(attempts, 1);
  assert.deepEqual(time.scheduledDelays, [100, 1]);
  await time.tick();
  assert.equal(await result, "opened");
  assert.equal(attempts, 2);
  assert.equal(time.timers.size, 0);
});

test("unresolved cleanup has a bounded error and a late release cannot restart opening", async () => {
  const time = clock(),
    controller = new AbortController(),
    cleanup = deferred();
  let attempts = 0;
  const result = openPageWithRetry(
    async () => {
      attempts++;
      throw Object.assign(Error("Server unavailable"), {
        status: 503,
        cleanupPromise: cleanup.promise,
      });
    },
    { signal: controller.signal, ...time, cleanupTimeoutMs: 10 },
  );
  const rejected = assert.rejects(result, (error) => {
    assert.equal(error.code, "PAGE_CLEANUP_PENDING");
    assert.equal(error.status, undefined, "a cleanup failure must not inherit a retryable status");
    assert.match(error.message, /still closing/);
    return true;
  });
  await settle();
  await time.tick();
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(time.timers.size, 0);
  cleanup.resolve();
  await settle();
  assert.equal(attempts, 1);
});

test("cleanup rejection stops retry without reusing the old transport error", async () => {
  const time = clock(),
    controller = new AbortController(),
    cleanup = deferred();
  const failure = Error("Native close failed");
  let attempts = 0;
  const result = openPageWithRetry(
    async () => {
      attempts++;
      throw Object.assign(Error("Server unavailable"), {
        status: 503,
        cleanupPromise: cleanup.promise,
      });
    },
    { signal: controller.signal, ...time },
  );
  const rejected = assert.rejects(result, (error) => {
    assert.equal(error.code, "PAGE_CLEANUP_FAILED");
    assert.equal(error.status, undefined);
    assert.equal(error.cause, failure);
    return true;
  });
  await settle();
  cleanup.reject(failure);
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(time.timers.size, 0);
});

test("navigation cancels the cleanup wait but lets native cleanup retain ownership", async (t) => {
  const time = clock(),
    controller = new AbortController(),
    cleanup = deferred();
  const listeners = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  t.mock.method(controller.signal, "addEventListener", (type, listener, options) => {
    if (type === "abort") listeners.add(listener);
    add(type, listener, options);
  });
  t.mock.method(controller.signal, "removeEventListener", (type, listener, options) => {
    if (type === "abort") listeners.delete(listener);
    remove(type, listener, options);
  });
  let attempts = 0;
  const result = openPageWithRetry(
    async () => {
      attempts++;
      throw Object.assign(Error("Server unavailable"), {
        status: 503,
        cleanupPromise: cleanup.promise,
      });
    },
    { signal: controller.signal, ...time },
  );
  const reason = Error("Navigated away");
  const rejected = assert.rejects(result, (error) => error === reason);
  await settle();
  controller.abort(reason);
  await rejected;
  assert.equal(attempts, 1);
  assert.equal(time.timers.size, 0);
  assert.equal(listeners.size, 0);
  cleanup.reject(Error("Close failed after navigation"));
  await settle();
  assert.equal(attempts, 1);
});

test("an already completed cleanup allows retry and removes its deadline", async () => {
  const time = clock(),
    controller = new AbortController();
  let attempts = 0;
  const result = openPageWithRetry(
    async () => {
      if (++attempts === 1)
        throw Object.assign(Error("Server unavailable"), {
          status: 503,
          cleanupPromise: Promise.resolve(),
        });
      return "opened";
    },
    { signal: controller.signal, ...time, delays: [1], cleanupTimeoutMs: 100 },
  );
  await settle();
  assert.deepEqual(time.scheduledDelays, [100, 1]);
  assert.equal(time.timers.size, 1, "only the backoff timer remains");
  await time.tick();
  assert.equal(await result, "opened");
  assert.equal(attempts, 2);
  assert.equal(time.timers.size, 0);
});
