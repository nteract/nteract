import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog, Page } from "./index.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { retryKey } from "../model/retry-key.mjs";
import { applyPageOperation, createPageData, initializePage } from "../model/page.mjs";
import { documentMutation, recoverDocumentMutations } from "./mutations.mjs";
import { issueRetryToken, JOURNAL_LIMITS, RETRY_LIFETIME_MS } from "./operation-journal.mjs";

const start = Date.parse("2026-10-25T00:00:00Z");
const pageId = "33333333-3333-4333-8333-333333333333";
class Storage {
  values = new Map();
  durable = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
  async sync() {
    this.durable = structuredClone(this.values);
  }
}
function fixture() {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "base", edits: 0 });
  let applications = 0;
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const identity = { principal: "user:fixture:owner", driver: "ChatGPT" };
  const context = {
    storage,
    handle,
    operation: "edit_page",
    identity,
    apply(draft) {
      applications++;
      draft.edits++;
      A.updateText(draft, ["text"], `edit ${draft.edits}`);
    },
    flush: async () => storage.sync(),
  };
  const token = () =>
    issueRetryToken(storage, { scope: `page:${pageId}`, principal: identity.principal });
  return { storage, handle, identity, context, token, applications: () => applications };
}
async function argsFor(f, token, key) {
  return {
    idempotency_key: await retryKey(token, key),
    base_heads: A.getHeads(f.handle.doc()),
    retry_token: token,
  };
}
function legacyReceipts(storage) {
  for (let index = 0; index < JOURNAL_LIMITS.entries; index++)
    storage.values.set(`host/operation/legacy-${String(index).padStart(5, "0")}`, {
      fingerprint: `fixture-${index}`,
      pending: false,
      receipt: { accepted: index },
    });
}

test("documentMutation preserves exact versioned retries and rejects changed payloads or principals", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = fixture();
  const issued = await f.token();
  const args = await argsFor(f, issued.retry_token, "versioned-edit");
  const receipt = await documentMutation({ ...f.context, args });
  assert.deepEqual(await documentMutation({ ...f.context, args }), receipt);
  assert.equal(f.applications(), 1);
  assert.equal(f.handle.doc().edits, 1);
  assert.deepEqual(A.getHeads(f.handle.doc()), receipt.heads);
  await assert.rejects(documentMutation({ ...f.context, args: { ...args, extra: true } }), {
    status: 409,
  });
  await assert.rejects(
    documentMutation({
      ...f.context,
      identity: { ...f.identity, principal: "user:fixture:other" },
      args: await argsFor(f, issued.retry_token, "different-user"),
    }),
    { status: 400, code: "invalid_retry_token" },
  );
  assert.equal(f.applications(), 1);
});

test("new-intent preparation cannot bypass a concurrently changed head guard", async () => {
  const f = fixture();
  const { retry_token } = await f.token();
  const args = await argsFor(f, retry_token, "preflight-race");
  await assert.rejects(
    documentMutation({
      ...f.context,
      args,
      prepare: async () => {
        await f.handle.update((doc) =>
          A.change(doc, (draft) => {
            draft.concurrent = true;
          }),
        );
      },
    }),
    { status: 409 },
  );
  assert.equal(f.applications(), 0);
  assert.equal(f.handle.doc().concurrent, true);
  assert.equal(await f.storage.get(`host/operation/${args.idempotency_key}`), undefined);
});

test("pending and completed retries preserve receipts without repeating external preparation", async () => {
  const f = fixture();
  const { retry_token } = await f.token();
  const args = await argsFor(f, retry_token, "preflight-retry");
  let prepared = 0,
    flushes = 0;
  await assert.rejects(
    documentMutation({
      ...f.context,
      args,
      prepare: async () => {
        prepared++;
      },
      flush: async () => {
        if (++flushes === 2) throw Error("Interrupted durability");
        await f.context.flush();
      },
    }),
    /Interrupted durability/,
  );
  const entry = await f.storage.get(`host/operation/${args.idempotency_key}`);
  assert.equal(entry.pending, true);
  const retry = {
    ...f.context,
    args,
    prepare: async () => assert.fail("External asset/source rechecked on retry"),
  };
  assert.deepEqual(await documentMutation(retry), entry.receipt);
  assert.deepEqual(await documentMutation(retry), entry.receipt);
  assert.equal(prepared, 1);
  assert.equal(f.applications(), 1);
});

test("expired document retries never execute after retirement or token stripping", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  const issued = await f.token();
  const args = await argsFor(f, issued.retry_token, "retired-edit");
  await documentMutation({ ...f.context, args });
  now += RETRY_LIFETIME_MS;
  const renewed = await f.token();
  await documentMutation({
    ...f.context,
    args: await argsFor(f, renewed.retry_token, "collect-retired"),
  });
  assert.equal(await f.storage.get(`host/operation/${args.idempotency_key}`), undefined);
  await assert.rejects(
    documentMutation({ ...f.context, args: { ...args, retry_token: renewed.retry_token } }),
    {
      status: 400,
      code: "invalid_retry_token",
    },
  );
  for (const request of [args, await argsFor(f, issued.retry_token, "never-attempted")])
    await assert.rejects(documentMutation({ ...f.context, args: request }), {
      status: 410,
      code: "retry_expired",
    });
  const stripped = { ...args, base_heads: A.getHeads(f.handle.doc()) };
  delete stripped.retry_token;
  await assert.rejects(documentMutation({ ...f.context, args: stripped }), {
    status: 400,
    code: "invalid_retry_token",
  });
  assert.equal(f.applications(), 2);
  assert.equal(f.handle.doc().edits, 2);
});

test("1000 retained legacy receipts do not block new versioned document work", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = fixture();
  legacyReceipts(f.storage);
  const issued = await f.token();
  const args = await argsFor(f, issued.retry_token, "fresh-versioned-edit");
  const receipt = await documentMutation({ ...f.context, args });
  assert.deepEqual(await documentMutation({ ...f.context, args }), receipt);
  assert.equal(f.applications(), 1);
  assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, 1001);
  assert.equal((await f.storage.get("host/operation/legacy-00000")).receipt.accepted, 0);
});

test("document edits continue beyond 1000 lifetime operations after the promised retry window closes", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = fixture();
  const issued = await f.token();
  let first;
  for (let index = 0; index < JOURNAL_LIMITS.entries; index++) {
    const args = await argsFor(
      f,
      issued.retry_token,
      `window-one-${String(index).padStart(5, "0")}`,
    );
    first ??= args;
    await documentMutation({ ...f.context, args });
  }
  assert.equal(f.handle.doc().edits, 1000);
  now += RETRY_LIFETIME_MS;
  const renewed = await f.token();
  assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, 1000);
  const next = await argsFor(f, renewed.retry_token, "window-two-first");
  const receipt = await documentMutation({ ...f.context, args: next });
  assert.equal(f.handle.doc().edits, 1001);
  assert.deepEqual(await documentMutation({ ...f.context, args: next }), receipt);
  await assert.rejects(documentMutation({ ...f.context, args: first }), {
    status: 410,
    code: "retry_expired",
  });
  assert.equal(f.applications(), 1001);
  assert.equal(f.handle.doc().edits, 1001);
  assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, 1);
});

for (const recovery of ["retry", "startup"]) {
  test(`expired pending document intent survives and completes through ${recovery}`, async (t) => {
    let now = start;
    t.mock.method(Date, "now", () => now);
    const f = fixture();
    const issued = await f.token();
    const args = await argsFor(f, issued.retry_token, "interrupted-edit");
    let flushes = 0;
    await assert.rejects(
      documentMutation({
        ...f.context,
        args,
        async flush() {
          if (++flushes === 2) throw Error("interrupted persistence");
          await f.context.flush();
        },
      }),
      /interrupted persistence/,
    );
    const entry = await f.storage.get(`host/operation/${args.idempotency_key}`);
    assert.equal(entry.pending, true);
    assert.equal(f.applications(), 1);
    now += RETRY_LIFETIME_MS * 2;
    await f.token();
    assert.deepEqual(await f.storage.get(`host/operation/${args.idempotency_key}`), entry);
    if (recovery === "startup") {
      await recoverDocumentMutations(f.storage, f.handle, f.context.flush);
      assert.equal((await f.storage.get(`host/operation/${args.idempotency_key}`)).pending, false);
      // Terminal recovery preserves the original retry deadline, never reauthoring.
      await assert.rejects(documentMutation({ ...f.context, args }), {
        status: 410,
        code: "retry_expired",
      });
    } else {
      assert.deepEqual(await documentMutation({ ...f.context, args }), entry.receipt);
      assert.equal((await f.storage.get(`host/operation/${args.idempotency_key}`)).pending, false);
    }
    assert.equal(f.applications(), 1);
    assert.equal(f.handle.doc().edits, 1);
    assert.deepEqual(A.getHeads(f.handle.doc()), entry.receipt.heads);
  });
}

async function catalogFixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const requests = [];
  const principal = `user:anaconda-fixture:${auth.subject}`;
  const catalog = new Catalog(
    { id: { name: principal }, storage },
    {
      ...auth.env,
      PAGES: {
        getByName: (id) => ({
          async fetch(request) {
            const path = new URL(request.url).pathname;
            requests.push({ path, id, body: await request.json() });
            return Response.json(
              path === "/internal/delete"
                ? { page_id: id, deleted: true }
                : { page_id: id, title: "Shared plan", heads: ["a".repeat(64)] },
            );
          },
        }),
      },
    },
  );
  const credential = auth.apiKey();
  const request = (operation, args = {}) =>
    catalog.fetch(
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${credential}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({ operation, arguments: args }),
      }),
    );
  return { storage, requests, request, principal };
}

test("list_pages token governs catalog create/delete retries and rejects another resource", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = await catalogFixture(t);
  const listed = await f.request("list_pages");
  assert.equal(listed.status, 200);
  const { retry_token, retry_until } = await listed.json();
  assert.equal(retry_until, new Date(start + RETRY_LIFETIME_MS).toISOString());
  const create = {
    title: "Shared plan",
    idempotency_key: await retryKey(retry_token, "catalog-create"),
    retry_token,
  };
  const createdResponse = await f.request("create_page", create);
  assert.equal(createdResponse.status, 200);
  const created = await createdResponse.json();
  assert.deepEqual(await (await f.request("create_page", create)).json(), created);
  assert.equal(f.requests.length, 1);
  assert.equal(
    (await f.request("create_page", { ...create, title: "Changed payload" })).status,
    409,
  );
  const wrongScope = await issueRetryToken(f.storage, {
    scope: `page:${pageId}`,
    principal: f.principal,
  });
  const wrongResponse = await f.request("create_page", {
    ...create,
    idempotency_key: await retryKey(wrongScope.retry_token, "wrong-resource"),
    retry_token: wrongScope.retry_token,
  });
  assert.equal(wrongResponse.status, 400);
  assert.equal((await wrongResponse.json()).code, "invalid_retry_token");
  assert.equal(f.requests.length, 1);
  const deletion = {
    page_id: created.page_id,
    idempotency_key: await retryKey(retry_token, "catalog-delete"),
    retry_token,
  };
  const deletedResponse = await f.request("delete_page", deletion);
  assert.equal(deletedResponse.status, 200);
  const deleted = await deletedResponse.json();
  assert.deepEqual(deleted, { page_id: created.page_id, deleted: true });
  assert.deepEqual(await (await f.request("delete_page", deletion)).json(), deleted);
  assert.equal(f.requests.length, 2);
  assert.equal((await (await f.request("list_pages")).json()).pages.length, 0);
  now += RETRY_LIFETIME_MS;
  const renewed = await (await f.request("list_pages")).json();
  // A new admitted operation collects terminal receipts; reads themselves do not.
  assert.equal(
    (
      await f.request("create_page", {
        title: "Fresh request",
        retry_token: renewed.retry_token,
        idempotency_key: await retryKey(renewed.retry_token, "next-catalog-create"),
      })
    ).status,
    200,
  );
  assert.equal(await f.storage.get(`host/operation/${create.idempotency_key}`), undefined);
  const substituted = await f.request("create_page", {
    ...create,
    retry_token: renewed.retry_token,
  });
  assert.equal(substituted.status, 400);
  assert.equal((await substituted.json()).code, "invalid_retry_token");
  for (const [operation, args] of [
    ["create_page", create],
    ["delete_page", deletion],
  ]) {
    const expired = await f.request(operation, args);
    assert.equal(expired.status, 410);
    assert.equal((await expired.json()).code, "retry_expired");
  }
  assert.equal(f.requests.length, 3);
});

test("a legacy-full catalog accepts a versioned operation and preserves old receipts", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = await catalogFixture(t);
  legacyReceipts(f.storage);
  const { retry_token } = await (await f.request("list_pages")).json();
  const response = await f.request("create_page", {
    title: "Shared plan",
    idempotency_key: await retryKey(retry_token, "catalog-after-legacy"),
    retry_token,
  });
  assert.equal(response.status, 200);
  assert.equal(f.requests.length, 1);
  assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, 1001);
  assert.equal((await f.storage.get("host/operation/legacy-00000")).receipt.accepted, 0);
});

async function pageFixture(t, { readContent = false } = {}) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  let doc = A.from(createPageData({ pageId, title: "Accepted content" }));
  let updates = 0;
  const principal = `user:anaconda-fixture:${auth.subject}`;
  const blockId = Object.keys(doc.blocks)[0];
  let threadId;
  if (readContent) {
    doc = A.change(doc, (draft) => {
      initializePage(draft, "## First section\n\nOriginal selected content.");
      applyPageOperation(draft, {
        operation: "edit_page",
        arguments: {
          operations: [
            { op: "insert_markdown", after_block_id: blockId, markdown: "Other block." },
          ],
        },
      });
      threadId = applyPageOperation(draft, {
        operation: "manage_page_comment",
        arguments: { block_id: blockId, body: "Original comment." },
        identity: { principal, displayName: "Fixture owner", driver: "Browser" },
      }).thread_id;
    });
  }
  const page = Object.assign(Object.create(Page.prototype), {
    ready: Promise.resolve(),
    tail: Promise.resolve(),
    env: auth.env,
    ctx: { storage, id: { name: pageId } },
    metadata: {
      pageId,
      documentId: "test",
      tree: "c".repeat(32),
      owner: principal,
      deleted: false,
    },
    handle: {
      doc: () => doc,
      async update(fn) {
        updates++;
        doc = fn(doc);
      },
      broadcast() {},
    },
    async flush() {
      await storage.sync();
    },
    cacheTitle() {},
  });
  page.policy = new DocumentPolicy({
    storage,
    metadata: () => page.metadata,
    serverKey: "a".repeat(64),
  });
  const token = auth.apiKey();
  const request = (operation, args = {}) =>
    page.fetch(
      new Request("https://pages.invalid/internal/tool", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({ operation, arguments: args }),
      }),
    );
  return { page, request, storage, principal, blockId, threadId, updates: () => updates };
}

test("actual Page read_page issues a token usable by its guarded edit path", async (t) => {
  let now = start;
  t.mock.method(Date, "now", () => now);
  const f = await pageFixture(t);
  const response = await f.request("read_page");
  assert.equal(response.status, 200);
  const before = await response.json();
  assert.equal(before.title, "Accepted content");
  assert.ok(before.retry_token);
  assert.equal(before.retry_until, new Date(start + RETRY_LIFETIME_MS).toISOString());
  const args = {
    page_id: pageId,
    base_heads: before.heads,
    retry_token: before.retry_token,
    idempotency_key: await retryKey(before.retry_token, "page-route-edit"),
    operations: [{ op: "set_title", title: "Edited once" }],
  };
  const changed = await f.request("edit_page", args);
  assert.equal(changed.status, 200);
  const receipt = await changed.json();
  assert.deepEqual(await (await f.request("edit_page", args)).json(), receipt);
  assert.equal(f.updates(), 1);
  assert.equal((await (await f.request("read_page")).json()).title, "Edited once");
  now += RETRY_LIFETIME_MS;
  await f.request("read_page");
  const expired = await f.request("edit_page", args);
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).code, "retry_expired");
  assert.equal(f.updates(), 1);
});

for (const operation of ["read_page", "list_page_comments"]) {
  test(`actual Page ${operation} partial read issues unchanged heads and usable retry authority`, async (t) => {
    const f = await pageFixture(t, { readContent: true });
    t.after(() => A.free(f.page.handle.doc()));
    const heads = A.getHeads(f.page.handle.doc());
    const response = await f.request(
      operation,
      operation === "read_page"
        ? { block_ids: [f.blockId], comments: "none" }
        : { thread_ids: [f.threadId], include_messages: false },
    );
    assert.equal(response.status, 200);
    const before = await response.json();
    assert.deepEqual(before.heads, heads);
    assert.deepEqual(A.getHeads(f.page.handle.doc()), heads);
    assert.equal(f.updates(), 0);
    assert.ok(before.retry_token);
    assert.ok(before.retry_key_prefix);
    assert.ok(before.retry_until);
    if (operation === "read_page") {
      assert.deepEqual(
        before.blocks.map((block) => block.id),
        [f.blockId],
      );
      assert.doesNotMatch(JSON.stringify(before), /Other block|Original comment/);
    } else {
      assert.deepEqual(
        before.comments.map((thread) => thread.id),
        [f.threadId],
      );
      assert.equal(before.comments[0].messages, undefined);
      assert.doesNotMatch(JSON.stringify(before), /Original comment|Original selected content/);
    }
    const args = {
      page_id: pageId,
      base_heads: before.heads,
      retry_token: before.retry_token,
      idempotency_key: await retryKey(before.retry_token, `${operation}-edit`),
      operations: [{ op: "set_title", title: "Edited from a partial read" }],
    };
    const changed = await f.request("edit_page", args);
    assert.equal(changed.status, 200);
    const receipt = await changed.json();
    assert.deepEqual(await (await f.request("edit_page", args)).json(), receipt);
    assert.equal(f.updates(), 1);
    assert.equal(f.page.handle.doc().title, "Edited from a partial read");
  });
}

test(
  "actual Page read captures content, comments and heads before retry-token storage awaits",
  { timeout: 5000 },
  async (t) => {
    const f = await pageFixture(t, { readContent: true });
    t.after(() => A.free(f.page.handle.doc()));
    const heads = A.getHeads(f.page.handle.doc());
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    t.after(() => released.resolve());
    const get = f.storage.get.bind(f.storage);
    let paused = false;
    t.mock.method(f.storage, "get", async (key) => {
      if (key === "host/retry-secret-v1" && !paused) {
        paused = true;
        entered.resolve();
        await released.promise;
      }
      return get(key);
    });
    const pending = f.request("read_page", { block_ids: [f.blockId], comments: "all" });
    await entered.promise;
    // Native synchronization bypasses the Page HTTP queue. Advance the handle
    // while token storage is blocked, without queueing another HTTP mutation.
    await f.page.handle.update((doc) =>
      A.change(doc, (draft) => {
        A.updateText(draft, ["title"], "Concurrent native title");
        initializePage(draft, "Concurrent native content.");
        applyPageOperation(draft, {
          operation: "manage_page_comment",
          arguments: { action: "reply", thread_id: f.threadId, body: "Concurrent native reply." },
          identity: { principal: f.principal, displayName: "Fixture owner", driver: "Browser" },
        });
      }),
    );
    assert.notDeepEqual(A.getHeads(f.page.handle.doc()), heads);
    released.resolve();
    const response = await pending;
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.heads, heads);
    assert.equal(body.title, "Accepted content");
    assert.match(body.blocks[0].markdown, /Original selected content/);
    assert.match(JSON.stringify(body.comments), /Original comment/);
    assert.doesNotMatch(JSON.stringify(body), /Concurrent native/);
    assert.ok(body.retry_token);
  },
);

test("actual Page rejects stale node ranges with a fresh outline instead of selected content", async (t) => {
  const f = await pageFixture(t, { readContent: true });
  t.after(() => A.free(f.page.handle.doc()));
  const heads = A.getHeads(f.page.handle.doc());
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) => {
      initializePage(
        draft,
        "Inserted first paragraph.\n\n## First section\n\nOriginal selected content.",
      );
    }),
  );
  const current = A.getHeads(f.page.handle.doc());
  const response = await f.request("read_page", {
    node_range: { block_id: f.blockId, from: 0, to: 2 },
    expected_heads: heads,
    comments: "none",
  });
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "read_revision_changed");
  assert.deepEqual(body.heads, current);
  assert.ok(Array.isArray(body.outline.entries));
  assert.equal(body.blocks, undefined);
  assert.equal(body.comments, undefined);
  assert.doesNotMatch(JSON.stringify(body), /Inserted first paragraph|Original selected content/);
  assert.equal(f.updates(), 1, "the rejected read performs no mutation");
  const fresh = await f.request("read_page", {
    node_range: { block_id: f.blockId, from: 0, to: 1 },
    expected_heads: current,
    comments: "none",
  });
  assert.equal(fresh.status, 200);
  assert.match((await fresh.json()).blocks[0].markdown, /Inserted first paragraph/);
});

test("actual Page returns a bounded UTF-8 budget error without truncated content", async (t) => {
  const f = await pageFixture(t, { readContent: true });
  t.after(() => A.free(f.page.handle.doc()));
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) => {
      initializePage(draft, `## Budget section\n\n${"雪".repeat(1800)}`);
    }),
  );
  const heads = A.getHeads(f.page.handle.doc());
  const response = await f.request("read_page", {
    block_ids: [f.blockId],
    comments: "none",
    max_bytes: 4096,
  });
  assert.equal(response.status, 413);
  const text = await response.text();
  assert.ok(new TextEncoder().encode(text).byteLength <= 4096);
  const body = JSON.parse(text);
  assert.equal(body.code, "read_budget_exceeded");
  assert.deepEqual(body.heads, heads);
  assert.ok(body.retry_token);
  assert.match(JSON.stringify(body.outline.entries), /Budget section/);
  assert.equal(body.blocks, undefined);
  assert.doesNotMatch(text, /雪/);
  assert.equal(f.updates(), 1);
});

test("Page image insertion validates storage once and journals actual block identity across retries", async (t) => {
  const f = await pageFixture(t);
  const assetId = "a".repeat(64);
  let heads = 0;
  f.page.env = {
    ...f.page.env,
    PAGES_ASSETS: {
      async head(key) {
        heads++;
        assert.ok(key.includes(pageId) && key.includes(assetId));
        return {
          size: 74,
          httpMetadata: { contentType: "image/png" },
          customMetadata: { page_id: pageId, hash: assetId, width: "3", height: "2" },
        };
      },
    },
  };
  const before = await (await f.request("read_page")).json();
  const args = {
    page_id: pageId,
    base_heads: before.heads,
    retry_token: before.retry_token,
    idempotency_key: await retryKey(before.retry_token, "insert-image-once"),
    operations: [{ op: "insert_image", asset_id: assetId, alt: "A cat" }],
  };
  const response = await f.request("edit_page", args);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  const [image] = receipt.result.inserted_images;
  assert.ok(f.page.handle.doc().blocks[image.block_id]);
  assert.equal(image.asset_id, assetId);
  assert.equal(heads, 1);
  // Receipt remains a record of the original operation, not a claim about the
  // latest document: a peer can remove the block before the requester retries.
  await f.page.handle.update((doc) =>
    A.change(doc, (draft) => {
      delete draft.blocks[image.block_id];
    }),
  );
  f.page.env.PAGES_ASSETS.head = async () => assert.fail("Retry depends on blob storage");
  assert.deepEqual(await (await f.request("edit_page", args)).json(), receipt);
  assert.equal(f.page.handle.doc().blocks[image.block_id], undefined);
  assert.equal(
    (
      await f.request("edit_page", {
        ...args,
        operations: [{ ...args.operations[0], alt: "Different" }],
      })
    ).status,
    409,
  );
});

test("Page image preflight rejects missing assets and lost write access before editing", async (t) => {
  for (const denied of ["missing", "permission"]) {
    const f = await pageFixture(t);
    const assetId = "a".repeat(64);
    f.page.env = {
      ...f.page.env,
      PAGES_ASSETS: {
        async head() {
          if (denied === "missing") return null;
          f.page.metadata.owner = "user:other";
          return {
            size: 74,
            httpMetadata: { contentType: "image/png" },
            customMetadata: { page_id: pageId, hash: assetId, width: "3", height: "2" },
          };
        },
      },
    };
    const before = await (await f.request("read_page")).json();
    const args = {
      page_id: pageId,
      base_heads: before.heads,
      retry_token: before.retry_token,
      idempotency_key: await retryKey(before.retry_token, `image-${denied}`),
      operations: [
        { op: "set_title", title: "Must not apply" },
        { op: "insert_image", asset_id: assetId, alt: "cat" },
      ],
    };
    const response = await f.request("edit_page", args);
    assert.equal(response.status, denied === "missing" ? 404 : 403);
    assert.equal(f.updates(), 0);
    assert.equal(f.page.handle.doc().title, "Accepted content");
    assert.equal(await f.storage.get(`host/operation/${args.idempotency_key}`), undefined);
  }
});

test("recovery-blocked Page keeps accepted content readable and rejects tool and native writes", async (t) => {
  t.mock.method(Date, "now", () => start);
  const f = await pageFixture(t);
  f.page.metadata.recoveryBlocked = { code: "history_capacity" };
  const response = await f.request("read_page");
  assert.equal(response.status, 200);
  const accepted = await response.json();
  assert.equal(accepted.title, "Accepted content");
  const edit = await f.request("edit_page", {
    page_id: pageId,
    base_heads: accepted.heads,
    retry_token: accepted.retry_token,
    idempotency_key: await retryKey(accepted.retry_token, "blocked-page-edit"),
    operations: [{ op: "set_title", title: "Must not apply" }],
  });
  assert.equal(edit.status, 409);
  assert.equal((await edit.json()).code, "page_recovery_blocked");
  assert.equal(f.updates(), 0);
  const key = "b".repeat(64);
  let disconnects = 0;
  const identity = {
    principal: f.principal,
    displayName: "Owner",
    driver: "Browser",
    canWrite: true,
    expiresAt: start + 60_000,
  };
  await f.page.policy.bind(key, "fixture-browser", identity, {
    reauthenticate: async () => identity,
    disconnect: async () => {
      disconnects++;
    },
  });
  let freed = 0;
  const resource = (hex) => ({
    toBytes: () => Uint8Array.from(Buffer.from(hex, "hex")),
    free() {
      freed++;
    },
  });
  const native = f.page.policy.native();
  await native.authorizeFetch(resource(key), resource(f.page.metadata.tree));
  await assert.rejects(
    native.authorizePut(resource(key), resource(key), resource(f.page.metadata.tree)),
    {
      status: 409,
      code: "page_recovery_blocked",
    },
  );
  assert.equal(disconnects, 1);
  assert.equal(
    freed,
    5,
    "native request resources are freed on both accepted reads and denied writes",
  );
  assert.equal(f.page.handle.doc().title, "Accepted content");
});
