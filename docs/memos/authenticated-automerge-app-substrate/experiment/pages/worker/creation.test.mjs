import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Page } from "./index.mjs";

class Storage {
  values = new Map();
  syncs = 0;
  fault;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (this.fault === "metadata" && key === "host/document") throw Error("metadata failed");
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.values.delete(key);
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)));
  }
  async sync() {
    this.syncs++;
    if (this.fault === "final-sync" && this.syncs >= 2) throw Error("sync failed");
  }
}
const pageId = "33333333-3333-4333-8333-333333333333";

for (const fault of ["metadata", "flush", "final-sync"]) {
  test(`create retries ${fault} failure before returning its original receipt`, async (t) => {
    const auth = await createAuthFixture();
    t.mock.method(globalThis, "fetch", auth.fetch);
    const storage = new Storage();
    storage.fault = fault;
    let doc;
    let flushes = 0;
    const handle = { doc: () => doc };
    const page = Object.assign(Object.create(Page.prototype), {
      ready: Promise.resolve(),
      env: auth.env,
      ctx: { id: { name: pageId }, storage },
      policy: { account() {} },
      repo: {
        async import(bytes) {
          const imported = A.load(bytes);
          doc = doc ? A.merge(doc, imported) : imported;
          return handle;
        },
        async flush() {
          flushes++;
          if (storage.fault === "flush") throw Error("flush failed");
        },
      },
      backend: { async flush() {} },
    });
    const token = auth.apiKey();
    const request = () =>
      new Request("https://pages.invalid/internal/create", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({ page_id: pageId, title: "Test", markdown: "Original content" }),
      });
    assert.equal((await page.run(request())).status, 500);
    const receipt = structuredClone(page.metadata.createdReceipt);
    assert.equal((await page.run(request())).status, 500);
    doc = A.change(doc, (draft) => {
      draft.concurrentNote = "Keep this edit";
    });
    storage.fault = undefined;
    const retry = await page.run(request());
    assert.equal(retry.status, 200);
    assert.deepEqual(await retry.json(), receipt);
    assert.ok(A.hasHeads(doc, receipt.heads));
    assert.equal(doc.concurrentNote, "Keep this edit");
    assert.deepEqual(await storage.get("host/document"), page.metadata);
    assert.equal(await storage.get("host/creation"), undefined);
    assert.ok(flushes >= 1);
    assert.ok(storage.syncs >= 2);
  });
}

test("restart does not replay an old creation over a persisted deletion", async (t) => {
  const storage = new Storage();
  const metadata = { pageId, documentId: "unused", deleted: true };
  await storage.put("host/document", metadata);
  await storage.put("host/creation", {
    metadata: { ...metadata, deleted: false },
    bytes: new Uint8Array(),
  });
  let replays = 0;
  t.mock.method(Page.prototype, "finishCreation", async function (intent) {
    replays++;
    this.metadata = intent.metadata;
    this.handle = {};
  });
  const page = new Page({ storage, blockConcurrencyWhile: (fn) => fn() }, {});
  t.after(async () => {
    await page.repo?.shutdown();
    await page.backend?.close();
    page.signer?.free();
  });
  await page.ready;
  assert.equal(replays, 0);
  assert.equal(page.metadata.deleted, true);
});
