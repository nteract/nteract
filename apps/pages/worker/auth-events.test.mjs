import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { createAuthFixture } from "../auth-fixtures.mjs";
import {
  AUTH_ACTIONS,
  AUTH_EVENT,
  authEvent,
  authRef,
  firstApiKeyUse,
  logAuthEvent,
  recordOidcEvent,
  resetApiKeyUses,
} from "./auth-events.mjs";
import { SECRET_SHAPES, captureConsole, secretLines } from "./auth-events-fixture.mjs";
import { authenticate } from "./auth.mjs";
import worker from "./index.mjs";
import { handleOAuth } from "./oauth.mjs";

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

const origin = "https://pages-auth-events.example";
const kiloCallback = "http://127.0.0.1:19876/mcp/oauth/callback";
const verifier = "v".repeat(43);
const principal = "user:anaconda:person";

function fixture(t) {
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_FLOW: "server",
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    NOTEBOOK_CLOUD_APP_SESSION_SECRET: "auth-events-fixture-".repeat(3),
    DB: new SqliteD1(),
  };
  t.after(() => env.DB.sqlite.close());
  return env;
}

async function signIn(env) {
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

const get = (path, cookie) => new Request(origin + path, { headers: cookie ? { cookie } : {} });
const post = (path, fields, headers = {}) =>
  new Request(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(fields),
  });

async function consentScreen(env, login) {
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
  const screen = await handleOAuth(get("/oauth/authorize?" + query, login.cookie), env);
  assert.equal(screen.status, 200);
  const text = await screen.text();
  const field = (name) => text.match(new RegExp(`name="${name}" value="([^"]+)"`))[1];
  return { consent_id: field("consent_id"), csrf_token: field("csrf_token") };
}
const decide = (env, login, fields, decision) =>
  handleOAuth(
    post("/oauth/authorize", { ...fields, decision }, { Origin: origin, Cookie: login.cookie }),
    env,
  );
const tokenRequest = (env, fields) =>
  handleOAuth(
    post("/oauth/token", { client_id: "pages-kilo", resource: origin + "/mcp", ...fields }),
    env,
  );

test("an auth record has a fixed shape and drops anything outside its allowlists", () => {
  const record = authEvent({
    action: "oauth.token_issued",
    principal,
    credential: "oauth",
    clientId: "pages-kilo",
    grant: "0123456789ab",
    grantType: "refresh_token",
    scope: "pages:write pages:read pages:read",
    refresh: true,
    now: new Date("2026-11-06T00:00:00Z"),
  });
  assert.deepEqual(record, {
    service: "nteract-pages-native",
    event: AUTH_EVENT,
    action: "oauth.token_issued",
    principal,
    credential: "oauth",
    client_id: "pages-kilo",
    grant: "0123456789ab",
    grant_type: "refresh_token",
    scope: "pages:read pages:write",
    refresh: true,
    timestamp: "2026-11-06T00:00:00.000Z",
  });
  assert.deepEqual(
    authEvent({
      action: "sign_in.failed",
      principal: "user:anaconda:person@example.invalid",
      clientId: "https://evil.example/client.json",
      grant: "pages_at_" + "a".repeat(43),
      scope: "admin pages:read",
      reason: "Bearer secret",
      projectId: "not-a-project",
      role: "owner",
      revokedBy: "attacker",
      now: new Date("2026-11-06T00:00:00Z"),
    }),
    {
      service: "nteract-pages-native",
      event: AUTH_EVENT,
      action: "sign_in.failed",
      client_id: "unknown",
      timestamp: "2026-11-06T00:00:00.000Z",
    },
  );
  assert.throws(() => authEvent({ action: "oauth.unknown" }), TypeError);
  assert.equal(AUTH_ACTIONS.length, new Set(AUTH_ACTIONS).size);
});

test("only a sign-out carries the scope all, and a sign-out carries no OAuth scope", () => {
  const scope = (action, value) => authEvent({ action, principal, scope: value }).scope;
  assert.equal(scope("sign_out", "all"), "all");
  assert.equal(scope("sign_out", "pages:read"), undefined);
  assert.equal(scope("sign_out", "everything"), undefined);
  assert.equal(scope("oauth.token_issued", "all"), undefined);
  assert.equal(scope("oauth.token_issued", "pages:read"), "pages:read");
});

test("grant and invitation ids leave only as short SHA-256 references", async (t) => {
  const capture = captureConsole(t);
  const grantId = randomSecret();
  const expected = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(grantId))).slice(
      0,
      6,
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  assert.equal(await authRef(grantId), expected);
  assert.equal(await authRef(""), undefined);
  const record = await logAuthEvent({
    action: "oauth.grant_revoked",
    principal,
    grantId,
    inviteId: "invite-1",
    revokedBy: "rfc7009",
  });
  assert.equal(record.grant, expected);
  assert.match(record.invite, /^[0-9a-f]{12}$/);
  assert.equal(capture.lines.join("\n").includes(grantId), false);
  assert.equal(capture.lines.join("\n").includes("invite-1"), false);
});

test("a record that can't be built is counted on the next line and never throws", async (t) => {
  const capture = captureConsole(t);
  assert.equal(await logAuthEvent({ action: "not.an.action" }), undefined);
  const next = await logAuthEvent({ action: "sign_out", principal });
  assert.equal(next.dropped, 1);
  assert.equal((await logAuthEvent({ action: "sign_out", principal })).dropped, undefined);
  assert.deepEqual(capture.actions(), ["sign_out", "sign_out"]);
});

test("shared sign-in callbacks map onto Pages auth actions", (t) => {
  const capture = captureConsole(t);
  recordOidcEvent({ type: "sign_in", principal });
  recordOidcEvent({
    type: "sign_in_failed",
    phase: "callback_transaction",
    kind: "callback_rejected",
    reason: "login_binding_missing",
    outcome: "failure_page",
  });
  recordOidcEvent({ type: "session_expired", principal, reason: "refresh_rejected" });
  recordOidcEvent({ type: "unknown" });
  recordOidcEvent(null);
  assert.deepEqual(
    capture.events.map(({ timestamp, ...rest }) => (assert.ok(timestamp), rest)),
    [
      {
        service: "nteract-pages-native",
        event: AUTH_EVENT,
        action: "sign_in.succeeded",
        principal,
        credential: "oidc",
      },
      {
        service: "nteract-pages-native",
        event: AUTH_EVENT,
        action: "sign_in.failed",
        credential: "oidc",
        reason: "login_binding_missing",
        phase: "callback_transaction",
        kind: "callback_rejected",
        outcome: "failure_page",
      },
      {
        service: "nteract-pages-native",
        event: AUTH_EVENT,
        action: "session.expired",
        principal,
        credential: "oidc",
        reason: "refresh_rejected",
      },
    ],
  );
});

test("an API key is recorded once per isolate cache window", () => {
  resetApiKeyUses();
  assert.equal(firstApiKeyUse("key-a", 0), true);
  assert.equal(firstApiKeyUse("key-a", 59_999), false);
  assert.equal(firstApiKeyUse("key-b", 1), true);
  assert.equal(firstApiKeyUse("key-a", 60_000), true);
  for (let index = 0; index < 300; index++) firstApiKeyUse(`key-${index}`, 2);
  assert.equal(firstApiKeyUse("key-299", 3), false, "the newest entries stay");
  assert.equal(firstApiKeyUse("key-0", 3), true, "the oldest entries are evicted");
});

test("an accepted Anaconda API key logs once per cache window, with no key or email", async (t) => {
  resetApiKeyUses();
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const capture = captureConsole(t);
  const key = auth.apiKey({ scopes: ["cloud:read"] });
  const request = () =>
    new Request("https://pages.invalid/whoami", { headers: { authorization: `Bearer ${key}` } });
  await authenticate(request(), auth.env);
  await authenticate(request(), auth.env);
  const accepted = capture.find("api_key.accepted");
  assert.equal(accepted.length, 1);
  assert.deepEqual(
    { ...accepted[0], timestamp: undefined },
    {
      service: "nteract-pages-native",
      event: AUTH_EVENT,
      action: "api_key.accepted",
      principal: `user:anaconda-fixture:${auth.subject}`,
      credential: "api-key",
      scope: "viewer",
      timestamp: undefined,
    },
  );
  assert.deepEqual(secretLines(capture.lines, [key]), []);
});

test("the OAuth flow records consent, code, tokens, reuse and revocation without secrets", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const capture = captureConsole(t);
  const secrets = [login.token, verifier];

  // A cancelled consent, then an approved one.
  const cancelled = await decide(env, login, await consentScreen(env, login), "cancel");
  assert.equal(cancelled.status, 303);
  const fields = await consentScreen(env, login);
  secrets.push(fields.consent_id, fields.csrf_token);
  const approved = await decide(env, login, fields, "approve");
  assert.equal(approved.status, 303);
  const code = new URL(approved.headers.get("location")).searchParams.get("code");
  secrets.push(code);

  const issued = await tokenRequest(env, {
    grant_type: "authorization_code",
    redirect_uri: kiloCallback,
    code_verifier: verifier,
    code,
  });
  assert.equal(issued.status, 200);
  const tokens = await issued.json();
  secrets.push(tokens.access_token, tokens.refresh_token);

  const refreshed = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  assert.equal(refreshed.status, 200);
  const next = await refreshed.json();
  secrets.push(next.access_token, next.refresh_token);

  // Presenting the spent refresh token again inside the reuse window issues
  // beside the first refresh.
  const beside = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  assert.equal(beside.status, 200);
  const other = await beside.json();
  secrets.push(other.access_token, other.refresh_token);

  // After the window it revokes the whole grant.
  env.DB.sqlite.exec("UPDATE pages_oauth_refresh_tokens SET consumed_at = consumed_at - 3600");
  const reused = await tokenRequest(env, {
    grant_type: "refresh_token",
    refresh_token: tokens.refresh_token,
  });
  assert.equal(reused.status, 400);

  // A second connection, revoked by the client (RFC 7009).
  const second = await decide(env, login, await consentScreen(env, login), "approve");
  const secondCode = new URL(second.headers.get("location")).searchParams.get("code");
  secrets.push(secondCode);
  const secondTokens = await (
    await tokenRequest(env, {
      grant_type: "authorization_code",
      redirect_uri: kiloCallback,
      code_verifier: verifier,
      code: secondCode,
    })
  ).json();
  secrets.push(secondTokens.access_token, secondTokens.refresh_token);
  const revoked = await handleOAuth(
    post("/oauth/revoke", { client_id: "pages-kilo", token: secondTokens.refresh_token }),
    env,
  );
  assert.equal(revoked.status, 200);

  // Replaying the first code revokes what it issued.
  const replayed = await tokenRequest(env, {
    grant_type: "authorization_code",
    redirect_uri: kiloCallback,
    code_verifier: verifier,
    code,
  });
  assert.equal(replayed.status, 400);

  assert.deepEqual(capture.actions(), [
    "oauth.consent_denied",
    "oauth.consent_granted",
    "oauth.code_issued",
    "oauth.token_issued",
    "oauth.token_issued",
    "oauth.refresh_reused",
    "oauth.token_issued",
    "oauth.refresh_reused",
    "oauth.grant_revoked",
    "oauth.token_refused",
    "oauth.consent_granted",
    "oauth.code_issued",
    "oauth.token_issued",
    "oauth.grant_revoked",
    "oauth.token_refused",
  ]);
  const [initial, refresh, besideRefresh, secondIssue] = capture.find("oauth.token_issued");
  assert.equal(besideRefresh.grant, initial.grant);
  assert.deepEqual(
    capture.find("oauth.refresh_reused").map(({ reason, grant }) => ({ reason, grant })),
    [
      { reason: "within_window", grant: initial.grant },
      { reason: undefined, grant: initial.grant },
    ],
  );
  for (const event of capture.events) {
    assert.equal(event.principal ?? principal, principal);
    assert.equal(event.client_id, "pages-kilo");
    assert.equal(event.credential, "oauth");
  }
  assert.match(initial.grant, /^[0-9a-f]{12}$/);
  assert.equal(refresh.grant, initial.grant);
  assert.notEqual(secondIssue.grant, initial.grant);
  assert.deepEqual(
    [initial, refresh].map(({ grant_type, refresh: hasRefresh, scope }) => ({
      grant_type,
      hasRefresh,
      scope,
    })),
    [
      { grant_type: "authorization_code", hasRefresh: true, scope: "pages:read pages:write" },
      { grant_type: "refresh_token", hasRefresh: true, scope: "pages:read pages:write" },
    ],
  );
  const [reuseRevoke, clientRevoke] = capture.find("oauth.grant_revoked");
  assert.deepEqual(
    { by: reuseRevoke.revoked_by, reason: reuseRevoke.reason, grant: reuseRevoke.grant },
    { by: "system", reason: "refresh_reused", grant: initial.grant },
  );
  assert.deepEqual(
    { by: clientRevoke.revoked_by, grant: clientRevoke.grant },
    { by: "rfc7009", grant: secondIssue.grant },
  );
  assert.deepEqual(
    capture.find("oauth.token_refused").map(({ reason, grant_type }) => ({ reason, grant_type })),
    [
      { reason: "invalid_grant", grant_type: "refresh_token" },
      { reason: "invalid_grant", grant_type: "authorization_code" },
    ],
  );
  assert.deepEqual(secretLines(capture.lines, secrets), []);
});

test("a replayed authorization code records the replay and the system revocation", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const code = new URL(
    (await decide(env, login, await consentScreen(env, login), "approve")).headers.get("location"),
  ).searchParams.get("code");
  const exchange = () =>
    tokenRequest(env, {
      grant_type: "authorization_code",
      redirect_uri: kiloCallback,
      code_verifier: verifier,
      code,
    });
  assert.equal((await exchange()).status, 200);
  const capture = captureConsole(t);
  assert.equal((await exchange()).status, 400);
  assert.deepEqual(capture.actions(), [
    "oauth.code_replayed",
    "oauth.grant_revoked",
    "oauth.token_refused",
  ]);
  const [replay, revoke] = capture.events;
  assert.equal(replay.principal, principal);
  assert.match(replay.grant, /^[0-9a-f]{12}$/);
  assert.deepEqual(
    { grant: revoke.grant, by: revoke.revoked_by, reason: revoke.reason },
    { grant: replay.grant, by: "system", reason: "code_replayed" },
  );
  assert.deepEqual(secretLines(capture.lines, [code]), []);
});

test("sign-out names the person who signed out and nothing else", async (t) => {
  const env = fixture(t);
  const login = await signIn(env);
  const capture = captureConsole(t);
  const response = await worker.fetch(
    new Request(origin + "/api/auth/logout", {
      method: "POST",
      headers: { Origin: origin, cookie: login.cookie },
    }),
    env,
  );
  assert.equal(response.status, 200);
  // A second sign-out with the same cookie has no session to name.
  await worker.fetch(
    new Request(origin + "/api/auth/logout", {
      method: "POST",
      headers: { Origin: origin, cookie: login.cookie },
    }),
    env,
  );
  assert.deepEqual(
    capture.events.map(({ action, principal: who, credential }) => ({ action, who, credential })),
    [{ action: "sign_out", who: principal, credential: "oidc" }],
  );
  assert.deepEqual(secretLines(capture.lines, [login.token]), []);
});

test("a refused sign-in callback records its coded reason and no callback values", async (t) => {
  const env = fixture(t);
  const capture = captureConsole(t);
  const state = "s".repeat(43);
  const response = await worker.fetch(
    new Request(`${origin}/oidc?state=${state}&code=provider-code`),
    env,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(
    capture.find("sign_in.failed").map(({ reason, phase, kind, outcome }) => ({
      reason,
      phase,
      kind,
      outcome,
    })),
    [
      {
        reason: "login_binding_missing",
        phase: "callback_transaction",
        kind: "callback_rejected",
        outcome: "failure_page",
      },
    ],
  );
  assert.deepEqual(secretLines(capture.lines, [state, "provider-code"]), []);
});

test("the secret scan flags every forbidden shape", () => {
  const samples = [
    `{"token":"pages_at_${"a".repeat(43)}"}`,
    `{"token":"pages_rt_${"a".repeat(43)}"}`,
    "authorization: Bearer abc",
    "https://pages.example/oidc?code=abc",
    "https://pages.example/oidc?state=abc",
    '{"principal":"person@example.invalid"}',
    `{"sealed":"${"i".repeat(16)}.${"c".repeat(24)}"}`,
  ];
  assert.equal(samples.length, SECRET_SHAPES.length);
  for (const sample of samples) assert.deepEqual(secretLines([sample]), [sample]);
  assert.deepEqual(
    secretLines(['{"event":"pages.auth.v1","action":"sign_out","principal":"user:anaconda:p"}']),
    [],
  );
});

// The auth suites' own console output, captured whole: OAuth endpoints and
// store, bearer and cookie authentication, Project invitations and sign-in
// callbacks. Test names and the runner's own lines are excluded; everything
// the code under test printed is scanned.
const AUTH_SUITES = [
  "worker/account-auth.test.mjs",
  "worker/oauth.test.mjs",
  "worker/oauth-store.test.mjs",
  "worker/oauth-auth.test.mjs",
  "worker/auth.test.mjs",
  "worker/project-membership.test.mjs",
  "worker/sign-in-failure.test.mjs",
];
test("the auth suites print no tokens, codes, state, emails or sealed values", () => {
  const env = { ...process.env };
  // Run as a standalone runner, not as a child reporting to this one.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--import", "tsx", "--test", "--test-reporter=spec", ...AUTH_SUITES],
    {
      cwd: new URL("../", import.meta.url),
      env: { ...env, TSX_TSCONFIG_PATH: "tsconfig.json" },
      encoding: "utf8",
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  assert.ifError(result.error);
  const output = `${result.stdout}\n${result.stderr}`;
  assert.equal(result.status, 0, output.slice(-4000));
  const printed = output
    .split("\n")
    .filter((line) => !/^\s*(?:[\u2714\u2716\u2139\u25b6]|$)/u.test(line));
  assert.ok(
    printed.some((line) => line.includes('"event":"pages.auth.v1"')),
    "the suites emitted auth events",
  );
  assert.deepEqual(secretLines(printed), []);
});
