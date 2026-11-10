import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog } from "./index.mjs";
import { documentMutation } from "./mutations.mjs";
import { reserveOperation } from "./operation-journal.mjs";
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
function fill(storage, count, pending = false) {
  for (let n = 0; n < count; n++)
    storage.values.set(`host/operation/old-${n}`, {
      fingerprint: `fixture-${n}`,
      pending,
      createdAt: "2000-01-01T00:00:00.000Z",
      receipt: { page_id: `deleted-${n}`, deleted: true },
    });
}

test("the 1001st tokenless document receipt evicts the oldest; exact retries and payload guards hold", async () => {
  const storage = new Storage();
  fill(storage, 999);
  let doc = A.from({ page_id: "fixture-page", text: "base" });
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
    args: { idempotency_key: "last-receipt", base_heads: A.getHeads(doc) },
    identity: { principal: "fixture:owner", driver: "test" },
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
    message: "idempotency_key was used for a different request",
  });
  // The lane is full. The next tokenless write makes room by evicting the
  // oldest completed receipt (the unstamped fixture rows sort oldest, in key
  // order), instead of refusing.
  const next = await documentMutation({
    ...context,
    args: { idempotency_key: "next-receipt", base_heads: A.getHeads(doc) },
    apply(draft) {
      draft.text = "accepted after eviction";
    },
  });
  assert.equal(applications, 2);
  assert.deepEqual(A.getHeads(doc), next.heads);
  const keys = [...(await storage.list({ prefix: "host/operation/" })).keys()];
  assert.equal(keys.length, 1000);
  assert.ok(!keys.includes("host/operation/old-0"), "the oldest receipt was evicted");
  assert.ok(keys.includes("host/operation/old-1"));
  assert.ok(keys.includes("host/operation/last-receipt"), "the newest receipts stay");
  assert.ok(keys.includes("host/operation/next-receipt"));
  // Both recent keys still replay without applying again.
  assert.deepEqual(await documentMutation(context), receipt);
  assert.equal(applications, 2);
});

test("pending tokenless entries never release capacity by age", async () => {
  const storage = new Storage();
  fill(storage, 1000, true);
  await assert.rejects(
    reserveOperation(storage, {
      key: "host/operation/new-legacy-request",
      entry: { fingerprint: "new", pending: true },
    }),
    { status: 429, code: "pending_operation_capacity" },
  );
  assert.equal((await storage.list({ prefix: "host/operation/" })).size, 1000);
});

test("completed tokenless receipts make room for a new one, oldest stamp first", async () => {
  const storage = new Storage();
  fill(storage, 1000);
  // Stamped rows are newer than the unstamped fixture rows; among stamped
  // rows the smallest stamp goes first.
  storage.values.get("host/operation/old-5").recordedAt = 10;
  storage.values.get("host/operation/old-6").recordedAt = 5;
  const admitted = await reserveOperation(storage, {
    key: "host/operation/new-legacy-request",
    entry: { fingerprint: "new", pending: true },
    now: 1000,
  });
  assert.equal(admitted.recordedAt, 1000);
  const after = await storage.list({ prefix: "host/operation/" });
  assert.equal(after.size, 999, "reserve only makes room; the caller stores the entry");
  assert.ok(!after.has("host/operation/old-0"), "unstamped rows are the oldest");
  assert.ok(after.has("host/operation/old-5") && after.has("host/operation/old-6"));
  for (let n = 1; n < 1000; n++) storage.values.delete(`host/operation/old-${n}`);
  storage.values.set("host/operation/old-5", {
    fingerprint: "a",
    pending: false,
    receipt: {},
    recordedAt: 10,
  });
  storage.values.set("host/operation/old-6", {
    fingerprint: "b",
    pending: false,
    receipt: {},
    recordedAt: 5,
  });
  for (let n = 0; n < 998; n++)
    storage.values.set(`host/operation/stamped-${String(n).padStart(4, "0")}`, {
      fingerprint: `s-${n}`,
      pending: false,
      receipt: {},
      recordedAt: 100 + n,
    });
  await reserveOperation(storage, {
    key: "host/operation/another-request",
    entry: { fingerprint: "new", pending: true },
    now: 5000,
  });
  const next = await storage.list({ prefix: "host/operation/" });
  assert.ok(!next.has("host/operation/old-6"), "the smallest stamp went first");
  assert.ok(next.has("host/operation/old-5"));
});

for (const operation of ["create_page", "delete_page"]) {
  test(`a catalog full of tokenless deletion receipts still admits a new tokenless ${operation}`, async (t) => {
    const auth = await createAuthFixture();
    t.mock.method(globalThis, "fetch", auth.fetch);
    const storage = new Storage();
    fill(storage, 1000);
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
            idempotency_key: "new-operation",
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
      args: { idempotency_key: "internal:preserved_markdown_two", base_heads: [] },
      identity: { principal: "user:one", driver: "API" },
      apply: () => {},
      flush: async () => {},
    }),
    { code: "invalid_idempotency_key" },
  );
});

test("1,500 tokenless comment writes leave the Page writable; the token lane keeps its window", async (t) => {
  const f = await fixture(t);
  const journal = () => f.storage.list({ prefix: "host/operation/" });
  // The first 1,000 comments' receipts, as the host holds them once the lane
  // is full. (Writing them through the fixture would save the whole comments
  // document 1,000 times.) The next 500 go through the host.
  for (let n = 0; n < 1000; n++)
    await f.storage.put(`host/operation/comment-${String(n).padStart(4, "0")}`, {
      fingerprint: `comment-${n}`,
      pending: false,
      doc: "comments",
      receipt: { page_id: pageId, result: { thread_id: `thread-${n}` } },
      recordedAt: 1_700_000_000_000 + n,
    });
  assert.equal((await journal()).size, 1000);
  for (let n = 1000; n < 1500; n++) {
    const added = await f.tool("owner", "manage_page_comment", {
      idempotency_key: `comment-${String(n).padStart(4, "0")}`,
      action: "add",
      block_id: f.blockId,
      body: `Comment ${n}`,
    });
    assert.equal(added.status, 200, `comment ${n}: ${JSON.stringify(added.body)}`);
  }
  const retained = await journal();
  assert.equal(retained.size, 1000, "the tokenless lane holds its newest 1,000 receipts");
  assert.ok(!retained.has("host/operation/comment-0499"), "the oldest 500 receipts were evicted");
  assert.ok(retained.has("host/operation/comment-0500"));
  assert.equal(Object.keys(f.commentsDoc().threads).length, 501);
  // A tokenless edit still lands.
  const edit = await f.tool("owner", "patch_page", {
    idempotency_key: "edit-after-the-discussion",
    base_heads: f.heads(),
    operations: [
      { op: "replace_match", block_id: f.blockId, match_text: "Friday", replacement: "Monday" },
    ],
  });
  assert.equal(edit.status, 200, JSON.stringify(edit.body));
  assert.deepEqual(f.heads(), edit.body.heads);
  // Its receipt replays exactly and guards its payload.
  const again = await f.tool("owner", "patch_page", {
    idempotency_key: "edit-after-the-discussion",
    base_heads: edit.body.heads,
    operations: [
      { op: "replace_match", block_id: f.blockId, match_text: "Friday", replacement: "Monday" },
    ],
  });
  assert.equal(again.status, 409, "a changed payload under the same key conflicts");
  assert.equal(again.body.code, "idempotency_conflict");
  // So does a comment that came in late enough to keep its receipt.
  const recent = await f.tool("owner", "manage_page_comment", {
    idempotency_key: "comment-1499",
    action: "add",
    block_id: f.blockId,
    body: "Comment 1499",
  });
  assert.equal(recent.status, 200);
  assert.equal(Object.keys(f.commentsDoc().threads).length, 501, "an exact retry replays");
  // The token lane is untouched by all of this and keeps its own window.
  const read = await f.tool("owner", "read_page", { include_content: false });
  const tokened = {
    idempotency_key: `${read.body.retry_key_prefix}first-request`,
    retry_token: read.body.retry_token,
    base_heads: read.body.heads,
    operations: [{ op: "set_title", title: "With a token" }],
  };
  const first = await f.tool("owner", "edit_page", tokened);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const replay = await f.tool("owner", "edit_page", tokened);
  assert.deepEqual(replay.body, first.body, "an exact retry replays the receipt");
  const changed = await f.tool("owner", "edit_page", {
    ...tokened,
    operations: [{ op: "set_title", title: "Another title" }],
  });
  assert.equal(changed.body.code, "idempotency_conflict");
  // A full retry window still refuses new tokened work, as before.
  const stored = await f.storage.get(`host/operation/${tokened.idempotency_key}`);
  for (let n = 0; n < 999; n++)
    await f.storage.put(
      `host/operation/${read.body.retry_key_prefix}filler-${String(n).padStart(4, "0")}`,
      {
        fingerprint: `filler-${n}`,
        pending: false,
        retry: stored.retry,
        receipt: {},
      },
    );
  const full = await f.tool("owner", "edit_page", {
    ...tokened,
    idempotency_key: `${read.body.retry_key_prefix}second-request`,
    base_heads: f.heads(),
  });
  assert.equal(full.status, 429, JSON.stringify(full.body));
  assert.equal(full.body.code, "operation_receipt_capacity");
  assert.match(full.body.error, /active retry window is full/);
  // And the tokenless lane still takes a comment beside the full token lane.
  const beside = await f.tool("owner", "manage_page_comment", {
    idempotency_key: "comment-beside-a-full-window",
    action: "add",
    block_id: f.blockId,
    body: "Still commenting",
  });
  assert.equal(beside.status, 200, JSON.stringify(beside.body));
});

/** `count` tokenless receipts, as the host holds them once its lane is full,
 * stamped from `since` upward. */
async function fillTokenless(storage, count, since = 1_700_000_000_000) {
  for (let n = 0; n < count; n++)
    await storage.put(`host/operation/filler-${String(n).padStart(5, "0")}`, {
      fingerprint: `filler-${n}`,
      pending: false,
      doc: "comments",
      receipt: { page_id: pageId, result: { thread_id: `thread-${n}` } },
      recordedAt: since + n,
    });
}

test("after a lost response, a tokened retry replays through eviction; a tokenless one is a new write", async (t) => {
  const f = await fixture(t);
  const threads = () => Object.keys(f.commentsDoc().threads).length;
  const read = await f.tool("owner", "read_page", { include_content: false });
  const tokened = {
    idempotency_key: `${read.body.retry_key_prefix}lost-response`,
    retry_token: read.body.retry_token,
    action: "add",
    block_id: f.blockId,
    body: "Tokened comment",
  };
  const plain = {
    idempotency_key: "tokenless-lost-response",
    action: "add",
    block_id: f.blockId,
    body: "Tokenless comment",
  };
  const first = await f.tool("owner", "manage_page_comment", tokened);
  const second = await f.tool("owner", "manage_page_comment", plain);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(threads(), 3);
  // The client never saw either response. Meanwhile the Page takes 1,000 more
  // tokenless writes, enough to evict every earlier tokenless receipt.
  await fillTokenless(f.storage, 999, Date.now() + 60_000);
  const push = await f.tool("owner", "manage_page_comment", {
    idempotency_key: "the-one-that-evicts",
    action: "add",
    block_id: f.blockId,
    body: "Pushes the oldest out",
  });
  assert.equal(push.status, 200, JSON.stringify(push.body));
  assert.equal(await f.storage.get("host/operation/tokenless-lost-response"), undefined);
  assert.ok(
    await f.storage.get(`host/operation/${tokened.idempotency_key}`),
    "the token lane kept its receipt",
  );
  assert.equal(threads(), 4);
  // The tokened retry replays: same receipt, no second comment.
  const replay = await f.tool("owner", "manage_page_comment", tokened);
  assert.deepEqual(replay.body, first.body);
  assert.equal(threads(), 4);
  // The tokenless retry is a new request: it applies again. That is why the
  // MCP layer tells a tokenless caller to read back and reconcile instead.
  const again = await f.tool("owner", "manage_page_comment", plain);
  assert.equal(again.status, 200);
  assert.notEqual(again.body.result.thread_id, second.body.result.thread_id);
  assert.equal(threads(), 5);
});

test("eviction order comes from the stored stamp, so it survives a restart", async (t) => {
  const f = await fixture(t);
  await fillTokenless(f.storage, 1000);
  // Give two receipts stamps out of key order, as writes at different times do.
  const early = await f.storage.get("host/operation/filler-00500");
  await f.storage.put("host/operation/filler-00500", { ...early, recordedAt: 1 });
  const late = await f.storage.get("host/operation/filler-00000");
  await f.storage.put("host/operation/filler-00000", { ...late, recordedAt: 2_000_000_000_000 });
  await f.restart();
  const write = await f.tool("owner", "manage_page_comment", {
    idempotency_key: "after-restart",
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
  for (let n = 0; n < 1000; n++)
    storage.values.set(`host/operation/same-${String(n).padStart(4, "0")}`, {
      fingerprint: `same-${n}`,
      pending: false,
      receipt: {},
      recordedAt: 5,
    });
  const now = 9;
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
