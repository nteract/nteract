import test from "node:test";
import assert from "node:assert/strict";
import { filter, firstValueFrom } from "rxjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { maintainBrowserSession } from "./browser-session.mjs";
import { sessionRefreshMachine } from "./session-refresh-machine.mjs";

const TABLE = new URL("../test/fixtures/machines/session-refresh.json", import.meta.url);
const identity = { principal: "one", displayName: "Kyle" };
const signedIn = { identity, canWrite: true };
const signedOut = { identity: null, canWrite: false };

function fixture(request, { onSession } = {}) {
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
    onSession: (value) => {
      sessions.push(value);
      onSession?.(value);
    },
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
    /** Removes the pending renewal timer and returns its callback. */
    takeTimer() {
      const [id, timer] = [...timers][0];
      timers.delete(id);
      assert.equal(timer.delay, 60_000);
      return timer.fn;
    },
    async tick() {
      await this.takeTimer()();
    },
    /** Waits until no request is in flight. */
    idle: () =>
      firstValueFrom(
        maintenance.store.state$.pipe(
          filter(({ name }) => name !== "requesting" && name !== "superseded"),
        ),
      ),
  };
}

/** A request whose answers the test hands out one at a time. */
function deferredRequests() {
  const calls = [];
  const request = () =>
    new Promise((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, request };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the session-refresh table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(sessionRefreshMachine, loadTable(TABLE)), {
    rows: 28,
    pairs: 13,
    unreachable: 2,
    cases: 11,
  });
});

test("renewals join the request in flight and schedule one minute from completion", async () => {
  const { calls, request } = deferredRequests();
  const f = fixture(request);
  const first = f.maintenance.refresh();
  assert.equal(calls.length, 1);
  assert.equal(f.timers.size, 0);
  calls[0].resolve(signedIn);
  assert.deepEqual(await first, signedIn);
  assert.equal(f.sessions.length, 1);
  assert.equal(f.timers.size, 1);

  // Two periodic renewals share one request.
  const renew = f.takeTimer();
  const ticks = [renew(), renew()];
  assert.equal(calls.length, 2);
  calls[1].resolve(signedIn);
  await Promise.all(ticks);
  assert.equal(calls.length, 2);
  assert.equal(f.sessions.length, 2);
  assert.equal(f.timers.size, 1);

  f.maintenance.stop();
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
  f.resume();
  assert.equal(await f.maintenance.refresh(), undefined);
  assert.equal(calls.length, 2);
});

for (const [name, stale] of [
  ["a signed-out answer", (call) => call.resolve(signedOut)],
  ["a 401", (call) => call.reject(Object.assign(Error("Sign in"), { status: 401 }))],
  ["a 503", (call) => call.reject(Object.assign(Error("Unavailable"), { status: 503 }))],
])
  test(`becoming visible mid-request replaces ${name} with one fresh request`, async (t) => {
    // A hidden tab's request is in flight when another tab signs in.
    const { calls, request } = deferredRequests();
    const f = fixture(request);
    t.after(() => f.maintenance.stop());
    const first = f.maintenance.refresh();
    f.resume();
    // More triggers while the follow-up is queued don't queue another.
    f.resume();
    const again = f.maintenance.refresh();
    assert.equal(calls.length, 1);

    stale(calls[0]);
    await flush();
    assert.equal(calls.length, 2, "the fresh request starts once the stale one answers");
    assert.deepEqual(f.sessions, [], "the stale answer never reaches the viewer");
    assert.deepEqual(f.errors, []);

    calls[1].resolve(signedIn);
    assert.deepEqual(await first, signedIn, "earlier waiters get the fresh answer");
    assert.deepEqual(await again, signedIn);
    assert.deepEqual(f.sessions, [signedIn]);
    assert.equal(f.timers.size, 1, "renewal stays scheduled");
    await flush();
    assert.equal(calls.length, 2);
  });

test("a signed-in tab that becomes visible mid-renewal still gets the fresh answer", async (t) => {
  // Signed out in another tab while this tab's renewal was in flight.
  const { calls, request } = deferredRequests();
  const f = fixture(request);
  t.after(() => f.maintenance.stop());
  const first = f.maintenance.refresh();
  calls[0].resolve(signedIn);
  await first;
  const tick = f.tick();
  f.resume();
  calls[1].resolve(signedIn);
  await flush();
  assert.equal(calls.length, 3);
  calls[2].resolve(signedOut);
  await tick;
  assert.deepEqual(f.sessions, [signedIn, signedOut]);
  assert.equal(f.timers.size, 0, "signed out stops renewing");
});

test("cleanup ignores an in-flight renewal result and does not restart maintenance", async () => {
  const { calls, request } = deferredRequests();
  const f = fixture(request);
  const pending = f.maintenance.refresh();
  f.maintenance.stop();
  calls[0].resolve(signedIn);
  await pending;
  assert.equal(f.sessions.length, 0);
  assert.equal(f.timers.size, 0);
  assert.equal(f.listeners.size, 0);
});

test("stopping drops a queued fresh request", async () => {
  const { calls, request } = deferredRequests();
  const f = fixture(request);
  const pending = f.maintenance.refresh();
  f.resume();
  f.maintenance.stop();
  calls[0].resolve(signedOut);
  assert.deepEqual(await pending, signedOut);
  await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(f.sessions, []);
  assert.equal(f.timers.size, 0);
});

test("a viewer callback that refreshes again starts from the settled state", async (t) => {
  const { calls, request } = deferredRequests();
  let again;
  const f = fixture(request, {
    onSession: () => {
      again ??= f.maintenance.refresh();
    },
  });
  t.after(() => f.maintenance.stop());
  const first = f.maintenance.refresh();
  calls[0].resolve(signedIn);
  assert.deepEqual(await first, signedIn);
  assert.equal(calls.length, 2);
  assert.equal(f.timers.size, 0, "the new request cancelled the renewal it settled with");
  calls[1].resolve(signedOut);
  assert.deepEqual(await again, signedOut);
  assert.equal(f.timers.size, 0);
});

test("missing sessions and auth rejection stop polling until an explicit or visibility retry", async (t) => {
  for (const status of [0, 401, 403])
    for (const retry of ["explicit", "visibility"])
      await t.test(`${status || "no identity"}, ${retry} retry`, async (t) => {
        let authorized = false,
          calls = 0;
        const f = fixture(async () => {
          calls++;
          if (authorized) return signedIn;
          if (status) throw Object.assign(Error("Sign in"), { status });
          return signedOut;
        });
        t.after(() => f.maintenance.stop());
        if (status) await assert.rejects(f.maintenance.refresh(), { status });
        else await f.maintenance.refresh();
        assert.equal(f.timers.size, 0);
        assert.equal(f.sessions[0].identity, null);
        assert.equal(calls, 1);
        authorized = true;
        if (retry === "explicit") await f.maintenance.refresh();
        else {
          f.resume();
          await f.idle();
        }
        assert.equal(calls, 2);
        assert.equal(f.sessions.at(-1).identity, identity);
        assert.equal(f.timers.size, 1);
      });
});

test("transient renewal failures retry on the next minute without clearing identity", async (t) => {
  let fail = false,
    calls = 0;
  const f = fixture(async () => {
    calls++;
    if (fail) throw Object.assign(Error("Temporarily unavailable"), { status: 503 });
    return signedIn;
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

test("a transient failure while signed out waits for a retry", async (t) => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    if (calls === 1) return signedOut;
    throw Object.assign(Error("Temporarily unavailable"), { status: 503 });
  });
  t.after(() => f.maintenance.stop());
  await f.maintenance.refresh();
  await assert.rejects(f.maintenance.refresh(), { status: 503 });
  assert.equal(f.errors.length, 1);
  assert.equal(f.timers.size, 0);
});
