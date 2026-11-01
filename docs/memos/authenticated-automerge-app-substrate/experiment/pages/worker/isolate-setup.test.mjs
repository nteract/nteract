import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { randomSecret, SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { authenticate } from "./auth.mjs";
import {
  isolateSetup,
  isolateSetupTimeouts,
  isolateSingleFlight,
  setupAction,
  setupTransition,
} from "./isolate-setup.mjs";
import worker from "./index.mjs";

// Real I/O turns. Tests mock only setTimeout, so these still advance.
const turns = async (count = 50) => {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
};

function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function track(promise) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

test("a waiter resumes from its own timer, not from the setup it waited for", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const setup = deferred();
  let runs = 0;
  const ready = isolateSetup(() => (runs++, setup.promise));
  const key = {};
  const owner = ready(key);
  const waiter = ready(key);
  const waiting = track(waiter);
  await turns();
  assert.equal(runs, 1, "only the first request starts the setup");
  setup.resolve();
  await owner;
  await turns();
  assert.equal(waiting.settled, false, "settling the setup does not resume the waiter");
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  await waiter;
  assert.equal(runs, 1);
  await ready(key);
  assert.equal(runs, 1, "a ready setup does not run again");
});

test("a failed setup lets the next request start it again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const calls = [first.promise, Promise.resolve()];
  const ready = isolateSetup(() => calls.shift());
  const key = {};
  const owner = ready(key);
  const waiter = ready(key);
  first.reject(Error("D1 unavailable"));
  await assert.rejects(owner, /D1 unavailable/);
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  await waiter;
  assert.equal(calls.length, 0, "the waiter ran the setup itself");
});

test("a waiter gives up with a retryable 503 when the setup never settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const ready = isolateSetup(() => new Promise(() => {}));
  const key = {};
  // The starter awaits its own attempt until the attempt's deadline.
  const owner = ready(key);
  const owning = track(owner);
  const waiter = ready(key);
  const waiting = track(waiter);
  for (
    let elapsed = 0;
    elapsed <= isolateSetupTimeouts.wait;
    elapsed += isolateSetupTimeouts.poll
  ) {
    t.mock.timers.tick(isolateSetupTimeouts.poll);
    await turns(2);
    if (waiting.settled) break;
  }
  await assert.rejects(waiter, (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "request_timeout");
    assert.equal(error.reason, "credential_unverified");
    return true;
  });
  assert.equal(owning.settled, false, "the starter outlasts a waiter");
  // At the attempt's deadline the starter gets the same refusal.
  t.mock.timers.tick(isolateSetupTimeouts.attempt);
  await assert.rejects(owner, (error) => {
    assert.equal(error.status, 503);
    assert.equal(error.code, "request_timeout");
    return true;
  });
});

test("a starter waits out a slow setup instead of timing out", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const slow = deferred();
  const ready = isolateSetup(() => slow.promise);
  const owner = ready({});
  const owning = track(owner);
  // Slower than any waiter would wait, but inside the attempt's deadline.
  t.mock.timers.tick(isolateSetupTimeouts.attempt - 1);
  await turns();
  assert.equal(owning.settled, false);
  slow.resolve();
  await owner;
});

test("an abandoned attempt frees its key, and its late result changes nothing", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const attempts = [deferred(), deferred()];
  let runs = 0;
  const ready = isolateSetup(() => attempts[runs++].promise);
  const key = {};
  const first = ready(key).catch((error) => error.message);
  await turns();
  // Inside the attempt's lifetime the key is still held.
  t.mock.timers.tick(isolateSetupTimeouts.attempt - 1);
  const blocked = ready(key).catch((error) => error);
  await turns();
  assert.equal(runs, 1, "the waiter waits on the abandoned attempt");
  // At the attempt's deadline the starter gives up and the attempt expires,
  // so the waiter starts the second attempt itself.
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  assert.equal(await first, "Pages is starting. Try again.");
  await turns();
  assert.equal(runs, 2);
  // The abandoned attempt fails late. It names an old generation, so the
  // second attempt keeps the key.
  attempts[0].reject(new Error("late failure"));
  await turns();
  const third = ready(key);
  await turns();
  assert.equal(runs, 2, "the late failure did not free the key");
  attempts[1].resolve();
  assert.equal(await blocked, undefined);
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  await third;
  assert.equal(runs, 2);
});

test("the setup machine accepts only its own attempt's results", () => {
  const idle = { name: "idle" };
  const running = { name: "running", generation: 2, deadline: 100 };
  const ready = { name: "ready" };
  const start = (now) => ({ type: "start", generation: 3, now, deadline: now + 50 });
  const cases = [
    [idle, start(0), { name: "running", generation: 3, deadline: 50 }],
    [running, start(99), "an attempt holds the key"],
    [running, start(100), { name: "running", generation: 3, deadline: 150 }],
    [ready, start(0), "setup is ready"],
    [running, { type: "succeed", generation: 2 }, ready],
    [running, { type: "succeed", generation: 1 }, "not the running attempt"],
    [running, { type: "fail", generation: 2 }, idle],
    [running, { type: "fail", generation: 1 }, "not the running attempt"],
    [idle, { type: "succeed", generation: 2 }, "not the running attempt"],
    [idle, { type: "fail", generation: 2 }, "not the running attempt"],
    [ready, { type: "succeed", generation: 2 }, "not the running attempt"],
    [ready, { type: "fail", generation: 2 }, "not the running attempt"],
    [running, { type: "expire", generation: 2, now: 100 }, idle],
    [running, { type: "expire", generation: 2, now: 99 }, "the attempt has time left"],
    [running, { type: "expire", generation: 1, now: 100 }, "not the running attempt"],
    [idle, { type: "expire", generation: 2, now: 100 }, "not the running attempt"],
    [ready, { type: "expire", generation: 2, now: 100 }, "not the running attempt"],
    [idle, { type: "other" }, "unknown event"],
  ];
  for (const [state, event, expected] of cases) {
    const result = setupTransition(state, event);
    if (typeof expected === "string") {
      assert.equal(result.rejected, expected, JSON.stringify([state, event]));
      assert.equal(result.state, state);
    } else assert.deepEqual(result, { state: expected }, JSON.stringify([state, event]));
  }
  assert.equal(setupAction(ready, 0), "ready");
  assert.equal(setupAction(idle, 0), "start");
  assert.equal(setupAction(running, 99), "wait");
  assert.equal(setupAction(running, 100), "start");
});

test("each key has its own setup", async () => {
  const keys = [];
  const ready = isolateSetup(async (key) => keys.push(key));
  const left = {};
  const right = {};
  await Promise.all([ready(left), ready(right)]);
  assert.deepEqual(keys, [left, right]);
});

test("a single-flight caller starts its work only after the earlier call settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const flight = isolateSingleFlight({ holdMs: 60_000 });
  const first = deferred();
  const started = [];
  const owner = flight("key", () => (started.push("owner"), first.promise));
  const waiter = flight("key", async () => (started.push("waiter"), "waited"));
  const other = flight("other", async () => (started.push("other"), "other"));
  assert.equal(await other, "other", "another key does not wait");
  await turns();
  assert.deepEqual(started, ["owner", "other"]);
  first.resolve("owned");
  assert.equal(await owner, "owned");
  await turns();
  assert.deepEqual(started, ["owner", "other"], "settling does not resume the waiter");
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  assert.equal(await waiter, "waited");
  assert.deepEqual(started, ["owner", "other", "waiter"]);
});

test("concurrent requests with one API key do not share a pending provider lookup", async (t) => {
  const fixture = await createAuthFixture();
  const lookup = deferred();
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    lookups++;
    await lookup.promise;
    return fixture.fetch(url, options);
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const token = fixture.apiKey();
  const request = () =>
    new Request("https://pages.invalid/api/connect?page=test", {
      headers: { authorization: `Bearer ${token}` },
    });
  const first = authenticate(request(), fixture.env);
  const second = authenticate(request(), fixture.env);
  const waiting = track(second);
  await turns();
  assert.equal(lookups, 1);
  lookup.resolve();
  await first;
  await turns();
  assert.equal(waiting.settled, false, "the second request waits on its own timer");
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  assert.equal((await second).principal, (await first).principal);
  assert.equal(lookups, 1, "the second request reads the settled cache entry");
});

/** A D1 binding over SQLite whose first session-schema statement waits for `release`. */
function sessionDatabase(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const held = deferred();
  const release = deferred();
  const schema = [];
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bindings = [];
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async first() {
          return statement.get(...bindings) ?? null;
        },
        async run() {
          if (sql.startsWith("CREATE TABLE IF NOT EXISTS oidc_login_transactions")) {
            schema.push(sql);
            held.resolve();
            await release.promise;
          }
          statement.run(...bindings);
          return { success: true };
        },
      };
    },
  };
  return {
    env: { DB, NOTEBOOK_CLOUD_APP_SESSION_SECRET: "fixture-only-session-secret-".repeat(2) },
    held: held.promise,
    release: release.resolve,
    schema,
  };
}

const withSessionCookie = (path) =>
  new Request(`http://127.0.0.1:9477${path}`, {
    headers: { cookie: `${SERVER_SESSION_COOKIE}=${randomSecret()}` },
  });

test("concurrent first gateway requests do not await one another's session schema", async (t) => {
  const { env, held, release, schema } = sessionDatabase(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = worker.fetch(withSessionCookie("/api/auth/session"), env);
  await held;
  const second = worker.fetch(withSessionCookie("/api/auth/session"), env);
  const waiting = track(second);
  await turns();
  release();
  assert.equal((await first).status, 200);
  await turns();
  assert.equal(
    waiting.settled,
    false,
    "the second request resumes from its own timer, not from the first request's setup",
  );
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  assert.equal((await second).status, 200);
  assert.equal(schema.length, 1, "the session schema is set up once");
});

test("a session schema setup that hangs is abandoned, and sign-in recovers without a restart", async (t) => {
  // The first session-schema statement never answers; later ones do.
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  let hung = 0;
  const DB = {
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let bindings = [];
      return {
        bind(...values) {
          bindings = values;
          return this;
        },
        async first() {
          return statement.get(...bindings) ?? null;
        },
        async run() {
          if (sql.startsWith("CREATE TABLE IF NOT EXISTS oidc_login_transactions") && !hung++)
            return new Promise(() => {});
          statement.run(...bindings);
          return { success: true };
        },
      };
    },
  };
  const env = { DB, NOTEBOOK_CLOUD_APP_SESSION_SECRET: "fixture-only-session-secret-".repeat(2) };
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const first = worker.fetch(withSessionCookie("/api/auth/login"), env);
  const starting = track(first);
  await turns();
  assert.equal(hung, 1);
  t.mock.timers.tick(isolateSetupTimeouts.attempt - 1);
  await turns();
  assert.equal(starting.settled, false, "a slow setup keeps its request until the deadline");
  // At the attempt's deadline the hung request gets a retryable refusal.
  t.mock.timers.tick(1);
  const refused = await first;
  assert.equal(refused.status, 503);
  assert.deepEqual(await refused.json(), {
    error: "Pages is starting. Try again.",
    code: "request_timeout",
    retryable: true,
  });
  // The next request starts a new attempt. It runs the schema again rather
  // than awaiting the hung statement.
  const next = worker.fetch(withSessionCookie("/api/auth/session"), env);
  const recovered = track(next);
  await turns();
  assert.equal(recovered.settled, true, "the new attempt did not wait on the hung one");
  assert.equal((await next).status, 200);
  assert.equal(hung, 2);
});

test("an admission request waiting on a stalled session schema gets a retryable refusal", async (t) => {
  const { env, held } = sessionDatabase(t);
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  void worker.fetch(withSessionCookie("/api/auth/session"), env);
  await held;
  const pageId = "33333333-3333-4333-8333-333333333333";
  const connect = worker.fetch(withSessionCookie(`/api/connect?page=${pageId}`), env);
  const waiting = track(connect);
  for (
    let elapsed = 0;
    elapsed <= isolateSetupTimeouts.wait;
    elapsed += isolateSetupTimeouts.poll
  ) {
    t.mock.timers.tick(isolateSetupTimeouts.poll);
    await turns(2);
    if (waiting.settled) break;
  }
  const response = await connect;
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "temporarily_unavailable");
});

test("an API key's lookups share one flight whatever the scheme's case", async (t) => {
  const fixture = await createAuthFixture();
  const lookup = deferred();
  let lookups = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    lookups++;
    await lookup.promise;
    return fixture.fetch(url, options);
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const token = fixture.apiKey();
  const request = (scheme) =>
    new Request("https://pages.invalid/api/connect?page=test", {
      headers: { authorization: `${scheme} ${token}` },
    });
  const first = authenticate(request("Bearer"), fixture.env);
  const second = authenticate(request("bearer"), fixture.env);
  const waiting = track(second);
  await turns();
  assert.equal(lookups, 1);
  lookup.resolve();
  await first;
  await turns();
  assert.equal(waiting.settled, false, "the lower-case request waits on its own timer");
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  assert.equal((await second).principal, (await first).principal);
  assert.equal(lookups, 1);
});

test("a single-flight caller whose work stalls gives up, and the key stays held until it settles", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const flight = isolateSingleFlight({ holdMs: 60_000 });
  const stalled = deferred();
  const outcome = flight("key", () => stalled.promise).then(
    () => "settled",
    (error) => error,
  );
  await turns();
  t.mock.timers.tick(isolateSetupTimeouts.wait);
  const error = await outcome;
  assert.equal(error.status, 503);
  assert.equal(error.code, "request_timeout");
  const started = [];
  const next = flight("key", async () => (started.push("next"), "next"));
  await turns();
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  await turns();
  assert.deepEqual(started, [], "no run starts while the abandoned one is pending");
  stalled.resolve();
  await turns();
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  assert.equal(await next, "next");
});

test("a key whose work never settles frees itself after holdMs", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const flight = isolateSingleFlight({ holdMs: 60_000 });
  flight("key", () => new Promise(() => {})).catch(() => {});
  await turns();
  t.mock.timers.tick(isolateSetupTimeouts.wait);
  await turns();
  const blocked = flight("key", async () => "blocked").then(
    () => "ran",
    (error) => error.status,
  );
  await turns();
  for (let elapsed = 0; elapsed < isolateSetupTimeouts.wait; elapsed += isolateSetupTimeouts.poll) {
    t.mock.timers.tick(isolateSetupTimeouts.poll);
    await turns(2);
  }
  assert.equal(await blocked, 503, "inside holdMs the key is still held");
  t.mock.timers.setTime(Date.now() + 60_000);
  assert.equal(await flight("key", async () => "fresh"), "fresh");
});
