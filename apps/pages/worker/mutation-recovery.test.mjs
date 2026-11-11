import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { documentMutation, recoverDocumentMutations } from "./mutations.mjs";
import { headsFor, revisionFor } from "./revisions.mjs";
import { refreshCatalogTitle } from "./catalog.mjs";
import { catalogSource } from "./catalog-index.mjs";

class Storage {
  values = new Map();
  syncs = 0;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    for (const [name, entry] of Object.entries(typeof key === "object" ? key : { [key]: value }))
      this.values.set(name, structuredClone(entry));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async sync() {
    this.syncs++;
  }
  async list({ prefix = "", startAfter, limit = Infinity } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
}
async function mutationFixture() {
  const storage = new Storage();
  let doc = A.from({ page_id: "test", text: "hello" });
  const handle = {
    doc: () => doc,
    update: async (update) => {
      doc = update(doc);
    },
  };
  const identity = { principal: "user:owner", driver: "ChatGPT" };
  const args = {
    nonce: "test-operation",
    revision: await revisionFor(storage, "page", A.getHeads(doc), Date.now()),
  };
  const context = {
    storage,
    handle,
    operation: "edit_page",
    args,
    identity,
    apply: (draft) => {
      A.updateText(draft, ["text"], "hello world");
      return { edited: true };
    },
    flush: async () => storage.sync(),
  };
  return { storage, handle, context, heads: (revision) => headsFor(storage, "page", revision) };
}

test("mutation receipt replay preserves change IDs and rejects a stale revision or nonce conflicts", async () => {
  const f = await mutationFixture();
  const first = await documentMutation(f.context);
  const heads = A.getHeads(f.handle.doc());
  assert.deepEqual(await documentMutation(f.context), first);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  await assert.rejects(
    documentMutation({
      ...f.context,
      args: { ...f.context.args, nonce: "another-operation" },
    }),
    /Page changed/,
  );
  await assert.rejects(
    documentMutation({ ...f.context, args: { ...f.context.args, extra: true } }),
    /different request/,
  );
});

test("pending incremental intent recovers after failure without repeating a semantic edit", async () => {
  const f = await mutationFixture();
  let flushes = 0;
  const broken = {
    ...f.context,
    flush: async () => {
      if (++flushes > 1) throw new Error("storage failed");
      await f.context.flush();
    },
  };
  await assert.rejects(documentMutation(broken), /storage failed/);
  const heads = A.getHeads(f.handle.doc());
  await recoverDocumentMutations(f.storage, f.handle, f.context.flush);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  assert.equal(f.handle.doc().text, "hello world");
  assert.deepEqual(await f.heads((await documentMutation(f.context)).revision), heads);
});

test("recorded tool intent merges a human edit arriving while persistence yields", async () => {
  const f = await mutationFixture();
  const original = f.storage.put.bind(f.storage);
  f.storage.put = async (key, value) => {
    await original(key, value);
    const written = typeof key === "object" ? Object.values(key) : [value];
    if (written.some((entry) => entry?.pending))
      await f.handle.update((doc) =>
        A.change(doc, (draft) => {
          draft.humanNote = "typed concurrently";
        }),
      );
  };
  await documentMutation(f.context);
  assert.equal(f.handle.doc().text, "hello world");
  assert.equal(f.handle.doc().humanNote, "typed concurrently");
});

test("recovery resolves pending dependencies regardless of idempotency key order", async () => {
  const f = await mutationFixture();
  const before = f.handle.doc();
  const first = A.change(A.clone(before), (doc) => {
    doc.note = "first";
  });
  const second = A.change(A.clone(first), (doc) => {
    doc.note = "second";
  });
  for (const [key, parent, next] of [
    ["z-first", before, first],
    ["a-second", first, second],
  ]) {
    await f.storage.put(`host/operation/${key}`, {
      pending: true,
      fingerprint: key,
      changes: A.getChanges(parent, next),
      heads: A.getHeads(next),
      receipt: {},
    });
  }
  await recoverDocumentMutations(f.storage, f.handle, f.context.flush);
  assert.equal(f.handle.doc().note, "second");
  assert.equal(A.hasHeads(f.handle.doc(), A.getHeads(first)), true);
  assert.equal(
    [...f.storage.values.values()].some((entry) => entry.pending),
    false,
  );
});

test("recovery keeps an intent pending when its dependencies are missing", async () => {
  const f = await mutationFixture();
  const first = A.change(A.clone(f.handle.doc()), (doc) => {
    doc.note = "first";
  });
  const second = A.change(A.clone(first), (doc) => {
    doc.note = "second";
  });
  await f.storage.put("host/operation/missing-parent", {
    pending: true,
    fingerprint: "missing",
    changes: A.getChanges(first, second),
    heads: A.getHeads(second),
    receipt: {},
  });
  await assert.rejects(
    recoverDocumentMutations(f.storage, f.handle, f.context.flush),
    /dependencies are unavailable/,
  );
  assert.equal((await f.storage.get("host/operation/missing-parent")).pending, true);
});

test("catalog lists stored projections and late title updates cannot revive deleted pages", async () => {
  const storage = new Storage();
  const one = "11111111-1111-4111-8111-111111111111";
  const pending = "22222222-2222-4222-8222-222222222222";
  const list = async () =>
    (await catalogSource(storage, { inTrash: false, needle: null })).next(null, 50);
  await storage.put(`page/${one}`, {
    page_id: one,
    title: "First",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });
  await storage.put(`page/${pending}`, { page_id: pending, pending: true });
  assert.deepEqual(
    (await list()).map((page) => page.title),
    ["First"],
  );
  await refreshCatalogTitle(storage, {
    page_id: one,
    title: "Renamed",
    observed_at: "2026-10-02T00:00:00Z",
  });
  await refreshCatalogTitle(storage, {
    page_id: one,
    title: "Stale",
    observed_at: "2026-10-01T00:00:00Z",
  });
  assert.equal((await list())[0].title, "Renamed");
  await storage.delete(`page/${one}`);
  await refreshCatalogTitle(storage, {
    page_id: one,
    title: "Deleted",
    observed_at: "2026-10-03T00:00:00Z",
  });
  assert.deepEqual(await list(), []);
});
