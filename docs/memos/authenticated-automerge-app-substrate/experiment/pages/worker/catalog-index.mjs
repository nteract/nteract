/**
 * D1 projection of each account's Page catalog.
 *
 * The projection chooses listing candidates; it never grants access. Page DOs
 * own the owner, ACL and lifecycle state. A listing returns a non-owner title
 * only after its Page DO confirms access, and an owner title only while the
 * owner's Catalog DO still has the matching `page/` or `trash/` entry. A stale
 * or missing D1 row can hide a Page from a listing; it cannot reveal one.
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
]);

const SCHEMA_TABLE = `CREATE TABLE IF NOT EXISTS pages_catalog_schema (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
)`;
const DIRTY = "host/index/dirty";
const schemas = new WeakMap();

/** Mutable so tests can shorten them; production uses these bounds. */
export const catalogIndexTimeouts = { read: 2500, write: 1500, migration: 120_000 };

/** The configured value is an epoch label. Change it after any period in which
 * a build without the index, or with it disabled, served traffic: every
 * account then reconciles from its Catalog DO on its next listing. */
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

/** One migration attempt per database binding; callers may time out while it
 * continues, so a slow first access warms the schema for later requests. */
export function catalogIndexDatabase(env) {
  const db = env.DB;
  let ready = schemas.get(db);
  if (!ready) {
    // Bounded separately from request reads: a first access may take far
    // longer than one listing waits, but a stuck attempt must not stay cached.
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

export async function markCatalogIndexDirty(storage) {
  await storage.put(DIRTY, true);
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
        created_at = min(pages_catalog_pages.created_at, excluded.created_at),
        updated_at = max(pages_catalog_pages.updated_at, excluded.updated_at),
        state = excluded.state,
        trashed_at = excluded.trashed_at,
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

/** Drop owner/member rows the host record no longer lists. */
function deleteUnlisted(db, pageId, rows) {
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND source IN ('owner', 'member')
        AND principal NOT IN (SELECT value FROM json_each(?))`,
    )
    .bind(
      pageId,
      JSON.stringify(
        rows.filter((row) => row.source !== "domain_opened").map((row) => row.principal),
      ),
    );
}

/** Domain-reader rows survive only under the same active domain view, and
 * never for a principal with any explicit member record (including removal). */
function deleteDomainReaders(db, pageId, domain, memberKeys) {
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND source = 'domain_opened'
        AND (? IS NULL OR domain IS NOT ? OR principal IN (SELECT value FROM json_each(?)))`,
    )
    .bind(pageId, domain, domain, JSON.stringify(memberKeys));
}

function upsertAccess(db, pageId, rows, revision) {
  return db
    .prepare(
      `INSERT INTO pages_catalog_access
        (page_id, principal, role, source, domain, updated_revision, updated_at)
      SELECT ?, json_extract(value, '$.principal'), json_extract(value, '$.role'),
        json_extract(value, '$.source'), json_extract(value, '$.domain'), ?,
        (SELECT updated_at FROM pages_catalog_pages WHERE page_id = ?)
      FROM json_each(?)
      WHERE EXISTS (SELECT 1 FROM pages_catalog_pages WHERE page_id = ? AND state != 'deleted')
      ON CONFLICT (page_id, principal) DO UPDATE SET
        role = excluded.role, source = excluded.source, domain = excluded.domain,
        updated_revision = excluded.updated_revision`,
    )
    .bind(pageId, revision, pageId, JSON.stringify(rows), pageId);
}

/** Listings sort by the Page's last observed title/sharing change. The copy
 * on each access row keeps the per-principal listing an index range scan. */
function syncSortKey(db, pageId) {
  return db
    .prepare(
      `UPDATE pages_catalog_access
      SET updated_at = (SELECT updated_at FROM pages_catalog_pages WHERE page_id = ?)
      WHERE page_id = ? AND EXISTS (SELECT 1 FROM pages_catalog_pages WHERE page_id = ?)`,
    )
    .bind(pageId, pageId, pageId);
}

function deleteAccess(db, pageId, principal) {
  return db
    .prepare("DELETE FROM pages_catalog_access WHERE page_id = ? AND principal = ?")
    .bind(pageId, principal);
}

/** Full reconcile from a Page DO's committed host record. Runs after commit,
 * so it may add grants. */
export async function reportPageIndex(env, { metadata, title, observedAt, reader }) {
  const state = indexedState(metadata);
  if (state === "deleted") return restrictPageIndex(env, metadata);
  const db = await catalogIndexDatabase(env);
  const projection = accessRows(metadata, env, state === "active" ? reader : undefined);
  const rows =
    state === "active" ? projection.rows : projection.rows.filter((row) => row.source === "owner");
  const pageId = metadata.pageId;
  await db.batch([
    pageUpsert(db, {
      page_id: pageId,
      owner: metadata.owner,
      title,
      state,
      created_at: observedAt,
      updated_at: observedAt,
      trashed_at: state === "trashed" ? trashedAt(metadata) : null,
      revision: metadata.acl?.revision ?? 0,
    }),
    deleteUnlisted(db, pageId, rows),
    deleteDomainReaders(
      db,
      pageId,
      state === "active" ? projection.domain : null,
      projection.memberKeys,
    ),
    upsertAccess(db, pageId, rows, metadata.acl?.revision ?? 0),
    syncSortKey(db, pageId),
  ]);
}

/** Remove listing rows that `metadata` no longer allows. Runs before the host
 * record commits, so it only ever deletes rows or marks lifecycle state. */
export async function restrictPageIndex(env, metadata) {
  const db = await catalogIndexDatabase(env);
  const pageId = metadata.pageId;
  const state = indexedState(metadata);
  if (state === "deleted") {
    const now = new Date().toISOString();
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
  const projection = accessRows(metadata, env);
  const rows =
    state === "active" ? projection.rows : projection.rows.filter((row) => row.source === "owner");
  await db.batch([
    ...(state === "trashed"
      ? [
          db
            .prepare(
              `UPDATE pages_catalog_pages SET state = 'trashed', trashed_at = ?
              WHERE page_id = ? AND state != 'deleted'`,
            )
            .bind(trashedAt(metadata) ?? new Date().toISOString(), pageId),
        ]
      : []),
    deleteUnlisted(db, pageId, rows),
    deleteDomainReaders(
      db,
      pageId,
      state === "active" ? projection.domain : null,
      projection.memberKeys,
    ),
  ]);
}

/** Best-effort removal of one stale row found by listing verification. */
export async function pruneIndexRows(db, rows) {
  if (!rows.length) return;
  await withTimeout(
    db.batch(rows.map(({ page_id, principal }) => deleteAccess(db, page_id, principal))),
    catalogIndexTimeouts.write,
  );
}

const CURSOR_PREFIX = "c1_";
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const base64url = (text) => btoa(text).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** Opaque keyset position: (updated_at, page_id) of the last scanned row.
 * Entries from older builds may lack updated_at; they sort last. */
export function encodeCursor({ updated_at, page_id }) {
  return CURSOR_PREFIX + base64url(JSON.stringify([updated_at ?? "", page_id]));
}
export function decodeCursor(cursor) {
  const invalid = () =>
    new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
  if (typeof cursor !== "string" || cursor.length > 256 || !cursor.startsWith(CURSOR_PREFIX))
    throw invalid();
  let value;
  try {
    value = JSON.parse(
      atob(cursor.slice(CURSOR_PREFIX.length).replaceAll("-", "+").replaceAll("_", "/")),
    );
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    typeof value[0] !== "string" ||
    !(value[0] === "" || isoTime.test(value[0])) ||
    !validPageId(value[1])
  )
    throw invalid();
  return { updated_at: value[0], page_id: value[1] };
}

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 100;

/** Unknown keys are ignored: older clients sent arguments this tool never read. */
export function parseListArguments(args = {}) {
  const fail = (message) => new HttpError(400, message, "invalid_list_arguments");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw fail("Invalid list arguments");
  const options = { limit: LIST_DEFAULT_LIMIT, inTrash: false, needle: null, cursor: null };
  if (args.query !== undefined) {
    if (typeof args.query !== "string" || args.query.length > 200)
      throw fail("query must be a string of at most 200 characters");
    const needle = searchText(args.query.trim());
    options.needle = needle || null;
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
  if (args.cursor !== undefined && args.cursor !== null) options.cursor = decodeCursor(args.cursor);
  return options;
}

export const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");
export const titleMatches = (title, needle) => !needle || searchText(title).includes(needle);
const sortKey = (row) => row.updated_at ?? "";
const before = (row, cursor) =>
  !cursor ||
  sortKey(row) < cursor.updated_at ||
  (sortKey(row) === cursor.updated_at && row.page_id < cursor.page_id);
const newestFirst = (a, b) =>
  sortKey(a) === sortKey(b) ? (a.page_id < b.page_id ? 1 : -1) : sortKey(a) < sortKey(b) ? 1 : -1;

/** Candidate rows from D1, newest first. Returns at most `limit` rows plus the
 * keyset position after the last scanned row, independent of verification. */
export async function queryCatalogIndex(db, { principal, domain, inTrash, needle, cursor, limit }) {
  const pattern = needle ? `%${escapeLike(needle)}%` : null;
  const result = await db
    .prepare(
      `SELECT a.page_id, a.source, a.updated_at, p.title, p.created_at, p.trashed_at
      FROM pages_catalog_access a
      JOIN pages_catalog_pages p ON p.page_id = a.page_id
      WHERE a.principal = ? AND p.kind = 'page' AND p.state = ?
        AND (? = 0 OR a.source = 'owner')
        AND (a.source != 'domain_opened' OR a.domain = ?)
        AND (? IS NULL OR p.title_search LIKE ? ESCAPE '\\')
        AND (? IS NULL OR a.updated_at < ? OR (a.updated_at = ? AND a.page_id < ?))
      ORDER BY a.updated_at DESC, a.page_id DESC
      LIMIT ?`,
    )
    .bind(
      principal,
      inTrash ? "trashed" : "active",
      inTrash ? 1 : 0,
      domain ?? null,
      pattern,
      pattern,
      cursor?.updated_at ?? null,
      cursor?.updated_at ?? null,
      cursor?.updated_at ?? null,
      cursor?.page_id ?? null,
      limit + 1,
    )
    .all();
  const scanned = result.results ?? [];
  const rows = scanned.slice(0, limit).map((row) => ({
    page_id: row.page_id,
    title: row.title,
    created_at: row.created_at,
    updated_at: row.updated_at,
    owned: row.source === "owner",
    ...(row.trashed_at ? { trashed_at: row.trashed_at } : {}),
  }));
  return { rows, next_cursor: scanned.length > limit ? encodeCursor(rows.at(-1)) : null };
}

async function listAll(storage, prefix) {
  return [...(await storage.list({ prefix })).values()];
}

/** Candidate rows from the Catalog DO when the index is off or unavailable. */
export async function catalogCandidates(storage, { inTrash, needle, cursor, limit }) {
  const entries = inTrash
    ? (await listAll(storage, "trash/")).map((entry) => ({ entry, owned: true }))
    : [
        ...(await listAll(storage, "page/"))
          .filter((entry) => !entry.pending)
          .map((entry) => ({ entry, owned: true })),
        ...(await listAll(storage, "shared/")).map((entry) => ({ entry, owned: false })),
      ];
  const scanned = entries
    .filter(({ entry }) => validPageId(entry?.page_id))
    .map(({ entry, owned }) => ({
      page_id: entry.page_id,
      title: catalogTitle(entry.title),
      created_at: entry.created_at,
      updated_at: entry.updated_at ?? entry.created_at,
      owned,
      ...(entry.trashed_at ? { trashed_at: entry.trashed_at } : {}),
    }))
    .filter((row) => titleMatches(row.title, needle) && before(row, cursor))
    .sort(newestFirst);
  const rows = scanned.slice(0, limit);
  return { rows, next_cursor: scanned.length > limit ? encodeCursor(rows.at(-1)) : null };
}

/**
 * Reconcile one account's D1 rows from its Catalog DO: the account's lazy
 * backfill, and its repair after a write that may not have reached D1. Owned
 * entries are imported directly. Shared entries missing from D1 are verified
 * against their Page DOs once; denied entries are pruned from the Catalog DO.
 * The marker is written only when every shared entry got a definite answer.
 */
export async function syncAccountIndex({ db, storage, principal, epoch, verify }) {
  const [owned, trashed, shared] = await Promise.all([
    listAll(storage, "page/"),
    listAll(storage, "trash/"),
    listAll(storage, "shared/"),
  ]);
  const existing = new Map(
    (
      await read(
        db
          .prepare(
            `SELECT a.page_id, a.source, p.state FROM pages_catalog_access a
            JOIN pages_catalog_pages p ON p.page_id = a.page_id
            WHERE a.principal = ?`,
          )
          .bind(principal)
          .all(),
      )
    ).results.map((row) => [row.page_id, row]),
  );
  const statements = [];
  const ownedIds = new Set();
  for (const [entries, state] of [
    [owned, "active"],
    [trashed, "trashed"],
  ]) {
    for (const entry of entries) {
      if (entry.pending || !validPageId(entry.page_id)) continue;
      ownedIds.add(entry.page_id);
      const row = existing.get(entry.page_id);
      if (row?.source === "owner" && row.state === state) continue;
      const updatedAt = entry.updated_at ?? entry.created_at ?? new Date().toISOString();
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
        ),
        syncSortKey(db, entry.page_id),
      );
    }
  }
  for (const [pageId, row] of existing)
    if (row.source === "owner" && !ownedIds.has(pageId))
      statements.push(deleteAccess(db, pageId, principal));
  const missing = shared.filter(
    (entry) =>
      validPageId(entry?.page_id) && !existing.has(entry.page_id) && !ownedIds.has(entry.page_id),
  );
  let complete = true;
  for (let index = 0; index < missing.length; index += 8) {
    const group = missing.slice(index, index + 8);
    const results = await Promise.all(group.map((entry) => verify(entry.page_id)));
    for (const [offset, result] of results.entries()) {
      const entry = group[offset];
      if (result.status === "denied") {
        await storage.delete(`shared/${entry.page_id}`);
      } else if (result.status !== "ok") {
        complete = false;
      } else if (result.page.state === "active" && result.page.owner) {
        const updatedAt = entry.updated_at ?? new Date().toISOString();
        statements.push(
          pageUpsert(db, {
            page_id: entry.page_id,
            owner: result.page.owner,
            title: result.page.title,
            state: "active",
            created_at: entry.created_at ?? updatedAt,
            updated_at: updatedAt,
            revision: result.page.revision,
          }),
          upsertAccess(
            db,
            entry.page_id,
            [
              {
                principal,
                role: result.page.role === "editor" ? "editor" : "viewer",
                source: result.page.source === "domain_opened" ? "domain_opened" : "member",
                domain: result.page.source === "domain_opened" ? result.page.domain : null,
              },
            ],
            result.page.revision ?? 0,
          ),
          syncSortKey(db, entry.page_id),
        );
      }
    }
  }
  for (let index = 0; index < statements.length; index += 48)
    await read(db.batch(statements.slice(index, index + 48)));
  if (!complete) return false;
  await read(
    db
      .prepare(
        `INSERT INTO pages_catalog_accounts (principal, epoch, synced_at) VALUES (?, ?, ?)
        ON CONFLICT (principal) DO UPDATE SET epoch = excluded.epoch, synced_at = excluded.synced_at`,
      )
      .bind(principal, epoch, new Date().toISOString())
      .run(),
  );
  await storage.delete(DIRTY);
  return true;
}

/** Candidate rows from D1, reconciling the account first when needed. */
export async function indexedCandidates({
  env,
  storage,
  principal,
  epoch,
  domain,
  options,
  verify,
}) {
  const db = await read(catalogIndexDatabase(env));
  const marker = await read(
    db
      .prepare("SELECT epoch FROM pages_catalog_accounts WHERE principal = ?")
      .bind(principal)
      .first(),
  );
  if (marker?.epoch !== epoch || (await storage.get(DIRTY)))
    await syncAccountIndex({ db, storage, principal, epoch, verify });
  return { db, ...(await read(queryCatalogIndex(db, { principal, domain, ...options }))) };
}
