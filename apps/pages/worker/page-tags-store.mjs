// The Page tag store: D1 table `page_tags`, the single normative record of
// every Page's tags.
//
// Provenance (DEPLOYMENT.md "Where state lives"):
//
// - Tags are NOT a projection and NOT an index. No Durable Object, Page host
//   record, Catalog entry or Automerge document holds a copy, so nothing can
//   regenerate these rows. The D1 rows are the truth. There is no Durable
//   Object tag store and none is planned: tags have no real-time component and
//   need only ordinary request/response access.
// - That differs from the `pages_catalog_*` tables, which project each
//   account's Catalog Durable Object and Page host records into D1 and can be
//   cleared and rebuilt. Never treat `page_tags` like them: no reconcile pass,
//   migration or repair may clear or rewrite it. Only a Page's permanent
//   deletion deletes its rows: the Page host does it itself, after the
//   catalog tombstone (`deletePageTags`), whether or not the catalog index is
//   on. The tombstone is a projection and never touches this table.
// - Authorization is not stored here. The Page host decides who may edit a
//   Page before `writePageTags` runs, and a listing verifies every candidate
//   before it shows it. A tag row grants nothing.
// - The table has its own schema-version table, `page_tags_schema`, and its
//   own migration list (`PAGE_TAGS_MIGRATIONS`), apart from the catalog's
//   `pages_catalog_schema` chain: the catalog chain is a projection's, and may
//   reset tables that this one never may. The two share D1's database binding,
//   so a tag read or write needs the binding that `PAGES_CATALOG_INDEX` turns
//   on, and the catalog schema is current first because a tag write checks the
//   `pages_catalog_pages` fence. That flag gates access to the database; it
//   does not make tags an index.

import { HttpError } from "./auth.mjs";
import {
  catalogIndexDatabase,
  catalogIndexEpoch,
  catalogIndexTimeouts,
  withTimeout,
} from "./catalog-index.mjs";
import { migrateSchema } from "./d1-schema.mjs";
import { isolateSetup } from "./isolate-setup.mjs";
import { MAX_TAGS_PER_PAGE, tagPredicate } from "./page-tags.mjs";

const TIMED_OUT = "Page tags timed out";
const read = (promise) => withTimeout(promise, catalogIndexTimeouts.read, TIMED_OUT);

/** The tag table's migrations, numbered from 1 in `page_tags_schema`. NORMATIVE,
 * not a projection: no migration may drop, clear or rewrite `page_tags` rows,
 * so each one only adds. `CREATE ... IF NOT EXISTS` adopts a table a pre-release
 * build created as catalog migration 9 and leaves its rows.
 * `added_by` is the principal that added the tag. It is a claim about who
 * added it, not proof of anything about the tag's meaning. The second index
 * answers "Pages with this tag". */
export const PAGE_TAGS_MIGRATIONS = Object.freeze([
  Object.freeze({
    version: 1,
    name: "page_tags",
    statements: Object.freeze([
      `CREATE TABLE IF NOT EXISTS page_tags (
        page_id TEXT NOT NULL,
        tag TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (page_id, tag)
      ) WITHOUT ROWID`,
      `CREATE INDEX IF NOT EXISTS page_tags_by_tag
        ON page_tags (tag, page_id)`,
    ]),
  }),
]);

/** Apply the tag table's pending migrations; returns its schema version. */
export function migratePageTags(
  db,
  migrations = PAGE_TAGS_MIGRATIONS,
  now = () => new Date().toISOString(),
) {
  return migrateSchema(db, { table: "page_tags_schema", migrations, now });
}

const tagSchemaReady = isolateSetup((db) => migratePageTags(db));

/** The D1 binding with the catalog schema (the Trash fence's table) and the
 * tag schema both current. Throws when D1 doesn't answer. */
export async function pageTagsDatabase(env, ctx) {
  const db = await withTimeout(
    catalogIndexDatabase(env, ctx),
    catalogIndexTimeouts.read,
    TIMED_OUT,
  );
  await tagSchemaReady(db);
  return db;
}

/** Page IDs per D1 statement when a filter or a read names candidates. */
const TAG_CHUNK = 400;

/** The Set of `pageIds` whose tags satisfy `ast`, read from `page_tags`. The
 * IDs come from the caller's own candidate list, never from the tags table, so
 * a Page with no tags (and so no row here) still matches `NOT x`. This decides
 * nothing about access: every candidate is still verified before it lists. */
export async function tagMatchingIds(db, ast, pageIds) {
  const matched = new Set();
  const { sql, params } = tagPredicate(ast, "j.value");
  for (let start = 0; start < pageIds.length; start += TAG_CHUNK) {
    const chunk = pageIds.slice(start, start + TAG_CHUNK);
    const result = await read(
      db
        .prepare(`SELECT j.value AS page_id FROM json_each(?) j WHERE ${sql}`)
        .bind(JSON.stringify(chunk), ...params)
        .all(),
    );
    for (const row of result.results ?? []) matched.add(row.page_id);
  }
  return matched;
}

/**
 * Add and remove tags on one Page, and return the Page's tags afterwards. This
 * writes the normative record: there is no other copy to update or repair
 * from. The caller has already checked edit access on the Page host.
 * `add` and `remove` are normalized, distinct and disjoint (page-tags.mjs).
 * Adding a tag the Page has, or removing one it lacks, changes nothing.
 *
 * One batch, one transaction, decides and applies the change. Its first
 * statement reads the Page's lifecycle mark and counts, as the writes see
 * them: the remove tags the Page has, the add tags it lacks, and the tags it
 * keeps. The delete and the insert both run only while the Page is open and
 * the change fits the limit, so a change applies whole or not at all. The
 * outcome comes from that read and the writes' `meta.changes`, never from a
 * later read: two writers racing can't pass the limit, and one can't report
 * the limit or Trash for a change the other made after its batch.
 *
 * This runs after the Page host's queue has released the request, so a Page
 * can be trashed or deleted between the host's check and this write, and a
 * batch that timed out here keeps running in D1 and can land later still. A
 * Page whose tombstone or Trash mark is in `pages_catalog_pages` takes no tag
 * changes: the writes check it as they run, so a late batch lands nothing on
 * a Page that took its Trash mark first, and the write answers `page_trashed`
 * (or `page_not_found` for a deleted mark) even when it would change nothing. That row is a projection of the Page
 * host's lifecycle, used here only as a fence; it is not tag data. The host
 * marks it after its own record is durable, so a write that races a Trash or
 * purge itself can land first. Trash keeps tags (a restored Page has them
 * back) and a purge deletes them (`deletePageTags`).
 */
export async function writePageTags(db, { pageId, principal, add, remove, now }) {
  const removes = JSON.stringify(remove);
  const adds = JSON.stringify(add);
  // The tags the Page keeps plus the add tags it lacks: the size after the
  // change. A delete leaves both counts as they were, so the insert after it
  // sees the same total.
  const total = `(SELECT count(*) FROM page_tags k
                   WHERE k.page_id = ? AND k.tag NOT IN (SELECT value FROM json_each(?)))
               + (SELECT count(*) FROM json_each(?) n
                   WHERE NOT EXISTS (SELECT 1 FROM page_tags t
                                      WHERE t.page_id = ? AND t.tag = n.value))`;
  const totalParams = [pageId, removes, adds, pageId];
  const applies = `NOT EXISTS (SELECT 1 FROM pages_catalog_pages p
                                WHERE p.page_id = ? AND p.state IN ('deleted', 'trashed'))
                   AND ${total} <= ?`;
  const appliesParams = [pageId, ...totalParams, MAX_TAGS_PER_PAGE];
  const [decided, deleted, inserted, listed] = await withTimeout(
    db.batch([
      db
        .prepare(
          `SELECT (SELECT state FROM pages_catalog_pages WHERE page_id = ?) AS state,
                  (SELECT count(*) FROM page_tags
                    WHERE page_id = ? AND tag IN (SELECT value FROM json_each(?))) AS removing,
                  (SELECT count(*) FROM json_each(?) n
                    WHERE NOT EXISTS (SELECT 1 FROM page_tags t
                                       WHERE t.page_id = ? AND t.tag = n.value)) AS adding,
                  ${total} AS total`,
        )
        .bind(pageId, pageId, removes, adds, pageId, ...totalParams),
      db
        .prepare(
          `DELETE FROM page_tags
            WHERE page_id = ? AND tag IN (SELECT value FROM json_each(?)) AND ${applies}`,
        )
        .bind(pageId, removes, ...appliesParams),
      db
        .prepare(
          `INSERT OR IGNORE INTO page_tags (page_id, tag, added_by, added_at)
          SELECT ?, j.value, ?, ? FROM json_each(?) j WHERE ${applies}`,
        )
        .bind(pageId, principal, now, adds, ...appliesParams),
      db.prepare("SELECT tag FROM page_tags WHERE page_id = ? ORDER BY tag").bind(pageId),
    ]),
    catalogIndexTimeouts.write,
    TIMED_OUT,
  );
  const { state, removing, adding, total: size } = decided.results[0];
  // A marked Page answers its lifecycle refusal, even for a change that
  // would have changed nothing.
  if (state === "deleted") throw new HttpError(404, "Page not found", "page_not_found");
  if (state === "trashed")
    throw new HttpError(409, "Restore this Page before changing its tags", "page_trashed");
  if (deleted.meta.changes === removing && inserted.meta.changes === adding)
    return listed.results.map((row) => row.tag);
  if (size > MAX_TAGS_PER_PAGE)
    throw new HttpError(
      409,
      `A Page holds at most ${MAX_TAGS_PER_PAGE} tags; this change would leave ${size}. Remove some first.`,
      "tag_limit_exceeded",
    );
  throw new Error("A tag write changed rows its own read did not predict");
}

/**
 * Delete every tag row of a Page that is permanently deleted. The Page host
 * calls this itself, after the catalog tombstone is written, for a purge or a
 * recorded deletion: the rows are the normative record, so the deletion does
 * not ride a projection that a missing or disabled catalog index would skip.
 * With the index off, the table may not exist (its migration never ran), and
 * then there is nothing to delete. A database failure throws, so the Page's
 * lifecycle repeats this step on its next request. Idempotent.
 */
export async function deletePageTags(env, ctx, pageId) {
  if (!env.DB?.prepare) return;
  const db = catalogIndexEpoch(env) ? await pageTagsDatabase(env, ctx) : env.DB;
  try {
    await withTimeout(
      db.prepare("DELETE FROM page_tags WHERE page_id = ?").bind(pageId).run(),
      catalogIndexTimeouts.write,
      TIMED_OUT,
    );
  } catch (error) {
    if (!/no such table/i.test(String(error?.message))) throw error;
  }
}

/** The tags of each of `pageIds`, read from `page_tags`, as a Map from Page ID to a sorted array. A
 * Page with none has no entry. */
export async function readPageTags(db, pageIds) {
  const tags = new Map();
  for (let start = 0; start < pageIds.length; start += TAG_CHUNK) {
    const chunk = pageIds.slice(start, start + TAG_CHUNK);
    const result = await read(
      db
        .prepare(
          `SELECT page_id, tag FROM page_tags
            WHERE page_id IN (SELECT value FROM json_each(?)) ORDER BY page_id, tag`,
        )
        .bind(JSON.stringify(chunk))
        .all(),
    );
    for (const row of result.results ?? []) {
      const list = tags.get(row.page_id);
      if (list) list.push(row.tag);
      else tags.set(row.page_id, [row.tag]);
    }
  }
  return tags;
}
