import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { DurableByteStore, persistentSeed } from "./storage.mjs";
import { DocumentPolicy } from "./policy.mjs";
import { proposeAccessUpdate } from "./access.mjs";
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
  assert.deepEqual(policy.profiles(), {}, "stored author history is not a live roster");
  await policy.bind(key, key, f.identity, {
    reauthenticate: async () => f.identity,
    disconnect: async () => {},
  });
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

test("WebSocket bridge reports one bounded refusal category before closing", async () => {
  class Socket extends EventTarget {
    closes = [];
    close(code, reason) {
      this.closes.push([code, reason]);
      this.dispatchEvent(new Event("close"));
    }
    send() {}
  }
  const cases = [
    [
      "unsupported_frame",
      (socket) => socket.dispatchEvent(new MessageEvent("message", { data: "text" })),
    ],
    [
      "frame_too_large",
      (socket) =>
        socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(5).buffer })),
    ],
    [
      "receive_queue_full",
      (socket) => {
        for (let i = 0; i < 2; i++)
          socket.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(3).buffer }));
      },
    ],
    ["send_buffer_full", (_socket, wire) => wire.sendBytes(new Uint8Array(4)).catch(() => {})],
  ];
  for (const [category, trigger] of cases) {
    const socket = new Socket();
    const reported = [];
    const wire = new WebSocketByteTransport(socket, {
      maxFrameBytes: 4,
      maxQueuedBytes: 4,
      onRefusal: (value) => {
        reported.push(value);
        return wire.disconnect(4400, "request_rejected");
      },
    });
    if (category === "send_buffer_full") socket.bufferedAmount = 2;
    await trigger(socket, wire);
    await new Promise(setImmediate);
    assert.deepEqual(reported, [category]);
    assert.deepEqual(socket.closes, [[4400, "request_rejected"]], "the host's close wins");
  }
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

function grant(f, principal, role) {
  const proposal = proposeAccessUpdate(
    f.metadata,
    f.identity,
    {
      principal,
      role,
      expected_revision: f.metadata.acl?.revision ?? 0,
    },
    { now: 1000 },
  );
  f.metadata.acl = proposal.acl;
}

test("Page grants gate native writes independently of the credential ceiling", async () => {
  const f = fixture();
  grant(f, "user:viewer", "viewer");
  grant(f, "user:editor", "editor");
  const viewer = { ...f.identity, principal: "user:viewer" };
  await f.bind(key, viewer);
  await f.policy.access(key, f.metadata.tree);
  assert.equal(f.policy.bindings.get(key).writer, false);
  await assert.rejects(f.policy.put(key, key, f.metadata.tree), /read-only/);
  await f.bind(otherKey, { ...f.identity, principal: "user:editor", canWrite: false });
  await f.policy.access(otherKey, f.metadata.tree);
  await assert.rejects(f.policy.put(otherKey, otherKey, f.metadata.tree), /read-only/);
});

test("current editors can relay another member's admitted writer history", async () => {
  const f = fixture();
  grant(f, "user:editor", "editor");
  await f.bind(key, { ...f.identity, principal: "user:editor", expiresAt: 2000 });
  f.advance(3000);
  await f.bind(otherKey);
  await f.policy.put(otherKey, key, f.metadata.tree);
  assert.equal(f.policy.bindings.get(key).generation, 1);
});

test("downgrade disconnects the writer and allows its old key only for reads", async () => {
  const f = fixture();
  const editor = { ...f.identity, principal: "user:editor" };
  grant(f, editor.principal, "editor");
  await f.bind(key, editor);
  await f.bind(otherKey);
  grant(f, editor.principal, "viewer");
  await f.policy.refreshAccess();
  assert.equal(f.closed(), 1);
  assert.equal(f.policy.sessions.has(key), false);
  assert.equal(f.policy.sessions.has(otherKey), true);
  assert.equal(f.policy.bindings.get(key).retired, true);
  await assert.rejects(f.policy.put(otherKey, key, f.metadata.tree), /Unknown document author/);
  const release = await f.bind(key, editor);
  await f.policy.access(key, f.metadata.tree);
  release();
  grant(f, editor.principal, "editor");
  await f.policy.refreshAccess();
  await f.bind(key, editor);
  await assert.rejects(f.policy.put(key, key, f.metadata.tree), /Signing key is read-only/);
  const freshKey = "3".repeat(64);
  await f.bind(freshKey, editor);
  await f.policy.put(freshKey, freshKey, f.metadata.tree);
  assert.equal(f.policy.bindings.get(freshKey).generation, 3);
});

test("removal denies fetch/presence and regrant cannot resurrect old author keys", async () => {
  const f = fixture();
  const editor = { ...f.identity, principal: "user:editor" };
  grant(f, editor.principal, "editor");
  await f.bind(key, editor);
  await f.bind(otherKey);
  grant(f, editor.principal, null);
  await f.policy.refreshAccess();
  await assert.rejects(f.policy.access(key, f.metadata.tree), /Unknown peer/);
  await assert.rejects(f.bind(key, editor), /access denied/);
  await assert.rejects(f.policy.put(otherKey, key, f.metadata.tree), /Unknown document author/);
  grant(f, editor.principal, "editor");
  const restored = new DocumentPolicy({
    storage: f.storage,
    metadata: () => f.metadata,
    serverKey,
    now: () => 1000,
  });
  await restored.load();
  await restored.bind(key, key, editor, {
    reauthenticate: async () => editor,
    disconnect: async () => {},
  });
  await restored.access(key, f.metadata.tree);
  await assert.rejects(restored.put(key, key, f.metadata.tree), /Signing key is read-only/);
});

test("metadata generation alone denies old authors after restart even if retirement did not persist", async () => {
  const f = fixture();
  const editor = { ...f.identity, principal: "user:editor" };
  grant(f, editor.principal, "editor");
  await f.bind(key, editor);
  grant(f, editor.principal, null);
  grant(f, editor.principal, "editor");
  const restored = new DocumentPolicy({
    storage: f.storage,
    metadata: () => f.metadata,
    serverKey,
    now: () => 1000,
  });
  await restored.load();
  await restored.bind(otherKey, otherKey, f.identity, {
    reauthenticate: async () => f.identity,
    disconnect: async () => {},
  });
  await assert.rejects(restored.put(otherKey, key, f.metadata.tree), /Unknown document author/);
});

test("access refresh fails closed and disconnects even when retiring keys cannot be stored", async () => {
  const f = fixture();
  const editor = { ...f.identity, principal: "user:editor" };
  grant(f, editor.principal, "editor");
  await f.bind(key, editor);
  await f.bind(otherKey);
  grant(f, editor.principal, "viewer");
  f.storage.put = () => {
    throw Error("storage failed");
  };
  await assert.rejects(f.policy.refreshAccess(), /Access refresh failed/);
  assert.equal(f.closed(), 1);
  assert.equal(f.policy.bindings.get(key).writer, false);
  await assert.rejects(f.policy.put(otherKey, key, f.metadata.tree), /Unknown document author/);
});

test("reader signing keys are never promoted by a stronger credential", async () => {
  const f = fixture();
  const release = await f.bind(key, { ...f.identity, canWrite: false });
  release();
  await f.bind(key);
  await assert.rejects(f.policy.put(key, key, f.metadata.tree), /Signing key is read-only/);
  await f.bind(otherKey);
  await f.policy.put(otherKey, otherKey, f.metadata.tree);
});

test("ACL changes during key persistence cannot admit the stale writer", async () => {
  const f = fixture();
  const editor = { ...f.identity, principal: "user:editor" };
  grant(f, editor.principal, "editor");
  const put = f.storage.put.bind(f.storage);
  f.storage.put = async (name, value) => {
    await put(name, value);
    if (name === `host/binding/${key}`) grant(f, editor.principal, "viewer");
  };
  await assert.rejects(f.bind(key, editor), /access changed during connection/);
  assert.equal(f.policy.sessions.has(key), false);
});

test("author relay waits until the key binding is durably admitted", async () => {
  const f = fixture();
  await f.bind(otherKey);
  let continuePut;
  const stalled = new Promise((resolve) => {
    continuePut = resolve;
  });
  const put = f.storage.put.bind(f.storage);
  f.storage.put = async (name, value) => {
    if (name === `host/binding/${key}`) await stalled;
    await put(name, value);
  };
  const admission = f.bind(key);
  await assert.rejects(f.policy.put(otherKey, key, f.metadata.tree), /Unknown document author/);
  continuePut();
  await admission;
  await f.policy.put(otherKey, key, f.metadata.tree);
});

test("native fetch and ephemeral policy reject a removed member immediately", async () => {
  const f = fixture();
  const viewer = { ...f.identity, principal: "user:viewer" };
  grant(f, viewer.principal, "viewer");
  await f.bind(key, viewer);
  const nativeValue = (hex) => ({
    toBytes: () => Uint8Array.from(Buffer.from(hex, "hex")),
    free() {},
  });
  await f.policy.native().authorizeFetch(nativeValue(key), nativeValue(f.metadata.tree));
  await f.policy.ephemeral().authorizePublish(nativeValue(key), nativeValue(f.metadata.tree));
  grant(f, viewer.principal, null);
  await assert.rejects(
    f.policy.native().authorizeFetch(nativeValue(key), nativeValue(f.metadata.tree)),
    /access denied/,
  );
  await assert.rejects(
    f.policy.ephemeral().authorizePublish(nativeValue(key), nativeValue(f.metadata.tree)),
    /Unknown peer/,
  );
});

test("uncommitted permission reductions retire keys in memory without orphaning durable grants", async () => {
  const f = fixture();
  const editor = { ...f.identity, principal: "user:editor" };
  f.metadata.acl = {
    revision: 1,
    members: { [editor.principal]: { role: "editor", generation: 1 } },
  };
  await f.bind(key, editor);
  const persisted = await f.storage.get(`host/binding/${key}`);
  f.metadata.acl = {
    revision: 2,
    members: { [editor.principal]: { role: "viewer", generation: 2 } },
  };
  f.metadata.aclCommitting = true;
  await f.policy.refreshAccess({ persist: false });
  assert.equal(f.policy.bindings.get(key).retired, true);
  assert.deepEqual(await f.storage.get(`host/binding/${key}`), persisted);
  await assert.rejects(f.bind(otherKey, editor), /being updated/);
  delete f.metadata.aclCommitting;
  await f.policy.refreshAccess();
  assert.equal((await f.storage.get(`host/binding/${key}`)).retired, true);
});

const numberedKey = (value) => value.toString(16).padStart(64, "0");

test("one member cannot consume other members' or the owner's signing-key capacity", async () => {
  const f = fixture();
  const viewer = { ...f.identity, principal: "user:viewer" };
  grant(f, viewer.principal, "viewer");
  grant(f, "user:editor", "editor");
  for (let i = 1; i <= 32; i++) (await f.bind(numberedKey(i), viewer))();
  await assert.rejects(
    f.bind(numberedKey(33), { ...viewer, driver: "Different driver" }),
    /32 signing keys per member/,
  );
  assert.equal(f.policy.bindings.size, 32);
  (await f.bind(numberedKey(1), viewer))();
  await f.bind(key);
  await f.bind(otherKey, { ...f.identity, principal: "user:editor" });
  assert.equal(f.policy.bindings.size, 34);
  grant(f, viewer.principal, "editor");
  await f.policy.refreshAccess();
  await f.bind(numberedKey(1), viewer);
  await assert.rejects(
    f.policy.put(key, numberedKey(1), f.metadata.tree),
    /Unknown document author/,
  );
  await assert.rejects(f.bind(numberedKey(33), viewer), /32 signing keys per member/);
  assert.equal(f.policy.bindings.get(numberedKey(1)).retired, true);
});

test("member signing-key capacity reserves owner keys and known keys reconnect at the global cap", async () => {
  const f = fixture();
  let next = 1;
  for (let member = 0; member < 7; member++) {
    const identity = { ...f.identity, principal: `user:member-${member}` };
    grant(f, identity.principal, "viewer");
    for (let i = 0; i < 32; i++) (await f.bind(numberedKey(next++), identity))();
  }
  const nextMember = { ...f.identity, principal: "user:next-member" };
  grant(f, nextMember.principal, "editor");
  await assert.rejects(f.bind(numberedKey(next), nextMember), /Member signing-key capacity/);
  for (let i = 0; i < 32; i++) (await f.bind(numberedKey(next++)))();
  assert.equal(f.policy.bindings.size, 256);
  await assert.rejects(f.bind(numberedKey(next)), /256 signing keys/);
  const reader = { ...f.identity, principal: "user:member-0" };
  (await f.bind(numberedKey(1), reader))();
  (await f.bind(numberedKey(225)))();
  assert.equal(f.policy.bindings.size, 256);
  grant(f, reader.principal, null);
  await f.policy.refreshAccess();
  assert.equal(f.policy.bindings.size, 256, "retired-key denial records must remain durable");
});

test("uncertain key persistence retains its reservation and permits only an exact retry", async () => {
  const f = fixture();
  const viewer = { ...f.identity, principal: "user:viewer" };
  grant(f, viewer.principal, "viewer");
  for (let i = 1; i <= 31; i++) (await f.bind(numberedKey(i), viewer))();
  let fail;
  const waiting = new Promise((_, reject) => {
    fail = reject;
  });
  const put = f.storage.put.bind(f.storage);
  f.storage.put = async (name, value) => {
    if (name === `host/binding/${numberedKey(32)}`) await waiting;
    return put(name, value);
  };
  const admission = f.bind(numberedKey(32), viewer);
  const denied = assert.rejects(admission, { code: "native_binding_persistence_failed" });
  await assert.rejects(f.bind(numberedKey(33), viewer), /32 signing keys per member/);
  assert.deepEqual(f.policy.profiles(), {}, "pending keys do not expose profiles");
  fail(new Error("fixture persistence failure"));
  await denied;
  assert.equal(f.policy.bindings.size, 32);
  assert.equal(f.policy.sessions.size, 0);
  await assert.rejects(f.bind(numberedKey(33), viewer), /32 signing keys per member/);
  f.storage.put = put;
  await f.bind(numberedKey(32), viewer);
  assert.equal(f.policy.bindings.size, 32);
});

test("presence profiles include only live authorized bindings without discarding author history", async () => {
  const f = fixture();
  const editor = { ...f.identity, principal: "user:editor" };
  grant(f, editor.principal, "editor");
  const release = await f.bind(key, editor);
  await f.bind(otherKey);
  assert.equal(f.policy.profiles()[key].principal, editor.principal);
  release();
  assert.equal(f.policy.profiles()[key], undefined);
  await f.policy.put(otherKey, key, f.metadata.tree);
  await f.bind(key, editor);
  grant(f, editor.principal, "viewer");
  assert.equal(f.policy.profiles()[key], undefined, "a changed grant hides a stale live lease");
  await f.policy.refreshAccess();
  await f.bind(key, editor);
  assert.equal(f.policy.profiles()[key], undefined, "retired keys are not presence identities");
  await f.bind("3".repeat(64), editor);
  assert.equal(f.policy.profiles()["3".repeat(64)].principal, editor.principal);
  grant(f, editor.principal, null);
  assert.equal(f.policy.profiles()["3".repeat(64)], undefined);
  await f.policy.refreshAccess();
  assert.ok(f.policy.bindings.has(key));
  assert.ok(f.storage.values.has(`host/binding/${key}`));
  f.advance(62_000);
  assert.deepEqual(f.policy.profiles(), {}, "expired live leases are excluded immediately");
});

const apiLeaseIdentity = (f, extra = {}) => ({
  ...f.identity,
  credentialKind: "api-key",
  namespace: "pages-test",
  ...extra,
});

test("API-key renewal survives two lifetimes without changing durable author authority", async () => {
  const f = fixture(),
    identity = apiLeaseIdentity(f),
    deadlines = [];
  await f.policy.bind(key, key, identity, {
    reauthenticate: async () => ({ ...identity, expiresAt: f.policy.now() + 60000 }),
    disconnect: async () => assert.fail("valid renewed lease must stay connected"),
    onRenewal: (deadline) => deadlines.push(deadline),
  });
  const author = structuredClone(f.policy.bindings.get(key));
  const persisted = await f.storage.get(`host/binding/${key}`);
  for (let now = 16000; now <= 136000; now += 15000) {
    f.advance(now);
    await f.policy.put(key, key, f.metadata.tree);
    assert.equal(f.policy.sessions.get(key).identity.expiresAt, now + 60000);
    assert.ok(f.policy.profiles()[key]);
  }
  assert.equal(deadlines.length, 9);
  assert.deepEqual(f.policy.bindings.get(key), author);
  assert.deepEqual(await f.storage.get(`host/binding/${key}`), persisted);
});

test("OIDC rechecks retain the admitted absolute expiry", async () => {
  const f = fixture(),
    identity = { ...f.identity, credentialKind: "session", namespace: "pages-test" };
  let closed = false;
  await f.policy.bind(key, key, identity, {
    reauthenticate: async () => ({ ...identity, expiresAt: 121000 }),
    disconnect: async () => {
      closed = true;
    },
    onRenewal: () => assert.fail("OIDC cannot extend the admitted session"),
  });
  f.advance(16000);
  await f.policy.active(key);
  assert.equal(f.policy.sessions.get(key).identity, identity);
  f.advance(61000);
  await assert.rejects(f.policy.active(key), /access denied/);
  assert.equal(closed, true);
});

for (const [field, value] of [
  ["principal", "user:other"],
  ["canWrite", false],
  ["namespace", "another-provider"],
  ["driver", "another-driver"],
  ["credentialKind", "session"],
  ["expiresAt", 16000],
  ["expiresAt", NaN],
  ["expiresAt", Infinity],
]) {
  test(`API-key renewal rejects changed or invalid ${field}=${String(value)}`, async () => {
    const f = fixture(),
      identity = apiLeaseIdentity(f);
    let closed = false;
    await f.policy.bind(key, key, identity, {
      reauthenticate: async () => ({ ...identity, expiresAt: 76000, [field]: value }),
      disconnect: async () => {
        closed = true;
      },
      onRenewal: () => assert.fail("rejected verification cannot extend a socket"),
    });
    f.advance(16000);
    await assert.rejects(f.policy.active(key), /Credential changed|access denied/);
    assert.equal(closed, true);
    assert.equal(f.policy.sessions.has(key), false);
  });
}

test("late verification cannot renew an expired API-key lease", async () => {
  const f = fixture(),
    identity = apiLeaseIdentity(f);
  let resolveCheck,
    closed = false;
  await f.policy.bind(key, key, identity, {
    reauthenticate: () =>
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    disconnect: async () => {
      closed = true;
    },
    onRenewal: () => assert.fail("expired authority cannot revive"),
  });
  f.advance(16000);
  const pending = f.policy.active(key);
  f.advance(61000);
  resolveCheck({ ...identity, expiresAt: 121000 });
  await assert.rejects(pending, /access denied/);
  assert.equal(closed, true);
  assert.equal(f.policy.sessions.has(key), false);
});

test("successful old renewal cannot change a replacement connection or timer", async () => {
  const f = fixture(),
    identity = apiLeaseIdentity(f);
  let resolveCheck;
  const release = await f.policy.bind(key, key, identity, {
    reauthenticate: () =>
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    disconnect: async () => {},
    onRenewal: () => assert.fail("released socket cannot renew"),
  });
  f.advance(16000);
  const pending = f.policy.active(key);
  release();
  const replacement = { ...identity, expiresAt: 136000 };
  await f.bind(key, replacement);
  const session = f.policy.sessions.get(key);
  resolveCheck({ ...identity, expiresAt: 76000 });
  await assert.rejects(pending, /Connection ended/);
  assert.equal(f.policy.sessions.get(key), session);
  assert.equal(session.identity, replacement);
  await f.policy.active(key);
});

for (const roles of [["viewer"], ["none"], ["none", "editor"]]) {
  test(`pending renewal cannot restore authority after ACL ${roles.join(" then ")}`, async () => {
    const f = fixture();
    f.metadata.acl = { revision: 1, members: { "user:editor": { role: "editor", generation: 1 } } };
    const identity = apiLeaseIdentity(f, { principal: "user:editor" });
    let resolveCheck,
      closed = false;
    await f.policy.bind(key, key, identity, {
      reauthenticate: () =>
        new Promise((resolve) => {
          resolveCheck = resolve;
        }),
      disconnect: async () => {
        closed = true;
      },
      onRenewal: () => assert.fail("old grant cannot renew"),
    });
    f.advance(16000);
    const pending = f.policy.active(key);
    for (const role of roles) grant(f, identity.principal, role === "none" ? null : role);
    resolveCheck({ ...identity, expiresAt: 76000 });
    await assert.rejects(pending, /Page access changed|access denied/);
    assert.equal(closed, true);
    assert.equal(f.policy.sessions.has(key), false);
    await assert.rejects(f.policy.put(key, key, f.metadata.tree));
  });
}
