import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import * as N from "@automerge/subduction";
import { createAuthFixture } from "../../auth-fixtures.mjs";
import { Catalog, Page } from "./index.mjs";
import { documentMutation } from "./mutations.mjs";

class Storage {
  values = new Map();
  writes = [];
  syncs = 0;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.writes.push(key);
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity } = {}) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).slice(0, limit));
  }
  async sync() {
    this.syncs++;
  }
}
const pageId = "33333333-3333-4333-8333-333333333333";
const requestFor = (token, path, body) =>
  new Request(`https://pages.invalid${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}`, "x-pages-driver": "ChatGPT" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const contextFor = (storage) => ({
  id: { name: pageId },
  storage,
  blockConcurrencyWhile: (fn) => fn(),
  waitUntil() {},
});
function mutationContext(storage, handle, flush) {
  return {
    storage,
    handle,
    flush,
    operation: "edit_page",
    args: { idempotency_key: "recoverable-edit", base_heads: A.getHeads(handle.doc()) },
    identity: { principal: "user:owner", driver: "ChatGPT" },
    apply: (draft) => {
      draft.toolNote = "survives restart";
    },
  };
}

// The intent survives a crash before application. Actual Automerge bytes
// exercise the dependency recovery in the Page constructor.
test("Page restart recovers an intent based on an unflushed WebSocket edit", async (t) => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "original" });
  await storage.put("fixture/document", A.save(doc));
  await storage.put("host/document", { pageId, documentId: "fixture", deleted: false });
  doc = A.change(doc, (draft) => {
    draft.humanNote = "received over WebSocket";
  });
  const base = A.getHeads(doc);
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const put = storage.put.bind(storage);
  storage.put = async (key, value) => {
    await put(key, value);
    if (key === "host/operation/recoverable-edit") throw Error("crash after intent write");
  };
  await assert.rejects(
    documentMutation(
      mutationContext(storage, handle, async () => {
        await storage.put("fixture/document", A.save(doc));
        await storage.sync();
      }),
    ),
    /crash after intent write/,
  );
  assert.equal(doc.toolNote, undefined);
  assert.equal((await storage.get("host/operation/recoverable-edit")).pending, true);
  assert.ok(A.hasHeads(A.load(await storage.get("fixture/document")), base));
  storage.put = put;
  t.mock.method(Page.prototype, "initializeRepo", async function () {
    let restored = A.load(await storage.get("fixture/document"));
    const recoveredHandle = {
      doc: () => restored,
      async update(fn) {
        restored = fn(restored);
      },
    };
    this.repo = {
      async find() {
        return recoveredHandle;
      },
      async flush() {
        await storage.put("fixture/document", A.save(restored));
      },
    };
    this.backend = { async flush() {} };
  });
  const restarted = new Page(contextFor(storage), {});
  await restarted.ready;
  assert.equal(restarted.handle.doc().humanNote, "received over WebSocket");
  assert.equal(restarted.handle.doc().toolNote, "survives restart");
  const receipt = await storage.get("host/operation/recoverable-edit");
  assert.equal(receipt.pending, false);
  assert.ok(A.hasHeads(A.load(await storage.get("fixture/document")), receipt.receipt.heads));
});

test("a failed base durability barrier records no mutation intent or tool changes", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "unflushed" });
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const before = A.getHeads(doc);
  await assert.rejects(
    documentMutation(
      mutationContext(storage, handle, async () => {
        throw Error("base durability failed");
      }),
    ),
    /base durability failed/,
  );
  assert.equal(storage.values.size, 0);
  assert.deepEqual(A.getHeads(doc), before);
  assert.equal(doc.toolNote, undefined);
});

test("the base barrier precedes intent storage without dropping a concurrent edit", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "base" });
  const handle = {
    doc: () => doc,
    async update(fn) {
      doc = fn(doc);
    },
  };
  const events = [];
  const put = storage.put.bind(storage);
  storage.put = async (key, value) => {
    events.push(value.pending ? "intent" : "receipt");
    await put(key, value);
  };
  let flushes = 0;
  let persisted;
  const receipt = await documentMutation(
    mutationContext(storage, handle, async () => {
      events.push("flush");
      persisted = A.save(doc);
      if (++flushes === 1) {
        assert.equal(doc.toolNote, undefined);
        assert.equal(storage.values.size, 0);
        doc = A.change(doc, (draft) => {
          draft.laterHumanNote = "arrived during base flush";
        });
      }
    }),
  );
  assert.deepEqual(events, ["flush", "intent", "flush", "receipt"]);
  assert.equal(doc.laterHumanNote, "arrived during base flush");
  assert.ok(A.hasHeads(A.load(persisted), receipt.heads));
});

test("unknown Page lookups write no signer, repository, or host state", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  for (const [path, body] of [
    ["/api/connect"],
    ["/api/sync"],
    ["/api/saved", { heads: ["a".repeat(64)] }],
    ["/internal/tool", { operation: "read_page", arguments: { page_id: pageId } }],
  ]) {
    const storage = new Storage();
    const page = new Page(contextFor(storage), auth.env);
    await page.ready;
    assert.equal((await page.fetch(requestFor(token, path, body))).status, 404);
    assert.equal(storage.values.size, 0);
    assert.deepEqual(storage.writes, []);
    assert.equal(page.signer, undefined);
    assert.equal(page.repo, undefined);
  }
});

test("valid creation and concurrent initialization share one persisted signer", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  const page = new Page(contextFor(storage), auth.env);
  await page.ready;
  t.after(async () => {
    await page.repo?.shutdown();
    await page.backend?.close();
    page.signer?.free();
  });
  const get = storage.get.bind(storage);
  let release, started;
  const waiting = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    started = resolve;
  });
  storage.get = async (key) => {
    if (key === "host/signer") {
      started();
      await waiting;
    }
    return get(key);
  };
  const creating = page.fetch(
    requestFor(auth.apiKey(), "/internal/create", {
      page_id: pageId,
      title: "Created lazily",
      markdown: "Content",
    }),
  );
  await entered;
  const initialization = [page.initializeRepo(), page.initializeRepo()];
  assert.equal(initialization[0], initialization[1]);
  release();
  assert.equal((await creating).status, 201);
  await Promise.all(initialization);
  assert.equal(storage.writes.filter((key) => key === "host/signer").length, 1);
  assert.equal(page.handle.doc().title, "Created lazily");
  assert.ok(await storage.get("host/document"));
  assert.equal(await storage.get("host/creation"), undefined);
});

test("a new delete key completes failed tombstone barriers before clearing its catalog row", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const token = auth.apiKey();
  const storage = new Storage();
  let failing = true;
  storage.sync = async () => {
    storage.syncs++;
    if (failing) throw Error("deletion sync failed");
  };
  const doc = A.from({ page_id: pageId, text: "Delete me" });
  let deletions = 0;
  const page = Object.assign(Object.create(Page.prototype), {
    ready: Promise.resolve(),
    env: auth.env,
    ctx: contextFor(storage),
    metadata: {
      pageId,
      documentId: "fixture",
      owner: `user:anaconda-fixture:${auth.subject}`,
      deleted: false,
    },
    handle: { doc: () => doc },
    wires: new Set(),
    policy: { async close() {} },
    repo: {
      async delete() {
        deletions++;
      },
    },
    backend: { async flush() {} },
  });
  const catalogStorage = new Storage();
  await catalogStorage.put(`page/${pageId}`, { page_id: pageId, title: "Delete me" });
  const catalog = new Catalog(
    { id: { name: page.metadata.owner }, storage: catalogStorage },
    {
      ...auth.env,
      PAGES: { getByName: () => ({ fetch: (request) => page.run(request) }) },
    },
  );
  const args = { page_id: pageId, base_heads: A.getHeads(doc) };
  const remove = (key, extra = {}) =>
    catalog.fetch(
      requestFor(token, "/internal/catalog", {
        operation: "delete_page",
        arguments: { ...args, idempotency_key: key, ...extra },
      }),
    );
  assert.equal((await remove("original-delete")).status, 500);
  assert.equal((await remove("replacement-delete")).status, 500);
  assert.ok(await catalogStorage.get(`page/${pageId}`));
  assert.equal((await catalogStorage.get("host/operation/replacement-delete")).pending, true);
  assert.equal(deletions, 2);
  failing = false;
  const response = await remove("replacement-delete");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { page_id: pageId, deleted: true });
  assert.equal(await catalogStorage.get(`page/${pageId}`), undefined);
  assert.equal(deletions, 3);
  assert.equal(storage.syncs, 3);
  assert.equal((await remove("original-delete", { extra: true })).status, 409);
  assert.equal(
    (
      await page.run(
        requestFor(token, "/internal/delete", {
          ...args,
          idempotency_key: "original-delete",
          extra: true,
        }),
      )
    ).status,
    409,
  );
});

test("deleting a missing Page durably removes only the caller's stale catalog entry", async (t) => {
  const auth = await createAuthFixture();
  t.mock.method(globalThis, "fetch", auth.fetch);
  const storage = new Storage();
  await storage.put(`page/${pageId}`, { page_id: pageId, title: "Stale" });
  await storage.put("page/other", { page_id: "other", title: "Retained" });
  const catalog = new Catalog(
    { id: { name: `user:anaconda-fixture:${auth.subject}` }, storage },
    {
      ...auth.env,
      PAGES: {
        getByName: () => ({
          fetch: async () => Response.json({ error: "Page not found" }, { status: 404 }),
        }),
      },
    },
  );
  const response = await catalog.fetch(
    requestFor(auth.apiKey(), "/internal/catalog", {
      operation: "delete_page",
      arguments: { page_id: pageId, idempotency_key: "missing-delete" },
    }),
  );
  assert.equal(response.status, 200);
  assert.equal(await storage.get(`page/${pageId}`), undefined);
  assert.ok(await storage.get("page/other"));
  assert.equal((await storage.get("host/operation/missing-delete")).pending, false);
  assert.equal(storage.syncs, 1);
});

test("cached tool receipts retry a failed final durability barrier", async () => {
  const storage = new Storage();
  let doc = A.from({ page_id: pageId, text: "original" });
  let updates = 0;
  const handle = {
    doc: () => doc,
    async update(fn) {
      updates++;
      doc = fn(doc);
    },
  };
  let failing = true;
  let durableReceipt;
  storage.sync = async () => {
    storage.syncs++;
    if (failing) throw Error("receipt sync failed");
    durableReceipt = await storage.get("host/operation/recoverable-edit");
  };
  const context = mutationContext(storage, handle, async () => {});
  await assert.rejects(documentMutation(context), /receipt sync failed/);
  const recorded = await storage.get("host/operation/recoverable-edit");
  assert.equal(recorded.pending, false);
  await assert.rejects(documentMutation(context), /receipt sync failed/);
  assert.equal(storage.syncs, 2);
  assert.equal(durableReceipt, undefined);
  failing = false;
  assert.deepEqual(await documentMutation(context), recorded.receipt);
  assert.equal(storage.syncs, 3);
  assert.equal(updates, 1);
  assert.deepEqual(durableReceipt, recorded);
});

for (const fault of ["signer-read", "signer-write", "policy-load"]) {
  test(`create retries ${fault} initialization failure with its exact recorded history`, async (t) => {
    const auth = await createAuthFixture();
    t.mock.method(globalThis, "fetch", auth.fetch);
    const storage = new Storage();
    const page = new Page(contextFor(storage), auth.env);
    await page.ready;
    t.after(async () => {
      await page.repo?.shutdown();
      await page.backend?.close();
      page.signer?.free();
    });
    let freed = 0;
    const free = N.MemorySigner.prototype.free;
    t.mock.method(N.MemorySigner.prototype, "free", function () {
      freed++;
      return free.call(this);
    });
    let failing = true;
    let attempts = 0;
    for (const [method, matches] of [
      ["get", (key) => key === "host/signer" && fault === "signer-read"],
      ["put", (key) => key === "host/signer" && fault === "signer-write"],
      ["list", (options) => options.prefix === "host/binding/" && fault === "policy-load"],
    ]) {
      const original = storage[method].bind(storage);
      storage[method] = async (...args) => {
        if (matches(args[0])) {
          attempts++;
          if (failing) throw Error(`transient ${fault}`);
        }
        return original(...args);
      };
    }
    const owner = auth.apiKey();
    const args = { page_id: pageId, title: "Original title", markdown: "Original content" };
    assert.equal((await page.fetch(requestFor(owner, "/internal/create", args))).status, 500);
    const intent = await storage.get("host/creation");
    assert.ok(intent);
    assert.equal(page.metadata, undefined);
    assert.equal(page.initializing, undefined);
    assert.equal(page.signer, undefined);
    assert.equal(page.repo, undefined);
    assert.equal(freed, fault === "policy-load" ? 1 : 0);
    failing = false;
    const attacker = auth.apiKey({ userId: "another-account" });
    assert.equal((await page.fetch(requestFor(attacker, "/internal/create", args))).status, 403);
    assert.equal(attempts, 1);
    assert.deepEqual(await storage.get("host/creation"), intent);
    const retry = await page.fetch(
      requestFor(owner, "/internal/create", {
        ...args,
        title: "Do not recreate",
        markdown: "Do not replace history",
      }),
    );
    assert.equal(retry.status, 201);
    assert.deepEqual(await retry.json(), intent.metadata.createdReceipt);
    assert.equal(page.metadata.documentId, intent.metadata.documentId);
    assert.deepEqual(A.getHeads(page.handle.doc()), intent.metadata.createdReceipt.heads);
    assert.deepEqual(A.getAllChanges(page.handle.doc()), A.getAllChanges(A.load(intent.bytes)));
    assert.equal(page.handle.doc().title, "Original title");
    assert.equal(await storage.get("host/creation"), undefined);
    assert.equal(storage.writes.filter((key) => key === "host/creation").length, 1);
    assert.equal(attempts, 2);
    assert.equal(page.initializing, undefined);
  });
}
