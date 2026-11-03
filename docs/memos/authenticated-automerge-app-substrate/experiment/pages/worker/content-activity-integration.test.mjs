import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { pmNodeToSpans } from "@automerge/prosemirror";
import { createPageData, initializePage, orderedBlockIds } from "../model/page.mjs";
import { hasPreservedBlocks } from "../model/raw-migration.mjs";
import { adapter, schema, textPath } from "../model/richtext.mjs";
import { sqliteD1 } from "../test/sqlite-d1.mjs";
import { CONTENT_ACTIVITY_KEY } from "./content-activity.mjs";
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
/** Change the title as a synced peer would: straight into the handle. */
const peerEdit = (page, title) =>
  page.handle.update((doc) =>
    A.change(doc, (draft) => {
      draft.title = title;
    }),
  );

test("content changes record a time; comments, presence and sharing don't", async (t) => {
  const f = await fixture(t);
  await emitting(f.page).watchContent();
  const ownerEntry = () => f.catalogOf(f.owner).storage.get(`page/${pageId}`);
  const comment = await f.tool("member", "manage_page_comment", {
    action: "add",
    block_id: f.blockId,
    body: "One more thought",
    idempotency_key: "content-activity-comment",
  });
  assert.equal(comment.status, 200, JSON.stringify(comment.body));
  const progress = await f.tool("owner", "report_page_progress", { message: "Reading" });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  const sharing = await f.pageCall("owner", "/internal/access", {
    action: "set_role",
    principal: "user:anaconda-fixture:new",
    role: "viewer",
    expected_revision: 1,
    idempotency_key: "content-activity-share",
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
    base_heads: f.heads(),
    idempotency_key: "content-activity-edit",
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

test("the host's own migrations rewrite blocks without recording content activity", async (t) => {
  let doc = A.change(A.from(createPageData({ pageId, title: "Launch plan" })), (draft) =>
    initializePage(draft, "We ship on Friday."),
  );
  const block = orderedBlockIds(doc)[0];
  const tree = schema.node("doc", null, [
    schema.node("paragraph", null, [schema.text("We ship on Friday.")]),
    schema.node("raw", { source: "Old ~~text~~.", importId: "", kind: "markdown" }),
  ]);
  doc = A.change(doc, (draft) =>
    A.updateSpans(
      draft,
      textPath(block),
      pmNodeToSpans(adapter, tree),
      adapter.updateSpansConfig(),
    ),
  );
  const plain = await fixture(t);
  const f = await fixture(t, { auth: plain.auth, docBytes: A.save(doc) });
  A.free(doc);
  await emitting(f.page).watchContent();
  const heads = f.heads();
  await f.page.convertPreservedMarkdown();
  await settle(f);
  assert.equal(hasPreservedBlocks(f.doc()), false);
  assert.notDeepEqual(f.heads(), heads, "the migration changed the document");
  assert.equal(f.page.contentActivity.value, null);
  assert.equal(await f.storage.get(CONTENT_ACTIVITY_KEY), undefined);
  // Observation resumes once it's done.
  await peerEdit(f.page, "Launch plan, revised");
  await settle(f);
  assert.ok(f.page.contentActivity.value);
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
  // Twenty peer changes in a burst: the first flushes, the rest wait.
  for (let n = 0; n < 20; n++) await peerEdit(f.page, `Launch plan ${n}`);
  await settle(f);
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
  f.page.contentActivity.stop();

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
