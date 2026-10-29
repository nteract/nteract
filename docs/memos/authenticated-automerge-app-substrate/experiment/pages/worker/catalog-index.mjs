/**
 * D1 projection of each account's Page catalog.
 *
 * The projection chooses listing candidates; it never grants access. Page DOs
 * own the owner, ACL and lifecycle state. A listing returns a non-owner title
 * only after its Page DO confirms access, and an owner title only while the
 * owner's Catalog DO still has the matching `page/` or `trash/` entry. A stale
 * or missing D1 row can hide a Page from a listing; it cannot reveal one, and
 * listings look ahead and seal their cursors so a rejected row cannot change a
 * response either.
 *
 * Migrations are append-only and additive. Older builds ignore these tables,
 * and a build must keep working against a schema version newer than it knows.
 */
import { pageGrant } from "./access.mjs";
import { HttpError } from "./auth.mjs";
import { catalogTitle } from "./catalog.mjs";
import { configuredDomainView } from "./domain-access.mjs";
import { validPageId } from "./registration.mjs";

export const CATALOG_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "catalog_index",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS pages_catalog_pages (
        page_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        title_search TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'page',
        state TEXT NOT NULL DEFAULT 'active'
          CHECK (state IN ('active', 'pending', 'trashed', 'deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        trashed_at TEXT,
        acl_revision INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS pages_catalog_access (
        page_id TEXT NOT NULL,
        principal TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
        source TEXT NOT NULL CHECK (source IN ('owner', 'member', 'domain_opened')),
        domain TEXT,
        updated_revision INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (page_id, principal)
      )`,
      `CREATE INDEX IF NOT EXISTS pages_catalog_access_listing
        ON pages_catalog_access (principal, updated_at DESC, page_id DESC)`,
      `CREATE TABLE IF NOT EXISTS pages_catalog_accounts (
        principal TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        synced_at TEXT NOT NULL
      )`,
    ]),
  }),
  // Each access row keeps the title its principal was last authorized to
  // see. Clearing the markers makes every account rebuild its snapshots.
  Object.freeze({
    version: 2,
    name: "access_title_snapshot",
    statements: Object.freeze([
      "ALTER TABLE pages_catalog_access ADD COLUMN title TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE pages_catalog_access ADD COLUMN title_search TEXT NOT NULL DEFAULT ''",
      "DELETE FROM pages_catalog_accounts",
    ]),
  }),
]);

const SCHEMA_TABLE = `CREATE TABLE IF NOT EXISTS pages_catalog_schema (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;
const DIRTY = "host/index/dirty";
const SYNC = "host/index/sync";
const schemas = new WeakMap();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Mutable so tests can shorten them; production uses these bounds. */
export const catalogIndexTimeouts = {
  read: 2500,
  write: 1500,
  migration: 120_000,
  verify: 3000,
  reconcile: 1000,
};
/** Per-listing reconcile budget, and the bounds on one listing's own scan. */
export const catalogIndexBounds = {
  entries: 64,
  entriesPerListing: 128,
  verifications: 16,
  concurrency: 4,
  fallbackScan: 500,
  reconcileIntervalMs: 6 * 60 * 60 * 1000,
  cursorMaxAgeMs: 24 * 60 * 60 * 1000,
};

/** The configured value is an epoch label. Changing it reconciles every
 * account on its next listing; without a change, accounts still reconcile
 * every `reconcileIntervalMs`, and Page hosts re-report on first use after
 * a restart. */
export function catalogIndexEpoch(env) {
  const value = typeof env?.PAGES_CATALOG_INDEX === "string" ? env.PAGES_CATALOG_INDEX.trim() : "";
  if (!value || value === "false" || !/^[A-Za-z0-9._-]{1,32}$/.test(value)) return null;
  return env.DB?.prepare && env.DB.batch ? value : null;
}

export function withTimeout(promise, ms, message = "Catalog index timed out") {
  let timer;
  promise.catch?.(() => {});
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
const read = (promise) => withTimeout(promise, catalogIndexTimeouts.read);

/** Apply pending migrations in order. Each migration and its version row
 * commit in one batch; a racing isolate's duplicate version row rolls back
 * the loser, which then observes the winner's version. */
export async function migrateCatalogIndex(
  db,
  migrations = CATALOG_MIGRATIONS,
  now = () => new Date().toISOString(),
) {
  await db.prepare(SCHEMA_TABLE).run();
  const current = async () =>
    (await db.prepare("SELECT max(version) AS version FROM pages_catalog_schema").first())
      ?.version ?? 0;
  let version = await current();
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    try {
      await db.batch([
        ...migration.statements.map((sql) => db.prepare(sql)),
        db
          .prepare("INSERT INTO pages_catalog_schema (version, name, applied_at) VALUES (?, ?, ?)")
          .bind(migration.version, migration.name, now()),
      ]);
    } catch (error) {
      if ((await current()) < migration.version) throw error;
    }
    version = migration.version;
  }
  return version;
}

/** One migration attempt per database binding. A caller may time out while it
 * continues, so a slow first access warms the schema for later requests; a
 * stuck attempt expires instead of staying cached. */
export function catalogIndexDatabase(env) {
  const db = env.DB;
  let ready = schemas.get(db);
  if (!ready) {
    ready = withTimeout(
      migrateCatalogIndex(db),
      catalogIndexTimeouts.migration,
      "Catalog index migration timed out",
    ).then(
      () => db,
      (error) => {
        schemas.delete(db);
        throw error;
      },
    );
    schemas.set(db, ready);
  }
  return ready;
}

/** A fresh token per mark: a reconcile pass clears it only if no newer mark
 * arrived while the pass was running. */
export async function markCatalogIndexDirty(storage) {
  await storage.put(DIRTY, crypto.randomUUID());
}

/** Lifecycle as the index stores it. Trash keeps a deleted tombstone plus a
 * trash record until purge. */
export function indexedState(metadata) {
  if (!metadata?.deleted) return "active";
  return metadata.trash && !metadata.purged ? "trashed" : "deleted";
}
function trashedAt(metadata) {
  const value = metadata?.trash?.trashed_at ?? metadata?.trash?.trashedAt;
  if (typeof value === "string" && Number.isFinite(Date.parse(value))) return value;
  if (Number.isFinite(value)) return new Date(value).toISOString();
  return null;
}

/** Principals a Page's host record lists. Domain readers appear only when
 * observed opening the Page through the current domain view. */
export function accessRows(metadata, env, reader) {
  const members = metadata?.acl?.members ?? {};
  const rows = [{ principal: metadata.owner, role: "owner", source: "owner", domain: null }];
  for (const principal of Object.keys(members)) {
    const { role } = pageGrant(metadata, principal);
    if (role === "viewer" || role === "editor")
      rows.push({ principal, role, source: "member", domain: null });
  }
  const domain = configuredDomainView(metadata, env)?.domain ?? null;
  if (
    reader &&
    domain &&
    reader.domain === domain &&
    reader.principal !== metadata.owner &&
    !Object.hasOwn(members, reader.principal)
  )
    rows.push({ principal: reader.principal, role: "viewer", source: "domain_opened", domain });
  return { rows, memberKeys: Object.keys(members), domain };
}

/** True when moving from `previous` to `next` removes a listed principal,
 * clears or changes the domain view, or tombstones a principal who could be a
 * domain reader. Pure grants never need a pre-commit index write. */
export function listingRestricted(previous, next, env) {
  if (indexedState(next) !== "active") return true;
  const before = accessRows(previous, env),
    after = accessRows(next, env);
  const kept = new Set(after.rows.map((row) => row.principal));
  return (
    before.rows.some((row) => !kept.has(row.principal)) ||
    (before.domain !== null && before.domain !== after.domain) ||
    after.memberKeys.some(
      (key) => !before.memberKeys.includes(key) && pageGrant(next, key).role === "none",
    )
  );
}

const searchText = (title) => title.toLowerCase();
const revisionOf = (metadata) => metadata?.acl?.revision ?? 0;

/** Title and lifecycle state follow the latest observation time; the ACL
 * revision only moves forward. A deleted tombstone never changes again. */
function pageUpsert(db, page) {
  const title = catalogTitle(page.title);
  return db
    .prepare(
      `INSERT INTO pages_catalog_pages
        (page_id, owner, title, title_search, state, created_at, updated_at, trashed_at, acl_revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (page_id) DO UPDATE SET
        title = CASE WHEN excluded.updated_at >= pages_catalog_pages.updated_at
          THEN excluded.title ELSE pages_catalog_pages.title END,
        title_search = CASE WHEN excluded.updated_at >= pages_catalog_pages.updated_at
          THEN excluded.title_search ELSE pages_catalog_pages.title_search END,
        state = CASE WHEN excluded.updated_at >= pages_catalog_pages.updated_at
          THEN excluded.state ELSE pages_catalog_pages.state END,
        trashed_at = CASE WHEN excluded.updated_at >= pages_catalog_pages.updated_at
          THEN excluded.trashed_at ELSE pages_catalog_pages.trashed_at END,
        created_at = min(pages_catalog_pages.created_at, excluded.created_at),
        updated_at = max(pages_catalog_pages.updated_at, excluded.updated_at),
        acl_revision = max(pages_catalog_pages.acl_revision, excluded.acl_revision)
      WHERE pages_catalog_pages.state != 'deleted'`,
    )
    .bind(
      page.page_id,
      page.owner,
      title,
      searchText(title),
      page.state,
      page.created_at,
      page.updated_at,
      page.trashed_at ?? null,
      page.revision ?? 0,
    );
}

/** Reconciliation deletes apply only from a revision at least as new as the
 * newest one the index has seen, and only to rows written at or before it. */
const revisionGuard = `updated_revision <= ? AND ? >= coalesce(
  (SELECT acl_revision FROM pages_catalog_pages WHERE page_id = pages_catalog_access.page_id), 0)`;

/** Drop owner/member rows the host record no longer lists. */
function deleteUnlisted(db, pageId, rows, revision) {
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND source IN ('owner', 'member')
        AND principal NOT IN (SELECT value FROM json_each(?)) AND ${revisionGuard}`,
    )
    .bind(
      pageId,
      JSON.stringify(
        rows.filter((row) => row.source !== "domain_opened").map((row) => row.principal),
      ),
      revision,
      revision,
    );
}

/** Domain-reader rows survive only under the same active domain view, and
 * never for a principal with any explicit member record (including removal). */
function deleteDomainReaders(db, pageId, domain, memberKeys, revision) {
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND source = 'domain_opened'
        AND (? IS NULL OR domain IS NOT ? OR principal IN (SELECT value FROM json_each(?)))
        AND ${revisionGuard}`,
    )
    .bind(pageId, domain, domain, JSON.stringify(memberKeys), revision, revision);
}

/** Grants from a committed revision, each carrying the title snapshot its
 * principal is now authorized to see. A delayed write from an older revision
 * finds a newer acl_revision and changes nothing; a principal no longer listed
 * keeps the last title it was authorized to see. Owner rows imported from the
 * owner's own Catalog are unguarded: ownership never changes. */
function upsertAccess(db, pageId, rows, revision, { title, updatedAt, owner = false }) {
  const snapshot = catalogTitle(title);
  return db
    .prepare(
      `INSERT INTO pages_catalog_access
        (page_id, principal, role, source, domain, updated_revision, updated_at, title, title_search)
      SELECT ?, json_extract(value, '$.principal'), json_extract(value, '$.role'),
        json_extract(value, '$.source'), json_extract(value, '$.domain'), ?, ?, ?, ?
      FROM json_each(?)
      WHERE EXISTS (
        SELECT 1 FROM pages_catalog_pages
        WHERE page_id = ? AND state != 'deleted' AND (? = 1 OR acl_revision <= ?)
      )
      ON CONFLICT (page_id, principal) DO UPDATE SET
        role = excluded.role, source = excluded.source, domain = excluded.domain,
        title = CASE WHEN excluded.updated_at >= pages_catalog_access.updated_at
          THEN excluded.title ELSE pages_catalog_access.title END,
        title_search = CASE WHEN excluded.updated_at >= pages_catalog_access.updated_at
          THEN excluded.title_search ELSE pages_catalog_access.title_search END,
        updated_at = max(pages_catalog_access.updated_at, excluded.updated_at),
        updated_revision = max(pages_catalog_access.updated_revision, excluded.updated_revision)
      WHERE ? = 1 OR excluded.updated_revision >= pages_catalog_access.updated_revision`,
    )
    .bind(
      pageId,
      revision,
      updatedAt,
      snapshot,
      searchText(snapshot),
      JSON.stringify(rows),
      pageId,
      owner ? 1 : 0,
      revision,
      owner ? 1 : 0,
    );
}

/** Delete one row only if nothing newer than the observed revision has
 * replaced it since: a regrant that lands first survives a delayed prune. */
function deleteObserved(db, pageId, principal, revision) {
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND principal = ? AND updated_revision <= ?`,
    )
    .bind(pageId, principal, revision);
}

/** Full reconcile from a Page DO's committed host record. Runs after commit,
 * so it may add grants. A deleted Page is retired, never reported. */
export async function reportPageIndex(env, { metadata, title, observedAt, reader, readerOnly }) {
  const state = indexedState(metadata);
  if (state === "deleted") return;
  const db = await catalogIndexDatabase(env);
  const projection = accessRows(metadata, env, state === "active" ? reader : undefined);
  const listed =
    state === "active" ? projection.rows : projection.rows.filter((row) => row.source === "owner");
  // A reader-only report refreshes that reader's snapshot and nobody else's.
  const rows = readerOnly ? listed.filter((row) => row.principal === reader?.principal) : listed;
  const pageId = metadata.pageId;
  const revision = revisionOf(metadata);
  await db.batch([
    pageUpsert(db, {
      page_id: pageId,
      owner: metadata.owner,
      title,
      state,
      created_at: observedAt,
      updated_at: observedAt,
      trashed_at: state === "trashed" ? trashedAt(metadata) : null,
      revision,
    }),
    deleteUnlisted(db, pageId, listed, revision),
    deleteDomainReaders(
      db,
      pageId,
      state === "active" ? projection.domain : null,
      projection.memberKeys,
      revision,
    ),
    upsertAccess(db, pageId, rows, revision, { title, updatedAt: observedAt }),
  ]);
}

/** Remove listing rows `metadata` no longer allows, before the host record
 * that restricts them is durable. Delete-only and reversible: if that record
 * never commits, the Page's next report restores the rows. A trashed or
 * deleted record keeps only the owner row here; `retirePageIndex` changes
 * lifecycle state after durability. */
export async function restrictPageIndex(env, metadata, revision = revisionOf(metadata)) {
  const db = await catalogIndexDatabase(env);
  const pageId = metadata.pageId;
  const active = indexedState(metadata) === "active";
  const projection = accessRows(metadata, env);
  const rows = active ? projection.rows : projection.rows.filter((row) => row.source === "owner");
  await db.batch([
    deleteUnlisted(db, pageId, rows, revision),
    deleteDomainReaders(
      db,
      pageId,
      active ? projection.domain : null,
      projection.memberKeys,
      revision,
    ),
  ]);
}

/** Record a durable trash or deletion. Only call after the host record that
 * says so has crossed its durability barrier: a deleted tombstone is final. */
export async function retirePageIndex(env, metadata, now = new Date().toISOString()) {
  const state = indexedState(metadata);
  if (state === "active") return;
  const db = await catalogIndexDatabase(env);
  const pageId = metadata.pageId;
  if (state === "deleted") {
    await db.batch([
      db
        .prepare(
          `INSERT INTO pages_catalog_pages
            (page_id, owner, title, title_search, state, created_at, updated_at)
          VALUES (?, ?, '', '', 'deleted', ?, ?)
          ON CONFLICT (page_id) DO UPDATE SET state = 'deleted', title = '', title_search = ''`,
        )
        .bind(pageId, metadata.owner, now, now),
      db.prepare("DELETE FROM pages_catalog_access WHERE page_id = ?").bind(pageId),
    ]);
    return;
  }
  await db.batch([
    db
      .prepare(
        `UPDATE pages_catalog_pages
        SET state = 'trashed', trashed_at = ?, updated_at = max(updated_at, ?)
        WHERE page_id = ? AND state != 'deleted'`,
      )
      .bind(trashedAt(metadata) ?? now, now, pageId),
    db
      .prepare("DELETE FROM pages_catalog_access WHERE page_id = ? AND source != 'owner'")
      .bind(pageId),
    db
      .prepare(
        `UPDATE pages_catalog_access SET updated_at = max(updated_at, ?)
        WHERE page_id = ? AND source = 'owner'`,
      )
      .bind(now, pageId),
  ]);
}

/** Best-effort removal of rows a listing found stale, guarded by the
 * revision each row had when the listing read it. */
export async function pruneIndexRows(db, rows) {
  if (!rows.length) return;
  await withTimeout(
    db.batch(
      rows.map(({ page_id, principal, revision }) =>
        deleteObserved(db, page_id, principal, revision ?? 0),
      ),
    ),
    catalogIndexTimeouts.write,
  );
}

const CURSOR_PREFIX = "c2_";
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const cursorKeys = new Map();
const toBase64url = (bytes) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64url = (text) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

/** AES-GCM key derived from the deployment's session secret. Without one
 * (tests), each isolate seals with its own random key; a cursor from another
 * isolate then fails closed and the client restarts from the first page. */
function cursorKey(env) {
  const configured = env?.NOTEBOOK_CLOUD_APP_SESSION_SECRET;
  const secret = typeof configured === "string" && configured.length >= 32 ? configured : "";
  let key = cursorKeys.get(secret);
  if (!key) {
    key = secret
      ? crypto.subtle
          .importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"])
          .then((material) =>
            crypto.subtle.deriveKey(
              {
                name: "HKDF",
                hash: "SHA-256",
                salt: new Uint8Array(),
                info: encoder.encode("pages-list-cursor-v1"),
              },
              material,
              { name: "AES-GCM", length: 256 },
              false,
              ["encrypt", "decrypt"],
            ),
          )
      : crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    cursorKeys.set(secret, key);
  }
  return key;
}
const cursorContext = ({ principal, needle, inTrash }) =>
  encoder.encode(
    JSON.stringify(["pages-list-cursor-v1", principal, needle ?? "", inTrash === true]),
  );

/** Seal a keyset position. The position stays private, the cursor only
 * opens for the same principal, query and in_trash, and it expires after
 * `cursorMaxAgeMs`. */
export async function sealCursor(env, context, { updated_at, page_id }, now = Date.now()) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: cursorContext(context) },
      await cursorKey(env),
      encoder.encode(JSON.stringify([updated_at ?? "", page_id, now])),
    ),
  );
  const bytes = new Uint8Array(iv.length + sealed.length);
  bytes.set(iv);
  bytes.set(sealed, iv.length);
  return CURSOR_PREFIX + toBase64url(bytes);
}

export async function openCursor(env, context, cursor, now = Date.now()) {
  const invalid = () =>
    new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
  if (typeof cursor !== "string" || cursor.length > 256 || !cursor.startsWith(CURSOR_PREFIX))
    throw invalid();
  let value;
  try {
    const bytes = fromBase64url(cursor.slice(CURSOR_PREFIX.length));
    if (bytes.length < 29) throw invalid();
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: cursorContext(context) },
      await cursorKey(env),
      bytes.slice(12),
    );
    value = JSON.parse(decoder.decode(plain));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    typeof value[0] !== "string" ||
    !(value[0] === "" || isoTime.test(value[0])) ||
    !validPageId(value[1]) ||
    !Number.isSafeInteger(value[2]) ||
    value[2] > now + 5 * 60 * 1000 ||
    now - value[2] > catalogIndexBounds.cursorMaxAgeMs
  )
    throw invalid();
  return { updated_at: value[0], page_id: value[1] };
}

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_LEGACY_LIMIT = 100;
export const LIST_MAX_LIMIT = 100;

/** Unknown keys are ignored: older clients sent arguments this tool never
 * read. A call with none of the new arguments keeps the old page size. */
export function parseListArguments(args = {}) {
  const fail = (message) => new HttpError(400, message, "invalid_list_arguments");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw fail("Invalid list arguments");
  const legacy = ["query", "cursor", "limit", "in_trash"].every((key) => args[key] === undefined);
  const options = {
    limit: legacy ? LIST_LEGACY_LIMIT : LIST_DEFAULT_LIMIT,
    inTrash: false,
    needle: null,
    cursor: null,
  };
  if (args.query !== undefined) {
    if (typeof args.query !== "string" || args.query.length > 200)
      throw fail("query must be a string of at most 200 characters");
    options.needle = searchText(args.query.trim()) || null;
  }
  if (args.limit !== undefined) {
    if (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > LIST_MAX_LIMIT)
      throw fail(`limit must be an integer from 1 to ${LIST_MAX_LIMIT}`);
    options.limit = args.limit;
  }
  if (args.in_trash !== undefined) {
    if (typeof args.in_trash !== "boolean") throw fail("in_trash must be a boolean");
    options.inTrash = args.in_trash;
  }
  if (args.cursor !== undefined && args.cursor !== null) {
    if (typeof args.cursor !== "string" || args.cursor.length > 256)
      throw new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
    options.cursor = args.cursor;
  }
  return options;
}

export const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");
export const titleMatches = (title, needle) => !needle || searchText(title).includes(needle);
const sortKey = (row) => row.updated_at ?? "";
const before = (row, position) =>
  !position ||
  sortKey(row) < position.updated_at ||
  (sortKey(row) === position.updated_at && row.page_id < position.page_id);
const newestFirst = (a, b) =>
  sortKey(a) === sortKey(b) ? (a.page_id < b.page_id ? 1 : -1) : sortKey(a) < sortKey(b) ? 1 : -1;

/** Up to `count` candidate rows from D1 after `after`, newest first. */
export async function queryCatalogIndex(db, { principal, domain, inTrash, needle, after, count }) {
  const pattern = needle ? `%${escapeLike(needle)}%` : null;
  const result = await db
    .prepare(
      `SELECT a.page_id, a.source, a.updated_at, a.updated_revision, a.title,
        p.created_at, p.trashed_at
      FROM pages_catalog_access a
      JOIN pages_catalog_pages p ON p.page_id = a.page_id
      WHERE a.principal = ? AND p.kind = 'page'
        AND CASE WHEN ? = 1 THEN a.source = 'owner' AND p.state = 'trashed'
          ELSE a.source != 'owner' OR p.state = 'active' END
        AND (a.source != 'domain_opened' OR a.domain = ?)
        AND (? IS NULL OR a.title_search LIKE ? ESCAPE '\\')
        AND (? IS NULL OR a.updated_at < ? OR (a.updated_at = ? AND a.page_id < ?))
      ORDER BY a.updated_at DESC, a.page_id DESC
      LIMIT ?`,
    )
    .bind(
      principal,
      inTrash ? 1 : 0,
      domain ?? null,
      pattern,
      pattern,
      after?.updated_at ?? null,
      after?.updated_at ?? null,
      after?.updated_at ?? null,
      after?.page_id ?? null,
      count,
    )
    .all();
  return (result.results ?? []).map((row) => ({
    page_id: row.page_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owned: row.source === "owner",
    revision: row.updated_revision,
    ...(row.trashed_at ? { trashed_at: row.trashed_at } : {}),
  }));
}

/** Candidate source over the Catalog entries, for when the index is off or
 * unavailable. Each prefix read is bounded. */
export async function catalogSource(storage, { inTrash, needle }) {
  const list = async (prefix) => [
    ...(await storage.list({ prefix, limit: catalogIndexBounds.fallbackScan })).values(),
  ];
  const entries = inTrash
    ? (await list("trash/")).map((entry) => ({ entry, owned: true }))
    : [
        ...(await list("page/"))
          .filter((entry) => !entry.pending)
          .map((entry) => ({ entry, owned: true })),
        ...(await list("shared/")).map((entry) => ({ entry, owned: false })),
      ];
  const rows = entries
    .filter(({ entry }) => validPageId(entry?.page_id))
    .map(({ entry, owned }) => ({
      page_id: entry.page_id,
      title: catalogTitle(entry.title),
      created_at: entry.created_at,
      updated_at: entry.updated_at ?? entry.created_at,
      owned,
      ...(entry.trashed_at ? { trashed_at: entry.trashed_at } : {}),
    }))
    .filter((row) => titleMatches(row.title, needle))
    .sort(newestFirst);
  return { next: async (after, count) => rows.filter((row) => before(row, after)).slice(0, count) };
}

export class CatalogIndexUnavailable extends Error {}

/** Candidate source over D1. Its errors are marked so the listing can fall
 * back to the Catalog entries instead of failing. */
export function indexSource(db, query) {
  return {
    next: async (after, count) => {
      try {
        return await read(queryCatalogIndex(db, { ...query, after, count }));
      } catch (error) {
        throw new CatalogIndexUnavailable("Catalog index query failed", { cause: error });
      }
    },
  };
}

/** Statements for one verified grant. The Page host's own title observation
 * time orders the snapshot, so a fresh title is never paired with an older
 * discovery timestamp. */
function sharedStatements(db, principal, pageId, page, fallbackAt, createdAt) {
  const observed =
    typeof page.title_observed_at === "string" && isoTime.test(page.title_observed_at)
      ? page.title_observed_at
      : fallbackAt;
  return [
    pageUpsert(db, {
      page_id: pageId,
      owner: page.owner,
      title: page.title,
      state: "active",
      created_at: createdAt ?? observed,
      updated_at: observed,
      revision: page.revision ?? 0,
    }),
    upsertAccess(
      db,
      pageId,
      [
        {
          principal,
          role: page.role === "editor" ? "editor" : "viewer",
          source: page.source === "domain_opened" ? "domain_opened" : "member",
          domain: page.source === "domain_opened" ? (page.domain ?? null) : null,
        },
      ],
      page.revision ?? 0,
      { title: page.title, updatedAt: observed },
    ),
  ];
}

/**
 * Read whether this account's rows are usable, and advance its reconcile pass
 * when they need repair. A pass rewrites owner rows from the Catalog's `page/`
 * and `trash/` entries (title, timestamps, state), re-verifies every shared
 * entry and every non-owner D1 row with its Page host, and drops owner rows
 * the Catalog no longer has. One listing advances it until about
 * `catalogIndexTimeouts.reconcile`, `entriesPerListing` entries or
 * `verifications` Page checks, whichever comes first; the deadline is checked
 * before every step, and a step's checks run `concurrency` at a time, so one
 * listing spends at most the reconcile budget plus one check deadline. The
 * exact position persists in the Catalog, so a pass over a large account
 * (O(account size), advanced only by listings) resumes instead of holding
 * this Catalog's request queue.
 *
 * Returns true when the account's rows are complete for this epoch: a pass
 * completed now, or one completed before under the same epoch.
 */
export async function reconcileAccountIndex({
  db,
  storage,
  principal,
  epoch,
  verify,
  now = Date.now(),
}) {
  const marker = await read(
    db
      .prepare("SELECT epoch, synced_at FROM pages_catalog_accounts WHERE principal = ?")
      .bind(principal)
      .first(),
  );
  const current = marker?.epoch === epoch;
  const dirty = await storage.get(DIRTY);
  let pass = await storage.get(SYNC);
  if (pass && pass.epoch !== epoch) pass = undefined;
  const due =
    !current ||
    dirty !== undefined ||
    pass !== undefined ||
    !(Date.parse(marker.synced_at) > now - catalogIndexBounds.reconcileIntervalMs);
  if (!due) return true;
  pass ??= { epoch, phase: "owned", after: null, incomplete: false, dirty: dirty ?? null };
  const deadline = Date.now() + catalogIndexTimeouts.reconcile;
  let verifications = 0;
  let entries = 0;
  /** Verify a group concurrently; deletes carry the revision observed before
   * the check, so a regrant that lands meanwhile survives. */
  const checkShared = async (group) => {
    verifications += group.length;
    const statements = [];
    const results = await Promise.all(group.map(({ pageId }) => verify(pageId)));
    for (const [index, result] of results.entries()) {
      const { pageId, updatedAt, createdAt, revision, fromCatalog } = group[index];
      if (result.status === "ok" && result.page.state === "active" && result.page.owner)
        statements.push(
          ...sharedStatements(db, principal, pageId, result.page, updatedAt, createdAt),
        );
      else if (result.status === "ok" || result.status === "denied") {
        if (fromCatalog) await storage.delete(`shared/${pageId}`);
        if (revision !== undefined)
          statements.push(deleteObserved(db, pageId, principal, revision));
      } else pass.incomplete = true;
    }
    return statements;
  };
  const observedRevisions = async (pageIds) =>
    new Map(
      (
        (
          await read(
            db
              .prepare(
                `SELECT page_id, updated_revision FROM pages_catalog_access
                WHERE principal = ? AND page_id IN (SELECT value FROM json_each(?))`,
              )
              .bind(principal, JSON.stringify(pageIds))
              .all(),
          )
        ).results ?? []
      ).map((row) => [row.page_id, row.updated_revision]),
    );
  while (
    pass.phase !== "done" &&
    Date.now() < deadline &&
    verifications < catalogIndexBounds.verifications &&
    entries < catalogIndexBounds.entriesPerListing
  ) {
    const statements = [];
    if (pass.phase === "owned" || pass.phase === "trash") {
      const prefix = pass.phase === "owned" ? "page/" : "trash/";
      const room = Math.min(
        catalogIndexBounds.entries,
        catalogIndexBounds.entriesPerListing - entries,
      );
      const listed = [
        ...(
          await storage.list({
            prefix,
            ...(pass.after && { startAfter: pass.after }),
            limit: room,
          })
        ).entries(),
      ];
      entries += listed.length;
      for (const [, entry] of listed) {
        if (entry?.pending || !validPageId(entry?.page_id)) continue;
        const updatedAt = entry.updated_at ?? entry.created_at ?? new Date(now).toISOString();
        const state = pass.phase === "owned" ? "active" : "trashed";
        statements.push(
          pageUpsert(db, {
            page_id: entry.page_id,
            owner: principal,
            title: entry.title,
            state,
            created_at: entry.created_at ?? updatedAt,
            updated_at: updatedAt,
            trashed_at: state === "trashed" ? (entry.trashed_at ?? null) : null,
          }),
          upsertAccess(
            db,
            entry.page_id,
            [{ principal, role: "owner", source: "owner", domain: null }],
            0,
            { title: entry.title, updatedAt, owner: true },
          ),
        );
      }
      pass.after = listed.at(-1)?.[0] ?? pass.after;
      if (listed.length < room)
        Object.assign(pass, { phase: pass.phase === "owned" ? "trash" : "shared", after: null });
    } else if (pass.phase === "shared") {
      const room = Math.min(
        catalogIndexBounds.concurrency,
        catalogIndexBounds.verifications - verifications,
      );
      const listed = [
        ...(
          await storage.list({
            prefix: "shared/",
            ...(pass.after && { startAfter: pass.after }),
            limit: room,
          })
        ).entries(),
      ];
      entries += listed.length;
      const valid = listed.map(([, entry]) => entry).filter((entry) => validPageId(entry?.page_id));
      const revisions = await observedRevisions(valid.map((entry) => entry.page_id));
      statements.push(
        ...(await checkShared(
          valid.map((entry) => ({
            pageId: entry.page_id,
            updatedAt: entry.updated_at ?? new Date(now).toISOString(),
            createdAt: entry.created_at,
            revision: revisions.get(entry.page_id),
            fromCatalog: true,
          })),
        )),
      );
      pass.after = listed.at(-1)?.[0] ?? pass.after;
      if (listed.length < room) Object.assign(pass, { phase: "rows", after: null });
    } else if (pass.phase === "rows" || pass.phase === "orphans") {
      const owner = pass.phase === "orphans";
      const room = owner
        ? Math.min(catalogIndexBounds.entries, catalogIndexBounds.entriesPerListing - entries)
        : Math.min(
            catalogIndexBounds.concurrency,
            catalogIndexBounds.verifications - verifications,
          );
      const rows =
        (
          await read(
            db
              .prepare(
                `SELECT a.page_id, a.updated_at, a.updated_revision, p.created_at
                FROM pages_catalog_access a
                JOIN pages_catalog_pages p ON p.page_id = a.page_id
                WHERE a.principal = ? AND (a.source = 'owner') = ? AND (? IS NULL OR a.page_id > ?)
                ORDER BY a.page_id LIMIT ?`,
              )
              .bind(principal, owner ? 1 : 0, pass.after, pass.after, room)
              .all(),
          )
        ).results ?? [];
      entries += rows.length;
      const unchecked = [];
      for (const row of rows) {
        if (owner) {
          const entry =
            (await storage.get(`page/${row.page_id}`)) ??
            (await storage.get(`trash/${row.page_id}`));
          if (!entry)
            statements.push(deleteObserved(db, row.page_id, principal, row.updated_revision));
        } else if (!(await storage.get(`shared/${row.page_id}`))) {
          // Rows with a shared entry were verified in the previous phase.
          unchecked.push({
            pageId: row.page_id,
            updatedAt: row.updated_at,
            createdAt: row.created_at,
            revision: row.updated_revision,
            fromCatalog: false,
          });
        }
      }
      statements.push(...(await checkShared(unchecked)));
      pass.after = rows.at(-1)?.page_id ?? pass.after;
      if (rows.length < room)
        Object.assign(pass, { phase: owner ? "done" : "orphans", after: null });
    }
    for (let index = 0; index < statements.length; index += 48)
      await read(db.batch(statements.slice(index, index + 48)));
    await storage.put(SYNC, pass);
  }
  if (pass.phase !== "done") return current;
  await storage.delete(SYNC);
  if (pass.incomplete) return current;
  await read(
    db
      .prepare(
        `INSERT INTO pages_catalog_accounts (principal, epoch, synced_at) VALUES (?, ?, ?)
        ON CONFLICT (principal) DO UPDATE SET epoch = excluded.epoch, synced_at = excluded.synced_at`,
      )
      .bind(principal, epoch, new Date(now).toISOString())
      .run(),
  );
  if ((await storage.get(DIRTY)) === (pass.dirty ?? undefined)) await storage.delete(DIRTY);
  return true;
}
