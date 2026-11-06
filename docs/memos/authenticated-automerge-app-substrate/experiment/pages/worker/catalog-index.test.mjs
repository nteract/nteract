import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { catalogTitle, projectLifecycle } from "./catalog.mjs";
import {
  CATALOG_MIGRATIONS,
  CURSOR_MAX_LENGTH,
  catalogIndexBounds,
  catalogSource,
  catalogIndexTimeouts,
  compareText,
  listScope,
  listingQuery,
  listingRestricted,
  migrateCatalogIndex,
  openCursor,
  openPosition,
  parseListArguments,
  positionOf,
  pruneIndexRows,
  queryCatalogIndex,
  reconcileAccountIndex,
  reportContentActivity,
  reportPageIndex,
  restrictPageIndex,
  retirePageIndex,
  sealCursor,
  sealPosition,
  titleKey,
  titleMatches,
} from "./catalog-index.mjs";
import { plainStub } from "./plain-stub.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
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
/** Object state for direct index calls; the test awaits each one. */
const testCtx = {};

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
    reportPageIndex(env, testCtx, {
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
    after = positionOf("activity", rows.at(-1));
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

test("cursors from every keyring key open and new cursors use the active key", async () => {
  const k1 = "s".repeat(32),
    k2 = "u".repeat(40);
  const legacy = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: k1 };
  const keyring = (active, keys) => ({
    NOTEBOOK_CLOUD_APP_SESSION_KEYS: JSON.stringify({ active, keys }),
  });
  const rotated = keyring("k2", { k1, k2 });
  const retired = keyring("k2", { k2 });
  const context = { principal: owner, needle: "", inTrash: false };
  const position = { updated_at: at(5), page_id: id(42) };
  const before = await sealCursor(legacy, context, position);
  const after = await sealCursor(rotated, context, position);
  assert.deepEqual(await openCursor(rotated, context, before), position);
  assert.deepEqual(await openCursor(rotated, context, after), position);
  assert.deepEqual(await openCursor(retired, context, after), position);
  const rejects = (promise) => assert.rejects(promise, { status: 400, code: "invalid_cursor" });
  await rejects(openCursor(legacy, context, after));
  await rejects(openCursor(retired, context, before));
  await rejects(openCursor(rotated, { ...context, principal: member }, before));
  const malformed = keyring("k3", { k1 });
  await assert.rejects(openCursor(malformed, context, before), /active must name a kid/);
  await assert.rejects(sealCursor(malformed, context, position), /active must name a kid/);
});

test("a delayed trash retirement cannot undo a restore or a later regrant", async (t) => {
  const { db, env } = await seededIndex(t);
  const viewer = { [member]: { role: "viewer", generation: 1 } };
  const metadata = (lifecycleRevision, revision, members, trashed = false) => ({
    pageId: id(1),
    owner,
    deleted: trashed,
    lifecycleRevision,
    acl: { revision, members },
    ...(trashed && { trash: { trashed_at: at(2) } }),
  });
  const rows = () =>
    db.rows(
      "SELECT principal, role FROM pages_catalog_access WHERE page_id = ? ORDER BY principal",
      id(1),
    );
  const state = () =>
    db.rows("SELECT state, lifecycle_revision FROM pages_catalog_pages WHERE page_id = ?", id(1));
  await reportPageIndex(env, testCtx, {
    metadata: metadata(0, 1, viewer),
    title: "Plan",
    observedAt: at(1),
  });
  const trashed = metadata(1, 1, viewer, true);
  // Trash's index writes outlive their timeout; the Page is restored first.
  const restored = metadata(2, 1, viewer);
  await reportPageIndex(env, testCtx, { metadata: restored, title: "Plan", observedAt: at(3) });
  await restrictPageIndex(env, testCtx, trashed);
  await retirePageIndex(env, testCtx, trashed, at(4));
  assert.deepEqual(state(), [{ state: "active", lifecycle_revision: 2 }]);
  assert.deepEqual(
    rows().map((row) => row.principal),
    [member, owner].sort(),
  );
  // A regrant after restore survives the same delayed writes.
  const regranted = metadata(2, 2, { [member]: { role: "editor", generation: 1 } });
  await reportPageIndex(env, testCtx, { metadata: regranted, title: "Plan", observedAt: at(5) });
  await retirePageIndex(env, testCtx, trashed, at(6));
  await restrictPageIndex(env, testCtx, trashed);
  assert.deepEqual(state(), [{ state: "active", lifecycle_revision: 2 }]);
  assert.equal(rows().find((row) => row.principal === member).role, "editor");
  // A report from before Trash cannot reactivate a trashed row or re-add members.
  const again = metadata(3, 2, { [member]: { role: "editor", generation: 1 } }, true);
  await restrictPageIndex(env, testCtx, again);
  await retirePageIndex(env, testCtx, again, at(7));
  await reportPageIndex(env, testCtx, { metadata: regranted, title: "Plan", observedAt: at(8) });
  assert.deepEqual(state(), [{ state: "trashed", lifecycle_revision: 3 }]);
  assert.deepEqual(
    rows().map((row) => row.principal),
    [owner],
  );
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
  await reportPageIndex(env, testCtx, { metadata: granted, title: "Before", observedAt: at(1) });
  let release;
  db.holdNext = new Promise((resolve) => {
    release = resolve;
  });
  // A report that outlived its caller's timeout is still in flight.
  const delayed = reportPageIndex(env, testCtx, {
    metadata: granted,
    title: "Old",
    observedAt: at(2),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await restrictPageIndex(env, testCtx, removed);
  await reportPageIndex(env, testCtx, { metadata: removed, title: "New", observedAt: at(3) });
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
  await reportPageIndex(env, testCtx, {
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
  await restrictPageIndex(env, testCtx, cleared);
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
  await restrictPageIndex(env, testCtx, removed);
  assert.deepEqual(rows(), [`owner:${owner}`]);

  // Before durability, deletion only drops rows; the Page can still come back.
  const deleted = { ...metadata, deleted: true };
  await restrictPageIndex(env, testCtx, deleted);
  assert.deepEqual(rows(), [`owner:${owner}`]);
  assert.equal(db.rows("SELECT state FROM pages_catalog_pages")[0].state, "active");
  await retirePageIndex(env, testCtx, deleted);
  assert.deepEqual(rows(), []);
  await reportPageIndex(env, testCtx, { metadata, title: "Late title", observedAt: at(9) });
  assert.deepEqual(rows(), []);
  assert.deepEqual(db.rows("SELECT state, title FROM pages_catalog_pages"), [
    { state: "deleted", title: "" },
  ]);
});

/** The access and sort combinations a denial must look the same under. */
const LISTING_VARIANTS = [
  {},
  { access: "shared" },
  { sort: "title" },
  { access: "shared", sort: "title" },
];

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
  const addPage = (
    pageId,
    title,
    acl = { revision: 0, members: {} },
    { storage = new Storage() } = {},
  ) => {
    const doc = A.from({ page_id: pageId, title, schema: { features: ["comments-doc"] } });
    const page = Object.assign(Object.create(Page.prototype), {
      env,
      ready: Promise.resolve(),
      tail: Promise.resolve(),
      ctx: { storage, waitUntil: (promise) => jobs.push(promise) },
      metadata: { pageId, owner, deleted: false, documentId: "doc", acl },
      handle: { doc: () => doc, broadcast() {} },
      wires: new Set(),
      repo: { delete: async () => {} },
      get plain() {
        return plainStub(this.repo);
      },
      calls: 0,
    });
    page.policy = new DocumentPolicy({
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
  const nulls = await f.list(owner, { access: null, sort: null });
  assert.equal(nulls.body.limit, 100, "null access and sort leave the call bare");
  assert.equal(nulls.body.pages.length, 60);
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
  const cases = [{ limit: 2 }, { query: "secret" }, { query: "visible", limit: 2 }].flatMap(
    (base) => LISTING_VARIANTS.map((variant) => ({ ...base, ...variant })),
  );
  for (const args of cases) {
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
  // Flip one bit of the sealed bytes. Editing the text can leave the bytes
  // unchanged: base64 decoding ignores the last character's unused bits.
  const [prefix, sealed] = [
    next_cursor.slice(0, 3),
    Buffer.from(next_cursor.slice(3), "base64url"),
  ];
  sealed[sealed.length - 1] ^= 1;
  const tampered = prefix + sealed.toString("base64url");
  assert.notEqual(tampered, next_cursor);
  for (const [principal, args] of [
    [member, { limit: 1, cursor: next_cursor }],
    [owner, { limit: 1, query: "owned", cursor: next_cursor }],
    [owner, { limit: 1, in_trash: true, cursor: next_cursor }],
    [owner, { limit: 1, cursor: tampered }],
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
  // Every row carries content_updated_at, null until its Page reports one.
  assert.deepEqual(result.body.pages, [
    { page_id: id(1), title: "Legacy", content_updated_at: null },
  ]);
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

test("a crash between trash barriers leaves the Page indexable; trash and purge retire it", async (t) => {
  const f = await catalogFixture(t);
  const acl = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  const page = f.addPage(id(60), "Team plan", acl);
  page.cacheTitle();
  await f.settle();
  const trash = (target) =>
    target.fetch(
      f.request(owner, "/internal/trash", {
        page_id: id(60),
        base_heads: A.getHeads(target.handle.doc()),
        idempotency_key: "trash-index-fixture",
      }),
    );
  const put = page.ctx.storage.put.bind(page.ctx.storage);
  page.ctx.storage.put = async (key, value) => {
    if (typeof key === "object" && "host/document" in key)
      throw Error("crash before the trash record is durable");
    return put(key, value);
  };
  assert.equal((await trash(page)).status, 500);
  // The member row was restricted before commit; the owner row stays active.
  assert.deepEqual(f.db.rows("SELECT state, title FROM pages_catalog_pages"), [
    { state: "active", title: "Team plan" },
  ]);
  // Restart: the durable record never saw Trash, and the Page reports again.
  const restarted = f.addPage(id(60), "Team plan", acl);
  restarted.cacheTitle();
  await f.settle();
  assert.deepEqual(
    (await f.list(member)).body.pages.map((entry) => entry.page_id),
    [id(60)],
  );
  assert.equal((await trash(restarted)).status, 200);
  assert.deepEqual(f.db.rows("SELECT state FROM pages_catalog_pages"), [{ state: "trashed" }]);
  assert.deepEqual(f.db.rows("SELECT source FROM pages_catalog_access"), [{ source: "owner" }]);
  const preview = await (
    await restarted.fetch(
      f.request(owner, "/internal/purge", { page_id: id(60), action: "preview" }),
    )
  ).json();
  const purged = await restarted.fetch(
    f.request(owner, "/internal/purge", {
      page_id: id(60),
      action: "confirm",
      preview_token: preview.preview_token,
      idempotency_key: "purge-index-fixture",
    }),
  );
  assert.equal(purged.status, 200);
  assert.deepEqual(f.db.rows("SELECT state, title FROM pages_catalog_pages"), [
    { state: "deleted", title: "" },
  ]);
  assert.equal(f.db.rows("SELECT count(*) AS n FROM pages_catalog_access")[0].n, 0);
});

test("a D1-only title failure repairs once on the next request without repeating Catalog delivery", async (t) => {
  const f = await catalogFixture(t);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const page = f.addPage(id(84), "Plan", {
    revision: 1,
    members: { [member]: { role: "viewer", generation: 1 } },
  });
  const sent = [];
  // Isolate the Page's D1 report from the Catalogs' own index writes.
  page.env = {
    ...f.env,
    CATALOGS: {
      getByName: (principal) => ({
        fetch: async (request) => {
          sent.push({ principal, body: await request.json() });
          return new Response(null);
        },
      }),
    },
  };
  const reports = [];
  const report = page.reportIndex.bind(page);
  page.reportIndex = (details) => {
    reports.push(details);
    return report(details);
  };
  f.db.mode = "fail";
  page.cacheTitle();
  await f.settle();
  assert.equal(sent.length, 2);
  assert.equal(reports.length, 1);
  assert.equal(await page.ctx.storage.get("host/index/report-pending"), true);
  assert.equal(await page.ctx.storage.get("host/title-projection/pending"), undefined);
  f.db.mode = "ok";
  t.mock.timers.tick(60_000);
  const response = await page.fetch(f.request(member, "/internal/catalog", {}));
  assert.equal(response.status, 200);
  await f.settle();
  assert.equal(sent.length, 2, "successful Catalog delivery is not repeated");
  assert.equal(reports.length, 2, "only the existing D1 repair path reports again");
  assert.equal(reports[1].observedAt, reports[0].observedAt);
  assert.equal(await page.ctx.storage.get("host/index/report-pending"), undefined);
});

test("a restarted Page host with an unchanged title moves no updated_at and reorders nothing", async (t) => {
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const mode = index ? "index" : "catalog";
      const f = await catalogFixture(t, { index });
      const later = () => new Promise((resolve) => setTimeout(resolve, 5));
      const acl = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
      // Neither Page has a content time, so activity sorts by updated_at.
      const older = f.addPage(id(81), "Older plan", acl);
      older.cacheTitle();
      await f.settle();
      await later();
      f.addPage(id(82), "Newer plan").cacheTitle();
      await f.settle();
      const listed = async (principal = owner) => {
        for (let request = 0; request < 6; request++) {
          const result = await f.list(principal, { sort: "activity" });
          if (result.source === mode) return result.body.pages.map((page) => page.page_id);
        }
        throw Error("the listing never reached its source");
      };
      assert.deepEqual(await listed(), [82, 81].map(id));
      const ownerStorage = f.catalog(owner).ctx.storage;
      const memberStorage = f.catalog(member).ctx.storage;
      const times = async () => ({
        owner: (await ownerStorage.get(`page/${id(81)}`)).updated_at,
        member: (await memberStorage.get(`shared/${id(81)}`)).updated_at,
        d1: index
          ? f.db.rows(
              `SELECT a.principal, a.updated_at AS access, p.updated_at AS page
              FROM pages_catalog_access a JOIN pages_catalog_pages p USING (page_id)
              WHERE page_id = ? ORDER BY a.principal`,
              id(81),
            )
          : [],
      });
      const before = await times();
      assert.ok(before.owner);

      // Restarts, with and without the stored projection a build before it
      // never wrote. Both project to the owner and the member and report the
      // row again, as the first check after a restart does.
      for (const legacy of [false, true]) {
        await later();
        if (legacy) await older.ctx.storage.delete("host/title-projection");
        const restarted = f.addPage(id(81), "Older plan", acl, { storage: older.ctx.storage });
        await restarted.restoreTitleProjection();
        restarted.cacheTitle();
        await f.settle();
        assert.deepEqual(await times(), before, legacy ? "without a record" : "with a record");
        assert.deepEqual(await listed(), [82, 81].map(id));
        if (!index) continue;
        // The member's next reconcile pass checks the Page with its host,
        // which reports the restart's observation time: rows keep theirs.
        await memberStorage.put("host/index/dirty", `restart-${legacy}`);
        for (let request = 0; request < 6; request++) {
          await f.list(member);
          if ((await memberStorage.get("host/index/dirty")) === undefined) break;
        }
        assert.equal(await memberStorage.get("host/index/dirty"), undefined);
        assert.deepEqual(await times(), before, "after the member's reconcile pass");
        assert.deepEqual(await listed(member), [81].map(id));
      }

      // A real title change still moves it.
      await later();
      const renamed = f.addPage(id(81), "Renamed plan", acl, { storage: older.ctx.storage });
      await renamed.restoreTitleProjection();
      renamed.cacheTitle();
      await f.settle();
      const after = await times();
      assert.ok(after.owner > before.owner);
      assert.ok(after.member > before.member);
      for (const [n, row] of after.d1.entries()) {
        assert.ok(row.access > before.d1[n].access);
        assert.ok(row.page > before.d1[n].page);
      }
      assert.deepEqual(await listed(), [81, 82].map(id));
    });
  }
});

test("a member's reconcile pass keeps a row's time only for an unchanged title its host lets writers keep", async (t) => {
  const { db, env } = await seededIndex(t);
  const acl = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  const cases = [
    { title: "Plan", keep: true, moves: false, label: "an unchanged title, keep_time" },
    { title: "Renamed", keep: true, moves: true, label: "a changed title" },
    { title: "Plan", keep: false, moves: true, label: "an observation without keep_time" },
  ];
  for (const [index, { title, keep, moves, label }] of cases.entries()) {
    const pageId = id(90 + index);
    await reportPageIndex(env, testCtx, {
      metadata: { pageId, owner, deleted: false, acl },
      title: "Plan",
      observedAt: at(1),
    });
    const storage = new Storage();
    await storage.put(`shared/${pageId}`, {
      page_id: pageId,
      title: "Plan",
      created_at: at(1),
      updated_at: at(1),
      shared: true,
    });
    assert.equal(
      await reconcileAccountIndex({
        db,
        storage,
        principal: member,
        epoch: "1",
        verify: async () => ({
          status: "ok",
          page: {
            page_id: pageId,
            title,
            owner,
            role: "viewer",
            source: "member",
            revision: 1,
            lifecycle_revision: 0,
            state: "active",
            title_observed_at: at(5),
            ...(keep && { title_keep_time: true }),
          },
        }),
      }),
      true,
    );
    const [row] = db.rows(
      `SELECT a.updated_at AS access, a.title, p.updated_at AS page
      FROM pages_catalog_access a JOIN pages_catalog_pages p USING (page_id)
      WHERE a.page_id = ? AND a.principal = ?`,
      pageId,
      member,
    );
    const expected = moves ? at(5) : at(1);
    assert.deepEqual(row, { access: expected, title, page: expected }, label);
    await db.prepare("DELETE FROM pages_catalog_accounts").run();
  }
});

test("an ACL commit and a restore move updated_at, including through a retried projection or a repaired report", async (t) => {
  const later = () => new Promise((resolve) => setTimeout(resolve, 5));
  for (const operation of ["acl", "restore"])
    for (const failing of ["catalog", "d1"])
      await t.test(`${operation}, ${failing} write fails first`, async (t) => {
        const f = await catalogFixture(t);
        const acl = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
        const page = f.addPage(id(83), "Plan", acl);
        const ownerStorage = f.catalog(owner).ctx.storage;
        await ownerStorage.put(`page/${id(83)}`, {
          page_id: id(83),
          title: "Plan",
          created_at: at(0),
          updated_at: at(1),
        });
        page.cacheTitle();
        await f.settle();
        const call = async (name, args) =>
          (
            await f
              .catalog(owner)
              .fetch(f.request(owner, "/internal/catalog", { operation: name, arguments: args }))
          ).json();
        if (operation === "restore") {
          const trashed = await call("delete_page", {
            page_id: id(83),
            base_heads: A.getHeads(page.handle.doc()),
            idempotency_key: "observe-trash",
          });
          assert.equal(trashed.state, "trashed", JSON.stringify(trashed));
          await f.settle();
        }
        const memberStorage = f.catalog(member).ctx.storage;
        const times = async () => ({
          member: (await memberStorage.get(`shared/${id(83)}`))?.updated_at,
          d1: f.db.rows(
            `SELECT a.principal, a.updated_at AS access, p.updated_at AS page
            FROM pages_catalog_access a JOIN pages_catalog_pages p USING (page_id)
            WHERE a.source = 'owner'`,
          )[0],
        });
        const before = await times();
        assert.ok(before.member, "the member's entry holds the same title");
        await later();

        // The first write of the observation fails.
        const memberCatalog = f.catalog(member);
        const fetch = memberCatalog.fetch.bind(memberCatalog);
        if (failing === "catalog")
          memberCatalog.fetch = async (request) => {
            if (new URL(request.url).pathname !== "/internal/projection") return fetch(request);
            memberCatalog.fetch = fetch;
            return Response.json({ error: "busy" }, { status: 503 });
          };
        else f.db.mode = "fail";
        if (operation === "acl")
          await page.installAccess({
            ...page.metadata,
            acl: { revision: 2, members: { [member]: { role: "editor", generation: 2 } } },
          });
        else {
          const restored = await call("restore_page", {
            page_id: id(83),
            idempotency_key: "observe-restore",
          });
          assert.equal(restored.restored, true, JSON.stringify(restored));
        }
        await f.settle();
        f.db.mode = "ok";
        const record = await page.ctx.storage.get("host/title-projection");
        assert.equal(record.keep, false, "an observation lets no writer keep its time");
        assert.deepEqual(page.titleProjection.record, record);

        // The next request retries the projection, or repairs the report.
        if (failing === "catalog") {
          assert.equal(
            page.titleProjection.delivery.name,
            "needed",
            "the failed projection is retried",
          );
          page.cacheTitle();
        } else {
          assert.equal(await page.ctx.storage.get("host/index/report-pending"), true);
          await page.repairIndex();
        }
        await f.settle();
        const after = await times();
        assert.equal(after.member, record.observed_at);
        // A restore's owner row is the owner Catalog's own projection, which
        // follows the host's observation, so both sources hold one time.
        // When D1 refused that write, the Page's mark stays, and the row
        // holds the host's repaired report until a listing settles the mark.
        const ownerTime =
          operation === "restore" && failing === "catalog"
            ? (await ownerStorage.get(`page/${id(83)}`)).updated_at
            : record.observed_at;
        if (operation === "restore" && failing === "d1")
          assert.equal(
            (await ownerStorage.list({ prefix: "host/index/page/" })).size,
            1,
            "the restore's mark stays",
          );
        assert.ok(ownerTime >= record.observed_at);
        assert.equal(after.d1.access, ownerTime);
        assert.equal(after.d1.page, ownerTime);
        assert.ok(after.member > before.member);
        assert.ok(after.d1.access > before.d1.access);

        // A restart repeats the observation's stored time, and moves nothing.
        await later();
        const restarted = f.addPage(id(83), "Plan", page.metadata.acl, {
          storage: page.ctx.storage,
        });
        restarted.metadata = page.metadata;
        await restarted.restoreTitleProjection();
        restarted.cacheTitle();
        await f.settle();
        assert.deepEqual(await times(), after);
      });
});

test("Trash and restore through the Catalog move a Page between indexed listings", async (t) => {
  const f = await catalogFixture(t);
  const acl = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  const page = f.addPage(id(70), "Quarterly plan", acl);
  await f.catalog(owner).ctx.storage.put(`page/${id(70)}`, {
    page_id: id(70),
    title: "Quarterly plan",
    created_at: at(0),
    updated_at: at(1),
  });
  page.cacheTitle();
  await f.settle();
  const call = async (operation, args) =>
    (
      await f
        .catalog(owner)
        .fetch(f.request(owner, "/internal/catalog", { operation, arguments: args }))
    ).json();
  const ids = async (principal, args) =>
    (await f.list(principal, args)).body.pages.map((entry) => entry.page_id);
  // Settle the account's first reconcile so listings read D1.
  for (let pass = 0; pass < 3; pass++) await f.list(owner);
  const trashed = await call("delete_page", {
    page_id: id(70),
    base_heads: A.getHeads(page.handle.doc()),
    idempotency_key: "index-trash-request",
  });
  assert.equal(trashed.state, "trashed");
  assert.deepEqual(f.db.rows("SELECT state FROM pages_catalog_pages"), [{ state: "trashed" }]);
  assert.deepEqual(await ids(owner), []);
  assert.deepEqual(await ids(owner, { in_trash: true }), [id(70)]);
  assert.deepEqual(await ids(member), []);
  const listed = await f.list(owner, { in_trash: true });
  assert.equal(listed.body.pages[0].state, "trashed");
  assert.equal(listed.body.pages[0].trashed_by, owner);
  const restored = await call("restore_page", {
    page_id: id(70),
    idempotency_key: "index-restore-request",
  });
  assert.equal(restored.restored, true);
  await f.settle();
  assert.deepEqual(await ids(owner), [id(70)]);
  assert.deepEqual(await ids(owner, { in_trash: true }), []);
  assert.deepEqual(await ids(member), [id(70)]);
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
    reportPageIndex(f.env, testCtx, {
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
  await reportPageIndex(env, testCtx, {
    metadata: metadata(1, "viewer"),
    title: "Plan",
    observedAt: at(1),
  });
  let release;
  db.holdNext = new Promise((resolve) => {
    release = resolve;
  });
  // A listing saw the row at revision 1 and its Page host denied it.
  const prune = pruneIndexRows(db, [{ page_id: id(1), principal: member, revision: 1 }]);
  await new Promise((resolve) => setImmediate(resolve));
  await reportPageIndex(env, testCtx, {
    metadata: metadata(3, "editor"),
    title: "Plan",
    observedAt: at(2),
  });
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
  const cases = [{ query: "zebra", limit: 1 }, { query: "zebra 7" }].flatMap((base) =>
    LISTING_VARIANTS.map((variant) => ({ ...base, ...variant })),
  );
  for (const args of cases) {
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
  let checksStarted = 0;
  for (let n = 1; n <= 16; n++) {
    const page = f.addPage(id(n), `Slow ${n}`, viewer);
    const run = page.fetch;
    page.fetch = async (request) => {
      checksStarted++;
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
  // The bound is one step: no Page check starts after the deadline. The
  // listing's own verification adds at most one page and one look-ahead.
  assert.ok(checksStarted <= 4 + 2, `Page checks started: ${checksStarted}`);
  // Wall time is one step of slow checks; the slack absorbs slow runners.
  assert.ok(elapsed < 3000, `listing took ${elapsed} ms`);
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
  assert.ok(
    restarted.titleProjection?.record?.observed_at,
    "the check ran this Page's first-use report",
  );
  await f.settle();
  assert.equal(
    f.db.rows("SELECT title FROM pages_catalog_access WHERE principal = ?", member)[0].title,
    "Gamma",
  );
});

test("a slow D1 cannot stretch reconcile past its deadline plus one call", async (t) => {
  const db = sqliteD1(t).open();
  await migrateCatalogIndex(db);
  const storage = new Storage();
  await ownEntries(storage, 100);
  shortBounds(t, { reconcile: 300 });
  db.delay = 150;
  const reconcile = () =>
    reconcileAccountIndex({
      db,
      storage,
      principal: owner,
      epoch: "1",
      verify: async () => ({ status: "unavailable" }),
    });
  const ownerRows = () =>
    db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", owner)[0].n;
  db.callStarts.length = 0;
  const started = Date.now();
  assert.equal(await reconcile(), false);
  const elapsed = Date.now() - started;
  // The bound is "no D1 call starts after the deadline": at most one call is
  // in flight when it passes. Small slack covers the deadline check itself.
  const late = db.callStarts.filter((at) => at > started + 300 + 25);
  assert.deepEqual(late, [], `D1 calls started after the deadline: ${late.length}`);
  // Wall time is deadline plus that one call; the slack absorbs slow runners.
  assert.ok(elapsed < 300 + 150 + 400, `reconcile took ${elapsed} ms`);
  // Progress stops at the last committed unit: every committed entry is in D1
  // and nothing after the saved position is.
  const pass = await storage.get("host/index/sync");
  assert.equal(pass.phase, "owned");
  const committed = Number(pass.after.slice("page/".length, "page/".length + 8));
  assert.ok(committed > 0 && committed % 24 === 0, pass.after);
  assert.equal(ownerRows(), committed);
  db.delay = 0;
  let done = false;
  for (let request = 0; request < 10 && !done; request++) done = await reconcile();
  assert.equal(done, true);
  assert.equal(ownerRows(), 100);
});

const PROJECT = `prj_${id(7)}`;

test("access and sort are validated, and shared refuses Trash and Projects", () => {
  const fails = (args, pattern) =>
    assert.throws(() => parseListArguments(args), {
      status: 400,
      code: "invalid_list_arguments",
      message: pattern,
    });
  const defaults = parseListArguments({});
  assert.equal(defaults.access, null);
  assert.equal(defaults.sort, "activity");
  assert.equal(parseListArguments({ access: "owned" }).limit, 50, "access is a new argument");
  assert.equal(parseListArguments({ sort: "title" }).limit, 50, "sort is a new argument");
  // null is omitted, including for the bare call's page size.
  for (const args of [{ access: null }, { sort: null }, { access: null, sort: null }])
    assert.deepEqual(parseListArguments(args), defaults, JSON.stringify(args));
  assert.equal(parseListArguments({ access: null, query: "x" }).limit, 50);
  for (const access of ["all", "OWNED", "", 1, true]) fails({ access }, /access must be/);
  for (const sort of ["updated", "TITLE", "CREATED", "", 0, "__proto__"])
    fails({ sort }, /sort must be/);
  assert.equal(parseListArguments({ sort: "created" }).sort, "created");
  fails({ access: "shared", in_trash: true }, /Trash lists only Pages you own/);
  fails({ access: "shared", space_id: PROJECT }, /project_id does not combine/);
  assert.equal(parseListArguments({ access: "owned", in_trash: true }).inTrash, true);
  assert.equal(parseListArguments({ access: "owned", space_id: PROJECT }).spaceId, PROJECT);
  assert.equal(parseListArguments({ access: "shared", parent_id: id(1) }).parentId, id(1));
  assert.equal(parseListArguments({ access: "shared", in_trash: false }).access, "shared");
  assert.equal(parseListArguments({ sort: "title", in_trash: true }).sort, "title");
  assert.equal(parseListArguments({ sort: "created", in_trash: true }).sort, "created");
  // In Trash, activity is trashing: the default lists the most recently trashed first.
  for (const args of [
    { in_trash: true },
    { in_trash: true, sort: "activity" },
    { in_trash: true, sort: null },
  ])
    assert.equal(parseListArguments(args).sort, "trashed", JSON.stringify(args));
  assert.equal(parseListArguments({ in_trash: false }).sort, "activity");
  // The trashed order is internal; callers name activity.
  fails({ sort: "trashed" }, /sort must be/);
  fails({ sort: "trashed", in_trash: true }, /sort must be/);
});

test("list scope names every sort, so activity cursors from earlier builds don't open", () => {
  const scope = (args) => listScope(parseListArguments(args));
  // Earlier builds sealed activity cursors with no scope, with a location-only
  // scope, or with [access, "activity"]. Activity positions now hold
  // activity_at, so none of those scopes may come back.
  const earlier = [
    undefined,
    JSON.stringify([PROJECT, null, true, null]),
    JSON.stringify([null, id(1), false, null]),
    JSON.stringify([null, null, true, null, "owned", "activity"]),
    JSON.stringify([null, null, true, null, "shared", "activity"]),
  ];
  for (const args of [
    {},
    { query: "x" },
    { sort: "activity" },
    { access: null, sort: null },
    { space_id: PROJECT },
    { parent_id: id(1) },
    { access: "owned" },
    { access: "shared" },
  ])
    assert.ok(!earlier.includes(scope(args)), JSON.stringify(args));
  assert.equal(scope({}), scope({ sort: "activity" }), "activity is the default");
  assert.equal(scope({}), scope({ access: null, sort: null }));
  // Title positions mean what they did, so title cursors keep their scope.
  assert.equal(scope({ sort: "title" }), JSON.stringify([null, null, true, null, null, "title"]));
  assert.equal(
    scope({ access: "owned", sort: "title" }),
    JSON.stringify([null, null, true, null, "owned", "title"]),
  );
  // Trash's default order has its own name: earlier builds sealed Trash
  // cursors under "content_activity", with activity_at keys.
  assert.equal(
    scope({ in_trash: true }),
    JSON.stringify([null, null, true, null, null, "trashed"]),
  );
  assert.equal(scope({ in_trash: true }), scope({ in_trash: true, sort: "activity" }));
  assert.equal(
    scope({ in_trash: true, access: "owned" }),
    JSON.stringify([null, null, true, null, "owned", "trashed"]),
  );
  // Created and title positions mean in Trash what they did.
  assert.equal(scope({ in_trash: true, sort: "title" }), scope({ sort: "title" }));
  assert.equal(scope({ in_trash: true, sort: "created" }), scope({ sort: "created" }));
  const variants = [
    {},
    { access: "owned" },
    { access: "shared" },
    { sort: "title" },
    { sort: "created" },
    { access: "owned", sort: "title" },
    { access: "shared", sort: "title" },
    { access: "owned", sort: "created" },
    { access: "shared", sort: "created" },
    { parent_id: id(1) },
    { parent_id: id(1), access: "shared" },
    { parent_id: id(1), sort: "title" },
    { parent_id: id(1), sort: "created" },
    { space_id: PROJECT },
    { space_id: PROJECT, sort: "created" },
  ].map(scope);
  assert.equal(new Set(variants).size, variants.length, "every combination has its own scope");
});

test("title cursors carry their key, fit the length bound and open only under their scope", async () => {
  const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: "s".repeat(32) };
  const context = (args) => ({
    principal: owner,
    needle: null,
    inTrash: false,
    scope: listScope(parseListArguments(args)),
  });
  const rejects = (promise) => assert.rejects(promise, { status: 400, code: "invalid_cursor" });
  const titled = { updated_at: at(1), page_id: id(1), title_search: "alpha" };
  const cursor = await sealCursor(env, context({ sort: "title" }), titled);
  assert.deepEqual(await openCursor(env, context({ sort: "title" }), cursor), titled);
  assert.ok(!Buffer.from(cursor.slice(3), "base64url").toString("latin1").includes("alpha"));
  for (const args of [
    {},
    { sort: "activity" },
    { sort: "created" },
    { access: "owned", sort: "title" },
  ])
    await rejects(openCursor(env, context(args), cursor));
  // Activity and created positions keep the three-element payload.
  const plain = await sealCursor(env, context({}), { updated_at: at(1), page_id: id(1) });
  assert.deepEqual(await openCursor(env, context({ sort: "activity" }), plain), {
    updated_at: at(1),
    page_id: id(1),
  });
  for (const args of [
    { access: "owned" },
    { access: "shared" },
    { sort: "title" },
    { sort: "created" },
  ])
    await rejects(openCursor(env, context(args), plain));
  // The longest title keys: 500 code units, escaped or multi-byte.
  for (const title of ["\u0001".repeat(500), "語".repeat(500), "😀".repeat(250), "İ".repeat(500)]) {
    const long = await sealCursor(env, context({ sort: "title" }), {
      updated_at: at(1),
      page_id: id(1),
      title_search: titleKey(title),
    });
    assert.ok(long.length <= CURSOR_MAX_LENGTH, `${long.length} characters`);
    assert.equal(
      (await openCursor(env, context({ sort: "title" }), long)).title_search,
      titleKey(title),
    );
    assert.equal(parseListArguments({ cursor: long }).cursor, long);
  }
  assert.throws(() => parseListArguments({ cursor: `c2_${"a".repeat(CURSOR_MAX_LENGTH)}` }), {
    code: "invalid_cursor",
  });
  await rejects(openCursor(env, context({}), `c2_${"a".repeat(CURSOR_MAX_LENGTH)}`));
});

test("title keys read back from D1 exactly as the Catalog fallback computes them", async (t) => {
  const split = `${"a".repeat(499)}😀 tail`;
  assert.equal(catalogTitle(split), "a".repeat(499), "a pair split at the limit is dropped");
  assert.equal(catalogTitle(`${"a".repeat(498)}😀 tail`), `${"a".repeat(498)}😀`);
  assert.equal(catalogTitle("x\uD800y\uDC00"), "x\uFFFDy\uFFFD", "lone halves become U+FFFD");
  assert.equal(catalogTitle("😀".repeat(300)), "😀".repeat(250));
  for (const title of ["x\uD800y\uDC00", split, "😀".repeat(300)])
    assert.equal(catalogTitle(title).isWellFormed(), true, title.slice(0, 4));
  // Every key survives the UTF-8 round trip, so a cursor handed from the
  // fallback to D1 (or back) compares against the same text.
  const { db, page } = await seededIndex(t);
  const titles = [split, "x\uD800y", "\uDC00lead", `${"b".repeat(499)}\uD83D`];
  for (const [index, title] of titles.entries()) await page(index + 1, title, at(index));
  for (const [index, title] of titles.entries()) {
    const [row] = db.rows(
      "SELECT title, title_search FROM pages_catalog_access WHERE page_id = ?",
      id(index + 1),
    );
    assert.equal(row.title, catalogTitle(title), `title ${index}`);
    assert.equal(row.title_search, titleKey(title), `key ${index}`);
  }
  const storage = new Storage();
  for (const [index, title] of titles.entries())
    await storage.put(`page/${id(index + 1)}`, {
      page_id: id(index + 1),
      title,
      created_at: at(0),
      updated_at: at(index),
    });
  const fallback = await (
    await catalogSource(storage, { inTrash: false, sort: "title" })
  ).next(null, 10);
  const indexed = await queryCatalogIndex(db, {
    principal: owner,
    inTrash: false,
    needle: null,
    after: null,
    count: 10,
    sort: "title",
  });
  assert.deepEqual(
    fallback.map((row) => [row.page_id, row.title_search]),
    indexed.map((row) => [row.page_id, row.title_search]),
  );
});

test("compareText orders strings as SQLite compares their UTF-8 bytes", () => {
  const samples = ["", "a", "A", "ab", "b", "é", "z", "～", "😀", "\uffff", "\ue000", "a😀", "a～"];
  const bytes = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
  for (const a of samples)
    for (const b of samples) assert.equal(compareText(a, b), bytes(a, b), `${a} vs ${b}`);
  assert.ok("😀" < "～", "plain < disagrees with UTF-8 order");
  assert.equal(compareText("😀", "～"), 1);
});

test("title order pages by title key and Page ID across ties, empty titles and search", async (t) => {
  const { page, query } = await seededIndex(t);
  const titles = ["beta", "Alpha", "alpha", "", "ALPHA beta", "😀 smile", "～ wave", "Éclair", ""];
  for (const [index, title] of titles.entries()) await page(index + 1, title, at(30 - index));
  const expected = titles
    .map((title, index) => ({ page_id: id(index + 1), title_search: titleKey(title) }))
    .sort((a, b) => compareText(a.title_search, b.title_search) || (a.page_id < b.page_id ? -1 : 1))
    .map((row) => row.page_id);
  const all = await query({ sort: "title" });
  assert.deepEqual(
    all.map((row) => row.page_id),
    expected,
  );
  assert.deepEqual(
    all.slice(0, 2).map((row) => row.title_search),
    ["", ""],
    "empty titles first",
  );
  assert.deepEqual(
    all.map((row) => row.title).slice(2, 5),
    ["Alpha", "alpha", "ALPHA beta"],
    "case-insensitive, ties by Page ID",
  );
  // Keyset pages see every row once, including across a tie, while new rows land.
  const seen = [];
  let after = null;
  for (let request = 0; request < 20; request++) {
    const rows = await query({ sort: "title", after, count: 2 });
    seen.push(...rows.map((row) => row.page_id));
    if (request === 1) await page(99, "😀😀 last", at(60));
    if (rows.length < 2) break;
    after = positionOf("title", rows.at(-1));
  }
  assert.deepEqual(seen, [...expected, id(99)]);
  // Search combines with the title order.
  const needle = parseListArguments({ query: "alpha" }).needle;
  const searched = await query({ sort: "title", needle });
  assert.deepEqual(
    searched.map((row) => row.title),
    ["Alpha", "alpha", "ALPHA beta"],
  );
  const second = await query({
    sort: "title",
    needle,
    after: positionOf("title", searched[0]),
    count: 1,
  });
  assert.deepEqual(
    second.map((row) => row.title),
    ["alpha"],
  );
});

test("listing pages seek their index: first pages by principal, later pages by row value", async (t) => {
  const { db } = await seededIndex(t);
  // Row values need SQLite 3.15; D1 and node:sqlite are far newer.
  const [major, minor] = db.rows("SELECT sqlite_version() AS v")[0].v.split(".").map(Number);
  assert.ok(major > 3 || (major === 3 && minor >= 15));
  const positions = {
    title: { title_search: "alpha", page_id: id(5) },
    activity: { key: at(5), page_id: id(5) },
    created: { key: at(5), page_id: id(5) },
  };
  const expected = {
    title: {
      index: "pages_catalog_access_title",
      first: "(principal=?)",
      next: "(principal=? AND (title_search,page_id)>(?,?))",
    },
    activity: {
      index: "pages_catalog_access_activity",
      first: "(principal=?)",
      next: "(principal=? AND (activity_at,page_id)<(?,?))",
    },
    created: {
      index: "pages_catalog_access_created",
      first: "(principal=?)",
      next: "(principal=? AND (created_at,page_id)<(?,?))",
    },
  };
  for (const [sort, { index, first, next }] of Object.entries(expected))
    for (const [after, constraint] of [
      [null, first],
      [positions[sort], next],
    ])
      for (const access of [null, "owned", "shared"]) {
        const { sql, params } = listingQuery({
          principal: owner,
          inTrash: false,
          needle: access ? "al" : null,
          after,
          count: 50,
          sort,
          access,
        });
        const plan = db.rows(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail);
        const label = `${sort} ${after ? "next" : "first"} ${access}:\n${plan.join("\n")}`;
        assert.ok(plan.includes(`SEARCH a USING INDEX ${index} ${constraint}`), label);
        assert.ok(!plan.some((detail) => detail.includes("TEMP B-TREE")), label);
      }
  // Trash's default order walks the owner's trashed Page rows and looks up
  // each one's owner row by primary key.
  for (const [after, constraint] of [
    [null, "(owner=?)"],
    [{ key: at(5), page_id: id(5) }, "(owner=? AND (trash_key,page_id)<(?,?))"],
  ])
    for (const access of [null, "owned"]) {
      const { sql, params } = listingQuery({
        principal: owner,
        inTrash: true,
        needle: access ? "al" : null,
        after,
        count: 50,
        sort: "trashed",
        access,
      });
      const plan = db.rows(`EXPLAIN QUERY PLAN ${sql}`, ...params).map((row) => row.detail);
      const label = `trashed ${after ? "next" : "first"} ${access}:\n${plan.join("\n")}`;
      assert.ok(
        plan.includes(`SEARCH p USING INDEX pages_catalog_pages_trash ${constraint}`),
        label,
      );
      assert.ok(
        plan.includes(
          "SEARCH a USING INDEX sqlite_autoindex_pages_catalog_access_1 (page_id=? AND principal=?)",
        ),
        label,
      );
      assert.ok(!plan.some((detail) => detail.includes("TEMP B-TREE")), label);
    }
  // The trashed order lists only Trash.
  assert.throws(
    () =>
      listingQuery({ principal: owner, inTrash: false, after: null, count: 1, sort: "trashed" }),
    TypeError,
  );
});

test("access filters D1 candidates to owner or non-owner rows", async (t) => {
  const { env, page, query } = await seededIndex(t);
  await page(1, "Mine", at(1));
  await reportPageIndex(env, testCtx, {
    metadata: {
      pageId: id(2),
      owner: member,
      deleted: false,
      acl: { revision: 1, members: { [owner]: { role: "viewer", generation: 1 } } },
    },
    title: "Theirs",
    observedAt: at(2),
  });
  const ids = async (options) => (await query(options)).map((row) => row.page_id);
  assert.deepEqual(await ids({}), [id(2), id(1)]);
  assert.deepEqual(await ids({ access: "owned" }), [id(1)]);
  assert.deepEqual(await ids({ access: "shared" }), [id(2)]);
  assert.deepEqual(await ids({ access: "shared", sort: "title" }), [id(2)]);
  assert.deepEqual(await ids({ access: "owned", inTrash: true }), []);
});

test("the title listing index applies on a fresh database and on top of version 4", async (t) => {
  const indexes = (db) =>
    db
      .rows("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'pages_catalog_%'")
      .map((row) => row.name);
  const latest = CATALOG_MIGRATIONS.at(-1).version;
  const fresh = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(fresh), latest);
  assert.ok(indexes(fresh).includes("pages_catalog_access_title"));

  const upgraded = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(upgraded, CATALOG_MIGRATIONS.slice(0, 4)), 4);
  assert.ok(!indexes(upgraded).includes("pages_catalog_access_title"));
  await reportPageIndex({ DB: upgraded, PAGES_CATALOG_INDEX: "1" }, testCtx, {
    metadata: { pageId: id(1), owner, deleted: false, acl: { revision: 0, members: {} } },
    title: "Kept",
    observedAt: at(1),
  });
  assert.equal(await migrateCatalogIndex(upgraded), latest);
  assert.ok(indexes(upgraded).includes("pages_catalog_access_title"));
  assert.deepEqual(
    (
      await queryCatalogIndex(upgraded, {
        principal: owner,
        inTrash: false,
        needle: null,
        after: null,
        count: 10,
        sort: "title",
      })
    ).map((row) => row.title),
    ["Kept"],
  );
  // A build that knows only migrations 1-4 runs against the newer schema.
  assert.equal(await migrateCatalogIndex(upgraded, CATALOG_MIGRATIONS.slice(0, 4)), latest);
});

/** A member who owns eight Pages and has two shared with them. */
const OWNED_TITLES = [
  [1, "Alpha"],
  [2, "alpha"],
  [3, ""],
  [4, "beta"],
  [5, "Zeta"],
  [6, "Éclair"],
  [7, "～ wave"],
  [8, "😀 smile"],
];
const SHARED_TITLES = [
  [100, "Gamma shared"],
  [101, "alpha shared"],
];
async function accessWorld(t, index) {
  const f = await catalogFixture(t, { index });
  const storage = f.catalog(member).ctx.storage;
  for (const [n, title] of OWNED_TITLES)
    await storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title,
      created_at: at(0),
      updated_at: at(n),
    });
  for (const [n, title] of SHARED_TITLES) {
    f.addPage(id(n), title, {
      revision: 1,
      members: { [member]: { role: "viewer", generation: 1 } },
    });
    await storage.put(`shared/${id(n)}`, {
      page_id: id(n),
      title,
      created_at: at(0),
      updated_at: at(n - 80),
      shared: true,
    });
  }
  // Let the member's first reconcile pass finish, so D1 serves.
  for (let request = 0; request < 8; request++)
    if ((await f.list(member)).source === "index") break;
  const calls = () => [...f.pages.values()].reduce((sum, page) => sum + page.calls, 0);
  const walk = async (args) => {
    const rows = [];
    let cursor;
    for (let request = 0; request < 20; request++) {
      const result = await f.list(member, { limit: 3, ...args, ...(cursor && { cursor }) });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.source, index ? "index" : "catalog");
      rows.push(...result.body.pages);
      cursor = result.body.next_cursor;
      if (!cursor) break;
    }
    return rows;
  };
  return { f, calls, walk };
}

test("access and title sort list the same Pages in the same order from D1 and the Catalog", async (t) => {
  const results = {};
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const { f, calls, walk } = await accessWorld(t, index);
      const ids = (rows) => rows.map((row) => row.page_id);
      const result = {};
      result.title = ids(await walk({ sort: "title" }));
      assert.deepEqual(
        result.title,
        [3, 1, 2, 101, 4, 100, 5, 6, 7, 8].map(id),
        "empty title first, case-insensitive, ties by Page ID, code point order",
      );
      result.ownedTitle = ids(await walk({ access: "owned", sort: "title" }));
      assert.deepEqual(result.ownedTitle, [3, 1, 2, 4, 5, 6, 7, 8].map(id));
      result.sharedTitle = await walk({ access: "shared", sort: "title" });
      assert.deepEqual(ids(result.sharedTitle), [101, 100].map(id));
      for (const row of result.sharedTitle) {
        assert.equal(row.shared, true);
        for (const field of ["project_id", "parent_id", "space_id", "position"])
          assert.equal(Object.hasOwn(row, field), false, field);
      }
      result.searched = ids(await walk({ sort: "title", query: "ALPHA" }));
      assert.deepEqual(result.searched, [1, 2, 101].map(id));
      result.activity = ids(await walk({}));
      result.ownedActivity = ids(await walk({ access: "owned" }));
      assert.deepEqual(result.ownedActivity, [8, 7, 6, 5, 4, 3, 2, 1].map(id));
      result.sharedActivity = ids(await walk({ access: "shared" }));
      assert.deepEqual(result.sharedActivity.sort(), [100, 101].map(id));
      assert.deepEqual(
        [...result.activity].sort(),
        [...result.title].sort(),
        "every sort lists the same Pages",
      );
      // An owned-only listing never asks a Page host about a shared row.
      const before = calls();
      await walk({ access: "owned" });
      await walk({ access: "owned", sort: "title", query: "a" });
      assert.equal(calls() - before, 0);
      results[index ? "index" : "catalog"] = result;
      // Sorting one way doesn't change what owned rows show.
      const row = (await f.list(member, { access: "owned", sort: "title", limit: 1 })).body
        .pages[0];
      assert.deepEqual(row, {
        page_id: id(3),
        title: "",
        created_at: at(0),
        updated_at: at(3),
        content_updated_at: null,
      });
    });
  }
  // Shared rows' activity times come from different observations in each
  // source; every title order and the owned activity order must match.
  const comparable = (result) => ({
    title: result.title,
    ownedTitle: result.ownedTitle,
    sharedTitle: result.sharedTitle.map((row) => row.page_id),
    searched: result.searched,
    ownedActivity: result.ownedActivity,
  });
  assert.deepEqual(comparable(results.index), comparable(results.catalog));
});

test("a cursor opens only under the access and sort it was issued for", async (t) => {
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const { f } = await accessWorld(t, index);
      const cursorOf = async (args) => {
        const result = await f.list(member, { limit: 2, ...args });
        assert.ok(result.body.next_cursor, JSON.stringify(args));
        return result.body.next_cursor;
      };
      const code = async (args) => {
        const result = await f.list(member, { limit: 2, ...args });
        return result.status === 200 ? "ok" : result.body.code;
      };
      const issued = {
        default: await cursorOf({}),
        owned: await cursorOf({ access: "owned" }),
        shared: await cursorOf({ access: "shared", limit: 1 }),
        title: await cursorOf({ sort: "title" }),
        ownedTitle: await cursorOf({ access: "owned", sort: "title" }),
        created: await cursorOf({ sort: "created" }),
      };
      const listings = {
        default: {},
        activity: { sort: "activity" },
        owned: { access: "owned" },
        shared: { access: "shared" },
        title: { sort: "title" },
        ownedTitle: { access: "owned", sort: "title" },
        created: { sort: "created" },
      };
      for (const [from, cursor] of Object.entries(issued))
        for (const [to, args] of Object.entries(listings)) {
          const same = from === to || (from === "default" && to === "activity");
          assert.equal(
            await code({ ...args, cursor }),
            same ? "ok" : "invalid_cursor",
            `${from} cursor under ${to}`,
          );
        }
      // Activity cursors from builds before content activity held
      // updated_at positions. Each scope they were sealed under now fails
      // with invalid_cursor, so a client restarts instead of seeking the
      // activity order with an updated_at key.
      const sealedBefore = async (scope) =>
        sealCursor(
          f.env,
          { principal: member, needle: null, inTrash: false, ...(scope && { scope }) },
          { updated_at: at(4), page_id: id(4) },
        );
      for (const [scope, args] of [
        [undefined, {}],
        [undefined, { sort: "activity" }],
        [JSON.stringify([null, null, true, null, "owned", "activity"]), { access: "owned" }],
        [JSON.stringify([null, null, true, null, "shared", "activity"]), { access: "shared" }],
      ]) {
        const result = await f.list(member, { ...args, cursor: await sealedBefore(scope) });
        assert.equal(result.status, 400, `${scope} under ${JSON.stringify(args)}`);
        assert.equal(result.body.code, "invalid_cursor");
      }
      // A title cursor from before keeps opening: its scope and key are unchanged.
      const titled = await sealCursor(
        f.env,
        {
          principal: member,
          needle: null,
          inTrash: false,
          scope: JSON.stringify([null, null, true, null, null, "title"]),
        },
        { updated_at: at(1), page_id: id(1), title_search: titleKey("Alpha") },
      );
      assert.equal((await f.list(member, { sort: "title", cursor: titled })).status, 200);
      // A title cursor carries its key, so the next page follows the tie.
      const first = await f.list(member, { sort: "title", limit: 2 });
      assert.deepEqual(
        first.body.pages.map((row) => row.page_id),
        [id(3), id(1)],
      );
      const next = await f.list(member, {
        sort: "title",
        limit: 2,
        cursor: first.body.next_cursor,
      });
      assert.deepEqual(
        next.body.pages.map((row) => row.page_id),
        [id(2), id(101)],
      );
    });
  }
});

test("a title cursor from the Catalog fallback continues there in the same order once D1 is back", async (t) => {
  const { f, walk } = await accessWorld(t, "1");
  const expected = (await walk({ sort: "title" })).map((row) => row.page_id);
  shortBounds(t, { read: 30, write: 30 });
  f.db.mode = "fail";
  const first = await f.list(member, { sort: "title", limit: 4 });
  assert.equal(first.source, "catalog");
  f.db.mode = "ok";
  Object.assign(catalogIndexTimeouts, { read: 2500, write: 1500 });
  const rest = await f.list(member, { sort: "title", limit: 10, cursor: first.body.next_cursor });
  // A walk continues on the source that issued its cursor.
  assert.equal(rest.source, "catalog");
  assert.deepEqual(
    [...first.body.pages, ...rest.body.pages].map((row) => row.page_id),
    expected,
  );
});

test("the scan refuses a row of the other kind, and an owned scan never checks a shared row", async (t) => {
  const { f } = await accessWorld(t, null);
  const catalog = f.catalog(member);
  const checked = [];
  const verify = catalog.verifyShared.bind(catalog);
  catalog.verifyShared = async (request, pageId) => {
    checked.push(pageId);
    return verify(request, pageId);
  };
  const identity = { principal: member };
  const request = f.request(member, "/internal/catalog", {});
  const scope = { locations: new Map(), located: () => true, exhaustive: false };
  // A source that ignores access: it hands over one owned and one shared row.
  const rows = [
    { page_id: id(1), updated_at: at(1), title_search: "alpha", owned: true },
    { page_id: id(100), updated_at: at(20), title_search: "gamma shared", owned: false },
  ];
  const source = {
    next: async (after, count) => (after ? [] : rows.slice(0, count).map((row) => ({ ...row }))),
  };
  const scan = (args) =>
    catalog.scanCandidates(request, identity, source, parseListArguments(args), scope, null, null);
  const ids = (result) => result.pages.map((page) => page.page_id);

  assert.deepEqual(ids(await scan({ access: "owned" })), [id(1)]);
  assert.deepEqual(checked, [], "an owned scan never asks a Page host");
  assert.deepEqual(ids(await scan({ access: "shared" })), [id(100)]);
  assert.deepEqual(checked, [id(100)], "a shared scan never reads an owned entry as shared");
  checked.length = 0;
  assert.deepEqual(ids(await scan({})), [id(1), id(100)]);
  assert.deepEqual(checked, [id(100)]);
});

test("Trash sorts by title from D1 and from the Catalog alike", async (t) => {
  const results = {};
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const f = await catalogFixture(t, { index });
      const storage = f.catalog(owner).ctx.storage;
      const trashed = [
        [1, "Zeta"],
        [2, "alpha"],
        [3, ""],
        [4, "Alpha"],
        [5, "Éclair"],
      ];
      for (const [n, title] of trashed)
        await storage.put(`trash/${id(n)}`, {
          page_id: id(n),
          title,
          created_at: at(0),
          updated_at: at(n),
          trashed_at: at(n + 10),
          trashed_by: owner,
          trash_root_id: id(n),
        });
      await storage.put(`page/${id(9)}`, {
        page_id: id(9),
        title: "Active",
        created_at: at(0),
        updated_at: at(9),
      });
      for (let request = 0; request < 6; request++)
        if ((await f.list(owner, { in_trash: true })).source === "index") break;
      const seen = [];
      let cursor;
      for (let request = 0; request < 10; request++) {
        const result = await f.list(owner, {
          in_trash: true,
          sort: "title",
          limit: 2,
          ...(cursor && { cursor }),
        });
        assert.equal(result.status, 200, JSON.stringify(result.body));
        assert.equal(result.source, index ? "index" : "catalog");
        seen.push(...result.body.pages);
        cursor = result.body.next_cursor;
        if (!cursor) break;
      }
      assert.deepEqual(
        seen.map((page) => page.page_id),
        [3, 2, 4, 1, 5].map(id),
        "empty first, ties by Page ID, accented after z; active Pages stay out",
      );
      for (const page of seen) {
        assert.equal(page.state, "trashed");
        assert.equal(page.trashed_by, owner);
      }
      const owned = await f.list(owner, { in_trash: true, sort: "title", access: "owned" });
      assert.deepEqual(
        owned.body.pages.map((page) => page.page_id),
        seen.map((page) => page.page_id),
      );
      results[index ? "index" : "catalog"] = seen;
    });
  }
  assert.deepEqual(results.index, results.catalog);
});

/** Trashed entries whose trash times tie and go missing, and whose content
 * times run another way. */
const TRASH_ENTRIES = [
  // [n, trashed_at, content_updated_at]
  [1, at(30), at(90)],
  [2, at(50), at(10)],
  [3, at(30), at(80)],
  [4, undefined, at(99)],
  [5, at(70), undefined],
  [6, undefined, at(5)],
  // A trash time that isn't a listing time sorts as a missing one.
  [7, Date.parse(at(95)), at(1)],
  [8, "2026-10-01", at(2)],
];

test("Trash lists the most recently trashed first from D1 and the Catalog alike, across ties, missing times and search", async (t) => {
  const results = {};
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const mode = index ? "index" : "catalog";
      const f = await catalogFixture(t, { index });
      const storage = f.catalog(owner).ctx.storage;
      for (const [n, trashed, content] of TRASH_ENTRIES)
        await storage.put(`trash/${id(n)}`, {
          page_id: id(n),
          title: n % 2 ? `Plan ${n}` : `Notes ${n}`,
          created_at: at(0),
          updated_at: at(n),
          ...(content && { content_updated_at: content }),
          ...(trashed && { trashed_at: trashed }),
          trashed_by: owner,
          trash_root_id: id(n),
        });
      for (let request = 0; request < 6; request++)
        if ((await f.list(owner, { in_trash: true })).source === mode) break;
      const walk = async (args) => {
        const pages = [];
        let cursor;
        for (let request = 0; request < 10; request++) {
          const result = await f.list(owner, {
            in_trash: true,
            limit: 2,
            ...args,
            ...(cursor && { cursor }),
          });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.source, mode);
          pages.push(...result.body.pages);
          cursor = result.body.next_cursor;
          if (!cursor) break;
        }
        return pages;
      };
      const trashed = await walk({});
      assert.deepEqual(
        trashed.map((page) => page.page_id),
        [5, 2, 3, 1, 8, 7, 6, 4].map(id),
        "trash time, newest first; ties by the larger Page ID; no trash time last",
      );
      for (const args of [{ sort: "activity" }, { sort: null }, { access: "owned" }])
        assert.deepEqual(
          (await walk(args)).map((page) => page.page_id),
          [5, 2, 3, 1, 8, 7, 6, 4].map(id),
          JSON.stringify(args),
        );
      assert.deepEqual(
        (await walk({ query: "plan" })).map((page) => page.page_id),
        [5, 3, 1, 7].map(id),
        "search keeps the trash order",
      );
      for (const page of trashed) {
        const [, time] = TRASH_ENTRIES.find(([n]) => id(n) === page.page_id);
        assert.equal(page.trashed_at, time, page.page_id);
      }
      // A Trash cursor sealed under the activity scope, as earlier builds
      // sealed it, held an activity_at key: it no longer opens.
      const earlier = await sealCursor(
        f.env,
        {
          principal: owner,
          needle: null,
          inTrash: true,
          scope: JSON.stringify([null, null, true, null, null, "content_activity"]),
        },
        { updated_at: at(90), page_id: id(1) },
      );
      const refused = await f.list(owner, { in_trash: true, cursor: earlier });
      assert.equal(refused.status, 400);
      assert.equal(refused.body.code, "invalid_cursor");
      results[mode] = trashed;
    });
  }
  assert.deepEqual(results.index, results.catalog);
});

test("restoring a Page and trashing it again moves it to the top of Trash", async (t) => {
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const mode = index ? "index" : "catalog";
      const f = await catalogFixture(t, { index });
      const storage = f.catalog(owner).ctx.storage;
      const hosts = {};
      // Page 72 was edited last, so by activity it would stay on top.
      for (const [n, edited] of [
        [71, at(50)],
        [72, at(60)],
      ]) {
        hosts[n] = f.addPage(id(n), `Plan ${n}`);
        await storage.put(`page/${id(n)}`, {
          page_id: id(n),
          title: `Plan ${n}`,
          created_at: at(0),
          updated_at: at(1),
          content_updated_at: edited,
        });
        hosts[n].cacheTitle();
      }
      await f.settle();
      for (let pass = 0; pass < 3; pass++) await f.list(owner);
      const call = async (operation, args) =>
        (
          await f
            .catalog(owner)
            .fetch(f.request(owner, "/internal/catalog", { operation, arguments: args }))
        ).json();
      let requests = 0;
      // Trash times have millisecond resolution; space the transitions so
      // they never tie.
      const later = () => new Promise((resolve) => setTimeout(resolve, 5));
      const trash = async (n) => {
        await later();
        const result = await call("delete_page", {
          page_id: id(n),
          base_heads: A.getHeads(hosts[n].handle.doc()),
          idempotency_key: `trash-again-${n}-${requests++}`,
        });
        assert.equal(result.state, "trashed", JSON.stringify(result));
        await f.settle();
      };
      const listed = async () => {
        for (let request = 0; request < 6; request++) {
          const result = await f.list(owner, { in_trash: true });
          if (result.source === mode) return result.body.pages;
        }
        throw Error("the listing never reached its source");
      };
      await trash(71);
      await trash(72);
      assert.deepEqual(
        (await listed()).map((page) => page.page_id),
        [72, 71].map(id),
      );
      await later();
      const restored = await call("restore_page", {
        page_id: id(71),
        idempotency_key: `restore-again-71-${requests++}`,
      });
      assert.equal(restored.restored, true, JSON.stringify(restored));
      await f.settle();
      assert.deepEqual(
        (await listed()).map((page) => page.page_id),
        [id(72)],
      );
      await trash(71);
      const pages = await listed();
      assert.deepEqual(
        pages.map((page) => page.page_id),
        [71, 72].map(id),
        "the Page trashed last is on top",
      );
      assert.ok(pages[0].trashed_at > pages[1].trashed_at);
      if (index)
        assert.deepEqual(
          f.db.rows(
            `SELECT page_id FROM pages_catalog_pages WHERE state = 'trashed'
            ORDER BY trash_key DESC, page_id DESC`,
          ),
          [71, 72].map((n) => ({ page_id: id(n) })),
        );
    });
  }
});

const columnsOf = (db, table) =>
  db.rows(`SELECT name FROM pragma_table_xinfo('${table}')`).map((row) => row.name);
const indexesOf = (db) =>
  db
    .rows("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'pages_catalog_%'")
    .map((row) => row.name);
/** The write a build that knows migrations 1-5 makes for one owned Page. */
function v5Report(db, pageId, { title, at: time }) {
  db.sqlite
    .prepare(
      `INSERT INTO pages_catalog_pages
        (page_id, owner, title, title_search, state, created_at, updated_at, trashed_at,
          acl_revision, lifecycle_revision)
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, 0, 0)`,
    )
    .run(pageId, owner, title, title.toLowerCase(), time, time);
  db.sqlite
    .prepare(
      `INSERT INTO pages_catalog_access
        (page_id, principal, role, source, domain, updated_revision, updated_at, title, title_search)
      VALUES (?, ?, 'owner', 'owner', NULL, 0, ?, ?, ?)`,
    )
    .run(pageId, owner, time, title, title.toLowerCase());
}

test("content activity migrates a fresh database and one at version 5, and builds without it keep working", async (t) => {
  const latest = CATALOG_MIGRATIONS.at(-1).version;
  assert.ok(latest >= 6);
  const fresh = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(fresh), latest);
  for (const column of ["content_updated_at", "created_at", "activity_at"])
    assert.ok(columnsOf(fresh, "pages_catalog_access").includes(column), column);
  assert.ok(columnsOf(fresh, "pages_catalog_pages").includes("content_updated_at"));
  for (const index of ["pages_catalog_access_activity", "pages_catalog_access_created"])
    assert.ok(indexesOf(fresh).includes(index), index);

  // Rows a build at version 5 wrote: created_at is backfilled from the Page
  // row, the content time stays unknown, and activity falls back.
  const upgraded = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(upgraded, CATALOG_MIGRATIONS.slice(0, 5)), 5);
  v5Report(upgraded, id(1), { title: "Before", at: at(3) });
  assert.equal(await migrateCatalogIndex(upgraded), latest);
  const access = (pageId) =>
    upgraded.rows(
      `SELECT created_at, content_updated_at, activity_at, updated_at
      FROM pages_catalog_access WHERE page_id = ?`,
      pageId,
    )[0];
  assert.deepEqual(access(id(1)), {
    created_at: at(3),
    content_updated_at: null,
    activity_at: at(3),
    updated_at: at(3),
  });

  // A build that knows migrations 1-5 runs against version 6: it migrates
  // nothing, writes rows without the new columns and lists as it always did.
  assert.equal(await migrateCatalogIndex(upgraded, CATALOG_MIGRATIONS.slice(0, 5)), latest);
  v5Report(upgraded, id(2), { title: "Rolled back", at: at(9) });
  assert.deepEqual(access(id(2)), {
    created_at: "",
    content_updated_at: null,
    activity_at: at(9),
    updated_at: at(9),
  });
  assert.deepEqual(
    upgraded
      .rows(
        `SELECT page_id FROM pages_catalog_access WHERE principal = ?
        ORDER BY updated_at DESC, page_id DESC`,
        owner,
      )
      .map((row) => row.page_id),
    [id(2), id(1)],
  );
  // This build reads that row: activity from updated_at, created last until a
  // report from this build copies the Page row's creation time.
  const query = (sort) =>
    queryCatalogIndex(upgraded, {
      principal: owner,
      inTrash: false,
      needle: null,
      after: null,
      count: 10,
      sort,
    }).then((rows) => rows.map((row) => row.page_id));
  assert.deepEqual(await query("activity"), [id(2), id(1)]);
  assert.deepEqual(await query("created"), [id(1), id(2)]);
  await reportPageIndex({ DB: upgraded, PAGES_CATALOG_INDEX: "1" }, testCtx, {
    metadata: { pageId: id(2), owner, deleted: false, acl: { revision: 0, members: {} } },
    title: "Rolled back",
    observedAt: at(10),
  });
  assert.equal(access(id(2)).created_at, at(9));
  assert.deepEqual(await query("created"), [id(2), id(1)]);
});

/** The Page row writes a build that knows migrations 1-6 makes when it
 * records a trash and a restore. */
function v6Trash(db, pageId, trashedAt) {
  db.sqlite
    .prepare(
      `UPDATE pages_catalog_pages
      SET state = 'trashed', trashed_at = ?, updated_at = max(updated_at, ?),
        lifecycle_revision = lifecycle_revision + 1
      WHERE page_id = ?`,
    )
    .run(trashedAt, trashedAt, pageId);
}
function v6Restore(db, pageId, at) {
  db.sqlite
    .prepare(
      `UPDATE pages_catalog_pages
      SET state = 'active', trashed_at = NULL, updated_at = max(updated_at, ?),
        lifecycle_revision = lifecycle_revision + 1
      WHERE page_id = ?`,
    )
    .run(at, pageId);
}

test("the trash listing migrates a fresh database and one at version 6, and builds without it keep working", async (t) => {
  const latest = CATALOG_MIGRATIONS.at(-1).version;
  assert.ok(latest >= 7);
  const fresh = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(fresh), latest);
  assert.ok(columnsOf(fresh, "pages_catalog_pages").includes("trash_key"));
  assert.ok(indexesOf(fresh).includes("pages_catalog_pages_trash"));

  // Pages a build at version 6 trashed: the migration keys them by trash time.
  const upgraded = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(upgraded, CATALOG_MIGRATIONS.slice(0, 6)), 6);
  for (const n of [1, 2, 3, 4]) v5Report(upgraded, id(n), { title: `Page ${n}`, at: at(n) });
  v6Trash(upgraded, id(1), at(30));
  v6Trash(upgraded, id(2), at(10));
  v6Trash(upgraded, id(3), at(20));
  assert.equal(await migrateCatalogIndex(upgraded), latest);
  const keys = () =>
    upgraded.rows("SELECT page_id, trash_key FROM pages_catalog_pages ORDER BY page_id");
  assert.deepEqual(keys(), [
    { page_id: id(1), trash_key: at(30) },
    { page_id: id(2), trash_key: at(10) },
    { page_id: id(3), trash_key: at(20) },
    { page_id: id(4), trash_key: "" },
  ]);
  const trash = (sort) =>
    queryCatalogIndex(upgraded, {
      principal: owner,
      inTrash: true,
      needle: null,
      after: null,
      count: 10,
      sort,
    }).then((rows) => rows.map((row) => row.page_id));
  assert.deepEqual(await trash("trashed"), [1, 3, 2].map(id));

  // A build that knows migrations 1-6 runs against version 7: it migrates
  // nothing, and its restores and trashes keep the trash key right.
  assert.equal(await migrateCatalogIndex(upgraded, CATALOG_MIGRATIONS.slice(0, 6)), latest);
  v6Restore(upgraded, id(1), at(40));
  v6Trash(upgraded, id(2), at(50));
  v6Trash(upgraded, id(4), at(45));
  assert.deepEqual(await trash("trashed"), [2, 4, 3].map(id));
  assert.equal(keys()[0].trash_key, "", "a restored Page has no trash key");
  // Its own Trash query, the access row's activity order, still runs.
  assert.deepEqual((await trash("activity")).sort(), [2, 3, 4].map(id));
});

test("content times only move forward: delayed reports, older full reports and new grants", async (t) => {
  const { db, env } = await seededIndex(t);
  const rows = () =>
    db.rows(
      `SELECT principal, content_updated_at, activity_at FROM pages_catalog_access
      WHERE page_id = ? ORDER BY principal`,
      id(1),
    );
  const pageRow = () =>
    db.rows("SELECT content_updated_at FROM pages_catalog_pages WHERE page_id = ?", id(1))[0];
  const metadata = (members = {}, revision = 0) => ({
    pageId: id(1),
    owner,
    deleted: false,
    acl: { revision, members },
  });
  await reportPageIndex(env, testCtx, { metadata: metadata(), title: "Plan", observedAt: at(1) });
  assert.deepEqual(rows(), [{ principal: owner, content_updated_at: null, activity_at: at(1) }]);
  await reportContentActivity(env, testCtx, { pageId: id(1), contentUpdatedAt: at(10) });
  assert.deepEqual(rows(), [{ principal: owner, content_updated_at: at(10), activity_at: at(10) }]);
  // A report that outlived its caller lands after a newer one.
  let release;
  db.holdNext = new Promise((resolve) => {
    release = resolve;
  });
  const delayed = reportContentActivity(env, testCtx, { pageId: id(1), contentUpdatedAt: at(5) });
  await new Promise((resolve) => setImmediate(resolve));
  await reportContentActivity(env, testCtx, { pageId: id(1), contentUpdatedAt: at(20) });
  release();
  await delayed;
  assert.deepEqual(rows(), [{ principal: owner, content_updated_at: at(20), activity_at: at(20) }]);
  assert.deepEqual(pageRow(), { content_updated_at: at(20) });
  // A full report carrying an older content time moves updated_at, not the
  // content time, so activity holds.
  await reportPageIndex(env, testCtx, {
    metadata: metadata(),
    title: "Renamed",
    observedAt: at(30),
    contentUpdatedAt: at(15),
  });
  assert.deepEqual(rows(), [{ principal: owner, content_updated_at: at(20), activity_at: at(20) }]);
  // A new grant copies the Page row's content time.
  await reportPageIndex(env, testCtx, {
    metadata: metadata({ [member]: { role: "viewer", generation: 1 } }, 1),
    title: "Renamed",
    observedAt: at(31),
  });
  assert.deepEqual(
    rows(),
    [
      { principal: owner, content_updated_at: at(20), activity_at: at(20) },
      { principal: member, content_updated_at: at(20), activity_at: at(20) },
    ].sort((a, b) => (a.principal < b.principal ? -1 : 1)),
  );
  // A newer full report moves it forward for everyone it lists.
  await reportPageIndex(env, testCtx, {
    metadata: metadata({ [member]: { role: "viewer", generation: 1 } }, 1),
    title: "Renamed",
    observedAt: at(32),
    contentUpdatedAt: at(25),
  });
  assert.ok(rows().every((row) => row.content_updated_at === at(25)));
  // A content report never touches a deleted Page or makes rows for a Page
  // without any.
  await retirePageIndex(env, testCtx, { ...metadata(), deleted: true }, at(40));
  await reportContentActivity(env, testCtx, { pageId: id(1), contentUpdatedAt: at(50) });
  await reportContentActivity(env, testCtx, { pageId: id(2), contentUpdatedAt: at(50) });
  assert.deepEqual(rows(), []);
  assert.deepEqual(pageRow(), { content_updated_at: at(25) });
  assert.equal(db.rows("SELECT count(*) AS n FROM pages_catalog_pages")[0].n, 1);
  await assert.rejects(
    reportContentActivity(env, testCtx, { pageId: id(1), contentUpdatedAt: "yesterday" }),
    TypeError,
  );
});

/** Owned entries whose activity and creation keys tie, fall back and go missing. */
const ACTIVITY_ENTRIES = [
  // [n, created_at, updated_at, content_updated_at]
  [1, at(0), at(50), undefined],
  [2, at(0), at(10), at(40)],
  [3, at(5), at(60), at(40)],
  [4, at(5), at(5), at(70)],
  [5, undefined, at(20), undefined],
  [6, at(30), at(30), at(30)],
];

test("activity and created sorts page alike from D1 and the Catalog, across ties and missing times", async (t) => {
  const results = {};
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const f = await catalogFixture(t, { index });
      const storage = f.catalog(owner).ctx.storage;
      for (const [n, created, updated, content] of ACTIVITY_ENTRIES)
        await storage.put(`page/${id(n)}`, {
          page_id: id(n),
          title: `Page ${n}`,
          ...(created && { created_at: created }),
          updated_at: updated,
          ...(content && { content_updated_at: content }),
        });
      for (let request = 0; request < 6; request++)
        if ((await f.list(owner)).source === (index ? "index" : "catalog")) break;
      const walk = async (args) => {
        const rows = [];
        let cursor;
        for (let request = 0; request < 10; request++) {
          const result = await f.list(owner, { limit: 2, ...args, ...(cursor && { cursor }) });
          assert.equal(result.status, 200, JSON.stringify(result.body));
          assert.equal(result.source, index ? "index" : "catalog");
          rows.push(...result.body.pages);
          cursor = result.body.next_cursor;
          if (!cursor) break;
        }
        return rows;
      };
      const activity = await walk({});
      assert.deepEqual(
        activity.map((row) => row.page_id),
        [4, 1, 3, 2, 6, 5].map(id),
        "content time, else updated_at; a tie goes to the larger Page ID",
      );
      assert.deepEqual(
        (await walk({ sort: "activity", access: "owned" })).map((row) => row.page_id),
        [4, 1, 3, 2, 6, 5].map(id),
      );
      const created = await walk({ sort: "created" });
      assert.deepEqual(
        created.map((row) => row.page_id),
        [6, 5, 4, 3, 2, 1].map(id),
        "created_at, else updated_at; ties by Page ID",
      );
      // updated_at keeps its meaning; content_updated_at is null when unknown.
      const byId = new Map(activity.map((row) => [row.page_id, row]));
      for (const [n, created, updated, content] of ACTIVITY_ENTRIES) {
        const row = byId.get(id(n));
        assert.equal(row.updated_at, updated, `updated_at ${n}`);
        assert.equal(row.content_updated_at, content ?? null, `content_updated_at ${n}`);
        assert.equal(row.created_at, created ?? updated, `created_at ${n}`);
      }
      results[index ? "index" : "catalog"] = { activity, created };
    });
  }
  assert.deepEqual(results.index, results.catalog);
});

test("an activity cursor from the Catalog fallback continues there in the same order once D1 is back", async (t) => {
  const f = await catalogFixture(t);
  const storage = f.catalog(owner).ctx.storage;
  for (const [n, created, updated, content] of ACTIVITY_ENTRIES)
    await storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: `Page ${n}`,
      ...(created && { created_at: created }),
      updated_at: updated,
      ...(content && { content_updated_at: content }),
    });
  for (let request = 0; request < 6; request++) if ((await f.list(owner)).source === "index") break;
  for (const [sort, expected] of [
    ["activity", [4, 1, 3, 2, 6, 5]],
    ["created", [6, 5, 4, 3, 2, 1]],
  ]) {
    shortBounds(t, { read: 30, write: 30 });
    f.db.mode = "fail";
    const first = await f.list(owner, { sort, limit: 3 });
    assert.equal(first.source, "catalog");
    f.db.mode = "ok";
    Object.assign(catalogIndexTimeouts, { read: 2500, write: 1500 });
    const rest = await f.list(owner, { sort, limit: 10, cursor: first.body.next_cursor });
    // A walk continues on the source that issued its cursor.
    assert.equal(rest.source, "catalog");
    assert.deepEqual(
      [...first.body.pages, ...rest.body.pages].map((row) => row.page_id),
      expected.map(id),
      sort,
    );
  }
});

test("a shared row shows the content time its Page host reports, and only after the check", async (t) => {
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const f = await catalogFixture(t, { index });
      const host = f.addPage(id(100), "Shared plan", {
        revision: 1,
        members: { [member]: { role: "viewer", generation: 1 } },
      });
      host.contentActivity = { value: at(42), pump() {} };
      await f.catalog(member).ctx.storage.put(`shared/${id(100)}`, {
        page_id: id(100),
        title: "Shared plan",
        created_at: at(1),
        updated_at: at(2),
        shared: true,
      });
      const listed = async () => {
        for (let request = 0; request < 6; request++) {
          const result = await f.list(member, { access: "shared" });
          if (result.source === (index ? "index" : "catalog")) return result;
        }
        throw Error("the listing never reached its source");
      };
      let result = await listed();
      assert.deepEqual(
        result.body.pages.map(({ page_id, content_updated_at }) => ({
          page_id,
          content_updated_at,
        })),
        [{ page_id: id(100), content_updated_at: at(42) }],
      );
      if (index) {
        // Reconciliation indexed the host's time from its check.
        assert.deepEqual(
          f.db.rows(
            "SELECT content_updated_at FROM pages_catalog_access WHERE page_id = ? AND principal = ?",
            id(100),
            member,
          ),
          [{ content_updated_at: at(42) }],
        );
        // The listing shows the host's answer, never the candidate row's.
        await reportContentActivity(f.env, testCtx, {
          pageId: id(100),
          contentUpdatedAt: at(99),
        });
        result = await listed();
        assert.equal(result.body.pages[0].content_updated_at, at(42));
      }
      // A host that no longer lets the member read the Page shows nothing.
      host.metadata = {
        ...host.metadata,
        acl: { revision: 2, members: { [member]: { role: "none", generation: 2 } } },
      };
      result = await f.list(member, { access: "shared" });
      assert.deepEqual(result.body.pages, []);
      assert.ok(!JSON.stringify(result.body).includes(at(42)));
      // A host that hasn't recorded an edit reports null.
      host.metadata = {
        ...host.metadata,
        acl: { revision: 3, members: { [member]: { role: "viewer", generation: 3 } } },
      };
      host.contentActivity = undefined;
      await f.catalog(member).ctx.storage.put(`shared/${id(100)}`, {
        page_id: id(100),
        title: "Shared plan",
        created_at: at(1),
        updated_at: at(2),
        shared: true,
      });
      // The denied listing pruned the D1 row; the next reconcile restores it.
      await f.catalog(member).ctx.storage.put("host/index/dirty", crypto.randomUUID());
      result = await listed();
      assert.deepEqual(
        result.body.pages.map((row) => row.content_updated_at),
        [null],
      );
    });
  }
});

test("the owner's Catalog takes content times forward without moving updated_at", async (t) => {
  const f = await catalogFixture(t, { index: null });
  const catalog = f.catalog(owner);
  const storage = catalog.ctx.storage;
  const project = (body) =>
    catalog.fetch(
      new Request("https://pages.internal/internal/projection", {
        method: "POST",
        body: JSON.stringify({ page_id: id(1), ...body }),
      }),
    );
  await storage.put(`page/${id(1)}`, {
    page_id: id(1),
    title: "Plan",
    created_at: at(0),
    updated_at: at(1),
  });
  const entry = () => storage.get(`page/${id(1)}`);
  await project({ content_updated_at: at(5) });
  assert.deepEqual(await entry(), {
    page_id: id(1),
    title: "Plan",
    created_at: at(0),
    updated_at: at(1),
    content_updated_at: at(5),
  });
  await project({ content_updated_at: at(3) });
  assert.equal((await entry()).content_updated_at, at(5), "a delayed report changes nothing");
  // A title observation older than the entry's still carries a newer content time.
  await project({ title: "Stale", observed_at: at(0), content_updated_at: at(9) });
  assert.deepEqual(
    { ...(await entry()) },
    {
      page_id: id(1),
      title: "Plan",
      created_at: at(0),
      updated_at: at(1),
      content_updated_at: at(9),
    },
  );
  // A newer title observation moves the title, never the content time back.
  await project({ title: "Renamed", observed_at: at(10), content_updated_at: at(8) });
  const renamed = await entry();
  assert.equal(renamed.title, "Renamed");
  assert.equal(renamed.updated_at, at(10));
  assert.equal(renamed.content_updated_at, at(9));
  // A content report lists nothing new: no entry for an unknown or trashed Page.
  await catalog.fetch(
    new Request("https://pages.internal/internal/projection", {
      method: "POST",
      body: JSON.stringify({ page_id: id(2), content_updated_at: at(20) }),
    }),
  );
  assert.equal(await storage.get(`page/${id(2)}`), undefined);
  await storage.put(`trash/${id(3)}`, { page_id: id(3), title: "Gone", updated_at: at(1) });
  await catalog.fetch(
    new Request("https://pages.internal/internal/projection", {
      method: "POST",
      body: JSON.stringify({ page_id: id(3), content_updated_at: at(20) }),
    }),
  );
  assert.equal(await storage.get(`page/${id(3)}`), undefined);
  assert.equal((await storage.get(`trash/${id(3)}`)).content_updated_at, undefined);
});

test("positions have one shape per sort, and sources refuse anything else", async () => {
  const row = {
    page_id: id(1),
    title: "Plan",
    title_search: "plan",
    created_at: at(1),
    updated_at: at(2),
    content_updated_at: at(3),
    activity_at: at(3),
    owned: true,
  };
  assert.deepEqual(positionOf("activity", row), { key: at(3), page_id: id(1) });
  assert.deepEqual(positionOf("created", row), { key: at(1), page_id: id(1) });
  assert.deepEqual(positionOf("title", row), { title_search: "plan", page_id: id(1) });
  // A Catalog fallback row has no generated column; its key is computed alike.
  const { activity_at: _, ...fallback } = row;
  assert.deepEqual(positionOf("activity", fallback), { key: at(3), page_id: id(1) });
  assert.deepEqual(positionOf("activity", { ...fallback, content_updated_at: null }), {
    key: at(2),
    page_id: id(1),
  });
  // A child ID row carries no time or title.
  const child = { page_id: id(2), updated_at: "", title_search: "", owned: false };
  assert.deepEqual(positionOf("created", child), { key: "", page_id: id(2) });
  assert.deepEqual(positionOf("title", child), { title_search: "", page_id: id(2) });
  // A trashed position holds the trash time, or "" without one, never another time.
  assert.deepEqual(positionOf("trashed", { ...row, trashed_at: at(4) }), {
    key: at(4),
    page_id: id(1),
  });
  assert.deepEqual(positionOf("trashed", row), { key: "", page_id: id(1) });

  // A raw row, an opened cursor's payload or another sort's position is a bug.
  const storage = new Storage();
  await storage.put(`page/${id(1)}`, { ...row });
  for (const sort of ["activity", "created", "title"]) {
    const memory = await catalogSource(storage, { inTrash: false, sort });
    const other = positionOf(sort === "title" ? "activity" : "title", row);
    for (const after of [row, { updated_at: at(3), page_id: id(1) }, other]) {
      await assert.rejects(memory.next(after, 1), TypeError, sort);
      assert.throws(
        () => listingQuery({ principal: owner, inTrash: false, after, count: 1, sort }),
        TypeError,
      );
    }
    const [first] = await memory.next(null, 1);
    assert.equal(first.page_id, id(1));
    assert.deepEqual(positionOf(sort, first), positionOf(sort, row));
    assert.deepEqual(await memory.next(positionOf(sort, first), 1), []);
  }
});

test("a stored time key that isn't an ISO time never jumps the order or breaks a cursor", async (t) => {
  const numeric = Date.parse(at(99));
  const row = { page_id: id(1), title_search: 7, created_at: numeric, trashed_at: numeric };
  for (const sort of ["activity", "created", "trashed"]) {
    assert.deepEqual(positionOf(sort, { ...row, updated_at: numeric }), {
      key: "",
      page_id: id(1),
    });
    // A date string in another format would sort by its spelling.
    for (const spelled of ["2026-10-01", "Thu, 01 Oct 2026 00:00:00 GMT"])
      assert.deepEqual(
        positionOf(sort, {
          ...row,
          created_at: spelled,
          updated_at: spelled,
          trashed_at: spelled,
        }),
        { key: "", page_id: id(1) },
      );
  }
  assert.deepEqual(positionOf("title", row), { title_search: "", page_id: id(1) });

  const results = {};
  const shapes = {};
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const mode = index ? "index" : "catalog";
      const f = await catalogFixture(t, { index });
      const storage = f.catalog(owner).ctx.storage;
      await storage.put(`page/${id(1)}`, {
        page_id: id(1),
        title: "One",
        created_at: numeric,
        updated_at: at(1),
      });
      await storage.put(`page/${id(2)}`, {
        page_id: id(2),
        title: "Two",
        created_at: at(5),
        updated_at: at(5),
      });
      await storage.put(`page/${id(3)}`, {
        page_id: id(3),
        title: "Three",
        created_at: at(3),
        updated_at: numeric,
      });
      await storage.put(`page/${id(8)}`, {
        page_id: id(8),
        title: "Eight",
        created_at: "2026-10-01",
        updated_at: at(2),
      });
      // Neither time is a listing time, or neither is there.
      await storage.put(`page/${id(9)}`, {
        page_id: id(9),
        title: "Nine",
        created_at: numeric,
        updated_at: "yesterday",
      });
      await storage.put(`page/${id(10)}`, { page_id: id(10), title: "Ten" });
      for (const [n, trashed] of [
        [4, numeric],
        [5, at(9)],
        [6, "2026-10-01"],
        [7, "Thu, 01 Oct 2026 00:00:00 GMT"],
      ])
        await storage.put(`trash/${id(n)}`, {
          page_id: id(n),
          title: `Gone ${n}`,
          created_at: at(0),
          updated_at: at(0),
          trashed_at: trashed,
          trashed_by: owner,
          trash_root_id: id(n),
        });
      for (let request = 0; request < 6; request++)
        if ((await f.list(owner)).source === mode) break;
      const walk = async (args) => {
        const seen = [];
        let cursor;
        for (let request = 0; request < 10; request++) {
          const result = await f.list(owner, { limit: 1, ...args, ...(cursor && { cursor }) });
          assert.equal(
            result.status,
            200,
            `${JSON.stringify(args)}: ${JSON.stringify(result.body)}`,
          );
          assert.equal(result.source, mode);
          seen.push(...result.body.pages.map((page) => page.page_id));
          cursor = result.body.next_cursor;
          if (!cursor) break;
        }
        return seen;
      };
      // A malformed created_at reads as the entry's updated_at, and a
      // malformed updated_at as its created_at, in both sources. With
      // neither, the key is '' and sorts last, ties by the larger Page ID.
      const orders = async () => ({
        created: await walk({ sort: "created" }),
        activity: await walk({ sort: "activity" }),
        // A malformed trash time sorts last, ties by the larger Page ID.
        trashed: await walk({ in_trash: true }),
      });
      const first = await orders();
      assert.deepEqual(first, {
        created: [2, 3, 8, 1, 10, 9].map(id),
        activity: [2, 3, 8, 1, 10, 9].map(id),
        trashed: [5, 7, 6, 4].map(id),
      });
      // An entry with no listing time answers without either time, from
      // either source: D1's '' never reaches the response.
      const listed = (await f.list(owner, { sort: "created" })).body.pages;
      const ten = listed.find((page) => page.page_id === id(10));
      assert.equal("created_at" in ten, false, JSON.stringify(ten));
      assert.equal("updated_at" in ten, false, JSON.stringify(ten));
      shapes[mode] = listed.map(({ page_id, created_at, updated_at }) => ({
        page_id,
        created_at,
        updated_at,
      }));
      if (index) {
        // Only listing times reach D1, or '' for an entry with none.
        const rows = () =>
          f.db.rows(
            `SELECT p.page_id, p.created_at, p.updated_at, p.trashed_at, a.updated_at AS access
            FROM pages_catalog_pages p JOIN pages_catalog_access a USING (page_id)
            ORDER BY p.page_id`,
          );
        for (const { page_id, created_at, updated_at, trashed_at, access } of rows()) {
          const none = [id(9), id(10)].includes(page_id);
          if (none) assert.deepEqual([created_at, updated_at, access], ["", "", ""]);
          else {
            assert.match(created_at, /^2026-10-01T\d\d:\d\d:00\.000Z$/);
            assert.match(updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
          }
          assert.ok(trashed_at === null || trashed_at === at(9), String(trashed_at));
        }
        // Later passes write the same keys: nothing moves.
        const indexed = rows();
        for (let pass = 0; pass < 3; pass++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
          await storage.put("host/index/dirty", `pass-${pass}`);
          for (let request = 0; request < 6; request++) {
            await f.list(owner);
            if ((await storage.get("host/index/dirty")) === undefined) break;
          }
          assert.equal(await storage.get("host/index/dirty"), undefined);
          assert.deepEqual(rows(), indexed, `after pass ${pass}`);
        }
        assert.deepEqual(await orders(), first);
        // A real time replaces '' once the entry has one.
        await storage.put(`page/${id(10)}`, {
          page_id: id(10),
          title: "Ten",
          created_at: at(4),
          updated_at: at(4),
        });
        await storage.put("host/index/dirty", "fixed");
        for (let request = 0; request < 6; request++) {
          await f.list(owner);
          if ((await storage.get("host/index/dirty")) === undefined) break;
        }
        const ten = rows().find((row) => row.page_id === id(10));
        assert.deepEqual([ten.created_at, ten.updated_at, ten.access], [at(4), at(4), at(4)]);
        assert.deepEqual(await walk({ sort: "created" }), [2, 10, 3, 8, 1, 9].map(id));
      }
      results[mode] = first;
    });
  }
  assert.deepEqual(results.index, results.catalog);
  assert.deepEqual(shapes.index, shapes.catalog, "both sources answer the same times");
});

test("a host trash time in another format reaches the Catalog's trash entry and D1 as the same ISO time", async (t) => {
  const { db, env } = await seededIndex(t);
  const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
  for (const [n, reported, stored] of [
    [61, "2026-10-01", "2026-10-01T00:00:00.000Z"],
    [62, "Thu, 01 Oct 2026 00:05:00 GMT", at(5)],
    [63, Date.parse(at(7)), at(7)],
    [64, at(9), at(9)],
    [65, "soon", null],
  ]) {
    const storage = new Storage();
    // No created_at: the trash entry falls back to the trash time, in the
    // same ISO form, or to the projection's own time without one.
    await storage.put(`page/${id(n)}`, { page_id: id(n), title: "Plan", updated_at: at(0) });
    await projectLifecycle(storage, id(n), {
      state: "trashed",
      revision: 1,
      title: "Plan",
      trashed_at: reported,
      trashed_by: owner,
    });
    const entry = await storage.get(`trash/${id(n)}`);
    assert.equal(entry.trashed_at, stored, String(reported));
    if (stored) assert.equal(entry.created_at, stored, String(reported));
    else assert.match(entry.created_at, iso, String(reported));
    const metadata = {
      pageId: id(n),
      owner,
      deleted: true,
      lifecycleRevision: 1,
      acl: { revision: 0, members: {} },
      trash: { trashed_at: reported, trashed_by: owner },
    };
    await reportPageIndex(env, testCtx, {
      metadata: { ...metadata, deleted: false, trash: undefined, lifecycleRevision: 0 },
      title: "Plan",
      observedAt: at(0),
    });
    await retirePageIndex(env, testCtx, metadata, at(10));
    const [row] = db.rows("SELECT trashed_at FROM pages_catalog_pages WHERE page_id = ?", id(n));
    // D1 and the Catalog agree, a trash time that isn't a date included:
    // null in both, so it sorts last in both.
    assert.equal(row.trashed_at, entry.trashed_at, String(reported));
  }
});

test("listing positions seal into the payload layout every build opens", async () => {
  const env = { NOTEBOOK_CLOUD_APP_SESSION_SECRET: "s".repeat(32) };
  const context = (sort) => ({
    principal: owner,
    needle: null,
    inTrash: false,
    scope: listScope(parseListArguments({ sort })),
  });
  const invalid = { status: 400, code: "invalid_cursor" };
  for (const sort of ["activity", "created"]) {
    const position = { key: at(7), page_id: id(7) };
    const cursor = await sealPosition(env, context(sort), sort, position);
    // The time slot holds the order's key, as builds since content activity sealed it.
    assert.deepEqual(await openCursor(env, context(sort), cursor), {
      updated_at: at(7),
      page_id: id(7),
    });
    assert.deepEqual(await openPosition(env, context(sort), cursor, sort), position);
    // A created position can be "": a Page whose row has no creation time.
    const empty = { key: "", page_id: id(8) };
    assert.deepEqual(
      await openPosition(
        env,
        context(sort),
        await sealPosition(env, context(sort), sort, empty),
        sort,
      ),
      empty,
    );
    // A payload with a title key never opens as a time-keyed position.
    const titled = await sealCursor(env, context(sort), {
      updated_at: at(7),
      page_id: id(7),
      title_search: "x",
    });
    await assert.rejects(openPosition(env, context(sort), titled, sort), invalid);
  }
  const position = { title_search: "alpha", page_id: id(1) };
  const cursor = await sealPosition(env, context("title"), "title", position);
  assert.deepEqual(await openCursor(env, context("title"), cursor), {
    updated_at: "",
    page_id: id(1),
    title_search: "alpha",
  });
  assert.deepEqual(await openPosition(env, context("title"), cursor, "title"), position);
  // Title cursors from earlier builds held the row's updated_at in the time
  // slot. They open to the same position.
  const earlier = await sealCursor(env, context("title"), {
    updated_at: at(9),
    page_id: id(1),
    title_search: "alpha",
  });
  assert.deepEqual(await openPosition(env, context("title"), earlier, "title"), position);
  // A title payload without its key is malformed.
  const keyless = await sealCursor(env, context("title"), { updated_at: at(9), page_id: id(1) });
  await assert.rejects(openPosition(env, context("title"), keyless, "title"), invalid);
  // Sealing a raw row is a bug, not a cursor.
  await assert.rejects(
    sealPosition(env, context("activity"), "activity", { updated_at: at(1), page_id: id(1) }),
    TypeError,
  );
});

/**
 * A member's listing where rejected candidates sit between visible Pages in
 * every order, and no visible Page's sort key equals its `updated_at`.
 *
 * Visible: ten owned Pages and four shared with the member. Rejected: owned
 * entries that vanish before the check (the D1 row is stale, or the Catalog
 * entry went away after the fallback read it) and shared Pages whose host
 * denies the member. Forty of each kind sit together in every order, so a
 * limit-1 page meets more rejected rows in a row than its scan bound of 18,
 * stops at the bound and resumes from the last row it rejected. The rest are
 * scattered.
 *
 * The member's Trash holds the owned and vanished Pages again under their
 * own IDs (`walkTrashId`), with trash times in a fourth order, so Trash's
 * default sort walks past the same blocks.
 */
const WALK_OWNED = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const WALK_SHARED = [101, 102, 103, 104];
const WALK_VANISHED = Array.from({ length: 45 }, (_, n) => 201 + n);
const WALK_REVOKED = Array.from({ length: 45 }, (_, n) => 301 + n);
/** Two limit-1 bounds and more: a look-ahead can consume up to 17 rows of a
 * block, and the next page still meets more than 18. */
const WALK_BLOCK = 40;
const WALK_SORTS = ["activity", "created", "title"];
const walkTrashId = (n) => id(1000 + n);
/** Matches the titles whose rank has a 4: a scattered subset of every order. */
const WALK_QUERY = "4";

/** Each sort's order, top first: the vanished block, eight scattered rows,
 * the revoked block, then the rest scattered. The shuffle is seeded per sort,
 * so the four orders differ. */
function walkOrders() {
  const scattered = [
    ...WALK_OWNED,
    ...WALK_SHARED,
    ...WALK_VANISHED.slice(WALK_BLOCK),
    ...WALK_REVOKED.slice(WALK_BLOCK),
  ];
  const ranks = {};
  for (const [index, sort] of [...WALK_SORTS, "trashed"].entries()) {
    let seed = 7 + index * 101;
    const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const shuffled = [...scattered];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const order = [
      ...WALK_VANISHED.slice(0, WALK_BLOCK),
      ...shuffled.slice(0, 8),
      ...WALK_REVOKED.slice(0, WALK_BLOCK),
      ...shuffled.slice(8),
    ];
    ranks[sort] = new Map(order.map((n, rank) => [n, rank]));
  }
  // Every ninth rank shares the previous one's key, so ties break by Page ID.
  const tied = (rank) => (rank % 9 === 4 ? rank - 1 : rank);
  const keys = (n) => {
    const activity = ranks.activity.get(n);
    return {
      content_updated_at: at(900 - tied(activity)),
      created_at: at(600 - tied(ranks.created.get(n))),
      // Runs opposite to activity, so a raw row's updated_at never stands in.
      updated_at: at(100 + activity),
      title: `${n % 2 ? "Title" : "TITLE"} ${String(tied(ranks.title.get(n))).padStart(3, "0")}`,
    };
  };
  /** When the Page's Trash copy was trashed. Shared Pages have none. */
  const trashedAt = (n) => at(1300 - tied(ranks.trashed.get(n)));
  return { keys, trashedAt };
}

test("listings past rejected candidates show every visible Page once, in order, for every sort, source, access and limit", async (t) => {
  const { keys, trashedAt } = walkOrders();
  const viewer = { revision: 1, members: { [member]: { role: "viewer", generation: 1 } } };
  const needleOf = (query) => (query === undefined ? null : parseListArguments({ query }).needle);
  const expected = (sort, access, { inTrash = false, query } = {}) => {
    const ids = inTrash
      ? WALK_OWNED
      : [...(access === "shared" ? [] : WALK_OWNED), ...(access === "owned" ? [] : WALK_SHARED)];
    const rows = ids
      .filter((n) => titleMatches(keys(n).title, needleOf(query)))
      .map((n) => ({
        ...keys(n),
        trashed_at: trashedAt(n),
        page_id: inTrash ? walkTrashId(n) : id(n),
        title_search: titleKey(keys(n).title),
      }));
    const byPageId = (a, b) => (a.page_id < b.page_id ? -1 : 1);
    // Trash's default order is by trash time.
    const key = sort === "created" ? "created_at" : inTrash ? "trashed_at" : "content_updated_at";
    rows.sort((a, b) => {
      if (sort === "title") return compareText(a.title_search, b.title_search) || byPageId(a, b);
      return a[key] === b[key] ? byPageId(b, a) : a[key] < b[key] ? 1 : -1;
    });
    return rows.map((row) => row.page_id);
  };
  const trashEntry = (n) => ({
    page_id: walkTrashId(n),
    ...keys(n),
    trashed_at: trashedAt(n),
    trashed_by: member,
    trash_root_id: walkTrashId(n),
  });
  for (const index of ["1", null]) {
    await t.test(index ? "index" : "catalog", async (t) => {
      const mode = index ? "index" : "catalog";
      const f = await catalogFixture(t, { index });
      const storage = f.catalog(member).ctx.storage;
      for (const n of [...WALK_OWNED, ...WALK_VANISHED]) {
        await storage.put(`page/${id(n)}`, { page_id: id(n), ...keys(n) });
        await storage.put(`trash/${walkTrashId(n)}`, trashEntry(n));
      }
      for (const n of WALK_SHARED) {
        const { title, content_updated_at } = keys(n);
        f.addPage(id(n), title, viewer).contentActivity = { value: content_updated_at, pump() {} };
        await storage.put(`shared/${id(n)}`, { page_id: id(n), ...keys(n), shared: true });
      }
      for (let request = 0; request < 12; request++)
        if ((await f.list(member)).source === mode) break;
      await f.settle();
      // Vanished entries stay listed, so every reconcile keeps their D1 rows
      // and the fallback reads them, but the check finds nothing.
      const vanished = new Set(
        WALK_VANISHED.flatMap((n) => [`page/${id(n)}`, `trash/${walkTrashId(n)}`]),
      );
      const get = storage.get.bind(storage);
      storage.get = async (key) => (vanished.has(key) ? undefined : get(key));
      // Revoked Pages have no host, so each check is denied. A rejection
      // prunes its D1 row and a denial deletes the entry, so every walk seeds
      // both kinds again.
      const reject = async () => {
        if (index)
          for (const n of WALK_VANISHED) {
            const time = keys(n);
            for (const trashed of [false, true])
              await reportPageIndex(f.env, testCtx, {
                metadata: {
                  pageId: trashed ? walkTrashId(n) : id(n),
                  owner: member,
                  deleted: trashed,
                  ...(trashed && { trash: { trashed_at: trashedAt(n) } }),
                  acl: { revision: 0, members: {} },
                },
                title: time.title,
                observedAt: time.created_at,
                contentUpdatedAt: time.content_updated_at,
              });
          }
        // A stale owner row marks the index dirty, and the reconcile that
        // follows re-verifies every shared row, dropping the revoked ones.
        // Start each walk clean so its first page still meets them.
        await storage.delete("host/index/dirty");
        for (const n of WALK_REVOKED) {
          const time = keys(n);
          await storage.put(`shared/${id(n)}`, { page_id: id(n), ...time, shared: true });
          if (index) {
            // Its row's created_at and updated_at are both the report time.
            await reportPageIndex(f.env, testCtx, {
              metadata: { pageId: id(n), owner, deleted: false, acl: viewer },
              title: time.title,
              observedAt: time.created_at,
              contentUpdatedAt: time.content_updated_at,
            });
          }
        }
      };
      const walk = async (label, args, want) => {
        await reject();
        const seen = [];
        let empty = 0;
        let cursor;
        for (let request = 0; request < 80; request++) {
          // Each page meets the vanished rows again, and a stale owner row
          // puts the account behind, which lists from the Catalog. Clear the
          // mark so every page of this walk reads its own source.
          await storage.delete("host/index/dirty");
          const result = await f.list(member, { ...args, ...(cursor && { cursor }) });
          assert.equal(result.status, 200, `${label}: ${JSON.stringify(result.body)}`);
          assert.equal(result.source, mode, label);
          assert.ok(result.body.pages.length <= args.limit, label);
          seen.push(...result.body.pages.map((page) => page.page_id));
          cursor = result.body.next_cursor;
          if (!result.body.pages.length && cursor) empty++;
          if (!cursor) break;
        }
        await f.settle();
        assert.equal(cursor, null, `${label}: the walk ended`);
        assert.deepEqual(seen, want, label);
        // A limit-1 page meets a block of rejected rows past its bound of 18
        // and returns an empty page with a cursor. A search walks only the
        // block's matches, so it may not.
        if (args.limit === 1 && args.query === undefined)
          assert.ok(empty > 0, `${label}: the scan stopped at its bound`);
      };
      for (const inTrash of [false, true])
        for (const query of [undefined, WALK_QUERY])
          for (const sort of WALK_SORTS)
            // Trash holds only owned Pages; shared refuses in_trash.
            for (const access of inTrash ? [null, "owned"] : [null, "owned", "shared"])
              for (const limit of query === undefined ? [1, 2, 3] : [1, 2]) {
                const want = expected(sort, access, { inTrash, query });
                if (query !== undefined && access === null)
                  assert.ok(want.length > 1, "the search matches visible Pages");
                await walk(
                  `${mode}${inTrash ? " trash" : ""} ${sort} ${access ?? "all"}${query === undefined ? "" : ` query ${query}`} limit ${limit}`,
                  {
                    sort,
                    limit,
                    ...(access && { access }),
                    ...(inTrash && { in_trash: true }),
                    ...(query !== undefined && { query }),
                  },
                  want,
                );
              }
    });
  }
});

test("schema v8 drops the Project root-Page column from a fresh database and from one at version 7", async (t) => {
  assert.equal(CATALOG_MIGRATIONS.at(-1).version, 8);
  const fresh = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(fresh), 8);
  const spaceColumns = (db) => columnsOf(db, "pages_catalog_spaces").sort();
  const expected = ["created_at", "owner", "space_id", "title", "title_search", "updated_at"];
  assert.deepEqual(spaceColumns(fresh), expected);
  assert.ok(indexesOf(fresh).includes("pages_catalog_spaces_listing"));

  // Rows a build at version 7 wrote keep everything but the dropped column.
  const upgraded = sqliteD1(t).open();
  assert.equal(await migrateCatalogIndex(upgraded, CATALOG_MIGRATIONS.slice(0, 7)), 7);
  upgraded.sqlite
    .prepare(
      `INSERT INTO pages_catalog_spaces
        (space_id, owner, title, title_search, home_page_id, created_at, updated_at)
      VALUES ('prj_a', 'owner', 'Launch', 'launch', 'doc', 't0', 't1')`,
    )
    .run();
  assert.equal(await migrateCatalogIndex(upgraded), 8);
  assert.deepEqual(spaceColumns(upgraded), expected);
  assert.deepEqual(
    upgraded.rows("SELECT * FROM pages_catalog_spaces").map((row) => ({ ...row })),
    [
      {
        space_id: "prj_a",
        owner: "owner",
        title: "Launch",
        title_search: "launch",
        created_at: "t0",
        updated_at: "t1",
      },
    ],
  );
  assert.ok(indexesOf(upgraded).includes("pages_catalog_spaces_listing"));
  assert.equal(await migrateCatalogIndex(upgraded), 8, "applied once");
});
