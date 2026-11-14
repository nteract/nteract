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
import { captureConsole, secretLines } from "./auth-events-fixture.mjs";
import worker from "./index.mjs";
import { handleOAuth } from "./oauth.mjs";
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

const origin = "https://pages-account-auth.example";
const kiloCallback = "http://127.0.0.1:19876/mcp/oauth/callback";
const verifier = "v".repeat(43);
const person = "user:anaconda:person";
const other = "user:anaconda:other";

function fixture(t) {
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "account-auth-fixture-".repeat(3),
    DB: new SqliteD1(),
  };
  t.after(() => env.DB.sqlite.close());
  return env;
}

async function signIn(env, principal = person) {
  await oidcDatabase(env);
  const now = Math.floor(Date.now() / 1000);
  const token = randomSecret(),
    id = await serverSessionId(env, token);
  const context = serverSessionContext(env, origin);
  const app = await createServerAppSession(
    env,
    {
      principal,
      metadata: {
        provider: "oidc",
        principalNamespace: "user:anaconda",
        displayName: "Example Person",
        email: "person@example.invalid",
        emailVerified: true,
      },
    },
    id,
    now + 3600,
    now,
  );
  await env.DB.prepare(
    "INSERT INTO oidc_server_sessions (id,context,session_json,sealed,access_expires_at,idle_expires_at,absolute_expires_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      context,
      JSON.stringify(app),
      await sealServerSecret(env, {}, `session:${id}:${context}`),
      now + 3600,
      now + 7200,
      now + 86400,
    )
    .run();
  return { cookie: `${SERVER_SESSION_COOKIE}=${token}`, token };
}

const get = (path, headers = {}) => new Request(origin + path, { headers });
const post = (path, fields, headers = {}) =>
  new Request(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
  });

/** One approved connection for the signed-in browser `login`: Kilo's, unless
 * another client and callback are named. */
async function connectAgent(env, login, clientId = "pages-kilo", redirectUri = kiloCallback) {
  const query = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    resource: origin + "/mcp",
    code_challenge: await secretHash(verifier),
    code_challenge_method: "S256",
    scope: "pages:read pages:write",
    state: "client-state-value",
  });
  const screen = await handleOAuth(get("/oauth/authorize?" + query, { cookie: login.cookie }), env);
  const text = await screen.text();
  const field = (name) => text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
  const approved = await handleOAuth(
    post(
      "/oauth/authorize",
      { consent_id: field("consent_id"), csrf_token: field("csrf_token"), decision: "approve" },
      { Origin: origin, Cookie: login.cookie },
    ),
    env,
  );
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  const issued = await handleOAuth(
    post("/oauth/token", {
      client_id: clientId,
      resource: origin + "/mcp",
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code_verifier: verifier,
      code,
    }),
    env,
  );
  assert.equal(issued.status, 200);
  return issued.json();
}

const call = (env, path, { method = "GET", cookie, origin: from = origin, headers = {} } = {}) =>
  worker.fetch(
    new Request(origin + path, {
      method,
      headers: {
        ...(cookie && { cookie }),
        ...(from && { Origin: from }),
        ...headers,
      },
    }),
    env,
  );
const signedIn = async (env, login) =>
  (await (await call(env, "/api/auth/session", { cookie: login.cookie })).json()).identity
    ?.principal ?? null;
const agentWorks = async (env, tokens) =>
  (await readAccessToken(env, tokens.access_token, { resource: origin + "/mcp" })) !== null;

test("sign out everywhere ends the caller's browsers and agents and nobody else's", async (t) => {
  const env = fixture(t);
  const here = await signIn(env);
  const laptop = await signIn(env);
  const theirs = await signIn(env, other);
  const agents = [await connectAgent(env, here), await connectAgent(env, laptop)];
  const theirAgent = await connectAgent(env, theirs);
  const capture = captureConsole(t);
  const response = await call(env, "/api/auth/logout-all", { method: "POST", cookie: here.cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, sessions: 2, agents: 2 });
  assert.match(
    response.headers.get("set-cookie"),
    new RegExp(`^${SERVER_SESSION_COOKIE}=;.*Max-Age=0`),
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(await signedIn(env, here), null);
  assert.equal(await signedIn(env, laptop), null);
  for (const tokens of agents) assert.equal(await agentWorks(env, tokens), false);
  assert.equal(await signedIn(env, theirs), other);
  assert.equal(await agentWorks(env, theirAgent), true);
  assert.deepEqual(
    capture.events.map(({ action, principal, revoked_by, reason, scope, credential }) => ({
      action,
      principal,
      revoked_by,
      reason,
      scope,
      credential,
    })),
    [
      ...Array(2).fill({
        action: "oauth.grant_revoked",
        principal: person,
        revoked_by: "user",
        reason: "sign_out_everywhere",
        scope: undefined,
        credential: "oauth",
      }),
      {
        action: "sign_out",
        principal: person,
        revoked_by: undefined,
        reason: undefined,
        scope: "all",
        credential: "oidc",
      },
    ],
  );
  assert.deepEqual(
    secretLines(capture.lines, [here.token, laptop.token, ...agents.map((a) => a.access_token)]),
    [],
  );
  // The cookie no longer names a session.
  const again = await call(env, "/api/auth/logout-all", { method: "POST", cookie: here.cookie });
  assert.equal(again.status, 401);
});

test("an approval whose session ends before its code is written issues no code", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const query = new URLSearchParams({
    client_id: "pages-kilo",
    redirect_uri: kiloCallback,
    response_type: "code",
    resource: origin + "/mcp",
    code_challenge: await secretHash(verifier),
    code_challenge_method: "S256",
    scope: "pages:read pages:write",
    state: "client-state-value",
  });
  const screen = await handleOAuth(get("/oauth/authorize?" + query, { cookie: login.cookie }), env);
  const text = await screen.text();
  const field = (name) => text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
  // Sign out everywhere lands after the approval's session check and consent
  // consumption, just before the code insert.
  const prepare = env.DB.prepare.bind(env.DB);
  let raced = false;
  t.mock.method(env.DB, "prepare", (sql) => {
    if (sql.trimStart().startsWith("INSERT INTO pages_oauth_codes") && !raced) {
      raced = true;
      env.DB.sqlite.exec("DELETE FROM oidc_server_sessions");
    }
    return prepare(sql);
  });
  const capture = captureConsole(t);
  const approved = await handleOAuth(
    post(
      "/oauth/authorize",
      { consent_id: field("consent_id"), csrf_token: field("csrf_token"), decision: "approve" },
      { Origin: origin, Cookie: login.cookie },
    ),
    env,
  );
  assert.equal(raced, true);
  // The client gets access_denied on its callback, and no code.
  assert.equal(approved.status, 303);
  const back = new URL(approved.headers.get("location"));
  assert.equal(`${back.origin}${back.pathname}`, kiloCallback);
  assert.equal(back.searchParams.get("error"), "access_denied");
  assert.equal(back.searchParams.has("code"), false);
  assert.equal(env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_codes").get().n, 0);
  assert.equal(capture.find("oauth.code_issued").length, 0);
  assert.equal(capture.find("oauth.consent_granted").length, 0);
});

test("the session answer advertises account controls to a browser session only", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const session = async (options) =>
    (await call(env, "/api/auth/session", { origin: null, ...options })).json();
  assert.equal((await session({ cookie: login.cookie })).accountControls, true);
  assert.equal((await session({})).accountControls, undefined);
});

test("the session answer holds who is signed in and what they can do, and nothing else", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const answer = await (
    await call(env, "/api/auth/session", { origin: null, cookie: login.cookie })
  ).json();
  assert.deepEqual(Object.keys(answer).sort(), [
    "accountControls",
    "canWrite",
    "expiresAt",
    "identity",
  ]);
  const signedOut = await (await call(env, "/api/auth/session", { origin: null })).json();
  assert.deepEqual(signedOut, { identity: null, canWrite: false });
});

test("sign out everywhere needs this origin and a browser session", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const tokens = await connectAgent(env, login);
  const refused = [
    // No Origin: a form post or a stripped header.
    [{ method: "POST", cookie: login.cookie, origin: null }, 403],
    [{ method: "POST", cookie: login.cookie, origin: "https://elsewhere.example" }, 403],
    [{ method: "POST", cookie: login.cookie, headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
    // An agent can't sign its person out, even with the cookie alongside.
    [
      {
        method: "POST",
        cookie: login.cookie,
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
      403,
    ],
    [{ method: "POST" }, 401],
    [{ method: "POST", cookie: `${SERVER_SESSION_COOKIE}=${"x".repeat(43)}` }, 401],
    [{ method: "GET", cookie: login.cookie }, 405],
  ];
  for (const [options, status] of refused) {
    const response = await call(env, "/api/auth/logout-all", options);
    assert.equal(response.status, status, JSON.stringify(options));
  }
  assert.equal(await signedIn(env, login), person);
  assert.equal(await agentWorks(env, tokens), true);
});

test("the connected agents list names a metadata-document client by product or host, never by its own claim", async (t) => {
  const env = fixture(t);
  env.PAGES_OAUTH_METADATA_EGRESS = "public-https";
  const login = await signIn(env);
  const claudeCode = "https://claude.ai/oauth/claude-code-client-metadata";
  const stranger = "https://app.example/client.json";
  const documents = {
    [claudeCode]: {
      client_id: claudeCode,
      client_name: "Claude Code",
      redirect_uris: ["http://localhost/callback", "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none",
    },
    [stranger]: {
      client_id: stranger,
      client_name: "Kilo",
      redirect_uris: ["https://app.example/callback"],
      token_endpoint_auth_method: "none",
    },
  };
  t.mock.method(globalThis, "fetch", async (url) =>
    Response.json(documents[url], { headers: { "Cache-Control": "no-store" } }),
  );
  await connectAgent(env, login, claudeCode, "http://localhost:3118/callback");
  await connectAgent(env, login, stranger, "https://app.example/callback");
  const response = await call(env, "/api/auth/grants", { cookie: login.cookie, origin: null });
  const { agents } = await response.json();
  assert.deepEqual(agents.map((agent) => agent.name).sort(), ["Claude Code", "app.example"]);
  assert.doesNotMatch(JSON.stringify(agents), /client\.json|oauth\/claude-code/);
  // Either connection disconnects like any other.
  for (const agent of agents) {
    const revoked = await call(env, `/api/auth/grants/${agent.id}/revoke`, {
      method: "POST",
      cookie: login.cookie,
    });
    assert.deepEqual(await revoked.json(), { revoked: true });
  }
});

test("the connected agents list shows the caller's live connections without secrets", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const tokens = [await connectAgent(env, login), await connectAgent(env, login)];
  await connectAgent(env, await signIn(env, other));
  const response = await call(env, "/api/auth/grants", { cookie: login.cookie, origin: null });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { agents } = await response.json();
  assert.equal(agents.length, 2);
  for (const agent of agents) {
    assert.deepEqual(Object.keys(agent).sort(), [
      "created_at",
      "expires_at",
      "id",
      "name",
      "scope",
    ]);
    assert.equal(agent.name, "Kilo");
    assert.equal(agent.scope, "pages:read pages:write");
    assert.match(agent.id, /^[A-Za-z0-9_-]{43}$/);
    assert.ok(Date.parse(agent.created_at) <= Date.now());
    assert.ok(Date.parse(agent.expires_at) > Date.now());
  }
  const text = JSON.stringify(agents);
  for (const value of tokens.flatMap((t) => [t.access_token, t.refresh_token]))
    assert.equal(text.includes(value), false);
  for (const { id } of env.DB.sqlite.prepare("SELECT id FROM pages_oauth_grants").all())
    assert.equal(text.includes(id), false);

  for (const [options, status] of [
    [{ origin: "https://elsewhere.example", cookie: login.cookie }, 403],
    [{ cookie: login.cookie, headers: { "Sec-Fetch-Site": "cross-site" } }, 403],
    [{ cookie: login.cookie, headers: { Authorization: `Bearer ${tokens[0].access_token}` } }, 403],
    [{}, 401],
    [{ method: "POST", cookie: login.cookie }, 405],
  ]) {
    const refused = await call(env, "/api/auth/grants", options);
    assert.equal(refused.status, status, JSON.stringify(options));
  }
});

test("disconnecting one agent revokes that connection only", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const theirs = await signIn(env, other);
  const first = await connectAgent(env, login);
  const second = await connectAgent(env, login);
  const theirAgent = await connectAgent(env, theirs);
  const list = async (who) =>
    (await (await call(env, "/api/auth/grants", { cookie: who.cookie })).json()).agents;
  const [theirHandle] = (await list(theirs)).map((agent) => agent.id);
  const revoke = (id, options = {}) =>
    call(env, `/api/auth/grants/${id}/revoke`, {
      method: "POST",
      cookie: login.cookie,
      ...options,
    });

  // Another account's connection is not the caller's to end.
  assert.deepEqual(await (await revoke(theirHandle)).json(), { revoked: false });
  assert.equal(await agentWorks(env, theirAgent), true);
  // Writes need this origin and a browser session.
  const [target] = await list(login);
  assert.equal((await revoke(target.id, { origin: null })).status, 403);
  assert.equal((await revoke(target.id, { origin: "https://elsewhere.example" })).status, 403);
  assert.equal(
    (await revoke(target.id, { headers: { Authorization: `Bearer ${second.access_token}` } }))
      .status,
    403,
  );
  assert.equal((await revoke(target.id, { method: "GET" })).status, 405);
  assert.equal((await call(env, "/api/auth/grants/short/revoke", { method: "POST" })).status, 404);
  assert.deepEqual([await agentWorks(env, first), await agentWorks(env, second)], [true, true]);

  const capture = captureConsole(t);
  const response = await revoke(target.id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { revoked: true });
  assert.deepEqual(await (await revoke(target.id)).json(), { revoked: false });
  // Exactly one of the two connections stopped working.
  assert.deepEqual([await agentWorks(env, first), await agentWorks(env, second)].sort(), [
    false,
    true,
  ]);
  assert.equal((await list(login)).length, 1);
  assert.equal(await signedIn(env, login), person);
  assert.deepEqual(
    capture
      .find("oauth.grant_revoked")
      .map(({ principal, revoked_by, reason }) => ({ principal, revoked_by, reason })),
    [{ principal: person, revoked_by: "user", reason: "disconnected" }],
  );
});
