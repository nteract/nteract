/**
 * Per-account Page quotas.
 *
 * One limit per account bounds both its active Pages and its Pages in Trash.
 * The gateway resolves it from the authenticated identity and passes it to
 * the owner's Catalog on every call that can add a Page to either listing;
 * the Catalog counts (catalog.mjs) and refuses.
 *
 * The limit comes from the first match of:
 *
 * 1. an `email` rule equal to the account's server-verified email;
 * 2. a `domain` rule equal to that email's domain, lowercased;
 * 3. the deploy target's default, `PAGES_DEFAULT_PAGE_QUOTA` (250 when unset).
 *
 * A matching rule replaces the default, so it may be lower, including 0,
 * which pauses the account: it can't create or restore Pages, but it can still
 * move them to Trash, which no limit caps at 0. A quota never deletes or hides
 * a Page the account already has.
 *
 * Only server-verified email counts. An API key's identity carries the email
 * Anaconda whoami verified. A browser session or OAuth grant carries only HMAC
 * bindings of the verified email and its domain (app-session.ts), so each rule
 * is checked against those bindings at the time they were verified. Nothing a
 * caller sends is read as an email.
 *
 * Rules live in D1 (`pages_quota_rules`). The gateway reads the whole table,
 * at most QUOTA_RULE_LIMIT rows, once per isolate per `pageQuotaBounds.rulesMs`
 * and caches each account's answer against that snapshot. Only settled values
 * are cached, so no request awaits work another request started
 * (isolate-setup.mjs). When D1 is missing, slow or failing, every account gets
 * the default: a failure never lifts a limit. The schema setup each read
 * starts is an isolateSetup attempt, so one that hangs is abandoned after
 * `isolateSetupTimeouts.attempt` and a later refresh tries again.
 */
import {
  appSessionHasFreshVerifiedEmail,
  appSessionHasFreshVerifiedEmailDomain,
} from "@cloud/app-session.ts";
import { normalizeInviteEmail } from "@cloud/sharing.ts";
import { HttpError, logFailure } from "./auth.mjs";
import { migrateSchema, withTimeout } from "./catalog-index.mjs";
import { isolateSetup } from "./isolate-setup.mjs";

export const DEFAULT_PAGE_QUOTA = 250;
/** The largest limit any rule or default can set. Catalog scans that read
 * every entry stay bounded by it. */
export const MAX_PAGE_QUOTA = 10_000;
/** The most rules one snapshot reads. A larger table resolves every account
 * to the default until it is trimmed. */
export const QUOTA_RULE_LIMIT = 1000;

/** Mutable so tests can shorten them. `rulesMs` is how long a rule snapshot
 * serves, `failureMs` how long a failed read serves the default, and `readMs`
 * bounds one read, schema setup included. */
export const pageQuotaBounds = { rulesMs: 5 * 60_000, failureMs: 30_000, readMs: 2500 };

export const QUOTA_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "quota_rules",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS pages_quota_rules (
        match_kind TEXT NOT NULL CHECK (match_kind IN ('email', 'domain')),
        match_value TEXT NOT NULL,
        page_limit INTEGER NOT NULL CHECK (page_limit >= 0),
        note TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (match_kind, match_value)
      )`,
    ]),
  }),
]);

export function migrateQuotaRules(db, now) {
  return migrateSchema(db, { table: "pages_quota_schema", migrations: QUOTA_MIGRATIONS, now });
}

export function validPageLimit(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_PAGE_QUOTA;
}

/** The deploy target's default limit. A malformed value falls back to 250. */
export function defaultPageQuota(env) {
  const raw = env?.PAGES_DEFAULT_PAGE_QUOTA;
  if (raw === undefined || raw === null || raw === "") return DEFAULT_PAGE_QUOTA;
  const text = String(raw).trim();
  const value = /^\d{1,6}$/.test(text) ? Number(text) : NaN;
  return validPageLimit(value) ? value : DEFAULT_PAGE_QUOTA;
}

/** The limit a Catalog applies: the one its gateway resolved, or the target
 * default when the forward carries none (a gateway from an earlier build). */
export function forwardedPageLimit(value, env) {
  return validPageLimit(value) ? value : defaultPageQuota(env);
}

const DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const validDomain = (domain) => domain.length <= 253 && DOMAIN.test(domain);

function emailDomain(email) {
  const domain = email.slice(email.lastIndexOf("@") + 1);
  return validDomain(domain) ? domain : null;
}

/** A rule's match value in the form the resolver compares, or null when it
 * can never match: emails as invite emails normalize them, domains lowercased
 * ASCII. */
export function normalizeRuleMatch(kind, value) {
  if (typeof value !== "string") return null;
  if (kind === "email") {
    try {
      const email = normalizeInviteEmail(value);
      return emailDomain(email) ? email : null;
    } catch {
      return null;
    }
  }
  if (kind === "domain") {
    const domain = value.trim().toLowerCase();
    return validDomain(domain) ? domain : null;
  }
  return null;
}

/** Rows as two lookup maps. Values are normalized again, so a row written by
 * hand still matches; of two rows that normalize alike, the newer wins. */
function ruleSet(rows) {
  const rules = { email: new Map(), domain: new Map() };
  const sorted = [...rows].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0));
  for (const row of sorted) {
    const value = normalizeRuleMatch(row.match_kind, row.match_value);
    if (!value || !Number.isSafeInteger(row.page_limit) || row.page_limit < 0) continue;
    rules[row.match_kind].set(value, Math.min(row.page_limit, MAX_PAGE_QUOTA));
  }
  return rules;
}

const ready = isolateSetup((db) => migrateQuotaRules(db));
/** db → { rules, expiresAt, answers }. `rules` is null after a failed read. */
const snapshots = new WeakMap();

async function readRules(db) {
  await ready(db);
  const result = await db
    .prepare(
      `SELECT match_kind, match_value, page_limit, updated_at FROM pages_quota_rules
      ORDER BY match_kind, match_value LIMIT ?`,
    )
    .bind(QUOTA_RULE_LIMIT + 1)
    .all();
  const rows = result.results ?? [];
  if (rows.length > QUOTA_RULE_LIMIT)
    throw new Error(`pages_quota_rules holds more than ${QUOTA_RULE_LIMIT} rules`);
  return ruleSet(rows);
}

async function snapshot(db, now) {
  const cached = snapshots.get(db);
  if (cached && cached.expiresAt > now) return cached;
  let rules = null;
  try {
    rules = await withTimeout(readRules(db), pageQuotaBounds.readMs, "Quota rules read timed out");
  } catch (error) {
    logFailure(error, "page-quota");
  }
  const next = {
    rules,
    expiresAt: now + (rules ? pageQuotaBounds.rulesMs : pageQuotaBounds.failureMs),
    answers: new Map(),
  };
  snapshots.set(db, next);
  return next;
}

/** What an identity proves about its email, or null when it proves nothing. */
export function quotaEvidence(identity) {
  if (identity?.credentialKind === "api-key") {
    if (typeof identity.verifiedEmail !== "string") return null;
    let email;
    try {
      email = normalizeInviteEmail(identity.verifiedEmail);
    } catch {
      return null;
    }
    return { email, domain: emailDomain(email), key: `email:${email}` };
  }
  const proof = identity?.emailProof;
  if (
    ["oidc", "oauth"].includes(identity?.credentialKind) &&
    proof?.provider === "app-session" &&
    Number.isSafeInteger(proof.identityVerifiedAt) &&
    proof.identityVerifiedAt > 0 &&
    typeof proof.verifiedEmailBinding === "string"
  )
    return {
      proof,
      key: `binding:${proof.identityVerifiedAt}:${proof.verifiedEmailBinding}:${proof.verifiedEmailDomainBinding ?? ""}`,
    };
  return null;
}

async function matchRules(env, identity, evidence, rules) {
  if (evidence.email) {
    if (rules.email.has(evidence.email))
      return { limit: rules.email.get(evidence.email), source: "email" };
    if (evidence.domain && rules.domain.has(evidence.domain))
      return { limit: rules.domain.get(evidence.domain), source: "domain" };
    return null;
  }
  // Checked as of the proof's own verification time: it shows which email the
  // server verified for this principal, and a quota grants no access.
  const connection = { principal: identity.principal, metadata: evidence.proof };
  const at = evidence.proof.identityVerifiedAt;
  for (const [email, limit] of rules.email)
    if (await appSessionHasFreshVerifiedEmail(env, connection, email, at))
      return { limit, source: "email" };
  for (const [domain, limit] of rules.domain)
    if (await appSessionHasFreshVerifiedEmailDomain(env, connection, domain, at))
      return { limit, source: "domain" };
  return null;
}

/**
 * The page limit for an authenticated identity: `{ limit, source }`, where
 * source is "email", "domain" or "default". It never throws.
 */
export async function resolvePageQuota(env, identity, now = Date.now()) {
  const fallback = { limit: defaultPageQuota(env), source: "default" };
  try {
    const evidence = quotaEvidence(identity);
    // Without verified email no rule can match, so D1 is never read.
    if (!evidence || !env?.DB?.prepare) return fallback;
    const current = await snapshot(env.DB, now);
    if (!current.rules) return fallback;
    const key = `${identity.principal}\u0000${evidence.key}`;
    const known = current.answers.get(key);
    if (known) return known;
    const answer = (await matchRules(env, identity, evidence, current.rules)) ?? fallback;
    if (current.answers.size >= 10_000) current.answers.clear();
    current.answers.set(key, answer);
    return answer;
  } catch (error) {
    logFailure(error, "page-quota");
    return fallback;
  }
}

/** "1 Page", "250 Pages", "1,000 Pages". */
export const pageCount = (value) =>
  `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")} ${value === 1 ? "Page" : "Pages"}`;

/** The refusal body when `prefix` ("page/" or "trash/") is at `limit`. Trash
 * is never full at limit 0 (Catalog destinationCapacity). */
export function quotaRefusal(prefix, { limit, count }) {
  const trash = prefix === "trash/";
  const error = trash
    ? `This alpha release allows ${pageCount(limit)} in Trash per account. Permanently delete Pages from Trash before moving more Pages there.`
    : limit === 0
      ? "Creating Pages is turned off for this account."
      : `This alpha release allows ${pageCount(limit)} per account.`;
  return {
    status: 409,
    body: { error, code: trash ? "trash_capacity" : "page_quota_exceeded", limit, count },
  };
}

export function quotaError(prefix, quota) {
  const { status, body } = quotaRefusal(prefix, quota);
  return Object.assign(new HttpError(status, body.error, body.code), {
    details: { limit: body.limit, count: body.count },
  });
}

/** Drop cached rule snapshots; tests call this between cases. */
export function resetPageQuotaCache(db) {
  snapshots.delete(db);
}
