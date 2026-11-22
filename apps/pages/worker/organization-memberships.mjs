/** What a deployment's organization directory last said about the
 * organizations an account belongs to, and the short-lived organization leases
 * an identity carries from it. The directory is an adapter
 * (organization-directory.mjs); `organizationDirectory` picks it.
 *
 * Every successful sign-in exchange, the browser code exchange and the agent
 * token exchange alike, reports the account's organizations through the
 * directory's `memberships`. The host keeps the newest report per principal
 * as one D1 row of `pages_organization_memberships`: the directory's
 * `provider`, the organizations, `verified_at_ms` (when Pages sent the
 * exchange that reported them, in milliseconds by Pages' clock), the
 * directory's opaque `directory_credential`, and the `capabilities` it
 * advertised with that exchange. Every successful exchange
 * writes, in one statement (`recordOrganizationMemberships`), so the row
 * always holds the newest answer any isolate received, and a slow exchange
 * can't undo a newer one. That costs one D1 write per browser sign-in, and
 * for an agent token at least one per exchange in each isolate: requests that
 * arrive together at the start of a lease each write the same answer.
 *
 * `authenticate` (auth.mjs) reads the row by principal for every directory
 * identity, whichever credential it arrived with: a browser cookie, a Pages
 * OAuth access token or an agent token. Nothing is copied into a session, an
 * OAuth grant or a token lease, so an agent connected by OAuth holds its
 * person's organizations while the person's evidence is fresh and loses them
 * the directory's `evidenceSeconds` after the person's last exchange.
 *
 * Every host a request crosses authenticates it again, so reads go through a
 * small per-isolate cache. An entry answers for at most `CACHE_MS` from its
 * read, and never past the end of the leases it yields. When a write in this
 * isolate ends, no entry read before that end survives it, and the writing
 * request's own next read goes to D1. (A read that ran wholly inside a
 * pending write may be cached until the write ends.) So a request sees a new
 * report at most 30 seconds after it is written, and an open sync socket,
 * which re-authenticates every 15 seconds, at most 45 seconds after. Only
 * settled values are cached, never a pending read (isolate-setup.mjs says
 * why).
 *
 * The directory credential and capabilities are read only by
 * `directoryAccess`, never cached, and never join the record the cache
 * holds, so the credential stays on the server and out of every identity. A
 * newer exchange without them clears them.
 *
 * Kilo deployments kept this evidence in `kilo_memberships` before the table
 * took the directory's name. Its migrations still run first, so every
 * database has that table in its last shape, and the first migration here
 * copies its rows: evidence a person holds keeps counting across the deploy.
 * Each Kilo write also goes to that table, without the credential, so a
 * build rolled back to reads current evidence, and each read takes the newer
 * of the two rows (`evidenceRow`), so an exchange a rolled-back build handled
 * counts after rolling forward. A later build stops both and drops the table
 * once every deployment has run this one for longer than the evidence
 * lasts.
 *
 * No organization id or name, and no credential, reaches a log line from
 * here. */
import { identityProvider } from "../identity-provider.mjs";
import { migrateSchema } from "./d1-schema.mjs";
import { isolateSetup } from "./isolate-setup.mjs";
import { kiloDirectory } from "./kilo-directory.mjs";
import { knownCapabilities } from "./organization-directory.mjs";

/** How long one read answers for in this isolate. */
export const CACHE_MS = 30_000;
/** How many principals one isolate remembers. */
export const MAX_CACHED = 1000;

/** This deployment's organization directory, or null when its sign-in
 * reports no organizations. */
export function organizationDirectory(env) {
  const provider = identityProvider(env);
  if (!provider.organizations) return null;
  return provider.id === "kilo" ? kiloDirectory(env) : null;
}

/** `kilo_memberships` as Kilo deployments built it, kept so the copy below
 * always reads it in its last shape. Statements as they shipped. */
const LEGACY_MIGRATIONS = Object.freeze([
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
  Object.freeze({
    version: 2,
    name: "memberships_by_millisecond",
    statements: Object.freeze([
      "DROP TABLE IF EXISTS kilo_memberships",
      `CREATE TABLE kilo_memberships (
        principal TEXT PRIMARY KEY,
        organizations TEXT NOT NULL,
        verified_at_ms INTEGER NOT NULL
      )`,
    ]),
  }),
]);

const MIGRATIONS = Object.freeze([
  // Every statement is safe to run again, and an older build keeps reading
  // and writing `kilo_memberships`, which this copies from and never
  // rewrites. A row an older build writes after the copy stays only there;
  // `evidenceRow` reads both tables, so it counts.
  Object.freeze({
    version: 1,
    name: "organization_memberships",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS pages_organization_memberships (
        principal TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        organizations TEXT NOT NULL,
        verified_at_ms INTEGER NOT NULL,
        directory_credential TEXT
      )`,
      `INSERT INTO pages_organization_memberships
        (principal, provider, organizations, verified_at_ms)
      SELECT principal, 'kilo', organizations, verified_at_ms FROM kilo_memberships WHERE true
      ON CONFLICT (principal) DO NOTHING`,
    ]),
  }),
  // What the directory advertised with that exchange, as a JSON array of
  // names. The default reads as nothing advertised, so a row an earlier
  // build of this table wrote offers nothing until that person's next
  // exchange through this build. An earlier build still running names no
  // capabilities in its write, so its update leaves the column as it was
  // and the credential it stores decides: Kilo mints one only while it
  // advertises member search.
  Object.freeze({
    version: 2,
    name: "directory_capabilities",
    statements: Object.freeze([
      `ALTER TABLE pages_organization_memberships
        ADD COLUMN capabilities TEXT NOT NULL DEFAULT '[]'`,
    ]),
  }),
]);
const ready = isolateSetup(async (db) => {
  await migrateSchema(db, { table: "kilo_membership_schema", migrations: LEGACY_MIGRATIONS });
  await migrateSchema(db, { table: "pages_organization_schema", migrations: MIGRATIONS });
});

/** principal -> { record, readAt }, oldest first. `record` is
 * `{ organizations, verifiedAtMs }` or null when the principal has none. */
const cache = new Map();

/** Counts each write's start and each write's end in this isolate. A read is
 * cached only when this count didn't change while it ran, and a write drops
 * the principal's entry when it ends. Together: no entry read before a
 * write's end survives that end, and the writing request's own next read
 * goes to D1. A read that ran wholly inside a pending write may be cached
 * until the write ends. One isolate-wide count rather
 * than one per principal: writes come once per exchange, so a read that loses
 * its cache entry to another principal's write costs one more D1 read, and
 * there is no second table to bound. */
let writes = 0;

/** When `record`'s evidence stops counting, in milliseconds. */
const evidenceEnd = (record, directory) => record.verifiedAtMs + directory.evidenceSeconds * 1000;

function remember(principal, record, now) {
  cache.delete(principal);
  cache.set(principal, { record, readAt: now });
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
}

function cached(principal, now, directory) {
  const entry = cache.get(principal);
  if (!entry) return undefined;
  const until = Math.min(
    entry.readAt + CACHE_MS,
    entry.record ? evidenceEnd(entry.record, directory) : Infinity,
  );
  if (now < until) return entry;
  cache.delete(principal);
  return undefined;
}

/** A stored row, or null for one that isn't the shape this module writes or
 * that another directory wrote. */
function parseRecord(row, directory) {
  if (!row || row.provider !== directory.provider || !Number.isSafeInteger(row.verified_at_ms))
    return null;
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

/** The newest stored answer for `principal`: `{ organizations,
 * verified_at_ms, provider, directory_credential, capabilities }`, or null.
 *
 * While `kilo_memberships` exists, a Kilo directory's answer is the newer of
 * this table's row and that one's. A build rolled back to, or an older
 * isolate, writes only the legacy table, so an exchange it handled (one that
 * removed someone from an organization, say) is newer there; the copy ran
 * once and doesn't carry it over. That row has no credential and advertises
 * nothing, so the person can't search until their next exchange through this
 * build. In a tie this
 * table's row wins. Read the new table alone once the legacy table is
 * dropped. */
async function evidenceRow(env, principal, directory) {
  if (directory.provider !== "kilo")
    return env.DB.prepare(
      `SELECT organizations, verified_at_ms, provider, directory_credential, capabilities
      FROM pages_organization_memberships WHERE principal = ?`,
    )
      .bind(principal)
      .first();
  return env.DB.prepare(
    `SELECT organizations, verified_at_ms, provider, directory_credential, capabilities,
      0 AS legacy
    FROM pages_organization_memberships WHERE principal = ?
    UNION ALL
    SELECT organizations, verified_at_ms, 'kilo', NULL, '[]', 1
    FROM kilo_memberships WHERE principal = ?
    ORDER BY verified_at_ms DESC, legacy ASC
    LIMIT 1`,
  )
    .bind(principal, principal)
    .first();
}

/** The principal's membership record, `{ organizations, verifiedAtMs }`, or
 * null. Reads D1 unless this isolate read or wrote it within `CACHE_MS`. */
export async function membershipRecord(env, principal, now = Date.now()) {
  const directory = organizationDirectory(env);
  if (!directory) return null;
  const hit = cached(principal, now, directory);
  if (hit) return hit.record;
  const writesBefore = writes;
  await ready(env.DB);
  const record = parseRecord(await evidenceRow(env, principal, directory), directory);
  if (writes === writesBefore) remember(principal, record, now);
  return record;
}

/**
 * Record what one exchange said about `principal`'s organizations. `sentAt`
 * is when Pages sent that exchange, in milliseconds. One statement orders it
 * against the stored row, so the newest answer wins across isolates:
 *
 * - sent later than the row: it replaces the row;
 * - sent in the same millisecond with the stored text: nothing changes, so
 *   the same answer written twice is a no-op;
 * - sent in the same millisecond with other text: the row lists no
 *   organizations. Two different answers that close can't be ordered, so the
 *   person holds none until their next exchange. A tie never adds one;
 * - sent earlier: nothing changes.
 *
 * The row's `verified_at_ms` never moves back. Every exchange writes, equal
 * answer or not, so that time always reaches the newest exchange seen.
 *
 * `credential` is the directory credential the exchange carried, or null. It
 * follows the same order: a later exchange replaces it, null included, and
 * one in the same millisecond keeps whichever is set. Two credentials that
 * close name the same person on the same deployment, so either serves.
 *
 * `capabilities` is what the directory advertised with the exchange. It
 * follows the organizations' rule: a later exchange replaces it, and one in
 * the same millisecond that advertised something else leaves nothing
 * advertised, so a tie never turns a feature on.
 */
export async function recordOrganizationMemberships(
  env,
  principal,
  organizations,
  sentAt,
  credential = null,
  capabilities = [],
) {
  const directory = organizationDirectory(env);
  if (!directory) throw new Error("This deployment's sign-in reports no organizations");
  writes++;
  try {
    await write(env, principal, directory.provider, organizations, sentAt, {
      credential,
      capabilities: JSON.stringify(knownCapabilities(capabilities)),
    });
  } finally {
    writes++;
    // The row may now differ from both this answer and this isolate's view,
    // so the writing request's own next read goes to D1.
    cache.delete(principal);
  }
}

/** The stored text of an answer's organizations. Invariant: the same answer
 * always yields the same text, because this is the one function that
 * serializes it, and it writes each entry's `id` then `name` and nothing
 * else, in the answer's order. The tie rule compares this text. The same
 * organizations in another order yield other text, which a tie reads as a
 * differing answer: the safe direction. */
const storedOrganizations = (organizations) =>
  JSON.stringify(organizations.map(({ id, name }) => ({ id, name })));

async function write(
  env,
  principal,
  provider,
  organizations,
  sentAt,
  { credential, capabilities },
) {
  await ready(env.DB);
  const stored = storedOrganizations(organizations);
  const table = "pages_organization_memberships";
  await env.DB.prepare(
    `INSERT INTO ${table} (principal, provider, organizations, verified_at_ms, directory_credential, capabilities)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (principal) DO UPDATE SET
      provider = excluded.provider,
      organizations = CASE
        WHEN excluded.verified_at_ms > ${table}.verified_at_ms THEN excluded.organizations
        WHEN excluded.organizations = ${table}.organizations THEN ${table}.organizations
        ELSE '[]'
      END,
      directory_credential = CASE
        WHEN excluded.verified_at_ms > ${table}.verified_at_ms
          THEN excluded.directory_credential
        ELSE COALESCE(excluded.directory_credential, ${table}.directory_credential)
      END,
      capabilities = CASE
        WHEN excluded.verified_at_ms > ${table}.verified_at_ms THEN excluded.capabilities
        WHEN excluded.capabilities = ${table}.capabilities THEN ${table}.capabilities
        ELSE '[]'
      END,
      verified_at_ms = excluded.verified_at_ms
    WHERE excluded.verified_at_ms >= ${table}.verified_at_ms`,
  )
    .bind(
      principal,
      provider,
      stored,
      Math.floor(sentAt),
      typeof credential === "string" && credential ? credential : null,
      capabilities,
    )
    .run();
  if (provider === "kilo") await writeLegacy(env, principal, stored, sentAt);
}

/** The same evidence, without the credential, in `kilo_memberships`, under
 * the statement earlier builds use: a build rolled back to, or an older
 * isolate still running, reads current evidence there, so removing someone
 * from an organization holds across a rollback. A later build stops this
 * write when it drops the table. */
async function writeLegacy(env, principal, stored, sentAt) {
  await env.DB.prepare(
    `INSERT INTO kilo_memberships (principal, organizations, verified_at_ms) VALUES (?, ?, ?)
    ON CONFLICT (principal) DO UPDATE SET
      organizations = CASE
        WHEN excluded.verified_at_ms > kilo_memberships.verified_at_ms THEN excluded.organizations
        WHEN excluded.organizations = kilo_memberships.organizations THEN kilo_memberships.organizations
        ELSE '[]'
      END,
      verified_at_ms = excluded.verified_at_ms
    WHERE excluded.verified_at_ms >= kilo_memberships.verified_at_ms`,
  )
    .bind(principal, stored, Math.floor(sentAt))
    .run();
}

/** What `identity`'s newest exchange left it for the directory, `{
 * credential, capabilities }`, or null when the evidence it came with no
 * longer counts or `identity` isn't an account of this deployment's
 * directory. `credential` is null when the exchange carried none (one an
 * older build handled carries none); `capabilities` is the known names the
 * directory advertised. A directory issues its credential with the exchange
 * and honors it for as long as Pages trusts the evidence, so a credential
 * this returns is one the directory still accepts, clocks aside. Reads D1
 * every time: it is never cached. */
export async function directoryAccess(env, identity, now = Date.now()) {
  const directory = directoryAccount(env, identity, now);
  if (!directory) return null;
  await ready(env.DB);
  const row = await evidenceRow(env, identity.principal, directory);
  if (
    !row ||
    row.provider !== directory.provider ||
    !Number.isSafeInteger(row.verified_at_ms) ||
    evidenceEnd({ verifiedAtMs: row.verified_at_ms }, directory) <= now
  )
    return null;
  let advertised;
  try {
    advertised = JSON.parse(row.capabilities);
  } catch {
    advertised = [];
  }
  return {
    credential:
      typeof row.directory_credential === "string" && row.directory_credential
        ? row.directory_credential
        : null,
    capabilities: knownCapabilities(advertised),
  };
}

/** The directory credential `identity`'s newest exchange carried while its
 * evidence counts, or null (`directoryAccess`). */
export async function directoryCredential(env, identity, now = Date.now()) {
  return (await directoryAccess(env, identity, now))?.credential ?? null;
}

/** This deployment's directory when `identity` is one of its accounts, the
 * only kind of identity organization evidence can name; else null. */
function directoryAccount(env, identity, now) {
  const directory = organizationDirectory(env);
  if (!directory) return null;
  const { namespace } = directory;
  return identity &&
    identity.namespace === namespace &&
    typeof identity.principal === "string" &&
    identity.principal.startsWith(`${namespace}:`) &&
    Number.isFinite(identity.expiresAt) &&
    identity.expiresAt > now
    ? directory
    : null;
}

/**
 * The organization leases `identity` holds now, `[{ id, name, namespace,
 * expiresAt }]`: one per organization the principal's fresh evidence names,
 * each ending when the identity does or the evidence stops counting,
 * whichever is first. Empty for any identity that isn't an account of this
 * deployment's directory.
 */
export async function organizationLeases(env, identity, now = Date.now()) {
  const directory = directoryAccount(env, identity, now);
  if (!directory) return [];
  const { namespace } = directory;
  const record = await membershipRecord(env, identity.principal, now);
  if (!record) return [];
  const expiresAt = Math.min(identity.expiresAt, evidenceEnd(record, directory));
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
  const directory = directoryAccount(env, identity, now);
  const record = directory ? await membershipRecord(env, identity.principal, now) : null;
  const fresh = !!record && Math.min(identity.expiresAt, evidenceEnd(record, directory)) > now;
  const named = new Set(record?.organizations.map(({ id }) => id));
  const proof = {};
  for (const id of ids) proof[id] = !named.has(id) ? "missing" : fresh ? "verified" : "expired";
  return proof;
}

/** Test seam: forget every cached record. */
export function resetMembershipCache() {
  cache.clear();
}
