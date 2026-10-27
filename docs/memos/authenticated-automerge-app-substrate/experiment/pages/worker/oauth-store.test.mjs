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
    restart() {
      env.DB.sqlite.close();
      env.DB = new SqliteD1(path);
    },
  };
}
async function request(scope = "pages:read pages:write offline_access") {
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
  const input = await request(scope);
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

test("no offline scope means no refresh and access expires after ten minutes", async (t) => {
  const f = fixture(t),
    g = await grant(f, "pages:read");
  assert.equal(g.tokens.refresh_token, undefined);
  assert.ok(await readAccessToken(f.env, g.tokens.access_token, { now: start + 599 }));
  assert.equal(await readAccessToken(f.env, g.tokens.access_token, { now: start + 600 }), null);
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
    { ...binding, scope: "pages:read offline_access" },
    { now: start + 600 },
  );
  const saved = await readAccessToken(f.env, first.access_token, { now: start + 600 });
  assert.deepEqual(saved.identity.emailProof, identity.emailProof);
  assert.equal(saved.scope.includes("pages:write"), false);
  await assert.rejects(
    rotateRefreshToken(
      f.env,
      {
        ...binding,
        refreshToken: first.refresh_token,
        scope: "pages:read pages:write offline_access",
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
