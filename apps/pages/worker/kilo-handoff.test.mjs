import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readServerAppSession, SERVER_SESSION_COOKIE } from "@cloud/oidc-session-store.ts";
import { ServerSessionGrantRejected } from "@cloud/server-oidc.ts";
import { startLocalKiloHandoff } from "../scripts/fixtures/local-kilo-handoff.mjs";
import { handleKiloSignIn, kiloSessionProvider, kiloSignIn } from "./kilo-handoff.mjs";

const origin = "http://127.0.0.1:9477";
const secret = "kilo-exchange-fixture-secret-0123456789";
const user = { id: "person:one", email: "person@example.test", name: "Example Person" };
const BINDING = "__Host-pages_kilo_handoff";

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
      const result = [];
      for (const statement of statements) result.push(await statement.run());
      this.sqlite.exec("COMMIT");
      return result;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}

async function fixture(t, extra = {}) {
  const kilo = await startLocalKiloHandoff({ origins: [origin], secret });
  kilo.signIn(user);
  const env = {
    DB: new SqliteD1(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "pages",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "kilo-session-fixture-secret-".repeat(3),
    PAGES_KILO_APP_URL: kilo.origin,
    PAGES_KILO_EXCHANGE_SECRET: secret,
    ...extra,
  };
  const lines = [];
  const restore = t.mock.method(console, "info", (line) => lines.push(String(line)));
  t.after(async () => {
    restore.mock.restore();
    await kilo.close();
    env.DB.sqlite.close();
  });
  return { env, kilo, lines };
}
const request = (path, { method = "GET", cookie, headers = {} } = {}) =>
  new Request(new URL(path, origin), {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
const setCookie = (response, name) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${name}=`))
    ?.split(";", 1)[0];
const rows = (env) => env.DB.sqlite.prepare("SELECT * FROM kilo_handoffs").all();
const reasons = (lines) =>
  lines.map((line) => JSON.parse(line)).filter((event) => event.action === "sign_in.failed");

/** Starts a sign-in in a browser holding `cookie`, and returns its binding
 * cookie and the address at Kilo it was sent to. */
async function begin(env, { returnTo = "/pages", cookie } = {}) {
  const response = await handleKiloSignIn(
    request(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`, { cookie }),
    env,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("cache-control"), "no-store");
  return { cookie: setCookie(response, BINDING), enter: response.headers.get("location") };
}
/** What Kilo's page does for a signed-in browser: the callback address. */
async function throughKilo(enter) {
  const response = await fetch(enter, { redirect: "manual" });
  assert.equal(response.status, 302);
  return response.headers.get("location");
}
const callback = (env, address, cookie) => handleKiloSignIn(request(address, { cookie }), env);
async function sessionOf(env, response) {
  const cookie = setCookie(response, SERVER_SESSION_COOKIE);
  if (!cookie) return null;
  return readServerAppSession(env, request("/", { cookie }), Math.floor(Date.now() / 1000));
}

test("a sign-in that starts and ends in one browser makes a session without an email", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const started = await begin(env, { returnTo: "/p/abc?view=1#top" });
  const enter = new URL(started.enter);
  assert.equal(enter.origin + enter.pathname, `${kilo.origin}/pages-auth`);
  assert.equal(enter.searchParams.get("origin"), origin);
  assert.deepEqual([...enter.searchParams.keys()].sort(), ["origin", "state"]);
  assert.match(started.cookie, /^__Host-pages_kilo_handoff=[A-Za-z0-9_-]{43}$/);
  const address = await throughKilo(started.enter);
  const response = await callback(env, address, started.cookie);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/p/abc?view=1#top");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const session = await sessionOf(env, response);
  assert.equal(session.principal, "user:kilo:person%3Aone");
  assert.equal(session.displayName, "Example Person");
  assert.equal(JSON.stringify(session).includes(user.email), false);
  assert.deepEqual(rows(env), []);
  const state = enter.searchParams.get("state");
  assert.deepEqual(kilo.exchanges(), [{ authorization: `Bearer ${secret}`, origin, state }]);
  const logged = lines.join("\n");
  const code = new URL(address).searchParams.get("code");
  for (const value of [state, code, secret, user.email, started.cookie.split("=")[1]])
    assert.equal(logged.includes(value), false);
});

test("a callback that reaches another browser signs nobody in and ends that sign-in", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const other = await begin(env);
  for (const cookie of [undefined, other.cookie, `${other.cookie}; ${other.cookie}`]) {
    lines.length = 0;
    const started = await begin(env);
    const address = await throughKilo(started.enter);
    const refused = await callback(env, address, cookie);
    assert.equal(refused.status, 400);
    assert.equal(reasons(lines)[0].reason, "binding_mismatch");
    assert.equal(setCookie(refused, SERVER_SESSION_COOKIE), undefined);
    assert.equal(refused.headers.get("referrer-policy"), "no-referrer");
    assert.equal(refused.headers.get("cache-control"), "no-store");
    assert.equal((await refused.text()).includes(new URL(address).searchParams.get("code")), false);
    // The address that browser was left holding is no use to the one that
    // started the sign-in.
    const carriedBack = await callback(env, address, started.cookie);
    assert.equal(carriedBack.status, 400);
    assert.equal(setCookie(carriedBack, SERVER_SESSION_COOKIE), undefined);
  }
  assert.equal(kilo.exchanges().length, 0);
});

test("a callback is taken once, by one of two requests that carry it", async (t) => {
  const { env, kilo } = await fixture(t);
  const started = await begin(env);
  const address = await throughKilo(started.enter);
  const answers = await Promise.all([
    callback(env, address, started.cookie),
    callback(env, address, started.cookie),
  ]);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [303, 400]);
  assert.equal(kilo.exchanges().length, 1);
  const done = answers.find((answer) => answer.status === 303);
  // The same callback again, from the browser that now has the session.
  const again = await callback(
    env,
    address,
    `${started.cookie}; ${setCookie(done, SERVER_SESSION_COOKIE)}`,
  );
  assert.equal(again.status, 303);
  assert.equal(again.headers.get("location"), "/");
  assert.equal(setCookie(again, SERVER_SESSION_COOKIE), undefined);
  assert.equal(kilo.exchanges().length, 1);
});

test("a sign-in started in a second tab doesn't break the one in the first", async (t) => {
  const { env } = await fixture(t);
  const first = await begin(env, { returnTo: "/p/one" });
  const second = await begin(env, { returnTo: "/p/two", cookie: first.cookie });
  assert.equal(second.cookie, first.cookie);
  assert.notEqual(
    new URL(first.enter).searchParams.get("state"),
    new URL(second.enter).searchParams.get("state"),
  );
  for (const [started, landing] of [
    [second, "/p/two"],
    [first, "/p/one"],
  ]) {
    const response = await callback(env, await throughKilo(started.enter), first.cookie);
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), landing);
  }
});

test("a sign-in left longer than its deadline can't finish", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const started = await begin(env);
  const address = await throughKilo(started.enter);
  const abandoned = await begin(env, { cookie: started.cookie });
  env.DB.sqlite
    .prepare("UPDATE kilo_handoffs SET expires_at = ?")
    .run(Math.floor(Date.now() / 1000));
  const refused = await callback(env, address, started.cookie);
  assert.equal(refused.status, 400);
  assert.equal(reasons(lines)[0].reason, "handoff_expired");
  assert.equal(kilo.exchanges().length, 0);
  // The next sign-in clears out the one nobody came back for.
  assert.ok(abandoned.enter);
  assert.equal(rows(env).length, 1);
  await begin(env);
  assert.equal(rows(env).length, 1);
});

test("only a path on this site is kept as the place to land", async (t) => {
  const { env } = await fixture(t);
  for (const [asked, landing] of [
    ["/p/abc", "/p/abc"],
    ["https://evil.example/p", "/"],
    ["//evil.example", "/"],
    ["/\t/evil.example", "/"],
    ["/a/..//evil.example", "/"],
    ["/\\evil.example", "/"],
    ["/api/auth/login", "/"],
    ["/api/auth/kilo/callback?code=x", "/"],
    ["p/abc", "/"],
  ]) {
    const started = await begin(env, { returnTo: asked });
    const response = await callback(env, await throughKilo(started.enter), started.cookie);
    assert.equal(response.headers.get("location"), landing, asked);
  }
});

test("a callback that isn't one Kilo sends is refused before the row is touched", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const started = await begin(env);
  const address = new URL(await throughKilo(started.enter));
  const state = address.searchParams.get("state");
  const code = address.searchParams.get("code");
  const path = "/api/auth/kilo/callback";
  for (const [query, cookie, reason] of [
    [`?state=${state}`, started.cookie, "callback_malformed"],
    [`?code=${code}`, started.cookie, "callback_malformed"],
    [`?code=${code}&state=short`, started.cookie, "callback_malformed"],
    [`?code=${code}&state=${state}&state=${state}`, started.cookie, "callback_malformed"],
    [`?code=${code}&code=${code}&state=${state}`, started.cookie, "callback_malformed"],
    [`?code=${"c".repeat(2049)}&state=${state}`, started.cookie, "callback_malformed"],
    [`?error=access_denied&state=${state}`, started.cookie, "provider_error"],
  ]) {
    lines.length = 0;
    const refused = await callback(env, path + query, cookie);
    assert.equal(refused.status, 400, query);
    assert.equal(reasons(lines)[0].reason, reason, query);
  }
  assert.equal(rows(env).length, 1);
  assert.equal(kilo.exchanges().length, 0);
});

test("a Kilo that refuses, fails or answers badly ends the sign-in without a session", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  const json = (status, value) => (req, res) =>
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
  for (const [answer, status, reason] of [
    [json(500, {}), 503, "kilo_unavailable"],
    [json(429, {}), 503, "kilo_unavailable"],
    [json(400, { error: "bad_code" }), 400, "exchange_refused_code"],
    [(req, res) => res.writeHead(410).end("gone"), 400, "exchange_refused_code"],
    [json(401, {}), 503, "exchange_refused_client"],
    [json(200, { user: { name: "No Id" } }), 502, "kilo_protocol_error"],
    [json(200, { user: { id: "" } }), 502, "kilo_protocol_error"],
    [(req, res) => res.writeHead(200).end("not json"), 502, "kilo_protocol_error"],
    [
      (req, res) => res.writeHead(302, { location: "https://evil.example/" }).end(),
      502,
      "kilo_protocol_error",
    ],
    [json(200, { user: { id: "x".repeat(17 * 1024) } }), 502, "kilo_protocol_error"],
  ]) {
    lines.length = 0;
    const started = await begin(env, { returnTo: "/p/abc" });
    const address = await throughKilo(started.enter);
    kilo.respond(answer);
    const failed = await callback(env, address, started.cookie);
    assert.equal(failed.status, status, reason);
    assert.equal(setCookie(failed, SERVER_SESSION_COOKIE), undefined);
    assert.equal(reasons(lines)[0].reason, reason);
    assert.match(await failed.text(), /href="\/api\/auth\/login\?return_to=%2Fp%2Fabc"/);
    // Nothing is kept to resume from.
    assert.deepEqual(rows(env), []);
  }
});

test("a code from one sign-in can't finish another", async (t) => {
  const { env, kilo } = await fixture(t);
  const started = await begin(env);
  const address = await throughKilo(started.enter);
  // Someone who got hold of that code presents it under a sign-in of their own.
  const theirs = await begin(env);
  const forged = new URL(await throughKilo(theirs.enter));
  forged.searchParams.set("code", new URL(address).searchParams.get("code"));
  const refused = await callback(env, forged.href, theirs.cookie);
  assert.equal(refused.status, 400);
  assert.equal(setCookie(refused, SERVER_SESSION_COOKIE), undefined);
  assert.equal(kilo.exchanges().at(-1).state, forged.searchParams.get("state"));
  // The sign-in the code belongs to still finishes.
  assert.equal((await callback(env, address, started.cookie)).status, 303);
});

test("an account Kilo has blocked is not signed in", async (t) => {
  const { env, kilo, lines } = await fixture(t);
  kilo.signIn({ ...user, blocked: true });
  const started = await begin(env);
  const refused = await callback(env, await throughKilo(started.enter), started.cookie);
  assert.equal(refused.status, 403);
  assert.equal(setCookie(refused, SERVER_SESSION_COOKIE), undefined);
  assert.equal(reasons(lines)[0].reason, "exchange_refused_account");
});

test("a deployment whose secret Kilo doesn't accept signs nobody in", async (t) => {
  const { env } = await fixture(t, { PAGES_KILO_EXCHANGE_SECRET: "another-secret-".repeat(4) });
  const started = await begin(env);
  const failed = await callback(env, await throughKilo(started.enter), started.cookie);
  assert.equal(failed.status, 503);
  assert.equal(setCookie(failed, SERVER_SESSION_COOKIE), undefined);
});

test("sign-in starts only from this site, and only with GET", async (t) => {
  const { env } = await fixture(t);
  for (const headers of [{ origin: "https://evil.example" }, { "sec-fetch-site": "cross-site" }]) {
    const refused = await handleKiloSignIn(request("/api/auth/login", { headers }), env);
    assert.equal(refused.status, 403);
  }
  for (const path of ["/api/auth/login", "/api/auth/kilo/callback"])
    assert.equal((await handleKiloSignIn(request(path, { method: "POST" }), env)).status, 405);
  assert.deepEqual(rows(env), []);
  assert.equal(await handleKiloSignIn(request("/api/auth/session"), env), null);
});

test("a deployment without the setting has no Kilo routes, and a bad setting throws", async (t) => {
  const { env } = await fixture(t);
  const off = { ...env, PAGES_KILO_APP_URL: undefined };
  assert.equal(await handleKiloSignIn(request("/api/auth/login"), off), null);
  assert.equal(kiloSessionProvider(off, request("/")), undefined);
  for (const bad of [
    { PAGES_KILO_APP_URL: "http://kilo.example" },
    { PAGES_KILO_APP_URL: "https://kilo.example/path" },
    { PAGES_KILO_APP_URL: "https://user@kilo.example" },
    { PAGES_KILO_APP_URL: "not a url" },
    { PAGES_KILO_EXCHANGE_SECRET: undefined },
    { PAGES_KILO_EXCHANGE_SECRET: "too-short" },
    { NOTEBOOK_CLOUD_LOCAL_OIDC: undefined },
  ])
    assert.throws(() => kiloSignIn({ ...env, ...bad }, request("/")), /misconfigured/);
  assert.equal(
    kiloSignIn({ ...env, PAGES_KILO_APP_URL: "https://kilo.example/" }, request("/")).appUrl,
    "https://kilo.example",
  );
});

test("a Kilo session is never renewed", async (t) => {
  const { env } = await fixture(t);
  const provider = kiloSessionProvider(env, request("/"));
  await assert.rejects(
    provider.refresh({ kind: "kilo-handoff", appUrl: env.PAGES_KILO_APP_URL, userId: user.id }),
    ServerSessionGrantRejected,
  );
});
