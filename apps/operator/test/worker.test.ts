import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createLocalOidcIssuer } from "../../../packages/local-oidc/src/index.ts";
import worker from "../src/worker.ts";
import { requireAllowedIdentity, type OperatorEnvironment } from "../src/auth.ts";
import { SERVER_SESSION_COOKIE } from "../../notebook-cloud/src/oidc-session-store.ts";
import { SqliteD1 } from "./sqlite.ts";

const ORIGIN = "https://deploy.example.test";
async function fixture(t: TestContext, email = "operator.one@example.test") {
  const db = new SqliteD1();
  t.after(() => db.sqlite.close());
  const issuerUrl = `https://issuer-${crypto.randomUUID()}.example.test`;
  const issuer = createLocalOidcIssuer({
    issuerUrl,
    clientId: "operator-test",
    audience: "operator-api",
    users: { sub: "operator", email, name: "Operator" },
    allowRedirectUri: (uri) => uri === `${ORIGIN}/oidc`,
    defaultTokenTtlSeconds: 3600,
  });
  const env: OperatorEnvironment = {
    DB: db,
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: ORIGIN,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: issuerUrl,
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "operator-test",
    NOTEBOOK_CLOUD_OIDC_AUDIENCE: "operator-api",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "operator-test",
    NOTEBOOK_CLOUD_OIDC_JWKS_JSON: JSON.stringify(await issuer.jwks()),
    NOTEBOOK_CLOUD_OIDC_TOKEN_AUTH_METHOD: "none",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "test-only-operator-session-secret-32-bytes",
    OPERATOR_ALLOWED_EMAILS: "operator.one@example.test,operator.two@example.test",
  };
  const calls: Request[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin === issuerUrl) return issuer.handle(request);
    assert.equal(new URL(request.url).origin, "http://127.0.0.1:9464");
    calls.push(request);
    return Response.json(
      { schema: 1, marker: "only aggregate metrics" },
      { headers: { "Set-Cookie": "must-not-forward=secret" } },
    );
  });
  const request = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(`${ORIGIN}${path}`, init), env);
  const login = async () => {
    const start = await request("/api/auth/oidc/login?return_to=https://evil.test");
    assert.equal(start.status, 302);
    const authorization = await issuer.handle(new Request(start.headers.get("Location")!));
    assert.ok(authorization);
    const callback = await worker.fetch(
      new Request(authorization.headers.get("Location")!, {
        headers: { cookie: start.headers.get("Set-Cookie")!.split(";")[0] },
      }),
      env,
    );
    return {
      callback,
      cookie: callback.headers
        .getSetCookie()
        .find((c) => c.startsWith(`${SERVER_SESSION_COOKIE}=`))
        ?.split(";")[0],
    };
  };
  return { env, db, calls, request, login };
}

test("server OIDC login with SQLite permits both exact verified emails and strips upstream headers", async (t) => {
  for (const email of ["operator.one@example.test", "operator.two@example.test"]) {
    await t.test(email, async (t) => {
      const f = await fixture(t, email),
        { callback, cookie } = await f.login();
      assert.equal(callback.status, 303);
      assert.equal(callback.headers.get("Location"), "/operator/");
      assert.ok(cookie);
      const response = await f.request("/api/operator/metrics?hours=24", {
        headers: { cookie, authorization: "do-not-forward", "x-secret": "private" },
      });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Set-Cookie"), null);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0].headers.get("cookie"), null);
      assert.equal(f.calls[0].headers.get("authorization"), null);
      assert.equal(f.calls[0].method, "GET");
      assert.equal((await response.json()).schema, 1);
    });
  }
});
test("unauthenticated, forged header, bearer and cookie requests never read metrics", async (t) => {
  const f = await fixture(t);
  const requests: Record<string, string>[] = [
    {},
    { "cf-access-authenticated-user-email": "operator.one@example.test" },
    { authorization: "Bearer forged" },
    { cookie: `${SERVER_SESSION_COOKIE}=forged` },
  ];
  for (const headers of requests) {
    const response = await f.request("/api/operator/metrics", { headers });
    assert.equal(response.status, 401);
  }
  assert.equal(f.calls.length, 0);
});
test("same-domain and lookalike accounts cannot create operator sessions", async (t) => {
  for (const email of [
    "someone@example.test",
    "operator.one+other@example.test",
    "operator.one@example.test.evil.test",
  ])
    await t.test(email, async (t) => {
      const f = await fixture(t, email),
        { callback, cookie } = await f.login();
      assert.notEqual(callback.status, 303);
      assert.equal(cookie, undefined);
      assert.equal(
        f.db.sqlite.prepare("SELECT count(*) AS n FROM oidc_server_sessions").get()!.n,
        0,
      );
    });
});
test("safelist removal and expired proof revoke data access without waiting for login", async (t) => {
  const f = await fixture(t),
    { cookie } = await f.login();
  assert.ok(cookie);
  f.env.OPERATOR_ALLOWED_EMAILS = "operator.two@example.test";
  assert.equal((await f.request("/api/operator/metrics", { headers: { cookie } })).status, 403);
  f.env.OPERATOR_ALLOWED_EMAILS = "operator.one@example.test";
  f.db.sqlite.exec("UPDATE oidc_server_sessions SET access_expires_at = 0");
  assert.equal((await f.request("/api/operator/metrics", { headers: { cookie } })).status, 401);
  assert.equal(f.calls.length, 0);
});
test("query bounds, route allowlist and method gate protect the local read interface", async (t) => {
  const f = await fixture(t),
    { cookie } = await f.login();
  assert.ok(cookie);
  for (const query of [
    "hours=999",
    "hours=1&hours=24",
    "preview=../../state",
    "url=http://169.254.169.254/",
    "sql=SELECT",
  ]) {
    assert.equal(
      (await f.request(`/api/operator/metrics?${query}`, { headers: { cookie } })).status,
      400,
    );
  }
  for (const route of [
    "/deploy",
    "/status",
    "/authorize",
    "/state",
    "/api/operator/unknown",
    "/operator/assets/../../worker.js",
  ]) {
    assert.equal((await f.request(route, { headers: { cookie } })).status, 404);
    assert.equal((await f.request(route, { method: "POST", headers: { cookie } })).status, 405);
  }
  assert.equal(f.calls.length, 0);
});
test("removing a safelisted identity in the refresh window revokes its session", async (t) => {
  const f = await fixture(t),
    { cookie } = await f.login();
  assert.ok(cookie);
  f.env.OPERATOR_ALLOWED_EMAILS = "replacement@example.test";
  f.db.sqlite
    .prepare("UPDATE oidc_server_sessions SET access_expires_at = ?")
    .run(Math.floor(Date.now() / 1000) + 60);
  const response = await f.request("/api/operator/session", { headers: { cookie } });
  assert.equal(response.status, 403);
  assert.match(response.headers.get("Set-Cookie") ?? "", /Max-Age=0/);
  assert.equal(f.db.sqlite.prepare("SELECT count(*) AS n FROM oidc_server_sessions").get()!.n, 0);
  assert.equal((await f.request("/api/operator/metrics", { headers: { cookie } })).status, 401);
  assert.equal(f.calls.length, 0);
});
test("cross-site top-level navigation reaches the login landing page but never APIs or assets", async (t) => {
  const f = await fixture(t);
  f.env.ASSETS = {
    async fetch() {
      return new Response("shell");
    },
  };
  const headers = {
    "Sec-Fetch-Site": "cross-site",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Dest": "document",
  };
  for (const path of ["/", "/operator", "/operator/"])
    assert.equal((await f.request(path, { headers })).status, path === "/operator/" ? 200 : 302);
  for (const path of [
    "/api/operator/metrics",
    "/api/operator/export.csv",
    "/api/operator/session",
    "/operator/assets/index-abc.js",
  ])
    assert.equal((await f.request(path, { headers })).status, 403);
  assert.equal(
    (await f.request("/operator/", { headers: { ...headers, "Sec-Fetch-Dest": "iframe" } })).status,
    403,
  );
  assert.equal(f.calls.length, 0);
});
test("origin protection, logout and configuration fail closed", async (t) => {
  const f = await fixture(t),
    { cookie } = await f.login();
  assert.ok(cookie);
  assert.equal(
    (await f.request("/api/operator/metrics", { headers: { cookie, Origin: "https://evil.test" } }))
      .status,
    403,
  );
  assert.equal(
    (await f.request("/api/operator/session", { method: "DELETE", headers: { cookie } })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/operator/session", {
        method: "DELETE",
        headers: { cookie, Origin: ORIGIN },
      })
    ).status,
    200,
  );
  assert.equal((await f.request("/api/operator/metrics", { headers: { cookie } })).status, 401);
  f.env.NOTEBOOK_CLOUD_LOCAL_OIDC = "true";
  assert.equal((await f.request("/operator/")).status, 503);
  delete f.env.NOTEBOOK_CLOUD_LOCAL_OIDC;
  delete f.env.OPERATOR_ALLOWED_EMAILS;
  assert.equal((await f.request("/")).status, 503);
});

test("static shell avoids index.html canonical redirects; unknown assets cannot expose worker files", async (t) => {
  const f = await fixture(t);
  const assets: string[] = [];
  f.env.ASSETS = {
    async fetch(request) {
      assets.push(new URL(request.url).pathname);
      return new Response("shell");
    },
  };
  assert.equal((await f.request("/operator/")).status, 200);
  assert.equal((await f.request("/operator/assets/index-abc.js")).status, 200);
  assert.deepEqual(assets, ["/", "/assets/index-abc.js"]);
  assert.equal((await f.request("/operator/worker.js")).status, 404);
  assert.equal((await f.request("/dev/oidc/authorize")).status, 404);
});

test("unverified email and non-OIDC identity cannot pass the login hook", async (t) => {
  const f = await fixture(t);
  const identity = {
    principal: "test",
    operator: "test",
    actorLabel: "test",
    scope: "viewer" as const,
    metadata: {
      provider: "oidc" as const,
      transport: "oidc-bearer" as const,
      principalNamespace: "test",
      email: "operator.one@example.test",
      emailVerified: false,
    },
  };
  assert.throws(() => requireAllowedIdentity(f.env, identity));
  assert.throws(() =>
    requireAllowedIdentity(f.env, {
      ...identity,
      metadata: { ...identity.metadata, provider: "dev", emailVerified: true },
    }),
  );
});
