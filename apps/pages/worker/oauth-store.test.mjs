import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { secretHash } from "@cloud/oidc-session-store.ts";
import { captureConsole } from "./auth-events-fixture.mjs";
import {
  cleanupOAuthStore,
  consumeConsent,
  exchangeAuthorizationCode,
  grantHandle,
  issueAuthorizationCode,
  issueConsent,
  listGrantsFor,
  OAuthStoreError,
  readAccessToken,
  readConsent,
  revokeGrantFor,
  revokeGrantsFor,
  revokeOAuthToken,
  rotateRefreshToken,
} from "./oauth-store.mjs";
import { OAUTH_REFRESH_REUSE_SECONDS } from "../shared/oauth-grant.mjs";

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
const origin = "https://page10.example";
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
async function authorize(f, scope, now = start, who = identity) {
  const input = { ...(await request(scope)), allowRefresh: true };
  const { code } = await issueAuthorizationCode(f.env, { ...input, identity: who }, { now });
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
async function grant(f, scope, now = start, who = identity) {
  const authorization = await authorize(f, scope, now, who);
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

const spentAt = (f) =>
  f.env.DB.sqlite
    .prepare("SELECT consumed_at FROM pages_oauth_refresh_tokens WHERE consumed_by IS NOT NULL")
    .all()
    .map((row) => row.consumed_at);
const revokedAt = (f) =>
  f.env.DB.sqlite.prepare("SELECT revoked_at FROM pages_oauth_grants").get().revoked_at;

test("overlapping refreshes of one token each get their own tokens and keep the grant", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  const capture = captureConsole(t);
  const [one, two] = await Promise.all([
    rotateRefreshToken(f.env, binding, { now: start + 1 }),
    rotateRefreshToken(f.env, binding, { now: start + 1 }),
  ]);
  assert.notEqual(one.access_token, two.access_token);
  assert.notEqual(one.refresh_token, two.refresh_token);
  assert.deepEqual(spentAt(f), [start + 1]);
  assert.equal(revokedAt(f), null);
  assert.deepEqual(capture.actions().sort(), [
    "oauth.refresh_reused",
    "oauth.token_issued",
    "oauth.token_issued",
  ]);
  assert.equal(capture.find("oauth.refresh_reused")[0].reason, "within_window");
  // The last second of the window still issues, and narrows scope like a first use.
  const edge = start + 1 + OAUTH_REFRESH_REUSE_SECONDS;
  const three = await rotateRefreshToken(f.env, { ...binding, scope: "pages:read" }, { now: edge });
  assert.equal(three.scope, "pages:read");
  // Each pair is a line of its own: every one reads and refreshes.
  for (const tokens of [one, two, three]) {
    assert.ok(await readAccessToken(f.env, tokens.access_token, { now: edge }));
    const next = await rotateRefreshToken(
      f.env,
      { ...binding, refreshToken: tokens.refresh_token },
      { now: edge },
    );
    assert.ok(await readAccessToken(f.env, next.access_token, { now: edge }));
  }
  assert.equal(revokedAt(f), null);
});

test("a refresh token reused after the window revokes the grant and every descendant", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  const first = await rotateRefreshToken(f.env, binding, { now: start + 1 });
  const beside = await rotateRefreshToken(f.env, binding, { now: start + 2 });
  const late = start + 2 + OAUTH_REFRESH_REUSE_SECONDS;
  const capture = captureConsole(t);
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: late }), invalidGrant);
  assert.equal(revokedAt(f), late);
  assert.deepEqual(capture.actions(), ["oauth.refresh_reused", "oauth.grant_revoked"]);
  assert.equal(capture.find("oauth.refresh_reused")[0].reason, undefined);
  for (const tokens of [g.tokens, first, beside]) {
    assert.equal(await readAccessToken(f.env, tokens.access_token, { now: late }), null);
    await assert.rejects(
      rotateRefreshToken(f.env, { ...binding, refreshToken: tokens.refresh_token }, { now: late }),
      invalidGrant,
    );
  }
});

test("a token spent with no recorded time is outside the window", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  const first = await rotateRefreshToken(f.env, binding, { now: start + 1 });
  // What a row spent before the column existed looks like.
  f.env.DB.sqlite.exec("UPDATE pages_oauth_refresh_tokens SET consumed_at = NULL");
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: start + 1 }), invalidGrant);
  assert.equal(revokedAt(f), start + 1);
  assert.equal(await readAccessToken(f.env, first.access_token, { now: start + 1 }), null);
});

test("a revoked grant issues nothing inside the window", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  const first = await rotateRefreshToken(f.env, binding, { now: start + 1 });
  await revokeOAuthToken(
    f.env,
    { token: first.refresh_token, clientId: g.input.clientId },
    { now: start + 2 },
  );
  const issued = () =>
    f.env.DB.sqlite
      .prepare(
        `SELECT (SELECT count(*) FROM pages_oauth_access_tokens) +
      (SELECT count(*) FROM pages_oauth_refresh_tokens) AS n`,
      )
      .get().n;
  const before = issued();
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: start + 2 }), invalidGrant);
  assert.equal(issued(), before);
});

// Runs `between` after rotateRefreshToken has read the token's row and before
// its batch, once. This is the stale read a concurrent request works from.
function afterRefreshRead(t, f, between) {
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  let pending = between;
  t.mock.method(f.env.DB, "prepare", (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith("SELECT r.scope AS token_scope")) return statement;
    return {
      ...statement,
      bind(...values) {
        const bound = statement.bind(...values);
        return {
          ...bound,
          async first() {
            const row = await bound.first();
            const run = pending;
            pending = null;
            if (run) await run(row);
            return row;
          },
        };
      },
    };
  });
}
const tokenRows = (f) =>
  f.env.DB.sqlite
    .prepare(
      `SELECT (SELECT count(*) FROM pages_oauth_access_tokens) +
      (SELECT count(*) FROM pages_oauth_refresh_tokens) AS n`,
    )
    .get().n;

test("a grant revoked after the read of a reusable token issues nothing", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  const first = await rotateRefreshToken(f.env, binding, { now: start + 1 });
  let before;
  afterRefreshRead(t, f, async (row) => {
    assert.notEqual(row.consumed_by, null, "the read saw a spent token");
    assert.equal(row.revoked_at, null, "and a live grant");
    await revokeOAuthToken(
      f.env,
      { token: first.refresh_token, clientId: g.input.clientId },
      { now: start + 2 },
    );
    before = tokenRows(f);
  });
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: start + 2 }), invalidGrant);
  assert.equal(tokenRows(f), before);
});

test("a late replay that lands between a reuse's read and its batch stops the reuse", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  const first = await rotateRefreshToken(f.env, binding, { now: start + 1 });
  const late = start + 2 + OAUTH_REFRESH_REUSE_SECONDS;
  let before;
  afterRefreshRead(t, f, async () => {
    await assert.rejects(rotateRefreshToken(f.env, binding, { now: late }), invalidGrant);
    before = tokenRows(f);
  });
  // This request is inside the window by its own clock, and read a live grant.
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: start + 2 }), invalidGrant);
  assert.equal(tokenRows(f), before);
  assert.equal(revokedAt(f), late);
  assert.equal(await readAccessToken(f.env, first.access_token, { now: late }), null);
});

test("a row spent before consumed_at existed stays strict after the column is added", async (t) => {
  const f = fixture(t),
    g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  await rotateRefreshToken(f.env, binding, { now: start + 1 });
  // The table as it shipped before the column, with its rows.
  f.env.DB.sqlite.exec(`
    CREATE TABLE refresh_before (
      token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL,
      scope TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_by TEXT
    );
    INSERT INTO refresh_before SELECT token_hash, grant_id, scope, expires_at, consumed_by
      FROM pages_oauth_refresh_tokens;
    DROP TABLE pages_oauth_refresh_tokens;
    ALTER TABLE refresh_before RENAME TO pages_oauth_refresh_tokens;
  `);
  f.restart();
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: start + 1 }), invalidGrant);
  assert.deepEqual(spentAt(f), [null]);
  assert.equal(revokedAt(f), start + 1);
});

test("a refresh table created before consumed_at gains the column for new uses", async (t) => {
  const f = fixture(t);
  f.env.DB.sqlite.exec(`CREATE TABLE pages_oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL,
    scope TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_by TEXT
  )`);
  const g = await grant(f);
  const binding = { refreshToken: g.tokens.refresh_token, clientId: g.input.clientId, resource };
  await rotateRefreshToken(f.env, binding, { now: start + 1 });
  assert.deepEqual(spentAt(f), [start + 1]);
  await rotateRefreshToken(f.env, binding, { now: start + 2 });
  assert.equal(revokedAt(f), null);
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
  // The client's own reuse after the window does revoke.
  const late = start + 2 + OAUTH_REFRESH_REUSE_SECONDS;
  await assert.rejects(
    rotateRefreshToken(f.env, { ...binding, clientId: "attacker" }, { now: late }),
    invalidGrant,
  );
  assert.ok(await readAccessToken(f.env, fresh.access_token, { now: late }));
  await assert.rejects(rotateRefreshToken(f.env, binding, { now: late }), invalidGrant);
  assert.equal(await readAccessToken(f.env, fresh.access_token, { now: late }), null);
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

const other = { ...identity, principal: "user:anaconda:other", displayName: "Other Person" };
const storeContext = (env) =>
  JSON.stringify([
    origin,
    env.NOTEBOOK_CLOUD_OIDC_ISSUER,
    env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID,
    env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE,
    "",
  ]);
// The grants table as it shipped before `principal` and `created_at`.
function legacyGrantSchema(f) {
  f.env.DB.sqlite.exec(`CREATE TABLE pages_oauth_grants (
    id TEXT PRIMARY KEY, context TEXT NOT NULL, client_id TEXT NOT NULL,
    resource TEXT NOT NULL, scope TEXT NOT NULL, identity_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER
  )`);
}
function insertLegacyGrants(f, rows) {
  const insert = f.env.DB.sqlite.prepare(`INSERT INTO pages_oauth_grants
    (id, context, client_id, resource, scope, identity_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  f.env.DB.sqlite.exec("BEGIN");
  for (const { id, identityJson, expiresAt = start + 3600 } of rows)
    insert.run(
      id,
      storeContext(f.env),
      "pages-kilo",
      resource,
      "pages:read",
      identityJson,
      expiresAt,
    );
  f.env.DB.sqlite.exec("COMMIT");
}
const grantColumn = (f, column, id) =>
  f.env.DB.sqlite.prepare(`SELECT ${column} AS value FROM pages_oauth_grants WHERE id = ?`).get(id)
    .value;
const legacyId = (n) => `legacy${String(n).padStart(37, "0")}`;

test("old grants gain an indexed principal from their identity snapshot", async (t) => {
  const f = fixture(t);
  legacyGrantSchema(f);
  insertLegacyGrants(f, [
    { id: legacyId(1), identityJson: JSON.stringify({ principal: identity.principal }) },
    { id: legacyId(2), identityJson: JSON.stringify({ principal: other.principal }) },
    { id: legacyId(3), identityJson: "not json" },
  ]);
  const listed = await listGrantsFor(f.env, identity.principal, { now: start });
  assert.deepEqual(
    listed.map(({ clientId, createdAt }) => ({ clientId, createdAt })),
    [{ clientId: "pages-kilo", createdAt: null }],
  );
  assert.equal(listed[0].handle, await grantHandle(legacyId(1)));
  assert.equal(grantColumn(f, "principal", legacyId(2)), other.principal);
  // An unreadable snapshot matches no account and leaves the backfill window.
  assert.equal(grantColumn(f, "principal", legacyId(3)), "");
  const plan = f.env.DB.sqlite
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM pages_oauth_grants WHERE principal = ?")
    .all("x")
    .map((row) => row.detail)
    .join(" ");
  assert.match(plan, /pages_oauth_grants_principal/);
  // New grants carry their principal and issue time from the start.
  const g = await grant(f, "pages:read", start + 5);
  const row = f.env.DB.sqlite
    .prepare("SELECT principal, created_at FROM pages_oauth_grants WHERE created_at IS NOT NULL")
    .get();
  assert.deepEqual({ ...row }, { principal: identity.principal, created_at: start + 5 });
  assert.ok(g.tokens.access_token);
});

test("setup backfills a bounded number of grants and each account read fills more", async (t) => {
  const f = fixture(t);
  legacyGrantSchema(f);
  // More rows than setup's 20 batches of 500.
  const total = 10_250;
  insertLegacyGrants(
    f,
    Array.from({ length: total }, (_, n) => ({
      id: legacyId(n),
      identityJson: JSON.stringify({ principal: n % 2 ? identity.principal : other.principal }),
    })),
  );
  const missing = () =>
    f.env.DB.sqlite
      .prepare("SELECT count(*) AS n FROM pages_oauth_grants WHERE principal IS NULL")
      .get().n;
  await cleanupOAuthStore(f.env, { now: start });
  assert.equal(missing(), total - 10_000);
  await listGrantsFor(f.env, other.principal, { now: start });
  assert.equal(missing(), 0);
});

test("two isolates can race the grant principal migration", async (t) => {
  const f = fixture(t);
  legacyGrantSchema(f);
  insertLegacyGrants(f, [
    { id: legacyId(1), identityJson: JSON.stringify({ principal: identity.principal }) },
  ]);
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
      if (sql !== "PRAGMA table_info(pages_oauth_grants)") return query;
      return {
        ...query,
        all: async () => {
          const result = await query.all();
          if (!result.results.some((column) => column.name === "principal")) {
            if (++readers === 2) release();
            await bothRead;
          }
          return result;
        },
      };
    });
  }
  const results = await Promise.all([
    listGrantsFor(f.env, identity.principal, { now: start }),
    listGrantsFor(second, identity.principal, { now: start }),
  ]);
  assert.equal(readers, 2);
  assert.deepEqual(
    results.map((rows) => rows.length),
    [1, 1],
  );
});

test("revoking an account's grants ends its tokens and pending approvals, and no one else's", async (t) => {
  const f = fixture(t);
  const mine = [await grant(f), await grant(f, "pages:read", start + 1)];
  const theirs = await grant(f, "pages:read pages:write", start, other);
  // Approvals under way: a consent screen and an unexchanged code for each.
  for (const who of [identity, other]) {
    await issueConsent(
      f.env,
      { request: await request(), sessionId: "session", principal: who.principal },
      { now: start + 2 },
    );
    await authorize(f, "pages:read", start + 2, who);
  }
  const pending = await authorize(f, "pages:read", start + 2);
  const capture = captureConsole(t);
  assert.equal(await revokeGrantsFor(f.env, identity.principal, { now: start + 3 }), 2);
  for (const { tokens, input } of mine) {
    assert.equal(await readAccessToken(f.env, tokens.access_token, { now: start + 3 }), null);
    await assert.rejects(
      rotateRefreshToken(
        f.env,
        { refreshToken: tokens.refresh_token, clientId: input.clientId, resource },
        { now: start + 3 },
      ),
      invalidGrant,
    );
  }
  await assert.rejects(
    exchangeAuthorizationCode(f.env, pending.exchange, { now: start + 3 }),
    invalidGrant,
  );
  assert.ok(await readAccessToken(f.env, theirs.tokens.access_token, { now: start + 3 }));
  const count = (sql, ...values) => f.env.DB.sqlite.prepare(sql).get(...values).n;
  assert.equal(
    count("SELECT count(*) AS n FROM pages_oauth_consents WHERE principal = ?", identity.principal),
    0,
  );
  assert.equal(
    count("SELECT count(*) AS n FROM pages_oauth_consents WHERE principal = ?", other.principal),
    1,
  );
  // Consumed codes stay as replay evidence; only unexchanged ones go.
  assert.equal(
    count(
      `SELECT count(*) AS n FROM pages_oauth_codes WHERE consumed_by IS NULL
      AND json_extract(identity_json, '$.principal') = ?`,
      identity.principal,
    ),
    0,
  );
  assert.equal(
    count(
      `SELECT count(*) AS n FROM pages_oauth_codes WHERE consumed_by IS NULL
      AND json_extract(identity_json, '$.principal') = ?`,
      other.principal,
    ),
    1,
  );
  assert.equal(
    count("SELECT count(*) AS n FROM pages_oauth_codes WHERE consumed_by IS NOT NULL"),
    3,
  );
  const revoked = capture.find("oauth.grant_revoked");
  assert.deepEqual(
    revoked.map(({ principal, revoked_by, reason }) => ({ principal, revoked_by, reason })),
    Array(2).fill({
      principal: identity.principal,
      revoked_by: "user",
      reason: "sign_out_everywhere",
    }),
  );
  // Nothing left to revoke the second time.
  assert.equal(await revokeGrantsFor(f.env, identity.principal, { now: start + 4 }), 0);
  assert.deepEqual(await listGrantsFor(f.env, identity.principal, { now: start + 4 }), []);
});

test("the connected agents list names the caller's live grants by handle only", async (t) => {
  const f = fixture(t);
  const newer = await grant(f, "pages:read", start + 10);
  await grant(f, "pages:read pages:write", start);
  await grant(f, "pages:read", start, other);
  const listed = await listGrantsFor(f.env, identity.principal, { now: start + 20 });
  assert.deepEqual(
    listed.map(({ scope, createdAt, expiresAt }) => ({ scope, createdAt, expiresAt })),
    [
      { scope: "pages:read", createdAt: start + 10, expiresAt: start + 10 + 30 * 24 * 60 * 60 },
      {
        scope: "pages:read pages:write",
        createdAt: start,
        expiresAt: start + 30 * 24 * 60 * 60,
      },
    ],
  );
  const text = JSON.stringify(listed);
  const ids = f.env.DB.sqlite
    .prepare("SELECT id FROM pages_oauth_grants")
    .all()
    .map((row) => row.id);
  for (const id of ids) assert.equal(text.includes(id), false);
  assert.equal(text.includes("pages_"), false);
  // Expired grants drop out.
  assert.deepEqual(await listGrantsFor(f.env, identity.principal, { now: start + 2_600_000 }), []);
  assert.ok(newer.tokens.access_token);
});

test("disconnecting one agent revokes only the caller's matching grant", async (t) => {
  const f = fixture(t);
  const kept = await grant(f, "pages:read", start);
  const dropped = await grant(f, "pages:read", start + 1);
  const theirs = await grant(f, "pages:read", start, other);
  const [newest] = await listGrantsFor(f.env, identity.principal, { now: start + 2 });
  const [otherHandle] = (await listGrantsFor(f.env, other.principal, { now: start + 2 })).map(
    (row) => row.handle,
  );
  assert.equal(
    await revokeGrantFor(f.env, identity.principal, otherHandle, { now: start + 2 }),
    false,
  );
  assert.equal(
    await revokeGrantFor(f.env, identity.principal, "x".repeat(43), { now: start + 2 }),
    false,
  );
  assert.equal(
    await revokeGrantFor(f.env, identity.principal, "../grants", { now: start + 2 }),
    false,
  );
  const capture = captureConsole(t);
  assert.equal(
    await revokeGrantFor(f.env, identity.principal, newest.handle, { now: start + 2 }),
    true,
  );
  assert.equal(
    await revokeGrantFor(f.env, identity.principal, newest.handle, { now: start + 3 }),
    false,
  );
  assert.equal(await readAccessToken(f.env, dropped.tokens.access_token, { now: start + 3 }), null);
  assert.ok(await readAccessToken(f.env, kept.tokens.access_token, { now: start + 3 }));
  assert.ok(await readAccessToken(f.env, theirs.tokens.access_token, { now: start + 3 }));
  assert.deepEqual(
    capture
      .find("oauth.grant_revoked")
      .map(({ principal, revoked_by, reason }) => ({ principal, revoked_by, reason })),
    [{ principal: identity.principal, revoked_by: "user", reason: "disconnected" }],
  );
});
