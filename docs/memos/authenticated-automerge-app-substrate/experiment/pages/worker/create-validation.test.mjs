import assert from "node:assert/strict";
import { test } from "node:test";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog, Page } from "./index.mjs";

class Storage {
  values = new Map();
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
  async sync() {}
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
}
const invalidInputs = [
  { title: null },
  { title: 42 },
  { title: [] },
  { title: {} },
  { title: "x".repeat(501) },
  { markdown: null },
  { markdown: 42 },
  { markdown: [] },
  { markdown: {} },
];
async function fixture(t) {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const request = (path, body) =>
    new Request(`https://pages.invalid${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
      body: JSON.stringify(body),
    });
  const storage = new Storage();
  const calls = [];
  let responseStatus = 200;
  let responseHeaders = {};
  const catalog = new Catalog(
    { id: { name: `user:anaconda-fixture:${auth.subject}` }, storage },
    {
      ...auth.env,
      PAGES: {
        getByName: (id) => ({
          fetch: async (request) => {
            calls.push({ id, args: await request.json() });
            return Response.json(
              { page_id: id, title: "Created", heads: ["a".repeat(64)] },
              { status: responseStatus, headers: responseHeaders },
            );
          },
        }),
      },
    },
  );
  const create = (args) =>
    catalog.fetch(request("/internal/catalog", { operation: "create_page", arguments: args }));
  return {
    auth,
    request,
    storage,
    calls,
    create,
    fail: () => {
      responseStatus = 500;
    },
    recover: () => {
      responseStatus = 200;
    },
    rejectSize: (beforeIntent = true) => {
      responseStatus = 413;
      responseHeaders = beforeIntent ? { "x-pages-create-rejected": "before-intent" } : {};
    },
  };
}

test("invalid creates reserve neither catalog capacity nor a request key", async (t) => {
  const f = await fixture(t);
  for (const input of invalidInputs) {
    const response = await f.create({ ...input, idempotency_key: "reusable-request" });
    assert.equal(response.status, 400);
    assert.equal(f.storage.values.size, 0);
    assert.equal(f.calls.length, 0);
  }
  // The same key remains available because none of the rejected inputs ran.
  const args = { title: "x".repeat(500), markdown: "", idempotency_key: "reusable-request" };
  const first = await f.create(args);
  assert.equal(first.status, 200);
  const receipt = await first.json();
  assert.deepEqual(await (await f.create(args)).json(), receipt);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.storage.list({ prefix: "page/" })).size, 1);
});

test("an uncertain valid create retains its pending reservation for the same retry", async (t) => {
  const f = await fixture(t);
  const args = { title: "Created", markdown: "Content", idempotency_key: "uncertain-create" };
  f.fail();
  assert.equal((await f.create(args)).status, 500);
  const pending = await f.storage.get("host/operation/uncertain-create");
  assert.equal(pending.pending, true);
  assert.equal((await f.storage.get(`page/${pending.pageId}`)).pending, true);
  f.recover();
  const response = await f.create(args);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).page_id, pending.pageId);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal((await f.storage.list({ prefix: "page/" })).size, 1);
  assert.equal((await f.storage.get("host/operation/uncertain-create")).pending, false);
});

test("Page ingress independently rejects the same invalid create fields", async (t) => {
  const f = await fixture(t);
  const pageId = "33333333-3333-4333-8333-333333333333";
  const page = Object.assign(Object.create(Page.prototype), {
    ready: Promise.resolve(),
    env: f.auth.env,
    ctx: { id: { name: pageId }, storage: f.storage },
  });
  for (const input of invalidInputs) {
    const response = await page.run(f.request("/internal/create", { ...input, page_id: pageId }));
    assert.equal(response.status, 400);
    assert.equal(f.storage.values.size, 0);
    assert.equal(page.metadata, undefined);
  }
});

test("a marked pre-intent size rejection frees the catalog reservation and retry key", async (t) => {
  const f = await fixture(t);
  f.rejectSize();
  const args = { title: "Too large", idempotency_key: "oversized-create" };
  assert.equal((await f.create(args)).status, 413);
  // Only the key counts remain, back at zero.
  assert.deepEqual(Object.fromEntries(f.storage.values), {
    "host/count/active": 0,
    "host/count/trash": 0,
  });
  f.recover();
  assert.equal((await f.create({ ...args, title: "Smaller" })).status, 200);
});

test("an unmarked size failure retains the pending create for safe retry", async (t) => {
  const f = await fixture(t);
  f.rejectSize(false);
  const args = { title: "Uncertain", idempotency_key: "uncertain-size" };
  assert.equal((await f.create(args)).status, 413);
  const intent = await f.storage.get("host/operation/uncertain-size");
  assert.equal(intent.pending, true);
  assert.equal((await f.storage.get(`page/${intent.pageId}`)).pending, true);
});
