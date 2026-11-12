// list_pages' `tags` filter: the same answers from D1 and from the Catalog
// entries, cursors sealed to the expression, refusals, and the lifecycle of
// `page_tags`, the normative tag table (not a projection: only a purge clears
// its rows, and the Page host does that itself).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CATALOG_MIGRATIONS,
  coolIndex,
  migrateCatalogIndex,
  reportPageIndex,
  retirePageIndex,
} from "./catalog-index.mjs";
import { at, catalogFixture, id, member, owner } from "./catalog-fixture.mjs";
import { PAGE_TAGS_MIGRATIONS, migratePageTags } from "./page-tags-store.mjs";

/** Pages the member owns (1 to 4) and one shared with them (100), with tags. */
const TAGS = new Map([
  [1, ["code", "status:reviewing"]],
  [2, ["code", "status:blocked", "repo:nteract"]],
  [3, ["repo:kilo"]],
  [4, []],
  [100, ["code", "status:reviewing"]],
]);

/** Expressions and the Pages they match, as numbers. */
const EXPRESSIONS = [
  ["code", [1, 2, 100]],
  ["CODE", [1, 2, 100]],
  ["code AND status:reviewing", [1, 100]],
  ["code AND NOT status:blocked", [1, 100]],
  ["(status:reviewing OR status:blocked) AND code", [1, 2, 100]],
  ["status:reviewing OR repo:kilo", [1, 3, 100]],
  ["NOT code", [3, 4]],
  ["(repo:nteract OR repo:kilo) AND NOT code", [3]],
  ["NOT (code OR repo:kilo)", [4]],
  ["(code OR repo:kilo) AND (status:blocked OR status:reviewing)", [1, 2, 100]],
  ["nope", []],
  ["NOT nope", [1, 2, 3, 4, 100]],
];

async function world(t, { index = "1", migrate = true } = {}) {
  const f = await catalogFixture(t, { index });
  const storage = f.catalog(member).ctx.storage;
  for (const n of [1, 2, 3, 4])
    await storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: `Page ${n}`,
      created_at: at(0),
      updated_at: at(n),
    });
  f.addPage(id(100), "Shared", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  await storage.put(`shared/${id(100)}`, {
    page_id: id(100),
    title: "Shared",
    created_at: at(0),
    updated_at: at(100 - 80),
    shared: true,
  });
  if (migrate) {
    await migrateCatalogIndex(f.db);
    await migratePageTags(f.db);
    for (const [n, tags] of TAGS)
      for (const tag of tags)
        f.db.sqlite
          .prepare("INSERT INTO page_tags VALUES (?, ?, ?, ?)")
          .run(id(n), tag, owner, at(0));
  }
  return f;
}

const numbers = (body) =>
  body.pages.map((page) => Number(page.page_id.slice(0, 8))).sort((a, b) => a - b);

test("a tag expression lists the same Pages from D1 and from the Catalog entries", async (t) => {
  // While the index cools after a failed walk, first pages read the Catalog
  // entries, and the tag filter still reads D1 for the tags.
  const early = await world(t);
  await coolIndex(early.catalog(member).ctx.storage);
  for (const [expression, want] of EXPRESSIONS) {
    const { source, body } = await early.list(member, { tags: expression });
    assert.equal(source, "catalog", expression);
    assert.deepEqual(numbers(body), want, `catalog: ${expression}`);
  }
  const ready = await world(t);
  await ready.untilReady(member);
  for (const [expression, want] of EXPRESSIONS) {
    const { source, body } = await ready.list(member, { tags: expression });
    assert.equal(source, "index", expression);
    assert.deepEqual(numbers(body), want, `index: ${expression}`);
  }
});

test("a filtered listing echoes the canonical expression and carries each Page's tags", async (t) => {
  const f = await world(t);
  await f.untilReady(member);
  const { body } = await f.list(member, { tags: "  Code   AND\tNOT status:blocked " });
  assert.equal(body.tag_filter, "code AND NOT status:blocked");
  const byId = new Map(body.pages.map((page) => [page.page_id, page.tags]));
  assert.deepEqual(byId.get(id(1)), ["code", "status:reviewing"]);
  assert.deepEqual(byId.get(id(100)), ["code", "status:reviewing"]);
  // An unfiltered listing keeps its row shape and says nothing about tags.
  const plain = (await f.list(member)).body;
  assert.equal(Object.hasOwn(plain, "tag_filter"), false);
  assert.ok(plain.pages.every((page) => !Object.hasOwn(page, "tags")));
  // Unless asked.
  const asked = (await f.list(member, { include_tags: true })).body;
  assert.equal(Object.hasOwn(asked, "tag_filter"), false);
  assert.deepEqual(new Map(asked.pages.map((page) => [page.page_id, page.tags])).get(id(4)), []);
});

test("filters combine with the other listing arguments", async (t) => {
  const f = await world(t);
  await f.untilReady(member);
  assert.deepEqual(numbers((await f.list(member, { tags: "code", access: "owned" })).body), [1, 2]);
  assert.deepEqual(numbers((await f.list(member, { tags: "code", access: "shared" })).body), [100]);
  assert.deepEqual(
    numbers((await f.list(member, { tags: "NOT code", query: "page 3" })).body),
    [3],
  );
  const walked = await f.walk(member, { tags: "code", limit: 1 });
  assert.deepEqual(
    walked.seen.map((pageId) => Number(pageId.slice(0, 8))).sort((a, b) => a - b),
    [1, 2, 100],
  );
});

test("a cursor opens only under the expression it was issued for", async (t) => {
  const f = await world(t);
  await f.untilReady(member);
  const first = (await f.list(member, { tags: "code", limit: 1 })).body;
  assert.ok(first.next_cursor);
  const next = await f.list(member, { tags: "code", limit: 1, cursor: first.next_cursor });
  assert.deepEqual(next.body.pages.length, 1);
  // The canonical spelling opens it too.
  assert.equal(
    (await f.listRaw(member, { tags: "  CODE ", limit: 1, cursor: first.next_cursor })).status,
    200,
  );
  for (const args of [{ tags: "NOT code" }, { tags: "code AND status:reviewing" }, {}]) {
    const refused = await f.listRaw(member, { ...args, limit: 1, cursor: first.next_cursor });
    assert.equal(refused.status, 400, JSON.stringify(args));
    assert.equal(refused.body.code, "invalid_cursor", JSON.stringify(args));
  }
  // And a cursor from a listing with no filter doesn't open under one.
  const plain = (await f.list(member, { limit: 1 })).body;
  const refused = await f.listRaw(member, { tags: "code", limit: 1, cursor: plain.next_cursor });
  assert.equal(refused.body.code, "invalid_cursor");
});

test("a malformed expression is refused with its position", async (t) => {
  const f = await world(t);
  for (const [tags, pattern] of [
    ["", /empty/],
    ["a AND b OR c", /can't mix at one level.*at character 8/],
    ["a AND", /ended.*at character 5/],
    ["(a", /Expected \)/],
    ["has space", /Expected AND, OR or the end/],
    ["a AND and", /reserved.*at character 6/],
    [7, /must be a string/],
    ["x".repeat(257), /at most 256/],
  ]) {
    const { status, body } = await f.listRaw(member, { tags });
    assert.equal(status, 400, JSON.stringify(tags));
    assert.equal(body.code, "invalid_list_arguments", JSON.stringify(tags));
    assert.match(body.error, pattern, JSON.stringify(tags));
  }
});

test("a tag filter never falls back to entries that have no tags", async (t) => {
  // The catalog index flag is off, so D1 is not reachable. Tags live only in
  // D1 (the normative page_tags table), so the Catalog entries cannot stand in.
  const off = await world(t, { index: null, migrate: false });
  const refused = await off.listRaw(member, { tags: "code" });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "tags_unavailable");
  assert.equal(refused.body.retryable, true);
  // The same listing without a filter still works from the entries.
  assert.equal((await off.listRaw(member)).status, 200);
  // D1 is failing.
  const down = await world(t);
  down.db.mode = "fail";
  const failed = await down.listRaw(member, { tags: "code" });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "tags_unavailable");
});

const tagTables = (f) =>
  f.db
    .rows("SELECT name FROM sqlite_master WHERE name LIKE 'page_tags%' ORDER BY name")
    .map((row) => row.name);
const versions = (f, table) =>
  f.db.rows(`SELECT version, name FROM ${table} ORDER BY version`).map((row) => ({ ...row }));
const snapshot = (f) =>
  Object.fromEntries(
    ["pages_catalog_pages", "pages_catalog_access", "pages_catalog_accounts"].map((table) => [
      table,
      f.db.rows(`SELECT * FROM ${table} ORDER BY 1, 2`).map((row) => ({ ...row })),
    ]),
  );

test("the tag table has its own schema-version table, and the catalog chain no longer carries it", async (t) => {
  assert.equal(CATALOG_MIGRATIONS.at(-1).version, 8);
  assert.deepEqual(
    PAGE_TAGS_MIGRATIONS.map((migration) => migration.version),
    [1],
  );
  const f = await catalogFixture(t);
  assert.equal(await migrateCatalogIndex(f.db), 8);
  assert.deepEqual(tagTables(f), [], "the catalog migrations create no tag table");
  assert.equal(await migratePageTags(f.db), 1);
  assert.deepEqual(tagTables(f), ["page_tags", "page_tags_by_tag", "page_tags_schema"]);
  assert.deepEqual(versions(f, "page_tags_schema"), [{ version: 1, name: "page_tags" }]);
  assert.equal(
    Math.max(...versions(f, "pages_catalog_schema").map((row) => row.version)),
    8,
    "the catalog's version table is untouched",
  );
  assert.equal(await migratePageTags(f.db), 1, "a second run applies nothing");
});

test("the tag migration adds its table without touching rows already in the database", async (t) => {
  // A database a build before tags left behind: catalog rows for owned,
  // shared and trashed Pages, and an account marker.
  const f = await catalogFixture(t);
  await migrateCatalogIndex(f.db);
  const env = { DB: f.db, PAGES_CATALOG_INDEX: "1" };
  for (const n of [1, 2, 3]) {
    const metadata = {
      pageId: id(n),
      owner,
      deleted: false,
      acl: { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } },
    };
    await reportPageIndex(env, {}, { metadata, title: `Older ${n}`, observedAt: at(n) });
  }
  await retirePageIndex(
    env,
    {},
    {
      pageId: id(3),
      owner,
      deleted: true,
      lifecycleRevision: 1,
      acl: { revision: 1, members: {} },
      trash: { trashed_at: at(4) },
    },
    at(4),
  );
  const older = snapshot(f);
  assert.ok(older.pages_catalog_pages.length >= 3, "older Page rows are seeded");
  assert.ok(older.pages_catalog_access.length >= 3, "older access rows are seeded");
  assert.deepEqual(tagTables(f), []);
  assert.equal(await migratePageTags(f.db), 1);
  assert.deepEqual(snapshot(f), older, "no existing row changed");
  // Rerunning either chain, or a build that knows an earlier catalog list,
  // leaves both the older rows and the tag rows alone.
  f.db.sqlite.prepare("INSERT INTO page_tags VALUES (?, 'keep', ?, ?)").run(id(1), owner, at(0));
  assert.equal(await migrateCatalogIndex(f.db, CATALOG_MIGRATIONS.slice(0, 5)), 8);
  assert.equal(await migratePageTags(f.db), 1);
  assert.deepEqual(snapshot(f), older);
  assert.deepEqual(
    f.db.rows("SELECT page_id, tag, added_by FROM page_tags").map((row) => ({ ...row })),
    [{ page_id: id(1), tag: "keep", added_by: owner }],
  );
});

test("a database that took the table from the earlier catalog migration 9 keeps its tag rows", async (t) => {
  // An earlier build of this branch created `page_tags` as catalog migration 9.
  const f = await catalogFixture(t);
  await migrateCatalogIndex(f.db);
  f.db.sqlite.exec(`CREATE TABLE page_tags (
      page_id TEXT NOT NULL, tag TEXT NOT NULL, added_by TEXT NOT NULL, added_at TEXT NOT NULL,
      PRIMARY KEY (page_id, tag)
    ) WITHOUT ROWID;
    CREATE INDEX page_tags_by_tag ON page_tags (tag, page_id);
    INSERT INTO pages_catalog_schema (version, name, applied_at) VALUES (9, 'page_tags', 'x')`);
  f.db.sqlite.prepare("INSERT INTO page_tags VALUES (?, 'old', ?, ?)").run(id(1), owner, at(0));
  // The catalog chain ends at 8 now and the recorded 9 does not stop it.
  assert.equal(await migrateCatalogIndex(f.db), 9);
  assert.equal(await migratePageTags(f.db), 1);
  assert.deepEqual(
    f.db.rows("SELECT page_id, tag FROM page_tags").map((row) => ({ ...row })),
    [{ page_id: id(1), tag: "old" }],
  );
  assert.deepEqual(tagTables(f), ["page_tags", "page_tags_by_tag", "page_tags_schema"]);
});

test("the catalog tombstone leaves tags alone: they are not part of the projection", async (t) => {
  const f = await catalogFixture(t);
  await migrateCatalogIndex(f.db);
  await migratePageTags(f.db);
  const env = { DB: f.db, PAGES_CATALOG_INDEX: "1" };
  const metadata = { pageId: id(1), owner, deleted: false, acl: { revision: 0, members: {} } };
  await reportPageIndex(env, {}, { metadata, title: "Tagged", observedAt: at(1) });
  for (const pageId of [id(1), id(2)])
    f.db.sqlite.prepare("INSERT INTO page_tags VALUES (?, 'keep', ?, ?)").run(pageId, owner, at(0));
  const tagged = () =>
    f.db.rows("SELECT page_id FROM page_tags ORDER BY page_id").map((row) => row.page_id);
  assert.deepEqual(tagged(), [id(1), id(2)]);
  // Trash keeps tags: a restored Page has them back.
  await retirePageIndex(
    env,
    {},
    { ...metadata, deleted: true, lifecycleRevision: 1, trash: { trashed_at: at(2) } },
    at(2),
  );
  assert.deepEqual(tagged(), [id(1), id(2)]);
  // The deletion tombstone marks the Page deleted and deletes no tag row; the
  // Page host's purge does (page-tags-write.test.mjs).
  await retirePageIndex(env, {}, { ...metadata, deleted: true, lifecycleRevision: 2 }, at(3));
  assert.equal(
    f.db.rows("SELECT state FROM pages_catalog_pages WHERE page_id = ?", id(1))[0].state,
    "deleted",
  );
  assert.deepEqual(tagged(), [id(1), id(2)]);
});

// ---------------------------------------------------------------------------
// A shared parent's children: the owner's Catalog names them, readable or not.

const PARENT = 200;
const READABLE = [201, 202, 204];
const HIDDEN = 203;

/** Member lists the children of a Page shared with them. Children 201, 202 and
 * 204 are shared with the member; 203 is not. `tagged` are the child numbers
 * that carry the tag `x`. `asked` collects the Page IDs the tag filter reads. */
async function sharedParent(t, tagged) {
  const f = await catalogFixture(t);
  await migrateCatalogIndex(f.db);
  await migratePageTags(f.db);
  const share = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  f.addPage(id(PARENT), "Parent", share);
  for (const n of READABLE) f.addPage(id(n), `Child ${n}`, share);
  f.addPage(id(HIDDEN), "Hidden child");
  for (const n of tagged)
    f.db.sqlite.prepare("INSERT INTO page_tags VALUES (?, 'x', ?, ?)").run(id(n), owner, at(0));
  const children = [...READABLE, HIDDEN].map(id);
  const real = f.env.CATALOGS.getByName;
  f.env.CATALOGS.getByName = (principal) =>
    principal === owner
      ? {
          fetch: async (request) => {
            const body = await request.clone().json();
            return body.children_of ? Response.json({ children }) : real(principal).fetch(request);
          },
        }
      : real(principal);
  const asked = [];
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.includes("FROM json_each(?) j WHERE")) return statement;
    return {
      ...statement,
      bind: (...values) => {
        asked.push(...JSON.parse(values[0]));
        return statement.bind(...values);
      },
    };
  };
  return { f, asked };
}

test("a tag filter on a shared parent's children never reads a child the caller can't open", async (t) => {
  // The same listing whether or not the child the caller can't read matches:
  // its tags decide nothing the caller can see.
  const results = [];
  for (const tagged of [[201, HIDDEN], [201], [201, 204, HIDDEN], [HIDDEN]]) {
    const { f, asked } = await sharedParent(t, tagged);
    const first = (await f.list(member, { parent_id: id(PARENT), tags: "x", limit: 1 })).body;
    const everything = (await f.list(member, { parent_id: id(PARENT), tags: "x" })).body;
    assert.ok(!asked.includes(id(HIDDEN)), `asked: ${JSON.stringify(tagged)}`);
    const expected = READABLE.filter((n) => tagged.includes(n));
    assert.deepEqual(numbers(everything), expected, JSON.stringify(tagged));
    assert.equal(everything.tag_filter, "x");
    assert.equal(everything.next_cursor, null);
    // A page of one has a next cursor exactly when another readable match follows.
    assert.equal(first.pages.length, Math.min(1, expected.length));
    assert.equal(first.next_cursor !== null, expected.length > 1, JSON.stringify(tagged));
    results.push(expected.length);
  }
  assert.deepEqual(results, [1, 1, 2, 0]);
});

test("a tag filter on a shared parent's children matches NOT and OR over the readable children", async (t) => {
  const { f } = await sharedParent(t, [201, HIDDEN]);
  const list = async (tags) =>
    numbers((await f.list(member, { parent_id: id(PARENT), tags })).body);
  assert.deepEqual(await list("x"), [201]);
  assert.deepEqual(await list("NOT x"), [202, 204]);
  assert.deepEqual(await list("x OR NOT x"), [201, 202, 204]);
  // Walked one at a time, the filter finds each readable match once.
  const walked = await f.walk(member, { parent_id: id(PARENT), tags: "NOT x", limit: 1 });
  assert.deepEqual(
    walked.seen.map((pageId) => Number(pageId.slice(0, 8))).sort((a, b) => a - b),
    [202, 204],
  );
});

test("a tag filter with no tag database refuses the listing of a shared parent's children", async (t) => {
  const { f } = await sharedParent(t, [201]);
  f.db.mode = "fail";
  const refused = await f.listRaw(member, { parent_id: id(PARENT), tags: "x" });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "tags_unavailable");
});

// ---------------------------------------------------------------------------
// A filtered listing always carries tags.

test("a filtered listing that can't read its Pages' tags is tags_unavailable, never Pages without tags", async (t) => {
  const f = await world(t);
  await f.untilReady(member);
  // The filter reads D1; then only the per-Page tag read fails.
  const prepare = f.db.prepare.bind(f.db);
  f.db.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.includes("SELECT page_id, tag FROM page_tags")) return statement;
    return {
      ...statement,
      bind: (...values) => ({
        ...statement.bind(...values),
        all: async () => {
          throw new Error("injected tag read failure");
        },
      }),
    };
  };
  const refused = await f.listRaw(member, { tags: "code" });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "tags_unavailable");
  assert.equal(refused.body.retryable, true);
  assert.equal(Object.hasOwn(refused.body, "pages"), false);
  // Without a filter the tags are an extra: the listing stands without them.
  const asked = await f.listRaw(member, { include_tags: true });
  assert.equal(asked.status, 200);
  assert.ok(asked.body.pages.length > 0);
  assert.ok(asked.body.pages.every((page) => !Object.hasOwn(page, "tags")));
  const plain = await f.listRaw(member);
  assert.equal(plain.status, 200);
});

test("every Page a filter returns has its tags, including a Page with none", async (t) => {
  const f = await world(t);
  await f.untilReady(member);
  const { body } = await f.list(member, { tags: "NOT code" });
  assert.deepEqual(numbers(body), [3, 4]);
  assert.ok(body.pages.every((page) => Array.isArray(page.tags)));
  assert.deepEqual(new Map(body.pages.map((page) => [page.page_id, page.tags])).get(id(4)), []);
});

// ---------------------------------------------------------------------------
// The longest expression, and the expression a listing echoes.

/** Groups the tokenizer reads without spaces around AND, so the canonical
 * spelling is longer than what was sent. */
const compact = (groups, tag = 11) =>
  Array.from(
    { length: groups },
    (_, i) => `(${String(i).padStart(tag, "t")} OR ${String(i + 100).padStart(tag, "u")})`,
  ).join("AND");

test("tag_filter round-trips: an expression the listing accepts, its echo accepts too", async (t) => {
  const f = await world(t);
  await f.untilReady(member);
  const base = (await f.list(member, { tags: "code AND NOT status:blocked" })).body;
  const again = (await f.list(member, { tags: base.tag_filter })).body;
  assert.equal(again.tag_filter, base.tag_filter);
  assert.deepEqual(numbers(again), numbers(base));
  // The largest expression whose canonical spelling still fits the bound.
  const input = compact(7);
  assert.ok(input.length < 256);
  const fits = (await f.list(member, { tags: input })).body;
  assert.ok(fits.tag_filter.length <= 256, String(fits.tag_filter.length));
  assert.equal((await f.list(member, { tags: fits.tag_filter })).body.tag_filter, fits.tag_filter);
  // Sent without spaces, 8 groups fit the bound as written but not canonically:
  // the echo would be refused, so the request is.
  const crowded = compact(8);
  assert.ok(crowded.length <= 256 && crowded.length > 240, String(crowded.length));
  const refused = await f.listRaw(member, { tags: crowded });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.code, "invalid_list_arguments");
  assert.match(refused.body.error, /at most 256 characters once written canonically/);
});
