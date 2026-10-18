import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { DurableByteStore, persistentSeed } from "./storage.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { documentMutation, recoverDocumentMutations } from "./mutations.mjs";
import { listCatalog, refreshCatalogTitle } from "./catalog.mjs";
import { WebSocketByteTransport } from "../shared/byte-transport.mjs";

class Storage {
  values = new Map();
  syncs = 0;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
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
const key = "1".repeat(64),
  otherKey = "2".repeat(64),
  serverKey = "f".repeat(64);
function fixture() {
  let now = 1000;
  const storage = new Storage();
  const metadata = { owner: "user:owner", tree: "a".repeat(32), deleted: false };
  const policy = new DocumentPolicy({
    storage,
    metadata: () => metadata,
    serverKey,
    now: () => now,
  });
  const identity = {
    principal: metadata.owner,
    displayName: "Kyle",
    driver: "ChatGPT",
    canWrite: true,
    expiresAt: 61_000,
  };
  let closed = 0;
  const bind = (signer, current = identity) =>
    policy.bind(signer, signer, current, {
      reauthenticate: async () => current,
      disconnect: async () => {
        closed++;
      },
    });
  return {
    policy,
    storage,
    metadata,
    identity,
    bind,
    advance: (value) => {
      now = value;
    },
    closed: () => closed,
  };
}

test("durable byte store keeps binary records, paginates, and isolates host keys", async () => {
  const storage = new Storage(),
    bytes = new DurableByteStore(storage);
  await storage.put("host/document", { private: true });
  for (let i = 0; i < 600; i++)
    await bytes.save(`tree/${String(i).padStart(4, "0")}`, new Uint8Array([i % 256]));
  assert.equal((await bytes.list("tree/")).length, 600);
  assert.equal(
    (await bytes.list("")).some((value) => value.includes("host")),
    false,
  );
  assert.deepEqual(await bytes.load("tree/0001"), new Uint8Array([1]));
  await bytes.remove("tree/0001");
  assert.equal(await bytes.load("tree/0001"), undefined);
  assert.deepEqual(await persistentSeed(storage), await persistentSeed(storage));
});

test("private owner and credential ceiling are independent of signer display claims", async () => {
  const f = fixture();
  await assert.rejects(
    f.bind(key, { ...f.identity, principal: "user:other", displayName: "Kyle" }),
    /access denied/,
  );
  await f.bind(key, { ...f.identity, canWrite: false, driver: "administrator" });
  await f.policy.access(key, f.metadata.tree);
  await assert.rejects(f.policy.put(key, key, f.metadata.tree), /read-only/);
  await assert.rejects(f.policy.access(key, "b".repeat(32)), /access denied/);
});

test("signer binding survives reload and rejects account or driver reassignment", async () => {
  const f = fixture();
  const release = await f.bind(key);
  await assert.rejects(f.bind(key), /already connected/);
  release();
  const policy = new DocumentPolicy({
    storage: f.storage,
    metadata: () => f.metadata,
    serverKey,
    now: () => 2000,
  });
  await policy.load();
  await assert.rejects(
    policy.bind(key, key, { ...f.identity, driver: "Mobile" }, {}),
    /another binding/,
  );
  assert.deepEqual(policy.profiles()[key], {
    principal: "user:owner",
    displayName: "Kyle",
    driver: "ChatGPT",
  });
});

test("expired author history can relay through a current writer but expired requestors cannot", async () => {
  const f = fixture();
  await f.bind(key, { ...f.identity, expiresAt: 2000 });
  f.advance(3000);
  await f.bind(otherKey);
  await f.policy.put(otherKey, key, f.metadata.tree);
  await assert.rejects(f.policy.put(key, key, f.metadata.tree), /access denied/);
  assert.equal(f.closed(), 1);
});

test("credential revocation and host deletion close or reject active peers", async () => {
  const f = fixture();
  let disconnected = false;
  await f.policy.bind(key, key, f.identity, {
    reauthenticate: async () => {
      throw new Error("revoked");
    },
    disconnect: async () => {
      disconnected = true;
    },
  });
  f.advance(20_000);
  await assert.rejects(f.policy.active(key), /revoked/);
  assert.equal(disconnected, true);
  await f.bind(otherKey);
  f.metadata.deleted = true;
  await assert.rejects(f.policy.access(otherKey, f.metadata.tree), /access denied/);
});

function mutationFixture() {
  const storage = new Storage();
  let doc = A.from({ page_id: "test", text: "hello" });
  const handle = {
    doc: () => doc,
    update: async (update) => {
      doc = update(doc);
    },
  };
  const identity = { principal: "user:owner", driver: "ChatGPT" };
  const args = { idempotency_key: "test-operation", base_heads: A.getHeads(doc) };
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
  return { storage, handle, context };
}

test("mutation receipt replay preserves change IDs and rejects stale heads or key conflicts", async () => {
  const f = mutationFixture();
  const first = await documentMutation(f.context);
  const heads = A.getHeads(f.handle.doc());
  assert.deepEqual(await documentMutation(f.context), first);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  await assert.rejects(
    documentMutation({
      ...f.context,
      args: { ...f.context.args, idempotency_key: "another-operation" },
    }),
    /Page changed/,
  );
  await assert.rejects(
    documentMutation({ ...f.context, args: { ...f.context.args, extra: true } }),
    /different request/,
  );
});

test("pending incremental intent recovers after failure without repeating a semantic edit", async () => {
  const f = mutationFixture();
  const broken = {
    ...f.context,
    flush: async () => {
      throw new Error("storage failed");
    },
  };
  await assert.rejects(documentMutation(broken), /storage failed/);
  const heads = A.getHeads(f.handle.doc());
  await recoverDocumentMutations(f.storage, f.handle, f.context.flush);
  assert.deepEqual(A.getHeads(f.handle.doc()), heads);
  assert.equal(f.handle.doc().text, "hello world");
  assert.deepEqual((await documentMutation(f.context)).heads, heads);
});

test("WebSocket bridge rejects text and oversized frames and releases pending receivers", async () => {
  class Socket extends EventTarget {
    close() {
      this.closed = true;
    }
    send(bytes) {
      this.sent = bytes;
    }
  }
  const socket = new Socket(),
    wire = new WebSocketByteTransport(socket, { maxFrameBytes: 4 });
  const waiting = wire.recvBytes();
  socket.dispatchEvent(new MessageEvent("message", { data: "not binary" }));
  await assert.rejects(waiting, /closed/);
  assert.equal(socket.closed, true);
  const other = new Socket(),
    bounded = new WebSocketByteTransport(other, { maxFrameBytes: 4 });
  socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(5).buffer }));
  await assert.rejects(bounded.sendBytes(new Uint8Array(5)), /limit/);
  assert.equal(other.closed, true);
});

test("current writers cannot relay unknown, read-only, revoked, or another account's authors", async () => {
  const f = fixture();
  await f.bind(key);
  await assert.rejects(f.policy.put(key, otherKey, f.metadata.tree), /Unknown document author/);
  const release = await f.bind(otherKey, { ...f.identity, canWrite: false });
  release();
  await assert.rejects(f.policy.put(key, otherKey, f.metadata.tree), /Unknown document author/);
  f.policy.bindings.set(otherKey, {
    ...f.policy.bindings.get(otherKey),
    writer: true,
    revoked: true,
  });
  await assert.rejects(f.policy.put(key, otherKey, f.metadata.tree), /Unknown document author/);
  f.policy.bindings.set(otherKey, {
    ...f.policy.bindings.get(otherKey),
    revoked: false,
    principal: "user:another",
  });
  await assert.rejects(f.policy.put(key, otherKey, f.metadata.tree), /Unknown document author/);
});

test("recorded tool intent merges a human edit arriving while persistence yields", async () => {
  const f = mutationFixture();
  const original = f.storage.put.bind(f.storage);
  f.storage.put = async (key, value) => {
    await original(key, value);
    if (value.pending)
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

test("a failed old lease check cannot remove a replacement connection", async () => {
  const f = fixture();
  let rejectCheck;
  const checking = new Promise((_, reject) => {
    rejectCheck = reject;
  });
  const release = await f.policy.bind(key, key, f.identity, {
    reauthenticate: () => checking,
    disconnect: async () => {},
  });
  f.advance(20_000);
  const oldAccess = f.policy.active(key);
  release();
  await f.bind(key);
  rejectCheck(new Error("old credential revoked"));
  await assert.rejects(oldAccess, /old credential revoked/);
  await f.policy.active(key);
  assert.equal(f.policy.sessions.size, 1);
});

test("recovery resolves pending dependencies regardless of idempotency key order", async () => {
  const f = mutationFixture();
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
      receipt: { heads: A.getHeads(next) },
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
  const f = mutationFixture();
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
    receipt: { heads: A.getHeads(second) },
  });
  await assert.rejects(
    recoverDocumentMutations(f.storage, f.handle, f.context.flush),
    /dependencies are unavailable/,
  );
  assert.equal((await f.storage.get("host/operation/missing-parent")).pending, true);
});

test("catalog lists stored projections and late title updates cannot revive deleted pages", async () => {
  const storage = new Storage();
  await storage.put("page/one", {
    page_id: "one",
    title: "First",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
  });
  await storage.put("page/pending", { page_id: "pending", pending: true });
  assert.deepEqual(
    (await listCatalog(storage)).map((page) => page.title),
    ["First"],
  );
  await refreshCatalogTitle(storage, {
    page_id: "one",
    title: "Renamed",
    observed_at: "2026-10-02T00:00:00Z",
  });
  await refreshCatalogTitle(storage, {
    page_id: "one",
    title: "Stale",
    observed_at: "2026-10-01T00:00:00Z",
  });
  assert.equal((await listCatalog(storage))[0].title, "Renamed");
  await storage.delete("page/one");
  await refreshCatalogTitle(storage, {
    page_id: "one",
    title: "Deleted",
    observed_at: "2026-10-03T00:00:00Z",
  });
  assert.deepEqual(await listCatalog(storage), []);
});
