import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { createAuthFixture } from "../auth-fixtures.mjs";
import { initializePage } from "../model/page.mjs";
import { blockAddress, nodeAddresses } from "../model/addresses.mjs";
import { Page } from "./index.mjs";
import { plainStub } from "./plain-stub.mjs";
import { headsFor } from "./revisions.mjs";

class Storage {
  values = new Map();
  syncs = 0;
  fault;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
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
    const handle = { doc: () => doc, on() {}, off() {} };
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
      get plain() {
        return plainStub(this.repo);
      },
    });
    const token = auth.apiKey();
    const request = () =>
      new Request("https://pages.invalid/internal/create", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
        body: JSON.stringify({
          page_id: pageId,
          title: "Test",
          markdown: "# Test\n\nOriginal content\n\n4. Fourth step",
        }),
      });
    assert.equal((await page.run(request())).status, 500);
    const receipt = structuredClone(page.metadata.createdReceipt);
    assert.deepEqual(
      receipt.warnings.map(({ code }) => code),
      ["opening_heading_repeats_title", "list_numbers_reset"],
    );
    assert.deepEqual(receipt.warnings[1].lists, [{ start: 4, first_item: "Fourth step" }]);
    assert.equal(receipt.warnings[0].code, "opening_heading_repeats_title");
    assert.equal(receipt.warnings[0].heading, "Test");
    // The first block's id and its nodes' ids, so the first edit needs no
    // read; the warning names the heading by its id.
    const key = Object.keys(doc.blocks)[0];
    assert.equal(receipt.node_id, blockAddress(doc, key));
    assert.deepEqual(receipt.nodes, nodeAddresses(doc, key));
    assert.equal(receipt.nodes.length, 3);
    assert.equal(receipt.warnings[0].node_id, receipt.nodes[0]);
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
    // The reply is the recorded receipt, its heads named by the revision
    // minted with the creation intent.
    const { heads: _heads, ...expected } = receipt;
    assert.deepEqual(await retry.json(), expected);
    assert.deepEqual(await headsFor(storage, "page", receipt.revision), receipt.heads);
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
  // A deleted Page's record from an earlier build has no comments_doc; it
  // still boots and answers as deleted.
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
  t.after(() => page.plain?.close());
  await page.ready;
  assert.equal(replays, 0);
  assert.equal(page.metadata.deleted, true);
});
