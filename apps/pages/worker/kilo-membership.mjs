/** What Kilo last said about the organizations an account belongs to, and the
 * short-lived organization leases a Kilo identity carries from it.
 *
 * Every successful Kilo exchange, the browser code exchange and the agent
 * token exchange alike, reports the account's organizations
 * (kilo-exchange.mjs). The host keeps the latest report per principal as one
 * D1 row: the organizations and `verified_at`, when Pages sent the exchange
 * that reported them, in seconds by Pages' clock. The row is last-writer-wins
 * on `verified_at`: one statement replaces it only with a report sent later,
 * so a slow exchange can't undo a newer answer.
 *
 * `authenticate` (auth.mjs) reads the row by principal for every Kilo
 * identity, whichever credential it arrived with: a browser cookie, a Pages
 * OAuth access token or a Kilo agent token. Nothing is copied into a session,
 * an OAuth grant or a token lease, so an agent connected by OAuth holds its
 * person's organizations while the person's evidence is fresh and loses them
 * `KILO_MEMBERSHIP_SECONDS` after the person's last exchange.
 *
 * Every host a request crosses authenticates it again, so reads go through a
 * small per-isolate cache. An entry answers for at most `CACHE_MS` from its
 * read, and never past the end of the leases it yields. So a new report
 * reaches an isolate's identities at most `CACHE_MS` after it is written; a
 * sync socket re-authenticates every 15 seconds, so it sees one within
 * `CACHE_MS` + 15 seconds. Only settled values are cached, never a pending
 * read (isolate-setup.mjs says why).
 *
 * No organization id or name reaches a log line from here. */
import { identityProvider } from "../identity-provider.mjs";
import { migrateSchema } from "./d1-schema.mjs";
import { isolateSetup } from "./isolate-setup.mjs";
import { KILO_MEMBERSHIP_SECONDS, kiloPrincipalNamespace } from "./kilo-config.mjs";

/** How long one read answers for in this isolate. */
export const CACHE_MS = 30_000;
/** How many principals one isolate remembers. */
export const MAX_CACHED = 1000;
/** A report equal to one this isolate knows was verified less than this long
 * before it is not written again. */
export const REWRITE_AFTER_SECONDS = 5 * 60;

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "memberships",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS kilo_memberships (
        principal TEXT PRIMARY KEY,
        organizations TEXT NOT NULL,
        verified_at INTEGER NOT NULL
      )`,
    ]),
  }),
]);
const ready = isolateSetup((db) =>
  migrateSchema(db, { table: "kilo_membership_schema", migrations: MIGRATIONS }),
);

/** principal -> { record, readAt }, oldest first. `record` is
 * `{ organizations, verifiedAt }` or null when the principal has none. */
const cache = new Map();

/** When `record`'s evidence stops counting, in milliseconds. */
const evidenceEnd = (record) => (record.verifiedAt + KILO_MEMBERSHIP_SECONDS) * 1000;

function remember(principal, record, now) {
  cache.delete(principal);
  cache.set(principal, { record, readAt: now });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}

function cached(principal, now) {
  const entry = cache.get(principal);
  if (!entry) return undefined;
  const until = Math.min(
    entry.readAt + CACHE_MS,
    entry.record ? evidenceEnd(entry.record) : Infinity,
  );
  if (now < until) return entry;
  cache.delete(principal);
  return undefined;
}

/** A stored row, or null for one that isn't the shape this module writes. */
function parseRecord(row) {
  if (!row || !Number.isSafeInteger(row.verified_at)) return null;
  let organizations;
  try {
    organizations = JSON.parse(row.organizations);
  } catch {
    return null;
  }
  if (
    !Array.isArray(organizations) ||
    organizations.some(
      (entry) => typeof entry?.id !== "string" || !entry.id || typeof entry.name !== "string",
    )
  )
    return null;
  return Object.freeze({
    organizations: Object.freeze(organizations.map(({ id, name }) => Object.freeze({ id, name }))),
    verifiedAt: row.verified_at,
  });
}

const sameOrganizations = (a, b) =>
  a.length === b.length &&
  a.every((entry, index) => entry.id === b[index].id && entry.name === b[index].name);

/** The principal's membership record, `{ organizations, verifiedAt }`, or
 * null. Reads D1 unless this isolate read or wrote it within `CACHE_MS`. */
export async function membershipRecord(env, principal, now = Date.now()) {
  const hit = cached(principal, now);
  if (hit) return hit.record;
  await ready(env.DB);
  const record = parseRecord(
    await env.DB.prepare(
      "SELECT organizations, verified_at FROM kilo_memberships WHERE principal = ?",
    )
      .bind(principal)
      .first(),
  );
  remember(principal, record, now);
  return record;
}

/**
 * Record what one exchange said about `principal`'s organizations.
 * `sentAt` is when Pages sent that exchange, in milliseconds. One statement
 * replaces the stored row only with a report sent in a later second, so of
 * two reports sent in the same second the first one written stays.
 *
 * The write is skipped when it can't change what readers get: the row as
 * this isolate sees it (`membershipRecord`) is at least as new, or holds the
 * same organizations verified less than `REWRITE_AFTER_SECONDS` earlier. A
 * newer report with different organizations is always written. That view is
 * at most `CACHE_MS` old, so a report another isolate wrote within it can
 * stand for up to `REWRITE_AFTER_SECONDS` over an equal one skipped here.
 */
export async function recordKiloMembership(env, principal, organizations, sentAt) {
  const verifiedAt = Math.floor(sentAt / 1000);
  const known = await membershipRecord(env, principal);
  if (
    known &&
    (verifiedAt <= known.verifiedAt ||
      (sameOrganizations(known.organizations, organizations) &&
        verifiedAt - known.verifiedAt < REWRITE_AFTER_SECONDS))
  )
    return;
  const stored = organizations.map(({ id, name }) => ({ id, name }));
  const result = await env.DB.prepare(
    `INSERT INTO kilo_memberships (principal, organizations, verified_at) VALUES (?, ?, ?)
    ON CONFLICT (principal) DO UPDATE SET
      organizations = excluded.organizations, verified_at = excluded.verified_at
    WHERE excluded.verified_at > kilo_memberships.verified_at`,
  )
    .bind(principal, JSON.stringify(stored), verifiedAt)
    .run();
  // Another isolate's newer report won: the next read fetches it.
  if (!result?.meta?.changes) cache.delete(principal);
  else
    remember(
      principal,
      parseRecord({ organizations: JSON.stringify(stored), verified_at: verifiedAt }),
      Date.now(),
    );
}

/** Whether `identity` is a Kilo account on this deployment, the only kind of
 * identity organization evidence can name. */
function kiloAccount(env, identity, now) {
  if (!identityProvider(env).organizations) return null;
  const namespace = kiloPrincipalNamespace(env);
  return identity &&
    identity.namespace === namespace &&
    typeof identity.principal === "string" &&
    identity.principal.startsWith(`${namespace}:`) &&
    Number.isFinite(identity.expiresAt) &&
    identity.expiresAt > now
    ? namespace
    : null;
}

/**
 * The organization leases `identity` holds now, `[{ id, name, namespace,
 * expiresAt }]`: one per organization the principal's fresh evidence names,
 * each ending when the identity does or the evidence stops counting,
 * whichever is first. Empty for any identity that isn't a Kilo account.
 */
export async function organizationLeases(env, identity, now = Date.now()) {
  const namespace = kiloAccount(env, identity, now);
  if (!namespace) return [];
  const record = await membershipRecord(env, identity.principal, now);
  if (!record) return [];
  const expiresAt = Math.min(identity.expiresAt, evidenceEnd(record));
  if (expiresAt <= now) return [];
  return record.organizations.map(({ id, name }) =>
    Object.freeze({ id, name, namespace, expiresAt }),
  );
}

/**
 * Bounded proof state for each of `ids`: "verified" when `identity` holds a
 * lease for it now, "expired" when the principal's evidence names it but no
 * longer counts (signing in again with the same account renews it), and
 * "missing" otherwise. Only "verified" authorizes anything.
 */
export async function organizationProof(env, identity, ids, now = Date.now()) {
  const namespace = kiloAccount(env, identity, now);
  const record = namespace ? await membershipRecord(env, identity.principal, now) : null;
  const fresh = !!record && Math.min(identity.expiresAt, evidenceEnd(record)) > now;
  const named = new Set(record?.organizations.map(({ id }) => id));
  const proof = {};
  for (const id of ids) proof[id] = !named.has(id) ? "missing" : fresh ? "verified" : "expired";
  return proof;
}

/** Test seam: forget every cached record. */
export function resetMembershipCache() {
  cache.clear();
}
