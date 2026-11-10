import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { documentIdToBinary } from "@automerge/automerge-repo";
import { AutomergeSyncBackend } from "./backend.mjs";
import { DocStore, MemoryByteStore, OBJECT_PART_BYTES } from "./doc-store.mjs";
import { Refusal } from "./host.mjs";
import { framePipe } from "./wire.mjs";
import { browser, host, idle, newId, raw, reconnect, until, urlOf } from "./test-helpers.mjs";

const hexOf = (handle) => Buffer.from(documentIdToBinary(handle.documentId)).toString("hex");
const commitRecord = (bytes) => {
  const c = A.decodeChange(bytes);
  return {
    kind: "commit",
    id: c.hash,
    parents: [...c.deps].sort(),
    blob: bytes,
  };
};
const syncHello = (changes) => {
  const m = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
  m.changes = changes;
  return A.encodeSyncMessage(m);
};

test("a failed cold load clears its promise and does not reload actor claims", async () => {
  const bytes = new MemoryByteStore();
  const h = await host({ bytes });
  const id = newId();
  h.register(id);
  const load = bytes.load.bind(bytes);
  let fail = true;
  bytes.load = async (key) => {
    assert.ok(!key.startsWith("actor/"));
    if (fail) {
      fail = false;
      throw Error("transient read");
    }
    return load(key);
  };
  h.load = async () => {
    throw Error("claims must not reload on cold open");
  };
  await assert.rejects(h.document(id), /transient read/);
  assert.deepEqual(A.getHeads(await h.document(id)), []);
});

test("Repo 3 creates on one browser, finds cold on another, and edits both ways", async () => {
  const h = await host();
  const alice = await browser(h, { principal: "account:alice" });
  const bob = await browser(h, { principal: "account:bob" });
  try {
    const created = await alice.repo.create({ title: "Hello", blocks: {} });
    const id = hexOf(created);
    h.register(id);
    await alice.repo.flush();
    await until(async () => A.getHeads(await h.document(id)).length, {
      label: "host has the doc",
    });
    const found = await bob.repo.find(created.url);
    assert.equal(found.doc().title, "Hello");
    found.change((d) => (d.title = "Hello from Bob"));
    await until(() => created.doc().title === "Hello from Bob", {
      label: "Alice sees Bob",
    });
    created.change((d) => (d.blocks.b1 = { markdown: "Alice" }));
    await until(() => found.doc().blocks.b1?.markdown === "Alice", {
      label: "Bob sees Alice",
    });
    assert.equal(h.actor(A.getActorId(created.doc())).principal, "account:alice");
    assert.equal(h.actor(A.getActorId(found.doc())).principal, "account:bob");
  } finally {
    await alice.repo.shutdown();
    await bob.repo.shutdown();
  }
});

test("a document the host doesn't serve is unavailable", async () => {
  const h = await host();
  const offline = await browser(h, { principal: "account:x" }, { connect: false });
  const bob = await browser(h, { principal: "account:bob" });
  try {
    const made = await offline.repo.create({ a: 1 });
    await assert.rejects(bob.repo.find(made.url));
  } finally {
    await offline.repo.shutdown();
    await bob.repo.shutdown();
  }
});

test("presence arrives with the host-stamped sender id", async () => {
  const h = await host();
  const alice = await browser(h, { principal: "account:alice" });
  const bob = await browser(h, { principal: "account:bob" });
  try {
    const ha = await alice.repo.create({ x: 1 });
    h.register(hexOf(ha));
    await alice.repo.flush();
    await until(async () => A.getHeads(await h.document(hexOf(ha))).length);
    const hb = await bob.repo.find(ha.url);
    await idle();
    const got = [];
    hb.on("ephemeral-message", (e) => got.push(e));
    ha.broadcast({ caret: 3 });
    await until(() => got.length > 0, { label: "presence" });
    assert.deepEqual(got[0].message, { caret: 3 });
    assert.equal(got[0].senderId, alice.identity.senderId);
  } finally {
    await alice.repo.shutdown();
    await bob.repo.shutdown();
  }
});

test("a browser reopens from its store and catches up with its saved sync state", async () => {
  const h = await host();
  const bytes = new MemoryByteStore();
  const alice = await browser(h, { principal: "account:alice" }, { bytes });
  const ha = await alice.repo.create({ n: 0 });
  const id = hexOf(ha);
  h.register(id);
  for (let i = 1; i <= 20; i++) ha.change((d) => (d.n = i));
  await alice.repo.flush();
  await until(async () => (await h.document(id)).n === 20, {
    label: "host n=20",
  });
  const session = alice.backend.open(id);
  assert.equal((await session.synchronize()).outcome, "complete");
  await alice.backend.flush();
  await alice.repo.shutdown();

  const bob = await browser(h, { principal: "account:bob" });
  const hb = await bob.repo.find(ha.url);
  hb.change((d) => (d.n = 99));
  await until(async () => (await h.document(id)).n === 99);

  const again = await browser(h, { principal: "account:alice" }, { bytes, connect: false });
  try {
    const local = await again.repo.find(ha.url);
    assert.equal(local.doc().n, 20);
    const link = reconnect(again, h);
    await until(() => local.doc().n === 99, { label: "catch up" });
    // A saved sync state means the host sends only the missing change.
    assert.ok(link.stats.bToA < 2000, `catch-up took ${link.stats.bToA} bytes`);
  } finally {
    await again.repo.shutdown();
    await bob.repo.shutdown();
  }
});

test("the store splits large objects into parts and reads them back", async () => {
  const bytes = new MemoryByteStore();
  const store = new DocStore(bytes);
  const id = newId();
  const big = crypto.getRandomValues(new Uint8Array(65536));
  const blob = new Uint8Array(OBJECT_PART_BYTES * 2 + 17);
  for (let i = 0; i < blob.length; i += big.length)
    blob.set(big.subarray(0, Math.min(big.length, blob.length - i)), i);
  await store.compact(id, blob, ["aa".repeat(32)]);
  assert.equal((await bytes.list(`sync/${id}/o/`)).length, 3);
  const read = await new DocStore(bytes).read(id);
  assert.deepEqual(read.snapshot, blob);
});

test("an ambiguous host append reloads durable history and actor claims before the next frame", async () => {
  const bytes = new MemoryByteStore();
  const h = await host({ bytes });
  const id = newId();
  const base = A.from({ n: 0 });
  await h.seed(id, "page", base);
  const actor = "ac".repeat(16);
  const one = A.change(A.clone(base, { actor }), (d) => {
    d.n = 1;
  });
  const save = bytes.saveMany.bind(bytes);
  bytes.saveMany = async (entries) => {
    await save(entries);
    throw Error("committed then failed");
  };
  const writer = raw(h, { principal: "account:a", role: "editor", senderId: "a" });
  writer.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(one)]), r: 1 });
  await until(() => writer.frames.length);
  assert.equal(writer.frames[0].code, "io");
  bytes.saveMany = save;
  const load = bytes.load.bind(bytes);
  let failedClaimRead = false;
  bytes.load = async (key) => {
    if (key.startsWith("actor/") && !failedClaimRead) {
      failedClaimRead = true;
      throw Error("transient claim read");
    }
    return load(key);
  };
  await assert.rejects(h.document(id), /transient claim read/);
  assert.equal((await h.document(id)).n, 1);
  const two = A.change(one, (d) => {
    d.n = 2;
  });
  const forger = raw(h, { principal: "account:b", role: "editor", senderId: "b" });
  forger.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(two)]), r: 1 });
  await until(() => forger.frames.length);
  assert.equal(forger.frames[0].code, "actor_claimed");
  assert.equal((await h.document(id)).n, 1);
  writer.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(two)]), r: 2 });
  await until(() => writer.frames.some((f) => f.r === 2));
  assert.equal((await h.document(id)).n, 2);
});

// Regressions for the independent review of the experiment.

test("one actor binds to one principal even across documents admitted at once", async () => {
  const h = await host();
  const [d1, d2] = [newId(), newId()];
  const base = A.from({ x: 0 }, { actor: "00".repeat(16) });
  await h.seed(d1, "page", base);
  await h.seed(d2, "page", base);
  const change = A.getLastLocalChange(
    A.change(A.clone(base, { actor: "ab".repeat(16) }), (d) => (d.x = 1)),
  );
  const alice = raw(h, {
    principal: "account:alice",
    role: "editor",
    senderId: "a",
  });
  const bob = raw(h, {
    principal: "account:bob",
    role: "editor",
    senderId: "b",
  });
  alice.link.client.send({ t: "sync", doc: d1, m: syncHello([change]), r: 1 });
  bob.link.client.send({ t: "sync", doc: d2, m: syncHello([change]), r: 1 });
  await until(() => alice.frames.length && bob.frames.length);
  assert.deepEqual([alice.frames[0].t, bob.frames[0].t].sort(), ["refused", "sync"]);
  const counts = await Promise.all(
    [d1, d2].map(async (d) => A.getAllChanges(await h.document(d)).length),
  );
  assert.deepEqual(counts.sort(), [1, 2]);
});

test("revoked or expired connections can't read and stop receiving fan-out", async () => {
  let clock = 0;
  const revoked = new Set();
  const h = await host({
    now: () => clock,
    policy: {
      denied: (conn, now) =>
        revoked.has(conn.principal)
          ? new Refusal("revoked", "Access was revoked", { fatal: true })
          : conn.expiresAt !== undefined && conn.expiresAt <= now
            ? new Refusal("expired", "The lease expired", { fatal: true })
            : null,
    },
  });
  const id = newId();
  await h.seed(id, "page", A.from({ x: 0 }));
  const reader = raw(h, {
    principal: "account:r",
    role: "viewer",
    senderId: "r",
    expiresAt: 100,
  });
  reader.link.client.send({ t: "sync", doc: id, m: syncHello([]), r: 1 });
  await until(() => reader.frames.length >= 1);
  assert.equal(reader.frames[0].has, true);
  clock = 200;
  const writer = raw(h, {
    principal: "account:w",
    role: "editor",
    senderId: "w",
  });
  const next = A.change(A.clone(await h.document(id)), (d) => (d.x = 2));
  writer.link.client.send({
    t: "sync",
    doc: id,
    m: syncHello(A.getAllChanges(next)),
    r: 1,
  });
  await until(() => reader.link.client.closed, {
    label: "expired reader closed",
  });
  assert.equal(
    reader.frames.some((f) => f.t === "sync" && f.m && f.r === undefined),
    false,
  );
  revoked.add("account:w");
  writer.link.client.send({ t: "sync", doc: id, m: null, r: 2 });
  await until(() => writer.frames.some((f) => f.t === "refused"));
});

test("a failed write is reported at flush and repaired by the next write", async () => {
  const bytes = new MemoryByteStore();
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(bytes),
  });
  const id = newId();
  let doc = A.from({ n: 0 }, { actor: "ef".repeat(16) });
  await backend.store(id, [commitRecord(A.getLastLocalChange(doc))]);
  doc = A.change(doc, (d) => (d.n = 1));
  bytes.failNext();
  await assert.rejects(backend.store(id, [commitRecord(A.getLastLocalChange(doc))]));
  await assert.rejects(backend.flush([id]), (e) => e.code === "io");
  doc = A.change(doc, (d) => (d.n = 2));
  await backend.store(id, [commitRecord(A.getLastLocalChange(doc))]);
  await backend.flush([id]);
  await backend.close();
  const reopened = await AutomergeSyncBackend.load({
    store: new DocStore(bytes),
  });
  const it = reopened.open(id).events[Symbol.asyncIterator]();
  const { value } = await it.next();
  assert.equal(A.load(value.records[0].blob).n, 2);
  await reopened.close();
});

test("open is refused while the document's deletion runs", async () => {
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
  });
  const id = newId();
  await backend.store(id, [commitRecord(A.getLastLocalChange(A.from({ a: 1 })))]);
  const deleting = backend.deleteLocal(id);
  assert.throws(
    () => backend.open(id),
    (e) => e.code === "deleted",
  );
  await deleting;
  backend.open(id);
  await backend.close();
});

test("a round against a silent host ends failed", async () => {
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
    syncTimeoutMs: 50,
  });
  backend.addConnection(framePipe().client);
  const id = newId();
  await backend.store(id, [commitRecord(A.getLastLocalChange(A.from({ a: 1 })))]);
  assert.equal((await backend.open(id).synchronize()).outcome, "failed");
  await backend.close();
});

test("the round a cold open starts completes without waiting for the timeout", async () => {
  const h = await host();
  const id = newId();
  let d = A.from({ n: 0 });
  for (let i = 0; i < 20; i++) d = A.change(d, (x) => (x.n = i));
  await h.seed(id, "page", d);
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
    syncTimeoutMs: 5000,
  });
  const link = framePipe();
  h.accept(link.host, { principal: "v", role: "viewer", senderId: "v" });
  backend.addConnection(link.client);
  const session = backend.open(id);
  const started = Date.now();
  const first = await session.synchronize();
  const second = await session.synchronize();
  assert.deepEqual(
    [first.outcome, second.outcome, first.peers[0].outcome],
    ["complete", "complete", "complete"],
  );
  assert.deepEqual(first.checkpoint.heads, A.getHeads(d));
  assert.ok(Date.now() - started < 1000);
  await backend.close();
});

test("a document record is bounded by the snapshot limit, not the record limit", async () => {
  const backend = await AutomergeSyncBackend.load({
    store: new DocStore(new MemoryByteStore()),
    maxRecordBytes: 1024,
    maxSnapshotBytes: 1024 * 1024,
  });
  const id = newId();
  const doc = A.from({
    text: crypto.getRandomValues(new Uint8Array(4096)).join(","),
  });
  const record = {
    kind: "document",
    heads: A.getHeads(doc),
    blob: A.save(doc),
  };
  assert.ok(record.blob.byteLength > 1024);
  await backend.store(id, [record]);
  await backend.store(id, [record]); // a reopen restores the same checkpoint again
  const big = A.change(
    doc,
    (d) => (d.more = crypto.getRandomValues(new Uint8Array(4096)).join(",")),
  );
  await assert.rejects(
    backend.store(id, [commitRecord(A.getLastLocalChange(big))]),
    (e) => e.code === "invalid-record",
  );
  await backend.close();
});
