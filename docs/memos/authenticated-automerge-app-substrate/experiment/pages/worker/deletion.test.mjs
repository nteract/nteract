import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog, Page } from "./index.mjs";

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
  async sync() {}
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
}
const pageId = "33333333-3333-4333-8333-333333333333";
async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, title: "Before" });
  let removed = 0,
    disconnected = 0;
  const page = Object.assign(Object.create(Page.prototype), {
    ready: Promise.resolve(),
    env: auth.env,
    ctx: { storage },
    metadata: {
      pageId,
      documentId: "test",
      owner: `user:anaconda-fixture:${auth.subject}`,
      deleted: false,
    },
    handle: { doc: () => doc },
    wires: new Set(),
    policy: {
      close: async () => {
        disconnected++;
      },
    },
    repo: {
      delete: async () => {
        removed++;
      },
    },
    backend: { flush: async () => {} },
  });
  const token = auth.apiKey();
  const request = (path, body) =>
    new Request(`https://pages.invalid${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
      body: JSON.stringify(body),
    });
  const args = () => ({
    page_id: pageId,
    base_heads: A.getHeads(doc),
    idempotency_key: "delete-fixture",
  });
  return {
    auth,
    storage,
    page,
    args,
    request,
    removed: () => removed,
    disconnected: () => disconnected,
    edit: () => {
      doc = A.change(doc, (draft) => {
        draft.title = "Newer content";
      });
    },
  };
}

test("delete rejects stale or missing heads before tombstoning or disconnecting", async (t) => {
  const f = await fixture(t);
  const stale = f.args();
  f.edit();
  assert.equal((await f.page.run(f.request("/internal/delete", stale))).status, 409);
  assert.equal(
    (await f.page.run(f.request("/internal/delete", { ...f.args(), base_heads: undefined })))
      .status,
    400,
  );
  assert.equal(f.page.metadata.deleted, false);
  assert.equal(f.page.handle.doc().title, "Newer content");
  assert.equal(f.removed(), 0);
  assert.equal(f.disconnected(), 0);
  assert.equal(await f.storage.get("host/document"), undefined);
});

test("same delete retries a persisted tombstone without needing the deleted document", async (t) => {
  const f = await fixture(t);
  const args = f.args();
  f.page.repo.delete = async () => {
    throw Error("interrupted cleanup");
  };
  assert.equal((await f.page.run(f.request("/internal/delete", args))).status, 500);
  const persisted = await f.storage.get("host/document");
  assert.equal(persisted.deleted, true);
  f.page.metadata = persisted;
  f.page.handle = {
    doc: () => {
      throw Error("deleted documents are not loaded on restart");
    },
  };
  let cleaned = false;
  f.page.repo.delete = async () => {
    cleaned = true;
  };
  const receipt = await f.page.run(f.request("/internal/delete", args));
  assert.equal(receipt.status, 200);
  assert.deepEqual(await receipt.json(), { page_id: pageId, deleted: true });
  assert.equal(cleaned, true);
  assert.equal(
    (await f.page.run(f.request("/internal/delete", { ...args, base_heads: ["0".repeat(64)] })))
      .status,
    409,
  );
  assert.equal(
    (
      await f.page.run(
        f.request("/internal/delete", { ...args, idempotency_key: "different-delete" }),
      )
    ).status,
    404,
  );
});

test("Catalog forwards delete guards and keeps the index until guarded deletion succeeds", async (t) => {
  const f = await fixture(t);
  const storage = new Storage();
  await storage.put(`page/${pageId}`, { page_id: pageId, title: "Before" });
  const forwarded = [];
  const catalog = new Catalog(
    { id: { name: f.page.metadata.owner }, storage },
    {
      ...f.auth.env,
      PAGES: {
        getByName: (id) => {
          assert.equal(id, pageId);
          return {
            fetch: async (request) => {
              forwarded.push(await request.clone().json());
              return f.page.run(request);
            },
          };
        },
      },
    },
  );
  const stale = f.args();
  f.edit();
  assert.equal(
    (
      await catalog.fetch(
        f.request("/internal/catalog", { operation: "delete_page", arguments: stale }),
      )
    ).status,
    409,
  );
  assert.deepEqual(forwarded[0], stale);
  assert.ok(await storage.get(`page/${pageId}`));
  const current = { ...f.args(), idempotency_key: "current-delete" };
  const first = await catalog.fetch(
    f.request("/internal/catalog", { operation: "delete_page", arguments: current }),
  );
  assert.equal(first.status, 200);
  assert.equal(await storage.get(`page/${pageId}`), undefined);
  const count = forwarded.length;
  const replay = await catalog.fetch(
    f.request("/internal/catalog", { operation: "delete_page", arguments: current }),
  );
  assert.deepEqual(await replay.json(), await first.json());
  assert.equal(forwarded.length, count);
});
