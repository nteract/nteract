import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import {
  CATALOG_MIGRATIONS,
  catalogIndexBounds,
  catalogIndexTimeouts,
  listingRestricted,
  migrateCatalogIndex,
  openCursor,
  parseListArguments,
  pruneIndexRows,
  queryCatalogIndex,
  reportPageIndex,
  restrictPageIndex,
  retirePageIndex,
  sealCursor,
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
  async list({ prefix = "", startAfter, limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .slice(0, limit),
    );
  }
}

const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const at = (minute) =>
  `2026-10-01T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
const namespace = "user:anaconda-fixture";
const owner = `${namespace}:fixture-user`;
const member = `${namespace}:member`;
const stranger = `${namespace}:stranger`;

/** Shorten every bound for one test and restore it afterwards. */
function shortBounds(t, timeouts = {}, bounds = {}) {
  const savedTimeouts = { ...catalogIndexTimeouts };
  const savedBounds = { ...catalogIndexBounds };
  t.after(() => {
    Object.assign(catalogIndexTimeouts, savedTimeouts);
    Object.assign(catalogIndexBounds, savedBounds);
  });
  Object.assign(catalogIndexTimeouts, timeouts);
  Object.assign(catalogIndexBounds, bounds);
}

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
  const page = (n, title, updatedAt, acl = { revision: 0, members: {} }) =>
    reportPageIndex(env, {
      metadata: { pageId: id(n), owner, deleted: false, acl },
      title,
      observedAt: updatedAt,
    });
  const query = (options = {}) =>
    queryCatalogIndex(db, {
      principal: owner,
      inTrash: false,
      needle: null,
      after: null,
      count: 100,
      ...options,
    });
  return { db, env, page, query };
}

test("search escapes LIKE wildcards and matches titles case-insensitively", async (t) => {
  const { page, query } = await seededIndex(t);
  await page(1, "100% done", at(1));
  await page(2, "a_b", at(2));
  await page(3, "back\\slash", at(3));
  await page(4, "Quarterly PLAN", at(4));
  await page(5, "abb and 100 done", at(5));
  const titles = async (text) =>
    (await query({ needle: parseListArguments({ query: text }).needle })).map((row) => row.title);
  assert.deepEqual(await titles("%"), ["100% done"]);
  assert.deepEqual(await titles("_"), ["a_b"]);
  assert.deepEqual(await titles("\\"), ["back\\slash"]);
  assert.deepEqual(await titles("plan"), ["Quarterly PLAN"]);
  assert.equal((await titles("  ")).length, 5);
  assert.deepEqual(await titles("missing"), []);
});

test("keyset positions are stable across ties and newer inserts", async (t) => {
  const { page, query } = await seededIndex(t);
  for (let n = 1; n <= 7; n++) await page(n, `Page ${n}`, at(n <= 3 ? 1 : n));
  const all = (await query()).map((row) => row.page_id);
  assert.equal(all.length, 7);
  const seen = [];
  let after = null;
  for (let request = 0; request < 10; request++) {
    const rows = await query({ after, count: 3 });
    seen.push(...rows.map((row) => row.page_id));
    if (request === 0) await page(8, "Newest", at(30));
    if (rows.length < 3) break;
    after = rows.at(-1);
  }
  assert.deepEqual(seen, all);
});

test("bare list calls keep the legacy page size; arguments are validated", () => {
  assert.equal(parseListArguments({}).limit, 100);
  assert.equal(parseListArguments({ page_id: id(1) }).limit, 100, "unknown keys are ignored");
  assert.equal(parseListArguments({ query: "x" }).limit, 50);
  assert.equal(parseListArguments({ in_trash: false }).limit, 50);
  assert.throws(() => parseListArguments({ limit: 101 }), { status: 400 });
  assert.throws(() => parseListArguments({ in_trash: "yes" }), { status: 400 });
  assert.throws(() => parseListArguments({ cursor: 7 }), { code: "invalid_cursor" });
});

test("cursors are sealed, opaque and bound to principal, query and in_trash", async () => {
  const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: "s".repeat(32) };
  const context = { principal: owner, needle: "plan", inTrash: false };
  const position = { updated_at: at(5), page_id: id(42) };
  const cursor = await sealCursor(env, context, position);
  assert.deepEqual(await openCursor(env, context, cursor), position);
  const exposed = Buffer.from(cursor.slice(3), "base64url").toString("latin1");
  assert.ok(!exposed.includes(id(42)) && !exposed.includes("2026-10-01"), "position is encrypted");
  assert.notEqual(await sealCursor(env, context, position), cursor, "fresh nonce per seal");
  const rejects = (promise) => assert.rejects(promise, { status: 400, code: "invalid_cursor" });
  await rejects(openCursor(env, { ...context, principal: member }, cursor));
  await rejects(openCursor(env, { ...context, needle: "other" }, cursor));
  await rejects(openCursor(env, { ...context, inTrash: true }, cursor));
  await rejects(openCursor({ NOTEBOOK_CLOUD_APP_SESSION_SECRET: "t".repeat(32) }, context, cursor));
  const bytes = Buffer.from(cursor.slice(3), "base64url");
  bytes[bytes.length - 1] ^= 1;
  await rejects(openCursor(env, context, `c2_${bytes.toString("base64url")}`));
  const legacy = `c1_${Buffer.from(JSON.stringify([at(5), id(42)])).toString("base64url")}`;
  await rejects(openCursor(env, context, legacy));
});

test("delayed reports from an older ACL revision change nothing", async (t) => {
  const { db, env } = await seededIndex(t);
  const metadata = (revision, members) => ({
    pageId: id(1),
    owner,
    deleted: false,
    acl: { revision, members },
  });
  const granted = metadata(1, { [member]: { role: "viewer", generation: 1 } });
  const removed = metadata(2, { [member]: { role: "none", generation: 2 } });
  await reportPageIndex(env, { metadata: granted, title: "Before", observedAt: at(1) });
  let release;
  db.holdNext = new Promise((resolve) => {
    release = resolve;
  });
  // A report that outlived its caller's timeout is still in flight.
  const delayed = reportPageIndex(env, { metadata: granted, title: "Old", observedAt: at(2) });
  await new Promise((resolve) => setImmediate(resolve));
  await restrictPageIndex(env, removed);
  await reportPageIndex(env, { metadata: removed, title: "New", observedAt: at(3) });
  release();
  await delayed;
  assert.deepEqual(db.rows("SELECT principal FROM pages_catalog_access ORDER BY principal"), [
    { principal: owner },
  ]);
  assert.deepEqual(db.rows("SELECT title, acl_revision FROM pages_catalog_pages"), [
    { title: "New", acl_revision: 2 },
  ]);
});

test("restrictions are delete-only; only a durable retirement writes the deleted tombstone", async (t) => {
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
      .rows("SELECT principal, source FROM pages_catalog_access")
      .map((row) => `${row.source}:${row.principal}`)
      .sort();
  assert.deepEqual(
    rows(),
    [`owner:${owner}`, `member:${member}`, `domain_opened:${reader}`].sort(),
  );
  const cleared = { ...metadata, acl: { ...metadata.acl, revision: 3, domainView: null } };
  assert.equal(listingRestricted(metadata, cleared, env), true);
  await restrictPageIndex(env, cleared);
  assert.ok(!rows().includes(`domain_opened:${reader}`));
  const granted = {
    ...cleared,
    acl: {
      ...cleared.acl,
      members: { ...cleared.acl.members, [reader]: { role: "editor", generation: 1 } },
    },
  };
  assert.equal(listingRestricted(cleared, granted, env), false, "pure grants skip D1");
  const removed = {
    ...cleared,
    acl: { ...cleared.acl, revision: 4, members: { [member]: { role: "none", generation: 2 } } },
  };
  assert.equal(listingRestricted(cleared, removed, env), true);
  await restrictPageIndex(env, removed);
  assert.deepEqual(rows(), [`owner:${owner}`]);

  // Before durability, deletion only drops rows; the Page can still come back.
  const deleted = { ...metadata, deleted: true };
  await restrictPageIndex(env, deleted);
  assert.deepEqual(rows(), [`owner:${owner}`]);
  assert.equal(db.rows("SELECT state FROM pages_catalog_pages")[0].state, "active");
  await retirePageIndex(env, deleted);
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
  const db = sqliteD1(t).open();
  const pages = new Map();
  const catalogs = new Map();
  const jobs = [];
  const env = {
    ...auth.env,
    DB: db,
    ...(index && { PAGES_CATALOG_INDEX: index }),
    PAGES: {
      getByName: (pageId) =>
        pages.get(pageId) ?? {
          fetch: async () => Response.json({ error: "Page not found" }, { status: 404 }),
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
  const tokens = {
    [owner]: auth.apiKey(),
    [member]: auth.apiKey({ userId: "member" }),
    [stranger]: auth.apiKey({ userId: "stranger" }),
  };
  const catalog = (principal) => env.CATALOGS.getByName(principal);
  const request = (principal, path, body) =>
    new Request(`https://pages.invalid${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${tokens[principal]}` },
      body: JSON.stringify(body),
    });
  const list = async (principal, args = {}) => {
    const response = await catalog(principal).fetch(
      request(principal, "/internal/catalog", { operation: "list_pages", arguments: args }),
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
    const doc = A.from({ page_id: pageId, title });
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      ctx: { storage, waitUntil: (promise) => jobs.push(promise) },
      metadata: { pageId, owner, deleted: false, documentId: "doc", acl },
      handle: { doc: () => doc, broadcast() {} },
      wires: new Set(),
      repo: { delete: async () => {} },
      backend: { flush: async () => {} },
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
  const settle = async () => {
    while (jobs.length) await Promise.allSettled(jobs.splice(0));
  };
  return { auth, db, env, pages, catalog, request, list, addPage, settle };
}

async function ownEntries(storage, count, title = (n) => `Owned ${n}`) {
  for (let n = 1; n <= count; n++)
    await storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: title(n),
      created_at: at(0),
      updated_at: at(n),
    });
}

test("bare list_pages returns up to 100 entries; explicit arguments page by 50", async (t) => {
  const f = await catalogFixture(t);
  await ownEntries(f.catalog(owner).ctx.storage, 60);
  const bare = await f.list(owner);
  assert.equal(bare.source, "index");
  assert.equal(bare.body.limit, 100);
  assert.equal(bare.body.pages.length, 60);
  assert.equal(bare.body.next_cursor, null);
  const paged = await f.list(owner, { query: "owned" });
  assert.equal(paged.body.pages.length, 50);
  assert.ok(paged.body.next_cursor);
  const rest = await f.list(owner, { query: "owned", cursor: paged.body.next_cursor });
  assert.equal(rest.body.pages.length, 10);
  assert.equal(rest.body.next_cursor, null);
});

test("first listing backfills owned and shared entries, verifying shared Pages", async (t) => {
  const f = await catalogFixture(t);
  await ownEntries(f.catalog(owner).ctx.storage, 120);
  await f.catalog(owner).ctx.storage.put(`page/${id(500)}`, { page_id: id(500), pending: true });
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
  for (const n of [200, 201, 202])
    await memberStorage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title: "Stale entry title",
      created_at: at(n - 190),
      updated_at: at(n - 190),
      shared: true,
    });

  // The first pass spans listings (128 entries each); cursors work across the
  // switch from Catalog entries to D1.
  const pages = [];
  let cursor;
  do {
    const result = await f.list(owner, { limit: 50, ...(cursor && { cursor }) });
    pages.push(...result.body.pages);
    cursor = result.body.next_cursor;
  } while (cursor);
  assert.equal(pages.length, 120, "no 100-entry cap");
  assert.equal(new Set(pages.map((page) => page.page_id)).size, 120);
  assert.equal(pages[0].title, "Owned 120");
  assert.equal((await f.list(owner, { limit: 1 })).source, "index");

  // The member's pass cannot finish while one host is unavailable, so the
  // Catalog entries serve; a later listing completes it and switches to D1.
  flaky.fetch = async () => Response.json({ error: "busy" }, { status: 503 });
  const first = await f.list(member, { limit: 10 });
  assert.equal(first.status, 503);
  assert.equal(await memberStorage.get(`shared/${id(201)}`), undefined, "denied entry is pruned");
  flaky.fetch = flakyFetch;
  const second = await f.list(member);
  assert.deepEqual(second.body.pages.map((page) => page.title).sort(), ["Flaky", "Shared plan"]);
  const third = await f.list(member);
  assert.equal(third.source, "index");
  assert.deepEqual(
    f.db.rows(
      "SELECT role, source FROM pages_catalog_access WHERE principal = ? AND page_id = ?",
      member,
      id(200),
    ),
    [{ role: "editor", source: "member" }],
  );
  shared.calls = 0;
  flaky.calls = 0;
  const limited = await f.list(member, { limit: 1 });
  assert.equal(limited.body.pages.length, 1);
  assert.ok(limited.body.next_cursor);
  assert.equal(shared.calls + flaky.calls, 2, "one page plus one verified look-ahead");
  assert.equal(typeof limited.body.retry_token, "string");
});

test("a denied matching row and a nonexistent row produce the same response", async (t) => {
  const f = await catalogFixture(t);
  const visible = [1, 2].map((n) =>
    f.addPage(id(n), `Visible ${n}`, {
      revision: 1,
      members: { [member]: { role: "viewer", generation: 1 } },
    }),
  );
  for (const page of visible) page.cacheTitle();
  const hidden = f.addPage(id(9), "Secret visible", {
    revision: 2,
    members: { [member]: { role: "none", generation: 2 } },
  });
  hidden.cacheTitle();
  await f.settle();
  await f.list(member);
  // A revoked member's row left behind (for example, D1 was down at revocation),
  // older than both visible Pages, so it would sit right after a page of two.
  f.db.sqlite.exec(`INSERT INTO pages_catalog_access
    (page_id, principal, role, source, updated_revision, updated_at, title, title_search)
    VALUES ('${id(9)}', '${member}', 'viewer', 'member', 1, '2000-01-01T00:00:00.000Z',
      'Secret visible', 'secret visible')`);
  const shape = (result) => ({
    status: result.status,
    source: result.source,
    pages: result.body.pages.map((page) => page.page_id),
    more: result.body.next_cursor !== null,
  });
  for (const args of [{ limit: 2 }, { query: "secret" }, { query: "visible", limit: 2 }]) {
    f.db.sqlite.exec(`INSERT OR IGNORE INTO pages_catalog_access
      (page_id, principal, role, source, updated_revision, updated_at, title, title_search)
      VALUES ('${id(9)}', '${member}', 'viewer', 'member', 1, '2000-01-01T00:00:00.000Z',
        'Secret visible', 'secret visible')`);
    const withStale = shape(await f.list(member, args));
    assert.equal(
      f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE page_id = ?", id(9))[0].n,
      1,
      "only the owner row remains; the stale row was pruned on encounter",
    );
    const without = shape(await f.list(member, args));
    assert.deepEqual(withStale, without, JSON.stringify(args));
    assert.ok(!withStale.pages.includes(id(9)));
  }
});

test("foreign or tampered cursors fail with one generic error", async (t) => {
  const f = await catalogFixture(t);
  await ownEntries(f.catalog(owner).ctx.storage, 3);
  const { next_cursor } = (await f.list(owner, { limit: 1 })).body;
  assert.ok(next_cursor);
  for (const [principal, args] of [
    [member, { limit: 1, cursor: next_cursor }],
    [owner, { limit: 1, query: "owned", cursor: next_cursor }],
    [owner, { limit: 1, in_trash: true, cursor: next_cursor }],
    [owner, { limit: 1, cursor: `${next_cursor.slice(0, -2)}AA` }],
  ]) {
    const result = await f.list(principal, args);
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_cursor");
  }
  const next = await f.list(owner, { limit: 1, cursor: next_cursor });
  assert.equal(next.body.pages[0].title, "Owned 2");
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
  shortBounds(t, { read: 30, write: 30 });
  f.db.mode = "hang";
  await page.installAccess({
    ...page.metadata,
    acl: { revision: 2, members: { [member]: { role: "none", generation: 2 } } },
  });
  assert.equal(page.metadata.acl.revision, 2, "the ACL committed without D1");
  await f.settle();
  assert.equal(await page.ctx.storage.get("host/index/report-pending"), true);
  f.db.mode = "ok";
  const memberRows = () =>
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", member)[0].n;
  assert.equal(memberRows(), 1, "the stale row is still in D1");
  const listed = await f.list(member);
  assert.equal(listed.source, "index");
  assert.deepEqual(listed.body.pages, []);
  assert.equal(memberRows(), 0, "verification pruned it");
  assert.deepEqual((await f.list(member, { query: "team" })).body.pages, []);
  // The failed report repeats on this Page's next request and clears its marker.
  await page.repairIndex();
  await f.settle();
  assert.equal(await page.ctx.storage.get("host/index/report-pending"), undefined);
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
  shortBounds(t, { read: 30, write: 30, migration: 50 });
  for (const mode of ["fail", "hang"]) {
    f.db.mode = mode;
    const result = await f.list(owner, { limit: 1 });
    assert.equal(result.status, 200);
    assert.equal(result.source, "catalog");
    assert.deepEqual(
      result.body.pages.map((page) => page.title),
      ["Newer"],
    );
    const next = await f.list(owner, { limit: 1, cursor: result.body.next_cursor });
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
  await f.catalog(owner).ctx.storage.put(`page/${id(1)}`, { page_id: id(1), title: "Legacy" });
  const result = await f.list(owner);
  assert.equal(result.source, "catalog");
  assert.equal(f.db.calls, 0);
  assert.deepEqual(result.body.pages, [{ page_id: id(1), title: "Legacy" }]);
  assert.equal(result.body.limit, 100);
  for (const key of ["next_cursor", "retry_token", "retry_key_prefix", "retry_until"])
    assert.ok(Object.hasOwn(result.body, key), key);
});

test("owner rows need a live Catalog entry and are pruned on encounter", async (t) => {
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
  assert.equal(
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE page_id = ?", id(7))[0].n,
    0,
  );
  await f.list(owner);
  assert.equal(await storage.get("host/index/dirty"), undefined, "the reconcile pass completed");
  assert.deepEqual((await f.list(owner, { in_trash: true })).body.pages, []);
});

test("an epoch change repairs stale titles and re-verifies existing shared rows", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(owner).ctx.storage;
  await ownEntries(storage, 2);
  const page = f.addPage(id(50), "Shared", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  page.cacheTitle();
  await f.settle();
  await f.list(owner);
  await f.list(member);
  // While the index was unset, a title changed and the member lost access.
  await storage.put(`page/${id(1)}`, {
    ...(await storage.get(`page/${id(1)}`)),
    title: "Renamed while off",
    updated_at: at(500),
  });
  page.metadata = {
    ...page.metadata,
    acl: { revision: 2, members: { [member]: { role: "none", generation: 2 } } },
  };
  f.env.PAGES_CATALOG_INDEX = "2";
  const renamed = await f.list(owner, { query: "renamed" });
  assert.equal(renamed.source, "index");
  assert.deepEqual(
    renamed.body.pages.map((entry) => entry.page_id),
    [id(1)],
  );
  assert.equal(
    f.db.rows("SELECT title FROM pages_catalog_pages WHERE page_id = ?", id(1))[0].title,
    "Renamed while off",
  );
  await f.list(member);
  assert.equal(
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", member)[0].n,
    0,
  );
});

test("reconcile passes are bounded per listing and resume where they stopped", async (t) => {
  const f = await catalogFixture(t);
  shortBounds(t, { verify: 30 }, { verifications: 2, entries: 2 });
  const memberStorage = f.catalog(member).ctx.storage;
  for (let n = 1; n <= 5; n++) {
    f.addPage(id(n), `Shared ${n}`, {
      revision: 1,
      members: { [member]: { role: "viewer", generation: 1 } },
    });
    await memberStorage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title: `Shared ${n}`,
      created_at: at(n),
      updated_at: at(n),
    });
  }
  const calls = () => [...f.pages.values()].reduce((sum, page) => sum + page.calls, 0);
  const sources = [];
  for (let request = 0; request < 6; request++) {
    const before = calls();
    const result = await f.list(member, { limit: 1 });
    sources.push(result.source);
    // Two pass checks plus at most two listing checks (one page and a look-ahead).
    assert.ok(calls() - before <= 4, `bounded verification on listing ${request}`);
  }
  assert.equal(sources[0], "catalog");
  assert.equal(sources.at(-1), "index");
  assert.equal(await memberStorage.get("host/index/sync"), undefined);

  // A host that never answers is unavailable after its deadline, not a hang.
  const stuck = f.pages.get(id(5));
  stuck.fetch = () => new Promise(() => {});
  await memberStorage.put("host/index/dirty", "again");
  const started = Date.now();
  await f.list(member, { limit: 1 });
  assert.ok(Date.now() - started < 1000);
});

test("a crash between deletion barriers leaves the Page indexable", async (t) => {
  const f = await catalogFixture(t);
  const page = f.addPage(id(60), "Team plan", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  page.cacheTitle();
  await f.settle();
  const remove = () =>
    page.fetch(
      f.request(owner, "/internal/delete", {
        page_id: id(60),
        base_heads: A.getHeads(page.handle.doc()),
        idempotency_key: "delete-index-fixture",
      }),
    );
  const put = page.ctx.storage.put.bind(page.ctx.storage);
  page.ctx.storage.put = async (key, value) => {
    if (key === "host/document") throw Error("crash before the tombstone is durable");
    return put(key, value);
  };
  assert.equal((await remove()).status, 500);
  assert.deepEqual(f.db.rows("SELECT state, title FROM pages_catalog_pages"), [
    { state: "active", title: "Team plan" },
  ]);
  // Restart: the durable record never saw the deletion, and the Page reports again.
  const restarted = f.addPage(id(60), "Team plan", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  restarted.cacheTitle();
  await f.settle();
  assert.deepEqual(
    (await f.list(member)).body.pages.map((entry) => entry.page_id),
    [id(60)],
  );
  const deleted = await restarted.fetch(
    f.request(owner, "/internal/delete", {
      page_id: id(60),
      base_heads: A.getHeads(restarted.handle.doc()),
      idempotency_key: "delete-index-fixture",
    }),
  );
  assert.equal(deleted.status, 200);
  assert.deepEqual(f.db.rows("SELECT state, title FROM pages_catalog_pages"), [
    { state: "deleted", title: "" },
  ]);
  assert.equal(f.db.rows("SELECT count(*) AS n FROM pages_catalog_access")[0].n, 0);
});

test("pagination is best-effort across concurrent title changes", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(owner).ctx.storage;
  await ownEntries(storage, 6);
  const first = await f.list(owner, { limit: 2 });
  assert.deepEqual(
    first.body.pages.map((page) => page.page_id),
    [id(6), id(5)],
  );
  const touch = (n, minute) =>
    reportPageIndex(f.env, {
      metadata: { pageId: id(n), owner, deleted: false, acl: { revision: 0, members: {} } },
      title: `Owned ${n}`,
      observedAt: at(minute),
    });
  // An already returned Page moves to the front: it is not returned again.
  await touch(5, 100);
  // A Page not yet returned moves before the cursor: this traversal skips it.
  await touch(2, 101);
  const seen = [...first.body.pages];
  let cursor = first.body.next_cursor;
  while (cursor) {
    const result = await f.list(owner, { limit: 2, cursor });
    seen.push(...result.body.pages);
    cursor = result.body.next_cursor;
  }
  const ids = seen.map((page) => page.page_id);
  assert.equal(new Set(ids).size, ids.length, "no duplicates");
  assert.deepEqual(ids, [id(6), id(5), id(4), id(3), id(1)]);
});

test("cursors expire after a day", async () => {
  const env = {};
  const context = { principal: owner, needle: null, inTrash: false };
  const issued = Date.parse("2026-10-01T00:00:00Z");
  const cursor = await sealCursor(env, context, { updated_at: at(1), page_id: id(1) }, issued);
  const hour = 60 * 60 * 1000;
  assert.equal((await openCursor(env, context, cursor, issued + 23 * hour)).page_id, id(1));
  for (const now of [issued + 25 * hour, issued - hour])
    await assert.rejects(openCursor(env, context, cursor, now), { code: "invalid_cursor" });
});

test("a regrant that lands before a delayed prune survives it", async (t) => {
  const { db, env } = await seededIndex(t);
  const metadata = (revision, role) => ({
    pageId: id(1),
    owner,
    deleted: false,
    acl: { revision, members: { [member]: { role, generation: revision } } },
  });
  await reportPageIndex(env, { metadata: metadata(1, "viewer"), title: "Plan", observedAt: at(1) });
  let release;
  db.holdNext = new Promise((resolve) => {
    release = resolve;
  });
  // A listing saw the row at revision 1 and its Page host denied it.
  const prune = pruneIndexRows(db, [{ page_id: id(1), principal: member, revision: 1 }]);
  await new Promise((resolve) => setImmediate(resolve));
  await reportPageIndex(env, { metadata: metadata(3, "editor"), title: "Plan", observedAt: at(2) });
  release();
  await prune;
  assert.deepEqual(
    db.rows("SELECT role, updated_revision FROM pages_catalog_access WHERE principal = ?", member),
    [{ role: "editor", updated_revision: 3 }],
  );
  await pruneIndexRows(db, [{ page_id: id(1), principal: member, revision: 3 }]);
  assert.equal(
    db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", member)[0].n,
    0,
  );
});

test("a revoked principal cannot probe titles set after revocation", async (t) => {
  const f = await catalogFixture(t);
  const viewer = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  const pages = Array.from({ length: 18 }, (_, n) =>
    f.addPage(id(n + 1), `Alpha ${n + 1}`, viewer),
  );
  for (const page of pages) page.cacheTitle();
  await f.settle();
  await f.list(owner);
  assert.equal((await f.list(member)).body.pages.length, 18);
  // Let the member's first pass finish so the probes below only scan.
  for (let request = 0; request < 4; request++) await f.list(member, { limit: 1 });
  assert.equal(await f.catalog(member).ctx.storage.get("host/index/sync"), undefined);
  assert.equal(await f.catalog(member).ctx.storage.get("host/index/dirty"), undefined);
  // Revoke every grant while D1 is down: all 18 member rows stay behind.
  shortBounds(t, { read: 30, write: 30 });
  f.db.mode = "hang";
  for (const page of pages)
    await page.installAccess({
      ...page.metadata,
      acl: { revision: 2, members: { [member]: { role: "none", generation: 2 } } },
    });
  await f.settle();
  f.db.mode = "ok";
  Object.assign(catalogIndexTimeouts, { read: 2500, write: 1500 });
  // Rename every Page through the owner's Catalog, which rewrites the shared
  // Page rows without touching the revoked member's rows.
  const storage = f.catalog(owner).ctx.storage;
  for (let n = 1; n <= 18; n++)
    await storage.put(`page/${id(n)}`, {
      ...(await storage.get(`page/${id(n)}`)),
      title: `Zebra ${n}`,
      updated_at: "2099-01-01T00:00:00.000Z",
    });
  await storage.put("host/index/dirty", "renamed");
  await f.list(owner);
  assert.equal(
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_pages WHERE title LIKE 'Zebra%'")[0].n,
    18,
  );
  assert.equal(
    f.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", member)[0].n,
    18,
  );
  const shape = (result) => ({
    status: result.status,
    pages: result.body.pages,
    more: result.body.next_cursor !== null,
  });
  for (const args of [{ query: "zebra", limit: 1 }, { query: "zebra 7" }]) {
    const revoked = shape(await f.list(member, args));
    const nonexistent = shape(await f.list(stranger, args));
    assert.deepEqual(revoked, nonexistent, JSON.stringify(args));
    assert.deepEqual(revoked, { status: 200, pages: [], more: false });
  }
});

test("reconcile checks its deadline before each step and stops at an exact position", async (t) => {
  const f = await catalogFixture(t);
  shortBounds(t, { reconcile: 50, verify: 500 });
  const memberStorage = f.catalog(member).ctx.storage;
  const viewer = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  for (let n = 1; n <= 16; n++) {
    const page = f.addPage(id(n), `Slow ${n}`, viewer);
    const run = page.fetch;
    page.fetch = async (request) => {
      await new Promise((resolve) => setTimeout(resolve, 150));
      return run(request);
    };
    await memberStorage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title: `Slow ${n}`,
      created_at: at(n),
      updated_at: at(n),
    });
  }
  const started = Date.now();
  const result = await f.list(member, { limit: 1 });
  const elapsed = Date.now() - started;
  assert.equal(result.source, "catalog");
  // One step of four concurrent checks, then the deadline stops the pass.
  assert.deepEqual(await memberStorage.get("host/index/sync"), {
    epoch: "1",
    phase: "shared",
    after: `shared/${id(4)}`,
    incomplete: false,
    dirty: null,
  });
  assert.ok(elapsed < 1000, `listing took ${elapsed} ms`);
});

test("shared title repair uses the Page host's observation time", async (t) => {
  const f = await catalogFixture(t);
  const viewer = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  const memberStorage = f.catalog(member).ctx.storage;
  f.addPage(id(70), "Alpha", viewer).cacheTitle();
  await f.settle();
  await f.list(member);
  const discovered = await memberStorage.get(`shared/${id(70)}`);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
  // A later title reaches D1 while the member's discovery entry misses it.
  await tick();
  f.addPage(id(70), "Beta", viewer).cacheTitle();
  await f.settle();
  await memberStorage.put(`shared/${id(70)}`, discovered);
  // Index off: the title changes again.
  await tick();
  delete f.env.PAGES_CATALOG_INDEX;
  f.addPage(id(70), "Gamma", viewer).cacheTitle();
  await f.settle();
  await memberStorage.put(`shared/${id(70)}`, discovered);
  // Re-enabled after a restart: the reconcile pass is the Page's first use.
  await tick();
  f.env.PAGES_CATALOG_INDEX = "2";
  const restarted = f.addPage(id(70), "Gamma", viewer);
  // Keep the host's own report out of this check: the pass must repair alone.
  restarted.reportIndex = async () => {
    throw Error("report unavailable");
  };
  const found = await f.list(member, { query: "gamma" });
  assert.equal(found.source, "index");
  assert.deepEqual(
    found.body.pages.map((page) => page.title),
    ["Gamma"],
  );
  assert.ok(restarted.titleObservedAt, "the check ran this Page's first-use report");
  await f.settle();
  assert.equal(
    f.db.rows("SELECT title FROM pages_catalog_access WHERE principal = ?", member)[0].title,
    "Gamma",
  );
});
