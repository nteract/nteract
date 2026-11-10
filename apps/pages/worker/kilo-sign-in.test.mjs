import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readServerAppSession, SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import { ServerSessionGrantRejected } from "@cloud/server-oidc.ts";
import { KiloUnavailable } from "./kilo-pairing-client.mjs";
import { startLocalKilo } from "../scripts/fixtures/local-kilo.mjs";
import { handleKiloSignIn, kiloSessionProvider, pairingTransition } from "./kilo-sign-in.mjs";

const origin = "http://127.0.0.1:9477";
const user = { id: "person:one", email: "person@example.test", name: "Example Person" };
const events = [
  "kilo_pending",
  "kilo_approved",
  "kilo_denied",
  "kilo_expired",
  "profile_read",
  "profile_refused",
  "profile_mismatch",
  "deadline_passed",
];
const states = ["pending", "approved", "signed_in", "denied", "expired", "failed"];
class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => this.sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ success: true, results: this.sqlite.prepare(sql).all(...values) }),
      run: async () => ({
        success: true,
        meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) },
      }),
    });
    return build();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const result = statements.map((statement) => statement.run());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
function fixture(t, kilo, extra = {}) {
  const env = {
    DB: new SqliteD1(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "kilo-session-fixture-secret-".repeat(3),
    PAGES_KILO_APP_URL: kilo.origin,
    ...extra,
  };
  const lines = [];
  const restore = t.mock.method(console, "info", (line) => lines.push(String(line)));
  t.after(async () => {
    restore.mock.restore();
    await kilo.close();
    env.DB.sqlite.close();
  });
  return { env, lines };
}
function request(path, { method = "GET", cookie, headers = {} } = {}) {
  return new Request(origin + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
}
function pairingCookie(response) {
  return response.headers
    .getSetCookie()
    .find((value) => value.startsWith("__Host-pages_kilo_pairing="));
}
function cookieValue(header) {
  return header.split(";", 1)[0];
}
async function begin(env, returnTo = "/pages") {
  const response = await handleKiloSignIn(
    request(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`, {
      headers: { "cf-connecting-ip": "127.0.0.9" },
    }),
    env,
  );
  assert.equal(response.status, 303);
  return { response, cookie: cookieValue(pairingCookie(response)) };
}
async function poll(env, cookie, headers = {}) {
  const response = await handleKiloSignIn(
    request("/api/auth/pairing", {
      method: "POST",
      cookie,
      headers: { Origin: origin, ...headers },
    }),
    env,
  );
  return { response, body: await response.json() };
}
async function approve(kilo, pageResponse, account = user) {
  const page = await pageResponse.text();
  const code = page.match(/class="user-code"[^>]*>([^<]+)/)?.[1];
  assert.ok(code);
  assert.equal(await kilo.approve(code, account), true);
  return page;
}

test("pairingTransition accepts only the declared state and event combinations", () => {
  const valid = new Map([
    ["pending:kilo_pending", ["pending", "wait"]],
    ["pending:kilo_approved", ["approved", "persist_grant"]],
    ["pending:kilo_denied", ["denied", "delete"]],
    ["pending:kilo_expired", ["expired", "delete"]],
    ["pending:deadline_passed", ["expired", "delete"]],
    ["approved:profile_read", ["signed_in", "create_session"]],
    ["approved:profile_refused", ["failed", "delete"]],
    ["approved:profile_mismatch", ["failed", "delete"]],
    ["approved:deadline_passed", ["expired", "delete"]],
  ]);
  for (const state of states)
    for (const event of events) {
      const expected = valid.get(`${state}:${event}`);
      if (!expected) assert.throws(() => pairingTransition(state, event));
      else assert.deepEqual(Object.values(pairingTransition(state, event)), expected);
    }
});

test("browser pairing persists the grant before profile lookup and issues a no-proof session", async (t) => {
  const kilo = await startLocalKilo();
  const { env, lines } = fixture(t, kilo);
  const secrets = [user.email, user.id];
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const response = await originalFetch(input, init);
    const path = new URL(input).pathname;
    if (["/api/device-auth/codes", "/api/device-auth/token"].includes(path)) {
      const body = await response.clone().json();
      for (const value of [
        body.device_code,
        body.token,
        body.refreshToken,
        body.userEmail,
        body.userId,
      ])
        if (typeof value === "string") secrets.push(value);
    }
    return response;
  });
  const started = await begin(env);
  assert.match(started.response.headers.get("location"), /\/sign-in$/);
  const pageResponse = await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env);
  const page = await pageResponse.text();
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  assert.match(page, /Pages uses your Kilo account/);
  assert.match(page, /Approve in Kilo/);
  assert.match(page, /target="_blank" rel="noopener noreferrer"/);
  assert.match(page, /kilo-pairing\.js/);
  assert.match(pageResponse.headers.get("content-security-policy"), /connect-src 'self'/);
  assert.doesNotMatch(page, /deviceCode|device_code/);
  const scriptResponse = await handleKiloSignIn(request("/api/auth/kilo-pairing.js"), env);
  const script = await scriptResponse.text();
  assert.match(script, /setTimeout\(poll, 2000\)/);
  await approve(kilo, new Response(page));
  const completed = await poll(env, started.cookie);
  assert.deepEqual(completed.body, { status: "signed_in", return_to: "/pages" });
  const publicResponses = [
    [started.response, ""],
    [pageResponse, page],
    [scriptResponse, script],
    [completed.response, JSON.stringify(completed.body)],
  ];
  for (const [response, body] of publicResponses) {
    const headers = [...response.headers]
      .filter(([name]) => name.toLowerCase() !== "set-cookie")
      .map(([, value]) => value)
      .join("\n");
    const content = `${headers}\n${body}`;
    for (const secret of secrets) assert.equal(content.includes(secret), false);
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const line of lines)
    for (const secret of secrets.slice(0, 1)) assert.equal(line.includes(secret), false);
  const responses = await kilo.requests();
  assert.equal(responses.filter((item) => item.path === "/api/device-auth/token").length, 1);
  const table = env.DB.sqlite.prepare("SELECT count(*) AS count FROM kilo_pairings").get();
  assert.equal(table.count, 0);
  const probe = await handleKiloSignIn(
    request("/api/auth/pairing", {
      method: "POST",
      cookie: started.cookie,
      headers: { Origin: origin },
    }),
    env,
  );
  assert.equal((await probe.json()).status, "expired");
  assert.ok(lines.some((line) => line.includes('"action":"sign_in.succeeded"')));
});

test("the session cookie authenticates as the encoded Kilo principal without email proof", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  const page = await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env);
  await approve(kilo, page);
  const result = await poll(env, started.cookie);
  const cookies = result.response.headers.getSetCookie();
  assert.equal(cookies.length, 2);
  const sessionCookie = cookies.find((value) => value.startsWith(`${SERVER_SESSION_COOKIE}=`));
  const session = await readServerAppSession(
    env,
    request("/api/auth/session", { cookie: cookieValue(sessionCookie) }),
    Math.floor(Date.now() / 1000),
  );
  assert.equal(session.principal, "user:kilo:person%3Aone");
  assert.equal(session.principalNamespace, "user:kilo");
  assert.equal(session.displayName, "Example Person");
  assert.equal(session.identityVerifiedAt, undefined);
  assert.equal(session.verifiedEmailBinding, undefined);
});

test("pairing cookies isolate browsers and concurrent approval polls", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const first = await begin(env),
    second = await begin(env);
  const firstPage = await handleKiloSignIn(request("/sign-in", { cookie: first.cookie }), env);
  await approve(kilo, firstPage);
  assert.equal((await poll(env, undefined)).body.status, "expired");
  const wrong = await poll(env, second.cookie);
  assert.equal(wrong.body.status, "pending");
  const before = (await kilo.requests()).filter(
    (item) => item.path === "/api/device-auth/token",
  ).length;
  const concurrent = await Promise.all([poll(env, first.cookie), poll(env, first.cookie)]);
  assert.equal(concurrent.filter(({ body }) => body.status === "signed_in").length, 1);
  assert.equal(
    (await kilo.requests()).filter((item) => item.path === "/api/device-auth/token").length,
    before + 1,
  );
});

test("profile lookup outage resumes the stored approved grant without re-exchange", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const started = await begin(env);
  await approve(kilo, await handleKiloSignIn(request("/sign-in", { cookie: started.cookie }), env));
  const original = globalThis.fetch;
  let failed = false;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    if (!failed && new URL(input).pathname === "/api/profile") {
      failed = true;
      throw new Error("offline");
    }
    return original(input, init);
  });
  assert.equal((await poll(env, started.cookie)).body.status, "pending");
  await new Promise((resolve) => setTimeout(resolve, 2100));
  assert.equal((await poll(env, started.cookie)).body.status, "signed_in");
  assert.equal(
    (await kilo.requests()).filter((item) => item.path === "/api/device-auth/token").length,
    1,
  );
});

test("denial, expiry, user mismatch, origin refusal, and unavailable start are bounded", async (t) => {
  let fakeNow = Date.now();
  const kilo = await startLocalKilo({ now: () => fakeNow });
  const { env } = fixture(t, kilo);
  const denied = await begin(env);
  const deniedPage = await handleKiloSignIn(request("/sign-in", { cookie: denied.cookie }), env);
  const deniedCode = (await deniedPage.text()).match(/class="user-code"[^>]*>([^<]+)/)[1];
  await kilo.deny(deniedCode);
  assert.equal((await poll(env, denied.cookie)).body.status, "denied");
  const expired = await begin(env);
  const row = env.DB.sqlite
    .prepare(
      "SELECT id FROM kilo_pairings WHERE user_code = (SELECT user_code FROM kilo_pairings ORDER BY rowid DESC LIMIT 1)",
    )
    .get();
  env.DB.sqlite.prepare("UPDATE kilo_pairings SET expires_at = 1 WHERE id = ?").run(row.id);
  assert.equal((await poll(env, expired.cookie)).body.status, "expired");
  const mismatch = await begin(env);
  const mismatchPage = await handleKiloSignIn(
    request("/sign-in", { cookie: mismatch.cookie }),
    env,
  );
  await approve(kilo, mismatchPage);
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input, init) => {
    const response = await originalFetch(input, init);
    if (new URL(input).pathname !== "/api/profile") return response;
    const body = await response.json();
    return new Response(JSON.stringify({ ...body, user: { ...body.user, id: "another" } }), {
      status: 200,
      headers: response.headers,
    });
  });
  assert.equal((await poll(env, mismatch.cookie)).body.status, "failed");
  assert.equal(
    (await poll(env, mismatch.cookie, { Origin: "https://evil.example" })).response.status,
    403,
  );
  const unavailable = await startLocalKilo();
  await unavailable.close();
  const badEnv = { ...env, PAGES_KILO_APP_URL: unavailable.origin };
  const failedStart = await handleKiloSignIn(request("/api/auth/login"), badEnv);
  assert.equal(failedStart.status, 503);
  assert.match(await failedStart.text(), /Sign-in is temporarily unavailable/);
});

test("session renewal rotates the stored credential and rejects ended or foreign grants", async (t) => {
  const kilo = await startLocalKilo();
  const { env } = fixture(t, kilo);
  const provider = kiloSessionProvider(env, request("/api/auth/session"));
  const initial = await (
    await import("./kilo-pairing-client.mjs")
  ).startKiloPairing(fetch, {
    appUrl: kilo.origin,
    client: { id: "pages", name: "Pages", redirectOrigin: origin },
  });
  await kilo.approve(initial.userCode, user);
  const exchange = await (
    await import("./kilo-pairing-client.mjs")
  ).exchangeKiloDeviceCode(fetch, { appUrl: kilo.origin, deviceCode: initial.deviceCode });
  const grant = {
    kind: "kilo",
    appUrl: kilo.origin,
    userId: user.id,
    refreshToken: exchange.refreshToken,
  };
  const refreshed = await provider.refresh(grant);
  assert.notEqual(refreshed.bundle.refreshToken, grant.refreshToken);
  assert.equal(refreshed.identity.principal, "user:kilo:person%3Aone");
  await assert.rejects(
    provider.refresh({ ...grant, appUrl: "https://elsewhere.example" }),
    ServerSessionGrantRejected,
  );
  kilo.revoke(user.id);
  await assert.rejects(provider.refresh(refreshed.bundle), ServerSessionGrantRejected);
  const second = await startLocalKilo();
  t.after(() => second.close());
  const secondStart = await (
    await import("./kilo-pairing-client.mjs")
  ).startKiloPairing(fetch, {
    appUrl: second.origin,
    client: { id: "pages", name: "Pages", redirectOrigin: origin },
  });
  await second.approve(secondStart.userCode, user);
  const secondGrant = await (
    await import("./kilo-pairing-client.mjs")
  ).exchangeKiloDeviceCode(fetch, { appUrl: second.origin, deviceCode: secondStart.deviceCode });
  const secondProvider = kiloSessionProvider(
    { ...env, PAGES_KILO_APP_URL: second.origin },
    request("/api/auth/session"),
  );
  second.block(user.id);
  await assert.rejects(
    secondProvider.refresh({
      kind: "kilo",
      appUrl: second.origin,
      userId: user.id,
      refreshToken: secondGrant.refreshToken,
    }),
    ServerSessionGrantRejected,
  );
  const originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async () => {
    throw new Error("offline");
  });
  await assert.rejects(
    secondProvider.refresh({
      kind: "kilo",
      appUrl: second.origin,
      userId: user.id,
      refreshToken: secondGrant.refreshToken,
    }),
    KiloUnavailable,
  );
  assert.equal(typeof originalFetch, "function");
});
