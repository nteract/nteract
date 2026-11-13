import test from "node:test";
import assert from "node:assert/strict";
import { filter, firstValueFrom } from "rxjs";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { maintainBrowserSession } from "./browser-session.mjs";
import { sessionRefreshMachine } from "./session-refresh-machine.mjs";
import { OUTAGE_MS } from "./reconnect-machine.mjs";
import {
  SERVER_UNREACHABLE,
  SESSION_ENDED,
  screenBanners,
  sessionAnswerNotice,
  sessionCheckBanner,
} from "./alerts.mjs";
import { REQUEST_TIMEOUT_MS, request as pagesRequest } from "./request.mjs";

const TABLE = new URL("../test/fixtures/machines/session-refresh.json", import.meta.url);
const identity = { principal: "one", displayName: "Kyle" };
const signedIn = { identity, canWrite: true };
const signedOut = { identity: null, canWrite: false };

function fixture(request, { onSession, onError, now } = {}) {
  const timers = new Map(),
    listeners = new Set(),
    sessions = [],
    errors = [],
    notices = [];
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
    onSession: (value, info) => {
      sessions.push(value);
      onSession?.(value, info);
    },
    onError: (error, info) => {
      errors.push(error);
      notices.push(info.notice);
      onError?.(error, info);
    },
    ...(now && { now }),
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
    notices,
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
    rows: 38,
    pairs: 13,
    unreachable: 2,
    cases: 17,
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

/**
 * A tab's session check as main.jsx shows it: the notice sessionCheckBanner
 * or sessionAnswerNotice picks, set by each answer. The server answers
 * through request(), so gateway pages and refusals classify as they do live.
 * `at` is the fake monotonic clock.
 */
function sessionCheckScreen({ injectNow = true } = {}) {
  let at = 0,
    answer = "ok",
    notice = null,
    account = null,
    deadline = 0;
  // request()'s deadline timers, which expireRequest() fires.
  const deadlines = new Map();
  const responses = {
    // The server never answers; request() gives up at its deadline.
    hang: () => new Promise(() => {}),
    ok: () => Response.json(signedIn),
    down: () =>
      new Response("<!DOCTYPE html><title>503: origin unreachable | Cloudflare</title>", {
        status: 503,
        headers: { "Content-Type": "text/html; charset=UTF-8" },
      }),
    expired: () => Response.json({ error: "Session expired" }, { status: 401 }),
    forbidden: () =>
      Response.json({ error: "Sign in with a verified anaconda.com email." }, { status: 403 }),
  };
  const f = fixture(
    () =>
      pagesRequest(
        "/api/auth/session",
        {},
        {
          fetch: async () => responses[answer](),
          setTimeout: (fn, ms) => {
            deadlines.set(++deadline, { fn, ms });
            return deadline;
          },
          clearTimeout: (id) => deadlines.delete(id),
        },
      ),
    {
      ...(injectNow && { now: () => at }),
      onSession: (result, { refusal }) => {
        notice = sessionAnswerNotice(refusal, { signedIn: !!account });
        account = result.identity;
      },
      onError: (error, info) => {
        const banner = sessionCheckBanner(error, info);
        if (banner !== undefined) notice = { message: banner, signIn: false };
      },
    },
  );
  return {
    f,
    get at() {
      return at;
    },
    /** The banners the screen shows, beside an open Page if one is given. */
    banners: (page = null) => screenBanners({ sessionNotice: notice, page }),
    set: (next) => (answer = next),
    /** Let the renewal timer fire `ms` after the last answer. */
    async renewAfter(ms) {
      at += ms;
      await f.tick();
      await f.idle();
    },
    async refreshAfter(ms) {
      at += ms;
      await f.maintenance.refresh().catch(() => {});
    },
    /** Let the one pending request's deadline pass while the server hangs. */
    async expireRequest() {
      await flush();
      assert.equal(deadlines.size, 1, "one session request waits on its deadline");
      at += REQUEST_TIMEOUT_MS;
      for (const [id, { fn, ms }] of deadlines) {
        assert.equal(ms, REQUEST_TIMEOUT_MS);
        deadlines.delete(id);
        fn();
      }
      await f.idle();
    },
    /** Let the renewal timer fire `ms` after the last answer while the
     * server hangs, past request()'s deadline. */
    async renewTimingOut(ms) {
      answer = "hang";
      at += ms;
      void f
        .takeTimer()()
        .catch(() => {});
      await this.expireRequest();
    },
  };
}

test("a library screen with a persistent 503 shows one notice after the threshold, cleared by success", async (t) => {
  const screen = sessionCheckScreen();
  t.after(() => screen.f.maintenance.stop());
  await screen.f.maintenance.refresh();
  assert.deepEqual(screen.banners(), []);

  screen.set("down");
  // The first failed renewal starts the run; it stays quiet.
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.f.notices, ["quiet"]);
  assert.deepEqual(screen.banners(), []);
  assert.equal(screen.f.timers.size, 1, "renewals continue");
  // The next one is past the threshold: exactly one plain sentence.
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.f.notices, ["quiet", "outage"]);
  assert.deepEqual(screen.banners(), [SERVER_UNREACHABLE]);
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.banners(), [SERVER_UNREACHABLE]);

  screen.set("ok");
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.banners(), [], "a session answer clears it");
  assert.equal(screen.f.sessions.length, 2);

  // The run starts over after a success.
  screen.set("down");
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.f.notices.slice(-1), ["quiet"]);
  assert.deepEqual(screen.banners(), []);
});

test("a healthy Page whose renewal keeps failing shows the same single notice", async (t) => {
  const screen = sessionCheckScreen();
  t.after(() => screen.f.maintenance.stop());
  await screen.f.maintenance.refresh();
  screen.set("down");
  // The Page's socket stays up, so its own problem stays empty.
  const healthy = { problem: "", authRequired: false, authProblem: "", accessProblem: "" };
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.banners(healthy), []);
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.banners(healthy), [SERVER_UNREACHABLE]);
  // A Page that reports its own outage too still shows one notice.
  assert.deepEqual(screen.banners({ ...healthy, problem: SERVER_UNREACHABLE }), [
    SERVER_UNREACHABLE,
  ]);
  screen.set("ok");
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.banners(healthy), []);
});

test("session refreshes from Page reconnects during a short restart stay quiet", async (t) => {
  const screen = sessionCheckScreen();
  t.after(() => screen.f.maintenance.stop());
  await screen.f.maintenance.refresh();
  screen.set("down");
  // Reconnect attempts ask for the session on their backoff, many times in a
  // few seconds; none of them is an outage.
  for (const delay of [250, 500, 1000, 2000, 4000]) await screen.refreshAfter(delay);
  assert.equal(screen.f.notices.length, 5);
  assert.ok(screen.f.notices.every((notice) => notice === "quiet"));
  assert.deepEqual(screen.banners(), []);
  // The same run, which began with the first failure 250 ms in, reaches
  // the threshold if it keeps going.
  await screen.refreshAfter(OUTAGE_MS + 250 - 7750);
  assert.deepEqual(screen.f.notices.at(-1), "outage");
  assert.deepEqual(screen.banners(), [SERVER_UNREACHABLE]);
  screen.set("ok");
  await screen.refreshAfter(250);
  assert.deepEqual(screen.banners(), []);
});

test("a wall-clock jump during a session-check outage neither hides nor hastens the notice", async (t) => {
  // maintainBrowserSession reads performance.now() by default; moving the
  // mocked wall clock an hour either way changes nothing.
  t.mock.timers.enable({ apis: ["Date"], now: 86_400_000 });
  const screen = sessionCheckScreen({ injectNow: false });
  t.mock.method(globalThis.performance, "now", () => screen.at);
  t.after(() => screen.f.maintenance.stop());
  await screen.f.maintenance.refresh();
  screen.set("down");
  await screen.refreshAfter(1000);
  t.mock.timers.setTime(Date.now() + 3_600_000);
  await screen.refreshAfter(5000);
  assert.deepEqual(screen.banners(), [], "a forward jump doesn't report early");
  t.mock.timers.setTime(Date.now() - 7_200_000);
  await screen.refreshAfter(OUTAGE_MS - 5000);
  assert.deepEqual(screen.banners(), [SERVER_UNREACHABLE], "a backward jump doesn't delay it");
});

test("the default outage clock ignores wall-clock jumps", async (t) => {
  const { monotonicNow } = await import("./monotonic.mjs");
  t.mock.timers.enable({ apis: ["Date"], now: 86_400_000 });
  const before = monotonicNow();
  t.mock.timers.setTime(Date.now() + 3_600_000);
  const forward = monotonicNow() - before;
  t.mock.timers.setTime(Date.now() - 7_200_000);
  const back = monotonicNow() - before;
  assert.ok(forward >= 0 && forward < 1000, `forward jump moved it ${forward} ms`);
  assert.ok(back >= forward && back < 1000, `backward jump moved it ${back} ms`);
});

test("a refused renewal during an outage replaces the notice with one sign-in banner", async (t) => {
  for (const [answer, message] of [
    ["expired", SESSION_ENDED],
    ["forbidden", "Sign in with a verified anaconda.com email."],
  ]) {
    await t.test(answer, async (t) => {
      const screen = sessionCheckScreen();
      t.after(() => screen.f.maintenance.stop());
      await screen.f.maintenance.refresh();
      screen.set("down");
      await screen.renewAfter(60_000);
      await screen.renewAfter(60_000);
      assert.deepEqual(screen.banners(), [SERVER_UNREACHABLE]);

      // The renewal timer's own request is refused: the tab signs out and
      // says why, instead of silently dropping the outage notice.
      screen.set(answer);
      await screen.renewAfter(60_000);
      assert.equal(screen.f.sessions.at(-1).identity, null, "the auth transition still happens");
      assert.deepEqual(screen.banners(), [message], "the library screen");
      // An open Page shows its own sign-in prompt, which is the one banner;
      // its sync outage from before sign-in isn't shown beside it.
      const prompt = "Sign in again to sync this Page. Keep it open while you sign in.";
      assert.deepEqual(
        screen.banners({
          problem: SERVER_UNREACHABLE,
          authRequired: true,
          authProblem: prompt,
          accessProblem: "",
        }),
        [],
      );
      assert.equal(screen.f.timers.size, 0, "signed out, renewals stop");
    });
  }
});

test("a tab that was never signed in gets no session-ended banner", async (t) => {
  const screen = sessionCheckScreen();
  t.after(() => screen.f.maintenance.stop());
  screen.set("expired");
  await screen.f.maintenance.refresh().catch(() => {});
  assert.deepEqual(screen.banners(), []);
});

test("a signed-in tab's renewal that times out stays quiet and renews a minute later", async (t) => {
  const screen = sessionCheckScreen();
  t.after(() => screen.f.maintenance.stop());
  await screen.f.maintenance.refresh();
  await screen.renewTimingOut(60_000);
  assert.equal(screen.f.errors[0].code, "REQUEST_TIMEOUT");
  assert.deepEqual(screen.f.notices, ["quiet"]);
  assert.deepEqual(screen.banners(), []);
  assert.equal(screen.f.sessions.length, 1, "the account stays as it was");
  assert.equal(screen.f.timers.size, 1, "the next renewal is scheduled");
  assert.equal(screen.f.maintenance.store.snapshot().failingSince, screen.at);

  // The next renewal, a minute after the timeout, is answered.
  screen.set("ok");
  await screen.renewAfter(60_000);
  assert.equal(screen.f.sessions.length, 2);
  assert.deepEqual(screen.banners(), []);
  assert.equal(screen.f.maintenance.store.snapshot().failingSince, null);
});

test("renewals that keep timing out report one outage, and an answer clears it", async (t) => {
  const screen = sessionCheckScreen();
  t.after(() => screen.f.maintenance.stop());
  await screen.f.maintenance.refresh();
  await screen.renewTimingOut(60_000);
  assert.deepEqual(screen.banners(), []);
  // The next one times out 90 s after the first: past OUTAGE_MS.
  await screen.renewTimingOut(60_000);
  assert.ok(60_000 + REQUEST_TIMEOUT_MS >= OUTAGE_MS);
  assert.deepEqual(screen.f.notices, ["quiet", "outage"]);
  assert.deepEqual(screen.banners(), [SERVER_UNREACHABLE]);
  screen.set("ok");
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.banners(), []);
});

test("a refusal after a timed-out renewal signs the tab out as any refusal does", async (t) => {
  for (const [answer, message] of [
    ["expired", SESSION_ENDED],
    ["forbidden", "Sign in with a verified anaconda.com email."],
  ])
    await t.test(answer, async (t) => {
      const screen = sessionCheckScreen();
      t.after(() => screen.f.maintenance.stop());
      await screen.f.maintenance.refresh();
      await screen.renewTimingOut(60_000);
      assert.deepEqual(screen.banners(), []);
      screen.set(answer);
      await screen.renewAfter(60_000);
      assert.equal(screen.f.sessions.at(-1).identity, null);
      assert.deepEqual(screen.banners(), [message]);
      assert.equal(screen.f.timers.size, 0, "signed out, renewals stop");
    });
});

test("a first session check that times out says so: nothing else is on screen", async (t) => {
  const screen = sessionCheckScreen();
  t.after(() => screen.f.maintenance.stop());
  screen.set("hang");
  const first = screen.f.maintenance.refresh();
  first.catch(() => {});
  await screen.expireRequest();
  await assert.rejects(first, { code: "REQUEST_TIMEOUT" });
  assert.deepEqual(screen.f.notices, ["failure"]);
  assert.deepEqual(screen.banners(), ["The request timed out. Please try again."]);
  // Past OUTAGE_MS it still says the error: the outage sentence promises
  // changes saved on this device, and no account has loaded.
  await screen.renewTimingOut(60_000);
  assert.deepEqual(screen.f.notices, ["failure", "failure"]);
  assert.deepEqual(screen.banners(), ["The request timed out. Please try again."]);
  // It still renews, and the answer clears the notice.
  screen.set("ok");
  await screen.renewAfter(60_000);
  assert.deepEqual(screen.f.sessions.at(-1).identity, identity);
  assert.deepEqual(screen.banners(), []);
});
