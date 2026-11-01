import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog } from "./index.mjs";
import { documentMutation } from "./mutations.mjs";
import { reserveOperation } from "./operation-journal.mjs";

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

test("the 1000th legacy document receipt succeeds; exact retries work but new legacy operations stop", async () => {
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
  await assert.rejects(
    documentMutation({
      ...context,
      args: { idempotency_key: "next-receipt", base_heads: A.getHeads(doc) },
    }),
    {
      status: 429,
      code: "operation_receipt_capacity",
      message: /use the retry_token from read_page or list_pages/,
    },
  );
  assert.equal(applications, 1);
  assert.deepEqual(A.getHeads(doc), receipt.heads);
});

for (const pending of [false, true]) {
  test(`legacy receipt age does not release capacity (pending=${pending})`, async () => {
    const storage = new Storage();
    fill(storage, 1000, pending);
    await assert.rejects(
      reserveOperation(storage, {
        key: "host/operation/new-legacy-request",
        entry: { fingerprint: "new", pending: true },
      }),
      { status: 429, code: pending ? "pending_operation_capacity" : "operation_receipt_capacity" },
    );
    assert.equal((await storage.list({ prefix: "host/operation/" })).size, 1000);
  });
}

for (const operation of ["create_page", "delete_page"]) {
  test(`a catalog full of legacy deletion receipts rejects new legacy ${operation}`, async (t) => {
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
            throw Error("must reject before contacting a Page");
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
    assert.equal(response.status, 429);
    const failure = await response.json();
    assert.equal(failure.code, "operation_receipt_capacity");
    assert.match(failure.error, /use the retry_token from read_page or list_pages/);
    assert.equal(pageRequests, 0);
    assert.equal((await storage.list({ prefix: "host/operation/" })).size, 1000);
  });
}

test("host migrations reserve in their own key space, past full client budgets", async () => {
  const { INTERNAL_PREFIX } = await import("./operation-journal.mjs");
  const storage = new Storage();
  fill(storage, 1000);
  const entry = (n) => ({ fingerprint: `migration-${n}`, pending: true, changes: [] });
  await assert.rejects(
    reserveOperation(storage, { key: "host/operation/client-new", entry: entry(0) }),
    { code: "operation_receipt_capacity" },
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
