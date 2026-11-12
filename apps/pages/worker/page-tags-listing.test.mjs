// list_pages' `tags` filter: the same answers from D1 and from the Catalog
// entries, cursors sealed to the expression, refusals, and the lifecycle of
// `page_tags`, the normative tag table (not a projection: only a deletion
// tombstone clears its rows).
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

test("migration 9 adds the tag table without touching older rows", async (t) => {
  assert.equal(CATALOG_MIGRATIONS.at(-1).version, 9);
  const f = await catalogFixture(t);
  await migrateCatalogIndex(f.db, CATALOG_MIGRATIONS.slice(0, 8));
  assert.deepEqual(
    f.db.rows("SELECT name FROM sqlite_master WHERE name LIKE 'page_tags%' ORDER BY name"),
    [],
  );
  assert.equal(await migrateCatalogIndex(f.db), 9);
  assert.deepEqual(
    f.db
      .rows("SELECT name FROM sqlite_master WHERE name LIKE 'page_tags%' ORDER BY name")
      .map((row) => row.name),
    ["page_tags", "page_tags_by_tag"],
  );
  // A build that knows only migrations 1 to 8 runs against the newer schema.
  assert.equal(await migrateCatalogIndex(f.db, CATALOG_MIGRATIONS.slice(0, 8)), 9);
});

test("a Page's tags go with its deletion tombstone and nothing else clears them", async (t) => {
  const f = await catalogFixture(t);
  await migrateCatalogIndex(f.db);
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
  // Deleting removes this Page's tags and no other Page's.
  await retirePageIndex(env, {}, { ...metadata, deleted: true, lifecycleRevision: 2 }, at(3));
  assert.deepEqual(tagged(), [id(2)]);
});
