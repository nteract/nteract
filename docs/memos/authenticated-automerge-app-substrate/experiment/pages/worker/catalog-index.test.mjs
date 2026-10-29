import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import {
  CATALOG_MIGRATIONS,
  catalogIndexTimeouts,
  decodeCursor,
  encodeCursor,
  listingRestricted,
  migrateCatalogIndex,
  parseListArguments,
  queryCatalogIndex,
  reportPageIndex,
  restrictPageIndex,
} from "./catalog-index.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async sync() {}
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit),
    );
  }
}

const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const at = (minute) => `2026-10-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
const namespace = "user:anaconda-fixture";
const owner = `${namespace}:fixture-user`;
const member = `${namespace}:member`;

test("migrations apply once, tolerate concurrent and newer schemas, and roll back atomically", async (t) => {
  const d1 = sqliteD1(t);
  const first = d1.open(),
    second = d1.open();
  const versions = CATALOG_MIGRATIONS.map((migration) => migration.version);
  assert.deepEqual(
    versions,
    [...versions].sort((a, b) => a - b),
    "append migrations in increasing version order",
  );
  assert.equal(new Set(versions).size, versions.length);
  const latest = versions.at(-1);
  assert.deepEqual(await Promise.all([migrateCatalogIndex(first), migrateCatalogIndex(second)]), [
    latest,
    latest,
  ]);
  assert.equal(await migrateCatalogIndex(first), latest);
  assert.equal(first.rows("SELECT count(*) AS n FROM pages_catalog_schema")[0].n, versions.length);

  // A newer build's additive migration must not break this build.
  first.sqlite.exec("INSERT INTO pages_catalog_schema VALUES (999, 'future', 'later')");
  assert.equal(await migrateCatalogIndex(first), 999);

  const other = sqliteD1(t).open();
  await migrateCatalogIndex(other);
  const next = [
    ...CATALOG_MIGRATIONS,
    { version: latest + 1, name: "probe", statements: ["CREATE TABLE probe (x)", "SELECT 1"] },
  ];
  other.failAt = 1;
  await assert.rejects(migrateCatalogIndex(other, next), /injected/);
  assert.equal(other.rows("SELECT max(version) AS v FROM pages_catalog_schema")[0].v, latest);
  assert.equal(other.rows("SELECT name FROM sqlite_master WHERE name = 'probe'").length, 0);
  assert.equal(await migrateCatalogIndex(other, next), latest + 1);
});

async function seededIndex(t) {
  const db = sqliteD1(t).open();
  await migrateCatalogIndex(db);
  const env = { DB: db, PAGES_CATALOG_INDEX: "1" };
  const page = (n, title, updatedAt, extra = {}) =>
    reportPageIndex(env, {
      metadata: { pageId: id(n), owner, deleted: false, acl: { revision: 0, members: {} } },
      title,
      observedAt: updatedAt,
      ...extra,
    });
  return { db, env, page };
}

test("search escapes LIKE wildcards and matches titles case-insensitively", async (t) => {
  const { db, page } = await seededIndex(t);
  await page(1, "100% done", at(1));
  await page(2, "a_b", at(2));
  await page(3, "back\\slash", at(3));
  await page(4, "Quarterly PLAN", at(4));
  await page(5, "abb and 100 done", at(5));
  const titles = async (query) =>
    (
      await queryCatalogIndex(db, {
        principal: owner,
        ...parseListArguments({ query }),
      })
    ).rows.map((row) => row.title);
  assert.deepEqual(await titles("%"), ["100% done"]);
  assert.deepEqual(await titles("_"), ["a_b"]);
  assert.deepEqual(await titles("\\"), ["back\\slash"]);
  assert.deepEqual(await titles("plan"), ["Quarterly PLAN"]);
  assert.deepEqual(await titles("  "), [
    "abb and 100 done",
    "Quarterly PLAN",
    "back\\slash",
    "a_b",
    "100% done",
  ]);
  assert.deepEqual(await titles("missing"), []);
});

test("keyset pagination is stable across ties and concurrent inserts", async (t) => {
  const { db, page } = await seededIndex(t);
  for (let n = 1; n <= 7; n++) await page(n, `Page ${n}`, at(n <= 3 ? 1 : n));
  const all = (
    await queryCatalogIndex(db, { principal: owner, ...parseListArguments({ limit: 100 }) })
  ).rows.map((row) => row.page_id);
  assert.equal(all.length, 7);
  const seen = [];
  let cursor;
  for (let request = 0; request < 10; request++) {
    const result = await queryCatalogIndex(db, {
      principal: owner,
      ...parseListArguments({ limit: 3, ...(cursor && { cursor }) }),
    });
    seen.push(...result.rows.map((row) => row.page_id));
    // A newer Page arriving mid-listing sorts before the cursor; it is not a duplicate.
    if (request === 0) await page(8, "Newest", at(30));
    cursor = result.next_cursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, all);
  assert.throws(() => decodeCursor("c1_bm90LWpzb24"), { code: "invalid_cursor" });
  assert.throws(() => decodeCursor(encodeCursor({ updated_at: at(1), page_id: "x" })), {
    code: "invalid_cursor",
  });
  assert.throws(() => parseListArguments({ limit: 101 }), { status: 400 });
  assert.throws(() => parseListArguments({ in_trash: "yes" }), { status: 400 });
  assert.deepEqual(parseListArguments({ page_id: id(1) }).limit, 50, "unknown keys are ignored");
});

test("restrictions only delete, deleted Pages cannot be revived by late reports", async (t) => {
  const { db, env } = await seededIndex(t);
  env.PAGES_COMPANY_VIEW_DOMAINS = "anaconda.com";
  env.NOTEBOOK_CLOUD_OIDC_PRINCIPAL_NAMESPACE = namespace;
  const metadata = {
    pageId: id(1),
    owner,
    deleted: false,
    acl: {
      revision: 2,
      members: { [member]: { role: "viewer", generation: 1 } },
      domainView: { domain: "anaconda.com", namespace },
    },
  };
  const reader = `${namespace}:reader`;
  await reportPageIndex(env, {
    metadata,
    title: "Plan",
    observedAt: at(1),
    reader: { principal: reader, domain: "anaconda.com" },
  });
  const rows = () =>
    db
      .rows("SELECT principal, source FROM pages_catalog_access ORDER BY principal")
      .map((row) => `${row.source}:${row.principal}`);
  assert.deepEqual(
    rows().sort(),
    [`owner:${owner}`, `member:${member}`, `domain_opened:${reader}`].sort(),
  );
  const cleared = { ...metadata, acl: { ...metadata.acl, revision: 3, domainView: null } };
  assert.equal(listingRestricted(metadata, cleared, env), true);
  await restrictPageIndex(env, cleared);
  assert.ok(!rows().includes(`domain_opened:${reader}`));
  const removed = {
    ...cleared,
    acl: { ...cleared.acl, revision: 4, members: { [member]: { role: "none", generation: 2 } } },
  };
  assert.equal(listingRestricted(cleared, removed, env), true);
  const granted = {
    ...cleared,
    acl: {
      ...cleared.acl,
      members: { ...cleared.acl.members, [reader]: { role: "editor", generation: 1 } },
    },
  };
  assert.equal(listingRestricted(cleared, granted, env), false, "pure grants skip D1");
  await restrictPageIndex(env, removed);
  assert.deepEqual(rows(), [`owner:${owner}`]);

  await restrictPageIndex(env, { ...metadata, deleted: true });
  assert.deepEqual(rows(), []);
  await reportPageIndex(env, { metadata, title: "Late title", observedAt: at(9) });
  assert.deepEqual(rows(), []);
  assert.deepEqual(db.rows("SELECT state, title FROM pages_catalog_pages"), [
    { state: "deleted", title: "" },
  ]);
});

async function catalogFixture(t, { index = "1" } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const d1 = sqliteD1(t);
  const db = d1.open();
  const pages = new Map();
  const catalogs = new Map();
  const jobs = [];
  const env = {
    ...auth.env,
    DB: db,
    ...(index && { PAGES_CATALOG_INDEX: index }),
    PAGES: {
      getByName: (pageId) => {
        const page = pages.get(pageId);
        return (
          page ?? { fetch: async () => Response.json({ error: "Page not found" }, { status: 404 }) }
        );
      },
    },
    CATALOGS: {
      getByName: (principal) => {
        if (!catalogs.has(principal))
          catalogs.set(
            principal,
            new Catalog({ id: { name: principal }, storage: new Storage() }, env),
          );
        return catalogs.get(principal);
      },
    },
  };
  const tokens = { [owner]: auth.apiKey(), [member]: auth.apiKey({ userId: "member" }) };
  const catalog = (principal) => env.CATALOGS.getByName(principal);
  const list = async (principal, args = {}) => {
    const response = await catalog(principal).fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${tokens[principal]}` },
        body: JSON.stringify({ operation: "list_pages", arguments: args }),
      }),
    );
    return {
      status: response.status,
      source: response.headers.get("x-pages-catalog-source"),
      body: await response.json(),
    };
  };
  /** A real Page host with stubbed native resources. */
  const addPage = (pageId, title, acl = { revision: 0, members: {} }) => {
    const storage = new Storage();
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      ctx: { storage, waitUntil: (promise) => jobs.push(promise) },
      metadata: { pageId, owner, deleted: false, documentId: "doc", acl },
      handle: { doc: () => ({ title }), broadcast() {} },
      calls: 0,
    });
    page.policy = new DocumentPolicy({
      storage,
      metadata: () => page.policyMetadata ?? page.metadata,
    });
    page.policy.refreshAccess = async () => {};
    const run = page.run.bind(page);
    page.fetch = (request) => {
      if (new URL(request.url).pathname === "/internal/catalog") page.calls++;
      return run(request);
    };
    pages.set(pageId, page);
    return page;
  };
  return { auth, db, env, pages, catalog, list, addPage, jobs, settle: () => Promise.all(jobs) };
}

test("first listing backfills owned and shared entries once, verifying shared Pages", async (t) => {
  const f = await catalogFixture(t);
  const ownerStorage = f.catalog(owner).ctx.storage;
  for (let n = 1; n <= 120; n++)
    await ownerStorage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: `Owned ${n}`,
      created_at: at(0),
      updated_at: `2026-10-01T01:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}.000Z`,
    });
  await ownerStorage.put(`page/${id(500)}`, { page_id: id(500), title: "Pending", pending: true });
  const memberStorage = f.catalog(member).ctx.storage;
  const shared = f.addPage(id(200), "Shared plan", {
    revision: 1,
    members: { [member]: { role: "editor", generation: 1 } },
  });
  f.addPage(id(201), "Revoked", {
    revision: 2,
    members: { [member]: { role: "none", generation: 2 } },
  });
  const flaky = f.addPage(id(202), "Flaky", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  const flakyFetch = flaky.fetch;
  flaky.fetch = async () => Response.json({ error: "busy" }, { status: 503 });
  for (const [n, title] of [
    [200, "Old shared title"],
    [201, "Revoked"],
    [202, "Flaky"],
  ])
    await memberStorage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title,
      created_at: at(n - 190),
      updated_at: at(n - 190),
      shared: true,
    });

  // Owned listing: no 100-entry cap, newest first, pending hidden.
  const pages = [];
  let cursor;
  do {
    const result = await f.list(owner, { limit: 50, ...(cursor && { cursor }) });
    assert.equal(result.source, "index");
    pages.push(...result.body.pages);
    cursor = result.body.next_cursor;
  } while (cursor);
  assert.equal(pages.length, 120);
  assert.equal(pages[0].title, "Owned 120");
  assert.ok(!pages.some((page) => page.title === "Pending"));

  const first = await f.list(member);
  assert.equal(first.source, "index");
  assert.deepEqual(
    first.body.pages.map((page) => [page.title, page.shared]),
    [["Shared plan", true]],
  );
  assert.equal(await memberStorage.get(`shared/${id(201)}`), undefined, "denied entry is pruned");
  assert.deepEqual(
    f.db.rows("SELECT principal FROM pages_catalog_accounts").map((row) => row.principal),
    [owner],
    "an unanswered verification leaves the member unmarked",
  );
  flaky.fetch = flakyFetch;
  const second = await f.list(member);
  assert.deepEqual(second.body.pages.map((page) => page.title).sort(), ["Flaky", "Shared plan"]);
  assert.equal(f.db.rows("SELECT count(*) AS n FROM pages_catalog_accounts")[0].n, 2);
  assert.deepEqual(
    f.db.rows(
      "SELECT role, source FROM pages_catalog_access WHERE principal = ? AND page_id = ?",
      member,
      id(200),
    ),
    [{ role: "editor", source: "member" }],
  );
  // After backfill, listings verify only the shared candidates they return.
  shared.calls = 0;
  flaky.calls = 0;
  const third = await f.list(member, { limit: 1 });
  assert.equal(third.body.pages.length, 1);
  assert.equal(shared.calls + flaky.calls, 1);
  assert.ok(third.body.next_cursor);
  assert.equal(typeof third.body.retry_token, "string");
});

test("a revoked member's row is removed before the ACL commits and never listed", async (t) => {
  const f = await catalogFixture(t);
  const page = f.addPage(id(300), "Team plan", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  page.cacheTitle();
  await f.settle();
  assert.deepEqual(
    (await f.list(member)).body.pages.map((entry) => entry.title),
    ["Team plan"],
  );
  let rowsAtCommit;
  const put = page.ctx.storage.put.bind(page.ctx.storage);
  page.ctx.storage.put = async (key, value) => {
    if (key === "host/document")
      rowsAtCommit = f.db.rows(
        "SELECT principal FROM pages_catalog_access WHERE page_id = ?",
        id(300),
      );
    return put(key, value);
  };
  await page.installAccess({
    ...page.metadata,
    acl: { revision: 2, members: { [member]: { role: "none", generation: 2 } } },
  });
  assert.deepEqual(rowsAtCommit, [{ principal: owner }]);
  await f.settle();
  assert.deepEqual((await f.list(member)).body.pages, []);
});

test("D1 outages never block revocation, and listing verification hides stale rows", async (t) => {
  const f = await catalogFixture(t);
  const page = f.addPage(id(301), "Team plan", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  page.cacheTitle();
  await f.settle();
  assert.equal((await f.list(member)).body.pages.length, 1);
  const timeouts = { ...catalogIndexTimeouts };
  t.after(() => Object.assign(catalogIndexTimeouts, timeouts));
  Object.assign(catalogIndexTimeouts, { read: 30, write: 30 });
  f.db.mode = "hang";
  await page.installAccess({
    ...page.metadata,
    acl: { revision: 2, members: { [member]: { role: "none", generation: 2 } } },
  });
  assert.equal(page.metadata.acl.revision, 2, "the ACL committed without D1");
  await f.settle().catch(() => {});
  f.db.mode = "ok";
  assert.equal(
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", member)[0].n,
    1,
    "the stale row is still in D1",
  );
  const listed = await f.list(member);
  assert.equal(listed.source, "index");
  assert.deepEqual(listed.body.pages, []);
  assert.equal(
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", member)[0].n,
    0,
    "verification pruned it",
  );
  assert.deepEqual(
    (await f.list(member, { query: "team" })).body.pages,
    [],
    "search cannot surface it either",
  );
});

test("listing falls back to Catalog entries when D1 fails or is slow", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(owner).ctx.storage;
  // Entries written by older builds carry no state or trash fields.
  await storage.put(`page/${id(1)}`, {
    page_id: id(1),
    title: "Legacy",
    created_at: at(1),
    updated_at: at(1),
  });
  await storage.put(`page/${id(2)}`, {
    page_id: id(2),
    title: "Newer",
    created_at: at(2),
    updated_at: at(2),
  });
  const timeouts = { ...catalogIndexTimeouts };
  t.after(() => Object.assign(catalogIndexTimeouts, timeouts));
  Object.assign(catalogIndexTimeouts, { read: 30, write: 30, migration: 50 });
  for (const mode of ["fail", "hang"]) {
    f.db.mode = mode;
    const result = await f.list(owner, { limit: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.source, "catalog");
    assert.deepEqual(
      result.body.pages.map((page) => page.title),
      ["Newer"],
    );
    const next = await f.list(owner, { cursor: result.body.next_cursor });
    assert.deepEqual(
      next.body.pages.map((page) => page.title),
      ["Legacy"],
    );
    assert.equal(next.body.next_cursor, null);
  }
  f.db.mode = "ok";
  // Let the stuck migration attempt expire so the next listing retries it.
  await new Promise((resolve) => setTimeout(resolve, 80));
  const indexed = await f.list(owner, { query: "LEG" });
  assert.equal(indexed.source, "index");
  assert.deepEqual(
    indexed.body.pages.map((page) => page.title),
    ["Legacy"],
  );
  // Catalog entries keep their legacy keys and shape, so older builds read them.
  assert.deepEqual(
    [...storage.values.keys()].filter((key) => !key.startsWith("host/")).sort(),
    [`page/${id(1)}`, `page/${id(2)}`].sort(),
  );
  assert.equal(await storage.get("host/index/dirty"), undefined);
});

test("index disabled: no D1 access and the bare call keeps the legacy fields", async (t) => {
  const f = await catalogFixture(t, { index: null });
  const storage = f.catalog(owner).ctx.storage;
  await storage.put(`page/${id(1)}`, { page_id: id(1), title: "Legacy" });
  const result = await f.list(owner);
  assert.equal(result.source, "catalog");
  assert.equal(f.db.calls, 0);
  assert.deepEqual(result.body.pages, [{ page_id: id(1), title: "Legacy" }]);
  for (const key of ["limit", "next_cursor", "retry_token", "retry_key_prefix", "retry_until"])
    assert.ok(Object.hasOwn(result.body, key), key);
});

test("owner rows need a live Catalog entry; deletion clears the row and marks a reconcile", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(owner).ctx.storage;
  await storage.put(`page/${id(7)}`, {
    page_id: id(7),
    title: "Doomed",
    created_at: at(1),
    updated_at: at(1),
  });
  assert.equal((await f.list(owner)).body.pages.length, 1);
  // An older build deleted the entry without touching D1.
  await storage.delete(`page/${id(7)}`);
  assert.deepEqual((await f.list(owner)).body.pages, []);
  assert.equal(await storage.get("host/index/dirty"), true);
  await f.list(owner);
  assert.equal(
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE page_id = ?", id(7))[0].n,
    0,
  );
  assert.equal(await storage.get("host/index/dirty"), undefined);
  assert.deepEqual((await f.list(owner, { in_trash: true })).body.pages, []);
});
