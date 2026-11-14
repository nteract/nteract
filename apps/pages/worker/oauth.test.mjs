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
import { metadataFetchTimeouts } from "./oauth-clients.mjs";
import { FAVICON_LINK } from "../shared/favicon.mjs";
import { readAccessToken } from "./oauth-store.mjs";

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
const origin = "https://page10.example";
const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
const kiloCallback = "http://127.0.0.1:19876/mcp/oauth/callback";
const metadataUrl = "https://chatgpt.com/oauth/client.json";
const claude = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const claudeCallback = "https://claude.ai/api/mcp/auth_callback";
const claudeCode = "https://claude.ai/oauth/claude-code-client-metadata";
// The documents Anthropic publishes at those two client ids.
const claudeDocument = {
  client_id: claude,
  client_name: "Claude",
  client_uri: "https://claude.ai",
  redirect_uris: [claudeCallback],
  grant_types: [
    "authorization_code",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  ],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const claudeCodeDocument = {
  client_id: claudeCode,
  client_name: "Claude Code",
  client_uri: "https://claude.ai",
  redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const verifier = "v".repeat(43);

/** Answer metadata fetches from `documents`, uncached, and record each one. */
function serve(t, documents) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return documents[url]
      ? Response.json(documents[url], { headers: { "Cache-Control": "no-store" } })
      : new Response(null, { status: 404 });
  });
  return calls;
}
function fixture(t, extra = {}) {
  const env = {
    PAGES_OAUTH_METADATA_EGRESS: "public-https",
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
    scope: "pages:read pages:write",
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
  assert.ok(text.includes(FAVICON_LINK), "the consent page carries the inlined tab icon");
  assert.match(result.headers.get("content-security-policy"), / img-src data:; /);
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
    scopes_supported: ["pages:read", "pages:write", "pages:share"],
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
    /^Bearer resource_metadata="https:\/\/page10.example\//,
  );
  assert.doesNotMatch(challenged.headers.get("www-authenticate"), /scope=/);
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
  assert.match(text, />Sign in<\/a>/);
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
  assert.match(screen.text, /Keep this connection active for up to 30 days/);
  assert.match(screen.text, /Your Anaconda password and API key are not shared/);
  assert.match(screen.text, /<script src="\/theme[.]js"><\/script>/);
  assert.ok(screen.text.indexOf("/theme.js") < screen.text.indexOf("/app.css"));
  assert.match(screen.result.headers.get("content-security-policy"), /script-src 'self';/);
  assert.doesNotMatch(
    screen.result.headers.get("content-security-policy"),
    /unsafe-inline|unsafe-eval/,
  );
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
  assert.equal(tokens.scope, "pages:read pages:write");
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
      scope: "pages:read",
    }),
    env,
  );
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.equal(next.scope, "pages:read");
  assert.match(next.refresh_token, /^pages_rt_/);
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
  assert.equal((await approve(env, login, { ...screen.fields, allowRefresh: "true" })).status, 400);
  const ok = await approve(env, login, screen.fields);
  assert.equal(ok.status, 303);
  const tokens = await (
    await exchange(env, new URL(ok.headers.get("location")).searchParams.get("code"))
  ).json();
  assert.equal(tokens.scope, "pages:read");
  assert.match(tokens.refresh_token, /^pages_rt_/);
  assert.equal((await approve(env, login, screen.fields)).status, 403);
});

test("pre-update pending consent keeps its original refresh permission when approved after deployment", async (t) => {
  const env = fixture(t),
    login = await session(env);
  for (const scope of ["pages:read", "pages:read offline_access"]) {
    const screen = await consent(env, login, { scope });
    // Model an outstanding pre-update consent, whose immutable request did not
    // record the new persistent-connection disclosure.
    const hash = await secretHash(screen.fields.consent_id);
    const row = env.DB.sqlite
      .prepare("SELECT request_json FROM pages_oauth_consents WHERE id_hash = ?")
      .get(hash);
    const saved = JSON.parse(row.request_json);
    assert.equal(saved.allowRefresh, true);
    delete saved.allowRefresh;
    env.DB.sqlite
      .prepare("UPDATE pages_oauth_consents SET request_json = ? WHERE id_hash = ?")
      .run(JSON.stringify(saved), hash);
    const approved = await approve(env, login, screen.fields);
    assert.equal(approved.status, 303);
    const code = new URL(approved.headers.get("location")).searchParams.get("code");
    const tokens = await (await exchange(env, code)).json();
    assert.equal(tokens.scope, scope.split(" ").sort().join(" "));
    assert.equal(
      typeof tokens.refresh_token,
      scope.includes("offline_access") ? "string" : "undefined",
    );
    const grant = env.DB.sqlite
      .prepare("SELECT expires_at FROM pages_oauth_grants ORDER BY expires_at DESC")
      .get();
    const remaining = grant.expires_at - Math.floor(Date.now() / 1000);
    assert.ok(scope.includes("offline_access") ? remaining > 29 * 86400 : remaining <= 600);
  }
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

test("a metadata-document client is fetched only for a signed-in person, and never when its id is malformed", async (t) => {
  const env = fixture(t),
    login = await session(env);
  const calls = serve(t, { [metadataUrl]: metadata(), [claude]: claudeDocument });
  // Signed out: the request names no client yet and nothing is fetched.
  for (const client_id of [metadataUrl, claude, "https://stranger.example/client.json"]) {
    const params = await authorization(env, {
      client_id,
      redirect_uri: "https://stranger.example",
    });
    const result = await handleOAuth(get("/oauth/authorize?" + params), env);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("location"), null);
    assert.equal(
      result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
      "'self'",
    );
    const text = await result.text();
    assert.match(text, /<h1>Connect an app<\/h1>/);
    // Outside the sign-in link's return address, the page names no client.
    assert.doesNotMatch(text.replace(/href="[^"]+"/g, ""), /stranger|claude|ChatGPT|<form/i);
    const link = text.match(/href="(\/api\/auth\/login\?[^"]+)"/)[1].replaceAll("&amp;", "&");
    assert.equal(new URL(link, origin).searchParams.get("return_to"), "/oauth/authorize?" + params);
  }
  assert.equal(calls.length, 0);
  // Signed in: the document at the exact client id is fetched, once.
  const screen = await consent(env, login, { client_id: metadataUrl, scope: "pages:write" });
  assert.match(screen.text, /<h1>Connect ChatGPT to Pages<\/h1>/);
  assert.match(screen.text, /Read the Pages/);
  assert.match(screen.text, /Create Pages/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, metadataUrl);
  assert.equal(calls[0].options.redirect, "manual");
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  for (const client_id of [
    "http://127.0.0.1/private",
    "https://127.0.0.1/private",
    "https://169.254.169.254/latest/meta-data",
    "https://localhost/client.json",
    "https://metadata.google.internal/client.json",
    "https://chatgpt.com/oauth/client.json?x=1",
    "https://chatgpt.com:8443/oauth/client.json",
    "https://chatgpt.com/",
    "https://page10.example/assets/client.json",
    "unregistered",
  ])
    for (const cookie of [login.cookie, null]) {
      const result = await handleOAuth(
        get("/oauth/authorize?" + (await authorization(env, { client_id })), cookie),
        env,
      );
      assert.equal(result.status, 400, client_id);
      assert.equal(result.headers.get("location"), null);
    }
  assert.equal(calls.length, 1);
  // The token and revocation endpoints never fetch, whatever client they name.
  for (const client_id of [metadataUrl, claude, "https://stranger.example/client.json"]) {
    assert.equal((await exchange(env, "c".repeat(43), { client_id })).status, 400);
    const refreshed = await handleOAuth(
      post("/oauth/token", {
        grant_type: "refresh_token",
        client_id,
        resource: origin + "/mcp",
        refresh_token: "pages_rt_" + "r".repeat(43),
      }),
      env,
    );
    assert.equal((await refreshed.json()).error, "invalid_grant");
    const revoked = await handleOAuth(
      post("/oauth/revoke", { client_id, token: "pages_rt_" + "r".repeat(43) }),
      env,
    );
    assert.equal(revoked.status, 200);
  }
  const refused = await exchange(env, "c".repeat(43), { client_id: "https://10.0.0.8/c.json" });
  assert.equal((await refused.json()).error, "invalid_client");
  assert.equal(calls.length, 1);
});

test("unknown harnesses complete OAuth with hosted and variable loopback callbacks", async (t) => {
  const client_id = "https://new-harness.example/oauth/client.json";
  const env = fixture(t, { PAGES_OAUTH_ANY_CLIENT_DOCUMENT: "false" });
  const login = await session(env);
  const calls = serve(t, {
    [client_id]: {
      client_id,
      client_name: "ChatGPT",
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://new-harness.example/callback", "http://localhost/callback"],
    },
  });
  for (const redirect_uri of [
    "https://new-harness.example/callback",
    "http://localhost:49152/callback",
  ]) {
    const options = { client_id, redirect_uri };
    const screen = await consent(env, login, options);
    assert.match(screen.text, /Connect new-harness\.example to Pages/);
    assert.match(screen.text, /It calls itself/);
    const approved = await approve(env, login, screen.fields);
    const target = new URL(approved.headers.get("location"));
    assert.equal(target.origin + target.pathname, redirect_uri);
    const exchanged = await exchange(env, target.searchParams.get("code"), options);
    assert.equal(exchanged.status, 200);
    const tokens = await exchanged.json();
    // Existing grants keep refreshing and can be revoked even if metadata
    // egress becomes unavailable. Neither endpoint fetches metadata.
    delete env.PAGES_OAUTH_METADATA_EGRESS;
    const refreshed = await handleOAuth(
      post("/oauth/token", {
        grant_type: "refresh_token",
        client_id,
        resource: origin + "/mcp",
        refresh_token: tokens.refresh_token,
      }),
      env,
    );
    assert.equal(refreshed.status, 200);
    const next = await refreshed.json();
    const access = await readAccessToken(env, next.access_token, { resource: origin + "/mcp" });
    assert.equal(access.clientId, client_id);
    assert.equal(access.identity.principal, "user:anaconda:person");
    assert.equal(
      (await handleOAuth(post("/oauth/revoke", { client_id, token: next.refresh_token }), env))
        .status,
      200,
    );
    assert.equal(
      await readAccessToken(env, next.access_token, { resource: origin + "/mcp" }),
      null,
    );
    env.PAGES_OAUTH_METADATA_EGRESS = "public-https";
  }
  assert.equal(calls.length, 2);
});

test("missing metadata egress configuration fails closed for every product", async (t) => {
  const env = fixture(t, { PAGES_OAUTH_METADATA_EGRESS: undefined });
  const login = await session(env);
  const calls = serve(t, {});
  for (const client_id of [metadataUrl, "https://new-harness.example/client.json"]) {
    const result = await handleOAuth(
      get("/oauth/authorize?" + (await authorization(env, { client_id })), login.cookie),
      env,
    );
    assert.equal(result.status, 503);
    assert.match(await result.text(), /public-only HTTPS egress/);
  }
  assert.equal(calls.length, 0);
});

test("Claude connects by its metadata document: consent, code, refresh and revoke", async (t) => {
  const env = fixture(t),
    login = await session(env);
  const calls = serve(t, { [claude]: claudeDocument });
  const options = {
    client_id: claude,
    redirect_uri: claudeCallback,
    scope: "pages:read pages:write pages:share offline_access",
  };
  const screen = await consent(env, login, options);
  assert.match(screen.text, /<h1>Connect Claude to Pages<\/h1>/);
  assert.match(
    screen.text,
    /<strong>Claude<\/strong> \(claude\.ai\) wants access to Pages at <strong>page10\.example<\/strong>/,
  );
  assert.match(screen.text, /Your browser will return to <strong>claude\.ai<\/strong>\./);
  assert.doesNotMatch(screen.text, /does not know this app|on this computer/);
  assert.equal(
    screen.result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
    "'self' " + claudeCallback,
  );
  const approved = await approve(env, login, screen.fields);
  const target = new URL(approved.headers.get("location"));
  assert.equal(target.origin + target.pathname, claudeCallback);
  assert.equal(target.searchParams.get("iss"), origin);
  assert.equal(target.searchParams.get("state"), "client-state");
  const grant = target.searchParams.get("code");
  // The code belongs to this client id and this callback.
  assert.equal((await exchange(env, grant)).status, 400);
  const exchanged = await exchange(env, grant, options);
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  assert.equal(tokens.scope, "offline_access pages:read pages:share pages:write");
  const access = await readAccessToken(env, tokens.access_token, { resource: origin + "/mcp" });
  assert.equal(access.clientId, claude);
  assert.equal(access.identity.principal, "user:anaconda:person");
  const refresh = (client_id, refresh_token) =>
    handleOAuth(
      post("/oauth/token", {
        grant_type: "refresh_token",
        client_id,
        resource: origin + "/mcp",
        refresh_token,
      }),
      env,
    );
  // Another client cannot refresh or revoke this grant.
  assert.equal((await refresh(claudeCode, tokens.refresh_token)).status, 400);
  await handleOAuth(
    post("/oauth/revoke", { client_id: claudeCode, token: tokens.refresh_token }),
    env,
  );
  const rotated = await refresh(claude, tokens.refresh_token);
  assert.equal(rotated.status, 200);
  const next = await rotated.json();
  assert.match(next.refresh_token, /^pages_rt_/);
  assert.ok(await readAccessToken(env, next.access_token, { resource: origin + "/mcp" }));
  const revoked = await handleOAuth(
    post("/oauth/revoke", { client_id: claude, token: next.refresh_token }),
    env,
  );
  assert.equal(revoked.status, 200);
  assert.equal(await readAccessToken(env, next.access_token, { resource: origin + "/mcp" }), null);
  assert.equal((await refresh(claude, next.refresh_token)).status, 400);
  // One fetch, for the consent screen. Token requests made none.
  assert.equal(calls.length, 1);
});

test("Claude Code returns to a loopback port it chose, and the consent screen says so", async (t) => {
  const env = fixture(t),
    login = await session(env);
  serve(t, { [claudeCode]: claudeCodeDocument });
  for (const redirect_uri of [
    "http://localhost:3118/callback",
    "http://127.0.0.1:49152/callback",
  ]) {
    const options = { client_id: claudeCode, redirect_uri };
    const screen = await consent(env, login, options);
    const host = new URL(redirect_uri).host;
    assert.match(screen.text, /<h1>Connect Claude Code to Pages<\/h1>/);
    assert.ok(
      screen.text.includes(
        `Your browser will return to an app on this computer, at <strong>${host}</strong>. Pages cannot tell which app is listening there. Allow access only if you started this connection yourself.`,
      ),
    );
    assert.equal(
      screen.result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
      "'self' " + redirect_uri,
    );
    const approved = await approve(env, login, screen.fields);
    const target = new URL(approved.headers.get("location"));
    assert.equal(target.origin + target.pathname, redirect_uri);
    const grant = target.searchParams.get("code");
    // The port is free at authorization, then fixed for that code.
    const moved = await exchange(env, grant, {
      ...options,
      redirect_uri: "http://localhost:3119/callback",
    });
    assert.equal(moved.status, 400);
    assert.equal((await exchange(env, grant, options)).status, 200);
  }
  for (const redirect_uri of [
    "http://localhost:3118/other",
    "http://localhost:3118/callback?next=evil",
    "http://[::1]:3118/callback",
    "http://127.0.0.2:3118/callback",
    "http://192.168.1.1:3118/callback",
    "https://localhost:3118/callback",
    "https://evil.example/callback",
    claudeCallback,
  ]) {
    const result = await handleOAuth(
      get(
        "/oauth/authorize?" + (await authorization(env, { client_id: claudeCode, redirect_uri })),
        login.cookie,
      ),
      env,
    );
    assert.equal(result.status, 400, redirect_uri);
    assert.equal(result.headers.get("location"), null);
    assert.equal(
      result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
      "'self'",
    );
  }
});

test("a local Pages server refuses a native client on its own loopback name and says which name to use", async (t) => {
  for (const [local, same, other] of [
    ["http://localhost:9894", "localhost", "127.0.0.1"],
    ["http://127.0.0.1:9894", "127.0.0.1", "localhost"],
  ]) {
    const env = fixture(t, { NOTEBOOK_CLOUD_PUBLIC_ORIGIN: local }),
      login = await session(env);
    serve(t, { [claudeCode]: claudeCodeDocument });
    const refused = await handleOAuth(
      get(
        "/oauth/authorize?" +
          (await authorization(env, {
            client_id: claudeCode,
            redirect_uri: `http://${same}:54034/callback`,
          })),
        login.cookie,
      ),
      env,
    );
    assert.equal(refused.status, 400, local);
    assert.equal(refused.headers.get("location"), null);
    const text = await refused.text();
    assert.ok(
      text.includes(
        `This client listens on ${same}, the name this local Pages server uses, so your browser would send it your Pages session. Run Pages on ${other} to connect it.`,
      ),
      text,
    );
    assert.doesNotMatch(text, /<form/);
    // The same client on the other loopback name gets its consent screen.
    const redirect_uri = `http://${other}:54034/callback`;
    const screen = await consent(env, login, { client_id: claudeCode, redirect_uri });
    assert.match(screen.text, /<h1>Connect Claude Code to Pages<\/h1>/);
    assert.equal(
      screen.result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
      "'self' " + redirect_uri,
    );
  }
  // A public deployment keeps the plain refusal.
  const env = fixture(t),
    login = await session(env);
  const client_id = "https://app.example/client.json";
  const redirect_uri = "https://page10.example:8443/cb";
  serve(t, {
    [client_id]: { ...claudeCodeDocument, client_id, redirect_uris: [redirect_uri] },
  });
  const refused = await handleOAuth(
    get(
      "/oauth/authorize?" + (await authorization(env, { client_id, redirect_uri })),
      login.cookie,
    ),
    env,
  );
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /The callback does not match this client\./);
});

test("a client Pages has no name for is shown by its host; the name it claims is quoted and escaped", async (t) => {
  const env = fixture(t),
    login = await session(env);
  const client_id = "https://claude.ai.attacker.example/oauth/mcp-oauth-client-metadata";
  const redirect_uri = "https://collector.example/cb?kind=mcp";
  const unnameable = "https://collector.example/cb;script-src%20*";
  serve(t, {
    [client_id]: {
      client_id,
      client_name: 'Claude</strong><img src=x onerror="alert(1)">',
      client_uri: "https://claude.ai",
      logo_uri: "https://claude.ai/logo.png",
      redirect_uris: [redirect_uri, unnameable, claudeCallback],
      token_endpoint_auth_method: "none",
    },
  });
  const screen = await consent(env, login, { client_id, redirect_uri });
  assert.match(screen.text, /<h1>Connect claude\.ai\.attacker\.example to Pages<\/h1>/);
  assert.ok(
    screen.text.includes(
      "<p><strong>claude.ai.attacker.example</strong> wants access to Pages at <strong>page10.example</strong>.</p>" +
        "<p>Pages does not know this app. It calls itself “Claude&lt;/strong&gt;&lt;img src=x onerror=&quot;alert(1)&quot;&gt;”. " +
        "Allow access only if you trust <strong>claude.ai.attacker.example</strong>.</p>" +
        "<p>Your browser will return to <strong>collector.example</strong>.</p>",
    ),
    screen.text,
  );
  assert.doesNotMatch(screen.text, /<img|<strong>Claude|logo\.png/);
  // The policy names the callback's origin and path, never the whole origin.
  assert.equal(
    screen.result.headers.get("content-security-policy"),
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; base-uri 'none'; form-action 'self' https://collector.example/cb; frame-ancestors 'none'",
  );
  // A listed callback whose path could end or extend the policy is refused
  // like an unlisted one: no consent screen, no redirect, no wider policy.
  const refused = await handleOAuth(
    get(
      "/oauth/authorize?" + (await authorization(env, { client_id, redirect_uri: unnameable })),
      login.cookie,
    ),
    env,
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.headers.get("location"), null);
  assert.equal(
    refused.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
    "'self'",
  );
  const refusal = await refused.text();
  assert.match(refusal, /The callback does not match this client\./);
  assert.doesNotMatch(refusal, /<form/);
  // The document lists Claude's callback too, and the screen still names this
  // host as the asker. The code sent there is stored with this client id and
  // the request's PKCE challenge, so a token request naming Claude's client
  // id is refused.
  const options = { client_id, redirect_uri: claudeCallback };
  const borrowed = await consent(env, login, options);
  assert.match(borrowed.text, /<h1>Connect claude\.ai\.attacker\.example to Pages<\/h1>/);
  assert.match(borrowed.text, /Your browser will return to <strong>claude\.ai<\/strong>\./);
  const sent = new URL((await approve(env, login, borrowed.fields)).headers.get("location"));
  assert.equal(sent.origin + sent.pathname, claudeCallback);
  const grant = sent.searchParams.get("code");
  assert.equal((await exchange(env, grant, { ...options, client_id: claude })).status, 400);
  assert.equal(
    (await exchange(env, grant, { ...options, code_verifier: "w".repeat(43) })).status,
    400,
  );
});

test("a document that changes its callbacks after consent does not move a pending consent or an issued code", async (t) => {
  const env = fixture(t),
    login = await session(env);
  const client_id = "https://changing.example/client.json";
  const first = "https://changing.example/callback",
    second = "https://elsewhere.example/callback";
  const documents = {
    [client_id]: {
      client_id,
      client_name: "Changing",
      redirect_uris: [first],
      token_endpoint_auth_method: "none",
    },
  };
  const calls = serve(t, documents);
  const screen = await consent(env, login, { client_id, redirect_uri: first });
  documents[client_id] = { ...documents[client_id], redirect_uris: [second] };
  // The consent the person saw keeps the callback it was shown with.
  const approved = new URL((await approve(env, login, screen.fields)).headers.get("location"));
  assert.equal(approved.origin + approved.pathname, first);
  const grant = approved.searchParams.get("code");
  // The code stays bound to that callback: the document's new one cannot
  // redeem it, and the token endpoint does not read the document again.
  const moved = await exchange(env, grant, { client_id, redirect_uri: second });
  assert.equal((await moved.json()).error, "invalid_grant");
  assert.equal((await exchange(env, grant, { client_id, redirect_uri: first })).status, 200);
  assert.equal(calls.length, 1);
  // A new authorization request reads the document as it is now.
  const stale = await handleOAuth(
    get(
      "/oauth/authorize?" + (await authorization(env, { client_id, redirect_uri: first })),
      login.cookie,
    ),
    env,
  );
  assert.equal(stale.status, 400);
  assert.equal(calls.length, 2);
});

test("a request waiting on another request's document fetch resumes on its own timer and finishes its store work", async (t) => {
  const env = fixture(t),
    login = await session(env);
  const saved = { ...metadataFetchTimeouts };
  t.after(() => Object.assign(metadataFetchTimeouts, saved));
  // A poll interval no other timer uses, so the waiter's own timer is the
  // one this test sees scheduled.
  metadataFetchTimeouts.poll = 7;
  const client_id = "https://concurrent.example/client.json",
    redirect_uri = "https://concurrent.example/callback";
  let release,
    calls = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, "fetch", async () => {
    calls++;
    await gate;
    return Response.json(
      {
        client_id,
        client_name: "Concurrent",
        redirect_uris: [redirect_uri],
        token_endpoint_auth_method: "none",
      },
      { headers: { "Cache-Control": "max-age=300" } },
    );
  });
  // Set up the OAuth store before timers are mocked.
  await consent(env, login);
  const consents = () =>
    env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_consents").get().n;
  const before = consents();
  const turns = async (count = 50) => {
    for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const request = async (overrides = {}) =>
    handleOAuth(
      get(
        "/oauth/authorize?" + (await authorization(env, { client_id, redirect_uri, ...overrides })),
        login.cookie,
      ),
      env,
    );
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const mocked = globalThis.setTimeout;
  const polling = new Promise((resolve) => {
    globalThis.setTimeout = function (callback, delay, ...rest) {
      if (delay === metadataFetchTimeouts.poll) {
        globalThis.setTimeout = mocked;
        resolve();
      }
      return mocked.call(this, callback, delay, ...rest);
    };
  });
  // The owner starts the fetch. Its request is invalid, so it answers as soon
  // as the document arrives, before the waiter has done anything else.
  const owner = request({ response_type: "token" });
  while (calls < 1) await turns(5);
  const waiter = request();
  let settled = false;
  waiter.then(
    () => (settled = true),
    () => (settled = true),
  );
  await polling;
  assert.equal(calls, 1, "the waiter did not start a second fetch");
  release();
  assert.equal((await owner).status, 400);
  await turns();
  assert.equal(settled, false, "the owner's response does not resume the waiter");
  assert.equal(consents(), before);
  t.mock.timers.tick(metadataFetchTimeouts.poll);
  // The waiter runs on from its own timer: it reads the kept document, then
  // writes its consent to the store and answers.
  const result = await waiter;
  assert.equal(result.status, 200);
  assert.match(await result.text(), /name="consent_id"/);
  assert.equal(consents(), before + 1);
  assert.equal(calls, 1);
});

test("a metadata-document client gets no redirect until the person chooses", async (t) => {
  const env = fixture(t),
    login = await session(env);
  const client_id = "https://stranger.example/client.json",
    redirect_uri = "https://stranger.example/landing";
  serve(t, {
    [client_id]: {
      client_id,
      client_name: "Stranger",
      redirect_uris: [redirect_uri],
      token_endpoint_auth_method: "none",
    },
  });
  // The same faults send a named client an OAuth error. Here they stay on a
  // Pages page, so a link to /oauth/authorize is not a redirect to this site.
  for (const invalid of [
    { response_type: "token" },
    { scope: "admin" },
    { code_challenge_method: "plain" },
    { resource: "https://evil.example/mcp" },
    { response_mode: "form_post" },
    { redirect_uri: "https://stranger.example/unlisted" },
    { redirect_uri: origin + "/oauth/authorize" },
  ]) {
    const result = await handleOAuth(
      get(
        "/oauth/authorize?" + (await authorization(env, { client_id, redirect_uri, ...invalid })),
        login.cookie,
      ),
      env,
    );
    assert.equal(result.status, 400, JSON.stringify(invalid));
    assert.equal(result.headers.get("location"), null);
    assert.match(await result.text(), /Connection not completed/);
  }
  const screen = await consent(env, login, { client_id, redirect_uri });
  const denied = new URL(
    (await approve(env, login, { ...screen.fields, decision: "cancel" })).headers.get("location"),
  );
  assert.equal(denied.origin + denied.pathname, redirect_uri);
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("iss"), origin);
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
  assert.match(await result.text(), />Sign in<\/a>/);
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

test("preconfigured Kilo grants requested read/write/offline scopes only to its exact loopback callback", async (t) => {
  const env = fixture(t),
    login = await session(env);
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Preconfigured Kilo must not fetch metadata or register a client");
  });
  const options = {
    client_id: "pages-kilo",
    redirect_uri: kiloCallback,
    scope: "pages:read pages:write offline_access",
  };
  const screen = await consent(env, login, options);
  assert.match(screen.text, /Connect Kilo to Pages/);
  assert.match(screen.text, /kilo.ai/);
  assert.match(screen.text, /delete Pages you own/);
  assert.equal(
    screen.result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
    "'self' " + kiloCallback,
  );
  assert.doesNotMatch(screen.result.headers.get("content-security-policy"), /chatgpt.com/);
  const approved = await approve(env, login, screen.fields);
  const target = new URL(approved.headers.get("location"));
  assert.equal(target.origin + target.pathname, kiloCallback);
  assert.equal(target.searchParams.get("iss"), origin);
  assert.equal(target.searchParams.get("state"), "client-state");
  const grant = target.searchParams.get("code");
  // A code issued to this public client cannot be redeemed through another
  // allowed client, or redirected to another loopback service.
  assert.equal((await exchange(env, grant)).status, 400);
  assert.equal(
    (
      await exchange(env, grant, {
        ...options,
        redirect_uri: "http://127.0.0.1:19877/mcp/oauth/callback",
      })
    ).status,
    400,
  );
  const exchanged = await exchange(env, grant, options);
  assert.equal(exchanged.status, 200);
  const tokens = await exchanged.json();
  assert.equal(tokens.scope, "offline_access pages:read pages:write");
  assert.match(tokens.refresh_token, /^pages_rt_/);
  const access = await readAccessToken(env, tokens.access_token, { resource: origin + "/mcp" });
  assert.equal(access.clientId, "pages-kilo");
  assert.equal(access.identity.principal, "user:anaconda:person");
  const cancel = await consent(env, login, options);
  const denied = new URL(
    (await approve(env, login, { ...cancel.fields, decision: "cancel" })).headers.get("location"),
  );
  assert.equal(denied.origin + denied.pathname, kiloCallback);
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("iss"), origin);
});

test("Kilo never accepts alternate loopback hosts, ports, paths or private-network callbacks", async (t) => {
  const env = fixture(t);
  t.mock.method(globalThis, "fetch", () => {
    throw new Error("Invalid callback must not trigger network activity");
  });
  for (const redirect_uri of [
    "http://localhost:19876/mcp/oauth/callback",
    "http://[::1]:19876/mcp/oauth/callback",
    "https://127.0.0.1:19876/mcp/oauth/callback",
    "http://127.0.0.1:19877/mcp/oauth/callback",
    "http://127.0.0.2:19876/mcp/oauth/callback",
    "http://127.0.0.1:19876/other",
    "http://127.0.0.1:19876/mcp/oauth/callback/",
    "http://127.0.0.1:19876/mcp/oauth/callback?next=evil",
    "http://127.0.0.1:19876/mcp/oauth/callback#fragment",
    "http://127.0.0.1:19876@evil.example/mcp/oauth/callback",
    "http://192.168.1.1:19876/mcp/oauth/callback",
    "http://169.254.169.254/latest/meta-data",
    callback,
  ]) {
    const result = await handleOAuth(
      get(
        "/oauth/authorize?" + (await authorization(env, { client_id: "pages-kilo", redirect_uri })),
      ),
      env,
    );
    assert.equal(result.status, 400, redirect_uri);
    assert.equal(result.headers.get("location"), null);
    assert.equal(
      result.headers.get("content-security-policy").match(/form-action ([^;]+)/)[1],
      "'self'",
    );
  }
});
