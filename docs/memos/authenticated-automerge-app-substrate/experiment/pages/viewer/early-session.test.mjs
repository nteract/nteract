import assert from "node:assert/strict";
import test from "node:test";
import { maintainBrowserSession } from "./browser-session.mjs";
import {
  EARLY_SESSION,
  EARLY_SESSION_MAX_AGE_MS,
  SESSION_URL,
  requestSession,
  startEarlySession,
  takeEarlySession,
} from "./early-session.mjs";
import { observeResponses, request } from "./request.mjs";

const identity = { principal: "one", displayName: "Kyle" };
const sessionResponse = (body, { status = 200, build = "early" } = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-probe-build": build },
  });

/** A page with event targets for the head script's invalidation listeners. */
function browser(pathname, response) {
  const calls = [];
  const target = () => {
    const listeners = new Map();
    return {
      listeners,
      addEventListener: (type, fn) =>
        listeners.set(type, (listeners.get(type) ?? new Set()).add(fn)),
      removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
      dispatch: (type, event = {}) => {
        for (const fn of listeners.get(type) ?? []) fn(event);
      },
    };
  };
  const document = { visibilityState: "hidden", ...target() };
  const win = {
    location: { href: `https://pages.example${pathname}` },
    document,
    ...target(),
    fetch: (...args) => {
      calls.push(args);
      return response();
    },
  };
  const listening = () =>
    (document.listeners.get("visibilitychange")?.size ?? 0) +
    (win.listeners.get("pageshow")?.size ?? 0);
  return { win, calls, listening };
}

/** Session maintenance as main.jsx wires it, with fake timers. */
function maintain(win, now) {
  const timers = [],
    sessions = [],
    errors = [];
  const maintenance = maintainBrowserSession({
    request: () => requestSession(request, now ? { win, now } : { win }),
    onSession: (value) => sessions.push(value),
    onError: (error) => errors.push(error),
    document: null,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
  });
  return { maintenance, timers, sessions, errors };
}

test("the head script starts the viewer's exact session request on viewer routes", () => {
  for (const pathname of [
    "/",
    "/?page=5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70",
    "/p/5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70",
    "/project/prj_5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70",
  ]) {
    const { win, calls } = browser(pathname, () => new Promise(() => {}));
    startEarlySession(win);
    assert.equal(calls.length, 1, pathname);
    const [url, init] = calls[0];
    assert.equal(url, SESSION_URL);
    // request() sends only { signal }: GET, same-origin credentials, no headers.
    assert.deepEqual(Object.keys(init), ["signal"]);
    assert.ok(init.signal instanceof AbortSignal);
    assert.ok(win[EARLY_SESSION]);
  }
});

test("the head script leaves pages that never check the session alone", () => {
  for (const pathname of ["/connect", "/oauth/authorize?client_id=x", "/p/not-a-page", "/other"]) {
    const { win, calls } = browser(pathname, () => new Promise(() => {}));
    startEarlySession(win);
    assert.equal(calls.length, 0, pathname);
    assert.equal(EARLY_SESSION in win, false, pathname);
  }
});

test("an unconsumed failed early request is not an unhandled rejection", async () => {
  const { win } = browser("/", () => Promise.reject(new TypeError("offline")));
  const unhandled = [];
  const listen = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listen);
  try {
    startEarlySession(win);
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", listen);
  }
  assert.deepEqual(unhandled, []);
});

/** Normal requests go through the global fetch, as request() does. */
function stubFetch(t, respond) {
  const fetched = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    fetched.push([url, init]);
    return respond();
  });
  return fetched;
}

test("the first refresh consumes the early response and later refreshes fetch", async (t) => {
  const { win } = browser("/", () =>
    Promise.resolve(sessionResponse({ identity, canWrite: true })),
  );
  startEarlySession(win);
  const fetched = stubFetch(t, () =>
    sessionResponse({ identity, canWrite: true }, { build: "later" }),
  );
  const seen = [];
  const stop = observeResponses((headers) => seen.push(headers.get("x-probe-build")));
  try {
    const f = maintain(win);
    assert.deepEqual(await f.maintenance.refresh(), { identity, canWrite: true });
    assert.equal(fetched.length, 0);
    assert.equal(EARLY_SESSION in win, false);
    // Build freshness reads the early response's headers like any other.
    assert.deepEqual(seen, ["early"]);
    assert.deepEqual(f.sessions, [{ identity, canWrite: true }]);

    // The periodic renewal, then an explicit retry, each fetch normally.
    assert.equal(f.timers.length, 1);
    await f.timers[0]();
    await f.maintenance.refresh();
    assert.equal(fetched.length, 2);
    for (const [url] of fetched) assert.equal(url, SESSION_URL);
    assert.deepEqual(seen, ["early", "later", "later"]);
    f.maintenance.stop();
  } finally {
    stop();
  }
});

test("a signed-out early answer is the first refresh's answer", async (t) => {
  const { win } = browser("/", () =>
    Promise.resolve(sessionResponse({ identity: null, canWrite: false })),
  );
  startEarlySession(win);
  const fetched = stubFetch(t, () => sessionResponse({ identity: null, canWrite: false }));
  const f = maintain(win);
  await f.maintenance.refresh();
  assert.equal(fetched.length, 0);
  assert.deepEqual(f.sessions, [{ identity: null, canWrite: false }]);
  assert.deepEqual(f.errors, []);
});

for (const [name, failure] of [
  ["a transport failure", () => Promise.reject(new TypeError("Failed to fetch"))],
  ["a 503", () => Promise.resolve(sessionResponse({ error: "Unavailable" }, { status: 503 }))],
])
  test(`${name} in the early request falls back to one normal request`, async (t) => {
    const { win } = browser("/", failure);
    startEarlySession(win);
    const fetched = stubFetch(t, () => sessionResponse({ identity, canWrite: true }));
    const f = maintain(win);
    assert.deepEqual(await f.maintenance.refresh(), { identity, canWrite: true });
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0][0], SESSION_URL);
    assert.deepEqual(Object.keys(fetched[0][1]), ["signal"]);
    assert.deepEqual(f.errors, []);
    assert.deepEqual(f.sessions, [{ identity, canWrite: true }]);
  });

test("request()'s deadline cancels a hanging early request without a fallback", async (t) => {
  const { win } = browser("/", () => new Promise(() => {}));
  startEarlySession(win);
  const { controller } = win[EARLY_SESSION];
  const fetched = stubFetch(t, () => sessionResponse({ identity }));
  await assert.rejects(
    requestSession((url, options, deps) => request(url, options, { ...deps, timeoutMs: 5 }), {
      win,
    }),
    { code: "REQUEST_TIMEOUT" },
  );
  assert.equal(controller.signal.aborted, true);
  assert.equal(fetched.length, 0);
});

test("without a head-script request the first refresh fetches", async () => {
  const win = {};
  const calls = [];
  const result = await requestSession(
    async (...args) => {
      calls.push(args);
      return { identity: null };
    },
    { win },
  );
  assert.deepEqual(result, { identity: null });
  assert.deepEqual(calls, [[SESSION_URL]]);
  assert.equal(takeEarlySession(win), undefined);
});

test("taking the slot removes the head script's listeners", async () => {
  const { win, listening } = browser("/", () =>
    Promise.resolve(sessionResponse({ identity: null, canWrite: false })),
  );
  startEarlySession(win);
  assert.equal(listening(), 2);
  assert.ok(takeEarlySession(win));
  assert.equal(listening(), 0);
  assert.equal(takeEarlySession(win), undefined);
});

test("becoming visible before the viewer mounts makes the first refresh fetch", async (t) => {
  // The early check answered signed out; another tab then signed in.
  const { win, listening } = browser("/", () =>
    Promise.resolve(sessionResponse({ identity: null, canWrite: false })),
  );
  startEarlySession(win);
  const { controller } = win[EARLY_SESSION];
  await new Promise((resolve) => setImmediate(resolve));
  // A hidden transition says nothing about the cookie.
  win.document.dispatch("visibilitychange");
  assert.ok(win[EARLY_SESSION]);
  win.document.visibilityState = "visible";
  win.document.dispatch("visibilitychange");
  assert.equal(EARLY_SESSION in win, false);
  assert.equal(controller.signal.aborted, true);
  assert.equal(listening(), 0);

  // WASM finishes later and the viewer mounts.
  const fetched = stubFetch(t, () => sessionResponse({ identity, canWrite: true }));
  const f = maintain(win);
  assert.deepEqual(await f.maintenance.refresh(), { identity, canWrite: true });
  assert.equal(fetched.length, 1);
  assert.deepEqual(f.sessions, [{ identity, canWrite: true }]);
  // Signed in, so renewal stays scheduled.
  assert.equal(f.timers.length, 1);
  f.maintenance.stop();
});

test("a back/forward cache restore drops the slot; the first load's pageshow does not", () => {
  const { win } = browser("/", () => new Promise(() => {}));
  startEarlySession(win);
  win.dispatch("pageshow", { persisted: false });
  assert.ok(win[EARLY_SESSION]);
  win.dispatch("pageshow", { persisted: true });
  assert.equal(EARLY_SESSION in win, false);
});

test("an early request older than the bound is dropped for a normal fetch", async (t) => {
  for (const [age, adopted] of [
    [EARLY_SESSION_MAX_AGE_MS, true],
    [EARLY_SESSION_MAX_AGE_MS + 1, false],
  ]) {
    let clock = 1_000;
    const now = () => clock;
    const { win } = browser("/", () =>
      Promise.resolve(sessionResponse({ identity: null, canWrite: false })),
    );
    startEarlySession(win, now);
    const { controller } = win[EARLY_SESSION];
    clock += age;
    const fetched = stubFetch(t, () => sessionResponse({ identity, canWrite: true }));
    const f = maintain(win, now);
    const result = await f.maintenance.refresh();
    assert.equal(EARLY_SESSION in win, false);
    if (adopted) {
      assert.deepEqual(result, { identity: null, canWrite: false });
      assert.equal(fetched.length, 0);
      assert.equal(controller.signal.aborted, false);
    } else {
      assert.deepEqual(result, { identity, canWrite: true });
      assert.equal(fetched.length, 1);
      assert.equal(controller.signal.aborted, true);
    }
    f.maintenance.stop();
    t.mock.restoreAll();
  }
});

test("an early 401 is the first refresh's answer, through normal error handling", async (t) => {
  const { win } = browser("/", () =>
    Promise.resolve(sessionResponse({ error: "Sign in again" }, { status: 401 })),
  );
  startEarlySession(win);
  const fetched = stubFetch(t, () => sessionResponse({ identity, canWrite: true }));
  const f = maintain(win);
  await assert.rejects(f.maintenance.refresh(), { status: 401, message: "Sign in again" });
  assert.equal(fetched.length, 0);
  assert.deepEqual(f.sessions, [{ identity: null, canWrite: false }]);
  assert.deepEqual(f.errors, []);
  // browser-session.mjs stops renewing after an authentication refusal.
  assert.equal(f.timers.length, 0);
});
