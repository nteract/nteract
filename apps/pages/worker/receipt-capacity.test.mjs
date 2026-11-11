import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { Catalog } from "./index.mjs";
import { COMMENTS_DOC, documentMutation, operationKey } from "./mutations.mjs";
import { HORIZON, readRevision, reserveOperation } from "./operation-journal.mjs";
import { fixture, pageId } from "./trash-fixture.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
  async sync() {}
}
/** `count` receipts, `pending` or completed. Stamped from `at` upward when
 * `at` is given; unstamped ones sort oldest. */
function fill(storage, count, { pending = false, at } = {}) {
  for (let n = 0; n < count; n++)
    storage.values.set(`host/operation/old-${n}`, {
      fingerprint: `fixture-${n}`,
      pending,
      createdAt: "2000-01-01T00:00:00.000Z",
      receipt: { page_id: `deleted-${n}`, deleted: true },
      ...(at !== undefined && { recordedAt: at + n }),
    });
}
// Receipts recorded within the last hour: inside their lifetime.
const recent = () => Date.now() - 60 * 60 * 1000;

test("the 1001st document receipt evicts the oldest; exact retries and payload guards hold", async () => {
  const storage = new Storage();
  fill(storage, 999, { at: recent() });
  let doc = A.from({ page_id: "fixture-page", text: "base" });
  const identity = { principal: "fixture:owner", driver: "test" };
  const revision = () => readRevision(storage, "page", A.getHeads(doc));
  const keyOf = (nonce) => operationKey({ nonce }, identity, "page");
  let applications = 0;
  const context = {
    storage,
    handle: {
      doc: () => doc,
      async update(fn) {
        applications++;
        doc = fn(doc);
      },
    },
    operation: "edit_page",
    args: { nonce: "last-receipt", revision: await revision() },
    identity,
    apply(draft) {
      draft.text = "accepted exactly once";
    },
    flush: async () => {},
  };
  const receipt = await documentMutation(context);
  assert.equal((await storage.list({ prefix: "host/operation/" })).size, 1000);
  assert.deepEqual(await documentMutation(context), receipt);
  await assert.rejects(documentMutation({ ...context, args: { ...context.args, extra: true } }), {
    status: 409,
    message: "This nonce was used for a different request",
  });
  // The lane is full. The next write makes room by evicting the oldest
  // completed receipt, instead of refusing.
  const next = await documentMutation({
    ...context,
    args: { nonce: "next-receipt", revision: await revision() },
    apply(draft) {
      draft.text = "accepted after eviction";
    },
  });
  assert.equal(applications, 2);
  assert.equal(next.revision, await revision());
  const keys = [...(await storage.list({ prefix: "host/operation/" })).keys()];
  assert.equal(keys.length, 1000);
  assert.ok(!keys.includes("host/operation/old-0"), "the oldest receipt was evicted");
  assert.ok(keys.includes("host/operation/old-1"));
  assert.ok(keys.includes(await keyOf("last-receipt")), "the newest receipts stay");
  assert.ok(keys.includes(await keyOf("next-receipt")));
  // Both recent keys still replay without applying again.
  assert.deepEqual(await documentMutation(context), receipt);
  assert.equal(applications, 2);
});

test("pending entries never release capacity by age", async () => {
  const storage = new Storage();
  fill(storage, 1000, { pending: true });
  await assert.rejects(
    reserveOperation(storage, {
      key: "host/operation/new-request",
      entry: { fingerprint: "new", pending: true },
    }),
    { status: 429, code: "pending_operation_capacity" },
  );
  assert.equal((await storage.list({ prefix: "host/operation/" })).size, 1000);
});

test("completed receipts make room for a new one, oldest stamp first", async () => {
  const storage = new Storage();
  const base = recent();
  fill(storage, 1000, { at: base });
  // Two receipts recorded earlier than their keys suggest.
  storage.values.get("host/operation/old-5").recordedAt = base - 10;
  storage.values.get("host/operation/old-6").recordedAt = base - 20;
  const admitted = await reserveOperation(storage, {
    key: "host/operation/new-request",
    entry: { fingerprint: "new", pending: true },
    now: base + 5000,
  });
  assert.equal(admitted.recordedAt, base + 5000);
  const after = await storage.list({ prefix: "host/operation/" });
  assert.equal(after.size, 999, "reserve only makes room; the caller stores the entry");
  assert.ok(!after.has("host/operation/old-6"), "the smallest stamp went first");
  assert.ok(after.has("host/operation/old-5") && after.has("host/operation/old-0"));
  // A receipt without a stamp counts as the oldest: it is past its lifetime.
  delete storage.values.get("host/operation/old-900").recordedAt;
  await reserveOperation(storage, {
    key: "host/operation/another-request",
    entry: { fingerprint: "new", pending: true },
    now: base + 6000,
  });
  const next = await storage.list({ prefix: "host/operation/" });
  assert.ok(!next.has("host/operation/old-900"));
  assert.ok(next.has("host/operation/old-5"));
});

for (const operation of ["create_page", "delete_page"]) {
  test(`a catalog full of deletion receipts still admits a new ${operation}`, async (t) => {
    const auth = await createAuthFixture();
    t.mock.method(globalThis, "fetch", auth.fetch);
    const storage = new Storage();
    fill(storage, 1000, { at: recent() });
    let pageRequests = 0;
    const catalog = new Catalog(
      { id: { name: `user:anaconda-fixture:${auth.subject}` }, storage },
      {
        ...auth.env,
        PAGES: {
          getByName: () => {
            pageRequests++;
            throw Error("the fixture stops once the Page is contacted");
          },
        },
      },
    );
    const response = await catalog.fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${auth.apiKey()}` },
        body: JSON.stringify({
          operation,
          arguments: {
            page_id: "33333333-3333-4333-8333-333333333333",
            title: "New Page",
            nonce: "new-operation",
          },
        }),
      }),
    );
    assert.notEqual(response.status, 429, await response.text());
    assert.equal(pageRequests, 1, "the request was admitted and reached the Page");
    const keys = await storage.list({ prefix: "host/operation/" });
    assert.ok(!keys.has("host/operation/old-0"), "the oldest receipt made room");
    assert.ok(keys.size <= 1000);
  });
}

test("host migrations reserve in their own key space, past full client budgets", async () => {
  const { INTERNAL_PREFIX } = await import("./operation-journal.mjs");
  const storage = new Storage();
  fill(storage, 1000);
  const entry = (n) => ({ fingerprint: `migration-${n}`, pending: true, changes: [] });
  // Pending client work fills the client lane; the internal key space is apart.
  for (const value of storage.values.values()) value.pending = true;
  await assert.rejects(
    reserveOperation(storage, { key: "host/operation/client-new", entry: entry(0) }),
    { code: "pending_operation_capacity" },
  );
  const key = `${INTERNAL_PREFIX}preserved_markdown_one`;
  assert.deepEqual(await reserveOperation(storage, { key, entry: entry(1) }), entry(1));
  // A finished migration receipt is dropped when the next one reserves.
  storage.values.set(key, { ...entry(1), pending: false });
  await reserveOperation(storage, {
    key: `${INTERNAL_PREFIX}preserved_markdown_two`,
    entry: entry(2),
  });
  assert.equal(storage.values.has(key), false);
  // Client keys can't name the internal space.
  await assert.rejects(
    documentMutation({
      storage,
      handle: { doc: () => A.from({ page_id: "p" }) },
      operation: "edit_page",
      args: { nonce: "internal:preserved_markdown_two", revision: "r1" },
      identity: { principal: "user:one", driver: "API" },
      apply: () => {},
      flush: async () => {},
    }),
    { code: "invalid_nonce" },
  );
});

test("1,500 comment writes leave the Page writable, and recent receipts still replay", async (t) => {
  const f = await fixture(t);
  const journal = () => f.storage.list({ prefix: "host/operation/" });
  // The first 1,000 comments' receipts, as the host holds them once the lane
  // is full. (Writing them through the fixture would save the whole comments
  // document 1,000 times.) The next 500 go through the host.
  const since = recent();
  for (let n = 0; n < 1000; n++)
    await f.storage.put(`host/operation/comment-${String(n).padStart(4, "0")}`, {
      fingerprint: `comment-${n}`,
      pending: false,
      doc: "comments",
      receipt: { page_id: pageId, result: { thread_id: `thread-${n}` } },
      recordedAt: since + n,
    });
  assert.equal((await journal()).size, 1000);
  for (let n = 1000; n < 1500; n++) {
    const added = await f.tool("owner", "manage_page_comment", {
      nonce: `comment-${String(n).padStart(4, "0")}`,
      action: "add",
      block_id: f.blockId,
      body: `Comment ${n}`,
    });
    assert.equal(added.status, 200, `comment ${n}: ${JSON.stringify(added.body)}`);
  }
  const retained = await journal();
  assert.equal(retained.size, 1000, "the lane holds its newest 1,000 receipts");
  assert.ok(!retained.has("host/operation/comment-0499"), "the oldest 500 receipts were evicted");
  assert.ok(retained.has("host/operation/comment-0500"));
  assert.equal(Object.keys(f.commentsDoc().threads).length, 501);
  // An edit still lands.
  const edit = await f.tool("owner", "edit_page", {
    nonce: "edit-after-the-discussion",
    revision: await f.revision(),
    operations: [
      { op: "replace_match", block_id: f.blockId, match_text: "Friday", replacement: "Monday" },
    ],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(f.heads(), await f.headsOf(edit.body.revision));
  // Its receipt replays exactly and guards its payload.
  const again = await f.tool("owner", "edit_page", {
    nonce: "edit-after-the-discussion",
    revision: edit.body.revision,
    operations: [
      { op: "replace_match", block_id: f.blockId, match_text: "Friday", replacement: "Monday" },
    ],
  });
  assert.equal(again.status, 409, "a changed payload under the same key conflicts");
  assert.equal(again.body.code, "nonce_conflict");
  // So does a comment that came in late enough to keep its receipt.
  const recentComment = await f.tool("owner", "manage_page_comment", {
    nonce: "comment-1499",
    action: "add",
    block_id: f.blockId,
    body: "Comment 1499",
  });
  assert.equal(recentComment.status, 200);
  assert.equal(Object.keys(f.commentsDoc().threads).length, 501, "an exact retry replays");
});

/** `count` receipts, as the host holds them once its lane is full, stamped
 * from `since` upward. */
async function fillReceipts(storage, count, since = recent()) {
  for (let n = 0; n < count; n++)
    await storage.put(`host/operation/filler-${String(n).padStart(5, "0")}`, {
      fingerprint: `filler-${n}`,
      pending: false,
      doc: "comments",
      receipt: { page_id: pageId, result: { thread_id: `thread-${n}` } },
      recordedAt: since + n,
    });
}

test("after a lost response, an edit retry past its evicted receipt is refused, not applied again", async (t) => {
  const f = await fixture(t);
  const args = {
    nonce: "lost-response",
    revision: await f.revision(),
    operations: [{ op: "set_title", title: "Edited once" }],
  };
  const first = await f.tool("owner", "edit_page", args);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  // The client never saw the response. Meanwhile the Page takes enough later
  // writes to evict the edit's receipt.
  await fillReceipts(f.storage, 999, Date.now() + 60_000);
  const push = await f.tool("owner", "manage_page_comment", {
    nonce: "the-one-that-evicts",
    action: "add",
    block_id: f.blockId,
    body: "Pushes the oldest out",
  });
  assert.equal(push.status, 200, JSON.stringify(push.body));
  assert.equal(
    await f.storage.get(await f.receiptKey("lost-response", f.owner, "page")),
    undefined,
  );
  // The edit's own revision was minted with its receipt, at or before the
  // horizon the eviction raised, so the retry can't be told from a new edit.
  const heads = f.heads();
  const retry = await f.tool("owner", "edit_page", args);
  assert.equal(retry.status, 409, JSON.stringify(retry.body));
  assert.equal(retry.body.code, "resync_required");
  assert.deepEqual(await f.headsOf(retry.body.current_revision), heads);
  assert.deepEqual(f.heads(), heads, "nothing was applied again");
});

test("eviction order comes from the stored stamp, so it survives a restart", async (t) => {
  const f = await fixture(t);
  await fillReceipts(f.storage, 1000);
  // Give two receipts stamps out of key order, as writes at different times do.
  const early = await f.storage.get("host/operation/filler-00500");
  await f.storage.put("host/operation/filler-00500", { ...early, recordedAt: 1 });
  const late = await f.storage.get("host/operation/filler-00000");
  await f.storage.put("host/operation/filler-00000", { ...late, recordedAt: 2_000_000_000_000 });
  await f.restart();
  const write = await f.tool("owner", "manage_page_comment", {
    nonce: "after-restart",
    action: "add",
    block_id: f.blockId,
    body: "After a restart",
  });
  assert.equal(write.status, 200, JSON.stringify(write.body));
  const keys = await f.storage.list({ prefix: "host/operation/" });
  assert.equal(keys.has("host/operation/filler-00500"), false, "the smallest stamp went first");
  assert.ok(keys.has("host/operation/filler-00000"), "a newer stamp stays whatever its key");
  assert.ok(keys.has("host/operation/filler-00001"));
  assert.equal(keys.size, 1000);
});

test("two admissions at capacity in one tick each evict one receipt; equal stamps break by key", async () => {
  const storage = new Storage();
  const base = recent();
  for (let n = 0; n < 1000; n++)
    storage.values.set(`host/operation/same-${String(n).padStart(4, "0")}`, {
      fingerprint: `same-${n}`,
      pending: false,
      receipt: {},
      recordedAt: base,
    });
  const now = base + 4;
  for (const key of ["host/operation/first-new", "host/operation/second-new"]) {
    const admitted = await reserveOperation(storage, {
      key,
      entry: { fingerprint: key, pending: true },
      now,
    });
    assert.equal(admitted.recordedAt, now);
    await storage.put(key, { ...admitted, pending: false });
  }
  const keys = await storage.list({ prefix: "host/operation/" });
  assert.equal(keys.size, 1000);
  assert.equal(keys.has("host/operation/same-0000"), false);
  assert.equal(keys.has("host/operation/same-0001"), false, "the tie broke by key, oldest first");
  assert.ok(keys.has("host/operation/same-0002"));
  assert.ok(keys.has("host/operation/first-new") && keys.has("host/operation/second-new"));
  // A third write with the same stamp as the two new ones evicts an older
  // receipt, never one of them.
  await reserveOperation(storage, {
    key: "host/operation/third-new",
    entry: { fingerprint: "third", pending: true },
    now,
  });
  const after = await storage.list({ prefix: "host/operation/" });
  assert.equal(after.has("host/operation/same-0002"), false);
  assert.ok(after.has("host/operation/first-new") && after.has("host/operation/second-new"));
});

const identity = { principal: "fixture:owner", driver: "test" };
// One instant for every stamp: the receipts, the read and the writes.
const FROZEN = Date.parse("2026-11-11T12:00:00.000Z");

/** A Page host on a clock frozen at `at`, its journal full of 1,000
 * completed receipts stamped `at`, its stored horizon below `at`. */
function frozenAtCapacity(t, at) {
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const storage = new Storage();
  for (let n = 0; n < 1000; n++)
    storage.values.set(`host/operation/old-${String(n).padStart(4, "0")}`, {
      fingerprint: `fixture-${n}`,
      pending: false,
      createdAt: "2000-01-01T00:00:00.000Z",
      receipt: { page_id: `deleted-${n}`, deleted: true },
      recordedAt: at,
    });
  let page = A.from({ page_id: "fixture-page", text: "base" });
  const edit = (args, text) =>
    documentMutation({
      storage,
      handle: {
        doc: () => page,
        async update(fn) {
          page = fn(page);
        },
      },
      operation: "edit_page",
      args,
      identity,
      apply(draft) {
        draft.text = text;
      },
      flush: async () => {},
    });
  return { storage, page: () => page, edit };
}

test("at capacity on a frozen clock, an edit's receipt revision is good for the next edit", async (t) => {
  const w = frozenAtCapacity(t, FROZEN);
  const read = await readRevision(w.storage, "page", A.getHeads(w.page()));
  assert.equal(await w.storage.get(HORIZON), undefined, "the stored horizon starts below the read");
  // The reservation evicts a receipt stamped at the read's instant, so the
  // horizon reaches the read's handle.
  const first = await w.edit({ nonce: "first-edit", revision: read }, "first");
  assert.equal(await w.storage.get(HORIZON), FROZEN);
  assert.equal(Date.now(), FROZEN, "no time passed");
  // The next write names the revision that receipt returned, with no read.
  const second = await w.edit({ nonce: "second-edit", revision: first.revision }, "second");
  assert.equal(w.page().text, "second");
  assert.notEqual(second.revision, first.revision);
});

test("at capacity on a frozen clock, a passage comment's Page revision is good for the next edit", async (t) => {
  const w = frozenAtCapacity(t, FROZEN);
  let comments = A.from({ page_id: "fixture-page", threads: [] });
  const read = await readRevision(w.storage, "page", A.getHeads(w.page()));
  assert.equal(await w.storage.get(HORIZON), undefined, "the stored horizon starts below the read");
  const comment = await documentMutation({
    storage: w.storage,
    handle: {
      doc: () => comments,
      async update(fn) {
        comments = fn(comments);
      },
    },
    doc: COMMENTS_DOC,
    pageId: "fixture-page",
    operation: "manage_page_comment",
    args: { nonce: "passage-comment", action: "add", revision: read },
    identity,
    baseRevision: (input) => input.revision,
    // A passage comment checks its own anchor; this one always holds.
    guard: () => null,
    // As the Page host does: the Page revision this write read.
    receiptFields: async (plan) => ({
      revision: await plan.handle("page", A.getHeads(w.page())),
    }),
    pageHeads: () => A.getHeads(w.page()),
    apply(draft) {
      draft.threads.push("a passage comment");
    },
    flush: async () => {},
  });
  assert.equal(await w.storage.get(HORIZON), FROZEN);
  assert.match(comment.revision, /^r\d+$/);
  // The comment left the Page where the read found it. An edit against the
  // Page revision its receipt names, with no read between, applies.
  await w.edit({ nonce: "after-comment", revision: comment.revision }, "after the comment");
  assert.equal(w.page().text, "after the comment");
});
