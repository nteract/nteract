import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { randomSecret, SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import { ADMISSION_ROUTES } from "./admission-reasons.mjs";
import { isolateSetupTimeouts, isolateSetup, isStartingRefusal } from "./isolate-setup.mjs";
import {
  isBrowserNavigation,
  STARTING_COOKIE,
  STARTING_REFRESH_SECONDS,
  startingCount,
  startingPage,
  startingRetry,
} from "./starting-page.mjs";
import worker from "./index.mjs";

const origin = "http://127.0.0.1:9477";
// What a browser sends when a person opens an address.
const NAVIGATE = {
  "sec-fetch-mode": "navigate",
  "sec-fetch-dest": "document",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};
// What the app's own fetch sends.
const FETCH = { "sec-fetch-mode": "cors", accept: "application/json" };

const request = (path, { method = "GET", headers = {} } = {}) =>
  new Request(new URL(path, origin), { method, headers });

/** The refusal a setup wait throws, made by a real setup that never settles. */
async function startingRefusal(t) {
  const saved = { ...isolateSetupTimeouts };
  t.after(() => Object.assign(isolateSetupTimeouts, saved));
  Object.assign(isolateSetupTimeouts, { attempt: 1 });
  const setup = isolateSetup(() => new Promise(() => {}));
  return setup({}).then(
    () => assert.fail("the setup never settles"),
    (error) => error,
  );
}

// Another 503 with the refusal's status and code (serial-queue.mjs).
const otherTimeout = () =>
  Object.assign(new Error("A queued request did not settle"), {
    status: 503,
    code: "request_timeout",
  });

test("the retry reloads after a growing delay and stops after the last one", () => {
  const table = [
    [0, { refreshSeconds: 2, nextCount: 1 }],
    [1, { refreshSeconds: 3, nextCount: 2 }],
    [2, { refreshSeconds: 5, nextCount: 3 }],
    [3, { refreshSeconds: 8, nextCount: 4 }],
    [4, { refreshSeconds: 12, nextCount: 5 }],
    [5, { refreshSeconds: null, nextCount: 0 }],
    [6, { refreshSeconds: null, nextCount: 0 }],
    [-1, { refreshSeconds: 2, nextCount: 1 }],
    [Number.NaN, { refreshSeconds: 2, nextCount: 1 }],
    [1.5, { refreshSeconds: 2, nextCount: 1 }],
  ];
  for (const [count, expected] of table)
    assert.deepEqual(startingRetry(count), expected, `count ${count}`);
  assert.equal(
    STARTING_REFRESH_SECONDS.reduce((sum, seconds) => sum + seconds, 0),
    30,
    "the reloads span one setup attempt",
  );
});

test("the count comes from one well-formed cookie", () => {
  const withCookie = (cookie) => request("/oidc", { headers: { cookie } });
  assert.equal(startingCount(request("/oidc")), 0);
  assert.equal(startingCount(withCookie(`${STARTING_COOKIE}=3`)), 3);
  assert.equal(startingCount(withCookie(`a=b; ${STARTING_COOKIE}=4; c=d`)), 4);
  assert.equal(startingCount(withCookie(`${STARTING_COOKIE}=9`)), 5, "clamped to the last");
  for (const value of ["", "x", "12", "-1", "3x"])
    assert.equal(startingCount(withCookie(`${STARTING_COOKIE}=${value}`)), 0, `value ${value}`);
  assert.equal(startingCount(withCookie(`${STARTING_COOKIE}=1; ${STARTING_COOKIE}=2`)), 0);
  assert.equal(startingCount(withCookie(`pages_starting=3`)), 0, "only the __Host- name");
});

test("only a browser opening a page counts as a navigation", () => {
  const cases = [
    ["GET navigate", request("/api/auth/login", { headers: NAVIGATE }), true],
    ["HEAD navigate", request("/oidc", { method: "HEAD", headers: NAVIGATE }), true],
    ["authorize", request("/oauth/authorize", { headers: NAVIGATE }), true],
    ["app shell", request("/p/abc", { headers: NAVIGATE }), true],
    [
      "no Sec-Fetch-Mode, HTML first",
      request("/oidc", { headers: { accept: NAVIGATE.accept } }),
      true,
    ],
    ["fetch", request("/api/auth/login", { headers: FETCH }), false],
    [
      "no Sec-Fetch-Mode, JSON",
      request("/oidc", { headers: { accept: "application/json" } }),
      false,
    ],
    [
      "no Sec-Fetch-Mode, JSON first",
      request("/oidc", { headers: { accept: "application/json, text/html;q=0.5" } }),
      false,
    ],
    ["no Sec-Fetch-Mode, any type", request("/oidc", { headers: { accept: "*/*" } }), false],
    ["no headers", request("/oidc"), false],
    [
      "Sec-Fetch-Mode beats Accept",
      request("/oidc", { headers: { "sec-fetch-mode": "no-cors", accept: NAVIGATE.accept } }),
      false,
    ],
    ["POST", request("/oauth/authorize", { method: "POST", headers: NAVIGATE }), false],
    [
      "bearer",
      request("/api/auth/login", { headers: { ...NAVIGATE, authorization: "Bearer x" } }),
      false,
    ],
    ["mcp", request("/mcp", { headers: NAVIGATE }), false],
    ["tools", request("/api/tools", { headers: NAVIGATE }), false],
    ["tool call", request("/api/tools/read_page", { headers: NAVIGATE }), false],
    ["REST", request("/api/pages", { headers: NAVIGATE }), false],
    ["token", request("/oauth/token", { headers: NAVIGATE }), false],
    ["metadata", request("/.well-known/oauth-authorization-server", { headers: NAVIGATE }), false],
    ["internal", request("/internal/access", { headers: NAVIGATE }), false],
    ...ADMISSION_ROUTES.map((path) => [path, request(path, { headers: NAVIGATE }), false]),
  ];
  for (const [name, input, expected] of cases)
    assert.equal(isBrowserNavigation(input), expected, name);
});

test("the starting page reloads, and carries the shell's headers and nothing from the request", async (t) => {
  const refusal = await startingRefusal(t);
  assert.equal(isStartingRefusal(refusal), true);
  const secret = "code-0123456789abcdef";
  const response = startingPage(
    request(`/oidc?code=${secret}&state=${secret}`, { headers: NAVIGATE }),
    refusal,
  );
  assert.equal(response.status, 503);
  const headers = Object.fromEntries(response.headers);
  assert.equal(headers["content-type"], "text/html; charset=utf-8");
  assert.equal(headers["cache-control"], "no-store");
  assert.equal(headers["retry-after"], "2");
  assert.equal(headers.refresh, "2");
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "no-referrer");
  assert.equal(
    headers["content-security-policy"],
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  );
  assert.deepEqual(response.headers.getSetCookie(), [
    `${STARTING_COOKIE}=1; Path=/; Max-Age=60; HttpOnly; Secure; SameSite=Lax`,
  ]);
  const body = await response.text();
  assert.match(body, /<meta http-equiv="refresh" content="2">/);
  assert.match(body, /<h1>Pages is starting<\/h1>/);
  assert.match(body, /class="starting-progress"/);
  for (const text of [secret, "oidc", "code=", "state=", "127.0.0.1"])
    assert.equal(body.includes(text), false, `the page names ${text}`);
  // No absolute URL and no inline script or style: the CSP forbids both. The
  // tab icon is a data: URL, which the CSP admits for images.
  const markup = body.replace(/ href="data:image\/png;base64,[A-Za-z0-9+/=]+"/, "");
  assert.doesNotMatch(markup, /https?:|<style|style=|<script>| on[a-z]+=/);
});

test("the last starting page stops reloading and offers to try again", async (t) => {
  const refusal = await startingRefusal(t);
  const response = startingPage(
    request("/api/auth/login", { headers: { ...NAVIGATE, cookie: `${STARTING_COOKIE}=5` } }),
    refusal,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.has("refresh"), false);
  assert.equal(response.headers.get("retry-after"), "30");
  assert.deepEqual(response.headers.getSetCookie(), [
    `${STARTING_COOKIE}=0; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
  ]);
  const body = await response.text();
  assert.doesNotMatch(body, /http-equiv/);
  assert.doesNotMatch(body, /starting-progress/);
  assert.match(body, /<h1>Pages is taking longer than usual<\/h1>/);
  assert.match(body, /<a class="primary setup-action" href="">Try again<\/a>/);
});

test("HEAD gets the starting page's headers and no body", async (t) => {
  const refusal = await startingRefusal(t);
  const response = startingPage(request("/oidc", { method: "HEAD", headers: NAVIGATE }), refusal);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("refresh"), "2");
  assert.equal(response.body, null);
});

test("only the starting refusal on a navigation becomes the page", async (t) => {
  const refusal = await startingRefusal(t);
  const navigation = request("/oidc", { headers: NAVIGATE });
  assert.equal(startingPage(navigation, otherTimeout()), null);
  assert.equal(startingPage(navigation, new Error("boom")), null);
  assert.equal(startingPage(navigation, undefined), null);
  assert.equal(startingPage(request("/oidc", { headers: FETCH }), refusal), null);
  // The mark doesn't carry over to a copy of the error.
  assert.equal(isStartingRefusal({ ...refusal }), false);
  assert.equal(isStartingRefusal(JSON.parse(JSON.stringify(refusal))), false);
});

/** A D1 stand-in over SQLite whose statements hang when `hangs(sql)` says so,
 * or fail with `fails(sql)`'s error. Records every statement it runs. */
function database(t, { hangs = () => false, fails = () => undefined } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const ran = [];
  const settle = async (sql, work) => {
    ran.push(sql);
    if (hangs(sql)) return new Promise(() => {});
    const error = fails(sql);
    if (error) throw error;
    return work();
  };
  const DB = {
    ran,
    prepare(sql) {
      const build = (values = []) => ({
        bind: (...next) => build(next),
        first: () => settle(sql, () => sqlite.prepare(sql).get(...values) ?? null),
        all: () =>
          settle(sql, () => ({ success: true, results: sqlite.prepare(sql).all(...values) })),
        run: () =>
          settle(sql, () => ({
            success: true,
            meta: { changes: Number(sqlite.prepare(sql).run(...values).changes) },
          })),
      });
      return build();
    },
    async batch(statements) {
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      return result;
    },
  };
  return DB;
}

/** A gateway env whose session schema never finishes, with setup waits cut
 * to a few milliseconds. */
function startingGateway(t, extra = {}) {
  const saved = { ...isolateSetupTimeouts };
  t.after(() => Object.assign(isolateSetupTimeouts, saved));
  Object.assign(isolateSetupTimeouts, { wait: 20, attempt: 20 });
  t.mock.method(console, "error", () => {});
  t.mock.method(console, "warn", () => {});
  return {
    DB: database(t, { hangs: () => true }),
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "fixture-only-session-secret-".repeat(2),
    ...extra,
  };
}

const STARTING_JSON = {
  error: "Pages is starting. Try again.",
  code: "request_timeout",
  retryable: true,
};

test("a browser opening sign-in while Pages starts gets the starting page", async (t) => {
  for (const path of ["/api/auth/login?return_to=%2Fpages", "/oidc?code=abc&state=def"]) {
    const env = startingGateway(t);
    const response = await worker.fetch(request(path, { headers: NAVIGATE }), env);
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8", path);
    assert.equal(response.headers.get("refresh"), "2", path);
    assert.match(await response.text(), /<h1>Pages is starting<\/h1>/, path);
  }
});

test("the last attempt's starting page doesn't reload", async (t) => {
  const env = startingGateway(t);
  const response = await worker.fetch(
    request("/oidc?code=abc&state=def", {
      headers: { ...NAVIGATE, cookie: `${STARTING_COOKIE}=5` },
    }),
    env,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.has("refresh"), false);
  assert.match(await response.text(), /Pages is taking longer than usual/);
});

test("programs get the starting refusal as unchanged JSON", async (t) => {
  const cookie = `${SERVER_SESSION_COOKIE}=${randomSecret()}`;
  const cases = [
    ["fetch", request("/api/auth/login", { headers: FETCH })],
    [
      "bearer navigation",
      request("/api/auth/login", { headers: { ...NAVIGATE, authorization: "Bearer pages_x" } }),
    ],
    ["mcp", request("/mcp", { method: "GET", headers: { ...NAVIGATE, cookie } })],
    ["curl", request("/oidc", { headers: { accept: "*/*" } })],
  ];
  for (const [name, input] of cases) {
    const env = startingGateway(t);
    const response = await worker.fetch(input, env);
    assert.equal(response.status, 503, name);
    assert.equal(response.headers.get("content-type"), "application/json", name);
    assert.equal(response.headers.has("refresh"), false, name);
    assert.deepEqual(await response.json(), STARTING_JSON, name);
  }
});

test("another 503 on a navigation stays JSON", async (t) => {
  const env = startingGateway(t);
  env.DB = database(t, { fails: () => otherTimeout() });
  const response = await worker.fetch(request("/api/auth/login", { headers: NAVIGATE }), env);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("content-type"), "application/json");
  assert.deepEqual(await response.json(), {
    error: "A queued request did not settle",
    code: "request_timeout",
    retryable: true,
  });
});

test("a Kilo callback refused while Pages starts has taken nothing, so it reloads", async (t) => {
  const env = startingGateway(t, {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    PAGES_KILO_APP_URL: "https://kilo.example",
    PAGES_KILO_AUDIENCE: "pages-test",
    PAGES_KILO_EXCHANGE_SECRET: "kilo-exchange-fixture-secret-0123456789",
  });
  // The session schema is ready; the Kilo handoff schema never finishes.
  env.DB = database(t, { hangs: (sql) => sql.includes("kilo_handoff") });
  const state = randomSecret();
  const response = await worker.fetch(
    request(`/api/auth/kilo/callback?code=abc&state=${state}`, { headers: NAVIGATE }),
    env,
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("refresh"), "2");
  assert.ok(
    env.DB.ran.some((sql) => sql.includes("kilo_handoff")),
    "the callback waited on the handoff schema",
  );
  assert.equal(
    env.DB.ran.some((sql) => /DELETE FROM kilo_handoffs/.test(sql)),
    false,
    "the callback took no handoff row",
  );
});
