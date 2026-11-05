// The account index's readiness: the machine's table, its interpreter in
// reconcileAccountIndex, and list_pages walks right after bulk creation over
// real Catalog and Page hosts (projects-fixture.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import {
  accountIndexMachine,
  accountIndexState,
  indexCooldownMachine,
  indexCooldownState,
  pageIndexMarkMachine,
  pageIndexMarkState,
  opensIndex,
} from "./account-index-machine.mjs";
import {
  catalogIndexBounds,
  markCatalogIndexDirty,
  markPagesForIndex,
  migrateCatalogIndex,
  reconcileAccountIndex,
  settlePageMark,
} from "./catalog-index.mjs";
import { Storage, world } from "./projects-fixture.mjs";

const TABLE = new URL("../test/fixtures/machines/account-index.json", import.meta.url);
const MARK_TABLE = new URL("../test/fixtures/machines/page-index-mark.json", import.meta.url);
const COOLDOWN_TABLE = new URL("../test/fixtures/machines/index-cooldown.json", import.meta.url);
const DIRTY = "host/index/dirty";
const SYNC = "host/index/sync";
const principal = "user:anaconda-fixture:fixture-user";
const id = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;
const at = (n) => new Date(Date.UTC(2026, 9, 1, 0, 0, n)).toISOString();

test("account-index: the table covers every state and event, and the machine agrees", async () => {
  const run = await runTable(accountIndexMachine, loadTable(TABLE));
  assert.equal(
    run.pairs + run.unreachable,
    accountIndexMachine.states.length * accountIndexMachine.events.length,
  );
  assert.equal(run.rows, 18);
});

test("page-index-mark: the table covers every state and event, and the machine agrees", async () => {
  const run = await runTable(pageIndexMarkMachine, loadTable(MARK_TABLE));
  assert.equal(
    run.pairs + run.unreachable,
    pageIndexMarkMachine.states.length * pageIndexMarkMachine.events.length,
  );
  assert.equal(run.rows, 10);
  assert.deepEqual(pageIndexMarkState(undefined), { name: "settled" });
  assert.deepEqual(pageIndexMarkState("t1"), { name: "pending", token: "t1" });
});

test("index-cooldown: the table covers every state and event, and the machine agrees", async () => {
  const run = await runTable(indexCooldownMachine, loadTable(COOLDOWN_TABLE));
  assert.equal(
    run.pairs + run.unreachable,
    indexCooldownMachine.states.length * indexCooldownMachine.events.length,
  );
  assert.equal(run.rows, 6);
  // The stored end gives the state: a passed or missing end reads as open.
  assert.deepEqual(indexCooldownState(undefined, 5), { name: "open" });
  assert.deepEqual(indexCooldownState(10, 5), { name: "cooling", until: 10 });
  assert.deepEqual(indexCooldownState(10, 10), { name: "open" });
});

test("opensIndex: a D1 walk always opens D1; anything else skips it while it is cooling", () => {
  const open = { name: "open" };
  const cooling = { name: "cooling", until: 10 };
  const cases = [
    ["index", open, true],
    ["index", cooling, true],
    ["catalog", open, true],
    ["catalog", cooling, false],
    [null, open, true],
    [null, cooling, false],
  ];
  for (const [pinned, cooldown, expected] of cases)
    assert.equal(opensIndex({ pinned, cooldown }), expected, `${pinned} ${cooldown.name}`);
});

test("account-index: every transition matches the state its persisted facts give", () => {
  // The interpreter derives the state from D1's marker and the dirty token on
  // every listing, so each event's change to those facts must land in the
  // state the transition names.
  const facts = {
    unsynced: [
      { current: false, dirty: undefined },
      { current: false, dirty: "t1" },
    ],
    behind: [{ current: true, dirty: "t1" }],
    ready: [{ current: true, dirty: undefined }],
  };
  const apply = (fact, event) => {
    switch (event.type) {
      case "marked":
        return { ...fact, dirty: "t2" };
      case "epoch":
        return { ...fact, current: false };
      case "completed": {
        // An unverified pass records nothing; a write that landed while it
        // ran still left its mark.
        if (!event.verified) return event.unchanged ? fact : { ...fact, dirty: "t2" };
        // The pass started from `t1` (or no token) and recorded its epoch.
        const started = fact.dirty;
        const dirty = event.unchanged ? started : "t2";
        return { current: true, dirty: dirty === started ? undefined : dirty };
      }
    }
  };
  const events = [
    { type: "marked" },
    { type: "epoch" },
    { type: "completed", verified: true, unchanged: true },
    { type: "completed", verified: true, unchanged: false },
    { type: "completed", verified: false, unchanged: true },
    { type: "completed", verified: false, unchanged: false },
  ];
  for (const [name, list] of Object.entries(facts))
    for (const fact of list) {
      assert.deepEqual(accountIndexState(fact), { name });
      for (const event of events)
        assert.deepEqual(
          accountIndexState(apply(fact, event)),
          accountIndexMachine.step({ name }, event).state,
          `${name} ${JSON.stringify(fact)} × ${JSON.stringify(event)}`,
        );
    }
});

/** One account's Catalog storage and a migrated D1, with `count` owned
 * entries, and a reconcile call as a listing makes it. */
async function account(t, count) {
  const db = sqliteD1(t).open();
  await migrateCatalogIndex(db);
  const storage = new Storage();
  const own = async (n) =>
    storage.put(`page/${id(n)}`, {
      page_id: id(n),
      title: `Page ${n}`,
      created_at: at(n),
      updated_at: at(n),
    });
  for (let n = 1; n <= count; n++) await own(n);
  const reconcile = (target = db) =>
    reconcileAccountIndex({
      db: target,
      storage,
      principal,
      epoch: "1",
      verify: async () => ({ status: "denied" }),
    });
  const indexed = () =>
    db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE principal = ?", principal)[0].n;
  return { db, storage, own, reconcile, indexed };
}

/** Shorten the per-listing entry budget for one test. */
function entriesPerListing(t, value) {
  const saved = catalogIndexBounds.entriesPerListing;
  t.after(() => {
    catalogIndexBounds.entriesPerListing = saved;
  });
  catalogIndexBounds.entriesPerListing = value;
}

test("a write since the last pass keeps D1 out of listings until a pass imports it", async (t) => {
  entriesPerListing(t, 4);
  const a = await account(t, 0);
  assert.equal(await a.reconcile(), true, "an empty account's first pass completes at once");
  assert.equal(await a.reconcile(), true, "nothing due");

  for (let n = 1; n <= 10; n++) {
    await markCatalogIndexDirty(a.storage);
    await a.own(n);
  }
  // Ten entries at four per listing, then the orphan check: every listing
  // before the pass ends leaves the account behind.
  const answers = [];
  for (let listing = 0; listing < 8 && answers.at(-1) !== true; listing++)
    answers.push(await a.reconcile());
  assert.equal(answers.at(-1), true);
  assert.ok(answers.length > 2, "the pass spans listings");
  assert.ok(
    answers.slice(0, -1).every((ready) => ready === false),
    JSON.stringify(answers),
  );
  assert.equal(a.indexed(), 10);
  assert.equal(await a.storage.get(DIRTY), undefined, "the mark is cleared");
  assert.equal(await a.reconcile(), true);
});

test("a write that lands while a pass runs keeps the account behind through the next pass", async (t) => {
  entriesPerListing(t, 4);
  const a = await account(t, 0);
  await a.reconcile();
  for (let n = 1; n <= 6; n++) {
    await markCatalogIndexDirty(a.storage);
    await a.own(n);
  }
  assert.equal(await a.reconcile(), false);
  assert.ok(await a.storage.get(SYNC), "the pass is under way");
  // Page 7 sorts before the pass's position, so this pass never reads it.
  await markCatalogIndexDirty(a.storage);
  await a.storage.put(`page/${id(0)}`, {
    page_id: id(0),
    title: "Late",
    created_at: at(70),
    updated_at: at(70),
  });
  const answers = [];
  for (let listing = 0; listing < 12 && answers.at(-1) !== true; listing++)
    answers.push(await a.reconcile());
  assert.equal(answers.at(-1), true);
  assert.equal(
    a.db.rows("SELECT count(*) AS n FROM pages_catalog_access WHERE page_id = ?", id(0))[0].n,
    1,
    "ready only once the late entry is in D1",
  );
});

test("a write during the epoch record keeps its mark and the account behind", async (t) => {
  const a = await account(t, 3);
  let inject = false;
  const wrap = (statement, sql) => ({
    bind: (...values) => wrap(statement.bind(...values), sql),
    first: () => statement.first(),
    all: () => statement.all(),
    execute: () => statement.execute(),
    run: async () => {
      if (inject && sql.includes("INSERT INTO pages_catalog_accounts")) {
        inject = false;
        await markCatalogIndexDirty(a.storage);
      }
      return statement.run();
    },
  });
  const hooked = {
    prepare: (sql) => wrap(a.db.prepare(sql), sql),
    batch: (statements) => a.db.batch(statements),
  };
  await markCatalogIndexDirty(a.storage);
  inject = true;
  assert.equal(await a.reconcile(hooked), false);
  assert.equal(inject, false, "the write landed during the record");
  assert.notEqual(await a.storage.get(DIRTY), undefined, "its mark survives");
  assert.equal(a.db.rows("SELECT epoch FROM pages_catalog_accounts")[0].epoch, "1");
  assert.equal(await a.reconcile(), true, "the next pass completes");
  assert.equal(await a.storage.get(DIRTY), undefined);
});

test("an unavailable check leaves the state the account had: behind stays out, a periodic pass stays in", async (t) => {
  const a = await account(t, 0);
  await a.storage.put(`shared/${id(9)}`, { page_id: id(9), title: "Shared", updated_at: at(9) });
  let answer = { status: "unavailable" };
  const reconcile = (now) =>
    reconcileAccountIndex({
      db: a.db,
      storage: a.storage,
      principal,
      epoch: "1",
      verify: async () => answer,
      ...(now && { now }),
    });
  assert.equal(await reconcile(), false, "never synced");
  answer = { status: "denied" };
  assert.equal(await reconcile(), true);

  // A periodic pass found nothing written since; an unavailable check
  // doesn't put D1 behind.
  await a.storage.put(`shared/${id(9)}`, { page_id: id(9), title: "Shared", updated_at: at(9) });
  answer = { status: "unavailable" };
  const later = Date.now() + catalogIndexBounds.reconcileIntervalMs + 1000;
  assert.equal(await reconcile(later), true);

  await markCatalogIndexDirty(a.storage);
  await a.own(1);
  assert.equal(await reconcile(), false, "behind, and the pass couldn't verify");
  assert.notEqual(await a.storage.get(DIRTY), undefined);
  answer = { status: "denied" };
  assert.equal(await reconcile(), true);
});

test("a write that lands during a call's own D1 awaits is never reported ready", async (t) => {
  entriesPerListing(t, 4);
  const a = await account(t, 10);
  assert.equal(await a.reconcile(), false);
  for (let listing = 0; listing < 10 && !(await a.reconcile()); listing++);
  assert.equal(await a.storage.get(DIRTY), undefined, "ready");
  // A periodic pass runs, and a creation lands while its first write waits.
  let landed = false;
  const hooked = {
    prepare: (sql) => a.db.prepare(sql),
    batch: async (statements) => {
      if (!landed) {
        landed = true;
        await markCatalogIndexDirty(a.storage);
        await a.own(11);
      }
      return a.db.batch(statements);
    },
  };
  const later = Date.now() + catalogIndexBounds.reconcileIntervalMs + 1000;
  const periodic = (db) =>
    reconcileAccountIndex({
      db,
      storage: a.storage,
      principal,
      epoch: "1",
      verify: async () => ({ status: "denied" }),
      now: later,
    });
  assert.equal(await periodic(hooked), false, "the pass is unfinished and a write landed");
  assert.ok(landed);
  assert.ok(await a.storage.get(SYNC), "the pass continues");

  // An unverified pass that saw a write land is behind too.
  const b = await account(t, 0);
  await b.storage.put(`shared/${id(9)}`, { page_id: id(9), title: "Shared", updated_at: at(9) });
  const pass = (verify, now) =>
    reconcileAccountIndex({
      db: b.db,
      storage: b.storage,
      principal,
      epoch: "1",
      verify,
      ...(now && { now }),
    });
  assert.equal(await pass(async () => ({ status: "denied" })), true);
  await b.storage.put(`shared/${id(9)}`, { page_id: id(9), title: "Shared", updated_at: at(9) });
  const unavailable = async () => {
    await markCatalogIndexDirty(b.storage);
    return { status: "unavailable" };
  };
  assert.equal(await pass(unavailable, later), false);
  assert.notEqual(await b.storage.get(DIRTY), undefined);
});

/** One list_pages call to the owner's Catalog, with the source it read. */
async function list(w, args) {
  const response = await w.catalog().fetch(
    new Request("https://pages.invalid/internal/catalog", {
      method: "POST",
      headers: { authorization: `Bearer ${w.auth.apiKey()}` },
      body: JSON.stringify({ operation: "list_pages", arguments: args }),
    }),
  );
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return { body, source: response.headers.get("x-pages-catalog-source") };
}

/** Walk list_pages from the first page until next_cursor is null, as the
 * viewer's Home does, and report each page's source. */
async function walk(w) {
  const seen = [];
  const trail = [];
  let cursor;
  for (let request = 0; request < 50; request++) {
    const { body, source } = await list(w, { limit: 100, ...(cursor && { cursor }) });
    seen.push(...body.pages.map((page) => page.page_id));
    trail.push(`${body.pages.length} from ${source}`);
    cursor = body.next_cursor;
    if (!cursor) return { seen, trail };
  }
  throw new Error("walk did not end");
}

for (const index of ["1", null])
  test(`a walk right after bulk creation lists every Page once (index ${index ?? "off"})`, async (t) => {
    const w = await world(t, { index });
    w.env.PAGES_DEFAULT_PAGE_QUOTA = "1000";
    // The account's first listing completes a pass on an empty account, so
    // its epoch is recorded before any Page exists.
    assert.deepEqual((await walk(w)).seen, []);
    const created = [];
    // Sequential and concurrent creations both reach the Catalog only.
    for (let n = 0; n < 150; n++) {
      const page = await w.createPage({ title: `Bulk ${n}` });
      assert.equal(page.status, 200, JSON.stringify(page.body));
      created.push(page.body.page_id);
    }
    for (let batch = 0; batch < 15; batch++) {
      const pages = await Promise.all(
        Array.from({ length: 10 }, (_, n) => w.createPage({ title: `Burst ${batch}.${n}` })),
      );
      for (const page of pages) {
        assert.equal(page.status, 200, JSON.stringify(page.body));
        created.push(page.body.page_id);
      }
    }
    for (let round = 0; round < 3; round++) {
      const { seen, trail } = await walk(w);
      assert.equal(new Set(seen).size, seen.length, `no Page twice: ${trail}`);
      assert.deepEqual([...seen].sort(), [...created].sort(), trail.join("; "));
    }
    if (!index) return;
    // Once the pass catches up, listings read D1 again.
    let source;
    for (let listing = 0; listing < 20 && source !== "index"; listing++)
      ({ source } = await list(w, { limit: 1 }));
    assert.equal(source, "index");
    const { seen, trail } = await walk(w);
    assert.deepEqual([...seen].sort(), [...created].sort(), trail.join("; "));
    assert.ok(
      trail.every((page) => page.endsWith("from index")),
      trail.join("; "),
    );
  });

/** The owner's D1 row for one Page: its state, or undefined. */
const ownerRow = (w, pageId) =>
  w.db.rows(
    `SELECT p.state FROM pages_catalog_access a JOIN pages_catalog_pages p ON p.page_id = a.page_id
    WHERE a.principal = ? AND a.page_id = ?`,
    w.owner,
    pageId,
  )[0]?.state;

/** Stored Page index marks. */
const pageMarks = async (w) => [
  ...(await w.catalogStorage().list({ prefix: "host/index/page/" })).keys(),
];

test("creating a Page or a Project marks the Page, answers, then writes the owner's D1 row", async (t) => {
  const w = await world(t);
  assert.equal((await list(w, { limit: 1 })).source, "index", "an empty account is ready");
  // Each request answers while its D1 write is still held back.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const batch = w.db.batch.bind(w.db);
  w.db.batch = async (statements) => {
    await gate;
    return batch(statements);
  };
  const created = [];
  for (let n = 0; n < 5; n++) {
    const page = await w.createPage({ title: `Kept ${n}` });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    created.push(page.body.page_id);
  }
  assert.equal((await pageMarks(w)).length, 5, "answered before any row landed");
  assert.equal(ownerRow(w, created[0]), undefined);
  release();
  const project = await w.createProject("Launch");
  assert.equal(await w.catalogStorage().get(DIRTY), undefined, "no write put the account behind");
  await w.settle();
  // The Project's content document has its owner row too, but it isn't a
  // Page in the tree, so no listing shows it.
  for (const pageId of [...created, project.document_id])
    assert.equal(ownerRow(w, pageId), "active");
  assert.deepEqual(await pageMarks(w), [], "each written row cleared its mark");
  const listed = await list(w, { limit: 100 });
  assert.equal(listed.source, "index");
  assert.deepEqual(listed.body.pages.map((page) => page.page_id).sort(), [...created].sort());
});

test("a creation lists in the very next listing, whether or not its D1 write has landed", async (t) => {
  const w = await world(t);
  await list(w, { limit: 1 });
  // The write hasn't run when the next listing arrives.
  w.db.mode = "fail";
  const page = await w.createPage({ title: "Unindexed" });
  w.db.mode = "ok";
  assert.equal(page.status, 200, JSON.stringify(page.body));
  await w.settle();
  assert.equal(ownerRow(w, page.body.page_id), undefined, "the background write failed");
  assert.equal((await pageMarks(w)).length, 1, "its mark stays");
  assert.equal(await w.catalogStorage().get(DIRTY), undefined, "the account isn't behind");
  // The listing settles the mark from the entry, and lists from D1.
  const listed = await list(w, { limit: 100 });
  assert.equal(listed.source, "index");
  assert.deepEqual(
    listed.body.pages.map((entry) => entry.page_id),
    [page.body.page_id],
  );
  assert.equal(ownerRow(w, page.body.page_id), "active");
  assert.deepEqual(await pageMarks(w), []);
});

test("a mark a listing can't settle keeps listings on the Catalog, which lists the Page", async (t) => {
  const w = await world(t);
  await list(w, { limit: 1 });
  w.db.mode = "fail";
  const page = await w.createPage({ title: "Unindexed" });
  await w.settle();
  // D1 is still down at the next listing: the Catalog serves it.
  const listed = await list(w, { limit: 100 });
  assert.equal(listed.source, "catalog");
  assert.deepEqual(
    listed.body.pages.map((entry) => entry.page_id),
    [page.body.page_id],
  );
  w.db.mode = "ok";
  assert.equal((await list(w, { limit: 100 })).source, "index");
});

test("a newer write's mark survives the older write's settle", async (t) => {
  const w = await world(t);
  await list(w, { limit: 1 });
  const storage = w.catalogStorage();
  const [mark] = await markPagesForIndex(w.env, storage, [id(5)]);
  const [newer] = await markPagesForIndex(w.env, storage, [id(5)]);
  await settlePageMark(storage, mark, "indexed");
  assert.equal(await storage.get(newer.key), newer.token, "the newer mark stays");
  await settlePageMark(storage, newer, "indexed");
  assert.equal(await storage.get(newer.key), undefined);
});

test("moving a Page changes nothing D1 holds and leaves the account ready", async (t) => {
  const w = await world(t);
  const parent = (await w.createPage({ title: "Parent" })).body.page_id;
  const child = (await w.createPage({ title: "Child" })).body.page_id;
  const authority = (await w.call("owner", "list_pages")).body;
  const moved = await w.call("owner", "move_page", {
    page_id: child,
    parent_id: parent,
    retry_token: authority.retry_token,
    idempotency_key: authority.retry_key_prefix + crypto.randomUUID(),
  });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(await w.catalogStorage().get(DIRTY), undefined);
  assert.equal((await list(w, { limit: 100 })).source, "index");
});

test("Trash, restore and purge write the owner's D1 row after answering, so the account stays ready", async (t) => {
  const w = await world(t);
  const pageId = (await w.createPage({ title: "Cycled" })).body.page_id;
  const kept = (await w.createPage({ title: "Kept" })).body.page_id;
  const ready = async (label) => {
    assert.equal(await w.catalogStorage().get(DIRTY), undefined, label);
    assert.deepEqual(await pageMarks(w), [], label);
    assert.equal((await list(w, { limit: 100 })).source, "index", label);
  };
  const trashed = await w.call("owner", "delete_page", {
    page_id: pageId,
    idempotency_key: w.key(),
  });
  assert.equal(trashed.status, 200, JSON.stringify(trashed.body));
  await w.settle();
  assert.equal(ownerRow(w, pageId), "trashed");
  await ready("after Trash");
  const inTrash = await list(w, { in_trash: true });
  assert.equal(inTrash.source, "index");
  assert.deepEqual(
    inTrash.body.pages.map((page) => page.page_id),
    [pageId],
  );
  const restored = await w.call("owner", "restore_page", {
    page_id: pageId,
    idempotency_key: w.key(),
  });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  await w.settle();
  assert.equal(ownerRow(w, pageId), "active");
  await ready("after restore");
  assert.deepEqual(
    (await list(w, { limit: 100 })).body.pages.map((page) => page.page_id).sort(),
    [pageId, kept].sort(),
  );
  await w.call("owner", "delete_page", { page_id: pageId, idempotency_key: w.key() });
  const preview = await w.call("owner", "purge_page", { page_id: pageId, action: "preview" });
  const purged = await w.call("owner", "purge_page", {
    page_id: pageId,
    action: "confirm",
    preview_token: preview.body.preview_token,
    idempotency_key: w.key(),
  });
  assert.equal(purged.status, 200, JSON.stringify(purged.body));
  await w.settle();
  assert.equal(ownerRow(w, pageId), undefined);
  await ready("after purge");
});

test("more pending creation marks than a listing settles keep D1 out until every one settles", async (t) => {
  const w = await world(t);
  w.env.PAGES_DEFAULT_PAGE_QUOTA = "1000";
  await list(w, { limit: 1 });
  // Every background write fails, so all 100 marks stay. Reads stay healthy.
  const batch = w.db.batch.bind(w.db);
  let down = true;
  w.db.batch = async (statements) => {
    if (down) throw new Error("injected D1 write outage");
    return batch(statements);
  };
  const created = [];
  for (let n = 0; n < 100; n++) {
    const page = await w.createPage({ title: `Pending ${n}` });
    assert.equal(page.status, 200, JSON.stringify(page.body));
    created.push(page.body.page_id);
  }
  await w.settle();
  down = false;
  assert.equal((await pageMarks(w)).length, 100);
  // The first listing settles 24 marks; D1 then holds 24 of 100 Pages, and
  // reading it would end the walk early.
  const seen = [];
  const sources = [];
  let cursor;
  for (let request = 0; request < 50; request++) {
    const { body, source } = await list(w, { limit: 10, ...(cursor && { cursor }) });
    seen.push(...body.pages.map((page) => page.page_id));
    sources.push(source);
    cursor = body.next_cursor;
    if (!cursor) break;
  }
  assert.equal(sources[0], "catalog", `marks were pending: ${sources}`);
  assert.equal(new Set(seen).size, seen.length);
  assert.deepEqual([...seen].sort(), [...created].sort(), `${seen.length} of 100: ${sources}`);
  // The walk's listings settled the rest; the next walk reads D1.
  assert.deepEqual(await pageMarks(w), []);
  assert.equal((await list(w, { limit: 1 })).source, "index");
});
