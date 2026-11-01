import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { initializePage } from "../model/page.mjs";
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
        body: JSON.stringify({
          page_id: pageId,
          title: "Test",
          markdown: "# Test\n\nOriginal content",
        }),
      });
    assert.equal((await page.run(request())).status, 500);
    const receipt = structuredClone(page.metadata.createdReceipt);
    assert.equal(receipt.warnings.length, 1);
    assert.equal(receipt.warnings[0].code, "opening_heading_repeats_title");
    assert.equal(receipt.warnings[0].heading, "Test");
    const recordedCreation = await storage.get("host/creation");
    assert.deepEqual(
      recordedCreation?.metadata.createdReceipt ??
        (await storage.get("host/document")).createdReceipt,
      receipt,
    );
    assert.equal((await page.run(request())).status, 500);
    doc = A.change(doc, (draft) => {
      draft.concurrentNote = "Keep this edit";
      A.updateText(draft, ["title"], "Changed title");
      initializePage(draft, "## Changed section\n\nKeep this later body edit.");
    });
    storage.fault = undefined;
    const retry = await page.run(request());
    assert.equal(retry.status, 200);
    // The recorded receipt is unchanged; edit authority rides beside it.
    const { retry_token, retry_key_prefix, retry_until, ...replayed } = await retry.json();
    assert.deepEqual(replayed, receipt);
    assert.equal(typeof retry_token, "string");
    assert.match(retry_key_prefix, /^v1_[a-f0-9]{64}_$/);
    assert.ok(Number.isFinite(Date.parse(retry_until)));
    assert.ok(A.hasHeads(doc, receipt.heads));
    assert.equal(doc.concurrentNote, "Keep this edit");
    assert.equal(doc.title, "Changed title");
    assert.match(doc.blocks[Object.keys(doc.blocks)[0]].richText, /Keep this later body edit/);
    assert.equal(A.view(doc, receipt.heads).title, "Test");
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
