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
//   migration or repair may clear or rewrite it. Only a Page's deletion
//   tombstone deletes a Page's rows (`tombstoneStatements` in
//   catalog-index.mjs).
// - Authorization is not stored here. The Page host decides who may edit a
//   Page before `writePageTags` runs, and a listing verifies every candidate
//   before it shows it. A tag row grants nothing.
// - The table shares D1's migration chain and database binding with the
//   catalog index (`CATALOG_MIGRATIONS`, migration 9), so a tag read or write
//   needs the D1 binding that `PAGES_CATALOG_INDEX` turns on. That flag gates
//   access to the database; it does not make tags an index.

import { HttpError } from "./auth.mjs";
import { catalogIndexTimeouts, withTimeout } from "./catalog-index.mjs";
import { MAX_TAGS_PER_PAGE, tagPredicate } from "./page-tags.mjs";

const TIMED_OUT = "Page tags timed out";
const read = (promise) => withTimeout(promise, catalogIndexTimeouts.read, TIMED_OUT);

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
 * The limit is checked against the rows read first and again inside the
 * insert, so two writers racing can't pass it: the loser's adds are skipped
 * and reported as `tag_limit_exceeded`, with its removals applied. A Page
 * whose deletion tombstone is in `pages_catalog_pages` takes no tags. That row
 * is a projection of the Page host's deletion, used here only as a guard so a
 * late write can't resurrect rows the tombstone deleted; it is not tag data.
 */
export async function writePageTags(db, { pageId, principal, add, remove, now }) {
  const list = async () =>
    (
      (
        await read(
          db.prepare("SELECT tag FROM page_tags WHERE page_id = ? ORDER BY tag").bind(pageId).all(),
        )
      ).results ?? []
    ).map((row) => row.tag);
  const before = await list();
  const after = new Set(before.filter((tag) => !remove.includes(tag)));
  for (const tag of add) after.add(tag);
  const full = (count) =>
    new HttpError(
      409,
      `A Page holds at most ${MAX_TAGS_PER_PAGE} tags; this change would leave ${count}. Remove some first.`,
      "tag_limit_exceeded",
    );
  if (after.size > MAX_TAGS_PER_PAGE) throw full(after.size);
  const adds = JSON.stringify(add);
  await withTimeout(
    db.batch([
      db
        .prepare(
          `DELETE FROM page_tags
            WHERE page_id = ? AND tag IN (SELECT value FROM json_each(?))`,
        )
        .bind(pageId, JSON.stringify(remove)),
      db
        .prepare(
          `INSERT OR IGNORE INTO page_tags (page_id, tag, added_by, added_at)
          SELECT ?, j.value, ?, ? FROM json_each(?) j
          WHERE NOT EXISTS (SELECT 1 FROM pages_catalog_pages p
                             WHERE p.page_id = ? AND p.state = 'deleted')
            AND (SELECT count(*) FROM page_tags t WHERE t.page_id = ?)
              + (SELECT count(*) FROM json_each(?) j2
                  WHERE NOT EXISTS (SELECT 1 FROM page_tags t2
                                     WHERE t2.page_id = ? AND t2.tag = j2.value))
              <= ?`,
        )
        .bind(pageId, principal, now, adds, pageId, pageId, adds, pageId, MAX_TAGS_PER_PAGE),
    ]),
    catalogIndexTimeouts.write,
    TIMED_OUT,
  );
  const tags = await list();
  if (add.some((tag) => !tags.includes(tag))) throw full(tags.length);
  return tags;
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
