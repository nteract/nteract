import test from "node:test";
import assert from "node:assert/strict";
import { maintainBrowserSession } from "./browser-session.mjs";

const identity = { principal: "one", displayName: "Kyle" };
function fixture(request) {
  const timers = new Map(),
    listeners = new Set(),
    sessions = [],
    errors = [];
  let id = 0;
  const document = {
    visibilityState: "hidden",
    addEventListener(_event, fn) {
      listeners.add(fn);
    },
    removeEventListener(_event, fn) {
      listeners.delete(fn);
    },
  };
  const maintenance = maintainBrowserSession({
    request,
    onSession: (value) => sessions.push(value),
    onError: (error) => errors.push(error),
    document,
    setTimeout: (fn, delay) => {
      timers.set(++id, { fn, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  return {
    maintenance,
    timers,
    listeners,
    sessions,
    errors,
    resume() {
      document.visibilityState = "visible";
      for (const fn of listeners) fn();
    },
    async tick() {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      assert.equal(timer.delay, 60_000);
      await timer.fn();
    },
  };
}

test("session maintenance deduplicates renewal and schedules one minute from completion", async (t) => {
  let resolve,
    calls = 0;
  let response = new Promise((done) => {
    resolve = done;
  });
  const f = fixture(async () => {
    calls++;
    return response;
  });
  t.after(() => f.maintenance.stop());
  const first = f.maintenance.refresh();
  assert.equal(f.maintenance.refresh(), first);
  f.resume();
  assert.equal(calls, 1);
  assert.equal(f.timers.size, 0);
  response = { identity, canWrite: true };
  resolve(response);
  await first;
  assert.equal(f.sessions.length, 1);
  assert.equal(f.timers.size, 1);
  await f.tick();
  assert.equal(calls, 2);
  assert.equal(f.timers.size, 1);
  f.maintenance.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  f.resume();
  await f.maintenance.refresh();
  assert.equal(calls, 2);
});

test("cleanup ignores an in-flight renewal result and does not restart maintenance", async () => {
  let resolve;
  const f = fixture(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = f.maintenance.refresh();
  f.maintenance.stop();
  resolve({ identity, canWrite: true });
  await pending;
  assert.equal(f.sessions.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
});

test("missing sessions and auth rejection stop polling until an explicit or visibility retry", async (t) => {
  for (const status of [0, 401, 403]) {
    await t.test(String(status || "no identity"), async (t) => {
      let authorized = false,
        calls = 0;
      const f = fixture(async () => {
        calls++;
        if (authorized) return { identity, canWrite: true };
        if (status) throw Object.assign(Error("Sign in"), { status });
        return { identity: null, canWrite: false };
      });
      t.after(() => f.maintenance.stop());
      if (status) await assert.rejects(f.maintenance.refresh(), { status });
      else await f.maintenance.refresh();
      assert.equal(f.timers.size, 0);
      assert.equal(f.sessions[0].identity, null);
      assert.equal(calls, 1);
      authorized = true;
      f.resume();
      await f.maintenance.refresh();
      assert.equal(calls, 2);
      assert.equal(f.sessions.at(-1).identity, identity);
      assert.equal(f.timers.size, 1);
    });
  }
});

test("transient renewal failures retry on the next minute without clearing identity", async (t) => {
  let fail = false,
    calls = 0;
  const f = fixture(async () => {
    calls++;
    if (fail) throw Object.assign(Error("Temporarily unavailable"), { status: 503 });
    return { identity, canWrite: true };
  });
  t.after(() => f.maintenance.stop());
  await f.maintenance.refresh();
  fail = true;
  await f.tick();
  assert.equal(calls, 2);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.errors.length, 1);
  assert.equal(f.timers.size, 1);
});
