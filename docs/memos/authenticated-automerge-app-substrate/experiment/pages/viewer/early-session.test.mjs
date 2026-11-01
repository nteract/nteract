import assert from "node:assert/strict";
import test from "node:test";
import { maintainBrowserSession } from "./browser-session.mjs";
import {
  CONNECT_HEADERS,
  EARLY_CONNECT,
  EARLY_CONNECT_MAX_AGE_MS,
  EARLY_SESSION,
  EARLY_SESSION_MAX_AGE_MS,
  SESSION_URL,
  connectUrl,
  earlyPreview,
  requestConnect,
  requestSession,
  startEarlyConnect,
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

/** Session maintenance as main.jsx wires it, with fake timers. Pass
 * `document` to enable its visibility listener. */
function maintain(win, now, { document = null } = {}) {
  const timers = [],
    sessions = [],
    errors = [];
  const maintenance = maintainBrowserSession({
    request: () => requestSession(request, now ? { win, now } : { win }),
    onSession: (value) => sessions.push(value),
    onError: (error) => errors.push(error),
    document,
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
    "/projects",
    "/pages?q=roadmap",
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
  for (const pathname of [
    "/connect",
    "/oauth/authorize?client_id=x",
    "/p/not-a-page",
    "/other",
    "/pages/x",
  ]) {
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

test("becoming visible while the taken early request is in flight asks again", async (t) => {
  // A hidden tab's early check is still in flight when the viewer takes it.
  // Another tab signs in, then this tab becomes visible before it answers.
  let answer;
  const { win } = browser(
    "/",
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );
  startEarlySession(win);
  const fetched = stubFetch(t, () => sessionResponse({ identity, canWrite: true }));
  const f = maintain(win, undefined, { document: win.document });
  const first = f.maintenance.refresh();
  assert.equal(EARLY_SESSION in win, false);

  win.document.visibilityState = "visible";
  win.document.dispatch("visibilitychange");
  assert.equal(fetched.length, 0, "the fresh request waits for the one in flight");

  answer(sessionResponse({ identity: null, canWrite: false }));
  assert.deepEqual(await first, { identity, canWrite: true });
  assert.equal(fetched.length, 1);
  assert.equal(fetched[0][0], SESSION_URL);
  // The stale signed-out answer never reached the viewer.
  assert.deepEqual(f.sessions, [{ identity, canWrite: true }]);
  assert.deepEqual(f.errors, []);
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

const PAGE = "5f0c4a5e-6c1e-4b0e-9a8f-0d0d4c5e6f70";
const OTHER = "6a1d5b6f-7d2f-4c1f-8b9a-1e1e5d6f7a81";
const connection = { documentId: "doc", serverPeerId: "00".repeat(32) };

test("the head script starts a Page's connection discovery on its route only", () => {
  for (const [pathname, pageId] of [
    [`/p/${PAGE}`, PAGE],
    [`/?page=${PAGE}`, PAGE],
    ["/", null],
    ["/projects", null],
    [`/project/prj_${PAGE}`, null],
    ["/p/not-a-page", null],
    ["/connect", null],
  ]) {
    const { win, calls } = browser(pathname, () => new Promise(() => {}));
    startEarlyConnect(win);
    if (!pageId) {
      assert.equal(calls.length, 0, pathname);
      assert.equal(EARLY_CONNECT in win, false, pathname);
      continue;
    }
    // The same request openConnection makes: a GET with the admission header.
    assert.equal(calls.length, 1, pathname);
    const [url, init] = calls[0];
    // Plus the preview the shell shows while the editor loads.
    assert.equal(url, `${connectUrl(pageId)}&preview=1`);
    assert.deepEqual(Object.keys(init), ["headers", "signal"]);
    assert.deepEqual(init.headers, CONNECT_HEADERS);
    assert.deepEqual(CONNECT_HEADERS, { "X-Pages-Admission": "1" });
  }
});

test("the first discovery for the routed Page adopts the early request; later ones fetch", async (t) => {
  const { win } = browser(`/p/${PAGE}`, () =>
    Promise.resolve(sessionResponse(connection, { build: "early" })),
  );
  startEarlyConnect(win);
  const fetched = stubFetch(t, () => sessionResponse(connection, { build: "later" }));
  const seen = [];
  const stop = observeResponses((headers) => seen.push(headers.get("x-probe-build")));
  try {
    assert.deepEqual(await requestConnect(PAGE, request, { win }), connection);
    assert.equal(fetched.length, 0);
    assert.equal(EARLY_CONNECT in win, false);
    assert.deepEqual(await requestConnect(PAGE, request, { win }), connection);
    assert.equal(fetched.length, 1);
    assert.equal(fetched[0][0], connectUrl(PAGE));
    assert.deepEqual(fetched[0][1].headers, CONNECT_HEADERS);
    assert.deepEqual(seen, ["early", "later"]);
  } finally {
    stop();
  }
});

test("a discovery for another Page drops the early request and fetches its own", async (t) => {
  const { win, listening } = browser(`/p/${PAGE}`, () => new Promise(() => {}));
  startEarlyConnect(win);
  const { controller } = win[EARLY_CONNECT];
  const fetched = stubFetch(t, () => sessionResponse(connection));
  assert.deepEqual(await requestConnect(OTHER, request, { win }), connection);
  assert.equal(controller.signal.aborted, true);
  assert.equal(EARLY_CONNECT in win, false);
  assert.equal(listening(), 0);
  assert.deepEqual(
    fetched.map(([url]) => url),
    [connectUrl(OTHER)],
  );
});

test("an early discovery follows its own age bound and the session slot's visibility and failure rules", async (t) => {
  // Older than the bound: dropped for a normal fetch.
  let clock = 1_000;
  const now = () => clock;
  {
    const { win } = browser(`/p/${PAGE}`, () => Promise.resolve(sessionResponse(connection)));
    startEarlyConnect(win, now);
    const { controller } = win[EARLY_CONNECT];
    // Within the connect bound, past the session bound: adopted.
    assert.ok(EARLY_CONNECT_MAX_AGE_MS > EARLY_SESSION_MAX_AGE_MS);
    clock += EARLY_CONNECT_MAX_AGE_MS + 1;
    const fetched = stubFetch(t, () => sessionResponse(connection));
    await requestConnect(PAGE, request, { win, now });
    assert.equal(fetched.length, 1);
    assert.equal(controller.signal.aborted, true);
    t.mock.restoreAll();
  }
  {
    const { win } = browser(`/p/${PAGE}`, () => Promise.resolve(sessionResponse(connection)));
    startEarlyConnect(win, now);
    clock += EARLY_CONNECT_MAX_AGE_MS;
    const fetched = stubFetch(t, () => sessionResponse(connection));
    await requestConnect(PAGE, request, { win, now });
    assert.equal(fetched.length, 0);
    t.mock.restoreAll();
  }
  // Becoming visible before the viewer asks: the answer may predate a sign-in.
  {
    const { win } = browser(`/p/${PAGE}`, () => Promise.resolve(sessionResponse(connection)));
    startEarlyConnect(win);
    win.document.visibilityState = "visible";
    win.document.dispatch("visibilitychange");
    assert.equal(EARLY_CONNECT in win, false);
    const fetched = stubFetch(t, () => sessionResponse(connection));
    await requestConnect(PAGE, request, { win });
    assert.equal(fetched.length, 1);
    t.mock.restoreAll();
  }
  // A 503 or a refusal falls back to one normal request: the Page may have
  // been registered, or access granted, since the head script asked.
  {
    const { win } = browser(`/p/${PAGE}`, () =>
      Promise.resolve(sessionResponse({ error: "Unavailable" }, { status: 503 })),
    );
    startEarlyConnect(win);
    const fetched = stubFetch(t, () => sessionResponse(connection));
    assert.deepEqual(await requestConnect(PAGE, request, { win }), connection);
    assert.equal(fetched.length, 1);
    t.mock.restoreAll();
  }
  {
    const { win } = browser(`/p/${PAGE}`, () =>
      Promise.resolve(
        sessionResponse({ error: "No access", code: "page_access_denied" }, { status: 403 }),
      ),
    );
    startEarlyConnect(win);
    const fetched = stubFetch(t, () => sessionResponse(connection));
    assert.deepEqual(await requestConnect(PAGE, request, { win }), connection);
    assert.equal(fetched.length, 1);
    assert.deepEqual(fetched[0][1].headers, CONNECT_HEADERS);
    t.mock.restoreAll();
  }
  // The fresh answer is the answer, refusal included.
  {
    const { win } = browser(`/p/${PAGE}`, () =>
      Promise.resolve(sessionResponse({ error: "Sign in" }, { status: 401 })),
    );
    startEarlyConnect(win);
    stubFetch(t, () =>
      sessionResponse({ error: "No access", code: "page_access_denied" }, { status: 403 }),
    );
    await assert.rejects(requestConnect(PAGE, request, { win }), {
      status: 403,
      code: "page_access_denied",
    });
  }
});

test("the session and connect slots are independent", async (t) => {
  const { win } = browser(`/p/${PAGE}`, () => Promise.resolve(sessionResponse(connection)));
  startEarlySession(win);
  startEarlyConnect(win);
  assert.ok(takeEarlySession(win));
  assert.ok(win[EARLY_CONNECT]);
  const fetched = stubFetch(t, () => sessionResponse(connection));
  await requestConnect(PAGE, request, { win });
  assert.equal(fetched.length, 0);
});

test("the early discovery's preview is readable without taking the request", async (t) => {
  const preview = { title: "Roadmap", blocks: [], truncated: false };
  const { win } = browser(`/p/${PAGE}`, () =>
    Promise.resolve(sessionResponse({ ...connection, preview })),
  );
  startEarlyConnect(win);
  assert.deepEqual(await earlyPreview(PAGE, win), preview);
  assert.equal(await earlyPreview(OTHER, win), null);
  assert.ok(win[EARLY_CONNECT], "reading the preview leaves the request for the session");
  const fetched = stubFetch(t, () => sessionResponse(connection));
  assert.deepEqual(await requestConnect(PAGE, request, { win }), { ...connection, preview });
  assert.equal(fetched.length, 0);
  assert.equal(await earlyPreview(PAGE, win), null);
});

test("a refused early discovery has no preview", async () => {
  const { win } = browser(`/p/${PAGE}`, () =>
    Promise.resolve(sessionResponse({ error: "Sign in" }, { status: 401 })),
  );
  startEarlyConnect(win);
  assert.equal(await earlyPreview(PAGE, win), null);
});
