import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { secretHash } from "@cloud/oidc-session-store.ts";
import {
  cleanupOAuthStore,
  consumeConsent,
  exchangeAuthorizationCode,
  issueAuthorizationCode,
  issueConsent,
  OAuthStoreError,
  readAccessToken,
  readConsent,
  revokeOAuthToken,
  rotateRefreshToken,
} from "./oauth-store.mjs";

// Actual SQLite, with D1 batches executed as transactions. Failure injection
// happens between statements so rollback protects more than a mocked call count.
class SqliteD1 {
  constructor(path) {
    this.sqlite = new DatabaseSync(path);
  }
  prepare(sql) {
    const connection = this.sqlite;
    const build = (values = []) => ({
      bind: (...next) => build(next),
      first: async () => connection.prepare(sql).get(...values) ?? null,
      all: async () => ({ success: true, results: connection.prepare(sql).all(...values) }),
      run: async () => {
        const result = connection.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
      execute: () => {
        const result = connection.prepare(sql).run(...values);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    });
    return build();
  }
  async batch(statements) {
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map((statement, index) => {
        if (this.failAt === index) {
          this.failAt = undefined;
          throw new Error("injected database failure");
        }
        return statement.execute();
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
}
const origin = "https://page7.example";
const resource = `${origin}/mcp`;
const start = 1_800_000_000;
const verifier = "v".repeat(43);
const identity = {
  principal: "user:anaconda:person",
  namespace: "user:anaconda",
  displayName: "Example Person",
  canWrite: true,
  expiresAt: start + 60,
  emailProof: {
    provider: "app-session",
    principalNamespace: "user:anaconda",
    identityVerifiedAt: start - 100,
    verifiedEmailBinding: "original-proof",
  },
  access_token: "must-not-store-provider-token",
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "pages-oauth-store-"));
  const path = join(directory, "store.sqlite");
  const env = {
    NOTEBOOK_CLOUD_PUBLIC_ORIGIN: origin,
    NOTEBOOK_CLOUD_OIDC_ISSUER: "https://issuer.example",
    NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "oidc-client",
    NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "user:anaconda",
    DB: new SqliteD1(path),
  };
  t.after(() => {
    env.DB.sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    env,
    path,
    restart() {
      env.DB.sqlite.close();
      env.DB = new SqliteD1(path);
    },
  };
}
async function request(scope = "pages:read pages:write") {
  return {
    clientId: "https://client.example/metadata.json",
    redirectUri: "https://client.example/callback",
    resource,
    scope,
    codeChallenge: await secretHash(verifier),
    state: "client-state",
  };
}
async function authorize(f, scope, now = start) {
  const input = { ...(await request(scope)), allowRefresh: true };
  const { code } = await issueAuthorizationCode(f.env, { ...input, identity }, { now });
  return {
    input,
    code,
    exchange: {
      code,
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      resource,
      codeVerifier: verifier,
    },
  };
}
async function grant(f, scope, now = start) {
  const authorization = await authorize(f, scope, now);
  return {
    ...authorization,
    tokens: await exchangeAuthorizationCode(f.env, authorization.exchange, { now }),
  };
}
const invalidGrant = (error) => error instanceof OAuthStoreError && error.error === "invalid_grant";

function legacyCodeSchema(f) {
  f.env.DB.sqlite.exec(`CREATE TABLE pages_oauth_codes (
    code_hash TEXT PRIMARY KEY, context TEXT NOT NULL, client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
    challenge TEXT NOT NULL, identity_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
    consumed_by TEXT
  )`);
}
async function legacyCode(f, scope, character) {
  const input = await request(scope);
  const code = character.repeat(43);
  const context = JSON.stringify([
    origin,
    f.env.NOTEBOOK_CLOUD_OIDC_ISSUER,
    f.env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
    f.env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE,
    "",
  ]);
  f.env.DB.sqlite
    .prepare(`INSERT INTO pages_oauth_codes
      (code_hash, context, client_id, redirect_uri, resource, scope, challenge, identity_json, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      await secretHash(code),
      context,
      input.clientId,
      input.redirectUri,
      resource,
      scope,
      input.codeChallenge,
      JSON.stringify({ principal: identity.principal, namespace: identity.namespace }),
      start + 300,
    );
  return {
    code,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    resource,
    codeVerifier: verifier,
  };
}

test("additive migration preserves old code consent and legacy offline_access refresh", async (t) => {
  const f = fixture(t);
  legacyCodeSchema(f);
  const transient = await legacyCode(f, "pages:read pages:write", "a");
  const persistent = await legacyCode(f, "offline_access pages:read", "b");
  const tokens = await exchangeAuthorizationCode(f.env, transient, { now: start });
  assert.equal(tokens.refresh_token, undefined);
  assert.equal(tokens.expires_in, 600);
  assert.equal(await readAccessToken(f.env, tokens.access_token, { now: start + 600 }), null);
  assert.deepEqual(
    f.env.DB.sqlite
      .prepare("SELECT allow_refresh FROM pages_oauth_codes")
      .all()
      .map((row) => row.allow_refresh),
    [0, 0],
  );
  f.restart();
  const approved = await exchangeAuthorizationCode(f.env, persistent, { now: start + 1 });
  assert.match(approved.refresh_token, /^pages_rt_/);
  assert.equal(approved.scope, "offline_access pages:read");
  const narrowed = await rotateRefreshToken(
    f.env,
    {
      refreshToken: approved.refresh_token,
      clientId: persistent.clientId,
      resource,
      scope: "pages:read",
    },
    { now: start + 601 },
  );
  assert.equal(narrowed.scope, "pages:read");
  assert.match(narrowed.refresh_token, /^pages_rt_/);
});

test("two isolates can race the additive refresh-consent migration", async (t) => {
  const f = fixture(t);
  legacyCodeSchema(f);
  const one = await legacyCode(f, "pages:read", "a");
  const two = await legacyCode(f, "pages:read", "b");
  const second = { ...f.env, DB: new SqliteD1(f.path) };
  t.after(() => second.DB.sqlite.close());
  let readers = 0,
    release;
  const bothRead = new Promise((resolve) => {
    release = resolve;
  });
  for (const db of [f.env.DB, second.DB]) {
    const prepare = db.prepare.bind(db);
    t.mock.method(db, "prepare", (sql) => {
      const query = prepare(sql);
      if (sql !== "PRAGMA table_info(pages_oauth_codes)") return query;
      return {
        ...query,
        all: async () => {
          const result = await query.all();
          if (!result.results.some((column) => column.name === "allow_refresh")) {
            if (++readers === 2) release();
            await bothRead;
          }
          return result;
        },
      };
    });
  }
  const results = await Promise.all([
    exchangeAuthorizationCode(f.env, one, { now: start }),
    exchangeAuthorizationCode(second, two, { now: start }),
  ]);
  assert.equal(readers, 2);
  assert.ok(results.every((tokens) => tokens.refresh_token === undefined));
  assert.equal(f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_grants").get().n, 2);
});

test("failed refresh-consent migration fails closed and retries instead of caching readiness", async (t) => {
  const f = fixture(t);
  legacyCodeSchema(f);
  const code = await legacyCode(f, "pages:read", "a");
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  const mock = t.mock.method(f.env.DB, "prepare", (sql) => {
    if (sql.startsWith("ALTER TABLE pages_oauth_codes")) throw new Error("migration unavailable");
    return prepare(sql);
  });
  await assert.rejects(
    exchangeAuthorizationCode(f.env, code, { now: start }),
    /migration unavailable/,
  );
  assert.equal(
    f.env.DB.sqlite.prepare("SELECT consumed_by FROM pages_oauth_codes").get().consumed_by,
    null,
  );
  mock.mock.restore();
  const tokens = await exchangeAuthorizationCode(f.env, code, { now: start });
  assert.equal(tokens.refresh_token, undefined);
});

test("consent binds session, account, context and CSRF; consumption is atomic and expires", async (t) => {
  const f = fixture(t),
    input = await request();
  const consent = await issueConsent(
    f.env,
    { request: input, sessionId: "session", principal: identity.principal },
    { now: start },
  );
  const binding = {
    consentId: consent.consentId,
    csrfToken: consent.csrfToken,
    sessionId: "session",
    principal: identity.principal,
  };
  assert.equal(
    await consumeConsent(f.env, { ...binding, csrfToken: "x".repeat(43) }, { now: start }),
    null,
  );
  assert.equal(
    await consumeConsent(f.env, { ...binding, principal: "another" }, { now: start }),
    null,
  );
  assert.equal(
    await readConsent(f.env, { ...binding, sessionId: "different" }, { now: start }),
    null,
  );
  assert.equal(
    await readConsent({ ...f.env, NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "changed" }, binding, {
      now: start,
    }),
    null,
  );
  f.restart();
  const results = await Promise.all([
    consumeConsent(f.env, binding, { now: start }),
    consumeConsent(f.env, binding, { now: start }),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(results.find(Boolean).state, input.state);
  const expired = await issueConsent(
    f.env,
    { request: input, sessionId: "session", principal: identity.principal },
    { now: start },
  );
  assert.equal(await consumeConsent(f.env, { ...binding, ...expired }, { now: start + 600 }), null);
});

test("bad code bindings never consume; single exchange survives restart and stores hashes only", async (t) => {
  const f = fixture(t),
    a = await authorize(f);
  for (const changed of [
    { clientId: "other" },
    { redirectUri: `${a.input.redirectUri}/other` },
    { resource: "https://other.example/mcp" },
    { codeVerifier: "x".repeat(43) },
  ])
    await assert.rejects(
      exchangeAuthorizationCode(f.env, { ...a.exchange, ...changed }, { now: start }),
      invalidGrant,
    );
  await assert.rejects(
    exchangeAuthorizationCode(
      { ...f.env, NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE: "changed" },
      a.exchange,
      { now: start },
    ),
    invalidGrant,
  );
  f.restart();
  const tokens = await exchangeAuthorizationCode(f.env, a.exchange, { now: start });
  assert.equal(tokens.expires_in, 600);
  assert.match(tokens.access_token, /^pages_at_/);
  assert.match(tokens.refresh_token, /^pages_rt_/);
  const saved = await readAccessToken(f.env, tokens.access_token, { resource, now: start });
  assert.equal(saved.identity.principal, identity.principal);
  assert.deepEqual(saved.identity.emailProof, identity.emailProof);
  assert.equal(saved.identity.canWrite, undefined);
  assert.equal(saved.identity.access_token, undefined);
  assert.equal(
    await readAccessToken(f.env, tokens.access_token, {
      resource: "https://other.example/mcp",
      now: start,
    }),
    null,
  );
  for (const key of [
    "NOTEBOOK_CLOUD_PUBLIC_ORIGIN",
    "NOTEBOOK_CLOUD_OIDC_ISSUER",
    "NOTEBOOK_CLOUD_OIDC_CLIENT_ID",
    "NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE",
  ])
    assert.equal(
      await readAccessToken(
        {
          ...f.env,
          [key]:
            key.endsWith("ORIGIN") || key.endsWith("ISSUER")
              ? "https://changed.example"
              : "changed",
        },
        tokens.access_token,
        { resource, now: start },
      ),
      null,
    );
  const dump = ["codes", "grants", "access_tokens", "refresh_tokens"].map((name) =>
    f.env.DB.sqlite.prepare(`SELECT * FROM pages_oauth_${name}`).all(),
  );
  const text = JSON.stringify(dump);
  for (const secret of [
    a.code,
    verifier,
    tokens.access_token,
    tokens.refresh_token,
    identity.access_token,
  ])
    assert.equal(text.includes(secret), false);
  await assert.rejects(exchangeAuthorizationCode(f.env, a.exchange, { now: start }), invalidGrant);
});

test("code expiry and concurrent exchange yield at most one grant", async (t) => {
  const f = fixture(t),
    expired = await authorize(f);
  await assert.rejects(
    exchangeAuthorizationCode(f.env, expired.exchange, { now: start + 300 }),
    invalidGrant,
  );
  const fresh = await authorize(f);
  let codeReads = 0,
    release;
  const bothRead = new Promise((resolve) => {
    release = resolve;
  });
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  t.mock.method(f.env.DB, "prepare", (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT * FROM pages_oauth_codes")) return statement;
    return {
      ...statement,
      bind(...values) {
        const bound = statement.bind(...values);
        return {
          ...bound,
          async first() {
            const row = await bound.first();
            assert.equal(row.consumed_by, null);
            if (++codeReads === 2) release();
            await bothRead;
            return row;
          },
        };
      },
    };
  });
  const results = await Promise.allSettled([
    exchangeAuthorizationCode(f.env, fresh.exchange, { now: start }),
    exchangeAuthorizationCode(f.env, fresh.exchange, { now: start }),
  ]);
  assert.equal(
    codeReads,
    2,
    "both exchanges observed an unconsumed code before either transaction",
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_grants").get().n, 1);
  const winner = results.find((result) => result.status === "fulfilled").value;
  assert.equal(await readAccessToken(f.env, winner.access_token, { now: start }), null);
  await assert.rejects(
    rotateRefreshToken(
      f.env,
      {
        refreshToken: winner.refresh_token,
        clientId: fresh.input.clientId,
        resource,
      },
      { now: start },
    ),
    invalidGrant,
  );
});

test("exchange batch failure rolls back code consumption and partial credentials", async (t) => {
  const f = fixture(t),
    a = await authorize(f);
  f.env.DB.failAt = 3;
  await assert.rejects(exchangeAuthorizationCode(f.env, a.exchange, { now: start }), /injected/);
  assert.equal(
    f.env.DB.sqlite.prepare("SELECT consumed_by FROM pages_oauth_codes").get().consumed_by,
    null,
  );
  assert.equal(f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_grants").get().n, 0);
  f.restart();
  const token = await exchangeAuthorizationCode(f.env, a.exchange, { now: start });
  assert.ok(await readAccessToken(f.env, token.access_token, { now: start }));
});

test("new consent without offline_access refreshes after ten-minute access expiry without adding scopes", async (t) => {
  const f = fixture(t),
    g = await grant(f, "pages:read pages:write");
  assert.match(g.tokens.refresh_token, /^pages_rt_/);
  assert.equal(g.tokens.scope, "pages:read pages:write");
  assert.ok(await readAccessToken(f.env, g.tokens.access_token, { now: start + 599 }));
  assert.equal(await readAccessToken(f.env, g.tokens.access_token, { now: start + 600 }), null);
  f.restart();
  const renewed = await rotateRefreshToken(
    f.env,
    { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource },
    { now: start + 601 },
  );
  assert.equal(renewed.scope, g.tokens.scope);
  assert.equal(renewed.expires_in, 600);
  assert.notEqual(renewed.refresh_token, g.tokens.refresh_token);
  assert.ok(await readAccessToken(f.env, renewed.access_token, { now: start + 601 }));
});

test("refresh narrows scopes, preserves original proof, and cannot extend absolute expiry", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  for (const changed of [{ clientId: "other" }, { resource: "https://other.example/mcp" }])
    await assert.rejects(
      rotateRefreshToken(f.env, { ...binding, ...changed }, { now: start + 20 }),
      invalidGrant,
    );
  await assert.rejects(
    rotateRefreshToken(f.env, { ...binding, scope: "admin" }, { now: start + 20 }),
    { error: "invalid_scope" },
  );
  f.restart();
  const first = await rotateRefreshToken(
    f.env,
    { ...binding, scope: "pages:read" },
    { now: start + 600 },
  );
  const saved = await readAccessToken(f.env, first.access_token, { now: start + 600 });
  assert.deepEqual(saved.identity.emailProof, identity.emailProof);
  assert.equal(saved.scope.includes("pages:write"), false);
  assert.match(first.refresh_token, /^pages_rt_/);
  await assert.rejects(
    rotateRefreshToken(
      f.env,
      {
        ...binding,
        refreshToken: first.refresh_token,
        scope: "pages:read pages:write",
      },
      { now: start + 601 },
    ),
    { error: "invalid_scope" },
  );
  const expiry = start + 30 * 24 * 60 * 60;
  const final = await rotateRefreshToken(
    f.env,
    { ...binding, refreshToken: first.refresh_token },
    { now: expiry - 5 },
  );
  assert.equal(final.expires_in, 5);
  assert.equal(await readAccessToken(f.env, final.access_token, { now: expiry }), null);
  await assert.rejects(
    rotateRefreshToken(f.env, { ...binding, refreshToken: final.refresh_token }, { now: expiry }),
    invalidGrant,
  );
});

test("refresh concurrency detects consumed replay and revokes all descendants", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  const results = await Promise.allSettled([
    rotateRefreshToken(f.env, binding, { now: start + 1 }),
    rotateRefreshToken(f.env, binding, { now: start + 1 }),
  ]);
  const successful = results.filter((result) => result.status === "fulfilled");
  assert.equal(successful.length, 1);
  assert.equal(
    await readAccessToken(f.env, successful[0].value.access_token, { now: start + 1 }),
    null,
  );
  assert.equal(await readAccessToken(f.env, g.tokens.access_token, { now: start + 1 }), null);
  await assert.rejects(
    rotateRefreshToken(
      f.env,
      { ...binding, refreshToken: successful[0].value.refresh_token },
      { now: start + 2 },
    ),
    invalidGrant,
  );
});

test("refresh transaction failure preserves old token; explicit revocation cannot be undone", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  f.env.DB.failAt = 3;
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: start + 1 }), /injected/);
  const second = await rotateRefreshToken(f.env, binding, { now: start + 1 });
  await revokeOAuthToken(
    f.env,
    { token: second.access_token, clientId: "other" },
    { now: start + 2 },
  );
  assert.ok(await readAccessToken(f.env, second.access_token, { now: start + 2 }));
  await revokeOAuthToken(
    f.env,
    { token: g.tokens.refresh_token, clientId: g.input.clientId },
    { now: start + 3 },
  );
  f.restart();
  assert.equal(await readAccessToken(f.env, second.access_token, { now: start + 3 }), null);
  await assert.rejects(
    rotateRefreshToken(
      f.env,
      { ...binding, refreshToken: second.refresh_token },
      { now: start + 3 },
    ),
    invalidGrant,
  );
});

test("cleanup is bounded and retains consumed refresh records until family expiry", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  await rotateRefreshToken(
    f.env,
    { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource },
    { now: start + 1 },
  );
  await cleanupOAuthStore(f.env, { now: start + 1000, limit: 1 });
  assert.equal(
    f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_refresh_tokens").get().n,
    2,
  );
  const expiry = start + 30 * 24 * 60 * 60;
  await cleanupOAuthStore(f.env, { now: expiry, limit: 1 });
  assert.equal(
    f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_refresh_tokens").get().n,
    1,
  );
  await cleanupOAuthStore(f.env, { now: expiry, limit: 1 });
  assert.equal(
    f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_refresh_tokens").get().n,
    0,
  );
});

test("wrong-client replay cannot revoke and readonly refresh cannot gain write", async (t) => {
  const f = fixture(t),
    g = await grant(f, "pages:read offline_access");
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  await assert.rejects(
    rotateRefreshToken(
      f.env,
      { ...binding, scope: "pages:read pages:write offline_access" },
      { now: start },
    ),
    { error: "invalid_scope" },
  );
  const fresh = await rotateRefreshToken(f.env, binding, { now: start + 1 });
  await assert.rejects(
    rotateRefreshToken(f.env, { ...binding, clientId: "attacker" }, { now: start + 2 }),
    invalidGrant,
  );
  assert.ok(await readAccessToken(f.env, fresh.access_token, { now: start + 2 }));
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: start + 2 }), invalidGrant);
  assert.equal(await readAccessToken(f.env, fresh.access_token, { now: start + 2 }), null);
});

test("revocation racing refresh never resurrects an active family", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const results = await Promise.allSettled([
    rotateRefreshToken(
      f.env,
      { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource },
      { now: start + 1 },
    ),
    revokeOAuthToken(
      f.env,
      { token: g.tokens.refresh_token, clientId: g.input.clientId },
      { now: start + 1 },
    ),
  ]);
  assert.equal(results[1].status, "fulfilled");
  assert.equal(await readAccessToken(f.env, g.tokens.access_token, { now: start + 2 }), null);
  if (results[0].status === "fulfilled")
    assert.equal(
      await readAccessToken(f.env, results[0].value.access_token, { now: start + 2 }),
      null,
    );
  assert.notEqual(
    f.env.DB.sqlite.prepare("SELECT revoked_at FROM pages_oauth_grants").get().revoked_at,
    null,
  );
});

test("code replay requires original bindings and revokes refresh descendants after restart and code expiry", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const refreshed = await rotateRefreshToken(
    f.env,
    {
      refreshToken: g.tokens.refresh_token,
      clientId: g.input.clientId,
      resource,
    },
    { now: start + 600 },
  );
  f.restart();
  await cleanupOAuthStore(f.env, { now: start + 1000 });
  assert.equal(
    f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_codes").get().n,
    1,
    "consumed code remains replay evidence while its grant is alive",
  );
  for (const changed of [
    { clientId: "other" },
    { redirectUri: `${g.input.redirectUri}/other` },
    { resource: "https://other.example/mcp" },
    { codeVerifier: "x".repeat(43) },
    { codeVerifier: "invalid" },
  ]) {
    await assert.rejects(
      exchangeAuthorizationCode(f.env, { ...g.exchange, ...changed }, { now: start + 1000 }),
      invalidGrant,
    );
    assert.ok(await readAccessToken(f.env, refreshed.access_token, { now: start + 1000 }));
  }
  await assert.rejects(
    exchangeAuthorizationCode({ ...f.env, NOTEBOOK_CLOUD_OIDC_CLIENT_ID: "changed" }, g.exchange, {
      now: start + 1000,
    }),
    invalidGrant,
  );
  assert.ok(await readAccessToken(f.env, refreshed.access_token, { now: start + 1000 }));
  await assert.rejects(
    exchangeAuthorizationCode(f.env, g.exchange, { now: start + 1000 }),
    invalidGrant,
  );
  f.restart();
  assert.equal(await readAccessToken(f.env, refreshed.access_token, { now: start + 1000 }), null);
  await assert.rejects(
    rotateRefreshToken(
      f.env,
      {
        refreshToken: refreshed.refresh_token,
        clientId: g.input.clientId,
        resource,
      },
      { now: start + 1000 },
    ),
    invalidGrant,
  );
  assert.equal(f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_grants").get().n, 1);
  await cleanupOAuthStore(f.env, { now: start + 30 * 24 * 60 * 60 });
  assert.equal(f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_codes").get().n, 0);
});

test("failed code replay transaction cannot leave partial revocation or issue another grant", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  f.env.DB.failAt = 1;
  await assert.rejects(
    exchangeAuthorizationCode(f.env, g.exchange, { now: start + 1 }),
    /injected/,
  );
  assert.ok(await readAccessToken(f.env, g.tokens.access_token, { now: start + 1 }));
  assert.equal(f.env.DB.sqlite.prepare("SELECT count(*) AS n FROM pages_oauth_grants").get().n, 1);
  await assert.rejects(
    exchangeAuthorizationCode(f.env, g.exchange, { now: start + 1 }),
    invalidGrant,
  );
  assert.equal(await readAccessToken(f.env, g.tokens.access_token, { now: start + 1 }), null);
});
