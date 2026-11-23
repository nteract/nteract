import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  readServerAppSession,
  SERVER_SESSION_COOKIE,
  ServerSessionGrantRejected,
} from "@nteract/session";
import { authenticate } from "./auth.mjs";
import { browserSessionProvider, handleProviderSignIn } from "./custom-providers.mjs";
import worker from "./index.mjs";
import { decodeEncodedWords, tailscaleSignIn } from "./tailscale-config.mjs";
import { handleTailscaleSignIn, tailscaleSessionProvider } from "./tailscale-signin.mjs";

const origin = "http://127.0.0.1:9478";
const person = "person@example.test";
const relative = "relative@example.test";

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

function fixture(t, extra = {}) {
  const env = {
    DB: new SqliteD1(),
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "tailscale-session-fixture-secret-".repeat(3),
    PAGES_TAILSCALE_LOGINS: ` ${person.toUpperCase()}, ${relative},${person}`,
    ...extra,
  };
  const lines = [];
  const restore = t.mock.method(console, "info", (line) => lines.push(String(line)));
  t.after(() => {
    restore.mock.restore();
    env.DB.sqlite.close();
  });
  return { env, lines };
}

/** A request as Tailscale Serve hands it on: `login` and `name` become the
 * identity headers. */
const request = (path, { method = "GET", cookie, login, name, headers = {} } = {}) =>
  new Request(new URL(path, origin), {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(login !== undefined ? { "Tailscale-User-Login": login } : {}),
      ...(name !== undefined ? { "Tailscale-User-Name": name } : {}),
      ...headers,
    },
  });
const sessionCookie = (response) =>
  response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${SERVER_SESSION_COOKIE}=`))
    ?.split(";", 1)[0];
const now = () => Math.floor(Date.now() / 1000);
const refusals = (lines) =>
  lines
    .map((line) => JSON.parse(line))
    .filter((event) => event.action === "sign_in.failed")
    .map((event) => event.reason);

async function signIn(env, login = person, extra = {}) {
  const response = await handleTailscaleSignIn(
    request("/api/auth/login?return_to=%2Fp%2Fabc%3Fview%3D1", { login, ...extra }),
    env,
  );
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const cookie = sessionCookie(response);
  assert.ok(cookie);
  return { response, cookie };
}

test("a request through Serve from a listed login signs in as that login, with its address verified", async (t) => {
  const { env } = fixture(t);
  const { response, cookie } = await signIn(env, "Person@Example.test", { name: "Example Person" });
  assert.equal(response.headers.get("location"), "/p/abc?view=1");
  const session = await readServerAppSession(env, request("/", { cookie }), now());
  assert.equal(session.principal, "user:tailscale:person%40example.test");
  assert.equal(session.principalNamespace, "user:tailscale");
  assert.equal(session.displayName, "Example Person");
  assert.ok(session.verifiedEmailBinding, "a listed address carries the signed email proof");
  const identity = await authenticate(request("/whoami", { cookie }), env);
  assert.equal(identity.principal, session.principal);
  assert.equal(identity.credentialKind, "oidc");
});

test("a name Tailscale sends Q-encoded is decoded, and a login with no address carries no proof", async (t) => {
  const { env } = fixture(t, { PAGES_TAILSCALE_LOGINS: "ferris@github" });
  const { cookie } = await signIn(env, "ferris@github", { name: "=?utf-8?q?Ferris_B=C3=BCller?=" });
  const session = await readServerAppSession(env, request("/", { cookie }), now());
  assert.equal(session.principal, "user:tailscale:ferris%40github");
  assert.equal(session.displayName, "Ferris Büller");
  assert.equal(session.verifiedEmailBinding, undefined);
});

test("encoded words decode as RFC 2047 says, and anything else falls back", () => {
  assert.equal(decodeEncodedWords("Plain Name"), "Plain Name");
  assert.equal(decodeEncodedWords("=?UTF-8?Q?a?= =?utf-8?q?_b?="), "a b");
  assert.equal(decodeEncodedWords("=?iso-8859-1?q?caf=E9?="), null);
  assert.equal(decodeEncodedWords("=?utf-8?q?bad=ZZ?="), null);
  assert.equal(decodeEncodedWords("=?utf-8?q?=C3?="), null);
});

test("a name that doesn't decode, or carries control characters, shows the login instead", async (t) => {
  const { env } = fixture(t);
  for (const name of ["=?utf-8?q?=C3?=", "=?utf-8?q?a=0Ab?="]) {
    const { cookie } = await signIn(env, person, { name });
    const session = await readServerAppSession(env, request("/", { cookie }), now());
    assert.equal(session.displayName, person);
  }
});

test("a name drops bidi controls and keeps joiners", async (t) => {
  const { env } = fixture(t);
  const shown = async (name) => {
    const { cookie } = await signIn(env, person, { name });
    return (await readServerAppSession(env, request("/", { cookie }), now())).displayName;
  };
  assert.equal(await shown("=?utf-8?q?evil=E2=80=AEtxt?="), "eviltxt");
  // Woman technologist: woman, zero-width joiner, laptop.
  assert.equal(
    await shown("=?utf-8?q?Ada_=F0=9F=91=A9=E2=80=8D=F0=9F=92=BB?="),
    "Ada \u{1F469}\u200D\u{1F4BB}",
  );
});

test("a request without a listed login is refused and starts no session", async (t) => {
  const { env, lines } = fixture(t);
  for (const [login, status] of [
    [undefined, 401],
    ["", 401],
    ["stranger@example.test", 403],
    [`${person}, ${relative}`, 400],
  ]) {
    const response = await handleTailscaleSignIn(request("/api/auth/login", { login }), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(sessionCookie(response), undefined);
    const page = await response.text();
    assert.equal(page.includes("stranger"), false);
    assert.match(page, /href="\/api\/auth\/login\?return_to=%2F"/);
  }
  assert.deepEqual(refusals(lines), ["missing", "missing", "not_allowed", "malformed"]);
});

test("sign-in starts only from this site, by GET, and the OIDC callback isn't served", async (t) => {
  const { env } = fixture(t);
  for (const headers of [
    { origin: "https://elsewhere.example" },
    { "sec-fetch-site": "cross-site" },
  ]) {
    const response = await handleTailscaleSignIn(
      request("/api/auth/login", { login: person, headers }),
      env,
    );
    assert.equal(response.status, 403);
    assert.equal(sessionCookie(response), undefined);
  }
  assert.equal(
    (
      await handleTailscaleSignIn(
        request("/api/auth/login", { method: "POST", login: person }),
        env,
      )
    ).status,
    405,
  );
  assert.equal((await handleTailscaleSignIn(request("/oidc?code=x&state=y"), env)).status, 404);
  assert.equal(
    await handleTailscaleSignIn(request("/api/auth/session", { login: person }), env),
    null,
  );
});

test("a landing path that leaves the site, or loops into sign-in, lands on /", async (t) => {
  const { env } = fixture(t);
  for (const returnTo of [
    "//elsewhere.example/",
    "https://elsewhere.example/",
    "/api/auth/login",
    "/oidc",
    "/\tx",
  ]) {
    const response = await handleTailscaleSignIn(
      request(`/api/auth/login?return_to=${encodeURIComponent(returnTo)}`, { login: person }),
      env,
    );
    assert.equal(response.headers.get("location"), "/");
  }
});

test("a deployment that doesn't list logins leaves the routes and renewals to others", async (t) => {
  const { env } = fixture(t, { PAGES_TAILSCALE_LOGINS: undefined });
  assert.equal(
    await handleTailscaleSignIn(request("/api/auth/login", { login: person }), env),
    null,
  );
  assert.equal(tailscaleSessionProvider(env, request("/")), undefined);
  assert.equal(browserSessionProvider(env, request("/")), undefined);
});

test("an unusable configuration throws instead of falling back to another sign-in", () => {
  const base = { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "https://pages.example.ts.net" };
  const at = new Request("https://pages.example.ts.net/");
  assert.deepEqual(tailscaleSignIn({ ...base, PAGES_TAILSCALE_LOGINS: "A@b.c,a@b.c" }, at).logins, [
    "a@b.c",
  ]);
  for (const env of [
    { ...base, PAGES_TAILSCALE_LOGINS: " , " },
    { ...base, PAGES_TAILSCALE_LOGINS: "has space@b.c" },
    // 200 "+" fit the login limit, but percent-encode past the principal limit.
    { ...base, PAGES_TAILSCALE_LOGINS: `${"+".repeat(200)}@b.c` },
    { ...base, PAGES_TAILSCALE_LOGINS: "a@b.c", PAGES_KILO_APP_URL: "https://kilo.example" },
    { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://pages.example", PAGES_TAILSCALE_LOGINS: "a@b.c" },
    {
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://pages.example",
      NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
      PAGES_TAILSCALE_LOGINS: "a@b.c",
    },
  ])
    assert.throws(() => tailscaleSignIn(env, at), /Tailscale sign-in is misconfigured/);
});

test("a name is cut at whole characters", async (t) => {
  const { env } = fixture(t);
  const emoji = "\u{1F600}";
  const encoded = Array.from(Buffer.from(emoji.repeat(300)))
    .map((byte) => `=${byte.toString(16).toUpperCase().padStart(2, "0")}`)
    .join("");
  const { cookie } = await signIn(env, person, { name: `=?utf-8?q?${encoded}?=` });
  const session = await readServerAppSession(env, request("/", { cookie }), now());
  assert.equal(session.displayName, emoji.repeat(Array.from(session.displayName).length));
  assert.ok(!/[\uD800-\uDBFF]$/.test(session.displayName), "no lone high surrogate at the cut");
});

test("an OAuth grant stops working once its login leaves the list", async (t) => {
  const { env } = fixture(t);
  const { cookie } = await signIn(env);
  const { createHash, randomBytes } = await import("node:crypto");
  const verifier = randomBytes(32).toString("base64url");
  const redirect = "http://127.0.0.1:19876/mcp/oauth/callback";
  const params = new URLSearchParams({
    client_id: "pages-kilo",
    redirect_uri: redirect,
    response_type: "code",
    resource: `${origin}/mcp`,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    scope: "pages:read pages:write",
    state: "s",
  });
  const serve = { login: person, cookie };
  const screen = await (
    await worker.fetch(request(`/oauth/authorize?${params}`, serve), env)
  ).text();
  const field = (name) => screen.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
  const approve = await worker.fetch(
    new Request(`${origin}/oauth/authorize`, {
      method: "POST",
      headers: {
        cookie,
        origin,
        "Tailscale-User-Login": person,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        consent_id: field("consent_id"),
        csrf_token: field("csrf_token"),
        decision: "approve",
      }),
    }),
    env,
  );
  const code = new URL(approve.headers.get("location")).searchParams.get("code");
  const token = await (
    await worker.fetch(
      new Request(`${origin}/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: "pages-kilo",
          code,
          redirect_uri: redirect,
          code_verifier: verifier,
          resource: `${origin}/mcp`,
        }),
      }),
      env,
    )
  ).json();
  const whoami = (environment) =>
    authenticate(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: { authorization: `Bearer ${token.access_token}` },
      }),
      environment,
    );
  assert.equal((await whoami(env)).principal, "user:tailscale:person%40example.test");
  await assert.rejects(
    whoami({ ...env, PAGES_TAILSCALE_LOGINS: relative }),
    (error) => error.status === 401,
  );
});

test("a deployment that names Kilo and Tailscale refuses Kilo too", async () => {
  const { kiloClient } = await import("./kilo-config.mjs");
  assert.throws(
    () =>
      kiloClient({
        PAGES_KILO_APP_URL: "https://kilo.example",
        PAGES_KILO_AUDIENCE: "pages-dev",
        PAGES_KILO_EXCHANGE_SECRET: "s".repeat(40),
        PAGES_TAILSCALE_LOGINS: person,
      }),
    /Kilo sign-in is misconfigured/,
  );
});

test("the gateway's provider hook answers sign-in with Tailscale ahead of OIDC", async (t) => {
  const { env } = fixture(t);
  const response = await handleProviderSignIn(request("/api/auth/login", { login: person }), env);
  assert.equal(response.status, 303);
  assert.ok(sessionCookie(response));
});

test("renewal follows the headers of the request it runs on", async (t) => {
  const { env } = fixture(t);
  const bundle = { kind: "tailscale", login: person };
  const renewed = await tailscaleSessionProvider(env, request("/", { login: person })).refresh(
    bundle,
  );
  assert.equal(renewed.identity.principal, "user:tailscale:person%40example.test");
  assert.deepEqual(renewed.bundle, bundle);
  assert.ok(renewed.expiresAt > now());
  // Another login, or one taken off the list: the session ends.
  await assert.rejects(
    tailscaleSessionProvider(env, request("/", { login: relative })).refresh(bundle),
    ServerSessionGrantRejected,
  );
  await assert.rejects(
    tailscaleSessionProvider(
      { ...env, PAGES_TAILSCALE_LOGINS: relative },
      request("/", { login: person }),
    ).refresh(bundle),
    ServerSessionGrantRejected,
  );
  // A bundle this provider didn't issue: the grant is over.
  await assert.rejects(
    tailscaleSessionProvider(env, request("/", { login: person })).refresh({
      kind: "kilo-handoff",
    }),
    ServerSessionGrantRejected,
  );
  // No headers: neither verdict, so the row stays for a request that has them.
  await assert.rejects(
    tailscaleSessionProvider(env, request("/")).refresh(bundle),
    (error) =>
      error.name === "TailscaleRequesterUnknown" && !(error instanceof ServerSessionGrantRejected),
  );
});

test("a lapsed session renews through the session route, and ends for another login", async (t) => {
  const { env } = fixture(t);
  const { cookie } = await signIn(env);
  const lapse = () =>
    env.DB.sqlite.prepare("UPDATE oidc_server_sessions SET access_expires_at = ?").run(now() - 1);
  const session = (login) => worker.fetch(request("/api/auth/session", { cookie, login }), env);
  lapse();
  const renewed = await session(person);
  assert.equal(renewed.status, 200);
  assert.equal((await renewed.json()).identity.principal, "user:tailscale:person%40example.test");
  const row = env.DB.sqlite.prepare("SELECT access_expires_at FROM oidc_server_sessions").get();
  assert.ok(row.access_expires_at > now());
  lapse();
  await session(relative);
  assert.equal(env.DB.sqlite.prepare("SELECT COUNT(*) AS n FROM oidc_server_sessions").get().n, 0);
});
