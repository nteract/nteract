import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { reportContentActivity, reportPageIndex } from "./catalog-index.mjs";
import { CONTENT_ACTIVITY_KEY, CONTENT_ACTIVITY_MAX_SKEW_MS } from "./content-activity.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";

// The Page host's side of content activity: which document changes count,
// what it stores and what it reports (worker/content-activity.mjs).

/** Give `page` a handle that emits `change` with patches, as the repo's
 * DocHandle does, over the fixture's document. */
function emitting(page) {
  const inner = page.handle;
  const listeners = new Set();
  page.handle = {
    doc: () => inner.doc(),
    broadcast: (...args) => inner.broadcast(...args),
    async update(fn) {
      const before = A.getHeads(inner.doc());
      await inner.update(fn);
      const after = inner.doc();
      const patches = A.diff(after, before, A.getHeads(after));
      if (patches.length) for (const listener of [...listeners]) listener({ patches });
    },
    on(type, listener) {
      if (type === "change") listeners.add(listener);
    },
    off(type, listener) {
      if (type === "change") listeners.delete(listener);
    },
  };
  return page;
}

const settle = async (f) => {
  while (f.tasks.length) await Promise.allSettled(f.tasks.splice(0));
};
/** Change the title as a synced peer would: straight into the handle. The
 * socket that brought it runs the deferred effects (`serve`), as `pump` does
 * here. */
const peerEdit = async (page, title) => {
  await page.handle.update((doc) =>
    A.change(doc, (draft) => {
      draft.title = title;
    }),
  );
  page.contentActivity?.pump();
};

test("content changes record a time; comments, presence and sharing don't", async (t) => {
  const f = await fixture(t);
  await emitting(f.page).watchContent();
  const ownerEntry = () => f.catalogOf(f.owner).storage.get(`page/${pageId}`);
  const comment = await f.tool("member", "manage_page_comment", {
    action: "add",
    block_id: f.blockId,
    body: "One more thought",
    nonce: "content-activity-comment",
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  const progress = await f.tool("owner", "report_page_progress", { message: "Reading" });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  const sharing = await f.pageCall("owner", "/internal/access", {
    action: "set_role",
    principal: "user:anaconda-fixture:new",
    role: "viewer",
    expected_revision: 1,
    nonce: "content-activity-share",
  });
  assert.equal(sharing.status, 200, JSON.stringify(sharing.body));
  await settle(f);
  assert.equal(f.page.contentActivity.value, null);
  assert.equal(await f.storage.get(CONTENT_ACTIVITY_KEY), undefined);
  assert.equal((await ownerEntry()).content_updated_at, undefined);
  // The ACL commit projected the title, which moved updated_at; an edit won't.
  const projected = (await ownerEntry()).updated_at;

  const before = new Date().toISOString();
  const edit = await f.tool("owner", "edit_page", {
    operations: [{ op: "insert_markdown", markdown: "A new paragraph." }],
    revision: await f.revision(),
    nonce: "content-activity-edit",
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  await settle(f);
  const value = f.page.contentActivity.value;
  assert.ok(value >= before, `${value} >= ${before}`);
  assert.deepEqual(await f.storage.get(CONTENT_ACTIVITY_KEY), { content_updated_at: value });
  // The owner's entry takes the time; updated_at keeps its meaning.
  const entry = await ownerEntry();
  assert.equal(entry.content_updated_at, value);
  assert.equal(entry.updated_at, projected);
  // A reader's check returns it.
  const check = await f.pageCall("member", "/internal/catalog", {});
  assert.equal(check.status, 200);
  assert.equal(check.body.content_updated_at, value);
});

test("a recorded time is stored once per window, reported to D1, and survives a restart", async (t) => {
  const db = sqliteD1(t).open();
  const f = await fixture(t, { env: { DB: db, PAGES_CATALOG_INDEX: "1" } });
  await emitting(f.page).watchContent();
  await f.page.reportIndex({ title: "Launch plan", observedAt: new Date().toISOString() });
  let writes = 0;
  const put = f.storage.put.bind(f.storage);
  f.storage.put = async (key, value) => {
    if (key === CONTENT_ACTIVITY_KEY) writes++;
    return put(key, value);
  };
  const batches = () => db.calls;
  const start = batches();
  // Twenty peer changes in a burst: the first flushes, the rest wait. The
  // window's timer is held on the request until it fires, so drain turns
  // rather than every held task.
  for (let n = 0; n < 20; n++) await peerEdit(f.page, `Launch plan ${n}`);
  for (let turn = 0; turn < 10; turn++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes, 1, "one storage write for the burst");
  assert.equal(batches() - start, 1, "one D1 batch for the burst");
  assert.equal(f.page.contentActivity.state.name, "waiting");
  const stored = (await f.storage.get(CONTENT_ACTIVITY_KEY)).content_updated_at;
  const rows = db.rows(
    "SELECT principal, content_updated_at FROM pages_catalog_access WHERE page_id = ?",
    pageId,
  );
  assert.ok(rows.length >= 1);
  for (const row of rows) assert.equal(row.content_updated_at, stored, row.principal);
  // The host goes away before the trailing flush.
  f.page.contentActivity.stop();
  await settle(f);

  // A restart restores the stored time; the newest unflushed one is lost.
  const page = emitting(await f.restart());
  await page.watchContent();
  assert.equal(page.contentActivity.value, stored);
  // The first check after the restart projects the title with the time, so
  // a member's Catalog gets it too.
  const check = await f.pageCall("member", "/internal/catalog", {});
  assert.equal(check.body.content_updated_at, stored);
  await settle(f);
  const shared = await f.catalogOf(f.member).storage.get(`shared/${pageId}`);
  assert.equal(shared.content_updated_at, stored);
});

test("the owner's Catalog takes a content report on its own route, and drops one from a clock ahead", async (t) => {
  const f = await fixture(t);
  const { catalog, storage } = f.catalogOf(f.owner);
  const send = (body, path = "/internal/content-activity") =>
    catalog.fetch(
      new Request(`https://pages.internal${path}`, {
        method: "POST",
        body: JSON.stringify({ page_id: pageId, ...body }),
      }),
    );
  const entry = () => storage.get(`page/${pageId}`);
  const before = await entry();
  const now = new Date().toISOString();
  assert.equal((await send({ content_updated_at: now })).status, 200);
  assert.deepEqual(await entry(), { ...before, content_updated_at: now });
  // A content report never names a title: the route refuses one that does.
  const titled = await send({ title: "Untitled", content_updated_at: now });
  assert.equal(titled.status, 400);
  assert.equal((await entry()).title, before.title);
  // A time further ahead than nodes skew changes nothing, on either route.
  const ahead = new Date(Date.now() + CONTENT_ACTIVITY_MAX_SKEW_MS + 60_000).toISOString();
  assert.equal((await send({ content_updated_at: ahead })).status, 200);
  assert.equal((await send({ content_updated_at: ahead }, "/internal/projection")).status, 200);
  assert.equal((await entry()).content_updated_at, now);
  // Page hosts from the first content build send title-less projections; the
  // projection route still reads those as content reports.
  const later = new Date(Date.now() + 1000).toISOString();
  await send({ content_updated_at: later }, "/internal/projection");
  assert.deepEqual(await entry(), { ...before, content_updated_at: later });
});

test("a D1 content report rewrites owner and member rows, never domain readers', and drops a future time", async (t) => {
  const db = sqliteD1(t).open();
  const f = await fixture(t, { env: { DB: db, PAGES_CATALOG_INDEX: "1" } });
  const observed = new Date(Date.now() - 60_000).toISOString();
  await reportPageIndex(f.env, f.page.ctx, {
    metadata: f.page.metadata,
    title: "Launch plan",
    observedAt: observed,
  });
  await db
    .prepare(
      `INSERT INTO pages_catalog_access
        (page_id, principal, role, source, domain, updated_revision, updated_at, title, title_search, created_at)
      VALUES (?, 'user:anaconda-fixture:reader', 'viewer', 'domain_opened', 'example.com', 1, ?, 'Launch plan', 'launch plan', ?)`,
    )
    .bind(pageId, observed, observed)
    .run();
  const rows = () =>
    Object.fromEntries(
      db
        .rows(
          "SELECT source, content_updated_at FROM pages_catalog_access WHERE page_id = ?",
          pageId,
        )
        .map((row) => [row.source, row.content_updated_at]),
    );
  const now = new Date().toISOString();
  await reportContentActivity(f.env, f.page.ctx, { pageId, contentUpdatedAt: now });
  assert.deepEqual(rows(), { owner: now, member: now, domain_opened: null });
  assert.equal(
    db.rows("SELECT content_updated_at FROM pages_catalog_pages WHERE page_id = ?", pageId)[0]
      .content_updated_at,
    now,
  );
  // A domain reader's row catches up when it's next upserted (it copies the
  // Page row's time), as a reconcile or the reader's next open does.
  const ahead = new Date(Date.now() + CONTENT_ACTIVITY_MAX_SKEW_MS + 60_000).toISOString();
  await reportContentActivity(f.env, f.page.ctx, { pageId, contentUpdatedAt: ahead });
  await reportPageIndex(f.env, f.page.ctx, {
    metadata: f.page.metadata,
    title: "Launch plan",
    observedAt: new Date().toISOString(),
    contentUpdatedAt: ahead,
  });
  assert.equal(rows().owner, now, "a time ahead of this clock writes nothing");
  assert.equal(
    db.rows("SELECT content_updated_at FROM pages_catalog_pages WHERE page_id = ?", pageId)[0]
      .content_updated_at,
    now,
  );
});
