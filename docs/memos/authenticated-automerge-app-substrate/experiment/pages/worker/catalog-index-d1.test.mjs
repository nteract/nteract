// Two D1 constraints celld's SQLite doesn't have: a 50-byte LIKE pattern
// limit, and Durable Objects that share module state but not I/O contexts.
// The test database enforces D1's pattern limit (test/sqlite-d1.mjs), so a
// search that binds a longer pattern fails here as it would on D1.
import assert from "node:assert/strict";
import { test } from "node:test";
import { D1_LIKE_PATTERN_MAX_BYTES, SqliteD1 } from "../test/sqlite-d1.mjs";
import {
  CATALOG_MIGRATIONS,
  LIKE_PATTERN_MAX_BYTES,
  catalogIndexDatabase,
  catalogIndexTimeouts,
  escapeLike,
  likePattern,
  migrateCatalogIndex,
  parseListArguments,
  queryCatalogIndex,
  reportPageIndex,
  withTimeout,
} from "./catalog-index.mjs";
import { at, catalogFixture, id, member, owner, viewerAcl } from "./catalog-fixture.mjs";

const bytes = (text) => new TextEncoder().encode(text).length;
/** The needle prefix a pattern holds, with its escapes undone. */
const unescaped = (pattern) => pattern.slice(1, -1).replace(/\\(.)/gsu, "$1");
const a = (n) => "a".repeat(n);

test("D1's pattern limit is the one the Worker fits", () => {
  assert.equal(LIKE_PATTERN_MAX_BYTES, D1_LIKE_PATTERN_MAX_BYTES);
});

test("a search pattern fits 50 bytes, cut between code points and never inside an escape", () => {
  // [needle, expected pattern bytes, expected prefix]
  const cases = [
    // 49, 50 and 51 bytes of ASCII: the last one loses one character.
    [a(47), 49, a(47)],
    [a(48), 50, a(48)],
    [a(49), 50, a(48)],
    // Two-byte é fills the pattern exactly, or doesn't fit and drops whole.
    [a(46) + "é", 50, a(46) + "é"],
    [a(47) + "é", 49, a(47)],
    [a(45) + "€", 50, a(45) + "€"],
    [a(46) + "€", 48, a(46)],
    // A four-byte emoji is one code point, two UTF-16 units: never halved.
    [a(44) + "😀", 50, a(44) + "😀"],
    [a(45) + "😀b", 47, a(45)],
    // An escape costs two bytes and stays with its character.
    [a(46) + "%", 50, a(46) + "%"],
    [a(47) + "%", 49, a(47)],
    [a(46) + "_", 50, a(46) + "_"],
    [a(47) + "_x", 49, a(47)],
    [a(46) + "\\", 50, a(46) + "\\"],
    [a(47) + "\\", 49, a(47)],
    ["%".repeat(30), 50, "%".repeat(24)],
    ["\\".repeat(25) + "a", 50, "\\".repeat(24)],
  ];
  for (const [needle, size, prefix] of cases) {
    const pattern = likePattern(needle);
    const label = JSON.stringify({ needle, pattern });
    assert.equal(bytes(pattern), size, label);
    assert.equal(unescaped(pattern), prefix, label);
    assert.ok(!/(^|[^\\])(\\\\)*\\%$/.test(pattern), `no dangling escape: ${label}`);
  }
  // Any needle up to the 200-character query bound: within the limit, a
  // prefix of the needle on a code point boundary, and as long as fits.
  const alphabet = ["a", "Z", "%", "_", "\\", "é", "€", "😀", " ", "ß"];
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 500; round++) {
    let needle = "";
    while (needle.length < 200 * random()) needle += alphabet[Math.floor(random() * 10)];
    if (!needle) continue;
    const pattern = likePattern(needle);
    const prefix = unescaped(pattern);
    assert.ok(bytes(pattern) <= 50, pattern);
    assert.ok(needle.startsWith(prefix), pattern);
    assert.ok(!/[\uD800-\uDBFF]$/.test(prefix), pattern);
    const next = needle.slice(prefix.length)[0];
    if (next) assert.ok(bytes(`%${escapeLike(prefix + next)}%`) > 50, pattern);
  }
});

test("the test database refuses a LIKE pattern over 50 bytes, as D1 does", (t) => {
  const db = new SqliteD1(":memory:");
  t.after(() => db.sqlite.close());
  const like = (pattern, text = "x") =>
    db.rows("SELECT ? LIKE ? ESCAPE '\\' AS m", text, pattern)[0].m;
  assert.equal(like(`%${a(48)}%`, a(48)), 1);
  assert.throws(() => like(`%${a(49)}%`), /LIKE or GLOB pattern too complex/);
  assert.throws(() => like(`%${a(47)}é%`), /too complex/, "bytes, not characters");
  // The guard keeps SQLite's LIKE: ASCII-only case folding, _ as one
  // character, % as any run, and escapes.
  assert.equal(like("%B%", "abc"), 1);
  assert.equal(like("%É%", "é"), 0);
  assert.equal(like("_", "é"), 1);
  assert.equal(like("a%c", "a\nb\nc"), 1);
  assert.equal(like("%\\%%", "100%"), 1);
  assert.equal(like("%\\%%", "100"), 0);
  assert.equal(like("a\\_c", "abc"), 0);
  assert.equal(db.rows("SELECT 'Zebra' LIKE 'z%' AS m")[0].m, 1);
  assert.equal(db.rows("SELECT NULL LIKE 'z%' AS m")[0].m, null);
});

/** A 200-character search: wildcard and escape characters inside the first
 * 50 bytes, multi-byte characters across the cut. */
const NEEDLE = (() => {
  // ASCII, escapes and a 3-byte dash, then 2- and 4-byte characters.
  let text = "q3 100% of a_b \\ plan — ";
  while (text.length + "ünïcode 😀 ".length <= 196) text += "ünïcode 😀 ";
  return text.padEnd(196, "x") + "tail";
})();
/** Titles that share the needle's first 100 code points, then differ. */
const decoy = (n) => `${[...NEEDLE].slice(0, 100).join("")} decoy ${n}`;

test("a long search reads candidates by the cut pattern and keeps only titles with the whole needle", async (t) => {
  assert.equal(NEEDLE.length, 200);
  assert.equal(parseListArguments({ query: NEEDLE }).needle, NEEDLE);
  const db = new SqliteD1(":memory:");
  t.after(() => db.sqlite.close());
  await migrateCatalogIndex(db);
  const env = { DB: db, PAGES_CATALOG_INDEX: "1" };
  const page = (n, title) =>
    reportPageIndex(
      env,
      {},
      {
        metadata: { pageId: id(n), owner, deleted: false, acl: { revision: 0, members: {} } },
        title,
        observedAt: at(n),
      },
    );
  await page(1, `Copy of ${NEEDLE.toUpperCase()}`);
  await page(2, decoy(2));
  await page(3, "unrelated");
  await page(4, `${NEEDLE} v2`);
  const rows = await queryCatalogIndex(db, {
    principal: owner,
    inTrash: false,
    needle: parseListArguments({ query: NEEDLE }).needle,
    after: null,
    count: 10,
  });
  assert.deepEqual(
    rows.map((row) => [row.page_id, row.unmatched === true]),
    [
      [id(4), false],
      [id(2), true],
      [id(1), false],
    ],
  );
});

/** Every page of one walk, with each page's size. */
async function walkPages(f, principal, args) {
  const pages = [];
  let cursor;
  for (let request = 0; request < 500; request++) {
    const { source, body } = await f.list(principal, { ...args, ...(cursor && { cursor }) });
    pages.push({ source, ids: body.pages.map((page) => page.page_id), cursor: body.next_cursor });
    cursor = body.next_cursor;
    if (!cursor) return pages;
  }
  throw new Error("the walk did not end");
}

test("a long search walks D1 to the end when the needle check drops rows a page scanned", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(owner).ctx.storage;
  // Runs of decoys longer than one page's scan bound (2 × limit + 16)
  // between the matches, in both activity and title order.
  const matches = [];
  let n = 0;
  for (let group = 0; group < 4; group++) {
    for (let k = 0; k < 25; k++) {
      n++;
      await storage.put(`page/${id(n)}`, {
        page_id: id(n),
        title: decoy(`${group}-${String(k).padStart(2, "0")}`),
        created_at: at(n),
        updated_at: at(n),
      });
    }
    n++;
    matches.push(id(n));
    await storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: `${NEEDLE} ${group}`,
      created_at: at(n),
      updated_at: at(n),
    });
  }
  await f.untilReady(owner);
  for (const sort of ["activity", "title", "created"]) {
    const pages = await walkPages(f, owner, { query: NEEDLE, limit: 1, sort });
    const label = `${sort}: ${JSON.stringify(pages)}`;
    assert.ok(
      pages.every((page) => page.source === "index"),
      label,
    );
    assert.deepEqual(pages.flatMap((page) => page.ids).sort(), [...matches].sort(), label);
    assert.ok(
      pages.some((page) => page.ids.length === 0 && page.cursor),
      `a page stopped at its scan bound on decoys and continued: ${label}`,
    );
  }
  assert.equal(await storage.get("host/index/unavailable-until"), undefined, "no cooldown");
  assert.equal(await storage.get("host/index/dirty"), undefined);
});

test("a 200-character search lists the same Pages from D1 and from the Catalog fallback", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(member).ctx.storage;
  const want = [];
  const decoys = [];
  const own = async (n, title) =>
    storage.put(`page/${id(n)}`, { page_id: id(n), title, created_at: at(n), updated_at: at(n) });
  const share = async (n, title) => {
    f.addPage(id(n), title, viewerAcl);
    await storage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title,
      created_at: at(n),
      updated_at: at(n),
      shared: true,
    });
  };
  for (let k = 0; k < 12; k++) {
    const n = 10 * k;
    await own(n + 1, `${NEEDLE} owned ${k}`);
    want.push(id(n + 1));
    await share(n + 2, `Re: ${NEEDLE.toUpperCase()} shared ${k}`);
    want.push(id(n + 2));
    await own(n + 3, decoy(`owned ${k}`));
    await share(n + 4, decoy(`shared ${k}`));
    decoys.push(id(n + 4));
    await own(n + 5, `unrelated ${k}`);
  }
  await f.untilReady(member);
  await f.settle();
  // Count Page host checks from here: a decoy row lists nothing, so it
  // never needs one.
  const checks = new Map();
  for (const pageId of decoys) {
    const host = f.pages.get(pageId);
    const fetch = host.fetch;
    host.fetch = (request) => {
      checks.set(pageId, (checks.get(pageId) ?? 0) + 1);
      return fetch(request);
    };
  }
  const walks = [];
  for (const sort of ["activity", "title"])
    for (const limit of [1, 5, 50]) walks.push({ sort, limit });
  const indexed = [];
  for (const { sort, limit } of walks) {
    const label = `${sort} limit ${limit}`;
    const pages = await walkPages(f, member, { query: NEEDLE, limit, sort });
    assert.ok(
      pages.every((page) => page.source === "index"),
      `${label}: ${JSON.stringify(pages)}`,
    );
    const ids = pages.flatMap((page) => page.ids);
    assert.equal(new Set(ids).size, ids.length, label);
    assert.deepEqual([...ids].sort(), [...want].sort(), label);
    indexed.push(ids);
  }
  // The same walks with the index off read the Catalog entries.
  delete f.env.PAGES_CATALOG_INDEX;
  for (const [index, { sort, limit }] of walks.entries()) {
    const label = `${sort} limit ${limit}`;
    const pages = await walkPages(f, member, { query: NEEDLE, limit, sort });
    assert.ok(
      pages.every((page) => page.source === "catalog"),
      label,
    );
    assert.deepEqual(pages.flatMap((page) => page.ids).sort(), [...indexed[index]].sort(), label);
  }
  assert.deepEqual([...checks], [], "no decoy host was checked");
  assert.equal(await storage.get("host/index/unavailable-until"), undefined, "no cooldown");
});

/** A deferred promise: settle it with `resolve` or `reject`. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}
const turns = async (n = 20) => {
  for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
};
const state = (promise) =>
  Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    turns().then(() => "pending"),
  ]);
/** Object state that records how many promises it holds. */
const objectCtx = () => {
  const held = [];
  return { held, waitUntil: (promise) => held.push(promise) };
};
const schemaRows = (db) => db.rows("SELECT version FROM pages_catalog_schema ORDER BY version");

test("an object never waits on another object's migration attempt", async (t) => {
  const db = new SqliteD1(":memory:");
  t.after(() => db.sqlite.close());
  const env = { DB: db };
  // The first object's first migration batch is in flight and stays there:
  // its object reset, or its context dropped the call.
  const stuck = deferred();
  db.holdNext = stuck.promise;
  const first = objectCtx();
  const stranded = catalogIndexDatabase(env, first);
  await turns();
  assert.equal(await state(stranded), "pending");
  // Another object's call runs its own attempt on its own clock.
  const second = objectCtx();
  assert.equal(
    await withTimeout(catalogIndexDatabase(env, second), catalogIndexTimeouts.write),
    db,
    "ready within a writer's own bound",
  );
  assert.equal(await state(stranded), "pending", "the first attempt is still out");
  assert.equal(second.held.length, 1, "the second attempt is held on its own object");
  // When the stranded batch finally lands, it loses the race to the
  // migrated schema, rolls back and reads the winner's version.
  stuck.resolve();
  assert.equal(await stranded, db);
  assert.deepEqual(
    schemaRows(db).map((row) => row.version),
    CATALOG_MIGRATIONS.map((migration) => migration.version),
  );
});

test("settled readiness is shared: later objects reuse it without touching D1", async (t) => {
  const db = new SqliteD1(":memory:");
  t.after(() => db.sqlite.close());
  const env = { DB: db };
  const first = objectCtx();
  // Two calls from one object share its attempt.
  const [one, two] = [catalogIndexDatabase(env, first), catalogIndexDatabase(env, first)];
  assert.equal(one, two);
  assert.equal(await one, db);
  const calls = db.calls;
  const later = objectCtx();
  assert.equal(await catalogIndexDatabase(env, later), db);
  assert.equal(await catalogIndexDatabase(env, first), db);
  assert.equal(db.calls, calls, "no D1 call once ready");
  assert.equal(later.held.length, 0, "nothing to hold");
});

test("a failed or expired attempt isn't kept: the next call retries", async (t) => {
  const db = new SqliteD1(":memory:");
  t.after(() => db.sqlite.close());
  const env = { DB: db };
  const ctx = objectCtx();
  db.mode = "fail";
  await assert.rejects(catalogIndexDatabase(env, ctx), /injected D1 outage/);
  const saved = catalogIndexTimeouts.migration;
  t.after(() => (catalogIndexTimeouts.migration = saved));
  catalogIndexTimeouts.migration = 20;
  db.mode = "hang";
  await assert.rejects(catalogIndexDatabase(env, ctx), /migration timed out/);
  catalogIndexTimeouts.migration = saved;
  db.mode = "ok";
  assert.equal(await catalogIndexDatabase(env, ctx), db);
  assert.equal(schemaRows(db).length, CATALOG_MIGRATIONS.length);
});
