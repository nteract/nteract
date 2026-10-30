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
  oidcProvider,
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
  void ready(key);
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
  const flight = isolateSingleFlight();
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

test("a single-flight caller whose work never settles gives up and frees the key", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const flight = isolateSingleFlight();
  const stuck = flight("key", () => new Promise(() => {}));
  const outcome = stuck.then(
    () => "settled",
    (error) => error,
  );
  await turns();
  t.mock.timers.tick(isolateSetupTimeouts.wait);
  const error = await outcome;
  assert.equal(error.status, 503);
  assert.equal(error.code, "request_timeout");
  assert.equal(await flight("key", async () => "next"), "next");
});

test("OIDC provider work runs one request at a time", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const first = deferred();
  const started = [];
  const owner = oidcProvider(() => (started.push("callback"), first.promise));
  const waiter = oidcProvider(async () => (started.push("status"), "status"));
  await turns();
  assert.deepEqual(started, ["callback"]);
  first.resolve("callback");
  assert.equal(await owner, "callback");
  t.mock.timers.tick(isolateSetupTimeouts.poll);
  assert.equal(await waiter, "status");
  assert.deepEqual(started, ["callback", "status"]);
});
