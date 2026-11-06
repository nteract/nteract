import { randomSecret, secretHash } from "@cloud/oidc-session-store.ts";
import { pagesPublicOrigin } from "../agent-guide.mjs";
import { isolateSetup } from "./isolate-setup.mjs";
import { logAuthEvent } from "./auth-events.mjs";

const CODE_SECONDS = 300;
const CONSENT_SECONDS = 600;
const ACCESS_SECONDS = 600;
const REFRESH_SECONDS = 30 * 24 * 60 * 60;
const tokenPattern = /^pages_(?:at|rt)_[A-Za-z0-9_-]{43}$/;
const secretPattern = /^[A-Za-z0-9_-]{43}$/;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pages_oauth_consents (
    id_hash TEXT PRIMARY KEY, context TEXT NOT NULL, session_id TEXT NOT NULL,
    principal TEXT NOT NULL, csrf_hash TEXT NOT NULL, request_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_consents_expiry ON pages_oauth_consents(expires_at)`,
  `CREATE TABLE IF NOT EXISTS pages_oauth_codes (
    code_hash TEXT PRIMARY KEY, context TEXT NOT NULL, client_id TEXT NOT NULL,
    redirect_uri TEXT NOT NULL, resource TEXT NOT NULL, scope TEXT NOT NULL,
    challenge TEXT NOT NULL, identity_json TEXT NOT NULL, expires_at INTEGER NOT NULL,
    consumed_by TEXT, allow_refresh INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_codes_expiry ON pages_oauth_codes(expires_at)`,
  `CREATE TABLE IF NOT EXISTS pages_oauth_grants (
    id TEXT PRIMARY KEY, context TEXT NOT NULL, client_id TEXT NOT NULL,
    resource TEXT NOT NULL, scope TEXT NOT NULL, identity_json TEXT NOT NULL,
    expires_at INTEGER NOT NULL, revoked_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_grants_expiry ON pages_oauth_grants(expires_at)`,
  `CREATE TABLE IF NOT EXISTS pages_oauth_access_tokens (
    token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL,
    scope TEXT NOT NULL, expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_access_expiry ON pages_oauth_access_tokens(expires_at)`,
  `CREATE TABLE IF NOT EXISTS pages_oauth_refresh_tokens (
    token_hash TEXT PRIMARY KEY, grant_id TEXT NOT NULL,
    scope TEXT NOT NULL, expires_at INTEGER NOT NULL, consumed_by TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_refresh_expiry ON pages_oauth_refresh_tokens(expires_at)`,
  // Revoked-grant cleanup finds a grant's tokens and codes through these.
  `CREATE INDEX IF NOT EXISTS pages_oauth_access_grant ON pages_oauth_access_tokens(grant_id)`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_refresh_grant ON pages_oauth_refresh_tokens(grant_id)`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_codes_grant ON pages_oauth_codes(consumed_by)`,
  `CREATE INDEX IF NOT EXISTS pages_oauth_grants_revoked ON pages_oauth_grants(revoked_at)`,
];

export class OAuthStoreError extends Error {
  constructor(error = "invalid_grant") {
    super(error);
    this.name = "OAuthStoreError";
    this.error = error;
  }
}
const invalid = () => {
  throw new OAuthStoreError();
};
const seconds = (now = Math.floor(Date.now() / 1000)) => {
  if (!Number.isSafeInteger(now) || now < 0) throw new OAuthStoreError("invalid_request");
  return now;
};
function boundedString(value, max = 2048) {
  // eslint-disable-next-line no-control-regex
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value))
    throw new OAuthStoreError("invalid_request");
  return value;
}
function scopeValue(scope) {
  if (typeof scope !== "string" || scope.length > 512 || !scope.trim())
    throw new OAuthStoreError("invalid_scope");
  const values = [...new Set(scope.trim().split(/ +/))];
  if (values.some((value) => !/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(value)))
    throw new OAuthStoreError("invalid_scope");
  return values.sort().join(" ");
}
function narrowedScope(requested, previous) {
  const scope = requested === undefined ? previous : scopeValue(requested);
  const allowed = new Set(previous.split(" "));
  if (scope.split(" ").some((value) => !allowed.has(value)))
    throw new OAuthStoreError("invalid_scope");
  return scope;
}
function contextFor(env) {
  return JSON.stringify([
    pagesPublicOrigin(env),
    env.NOTEBOOK_CLOUD_OIDC_ISSUER?.trim() ?? "",
    env.NOTEBOOK_CLOUD_OIDC_CLIENT_ID?.trim() ?? "",
    env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE?.trim() ?? "",
    env.NOTEBOOK_CLOUD_OIDC_USERINFO_URL?.trim() ?? "",
  ]);
}
function authorizationRequest(env, input) {
  const clientId = boundedString(input.clientId);
  const redirectUri = boundedString(input.redirectUri);
  const resource = boundedString(input.resource);
  if (resource !== `${pagesPublicOrigin(env)}/mcp` || !secretPattern.test(input.codeChallenge))
    throw new OAuthStoreError("invalid_request");
  const scope = scopeValue(input.scope);
  return {
    clientId,
    redirectUri,
    resource,
    scope,
    codeChallenge: input.codeChallenge,
    ...(input.state !== undefined && { state: boundedString(input.state) }),
    // This is server-recorded consent policy, never an OAuth scope or a value
    // accepted from the client's authorization query or consent form.
    ...(input.allowRefresh === true && { allowRefresh: true }),
  };
}
function identitySnapshot(identity) {
  const principal = boundedString(identity?.principal, 512);
  const namespace = boundedString(identity?.namespace, 512);
  if (!principal.startsWith(`${namespace}:`)) throw new OAuthStoreError("invalid_request");
  const snapshot = { principal, namespace };
  if (identity.displayName !== undefined)
    snapshot.displayName = boundedString(identity.displayName, 256);
  // Only existing proof is retained. Refreshing a grant never renews this timestamp.
  const proof = identity.emailProof;
  if (
    proof?.provider === "app-session" &&
    proof.principalNamespace === namespace &&
    Number.isSafeInteger(proof.identityVerifiedAt) &&
    proof.identityVerifiedAt > 0 &&
    typeof proof.verifiedEmailBinding === "string"
  ) {
    snapshot.emailProof = {
      provider: "app-session",
      principalNamespace: namespace,
      identityVerifiedAt: proof.identityVerifiedAt,
      verifiedEmailBinding: boundedString(proof.verifiedEmailBinding, 512),
      ...(typeof proof.verifiedEmailDomainBinding === "string" && {
        verifiedEmailDomainBinding: boundedString(proof.verifiedEmailDomainBinding, 512),
      }),
    };
  }
  return snapshot;
}
// Concurrent requests never await one another's schema setup; see isolate-setup.mjs.
const schemaReady = isolateSetup(async (db) => {
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  const hasRefreshConsent = async () => {
    const result = await db.prepare("PRAGMA table_info(pages_oauth_codes)").all();
    return result.results?.some((column) => column.name === "allow_refresh") ?? false;
  };
  if (!(await hasRefreshConsent())) {
    try {
      // Old codes keep the permissions approved on their original screen.
      await db
        .prepare(
          "ALTER TABLE pages_oauth_codes ADD COLUMN allow_refresh INTEGER NOT NULL DEFAULT 0",
        )
        .run();
    } catch (error) {
      // Another isolate may have completed the same additive migration.
      if (!(await hasRefreshConsent())) throw error;
    }
  }
});
async function database(env) {
  const db = env.DB;
  if (!db?.prepare || !db.batch)
    throw new Error("Pages OAuth requires transactional database storage");
  await schemaReady(db);
  return db;
}
const statement = (db, sql, ...values) => db.prepare(sql).bind(...values);
/** The principal in a stored identity snapshot, for audit lines only. */
function snapshotPrincipal(identityJson) {
  try {
    return JSON.parse(identityJson)?.principal;
  } catch {
    return undefined;
  }
}

// Each table's primary key, in cleanup order: a code is kept while its grant
// lives, so codes go before grants.
const EXPIRY_KEYS = {
  pages_oauth_consents: "id_hash",
  pages_oauth_codes: "code_hash",
  pages_oauth_access_tokens: "token_hash",
  pages_oauth_refresh_tokens: "token_hash",
  pages_oauth_grants: "id",
};
export const OAUTH_EXPIRY_TABLES = Object.freeze(Object.keys(EXPIRY_KEYS));
function cleanupLimit(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new OAuthStoreError("invalid_request");
  return limit;
}
function expiryStatement(db, table, now, limit) {
  const key = EXPIRY_KEYS[table];
  if (!key) throw new OAuthStoreError("invalid_request");
  // A consumed code is replay evidence for every token in its grant, even
  // after the code's own five-minute exchange window has closed.
  const retainedCode = table === "pages_oauth_codes";
  const expiry = retainedCode
    ? `expires_at <= ? AND (consumed_by IS NULL OR NOT EXISTS
      (SELECT 1 FROM pages_oauth_grants WHERE id = pages_oauth_codes.consumed_by AND expires_at > ?))`
    : "expires_at <= ?";
  return statement(
    db,
    `DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} WHERE ${expiry} ORDER BY expires_at LIMIT ?)`,
    ...(retainedCode ? [now, now, limit] : [now, limit]),
  );
}
const changesOf = (result) => result.meta?.changes ?? 0;

/** Expiry cleanup is bounded and never discards a still-valid replay tombstone. */
export async function cleanupOAuthStore(env, { now, limit = 100 } = {}) {
  now = seconds(now);
  cleanupLimit(limit);
  const db = await database(env);
  const results = await db.batch(
    OAUTH_EXPIRY_TABLES.map((table) => expiryStatement(db, table, now, limit)),
  );
  return results.reduce((total, result) => total + changesOf(result), 0);
}

/** The same expiry rule as cleanupOAuthStore, for one table at a time. */
export async function cleanupOAuthTable(env, table, { now, limit } = {}) {
  now = seconds(now);
  cleanupLimit(limit);
  const db = await database(env);
  return changesOf(await expiryStatement(db, table, now, limit).run());
}

// Rows that hang off a revoked grant, deleted before the grant itself. Every
// read and exchange already refuses them, because the grant is revoked.
const REVOKED_CHILDREN = {
  pages_oauth_access_tokens: ["token_hash", "grant_id"],
  pages_oauth_refresh_tokens: ["token_hash", "grant_id"],
  pages_oauth_codes: ["code_hash", "consumed_by"],
};
export const OAUTH_REVOKED_TABLES = Object.freeze([
  ...Object.keys(REVOKED_CHILDREN),
  "pages_oauth_grants",
]);
const revokedBy = (table, [, link]) =>
  `SELECT 1 FROM ${table} WHERE ${table}.${link} = pages_oauth_grants.id`;

/**
 * Deletes at most `limit` rows of one table that belong to grants revoked at
 * or before `revokedBefore` (seconds). A grant row goes only once none of its
 * tokens or codes remain, so a partial run never orphans them.
 */
export async function deleteRevokedGrantRows(env, table, { revokedBefore, limit } = {}) {
  revokedBefore = seconds(revokedBefore);
  cleanupLimit(limit);
  const db = await database(env);
  const child = REVOKED_CHILDREN[table];
  let sql;
  if (child) {
    const [key, link] = child;
    sql = `DELETE FROM ${table} WHERE ${key} IN (SELECT ${table}.${key} FROM ${table}
      JOIN pages_oauth_grants ON pages_oauth_grants.id = ${table}.${link}
      WHERE pages_oauth_grants.revoked_at IS NOT NULL AND pages_oauth_grants.revoked_at <= ? LIMIT ?)`;
  } else if (table === "pages_oauth_grants") {
    const orphanless = Object.entries(REVOKED_CHILDREN)
      .map(([name, columns]) => `NOT EXISTS (${revokedBy(name, columns)})`)
      .join(" AND ");
    sql = `DELETE FROM pages_oauth_grants WHERE id IN (SELECT id FROM pages_oauth_grants
      WHERE revoked_at IS NOT NULL AND revoked_at <= ? AND ${orphanless}
      ORDER BY revoked_at LIMIT ?)`;
  } else throw new OAuthStoreError("invalid_request");
  return changesOf(await statement(db, sql, revokedBefore, limit).run());
}

export async function issueConsent(env, { request, sessionId, principal }, { now } = {}) {
  now = seconds(now);
  const value = authorizationRequest(env, request);
  boundedString(sessionId);
  boundedString(principal, 512);
  const consentId = randomSecret(),
    csrfToken = randomSecret();
  const db = await database(env);
  await cleanupOAuthStore(env, { now });
  await statement(
    db,
    `INSERT INTO pages_oauth_consents
    (id_hash, context, session_id, principal, csrf_hash, request_json, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    await secretHash(consentId),
    contextFor(env),
    sessionId,
    principal,
    await secretHash(csrfToken),
    JSON.stringify(value),
    now + CONSENT_SECONDS,
  ).run();
  return { consentId, csrfToken, expiresAt: now + CONSENT_SECONDS };
}
export async function readConsent(env, { consentId, sessionId, principal }, { now } = {}) {
  now = seconds(now);
  if (!secretPattern.test(consentId)) return null;
  const db = await database(env);
  const row = await statement(
    db,
    `SELECT request_json FROM pages_oauth_consents
    WHERE id_hash = ? AND context = ? AND session_id = ? AND principal = ? AND expires_at > ?`,
    await secretHash(consentId),
    contextFor(env),
    sessionId,
    principal,
    now,
  ).first();
  return row ? JSON.parse(row.request_json) : null;
}
export async function consumeConsent(
  env,
  { consentId, sessionId, principal, csrfToken },
  { now } = {},
) {
  now = seconds(now);
  if (!secretPattern.test(consentId) || !secretPattern.test(csrfToken)) return null;
  const db = await database(env);
  const row = await statement(
    db,
    `DELETE FROM pages_oauth_consents
    WHERE id_hash = ? AND context = ? AND session_id = ? AND principal = ? AND csrf_hash = ? AND expires_at > ? RETURNING request_json`,
    await secretHash(consentId),
    contextFor(env),
    sessionId,
    principal,
    await secretHash(csrfToken),
    now,
  ).first();
  return row ? JSON.parse(row.request_json) : null;
}

export async function issueAuthorizationCode(env, input, { now } = {}) {
  now = seconds(now);
  const value = authorizationRequest(env, input);
  const identity = identitySnapshot(input.identity);
  const code = randomSecret(),
    db = await database(env);
  await cleanupOAuthStore(env, { now });
  await statement(
    db,
    `INSERT INTO pages_oauth_codes
    (code_hash, context, client_id, redirect_uri, resource, scope, challenge, identity_json, expires_at, allow_refresh)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    await secretHash(code),
    contextFor(env),
    value.clientId,
    value.redirectUri,
    value.resource,
    value.scope,
    value.codeChallenge,
    JSON.stringify(identity),
    now + CODE_SECONDS,
    value.allowRefresh === true ? 1 : 0,
  ).run();
  return { code, expiresAt: now + CODE_SECONDS };
}

async function newTokens(allowRefresh, now, absoluteExpiry) {
  const accessToken = `pages_at_${randomSecret()}`;
  const refreshToken = allowRefresh ? `pages_rt_${randomSecret()}` : null;
  return {
    accessToken,
    accessHash: await secretHash(accessToken),
    refreshToken,
    refreshHash: refreshToken ? await secretHash(refreshToken) : null,
    expiresAt: Math.min(now + ACCESS_SECONDS, absoluteExpiry),
  };
}
function tokenResponse(tokens, scope, now) {
  return {
    access_token: tokens.accessToken,
    token_type: "Bearer",
    expires_in: tokens.expiresAt - now,
    scope,
    ...(tokens.refreshToken && { refresh_token: tokens.refreshToken }),
  };
}
export async function exchangeAuthorizationCode(env, input, { now } = {}) {
  now = seconds(now);
  if (!secretPattern.test(input.code) || !/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier))
    invalid();
  const db = await database(env),
    codeHash = await secretHash(input.code),
    context = contextFor(env);
  const row = await statement(
    db,
    `SELECT * FROM pages_oauth_codes WHERE code_hash = ?`,
    codeHash,
  ).first();
  const challenge = await secretHash(input.codeVerifier);
  if (
    !row ||
    row.context !== context ||
    row.client_id !== input.clientId ||
    row.redirect_uri !== input.redirectUri ||
    row.resource !== input.resource ||
    row.challenge !== challenge ||
    (row.expires_at <= now && !row.consumed_by)
  )
    invalid();
  const grantId = randomSecret();
  // Legacy offline_access requests already received the persistent-connection
  // disclosure. Other old codes must not gain a longer grant after deployment.
  const allowRefresh = row.allow_refresh === 1 || row.scope.split(" ").includes("offline_access");
  const absoluteExpiry = now + (allowRefresh ? REFRESH_SECONDS : ACCESS_SECONDS);
  const tokens = await newTokens(allowRefresh, now, absoluteExpiry);
  // All client, redirect, resource and PKCE bindings were checked before this
  // transaction. A correctly bound replay revokes the issued family, including
  // when another exchanger consumed the code after our read. Claim markers gate
  // every INSERT, so that race cannot issue duplicate grants or revive one.
  const batch = [
    statement(
      db,
      `UPDATE pages_oauth_grants SET revoked_at = ? WHERE revoked_at IS NULL AND id IN
      (SELECT consumed_by FROM pages_oauth_codes WHERE code_hash = ? AND context = ? AND consumed_by IS NOT NULL)`,
      now,
      codeHash,
      context,
    ),
    statement(
      db,
      `UPDATE pages_oauth_codes SET consumed_by = ? WHERE code_hash = ?
      AND consumed_by IS NULL AND expires_at > ? AND context = ?`,
      grantId,
      codeHash,
      now,
      context,
    ),
    statement(
      db,
      `INSERT INTO pages_oauth_grants
      (id, context, client_id, resource, scope, identity_json, expires_at)
      SELECT ?, context, client_id, resource, scope, identity_json, ? FROM pages_oauth_codes
      WHERE code_hash = ? AND consumed_by = ?`,
      grantId,
      absoluteExpiry,
      codeHash,
      grantId,
    ),
    statement(
      db,
      `INSERT INTO pages_oauth_access_tokens (token_hash, grant_id, scope, expires_at)
      SELECT ?, id, scope, ? FROM pages_oauth_grants WHERE id = ? AND revoked_at IS NULL`,
      tokens.accessHash,
      tokens.expiresAt,
      grantId,
    ),
  ];
  if (tokens.refreshToken)
    batch.push(
      statement(
        db,
        `INSERT INTO pages_oauth_refresh_tokens (token_hash, grant_id, scope, expires_at)
      SELECT ?, id, scope, expires_at FROM pages_oauth_grants WHERE id = ? AND revoked_at IS NULL`,
        tokens.refreshHash,
        grantId,
      ),
    );
  const result = await db.batch(batch);
  const audit = {
    principal: snapshotPrincipal(row.identity_json),
    credential: "oauth",
    clientId: row.client_id,
  };
  if ((result[0].meta?.changes ?? 0) > 0) {
    await logAuthEvent({ action: "oauth.code_replayed", ...audit, grantId: row.consumed_by });
    await logAuthEvent({
      action: "oauth.grant_revoked",
      ...audit,
      grantId: row.consumed_by,
      revokedBy: "system",
      reason: "code_replayed",
    });
  }
  if (result[1].meta?.changes !== 1) invalid();
  await logAuthEvent({
    action: "oauth.token_issued",
    ...audit,
    grantId,
    grantType: "authorization_code",
    scope: row.scope,
    refresh: Boolean(tokens.refreshToken),
  });
  return tokenResponse(tokens, row.scope, now);
}

export async function rotateRefreshToken(env, input, { now } = {}) {
  now = seconds(now);
  if (!/^pages_rt_[A-Za-z0-9_-]{43}$/.test(input.refreshToken)) invalid();
  const db = await database(env),
    hash = await secretHash(input.refreshToken),
    context = contextFor(env);
  const row = await statement(
    db,
    `SELECT r.scope AS token_scope, r.consumed_by, g.*
    FROM pages_oauth_refresh_tokens r JOIN pages_oauth_grants g ON g.id = r.grant_id
    WHERE r.token_hash = ? AND r.expires_at > ?`,
    hash,
    now,
  ).first();
  if (
    !row ||
    row.context !== context ||
    row.client_id !== input.clientId ||
    row.resource !== input.resource ||
    row.expires_at <= now ||
    row.revoked_at !== null
  )
    invalid();
  // Validate client/resource/scope before any consume or replay revocation.
  const scope = narrowedScope(input.scope, row.token_scope);
  const claim = randomSecret(),
    tokens = await newTokens(true, now, row.expires_at);
  const batch = [
    // Retained consumed hashes detect replay, including a race that lost after
    // reading an unconsumed row. This revokes newly issued descendants too.
    statement(
      db,
      `UPDATE pages_oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
      AND EXISTS (SELECT 1 FROM pages_oauth_refresh_tokens WHERE token_hash = ? AND consumed_by IS NOT NULL)`,
      now,
      row.id,
      hash,
    ),
    statement(
      db,
      `UPDATE pages_oauth_refresh_tokens SET consumed_by = ? WHERE token_hash = ?
      AND consumed_by IS NULL AND expires_at > ? AND EXISTS
      (SELECT 1 FROM pages_oauth_grants WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND context = ?)`,
      claim,
      hash,
      now,
      row.id,
      now,
      context,
    ),
    statement(
      db,
      `INSERT INTO pages_oauth_access_tokens (token_hash, grant_id, scope, expires_at)
      SELECT ?, r.grant_id, ?, ? FROM pages_oauth_refresh_tokens r JOIN pages_oauth_grants g ON g.id = r.grant_id
      WHERE r.token_hash = ? AND r.consumed_by = ? AND g.revoked_at IS NULL`,
      tokens.accessHash,
      scope,
      tokens.expiresAt,
      hash,
      claim,
    ),
  ];
  if (tokens.refreshToken)
    batch.push(
      statement(
        db,
        `INSERT INTO pages_oauth_refresh_tokens (token_hash, grant_id, scope, expires_at)
      SELECT ?, r.grant_id, ?, g.expires_at FROM pages_oauth_refresh_tokens r JOIN pages_oauth_grants g ON g.id = r.grant_id
      WHERE r.token_hash = ? AND r.consumed_by = ? AND g.revoked_at IS NULL`,
        tokens.refreshHash,
        scope,
        hash,
        claim,
      ),
    );
  const result = await db.batch(batch);
  const audit = {
    principal: snapshotPrincipal(row.identity_json),
    credential: "oauth",
    clientId: row.client_id,
    grantId: row.id,
  };
  if (result[0].meta?.changes === 1) {
    await logAuthEvent({ action: "oauth.refresh_reused", ...audit });
    await logAuthEvent({
      action: "oauth.grant_revoked",
      ...audit,
      revokedBy: "system",
      reason: "refresh_reused",
    });
  }
  if (result[1].meta?.changes !== 1) invalid();
  await logAuthEvent({
    action: "oauth.token_issued",
    ...audit,
    grantType: "refresh_token",
    scope,
    refresh: true,
  });
  return tokenResponse(tokens, scope, now);
}

export async function readAccessToken(env, token, { resource, now } = {}) {
  now = seconds(now);
  if (!/^pages_at_[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const db = await database(env);
  const row = await statement(
    db,
    `SELECT a.scope AS token_scope, a.expires_at AS token_expires_at,
    g.identity_json, g.client_id, g.id FROM pages_oauth_access_tokens a
    JOIN pages_oauth_grants g ON g.id = a.grant_id WHERE a.token_hash = ?
    AND a.expires_at > ? AND g.expires_at > ? AND g.revoked_at IS NULL AND g.context = ? AND g.resource = ?`,
    await secretHash(token),
    now,
    now,
    contextFor(env),
    resource ?? `${pagesPublicOrigin(env)}/mcp`,
  ).first();
  return row
    ? {
        identity: JSON.parse(row.identity_json),
        scope: row.token_scope,
        clientId: row.client_id,
        expiresAt: row.token_expires_at,
        grantId: row.id,
      }
    : null;
}

/** Whether an OAuth grant is still live: this deployment's, not revoked and
 * not expired. An upload capability issued under a grant checks this when it
 * is used (asset-uploads.mjs), so revoking a connection ends its uploads too.
 * The grant ID authorizes nothing by itself. */
export async function oauthGrantActive(env, grantId, { now } = {}) {
  now = seconds(now);
  if (typeof grantId !== "string" || !secretPattern.test(grantId)) return false;
  const db = await database(env);
  const row = await statement(
    db,
    `SELECT 1 AS live FROM pages_oauth_grants
    WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND context = ?`,
    grantId,
    now,
    contextFor(env),
  ).first();
  return row !== null;
}

/** RFC 7009: unknown tokens/wrong clients succeed without revealing membership. */
export async function revokeOAuthToken(env, { token, clientId }, { now } = {}) {
  now = seconds(now);
  if (!tokenPattern.test(token) || typeof clientId !== "string") return;
  const db = await database(env),
    hash = await secretHash(token);
  const revoked = await statement(
    db,
    `UPDATE pages_oauth_grants SET revoked_at = ?
    WHERE client_id = ? AND context = ? AND revoked_at IS NULL AND id IN
    (SELECT grant_id FROM pages_oauth_access_tokens WHERE token_hash = ?
     UNION SELECT grant_id FROM pages_oauth_refresh_tokens WHERE token_hash = ?)
    RETURNING id, client_id, identity_json`,
    now,
    clientId,
    contextFor(env),
    hash,
    hash,
  ).all();
  for (const grant of revoked.results ?? [])
    await logAuthEvent({
      action: "oauth.grant_revoked",
      principal: snapshotPrincipal(grant.identity_json),
      credential: "oauth",
      clientId: grant.client_id,
      grantId: grant.id,
      revokedBy: "rfc7009",
    });
}
