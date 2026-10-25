import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog } from "./index.mjs";
import { documentMutation, reserveCapacity } from "./mutations.mjs";

class Storage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
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

test("the 1000th document receipt succeeds; exact retries work but fresh operations stop", async () => {
  const storage = new Storage();
  fill(storage, 999);
  let doc = A.from({ page_id: "fixture-page", text: "base" });
  let applications = 0;
  const context = {
    storage,
    handle: {
      doc: () => doc,
      async update(fn) {
        doc = fn(doc);
      },
    },
    operation: "edit_page",
    args: { idempotency_key: "last-receipt", base_heads: A.getHeads(doc) },
    identity: { principal: "fixture:owner", driver: "test" },
    apply(draft) {
      applications++;
      draft.text = "accepted exactly once";
    },
    flush: async () => {},
  };
  const receipt = await documentMutation(context);
  assert.equal(storage.values.size, 1000);
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
    { status: 409, message: /1000 operation receipts/ },
  );
  assert.equal(applications, 1);
  assert.deepEqual(A.getHeads(doc), receipt.heads);
});

for (const pending of [false, true]) {
  test(`receipt age does not release capacity (pending=${pending})`, async () => {
    const storage = new Storage();
    fill(storage, 1000, pending);
    await assert.rejects(reserveCapacity(storage), { status: 409 });
    assert.equal(storage.values.size, 1000);
  });
}

for (const operation of ["create_page", "delete_page"]) {
  test(`a catalog full of completed deletion receipts blocks ${operation}`, async (t) => {
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
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /1000 operation receipts/);
    assert.equal(pageRequests, 0);
    assert.equal(storage.values.size, 1000);
  });
}
