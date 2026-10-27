import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { createServerAppSession } from "@cloud/app-session.ts";
import {
  oidcDatabase,
  randomSecret,
  sealServerSecret,
  secretHash,
  serverSessionContext,
  serverSessionId,
  SERVER_SESSION_COOKIE,
} from "@cloud/oidc-session-store.ts";
import { handleOAuth, mcpAuthChallenge } from "./oauth.mjs";
import { readAccessToken } from "./oauth-store.mjs";

class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
  }
  prepare(sql) {
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => this.sqlite.prepare(sql).get(...values) ?? null,
      run: async () => ({
        success: true,
        meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) },
      }),
      execute: () => ({
        success: true,
        meta: { changes: Number(this.sqlite.prepare(sql).run(...values).changes) },
      }),
    });
    return build();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((s) => s.execute());
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
const origin = "https://page7.example";
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const metadataUrl = "https://chatgpt.com/oauth/client.json";
const verifier = "v".repeat(43);
function fixture(t, extra = {}) {
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "oauth-fixture-secret-".repeat(3),
    DB: new SqliteD1(),
    ...extra,
  };
  t.after(() => env.DB.sqlite.close());
  return env;
}
async function session(
  env,
  {
    principal = "user:anaconda:person",
    displayName = "Example Person",
    expiresAt = Math.floor(Date.now() / 1000) + 3600,
  } = {},
) {
  await oidcDatabase(env);
  const now = Math.floor(Date.now() / 1000);
  const token = randomSecret(),
    id = await serverSessionId(env, token);
  const context = serverSessionContext(env, env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN);
  const app = await createServerAppSession(
    env,
    { principal, metadata: { provider: "oidc", principalNamespace: "user:anaconda", displayName } },
    id,
    expiresAt,
    now,
  );
  const sealed = await sealServerSecret(env, {}, `session:${id}:${context}`);
  await env.DB.prepare(
    "INSERT INTO oidc_server_sessions (id,context,session_json,sealed,access_expires_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(id, context, JSON.stringify(app), sealed, expiresAt, now + 7200, now + 86400)
    .run();
  return { id, cookie: `${SERVER_SESSION_COOKIE}=${token}` };
}
async function authorization(env, overrides = {}) {
  return new URLSearchParams({
    client_id: "pages-chatgpt",
    redirect_uri: callback,
    response_type: "code",
    resource: env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN + "/mcp",
    code_challenge: await secretHash(verifier),
    code_challenge_method: "S256",
    scope: "pages:read pages:write offline_access",
    state: "client-state",
    ...overrides,
  });
}
function get(path, cookie, headers = {}) {
  return new Request("http://127.0.0.1:9477" + path, {
    headers: { ...(cookie ? { cookie } : {}), ...headers },
  });
}
function post(path, fields, headers = {}) {
  return new Request("http://127.0.0.1:9477" + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
  });
}
async function consent(env, login, overrides = {}) {
  const result = await handleOAuth(
    get("/oauth/authorize?" + (await authorization(env, overrides)), login.cookie),
    env,
  );
  assert.equal(result.status, 200, await result.clone().text());
  const text = await result.text();
  const fields = Object.fromEntries(
    ["consent_id", "csrf_token"].map((name) => [
      name,
      text.match(new RegExp(`name="${name}" value="([^"]+)"`))?.[1],
    ]),
  );
  assert.ok(fields.consent_id && fields.csrf_token);
  return { result, text, fields: { ...fields, decision: "approve" } };
}
function approve(env, login, fields, headers = {}) {
  return handleOAuth(
    post("/oauth/authorize", fields, {
      Origin: env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN,
      Cookie: login.cookie,
      ...headers,
    }),
    env,
  );
}
async function code(env, login, overrides = {}) {
  const screen = await consent(env, login, overrides);
  const result = await approve(env, login, screen.fields);
  assert.equal(result.status, 303, await result.clone().text());
  const url = new URL(result.headers.get("location"));
  assert.equal(url.searchParams.get("iss"), env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN);
  assert.equal(url.searchParams.get("state"), "client-state");
  assert.ok(url.searchParams.get("code"), url.href);
  return url.searchParams.get("code");
}
function exchange(env, authorizationCode, overrides = {}) {
  return handleOAuth(
    post("/oauth/token", {
      grant_type: "authorization_code",
      client_id: "pages-chatgpt",
      redirect_uri: callback,
      resource: env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN + "/mcp",
      code_verifier: verifier,
      code: authorizationCode,
      ...overrides,
    }),
    env,
  );
}
function metadata(extra = {}) {
  return {
    client_id: metadataUrl,
    client_name: "ChatGPT",
    redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "private_key_jwt",
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
    ...extra,
  };
}

test("metadata and challenge use configured public origin; unknown OAuth routes fail closed", async (t) => {
  const env = fixture(t);
  const prm = await handleOAuth(
    get("/.well-known/oauth-protected-resource/mcp", null, {
      Host: "evil.example",
      "X-Forwarded-Host": "evil.example",
    }),
    env,
  );
  assert.equal(prm.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(await prm.json(), {
    resource: origin + "/mcp",
    authorization_servers: [origin],
    scopes_supported: ["pages:read", "pages:write"],
    bearer_methods_supported: ["header"],
    resource_name: "Pages",
    resource_documentation: origin + "/connect",
  });
  const as = await (await handleOAuth(get("/.well-known/oauth-authorization-server"), env)).json();
  assert.equal(as.issuer, origin);
  assert.deepEqual(as.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(as.code_challenge_methods_supported, ["S256"]);
  assert.ok(as.scopes_supported.includes("offline_access"));
  assert.equal(as.registration_endpoint, undefined);
  assert.equal(as.authorization_response_iss_parameter_supported, true);
  const challenged = mcpAuthChallenge(env, new Response("sign in", { status: 401 }));
  assert.match(
    challenged.headers.get("www-authenticate"),
    /^Bearer resource_metadata="https:\/\/page7.example\//,
  );
  const forbidden = new Response(null, { status: 403 });
  assert.equal(mcpAuthChallenge(env, forbidden), forbidden);
  assert.equal((await handleOAuth(get("/oauth/register"), env)).status, 404);
  assert.equal(
    (await handleOAuth(get("/.well-known/oauth-protected-resource/wrong"), env)).status,
    404,
  );
  assert.equal(await handleOAuth(get("/unrelated"), {}), null);
});

test("cross-site authorization first renders a same-origin sign-in link; no automatic provider login", async (t) => {
  const env = fixture(t);
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected provider request");
  });
  const params = await authorization(env);
  const result = await handleOAuth(
    get("/oauth/authorize?" + params, null, { "Sec-Fetch-Site": "cross-site" }),
    env,
  );
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("location"), null);
  assert.equal(
    result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
    "'self'",
  );
  const text = await result.text();
  assert.match(text, />Sign In<\/a>/);
  assert.doesNotMatch(text, /<form/);
  const link = text.match(/href="(\/api\/auth\/login\?[^"]+)"/)[1].replaceAll("&amp;", "&");
  assert.equal(new URL(link, origin).searchParams.get("return_to"), "/oauth/authorize?" + params);
});

test("explicit consent escapes identity, grants only Pages tokens, rotates, narrows and revokes", async (t) => {
  const env = fixture(t),
    login = await session(env, { displayName: "<img src=x onerror=alert(1)>" });
  const screen = await consent(env, login);
  assert.match(screen.text, /&lt;img/);
  assert.doesNotMatch(screen.text, /<img/);
  assert.match(screen.text, /delete Pages you own/);
  assert.match(screen.text, /Your Anaconda password and API key are not shared/);
  assert.equal(screen.result.headers.get("referrer-policy"), "same-origin");
  assert.match(screen.result.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.equal(
    screen.result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
    "'self' " + callback,
  );
  assert.match(screen.result.headers.get("set-cookie"), /Secure/);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_codes").get().n, 0);
  const result = await approve(env, login, screen.fields),
    redirect = new URL(result.headers.get("location"));
  assert.equal(redirect.searchParams.get("state"), "client-state");
  assert.equal(redirect.searchParams.get("iss"), origin);
  const tokensResponse = await exchange(env, redirect.searchParams.get("code"));
  assert.equal(tokensResponse.status, 200);
  const tokens = await tokensResponse.json();
  assert.match(tokens.access_token, /^pages_at_/);
  assert.match(tokens.refresh_token, /^pages_rt_/);
  assert.equal(tokens.expires_in, 600);
  assert.equal(
    (await readAccessToken(env, tokens.access_token, { resource: origin + "/mcp" })).identity
      .principal,
    "user:anaconda:person",
  );
  const rotated = await handleOAuth(
    post("/oauth/token", {
      grant_type: "refresh_token",
      client_id: "pages-chatgpt",
      resource: origin + "/mcp",
      refresh_token: tokens.refresh_token,
      scope: "pages:read offline_access",
    }),
    env,
  );
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.equal(next.scope, "offline_access pages:read");
  const revoked = await handleOAuth(
    post("/oauth/revoke", { client_id: "pages-chatgpt", token: next.refresh_token }),
    env,
  );
  assert.equal(revoked.status, 200);
  assert.equal(await readAccessToken(env, next.access_token, { resource: origin + "/mcp" }), null);
  assert.equal(
    await readAccessToken(env, tokens.access_token, { resource: origin + "/mcp" }),
    null,
  );
});

test("consent requires exact Origin, session, account, CSRF and immutable request; replay fails", async (t) => {
  const env = fixture(t),
    login = await session(env),
    otherLogin = await session(env),
    otherAccount = await session(env, { principal: "user:anaconda:other" });
  const screen = await consent(env, login, { scope: "pages:read" });
  for (const headers of [
    { Origin: "https://evil.example" },
    { Origin: "null" },
    { Origin: "" },
    { "Sec-Fetch-Site": "cross-site" },
  ])
    assert.equal((await approve(env, login, screen.fields, headers)).status, 403);
  for (const actor of [otherLogin, otherAccount])
    assert.equal((await approve(env, actor, screen.fields)).status, 403);
  const csrf = await approve(env, login, { ...screen.fields, csrf_token: "x".repeat(43) });
  assert.equal(csrf.status, 403);
  assert.ok(csrf.headers.get("set-cookie"));
  assert.equal((await approve(env, login, { ...screen.fields, scope: "pages:write" })).status, 400);
  const ok = await approve(env, login, screen.fields);
  assert.equal(ok.status, 303);
  const tokens = await (
    await exchange(env, new URL(ok.headers.get("location")).searchParams.get("code"))
  ).json();
  assert.equal(tokens.scope, "pages:read");
  assert.equal(tokens.refresh_token, undefined);
  assert.equal((await approve(env, login, screen.fields)).status, 403);
});

test("cancel returns a bound error with issuer and state without granting a code", async (t) => {
  const env = fixture(t),
    login = await session(env),
    screen = await consent(env, login);
  const result = await approve(env, login, { ...screen.fields, decision: "cancel" });
  const url = new URL(result.headers.get("location"));
  assert.equal(url.searchParams.get("error"), "access_denied");
  assert.equal(url.searchParams.get("state"), "client-state");
  assert.equal(url.searchParams.get("iss"), origin);
  assert.equal(url.searchParams.get("code"), null);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_codes").get().n, 0);
  assert.equal((await approve(env, login, screen.fields)).status, 403);
});

test("codes enforce S256, client, callback, resource and one-use; no confidential-client fallback", async (t) => {
  const env = fixture(t),
    login = await session(env),
    value = await code(env, login);
  for (const invalid of [
    { code_verifier: "bad" },
    { code_verifier: "x".repeat(43) },
    { resource: "https://evil.example/mcp" },
    { client_id: metadataUrl },
    { redirect_uri: "https://evil.example/callback" },
    { client_secret: "secret" },
  ]) {
    const result = await exchange(env, value, invalid);
    assert.equal(result.status, 400);
    assert.ok((await result.json()).error);
  }
  assert.equal((await exchange(env, value)).status, 200);
  assert.equal((await exchange(env, value)).status, 400);
});

test("CIMD fetches only the exact trusted URL, accepts none intersection, rejects arbitrary URLs before fetch", async (t) => {
  const env = fixture(t),
    login = await session(env);
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json(metadata(), { headers: { "Cache-Control": "no-store" } });
  });
  const screen = await consent(env, login, { client_id: metadataUrl, scope: "pages:write" });
  assert.match(screen.text, /Read the Pages/);
  assert.match(screen.text, /Create Pages/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, metadataUrl);
  assert.equal(calls[0].options.redirect, "manual");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  for (const client_id of [
    "http://127.0.0.1/private",
    "https://chatgpt.com/oauth/client.json?x=1",
    "https://evil.example/metadata.json",
  ]) {
    const result = await handleOAuth(
      get("/oauth/authorize?" + (await authorization(env, { client_id })), login.cookie),
      env,
    );
    assert.equal(result.status, 400);
    assert.equal(result.headers.get("location"), null);
  }
  assert.equal(calls.length, 1);
});

test("CIMD failures, redirects, oversized JSON and incompatible metadata fail closed", async (t) => {
  const env = fixture(t),
    login = await session(env);
  let fetched;
  t.mock.method(globalThis, "fetch", async () => fetched);
  const failures = [
    new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/private" } }),
    new Response("x".repeat(16385), { headers: { "Content-Type": "application/json" } }),
    Response.json(metadata({ client_id: "other" })),
    Response.json(metadata({ redirect_uris: ["https://evil.example"] })),
    Response.json(metadata({ token_endpoint_auth_methods_supported: ["private_key_jwt"] })),
    Response.json(metadata({ response_types: "code" })),
  ];
  for (const failure of failures) {
    fetched = failure;
    const result = await handleOAuth(
      get(
        "/oauth/authorize?" + (await authorization(env, { client_id: metadataUrl })),
        login.cookie,
      ),
      env,
    );
    assert.ok(result.status >= 400);
    assert.equal(result.headers.get("location"), null);
  }
});

test("expired sign-in cannot authorize; logout invalidates pending consent", async (t) => {
  const env = fixture(t),
    expired = await session(env, { expiresAt: Math.floor(Date.now() / 1000) - 1 });
  const result = await handleOAuth(
    get("/oauth/authorize?" + (await authorization(env)), expired.cookie),
    env,
  );
  assert.equal(result.status, 200);
  assert.match(await result.text(), />Sign In<\/a>/);
  assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
  const login = await session(env),
    screen = await consent(env, login);
  await env.DB.prepare("DELETE FROM oidc_server_sessions WHERE id = ?").bind(login.id).run();
  assert.equal((await approve(env, login, screen.fields)).status, 401);
});

test("local client requires both fixture flags and loopback configured origin", async (t) => {
  for (const extra of [
    {},
    { PAGES_E2E_ONLY: "true", NOTEBOOK_CLOUD_LOCAL_OIDC: "true" },
    { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://127.0.0.1:9467", PAGES_E2E_ONLY: "true" },
  ]) {
    const env = fixture(t, extra);
    const result = await handleOAuth(
      get(
        "/oauth/authorize?" +
          (await authorization(env, {
            client_id: "pages-local-e2e",
            redirect_uri: env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN + "/oauth/test/callback",
          })),
      ),
      env,
    );
    assert.equal(result.status, 400);
  }
  const env = fixture(t, {
      NOTEBOOK_CLOUD_PUBLIC_ORIGIN: "http://127.0.0.1:9467",
      PAGES_E2E_ONLY: "true",
      NOTEBOOK_CLOUD_LOCAL_OIDC: "true",
    }),
    login = await session(env);
  const screen = await consent(env, login, {
    client_id: "pages-local-e2e",
    redirect_uri: env.NOTEBOOK_CLOUD_PUBLIC_ORIGIN + "/oauth/test/callback",
  });
  assert.equal(
    screen.result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
    "'self'",
  );
  const result = await approve(env, login, screen.fields);
  assert.equal(new URL(result.headers.get("location")).pathname, "/oauth/test/callback");
});

test("validated authorization errors redirect safely; duplicates, invalid callbacks and unbounded inputs do not", async (t) => {
  const env = fixture(t);
  for (const invalid of [
    { response_type: "token" },
    { scope: "admin" },
    { scope: "offline_access" },
    { code_challenge_method: "plain" },
    { code_challenge: "bad" },
    { resource: "https://evil.example/mcp" },
    { response_mode: "form_post" },
  ]) {
    const result = await handleOAuth(
      get("/oauth/authorize?" + (await authorization(env, invalid))),
      env,
    );
    assert.equal(result.status, 303);
    const url = new URL(result.headers.get("location"));
    assert.equal(url.origin + url.pathname, callback);
    assert.ok(url.searchParams.get("error"));
    assert.equal(url.searchParams.get("iss"), origin);
    assert.equal(url.searchParams.get("state"), "client-state");
  }
  const duplicate = await authorization(env);
  duplicate.append("resource", origin + "/mcp");
  for (const params of [
    duplicate,
    await authorization(env, { redirect_uri: "https://evil.example" }),
    await authorization(env, { state: "x".repeat(17000) }),
  ]) {
    const result = await handleOAuth(get("/oauth/authorize?" + params), env);
    assert.equal(result.status, 400);
    assert.equal(result.headers.get("location"), null);
  }
  assert.equal((await handleOAuth(get("/oauth/token"), env)).status, 405);
  const huge = await handleOAuth(post("/oauth/token", { value: "x".repeat(16385) }), env);
  assert.equal(huge.status, 400);
  const duplicateBody = await handleOAuth(
    post("/oauth/token", new URLSearchParams("client_id=pages-chatgpt&client_id=pages-chatgpt")),
    env,
  );
  assert.equal(duplicateBody.status, 400);
  const wrongType = await handleOAuth(
    new Request(origin + "/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }),
    env,
  );
  assert.equal(wrongType.status, 400);
  const unsupported = await handleOAuth(
    post("/oauth/token", {
      grant_type: "password",
      client_id: "pages-chatgpt",
      resource: origin + "/mcp",
    }),
    env,
  );
  assert.equal((await unsupported.json()).error, "unsupported_grant_type");
});

test("code issuance failure returns a bound OAuth error and preserves the renewed session cookie", async (t) => {
  const env = fixture(t),
    login = await session(env),
    screen = await consent(env, login);
  const prepare = env.DB.prepare.bind(env.DB);
  t.mock.method(env.DB, "prepare", (sql) => {
    if (sql.includes("INSERT INTO pages_oauth_codes"))
      throw new Error("injected code storage failure");
    return prepare(sql);
  });
  const result = await approve(env, login, screen.fields);
  assert.equal(result.status, 303);
  const url = new URL(result.headers.get("location"));
  assert.equal(url.origin + url.pathname, callback);
  assert.equal(url.searchParams.get("error"), "server_error");
  assert.equal(url.searchParams.get("state"), "client-state");
  assert.equal(url.searchParams.get("iss"), origin);
  assert.doesNotMatch(url.href, /injected/);
  assert.ok(result.headers.get("set-cookie"));
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_codes").get().n, 0);
  assert.equal((await approve(env, login, screen.fields)).status, 403);
});

test("successful CIMD validation is cached briefly, honors cache directives, coalesces and never retains failures", async (t) => {
  const env = fixture(t);
  let now = Date.now(),
    calls = 0,
    headers = {},
    value = metadata(),
    status = 200,
    gate;
  t.mock.method(Date, "now", () => now);
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    if (gate) await gate;
    return Response.json(value, { status, headers });
  });
  const request = await authorization(env, { client_id: metadataUrl });
  const perform = () => handleOAuth(get("/oauth/authorize?" + request), env);
  for (const directive of [
    "no-store, max-age=300",
    "no-cache, max-age=300",
    'no-cache="Set-Cookie", max-age=300',
    "private, max-age=300",
    "max-age=0",
    "max-age=abc",
    "max-age=10, max-age=300",
  ]) {
    now += 1_000_000;
    headers = { "Cache-Control": directive };
    const before = calls;
    assert.equal((await perform()).status, 200);
    assert.equal((await perform()).status, 200);
    assert.equal(calls - before, 2, directive);
  }
  for (const [cacheHeaders, seconds] of [
    [{}, 60],
    [{ "Cache-Control": "max-age=900" }, 300],
    [{ "Cache-Control": 'max-age="10"', Age: "3" }, 7],
    [
      { "Cache-Control": "max-age=100", Date: new Date(now + 1_000_000 - 80_000).toUTCString() },
      20,
    ],
  ]) {
    now += 1_000_000;
    // Construct Date relative to the current request, not prior test cases.
    headers = cacheHeaders.Date
      ? { ...cacheHeaders, Date: new Date(now - 80_000).toUTCString() }
      : cacheHeaders;
    const before = calls;
    assert.equal((await perform()).status, 200);
    now += seconds * 1000 - 1000;
    assert.equal((await perform()).status, 200);
    assert.equal(calls - before, 1);
    now += 1000;
    assert.equal((await perform()).status, 200);
    assert.equal(calls - before, 2);
  }
  now += 1_000_000;
  headers = { "Cache-Control": "max-age=300" };
  value = metadata({ client_id: "unexpected" });
  const beforeInvalid = calls;
  assert.equal((await perform()).status, 400);
  assert.equal((await perform()).status, 400);
  assert.equal(calls - beforeInvalid, 2);
  value = metadata();
  status = 503;
  assert.equal((await perform()).status, 503);
  assert.equal((await perform()).status, 503);
  assert.equal(calls - beforeInvalid, 4);

  status = 200;
  headers = { "Cache-Control": "no-store" };
  let release;
  gate = new Promise((resolve) => {
    release = resolve;
  });
  const beforeParallel = calls;
  const one = perform(),
    two = perform(),
    three = perform();
  await new Promise(setImmediate);
  assert.equal(calls - beforeParallel, 1);
  release();
  assert.deepEqual(
    (await Promise.all([one, two, three])).map((result) => result.status),
    [200, 200, 200],
  );
  gate = undefined;
  assert.equal((await perform()).status, 200);
  assert.equal(calls - beforeParallel, 2);

  // Even a warm validation cache cannot admit another client or callback.
  headers = { "Cache-Control": "max-age=300" };
  assert.equal((await perform()).status, 200);
  const beforeUnknown = calls;
  for (const invalid of [
    { client_id: "https://evil.example/client.json" },
    { redirect_uri: "https://chatgpt.com/unregistered" },
  ]) {
    const result = await handleOAuth(
      get("/oauth/authorize?" + (await authorization(env, { client_id: metadataUrl, ...invalid }))),
      env,
    );
    assert.equal(result.status, 400);
    assert.equal(result.headers.get("location"), null);
  }
  assert.equal(calls, beforeUnknown);
  // Leave the isolate cache expired for any later tests.
  now += 1_000_000;
  status = 503;
  assert.equal((await perform()).status, 503);
});
