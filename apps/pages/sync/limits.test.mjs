import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { MemoryByteStore } from "./doc-store.mjs";
import { SyncHost } from "./host.mjs";
import { newId, raw, until } from "./test-helpers.mjs";

/** A byte store whose writes wait while held. */
class HeldByteStore extends MemoryByteStore {
  gate = null;
  hold() {
    let release;
    this.gate = new Promise((resolve) => (release = resolve));
    return () => {
      this.gate = null;
      release();
    };
  }
  async saveMany(entries) {
    await this.gate;
    return super.saveMany(entries);
  }
}

const syncHello = (changes) => {
  const m = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
  m.changes = changes;
  return A.encodeSyncMessage(m);
};

async function setup({ limits, policy } = {}) {
  const bytes = new HeldByteStore();
  const h = await new SyncHost({ bytes, limits, policy }).load();
  const id = newId();
  const base = A.from({ n: 0 }, { actor: "00".repeat(16) });
  await h.seed(id, "page", base);
  return { h, id, bytes, base };
}

const edit = (base, actor, n) =>
  A.getLastLocalChange(A.change(A.clone(base, { actor }), (d) => (d.n = n)));

test("a connection over the frame limit is refused and closed as temporarily unavailable", async () => {
  const { h, id, bytes, base } = await setup({ limits: { maxFrames: 2 } });
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  const release = bytes.hold();
  editor.link.client.send({
    t: "sync",
    doc: id,
    m: syncHello([edit(base, "aa".repeat(16), 1)]),
    r: 1,
  });
  editor.link.client.send({ t: "sync", doc: id, m: null, r: 2 });
  editor.link.client.send({ t: "sync", doc: id, m: null, r: 3 });
  await until(() => editor.frames.some((f) => f.t === "refused"), { label: "refusal" });
  const refused = editor.frames.find((f) => f.t === "refused");
  assert.deepEqual([refused.code, refused.r, refused.fatal], ["receive_queue_full", 3, true]);
  assert.equal(editor.link.client.closeCode, 4503);
  assert.equal(editor.link.client.closeReason, "temporarily_unavailable");
  await until(() => editor.conn.closed, { label: "closed" });
  // Two frames are still running: the connection closes, then drains.
  assert.deepEqual(editor.conn.receive, {
    phase: "closing",
    frames: 2,
    bytes: editor.conn.receive.bytes,
  });
  release();
  await until(() => editor.conn.receive.phase === "closed", { label: "drained" });
  // The frame admitted before the overflow is still stored.
  await until(async () => (await h.document(id)).n === 1, { label: "first frame stored" });
});

test("a frame over the byte limit is refused even on an empty queue", async () => {
  const { h, id, base } = await setup({ limits: { maxBytes: 64 } });
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  const m = syncHello([edit(base, "aa".repeat(16), 1)]);
  assert.ok(m.byteLength > 64);
  editor.link.client.send({ t: "sync", doc: id, m, r: 1 });
  await until(() => editor.frames.some((f) => f.t === "refused"));
  assert.equal(editor.frames.find((f) => f.t === "refused").code, "receive_queue_full");
  assert.equal((await h.document(id)).n, 0);
});

test("settled frames free their slots, so a steady connection never overflows", async () => {
  const { h, id, base } = await setup({ limits: { maxFrames: 1 } });
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  let doc = A.clone(base, { actor: "aa".repeat(16) });
  for (let i = 1; i <= 5; i++) {
    const before = doc;
    doc = A.change(doc, (d) => (d.n = i));
    editor.link.client.send({ t: "sync", doc: id, m: syncHello(A.getChanges(before, doc)), r: i });
    await until(() => editor.frames.some((f) => f.r === i), { label: `ack ${i}` });
  }
  assert.ok(editor.frames.every((f) => f.t === "sync"));
  assert.deepEqual(editor.conn.receive, { phase: "open", frames: 0, bytes: 0 });
  assert.equal((await h.document(id)).n, 5);
});

test("the host's own trusted connection has no receive limit", async () => {
  const { h, id, bytes } = await setup({ limits: { maxFrames: 1 } });
  const host = raw(h, { trusted: true, principal: "service:pages", senderId: "pages-host" });
  const release = bytes.hold();
  for (let r = 1; r <= 4; r++) host.link.client.send({ t: "sync", doc: id, m: null, r });
  await new Promise((resolve) => setTimeout(resolve, 20));
  release();
  await until(() => host.frames.length === 4, { label: "four acks" });
  assert.ok(host.frames.every((f) => f.t === "sync"));
});

test("an ephemeral message over the cap is refused and never fanned out", async () => {
  const { h, id } = await setup({ limits: { maxEphemeralBytes: 16 } });
  const reader = raw(h, { principal: "account:r", role: "viewer", senderId: "r" });
  reader.link.client.send({ t: "sync", doc: id, m: null, r: 1 });
  await until(() => reader.frames.length === 1);
  const big = raw(h, { principal: "account:b", role: "viewer", senderId: "b" });
  const small = raw(h, { principal: "account:s", role: "viewer", senderId: "s" });
  const eph = (n) => ({
    t: "eph",
    doc: id,
    e: {
      messageId: crypto.randomUUID(),
      origin: { kind: "repo", id: "x" },
      payload: new Uint8Array(n),
    },
  });
  big.link.client.send(eph(17));
  small.link.client.send(eph(16));
  await until(() => reader.frames.some((f) => f.t === "eph"), { label: "small presence" });
  await until(() => big.link.client.closed, { label: "big closed" });
  assert.equal(big.frames[0].code, "ephemeral_too_large");
  assert.equal(big.link.client.closeCode, 4400);
  const relayed = reader.frames.filter((f) => f.t === "eph");
  assert.deepEqual(
    relayed.map((f) => [f.sender.id, f.e.payload.byteLength]),
    [["s", 16]],
  );
});

test("unused previews are freed, but borrowed roots survive replacement", async () => {
  const { h, id, base } = await setup();
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  const send = async (changes, r) => {
    editor.link.client.send({ t: "sync", doc: id, m: syncHello(changes), r });
    await until(() => editor.frames.some((f) => f.r === r), { label: `answer ${r}` });
    return editor.frames.find((f) => f.r === r);
  };
  const before = await h.document(id);
  let freed = h.stats.freed;
  const one = A.change(A.clone(base, { actor: "aa".repeat(16) }), (d) => (d.n = 1));
  assert.equal((await send([A.getLastLocalChange(one)], 1)).t, "sync");
  assert.equal(h.stats.freed - freed, 0, "the replaced live doc was borrowed");
  assert.deepEqual(A.getHeads(before), A.getHeads(base));
  freed = h.stats.freed;
  // Re-sending held history: the preview has nothing new.
  assert.equal((await send([A.getLastLocalChange(one)], 2)).t, "sync");
  assert.equal(h.stats.freed - freed, 1, "an empty preview");
  freed = h.stats.freed;
  // A change whose dependency the host lacks.
  const two = A.change(A.clone(one, { actor: "aa".repeat(16) }), (d) => (d.n = 2));
  const three = A.change(A.clone(two, { actor: "aa".repeat(16) }), (d) => (d.n = 3));
  assert.equal((await send([A.getLastLocalChange(three)], 3)).code, "missing_dependencies");
  assert.equal(h.stats.freed - freed, 1, "a refused preview");
  freed = h.stats.freed;
  // An actor another principal claimed.
  const other = raw(h, { principal: "account:o", role: "editor", senderId: "o" });
  other.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(two)]), r: 1 });
  await until(() => other.frames.length);
  assert.equal(other.frames[0].code, "actor_claimed");
  assert.equal(h.stats.freed - freed, 1, "a preview refused for its claims");
  assert.equal((await h.document(id)).n, 1);
});

test("a replacement from policy.admit is adopted; the preview it replaced, and a refused replacement, are freed", async () => {
  let replacement;
  const { h, id, base, bytes } = await setup({
    policy: {
      admit: (_conn, _doc, _live, _fresh, preview) => (replacement = A.clone(preview)),
    },
  });
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  let freed = h.stats.freed;
  const one = A.change(A.clone(base, { actor: "aa".repeat(16) }), (d) => (d.n = 1));
  editor.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(one)]), r: 1 });
  await until(() => editor.frames.length === 1);
  assert.equal(h.stats.freed - freed, 2, "the preview and the replaced live doc");
  assert.equal((await h.document(id)).n, 1);
  assert.deepEqual(A.getHeads(replacement), A.getHeads(await h.document(id)));
  freed = h.stats.freed;
  const two = A.change(A.clone(one), (d) => (d.n = 2));
  bytes.failNext();
  editor.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(two)]), r: 2 });
  await until(() => editor.frames.length === 2);
  assert.equal(editor.frames[1].code, "io");
  assert.equal(
    h.stats.freed - freed,
    2,
    "the preview and its unstored replacement; the invalidated live doc was borrowed",
  );
  assert.throws(() => A.getHeads(replacement));
  assert.equal((await h.document(id)).n, 1);
});

test("a closed connection is released only after the refusals of frames still running", async () => {
  const events = [];
  let open;
  const gate = new Promise((resolve) => (open = resolve));
  const { h, id, base } = await setup({
    policy: {
      admit: async (_conn, _doc, _live, _fresh, preview) => {
        await gate;
        return preview;
      },
      refused: (_conn, _doc, refusal) => events.push(`refused:${refusal.code}`),
      released: (conn) => events.push(`released:${conn.senderId}`),
    },
  });
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  editor.link.client.send({
    t: "sync",
    doc: id,
    m: syncHello([edit(base, "aa".repeat(16), 1)]),
    r: 1,
  });
  editor.link.client.send({ t: "sync", doc: id, m: null, r: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
  editor.link.host.close(1001, "going away");
  await until(() => editor.conn.closed, { label: "closed" });
  assert.deepEqual(events, [], "nothing is released while frames run");
  open();
  await until(() => events.length === 2, { label: "release" });
  assert.deepEqual(events, ["refused:closed", "released:e"]);
  // A socket with nothing running is released at its close.
  const idle = raw(h, { principal: "account:i", role: "viewer", senderId: "i" });
  idle.link.host.close(1001, "going away");
  await until(() => events.length === 3);
  assert.equal(events[2], "released:i");
});
