/**
 * D1 projection of each account's Page catalog.
 *
 * The projection chooses listing candidates; it never grants access. Page DOs
 * own the owner, ACL and lifecycle state. A listing returns a non-owner title
 * only after its Page DO confirms access, and an owner title only while the
 * owner's Catalog DO still has the matching `page/` or `trash/` entry. A stale
 * or missing D1 row can hide a Page from a listing; it cannot reveal a title.
 * Search and ordering use each principal's own snapshot of the titles it was
 * authorized to see. A title-sorted listing orders by that snapshot while it
 * shows the title the owner's Catalog or the Page host returns, so a Page
 * renamed since its snapshot can appear out of order until its row is
 * rewritten. A listing looks ahead for one verified row, but a scan
 * stopped by its bound can still return a cursor positioned over stale rows
 * whose snapshots the caller was previously authorized to see.
 *
 * Activity order follows `activity_at`: the time the Page host last accepted
 * a content change (`content_updated_at`, content-activity.mjs), else the
 * row's `updated_at`. Content times only move forward. A listing shows a
 * shared row's content time from its Page host's check, never from D1.
 * Trash's activity is trashing: under `in_trash` the default sort lists by
 * `trashed_at`, most recent first.
 *
 * Migrations are append-only and additive. Older builds ignore these tables,
 * and a build must keep working against a schema version newer than it knows.
 *
 * Callers see Projects. Storage keeps the Space name so a rollback build reads
 * the same records: `pages_catalog_spaces`, the `space_id` column and the
 * `host/index/spaces-*` markers. project-api.mjs maps `space_id` in results.
 */
import { sessionKeyring } from "@cloud/session-keyring.ts";
import { pageGrant, pageState } from "./access.mjs";
import {
  accountIndexMachine,
  accountIndexState,
  indexCooldownMachine,
  indexCooldownState,
  pageIndexMarkMachine,
  pageIndexMarkState,
} from "./account-index-machine.mjs";
import { HttpError } from "./auth.mjs";
import { catalogTitle, listAll, trashTime } from "./catalog.mjs";
import { acceptedTime, validTime } from "./content-activity.mjs";
import { configuredDomainView } from "./domain-access.mjs";
import { validPageId } from "./registration.mjs";
import { holdUntilSettled } from "./request-hold.mjs";
import { requirePageIdArgument, requireSpaceIdArgument, validSpaceId } from "./spaces.mjs";

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
  // The Page's lifecycle revision fences state changes and access writes, so
  // a delayed trash retirement or stale report can't undo a restore.
  Object.freeze({
    version: 3,
    name: "lifecycle_revision",
    statements: Object.freeze([
      "ALTER TABLE pages_catalog_pages ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0",
    ]),
  }),
  // Spaces get their own rows, keyed by owner: only the owner lists a Space
  // in this build. The page placement columns stay in the schema; nothing
  // writes or reads them, because location lives in the owner's Catalog.
  Object.freeze({
    version: 4,
    name: "spaces",
    statements: Object.freeze([
      "ALTER TABLE pages_catalog_pages ADD COLUMN space_id TEXT",
      "ALTER TABLE pages_catalog_pages ADD COLUMN parent_id TEXT",
      "ALTER TABLE pages_catalog_pages ADD COLUMN position TEXT",
      "ALTER TABLE pages_catalog_pages ADD COLUMN placement_epoch INTEGER",
      `CREATE INDEX IF NOT EXISTS pages_catalog_pages_placement
        ON pages_catalog_pages (space_id, parent_id)`,
      `CREATE TABLE IF NOT EXISTS pages_catalog_spaces (
        space_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        title_search TEXT NOT NULL,
        -- Legacy schema history: v8 drops this never-read column.
        home_page_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS pages_catalog_spaces_listing
        ON pages_catalog_spaces (owner, updated_at DESC, space_id DESC)`,
    ]),
  }),
  // Title-sorted listings page by (title_search, page_id) within a principal.
  Object.freeze({
    version: 5,
    name: "access_title_listing",
    statements: Object.freeze([
      `CREATE INDEX IF NOT EXISTS pages_catalog_access_title
        ON pages_catalog_access (principal, title_search, page_id)`,
    ]),
  }),
  // When each Page's content last changed, as its host reports it, and the
  // two keys the activity and created sorts page by within a principal.
  // `activity_at` is generated, so every writer keeps it right, including a
  // build that predates it: the content time once known, else `updated_at`.
  // `created_at` is copied from the Page row; a row a build without it
  // inserts holds '' (sorts last) until this build rewrites it.
  Object.freeze({
    version: 6,
    name: "content_activity_listing",
    statements: Object.freeze([
      "ALTER TABLE pages_catalog_pages ADD COLUMN content_updated_at TEXT",
      "ALTER TABLE pages_catalog_access ADD COLUMN content_updated_at TEXT",
      "ALTER TABLE pages_catalog_access ADD COLUMN created_at TEXT NOT NULL DEFAULT ''",
      `ALTER TABLE pages_catalog_access ADD COLUMN activity_at TEXT
        GENERATED ALWAYS AS (coalesce(content_updated_at, updated_at)) VIRTUAL`,
      `UPDATE pages_catalog_access SET created_at = coalesce(
        (SELECT created_at FROM pages_catalog_pages p WHERE p.page_id = pages_catalog_access.page_id),
        '')`,
      `CREATE INDEX IF NOT EXISTS pages_catalog_access_activity
        ON pages_catalog_access (principal, activity_at DESC, page_id DESC)`,
      `CREATE INDEX IF NOT EXISTS pages_catalog_access_created
        ON pages_catalog_access (principal, created_at DESC, page_id DESC)`,
    ]),
  }),
  // Trash lists the most recently trashed Page first. `trash_key` is
  // generated from `trashed_at`, which every build sets when it records a
  // trash and clears on restore, so a build without this migration keeps it
  // right. The index holds only trashed rows, keyed by owner: Trash lists
  // only the caller's own Pages.
  Object.freeze({
    version: 7,
    name: "trash_listing",
    statements: Object.freeze([
      `ALTER TABLE pages_catalog_pages ADD COLUMN trash_key TEXT
        GENERATED ALWAYS AS (coalesce(trashed_at, '')) VIRTUAL`,
      `CREATE INDEX IF NOT EXISTS pages_catalog_pages_trash
        ON pages_catalog_pages (owner, trash_key DESC, page_id DESC) WHERE state = 'trashed'`,
    ]),
  }),
  // Projects have no separate root Page any more; their rows lose the column
  // that named it. Nothing read it. SQLite can't drop a NOT NULL column that
  // an index doesn't cover on every D1 version, so the table is rebuilt.
  Object.freeze({
    version: 8,
    name: "spaces_without_root_page",
    statements: Object.freeze([
      `CREATE TABLE pages_catalog_spaces_v8 (
        space_id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        title TEXT NOT NULL,
        title_search TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `INSERT INTO pages_catalog_spaces_v8
        (space_id, owner, title, title_search, created_at, updated_at)
        SELECT space_id, owner, title, title_search, created_at, updated_at
        FROM pages_catalog_spaces`,
      "DROP TABLE pages_catalog_spaces",
      "ALTER TABLE pages_catalog_spaces_v8 RENAME TO pages_catalog_spaces",
      `CREATE INDEX IF NOT EXISTS pages_catalog_spaces_listing
        ON pages_catalog_spaces (owner, updated_at DESC, space_id DESC)`,
    ]),
  }),
]);

const DIRTY = "host/index/dirty";
const SYNC = "host/index/sync";
/** One Page's index mark: `PAGE_MARK + pageId` holds a token
 * (account-index-machine.mjs `pageIndexMarkMachine`). */
const PAGE_MARK = "host/index/page/";
/** When this account's first pages may try D1 again, in ms
 * (account-index-machine.mjs `indexCooldownMachine`). */
const UNAVAILABLE_UNTIL = "host/index/unavailable-until";
const SPACES_DIRTY = "host/index/spaces-dirty";
/** Per D1 binding: `SCHEMA_READY`, or the attempts running per calling
 * object (`catalogIndexDatabase`). */
const schemas = new WeakMap();
const SCHEMA_READY = Symbol("catalog index schema ready");
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
  /** Page index marks one listing settles; owned marks need one D1 write. */
  pageMarks: 24,
  /** How long first pages read the Catalog after D1 failed a D1 walk. */
  unavailableCooldownMs: 60_000,
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
  return migrateSchema(db, { table: "pages_catalog_schema", migrations, now });
}

/** Apply `migrations` in order, recording each version in `table`. Each
 * schema keeps its own version table, so its migrations number from 1. */
export async function migrateSchema(
  db,
  { table, migrations, now = () => new Date().toISOString() },
) {
  if (!/^[a-z_]+$/.test(table)) throw new TypeError("Invalid schema table name");
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ${table} (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    )
    .run();
  const current = async () =>
    (await db.prepare(`SELECT max(version) AS version FROM ${table}`).first())?.version ?? 0;
  let version = await current();
  for (const migration of migrations) {
    if (migration.version <= version) continue;
    try {
      await db.batch([
        ...migration.statements.map((sql) => db.prepare(sql)),
        db
          .prepare(`INSERT INTO ${table} (version, name, applied_at) VALUES (?, ?, ?)`)
          .bind(migration.version, migration.name, now()),
      ]);
    } catch (error) {
      if ((await current()) < migration.version) throw error;
    }
    version = migration.version;
  }
  return version;
}

/**
 * The D1 binding, once its catalog index schema is current.
 *
 * Durable Objects in one isolate share this module, but each runs its I/O in
 * its own context. A promise one object started may never settle for another:
 * if the starter resets mid-flight, its D1 call and its expiry timer can be
 * dropped with it. So objects share only settled readiness. `schemas` holds,
 * per binding, one of two states:
 *
 * - `SCHEMA_READY`: an attempt succeeded. Every later call returns the binding
 *   without touching D1.
 * - a `WeakMap` from each calling object's `ctx` to the attempt that object is
 *   running: no attempt has succeeded yet.
 *
 * An object that finds no attempt of its own starts one, under its own expiry
 * timer (`catalogIndexTimeouts.migration`), even while another object's is
 * running. Never awaiting another object's attempt keeps every caller's wait on
 * its own clock. Racing attempts are safe: each migration commits with its
 * version row in one batch, and the loser rolls back and reads the winner's
 * version (`migrateSchema`). Concurrent calls from one object share its
 * attempt. A failed or expired attempt is forgotten, so the next call retries.
 *
 * `ctx` is the calling object's state, and it is required. A caller may stop
 * waiting at its own read or write bound while the attempt continues, so a
 * slow first access warms the schema for later requests. Each call that starts
 * or joins an attempt holds it on its request (request-hold.mjs), so a request
 * that stops waiting can't strand it.
 */
export function catalogIndexDatabase(env, ctx) {
  if (!ctx || typeof ctx !== "object")
    throw new TypeError("catalogIndexDatabase needs the calling object's ctx");
  const db = env.DB;
  let attempts = schemas.get(db);
  if (attempts === SCHEMA_READY) return Promise.resolve(db);
  if (!attempts) schemas.set(db, (attempts = new WeakMap()));
  const running = attempts.get(ctx);
  if (running) {
    holdUntilSettled(ctx, running);
    return running;
  }
  const attempt = withTimeout(
    migrateCatalogIndex(db),
    catalogIndexTimeouts.migration,
    "Catalog index migration timed out",
  ).then(
    () => {
      schemas.set(db, SCHEMA_READY);
      return db;
    },
    (error) => {
      if (attempts.get(ctx) === attempt) attempts.delete(ctx);
      throw error;
    },
  );
  attempts.set(ctx, attempt);
  holdUntilSettled(ctx, attempt);
  return attempt;
}

/** A fresh token per mark: a reconcile pass clears it only if no newer mark
 * arrived while the pass was running. */
export async function markCatalogIndexDirty(storage) {
  await storage.put(DIRTY, crypto.randomUUID());
}

/**
 * Mark `pageIds` before a write to their entries, so listings don't read D1
 * until it holds them. Returns the marks, each `{ key, pageId, token }`, for
 * `settlePageMark` once the write's own D1 rows land. With the index off, no
 * listing settles marks, so the account is marked dirty instead, which the
 * first pass after the index returns clears.
 */
export async function markPagesForIndex(env, storage, pageIds) {
  if (!catalogIndexEpoch(env)) {
    await markCatalogIndexDirty(storage);
    return [];
  }
  const marks = pageIds.map((pageId) => ({
    key: `${PAGE_MARK}${pageId}`,
    pageId,
    token: crypto.randomUUID(),
  }));
  if (marks.length)
    await storage.put(Object.fromEntries(marks.map((mark) => [mark.key, mark.token])));
  return marks;
}

/** Settle the mark `{ key, pageId, token }` a writer read, with `outcome`
 * (`pageIndexMarkMachine`). Reads the stored token and runs the effects with
 * no I/O between, so a newer mark survives. */
export async function settlePageMark(storage, { key, pageId, token }, outcome) {
  const state = pageIndexMarkState(await storage.get(key));
  const step = pageIndexMarkMachine.step(state, { type: "checked", token, outcome });
  for (const effect of step.effects)
    if (effect.type === "forget_entry") await storage.delete(`shared/${pageId}`);
    else if (effect.type === "clear") await storage.delete(key);
}

/** The account's D1 cooldown state at `now` (`indexCooldownMachine`). */
export async function readIndexCooldown(storage, now = Date.now()) {
  return indexCooldownState(await storage.get(UNAVAILABLE_UNTIL), now);
}

/** D1 couldn't serve a walk that began there: start or extend the cooldown,
 * so the walk's restart and other first pages read the Catalog for a while. */
export async function coolIndex(storage, now = Date.now()) {
  const state = await readIndexCooldown(storage, now);
  const step = indexCooldownMachine.step(state, {
    type: "refused",
    now,
    cooldownMs: catalogIndexBounds.unavailableCooldownMs,
  });
  for (const effect of step.effects)
    if (effect.type === "store") await storage.put(UNAVAILABLE_UNTIL, effect.until);
}

/** True while any Page index mark is stored. */
async function pageMarksPending(storage) {
  return (await storage.list({ prefix: PAGE_MARK, limit: 1 })).size > 0;
}

/** Lifecycle as the index stores it. Trash keeps a deleted tombstone plus a
 * trash record until purge. */
export function indexedState(metadata) {
  const state = pageState(metadata);
  return state === "missing" ? "active" : state;
}
/** The host record's trash time as the Catalog's `trash/` entry stores it
 * (catalog.mjs `trashTime`), or null. */
const trashedAt = (metadata) =>
  trashTime(metadata?.trash?.trashed_at ?? metadata?.trash?.trashedAt);

/** The first of `values` that is a listing time (`validTime`), else null. A
 * Catalog entry's stored time is trusted only in that format: a number would
 * reach D1 as text such as "1790818740000.0", and another date string would
 * sort by its spelling. Neither can be sealed into a cursor. */
const firstTime = (...values) => values.find(validTime) ?? null;

/** Principals a Page's host record lists. Domain readers appear only when
 * observed opening the Page through the current domain view. */
export function accessRows(metadata, env, reader) {
  const members = metadata?.acl?.members ?? {};
  const rows = [{ principal: metadata.owner, role: "owner", source: "owner", domain: null }];
  for (const principal of Object.keys(members)) {
    const { role } = pageGrant(metadata, principal);
    // The index lists; it never grants. Its role column predates commenters
    // and accepts owner, editor and viewer, so a commenter lists as a viewer.
    if (role === "viewer" || role === "editor" || role === "commenter")
      rows.push({
        principal,
        role: role === "commenter" ? "viewer" : role,
        source: "member",
        domain: null,
      });
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
const lifecycleOf = (metadata) => metadata?.lifecycleRevision ?? 0;
/** True when the bound lifecycle revision is at least the Page row's. */
const lifecycleGuard = (pageId) =>
  `? >= coalesce((SELECT lifecycle_revision FROM pages_catalog_pages WHERE page_id = ${pageId}), 0)`;

/** SQL for the later of two nullable timestamps. SQLite's two-argument max()
 * returns NULL when either is NULL. */
const laterSql = (a, b) => `nullif(max(coalesce(${a}, ''), coalesce(${b}, '')), '')`;
/** SQL for the earlier of two NOT NULL timestamps, where '' means unknown: a
 * known time replaces '', and '' never replaces one. */
const earlierSql = (a, b) =>
  `CASE WHEN ${a} = '' THEN ${b} WHEN ${b} = '' THEN ${a} ELSE min(${a}, ${b}) END`;

/** Title follows the latest observation time. Lifecycle state follows the
 * newest lifecycle revision, then observation time within one revision.
 * Location lives in the owner's Catalog, and these rows don't carry it. The ACL and
 * lifecycle revisions only move forward, and so does `content_updated_at`:
 * a delayed report can't move it back. A deleted tombstone never changes
 * again. With `keep_time`, a write whose title and state equal the row's
 * keeps the row's `updated_at`: it repeats an observation (index.mjs
 * `titleObservation`). */
function pageUpsert(db, page) {
  const title = catalogTitle(page.title);
  const newerState = `excluded.lifecycle_revision > pages_catalog_pages.lifecycle_revision
    OR (excluded.lifecycle_revision = pages_catalog_pages.lifecycle_revision
      AND excluded.updated_at >= pages_catalog_pages.updated_at)`;
  return db
    .prepare(
      `INSERT INTO pages_catalog_pages
        (page_id, owner, title, title_search, state, created_at, updated_at, trashed_at,
          acl_revision, lifecycle_revision, content_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (page_id) DO UPDATE SET
        content_updated_at = ${laterSql("pages_catalog_pages.content_updated_at", "excluded.content_updated_at")},
        title = CASE WHEN excluded.updated_at >= pages_catalog_pages.updated_at
          THEN excluded.title ELSE pages_catalog_pages.title END,
        title_search = CASE WHEN excluded.updated_at >= pages_catalog_pages.updated_at
          THEN excluded.title_search ELSE pages_catalog_pages.title_search END,
        state = CASE WHEN ${newerState} THEN excluded.state ELSE pages_catalog_pages.state END,
        trashed_at = CASE WHEN ${newerState}
          THEN excluded.trashed_at ELSE pages_catalog_pages.trashed_at END,
        created_at = ${earlierSql("pages_catalog_pages.created_at", "excluded.created_at")},
        updated_at = CASE WHEN ? = 1 AND excluded.title = pages_catalog_pages.title
            AND excluded.state = pages_catalog_pages.state
          THEN pages_catalog_pages.updated_at
          ELSE max(pages_catalog_pages.updated_at, excluded.updated_at) END,
        acl_revision = max(pages_catalog_pages.acl_revision, excluded.acl_revision),
        lifecycle_revision = max(pages_catalog_pages.lifecycle_revision, excluded.lifecycle_revision)
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
      page.lifecycle ?? 0,
      // A time further ahead of this writer's clock than nodes skew is dropped.
      acceptedTime(page.content_updated_at),
      page.keep_time ? 1 : 0,
    );
}

/** Reconciliation deletes apply only from a revision at least as new as the
 * newest one the index has seen, and only to rows written at or before it. */
const revisionGuard = `updated_revision <= ? AND ? >= coalesce(
  (SELECT acl_revision FROM pages_catalog_pages WHERE page_id = pages_catalog_access.page_id), 0)`;

/** Drop owner/member rows the host record no longer lists. */
function deleteUnlisted(db, pageId, rows, revision, lifecycle) {
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND source IN ('owner', 'member')
        AND principal NOT IN (SELECT value FROM json_each(?)) AND ${revisionGuard}
        AND ${lifecycleGuard("pages_catalog_access.page_id")}`,
    )
    .bind(
      pageId,
      JSON.stringify(
        rows.filter((row) => row.source !== "domain_opened").map((row) => row.principal),
      ),
      revision,
      revision,
      lifecycle,
    );
}

/** Domain-reader rows survive only under the same active domain view, and
 * never for a principal with any explicit member record (including removal). */
function deleteDomainReaders(db, pageId, domain, memberKeys, revision, lifecycle) {
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND source = 'domain_opened'
        AND (? IS NULL OR domain IS NOT ? OR principal IN (SELECT value FROM json_each(?)))
        AND ${revisionGuard} AND ${lifecycleGuard("pages_catalog_access.page_id")}`,
    )
    .bind(pageId, domain, domain, JSON.stringify(memberKeys), revision, revision, lifecycle);
}

/** Grants from a committed revision, each carrying the title snapshot its
 * principal is now authorized to see. A delayed write from an older revision
 * finds a newer acl_revision and changes nothing; a principal no longer listed
 * keeps the last title it was authorized to see. Snapshots change only here:
 * from Page host reports (members on title changes, a domain reader when it
 * opens the Page) and from account reconciliation after the Page host
 * verifies the principal. Owner rows imported from the owner's own Catalog
 * are unguarded: ownership never changes.
 *
 * Each row copies the Page row's `created_at` and `content_updated_at`, so
 * call this after `pageUpsert` in the same batch. The content time only moves
 * forward. With `keepTime`, a row whose snapshot already equals `title`
 * keeps its `updated_at`, as `pageUpsert` keeps the Page row's. */
function upsertAccess(
  db,
  pageId,
  rows,
  revision,
  { title, updatedAt, owner = false, lifecycle = 0, keepTime = false },
) {
  const snapshot = catalogTitle(title);
  return db
    .prepare(
      `INSERT INTO pages_catalog_access
        (page_id, principal, role, source, domain, updated_revision, updated_at, title, title_search,
          created_at, content_updated_at)
      SELECT ?, json_extract(value, '$.principal'), json_extract(value, '$.role'),
        json_extract(value, '$.source'), json_extract(value, '$.domain'), ?, ?, ?, ?,
        coalesce(p.created_at, ''), p.content_updated_at
      FROM json_each(?)
      JOIN pages_catalog_pages p ON p.page_id = ?
      WHERE p.state != 'deleted'
        AND (? = 1 OR (p.acl_revision <= ? AND p.lifecycle_revision <= ?))
      ON CONFLICT (page_id, principal) DO UPDATE SET
        created_at = excluded.created_at,
        content_updated_at = ${laterSql("pages_catalog_access.content_updated_at", "excluded.content_updated_at")},
        role = excluded.role, source = excluded.source, domain = excluded.domain,
        title = CASE WHEN excluded.updated_at >= pages_catalog_access.updated_at
          THEN excluded.title ELSE pages_catalog_access.title END,
        title_search = CASE WHEN excluded.updated_at >= pages_catalog_access.updated_at
          THEN excluded.title_search ELSE pages_catalog_access.title_search END,
        updated_at = CASE WHEN ? = 1 AND excluded.title = pages_catalog_access.title
          THEN pages_catalog_access.updated_at
          ELSE max(pages_catalog_access.updated_at, excluded.updated_at) END,
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
      lifecycle,
      keepTime ? 1 : 0,
      owner ? 1 : 0,
    );
}

/** Delete one row only if nothing newer than the observed revision has
 * replaced it since: a regrant that lands first survives a delayed prune. */
function deleteObserved(db, pageId, principal, revision, updatedAt = null) {
  // A row rewritten since the listing read it (a restore or regrant at the
  // same ACL revision advances updated_at) survives a delayed prune.
  return db
    .prepare(
      `DELETE FROM pages_catalog_access
      WHERE page_id = ? AND principal = ? AND updated_revision <= ?
        AND (? IS NULL OR updated_at <= ?)`,
    )
    .bind(pageId, principal, revision, updatedAt, updatedAt);
}

/** Full reconcile from a Page DO's committed host record. Runs after commit,
 * so it may add grants. A deleted Page is retired, never reported.
 * `contentUpdatedAt` is the host's newest content time, when it has one.
 * `keepTime` repeats an observation: rows whose title already equals `title`
 * keep their `updated_at`, and new rows take `observedAt`. */
export async function reportPageIndex(
  env,
  ctx,
  { metadata, title, observedAt, reader, readerOnly, contentUpdatedAt, keepTime = false },
) {
  const state = indexedState(metadata);
  if (state === "deleted") return;
  const db = await catalogIndexDatabase(env, ctx);
  const projection = accessRows(metadata, env, state === "active" ? reader : undefined);
  const listed =
    state === "active" ? projection.rows : projection.rows.filter((row) => row.source === "owner");
  // A reader-only report refreshes that reader's snapshot and nobody else's.
  const rows = readerOnly ? listed.filter((row) => row.principal === reader?.principal) : listed;
  const pageId = metadata.pageId;
  const revision = revisionOf(metadata);
  const lifecycle = lifecycleOf(metadata);
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
      lifecycle,
      content_updated_at: contentUpdatedAt,
      keep_time: keepTime,
    }),
    deleteUnlisted(db, pageId, listed, revision, lifecycle),
    deleteDomainReaders(
      db,
      pageId,
      state === "active" ? projection.domain : null,
      projection.memberKeys,
      revision,
      lifecycle,
    ),
    upsertAccess(db, pageId, rows, revision, {
      title,
      updatedAt: observedAt,
      lifecycle,
      keepTime,
    }),
  ]);
}

/** Record a Page host's newest content time on its Page row and its owner and
 * member access rows, in one batch. The time only moves forward, so a delayed
 * report changes nothing once a newer one has landed, and rows already at or
 * past it aren't rewritten. It inserts nothing: a Page without rows waits for
 * its next full report. A row for someone who can no longer read the Page
 * still lists nothing, because each shared row is verified with its Page host
 * before it is shown.
 *
 * One report rewrites the Page row plus one row per owner and member, at most
 * once per content window while the Page is edited.
 * Domain readers' rows (`domain_opened`) are unbounded on a domain-wide Page,
 * so they aren't touched here. The Page host reports a reader's row again
 * when that reader opens the Page and the host's content time has moved past
 * the one its last report for that reader carried (index.mjs `cacheTitle`).
 * Its account's reconcile pass (`reconcileIntervalMs`, on that reader's own
 * listings) also copies it. Until one of those, the row sorts by its older
 * time, and a reader's listing shows the time from the host's check either
 * way. A time further ahead of this clock than nodes skew writes nothing. */
export async function reportContentActivity(env, ctx, { pageId, contentUpdatedAt }) {
  if (!validTime(contentUpdatedAt)) throw new TypeError("contentUpdatedAt must be an ISO time");
  if (!acceptedTime(contentUpdatedAt)) return;
  const db = await catalogIndexDatabase(env, ctx);
  const stale = "(content_updated_at IS NULL OR content_updated_at < ?)";
  await db.batch([
    db
      .prepare(
        `UPDATE pages_catalog_pages SET content_updated_at = ?
        WHERE page_id = ? AND state != 'deleted' AND ${stale}`,
      )
      .bind(contentUpdatedAt, pageId, contentUpdatedAt),
    db
      .prepare(
        `UPDATE pages_catalog_access SET content_updated_at = ?
        WHERE page_id = ? AND source IN ('owner', 'member') AND ${stale}`,
      )
      .bind(contentUpdatedAt, pageId, contentUpdatedAt),
  ]);
}

/** Remove listing rows `metadata` no longer allows, before the host record
 * that restricts them is durable. Delete-only and reversible: if that record
 * never commits, the Page's next report restores the rows. A trashed or
 * deleted record keeps only the owner row here; `retirePageIndex` changes
 * lifecycle state after durability. */
export async function restrictPageIndex(env, ctx, metadata, revision = revisionOf(metadata)) {
  const db = await catalogIndexDatabase(env, ctx);
  const pageId = metadata.pageId;
  const active = indexedState(metadata) === "active";
  const projection = accessRows(metadata, env);
  const rows = active ? projection.rows : projection.rows.filter((row) => row.source === "owner");
  const lifecycle = lifecycleOf(metadata);
  await db.batch([
    deleteUnlisted(db, pageId, rows, revision, lifecycle),
    deleteDomainReaders(
      db,
      pageId,
      active ? projection.domain : null,
      projection.memberKeys,
      revision,
      lifecycle,
    ),
  ]);
}

/** A deleted Page's tombstone: no title, no access rows, and no later write
 * changes it. */
function tombstoneStatements(db, pageId, owner, lifecycle, now = new Date().toISOString()) {
  return [
    db
      .prepare(
        `INSERT INTO pages_catalog_pages
          (page_id, owner, title, title_search, state, created_at, updated_at, lifecycle_revision)
        VALUES (?, ?, '', '', 'deleted', ?, ?, ?)
        ON CONFLICT (page_id) DO UPDATE SET state = 'deleted', title = '', title_search = '',
          lifecycle_revision = max(lifecycle_revision, excluded.lifecycle_revision)`,
      )
      .bind(pageId, owner, now, now, lifecycle),
    db.prepare("DELETE FROM pages_catalog_access WHERE page_id = ?").bind(pageId),
  ];
}

/** Record a durable trash or deletion. Only call after the host record that
 * says so has crossed its durability barrier: a deleted tombstone is final. */
export async function retirePageIndex(env, ctx, metadata, now = new Date().toISOString()) {
  const state = indexedState(metadata);
  if (state === "active") return;
  const db = await catalogIndexDatabase(env, ctx);
  const pageId = metadata.pageId;
  if (state === "deleted") {
    await db.batch(tombstoneStatements(db, pageId, metadata.owner, lifecycleOf(metadata), now));
    return;
  }
  // Fenced by lifecycle revision: a retirement delayed past a restore (or a
  // later regrant) finds a newer revision and changes nothing. A host trash
  // time that isn't a date stays null, as in the Catalog's `trash/` entry
  // (catalog.mjs `trashTime`), so it sorts last in both.
  const lifecycle = lifecycleOf(metadata);
  await db.batch([
    db
      .prepare(
        `UPDATE pages_catalog_pages
        SET state = 'trashed', trashed_at = ?, updated_at = max(updated_at, ?),
          lifecycle_revision = ?
        WHERE page_id = ? AND state != 'deleted' AND lifecycle_revision <= ?`,
      )
      .bind(trashedAt(metadata), now, lifecycle, pageId, lifecycle),
    db
      .prepare(
        `DELETE FROM pages_catalog_access WHERE page_id = ? AND source != 'owner'
          AND ${lifecycleGuard("pages_catalog_access.page_id")}`,
      )
      .bind(pageId, lifecycle),
    db
      .prepare(
        `UPDATE pages_catalog_access SET updated_at = max(updated_at, ?)
        WHERE page_id = ? AND source = 'owner' AND ${lifecycleGuard("pages_catalog_access.page_id")}`,
      )
      .bind(now, pageId, lifecycle),
  ]);
}

/** Best-effort removal of rows a listing found stale, guarded by the
 * revision each row had when the listing read it. */
export async function pruneIndexRows(db, rows) {
  if (!rows.length) return;
  await withTimeout(
    db.batch(
      rows.map(({ page_id, principal, revision, updated_at }) =>
        deleteObserved(db, page_id, principal, revision ?? 0, updated_at ?? null),
      ),
    ),
    catalogIndexTimeouts.write,
  );
}

const CURSOR_PREFIX = "c2_";
/** Longest cursor `openCursor` accepts. A title-sorted cursor carries its
 * position's title key, up to 500 code units of title (`catalogTitle`), so it
 * can run to a few kilobytes; activity cursors stay under 200 characters. */
export const CURSOR_MAX_LENGTH = 8192;
/** Longest cursor for a listing whose positions are only `updated_at` and an
 * ID, such as list_projects. */
export const SHORT_CURSOR_MAX_LENGTH = 256;
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

/** AES-GCM keys derived from the deployment's session keyring, the active key
 * first (see `sessionKeyring`). A cursor is sealed with the active key and
 * opens under any key, so cursors issued before a rotation keep working until
 * they expire. Without a key (tests), each isolate seals with its own random
 * key; a cursor from another isolate then fails closed and the client
 * restarts from the first page. A malformed keyring throws. */
function cursorKeysFor(env) {
  const keyring = sessionKeyring(env);
  return keyring ? keyring.keys.map(({ secret }) => cursorKey(secret)) : [cursorKey("")];
}

function cursorKey(secret) {
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
/** `scope` binds a cursor to everything else that shapes its listing: a
 * Space, a parent, kind, access and sort (see `listScope`), or the Space
 * listing itself. Cursors without one keep their original bytes. `source`,
 * which needs a scope, binds a Page listing's cursor to the candidate source
 * that issued it (`LIST_SOURCES`); cursors without one keep their bytes too. */
const cursorContext = ({ principal, needle, inTrash, scope, source }) => {
  if (source !== undefined && !scope) throw new TypeError("A cursor source needs a scope");
  return encoder.encode(
    JSON.stringify([
      "pages-list-cursor-v1",
      principal,
      needle ?? "",
      inTrash === true,
      ...(scope ? [scope] : []),
      ...(source !== undefined ? [source] : []),
    ]),
  );
};

/**
 * A Page listing's candidate sources: D1 (`index`) and this account's own
 * Catalog entries (`catalog`). They order shared rows by different times: D1
 * holds the Page row's own creation and content times, the Catalog this
 * account's discovery time and the last projection's. A walk that switched
 * sources would resume one order from a position in the other and skip or
 * repeat rows, so every cursor names its source, and a walk continues on it.
 */
export const LIST_SOURCES = Object.freeze(["index", "catalog"]);

/** Seal a cursor payload. The payload stays private, the cursor only opens
 * for the same principal, query, in_trash and scope (location, kind, access
 * and sort filters), and it expires after `cursorMaxAgeMs`. The payload is
 * `[updated_at, page_id, issued]`, plus `title_search` as a fourth element
 * when it is a string. Every build since sealed cursors opens the
 * three-element layout; the four-element one opens on builds since title
 * sort.
 * Page listings seal positions through `sealPosition`, which maps each
 * sort's position onto these slots. Spaces seal `{ updated_at, page_id }`
 * directly: a Space's own time is its key. */
export async function sealCursor(
  env,
  context,
  { updated_at, page_id, title_search },
  now = Date.now(),
) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const position = [updated_at ?? "", page_id, now];
  if (typeof title_search === "string") position.push(title_search);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: cursorContext(context) },
      await cursorKeysFor(env)[0],
      encoder.encode(JSON.stringify(position)),
    ),
  );
  const bytes = new Uint8Array(iv.length + sealed.length);
  bytes.set(iv);
  bytes.set(sealed, iv.length);
  return CURSOR_PREFIX + toBase64url(bytes);
}

/** Open a sealed cursor. `maxLength` is the longest cursor the listing can
 * issue: `CURSOR_MAX_LENGTH` for Page listings, `SHORT_CURSOR_MAX_LENGTH` for
 * listings whose positions carry no title key. */
export async function openCursor(
  env,
  context,
  cursor,
  now = Date.now(),
  { maxLength = CURSOR_MAX_LENGTH } = {},
) {
  const invalid = () =>
    new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
  if (typeof cursor !== "string" || cursor.length > maxLength || !cursor.startsWith(CURSOR_PREFIX))
    throw invalid();
  // Outside the try: a malformed keyring is a server fault, not a bad cursor.
  const keys = cursorKeysFor(env);
  let value;
  try {
    const bytes = fromBase64url(cursor.slice(CURSOR_PREFIX.length));
    if (bytes.length < 29) throw invalid();
    let plain;
    for (const key of keys) {
      try {
        plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv: bytes.slice(0, 12), additionalData: cursorContext(context) },
          await key,
          bytes.slice(12),
        );
        break;
      } catch {
        // AES-GCM authenticates: a wrong key fails here, and the next is tried.
      }
    }
    if (!plain) throw invalid();
    value = JSON.parse(decoder.decode(plain));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(value) ||
    !(value.length === 3 || (value.length === 4 && typeof value[3] === "string")) ||
    typeof value[0] !== "string" ||
    !(value[0] === "" || isoTime.test(value[0])) ||
    !(validPageId(value[1]) || validSpaceId(value[1])) ||
    !Number.isSafeInteger(value[2]) ||
    value[2] > now + 5 * 60 * 1000 ||
    now - value[2] > catalogIndexBounds.cursorMaxAgeMs
  )
    throw invalid();
  return {
    updated_at: value[0],
    page_id: value[1],
    ...(value.length === 4 && { title_search: value[3] }),
  };
}

/** Seal a Page listing position (see `positionOf`) in the payload layout
 * `sealCursor` documents. An activity, created or trashed position seals its
 * key in the time slot, as builds since content activity have. A title position
 * seals its title key in the fourth slot and "" in the time slot, which no
 * title listing has ever read. */
export async function sealPosition(env, context, sort, position, now = Date.now()) {
  const { page_id } = requirePosition(sort, position);
  return sealCursor(
    env,
    context,
    sort === "title"
      ? { updated_at: "", page_id, title_search: position.title_search }
      : { updated_at: position.key, page_id },
    now,
  );
}

/** Open a Page listing cursor into `sort`'s position shape. The scope binds
 * the sort, so a payload of the other layout is malformed: a title position
 * needs its title key, and a time-keyed one must not carry one. A title
 * cursor sealed with a row's `updated_at` in its time slot opens to the same
 * position as one sealed with "". */
export async function openPosition(env, context, cursor, sort, now = Date.now()) {
  const opened = await openCursor(env, context, cursor, now);
  const title = sort === "title";
  if (title !== (typeof opened.title_search === "string"))
    throw new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
  return title
    ? { title_search: opened.title_search, page_id: opened.page_id }
    : { key: opened.updated_at, page_id: opened.page_id };
}

/** Open a Page listing cursor: its position, and the source that issued it
 * (`LIST_SOURCES`), or null for a cursor an earlier build sealed without
 * one. Each source seals under its own context, so a cursor opens under
 * exactly one; a cursor from an earlier build opens only without a source.
 * Anything else fails with `invalid_cursor`. */
export async function openListingCursor(env, context, cursor, sort, now = Date.now()) {
  for (const source of [...LIST_SOURCES, undefined]) {
    try {
      const position = await openPosition(env, { ...context, source }, cursor, sort, now);
      return { position, source: source ?? null };
    } catch (error) {
      if (error?.code !== "invalid_cursor" || source === undefined) throw error;
    }
  }
}

export const LIST_DEFAULT_LIMIT = 50;
export const LIST_LEGACY_LIMIT = 100;
export const LIST_MAX_LIMIT = 100;

/** Unknown keys are ignored: older clients sent arguments this tool never
 * read. A call with none of the new arguments keeps the old page size.
 *
 * `access` narrows the listing to owned Pages ("owned") or Pages shared with
 * the caller ("shared"); null lists both. `sort` is "activity" (newest
 * `activity_at` first: the content time, else `updated_at`), "created"
 * (newest `created_at` first) or "title" (title key ascending, then Page
 * ID). Null or omitted `access` and `sort` mean the defaults. Trash and Projects hold only
 * owned Pages, so "shared" refuses in_trash and project_id rather than
 * answering an empty list that looks like a real one.
 *
 * Under `in_trash`, "activity" means the most recently trashed first, and
 * the options carry the internal "trashed" order for it: in Trash, being
 * trashed is a Page's latest activity, and an edit can't happen there. The
 * caller never names "trashed". */
export function parseListArguments(args = {}) {
  const fail = (message) => new HttpError(400, message, "invalid_list_arguments");
  if (!args || typeof args !== "object" || Array.isArray(args))
    throw fail("Invalid list arguments");
  // null `access` or `sort` is the default, so it leaves a bare call bare.
  const legacy =
    ["query", "cursor", "limit", "in_trash", "space_id", "parent_id", "kind"].every(
      (key) => args[key] === undefined,
    ) && ["access", "sort"].every((key) => args[key] == null);
  const options = {
    limit: legacy ? LIST_LEGACY_LIMIT : LIST_DEFAULT_LIMIT,
    inTrash: false,
    needle: null,
    cursor: null,
    spaceId: null,
    // undefined: any parent; null: top level; otherwise that parent's children.
    parentId: undefined,
    kind: null,
    access: null,
    sort: "activity",
  };
  if (args.access !== undefined && args.access !== null) {
    if (args.access !== "owned" && args.access !== "shared")
      throw fail("access must be owned or shared");
    options.access = args.access;
  }
  if (args.sort !== undefined && args.sort !== null) {
    if (!LIST_SORTS.includes(args.sort)) throw fail("sort must be activity, created or title");
    options.sort = args.sort;
  }
  if (args.space_id !== undefined && args.space_id !== null)
    options.spaceId = requireSpaceIdArgument(args.space_id);
  if (args.parent_id === null) {
    if (!options.spaceId)
      throw fail("parent_id null lists a Project's top level; pass project_id too");
    options.parentId = null;
  } else if (args.parent_id !== undefined)
    options.parentId = requirePageIdArgument(args.parent_id, "parent_id");
  if (args.kind !== undefined) {
    if (!["page", "notebook", "dashboard", "result"].includes(args.kind))
      throw fail("kind must be page, notebook, dashboard or result");
    options.kind = args.kind;
  }
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
    if (typeof args.cursor !== "string" || args.cursor.length > CURSOR_MAX_LENGTH)
      throw new HttpError(400, "Invalid cursor; restart from the first page", "invalid_cursor");
    options.cursor = args.cursor;
  }
  if (options.inTrash && (options.spaceId || options.parentId !== undefined))
    throw fail("in_trash lists your whole Trash; it does not combine with project_id or parent_id");
  if (options.access === "shared" && options.inTrash)
    throw fail("Trash lists only Pages you own; in_trash does not combine with access shared");
  if (options.access === "shared" && options.spaceId)
    throw fail(
      "Projects hold only their owner's Pages; project_id does not combine with access shared",
    );
  if (options.inTrash && options.sort === "activity") options.sort = "trashed";
  return options;
}

/** The sorts a caller can name. */
const LIST_SORTS = Object.freeze(["activity", "created", "title"]);

/** The name each sort seals into its cursor scope. A scope name stands for
 * one meaning of a position's key, so a cursor opens only where its key
 * means the same thing: "content_activity" positions hold `activity_at`,
 * "created" positions `created_at`, "title" positions `title_search`,
 * "trashed" positions `trash_key`. An activity cursor sealed with no scope,
 * or a scope that names no sort or names "activity", held an `updated_at`
 * key and fails with `invalid_cursor`. So does a Trash cursor sealed under
 * "content_activity": it held an `activity_at` key. A change to what a
 * sort's key means needs a new name. */
const SCOPE_SORTS = Object.freeze({
  activity: "content_activity",
  created: "created",
  title: "title",
  trashed: "trashed",
});

/** Cursor scope for a listing: its location, kind, access and sort, so a
 * cursor never opens under a different filter or order. */
export function listScope(options) {
  return JSON.stringify([
    options.spaceId ?? null,
    options.parentId ?? null,
    options.parentId === undefined,
    options.kind ?? null,
    options.access ?? null,
    SCOPE_SORTS[options.sort ?? "activity"],
  ]);
}

export const escapeLike = (value) => value.replace(/[\\%_]/g, "\\$&");
export const titleMatches = (title, needle) => !needle || searchText(title).includes(needle);

/** The longest `LIKE` or `GLOB` pattern D1 accepts, in UTF-8 bytes
 * (https://developers.cloudflare.com/d1/platform/limits/). A longer one fails
 * the query. */
export const LIKE_PATTERN_MAX_BYTES = 50;

/**
 * The `LIKE` pattern a search binds: `%…%` around the longest prefix of
 * `needle` whose escaped form keeps the whole pattern within
 * `LIKE_PATTERN_MAX_BYTES` of UTF-8. The cut falls between code points, and
 * each character's escape stays with it, so the pattern never ends in a
 * dangling `\`. A cut pattern matches a superset of the rows the full needle
 * matches; `queryCatalogIndex` marks the rest. Every database gets the same
 * pattern, so a search behaves the same on celld's SQLite as on D1.
 */
export function likePattern(needle) {
  let budget = LIKE_PATTERN_MAX_BYTES - 2;
  let escaped = "";
  for (const char of needle) {
    const piece = escapeLike(char);
    const bytes = encoder.encode(piece).length;
    if (bytes > budget) break;
    budget -= bytes;
    escaped += piece;
  }
  return `%${escaped}%`;
}
/** The title key a title-sorted listing orders by: the same lowercased,
 * capped title the index stores as `title_search`. An empty title sorts
 * first; a missing one is stored as "Untitled" and sorts as that word. */
export const titleKey = (title) => searchText(catalogTitle(title));

/** Code point order of two strings: the order SQLite's BINARY collation gives
 * the UTF-8 text D1 stores. Plain `<` compares UTF-16 code units, which puts
 * astral characters (surrogate pairs) before U+E000–U+FFFF. */
export function compareText(a, b) {
  if (a === b) return 0;
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) {
    let x = a.charCodeAt(index),
      y = b.charCodeAt(index);
    if (x === y) continue;
    if (x >= 0xd800 && y >= 0xd800) {
      x += x >= 0xe000 ? -0x800 : 0x2000;
      y += y >= 0xe000 ? -0x800 : 0x2000;
    }
    return x < y ? -1 : 1;
  }
  return a.length < b.length ? -1 : 1;
}

/** The activity key: the Page's content time once known, else `updated_at`.
 * The index generates `activity_at` with the same rule. */
export const activityKey = (row) => row.content_updated_at || row.updated_at || "";
const comparePageIds = (a, b) => (a.page_id < b.page_id ? -1 : a.page_id > b.page_id ? 1 : 0);
/** A stored title key as the title order reads it: any value but a string
 * reads as "". */
const keyText = (value) => (typeof value === "string" ? value : "");
/** A stored time key as the time orders read it: anything but a listing time
 * (`validTime`) reads as "", so a malformed key (a number, "2026-10-01", an
 * RFC 1123 date) sorts last instead of jumping the order or sealing a cursor
 * `openCursor` refuses. Reconciliation indexes the same entry by its fallback
 * time, and the Catalog source computes that fallback too (`catalogSource`). */
const timeKey = (value) => (validTime(value) ? value : "");
/** Newest first by an ISO time key (plain `<` is byte order over ASCII), then
 * Page ID descending. A missing key is "" and sorts last, as SQLite puts ''
 * after every timestamp in a descending index. Positions are
 * `{ key, page_id }`. `read` turns a stored key into its sort key. */
const newestBy = (stored, read = timeKey) => {
  const key = (row) => read(stored(row));
  return {
    fields: ["key", "page_id"],
    position: (row) => ({ key: key(row), page_id: row.page_id }),
    seek: (position) => position.key,
    compare: (a, b) => (key(a) === key(b) ? -comparePageIds(a, b) : key(a) < key(b) ? 1 : -1),
    follows: (row, position) =>
      !position ||
      key(row) < position.key ||
      (key(row) === position.key && row.page_id < position.page_id),
  };
};
const titleOf = (row) => keyText(row.title_search);
/** One listing order. `position(row)` is where a page that stopped on `row`
 * resumes, in the one shape this order's positions have. `compare` sorts
 * candidate rows, `follows(row, position)` keeps the rows strictly after a
 * position, and `seek(position)` is the key `listingQuery` compares. Each
 * matches the ORDER BY and keyset condition of the same sort there.
 * "trashed" lists only Trash (see `parseListArguments`): its key is
 * `trashed_at`, or "" without one, as D1 generates `trash_key`. */
const ORDERS = {
  activity: newestBy((row) => row.activity_at ?? activityKey(row)),
  created: newestBy((row) => row.created_at),
  title: {
    fields: ["page_id", "title_search"],
    position: (row) => ({ title_search: titleOf(row), page_id: row.page_id }),
    seek: (position) => position.title_search,
    compare: (a, b) => compareText(titleOf(a), titleOf(b)) || comparePageIds(a, b),
    follows: (row, position) =>
      !position ||
      compareText(titleOf(row), position.title_search) > 0 ||
      (titleOf(row) === position.title_search && row.page_id > position.page_id),
  },
  trashed: newestBy((row) => row.trashed_at),
};
const listOrder = (sort) => ORDERS[sort] ?? ORDERS.activity;

/**
 * The position a Page listing in `sort` resumes from after `row`: a D1 row, a
 * Catalog fallback row or a child ID row. Activity, created and trashed
 * positions are `{ key, page_id }`, where `key` is the order's time key
 * (`activity_at`, `created_at` or `trashed_at`), never the row's
 * `updated_at`. Title positions are
 * `{ title_search, page_id }`. The cursor seal, the scan's refetch position
 * and the next cursor all come from here, and every source reads only this
 * shape, so a raw row can't stand in for a position.
 */
export const positionOf = (sort, row) => listOrder(sort).position(row);

/** `position` unchanged when it has exactly `sort`'s position fields, or
 * null for a first page. Anything else is a programming error: a source
 * handed a raw row would seek by the wrong key. */
export function requirePosition(sort, position) {
  if (position == null) return null;
  const { fields } = listOrder(sort);
  const keys = Object.keys(position).sort();
  if (
    keys.length !== fields.length ||
    keys.some((key, index) => key !== fields[index]) ||
    typeof listOrder(sort).seek(position) !== "string" ||
    typeof position.page_id !== "string"
  )
    throw new TypeError(`A ${sort} listing position is {${fields.join(", ")}}; got {${keys}}`);
  return position;
}

/** Spaces list by `updated_at`, newest first. A Space position is
 * `{ updated_at, page_id }`: a Space row's own time is its key, so a raw row
 * is already its position, and `before` compares it as stored. */
const newestFirst = newestBy((row) => row.updated_at ?? "", keyText).compare;
const before = (row, after) =>
  !after ||
  (row.updated_at ?? "") < after.updated_at ||
  ((row.updated_at ?? "") === after.updated_at && row.page_id < after.page_id);

/** SQL and parameters for one page of D1 candidates. The SQL text depends
 * only on `access`, `sort` and whether `after` holds a position; every value
 * is a bound parameter. `after` is null or a `positionOf(sort, …)`. */
export function listingQuery({
  principal,
  domain,
  inTrash,
  needle,
  after,
  count,
  access = null,
  sort = "activity",
}) {
  const pattern = needle ? likePattern(needle) : null;
  if (sort === "trashed") return trashQuery({ principal, inTrash, pattern, after, count });
  const title = sort === "title";
  const accessFilter =
    access === "owned"
      ? "AND a.source = 'owner'"
      : access === "shared"
        ? "AND a.source != 'owner'"
        : "";
  // Each sort walks its own index after `principal = ?`.
  const column = title ? "a.title_search" : sort === "created" ? "a.created_at" : "a.activity_at";
  const order = title ? `${column} ASC, a.page_id ASC` : `${column} DESC, a.page_id DESC`;
  // A continuation page compares a row value, which SQLite turns into a range
  // seek on the listing index after `principal = ?`. A first page has no
  // position, so it carries no keyset predicate at all.
  const continued = requirePosition(sort, after) !== null;
  const key = continued ? listOrder(sort).seek(after) : null;
  const keyset = !continued ? "" : `AND (${column}, a.page_id) ${title ? ">" : "<"} (?, ?)`;
  return {
    sql: `SELECT a.page_id, a.source, a.updated_at, a.updated_revision, a.title, a.title_search,
        a.created_at, a.content_updated_at, a.activity_at, p.trashed_at
      FROM pages_catalog_access a
      JOIN pages_catalog_pages p ON p.page_id = a.page_id
      WHERE a.principal = ? AND p.kind = 'page'
        AND CASE WHEN ? = 1 THEN a.source = 'owner' AND p.state = 'trashed'
          ELSE a.source != 'owner' OR p.state = 'active' END
        ${accessFilter}
        AND (a.source != 'domain_opened' OR a.domain = ?)
        AND (? IS NULL OR a.title_search LIKE ? ESCAPE '\\')
        ${keyset}
      ORDER BY ${order}
      LIMIT ?`,
    params: [
      principal,
      inTrash ? 1 : 0,
      domain ?? null,
      pattern,
      pattern,
      ...(continued ? [key, after.page_id] : []),
      count,
    ],
  };
}

/** The trashed order's query. A trash time lives on the Page row, so it walks
 * `pages_catalog_pages_trash` from `owner = ?` and joins the caller's own
 * access row for its title snapshot and times, where the other sorts walk the
 * access row's indexes. The candidates are the ones the other sorts list
 * under `in_trash`, owner rows of trashed Pages: an owner row's principal is
 * its Page row's `owner`. `access` needs no filter, since every row here is
 * an owner row. */
function trashQuery({ principal, inTrash, pattern, after, count }) {
  if (inTrash !== true) throw new TypeError("The trashed order lists only Trash");
  const continued = requirePosition("trashed", after) !== null;
  return {
    sql: `SELECT a.page_id, a.source, a.updated_at, a.updated_revision, a.title, a.title_search,
        a.created_at, a.content_updated_at, a.activity_at, p.trashed_at
      FROM pages_catalog_pages p
      JOIN pages_catalog_access a ON a.page_id = p.page_id AND a.principal = ?
      WHERE p.owner = ? AND p.state = 'trashed' AND p.kind = 'page' AND a.source = 'owner'
        AND (? IS NULL OR a.title_search LIKE ? ESCAPE '\\')
        ${continued ? "AND (p.trash_key, p.page_id) < (?, ?)" : ""}
      ORDER BY p.trash_key DESC, p.page_id DESC
      LIMIT ?`,
    params: [
      principal,
      principal,
      pattern,
      pattern,
      ...(continued ? [after.key, after.page_id] : []),
      count,
    ],
  };
}

/** Up to `count` candidate rows from D1 after `after`, in the listing's
 * order: newest activity, creation or trash first, or by title key. `access` keeps
 * only owner rows ("owned") or only non-owner rows ("shared").
 *
 * A search binds a pattern that may hold only a prefix of the needle
 * (`likePattern`). A row that pattern matched but whose title snapshot lacks
 * the whole needle comes back with `unmatched: true`, in its place in the
 * order: it counts toward the caller's scan bound and moves the scan's
 * position past it, but never lists. Dropping it here instead would return
 * fewer than `count` rows from a walk with more rows to read, which the scan
 * takes as the end of the walk. */
export async function queryCatalogIndex(db, query) {
  const { sql, params } = listingQuery(query);
  const result = await db
    .prepare(sql)
    .bind(...params)
    .all();
  const needle = query.needle;
  return (result.results ?? []).map((row) => ({
    ...(needle && !keyText(row.title_search).includes(needle) && { unmatched: true }),
    page_id: row.page_id,
    title: row.title,
    title_search: row.title_search,
    created_at: row.created_at,
    updated_at: row.updated_at,
    content_updated_at: row.content_updated_at ?? null,
    activity_at: row.activity_at,
    owned: row.source === "owner",
    revision: row.updated_revision,
    ...(row.trashed_at ? { trashed_at: row.trashed_at } : {}),
  }));
}

/** Candidate source over the Catalog entries: for when the index is off or
 * unavailable, and for listings filtered by location, which only the
 * Catalog's entries record. `owned(entry)` keeps an owned entry; `shared`
 * says whether shared entries are candidates. Every entry is read: rows
 * order by keys stored in the entries, not by their storage keys, so a
 * listing that read only some of them could put a later entry before its
 * cursor and end a walk without it. Owned entries are bounded by the
 * account's Page limit; shared entries grow only as Pages are shared with
 * the account and it opens them. Each row is still checked before it shows,
 * within the scan's own bound.
 * Rows order as `listingQuery` orders the same `sort`, with each key computed
 * from the entry as the index computes it: the title key from its title, the
 * activity key from its `content_updated_at`, else `updated_at`, the
 * created key from its `created_at`, and a `trash/` entry's trash key from
 * its `trashed_at`. A time that isn't a listing time falls back as
 * reconciliation's does (`firstTime`). For a shared entry those times are this
 * account's discovery and the Page host's projections, where D1 holds the
 * Page row's own times, so shared rows can order differently between the
 * two sources. Owned rows converge to one order: a content time reaches both
 * from one flush that retries until both writes land, and D1's `created_at`
 * holds the host's first report time until reconciliation imports the
 * Catalog's earlier creation time (README, "Catalog index"). */
export async function catalogSource(
  storage,
  { inTrash, needle, owned = () => true, shared = true, sort = "activity" },
) {
  const order = listOrder(sort);
  const list = async (prefix) => [...(await listAll(storage, prefix)).values()];
  const entries = inTrash
    ? (await list("trash/")).map((entry) => ({ entry, owned: true }))
    : [
        ...(await list("page/"))
          .filter((entry) => !entry.pending && owned(entry))
          .map((entry) => ({ entry, owned: true })),
        ...(shared ? await list("shared/") : []).map((entry) => ({ entry, owned: false })),
      ];
  const rows = entries
    .filter(({ entry }) => validPageId(entry?.page_id))
    .map(({ entry, owned }) => {
      const row = {
        page_id: entry.page_id,
        title: catalogTitle(entry.title),
        title_search: titleKey(entry.title),
        // As reconciliation indexes them: an entry whose created_at is
        // missing or malformed at its updated_at, and the other way round.
        // With neither, both read the key as "".
        created_at: firstTime(entry.created_at, entry.updated_at) ?? undefined,
        updated_at: firstTime(entry.updated_at, entry.created_at) ?? undefined,
        content_updated_at: firstTime(entry.content_updated_at),
        owned,
        ...(entry.trashed_at ? { trashed_at: entry.trashed_at } : {}),
      };
      return { ...row, activity_at: activityKey(row) };
    })
    .filter((row) => titleMatches(row.title, needle))
    .sort(order.compare);
  return memorySource(rows, sort);
}

/** Candidate source over the child IDs a shared parent's owner Catalog
 * returned. The caller's discovery cache doesn't decide which children are
 * candidates: each one is checked with the caller's credentials before its
 * title is shown. IDs carry no time or title, so rows order by Page ID alone:
 * descending for activity and created (every time key is empty), ascending
 * for title (every title key is empty). */
export function childIdSource(pageIds, sort = "activity") {
  const order = listOrder(sort);
  const rows = [...new Set(pageIds)]
    .filter(validPageId)
    .map((pageId) => ({ page_id: pageId, updated_at: "", title_search: "", owned: false }))
    .sort(order.compare);
  return memorySource(rows, sort);
}

/** A candidate source over rows already sorted in `sort`'s order. */
function memorySource(rows, sort) {
  const { follows } = listOrder(sort);
  return {
    next: async (after, count) => {
      requirePosition(sort, after);
      return rows.filter((row) => follows(row, after)).slice(0, count);
    },
  };
}

export class CatalogIndexUnavailable extends Error {}

/** Candidate source over D1. Its errors are marked so the listing can fall
 * back to the Catalog entries instead of failing. */
export function indexSource(db, query) {
  return {
    next: async (after, count) => {
      // Outside the try: a malformed position is a bug, not an outage.
      requirePosition(query.sort ?? "activity", after);
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
 * discovery timestamp. With the host's `title_keep_time`, rows that already
 * hold the title keep their `updated_at`, as they do for the host's own
 * reports of that observation: a restart from a build without the stored
 * observation re-observes an unchanged title now. A changed title, and an
 * ACL commit's or a restore's observation, still move them. */
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
      lifecycle: page.lifecycle_revision ?? 0,
      content_updated_at: page.content_updated_at,
      keep_time: page.title_keep_time === true,
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
      {
        title: page.title,
        updatedAt: observed,
        lifecycle: page.lifecycle_revision ?? 0,
        keepTime: page.title_keep_time === true,
      },
    ),
  ];
}

/** Statements that index one owned Catalog entry (`page/` as "active",
 * `trash/` as "trashed") exactly as a reconcile pass does. Only listing
 * times reach D1 (`firstTime`); the fallback reads the same entry with the
 * same fallbacks (`catalogSource`). An entry with neither time is indexed at
 * '', which the fallback reads too: every writer writes the same value, so
 * it never moves the row. */
function ownedEntryStatements(db, principal, entry, state) {
  const updatedAt = firstTime(entry.updated_at, entry.created_at) ?? "";
  return [
    pageUpsert(db, {
      page_id: entry.page_id,
      owner: principal,
      title: entry.title,
      state,
      created_at: firstTime(entry.created_at) ?? updatedAt,
      updated_at: updatedAt,
      // A trash key the fallback would read as "" is indexed as null,
      // which `trash_key` reads as '': both sort it last.
      trashed_at: state === "trashed" ? firstTime(entry.trashed_at) : null,
      lifecycle: entry.lifecycle_revision ?? 0,
      content_updated_at: entry.content_updated_at,
    }),
    upsertAccess(
      db,
      entry.page_id,
      [{ principal, role: "owner", source: "owner", domain: null }],
      0,
      { title: entry.title, updatedAt, owner: true },
    ),
  ];
}

/**
 * Index owned Catalog entries a Catalog request wrote, after its response,
 * so its Page index marks clear without a listing's help. `items` are
 * `{ entry, state }`: state "active" for a `page/` entry, "trashed" for a
 * `trash/` entry, or "deleted" for a purged Page, whose row becomes a
 * tombstone. The rows are what a reconcile pass would write from the same
 * entries, fenced by lifecycle revision as every index write is.
 *
 * Bounded by the read and write timeouts. Returns true when D1 holds the
 * rows, false when the index is off, and rejects when the write fails. The
 * caller marked the Pages first (`markPagesForIndex`) and settles the marks
 * only on true; a mark left behind is settled by the next listing.
 */
export async function indexOwnedEntries(env, ctx, principal, items) {
  if (!catalogIndexEpoch(env) || typeof principal !== "string") return false;
  const db = await withTimeout(catalogIndexDatabase(env, ctx), catalogIndexTimeouts.read);
  const statements = items.flatMap(({ entry, state }) =>
    state === "deleted"
      ? tombstoneStatements(db, entry.page_id, principal, entry.lifecycle_revision ?? 0)
      : ownedEntryStatements(db, principal, entry, state),
  );
  if (statements.length) await withTimeout(db.batch(statements), catalogIndexTimeouts.write);
  return true;
}

/**
 * Read whether this account's rows are usable, and advance its reconcile pass
 * when they need repair. A pass rewrites owner rows from the Catalog's `page/`
 * and `trash/` entries (title, timestamps, state), re-verifies every shared
 * entry and every non-owner D1 row with its Page host, and drops owner rows
 * the Catalog no longer has.
 *
 * One listing advances the pass in units: at most one D1 read, one group of
 * `concurrency` Page checks, and one D1 write each. The deadline
 * (`catalogIndexTimeouts.reconcile` from entry) is checked before every D1
 * call and every check group; after it passes, nothing new starts. The only
 * exception is the write that commits checks already made, so their results
 * are never thrown away. Worst case: the deadline plus one in-flight D1 call
 * (`read`), or plus one check group (`verify`) and its commit (`write`). The
 * position advances only through committed entries and persists in the
 * Catalog, so a pass, which is O(account size) and advanced only by listings,
 * resumes exactly where it stopped and never holds this Catalog's request
 * queue beyond that bound. While D1 calls exceed the budget, the pass waits.
 *
 * Returns true when the account's rows may choose listing candidates: the
 * account index is `ready` (account-index-machine.mjs) when this call returns.
 * A pass still running, or one that started before the Catalog's latest write,
 * leaves it `unsynced` or `behind`, and the listing reads the Catalog entries.
 */
export async function reconcileAccountIndex({
  db,
  storage,
  principal,
  epoch,
  verify,
  now = Date.now(),
}) {
  const deadline = Date.now() + catalogIndexTimeouts.reconcile;
  const open = () => Date.now() < deadline;
  const marker = await read(
    db
      .prepare("SELECT epoch, synced_at FROM pages_catalog_accounts WHERE principal = ?")
      .bind(principal)
      .first(),
  );
  const current = marker?.epoch === epoch;
  const dirty = await storage.get(DIRTY);
  const state = accountIndexState({ current, dirty });
  let verifications = 0;
  let entries = 0;
  const write = (statements) =>
    statements.length
      ? withTimeout(db.batch(statements), catalogIndexTimeouts.write)
      : Promise.resolve();
  verifications += await settlePageMarks({ db, storage, principal, verify, open, write, now });
  let pass = await storage.get(SYNC);
  if (pass && pass.epoch !== epoch) pass = undefined;
  const due =
    state.name !== "ready" ||
    pass !== undefined ||
    !(Date.parse(marker.synced_at) > now - catalogIndexBounds.reconcileIntervalMs);
  if (!due) return !(await pageMarksPending(storage));
  pass ??= { epoch, phase: "owned", after: null, incomplete: false, dirty: dirty ?? null };
  /** Commit a unit and the position after it, in that order. */
  const commit = async (statements, position) => {
    await write(statements);
    Object.assign(pass, position);
    await storage.put(SYNC, pass);
  };
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
  // One owner write holds at most 24 entries (two statements each).
  const ownerUnit = 24;
  while (
    pass.phase !== "finished" &&
    open() &&
    verifications < catalogIndexBounds.verifications &&
    entries < catalogIndexBounds.entriesPerListing
  ) {
    if (pass.phase === "owned" || pass.phase === "trash") {
      const prefix = pass.phase === "owned" ? "page/" : "trash/";
      const room = Math.min(ownerUnit, catalogIndexBounds.entriesPerListing - entries);
      const listed = [
        ...(
          await storage.list({
            prefix,
            ...(pass.after && { startAfter: pass.after }),
            limit: room,
          })
        ).entries(),
      ];
      const statements = [];
      for (const [, entry] of listed) {
        if (entry?.pending || !validPageId(entry?.page_id)) continue;
        statements.push(
          ...ownedEntryStatements(
            db,
            principal,
            entry,
            pass.phase === "owned" ? "active" : "trashed",
          ),
        );
      }
      // Storage reads are local; the deadline guards the D1 write.
      if (statements.length && !open()) break;
      entries += listed.length;
      await commit(
        statements,
        listed.length < room
          ? { phase: pass.phase === "owned" ? "trash" : "shared", after: null }
          : { after: listed.at(-1)[0] },
      );
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
      const valid = listed.map(([, entry]) => entry).filter((entry) => validPageId(entry?.page_id));
      let statements = [];
      if (valid.length) {
        const revisions = await observedRevisions(valid.map((entry) => entry.page_id));
        if (!open()) break;
        statements = await checkShared(
          valid.map((entry) => ({
            pageId: entry.page_id,
            updatedAt: firstTime(entry.updated_at) ?? new Date(now).toISOString(),
            createdAt: firstTime(entry.created_at) ?? undefined,
            revision: revisions.get(entry.page_id),
            fromCatalog: true,
          })),
        );
      }
      entries += listed.length;
      await commit(
        statements,
        listed.length < room ? { phase: "rows", after: null } : { after: listed.at(-1)[0] },
      );
    } else if (pass.phase === "rows" || pass.phase === "orphans") {
      const owner = pass.phase === "orphans";
      const room = owner
        ? Math.min(ownerUnit * 2, catalogIndexBounds.entriesPerListing - entries)
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
      let statements = [];
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
      if ((statements.length || unchecked.length) && !open()) break;
      if (unchecked.length) statements = await checkShared(unchecked);
      entries += rows.length;
      await commit(
        statements,
        rows.length < room
          ? { phase: owner ? "done" : "orphans", after: null }
          : { after: rows.at(-1).page_id },
      );
    } else if (pass.phase === "done") {
      await storage.delete(SYNC);
      const verified = !pass.incomplete;
      if (verified)
        await read(
          db
            .prepare(
              `INSERT INTO pages_catalog_accounts (principal, epoch, synced_at) VALUES (?, ?, ?)
              ON CONFLICT (principal) DO UPDATE SET epoch = excluded.epoch, synced_at = excluded.synced_at`,
            )
            .bind(principal, epoch, new Date(now).toISOString())
            .run(),
        );
      // Read after the marker lands: a write that arrived while the pass ran,
      // or during the marker write, leaves the account behind.
      const unchanged = (await storage.get(DIRTY)) === (pass.dirty ?? undefined);
      const step = accountIndexMachine.step(state, { type: "completed", verified, unchanged });
      for (const effect of step.effects) if (effect.type === "clear") await storage.delete(DIRTY);
      return step.state.name === "ready" && !(await pageMarksPending(storage));
    }
  }
  // Unfinished. The pass's D1 calls let other requests run, and a write one
  // of them recorded since entry puts a ready account behind.
  if (state.name !== "ready") return false;
  return (await storage.get(DIRTY)) === undefined && !(await pageMarksPending(storage));
}

/**
 * Settle up to `pageMarks` Page index marks from their Pages' current
 * entries (`pageIndexMarkMachine`). An owned entry (`page/` or `trash/`) is
 * written as a pass writes it, and a purged Page's tombstone likewise. A
 * shared entry is settled when D1 already holds this account's active row
 * (its host's report landed); otherwise its host is checked, within the
 * verification budget, and an answer is written as a pass writes it. A Page
 * with no entry has nothing to list. Every write lands before a mark clears.
 * Returns the Page checks it spent.
 */
async function settlePageMarks({ db, storage, principal, verify, open, write, now }) {
  const marks = [
    ...(await storage.list({ prefix: PAGE_MARK, limit: catalogIndexBounds.pageMarks })).entries(),
  ].map(([key, token]) => ({ key, pageId: key.slice(PAGE_MARK.length), token }));
  if (!marks.length) return 0;
  const live = (entry) =>
    entry && !entry.pending && !entry.reservation && validPageId(entry.page_id);
  const statements = [];
  const indexed = [];
  const refused = [];
  const shared = [];
  for (const mark of marks) {
    const { pageId } = mark;
    if (!validPageId(pageId)) {
      indexed.push(mark);
      continue;
    }
    const active = await storage.get(`page/${pageId}`);
    const trashed = live(active) ? undefined : await storage.get(`trash/${pageId}`);
    const entry = live(active) || live(trashed) ? undefined : await storage.get(`shared/${pageId}`);
    if (live(active)) statements.push(...ownedEntryStatements(db, principal, active, "active"));
    else if (live(trashed))
      statements.push(...ownedEntryStatements(db, principal, trashed, "trashed"));
    else if (entry) {
      shared.push({ mark, entry });
      continue;
    } else if (await storage.get(`host/deleted/${pageId}`))
      statements.push(...tombstoneStatements(db, pageId, principal, 0));
    indexed.push(mark);
  }
  let checks = 0;
  if (shared.length && open()) {
    const rows =
      (
        await read(
          db
            .prepare(
              `SELECT a.page_id FROM pages_catalog_access a
              JOIN pages_catalog_pages p ON p.page_id = a.page_id
              WHERE a.principal = ? AND p.state = 'active'
                AND a.page_id IN (SELECT value FROM json_each(?))`,
            )
            .bind(principal, JSON.stringify(shared.map(({ mark }) => mark.pageId)))
            .all(),
        )
      ).results ?? [];
    const found = new Set(rows.map((row) => row.page_id));
    const unchecked = [];
    for (const item of shared) (found.has(item.mark.pageId) ? indexed : unchecked).push(item.mark);
    const entries = new Map(shared.map(({ mark, entry }) => [mark.pageId, entry]));
    for (
      let at = 0;
      at < unchecked.length && open() && checks < catalogIndexBounds.verifications;
      at += catalogIndexBounds.concurrency
    ) {
      const group = unchecked.slice(
        at,
        at + Math.min(catalogIndexBounds.concurrency, catalogIndexBounds.verifications - checks),
      );
      checks += group.length;
      const results = await Promise.all(group.map((mark) => verify(mark.pageId)));
      for (const [index, result] of results.entries()) {
        const mark = group[index];
        const entry = entries.get(mark.pageId);
        if (result.status === "ok" && result.page.state === "active" && result.page.owner) {
          statements.push(
            ...sharedStatements(
              db,
              principal,
              mark.pageId,
              result.page,
              firstTime(entry.updated_at) ?? new Date(now).toISOString(),
              firstTime(entry.created_at) ?? undefined,
            ),
          );
          indexed.push(mark);
        } else if (result.status === "ok" || result.status === "denied") refused.push(mark);
      }
    }
  }
  if (statements.length) {
    if (!open()) return checks;
    await write(statements);
  }
  for (const mark of indexed) await settlePageMark(storage, mark, "indexed");
  for (const mark of refused) await settlePageMark(storage, mark, "refused");
  return checks;
}

const SPACES_SYNCED = "host/index/spaces-synced";
/** Most `space/` entries one account reconcile reads. */
const SPACE_RECONCILE_LIMIT = 200;

/** The owner's Space entries changed; the next Space listing rewrites them. */
export async function markSpaceIndexDirty(storage) {
  await storage.put(SPACES_DIRTY, crypto.randomUUID());
}

function spaceUpsert(db, owner, entry) {
  const title = catalogTitle(entry.title);
  return db
    .prepare(
      `INSERT INTO pages_catalog_spaces
        (space_id, owner, title, title_search, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (space_id) DO UPDATE SET
        title = CASE WHEN excluded.updated_at >= pages_catalog_spaces.updated_at
          THEN excluded.title ELSE pages_catalog_spaces.title END,
        title_search = CASE WHEN excluded.updated_at >= pages_catalog_spaces.updated_at
          THEN excluded.title_search ELSE pages_catalog_spaces.title_search END,
        updated_at = max(pages_catalog_spaces.updated_at, excluded.updated_at)
      WHERE pages_catalog_spaces.owner = excluded.owner`,
    )
    .bind(
      entry.space_id,
      owner,
      title,
      searchText(title),
      entry.created_at,
      entry.updated_at ?? entry.created_at,
    );
}

/**
 * Space rows for one owner, rewritten from the owner's Catalog `space/`
 * entries when a Space changed or the epoch moved. An account holds at most
 * `SPACE_LIMIT` Spaces, so one bounded read and one D1 batch cover it. The
 * Catalog entries stay the authority: a listing confirms every D1 candidate
 * against them, so a stale row can hide a Space for one listing but never
 * show one.
 */
export async function reconcileSpaceIndex({ db, storage, principal, epoch }) {
  const dirty = await storage.get(SPACES_DIRTY);
  if (dirty === undefined && (await storage.get(SPACES_SYNCED)) === epoch) return;
  const entries = [
    ...(await storage.list({ prefix: "space/", limit: SPACE_RECONCILE_LIMIT })).values(),
  ].filter((entry) => validSpaceId(entry?.space_id) && !entry.pending);
  await withTimeout(
    db.batch([
      ...entries.map((entry) => spaceUpsert(db, principal, entry)),
      db
        .prepare(
          `DELETE FROM pages_catalog_spaces
          WHERE owner = ? AND space_id NOT IN (SELECT value FROM json_each(?))`,
        )
        .bind(principal, JSON.stringify(entries.map((entry) => entry.space_id))),
    ]),
    catalogIndexTimeouts.write,
  );
  await storage.put(SPACES_SYNCED, epoch);
  if ((await storage.get(SPACES_DIRTY)) === dirty) await storage.delete(SPACES_DIRTY);
}

/** Space candidates from D1, newest first. Rows reuse the listing cursor's
 * `page_id` slot for the Space ID. */
export function spaceIndexSource(db, { principal }) {
  return {
    next: async (after, count) => {
      try {
        const result = await read(
          db
            .prepare(
              `SELECT space_id, updated_at FROM pages_catalog_spaces
              WHERE owner = ?
                AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND space_id < ?))
              ORDER BY updated_at DESC, space_id DESC
              LIMIT ?`,
            )
            .bind(
              principal,
              after?.updated_at ?? null,
              after?.updated_at ?? null,
              after?.updated_at ?? null,
              after?.page_id ?? null,
              count,
            )
            .all(),
        );
        return (result.results ?? []).map((row) => ({
          page_id: row.space_id,
          updated_at: row.updated_at,
        }));
      } catch (error) {
        throw new CatalogIndexUnavailable("Space index query failed", { cause: error });
      }
    },
  };
}

/** Space candidates from the owner's Catalog entries. */
export async function spaceCatalogSource(storage) {
  const rows = [
    ...(await storage.list({ prefix: "space/", limit: SPACE_RECONCILE_LIMIT })).values(),
  ]
    .filter((entry) => validSpaceId(entry?.space_id) && !entry.pending)
    .map((entry) => ({
      page_id: entry.space_id,
      updated_at: entry.updated_at ?? entry.created_at,
    }))
    .sort(newestFirst);
  return { next: async (after, count) => rows.filter((row) => before(row, after)).slice(0, count) };
}
