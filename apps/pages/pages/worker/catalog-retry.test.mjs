import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog } from "./index.mjs";

class Storage {
  values = new Map();
  durable = new Map();
  syncs = 0;
  failing = true;
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
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
  async sync() {
    this.syncs++;
    if (this.failing) throw Error("catalog durability failed");
    this.durable = structuredClone(this.values);
  }
}
const pageId = "33333333-3333-4333-8333-333333333333";

for (const operation of ["create_page", "delete_page"]) {
  test(`${operation} retry resyncs its catalog receipt and index`, async (t) => {
    const auth = await createAuthFixture();
    t.mock.method(globalThis, "fetch", auth.fetch);
    const storage = new Storage();
    if (operation === "delete_page") {
      await storage.put(`page/${pageId}`, { page_id: pageId, title: "Before" });
      storage.durable = structuredClone(storage.values);
    }
    let pageRequests = 0;
    const catalog = new Catalog(
      { id: { name: `user:anaconda-fixture:${auth.subject}` }, storage },
      {
        ...auth.env,
        PAGES: {
          getByName: (id) => ({
            fetch: async () => {
              pageRequests++;
              return Response.json(
                operation === "create_page"
                  ? { page_id: id, title: "Created", heads: ["a".repeat(64)] }
                  : {
                      receipt: { page_id: id, state: "trashed", trashed: true },
                      current: { page_id: id, state: "trashed", revision: 1, title: "Before" },
                    },
              );
            },
          }),
        },
      },
    );
    const token = auth.apiKey();
    const request = () =>
      new Request("https://pages.invalid/internal/catalog", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({
          operation,
          arguments: { page_id: pageId, title: "Created", idempotency_key: "catalog-retry" },
        }),
      });
    assert.equal((await catalog.fetch(request())).status, 500);
    const recorded = await storage.get("host/operation/catalog-retry");
    assert.equal(recorded.pending, false);
    assert.equal((await catalog.fetch(request())).status, 500);
    assert.equal(storage.syncs, 2);
    storage.failing = false;
    const retry = await catalog.fetch(request());
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), recorded.receipt);
    assert.equal(storage.syncs, 3);
    assert.equal(pageRequests, 1);
    assert.deepEqual(storage.durable, storage.values);
    assert.equal(storage.durable.has(`page/${recorded.pageId}`), operation === "create_page");
    assert.equal(storage.durable.has(`trash/${recorded.pageId}`), operation === "delete_page");
  });
}
