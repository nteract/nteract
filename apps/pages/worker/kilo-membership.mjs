/** What Kilo last said about the organizations an account belongs to, and the
 * short-lived organization leases a Kilo identity carries from it.
 *
 * Every successful Kilo exchange, the browser code exchange and the agent
 * token exchange alike, reports the account's organizations
 * (kilo-exchange.mjs). The host keeps the newest report per principal as one
 * D1 row: the organizations and `verified_at_ms`, when Pages sent the exchange
 * that reported them, in milliseconds by Pages' clock. Every successful
 * exchange writes, in one statement (`recordKiloMembership`), so the row
 * always holds the newest answer any isolate received, and a slow exchange
 * can't undo a newer one. That costs one D1 write per browser sign-in and one
 * per agent token exchange in each isolate.
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
 * read, and never past the end of the leases it yields; a write drops the
 * writing isolate's entry. So a request sees a new report at most 30 seconds
 * after it is written, and an open sync socket, which re-authenticates every
 * 15 seconds, at most 45 seconds after. Only settled values are cached, never
 * a pending read (isolate-setup.mjs says why).
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

const MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "memberships",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS kilo_memberships (
        principal TEXT PRIMARY KEY,
        organizations TEXT NOT NULL,
        verified_at_ms INTEGER NOT NULL
      )`,
    ]),
  }),
]);
const ready = isolateSetup((db) =>
  migrateSchema(db, { table: "kilo_membership_schema", migrations: MIGRATIONS }),
);

/** principal -> { record, readAt }, oldest first. `record` is
 * `{ organizations, verifiedAtMs }` or null when the principal has none. */
const cache = new Map();

/** When `record`'s evidence stops counting, in milliseconds. */
const evidenceEnd = (record) => record.verifiedAtMs + KILO_MEMBERSHIP_SECONDS * 1000;

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
  if (!row || !Number.isSafeInteger(row.verified_at_ms)) return null;
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
    verifiedAtMs: row.verified_at_ms,
  });
}

/** The principal's membership record, `{ organizations, verifiedAtMs }`, or
 * null. Reads D1 unless this isolate read or wrote it within `CACHE_MS`. */
export async function membershipRecord(env, principal, now = Date.now()) {
  const hit = cached(principal, now);
  if (hit) return hit.record;
  await ready(env.DB);
  const record = parseRecord(
    await env.DB.prepare(
      "SELECT organizations, verified_at_ms FROM kilo_memberships WHERE principal = ?",
    )
      .bind(principal)
      .first(),
  );
  remember(principal, record, now);
  return record;
}

/**
 * Record what one exchange said about `principal`'s organizations. `sentAt`
 * is when Pages sent that exchange, in milliseconds. One statement orders it
 * against the stored row, so the newest answer wins across isolates:
 *
 * - sent later than the row: it replaces the row;
 * - sent in the same millisecond: the row keeps only the organizations both
 *   answers list. Two answers that close can't be ordered, and keeping the
 *   intersection means a tie never adds an organization, only drops one;
 * - sent earlier: nothing changes.
 *
 * The row's `verified_at_ms` never moves back. Every exchange writes, equal
 * answer or not, so that time always reaches the newest exchange seen.
 */
export async function recordKiloMembership(env, principal, organizations, sentAt) {
  await ready(env.DB);
  const stored = JSON.stringify(organizations.map(({ id, name }) => ({ id, name })));
  await env.DB.prepare(
    `INSERT INTO kilo_memberships (principal, organizations, verified_at_ms) VALUES (?, ?, ?)
    ON CONFLICT (principal) DO UPDATE SET
      organizations = CASE
        WHEN excluded.verified_at_ms > kilo_memberships.verified_at_ms THEN excluded.organizations
        ELSE (
          SELECT coalesce(json_group_array(json(answer.value)), '[]')
          FROM json_each(excluded.organizations) AS answer
          WHERE json_extract(answer.value, '$.id') IN (
            SELECT json_extract(kept.value, '$.id')
            FROM json_each(kilo_memberships.organizations) AS kept
          )
        )
      END,
      verified_at_ms = excluded.verified_at_ms
    WHERE excluded.verified_at_ms >= kilo_memberships.verified_at_ms`,
  )
    .bind(principal, stored, Math.floor(sentAt))
    .run();
  // The row may now differ from both this answer and this isolate's view.
  cache.delete(principal);
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
