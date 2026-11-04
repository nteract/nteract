import assert from "node:assert/strict";
import { test } from "node:test";
import * as A from "@automerge/automerge";
import { DocStore, MemoryByteStore } from "./doc-store.mjs";
import { SyncHost } from "./host.mjs";
import { idle, newId, raw, until } from "./test-helpers.mjs";

/** A byte store whose writes wait while held, and can fail a later write. */
class TestByteStore extends MemoryByteStore {
  gate = null;
  waiting = 0;
  failAt = 0;
  hold() {
    let release;
    this.gate = new Promise((resolve) => (release = resolve));
    return () => {
      this.gate = null;
      release();
    };
  }
  /** Fail the `n`th saveMany from now. */
  failSave(n) {
    this.failAt = n;
  }
  async saveMany(entries) {
    this.waiting++;
    await this.gate;
    this.waiting--;
    if (this.failAt && --this.failAt === 0) throw new Error("injected compaction failure");
    return super.saveMany(entries);
  }
}

const syncHello = (changes) => {
  const m = A.decodeSyncMessage(A.generateSyncMessage(A.init(), A.initSyncState())[1]);
  m.changes = changes;
  return A.encodeSyncMessage(m);
};
const ACTOR = "aa".repeat(16);

test("a round's latency runs from the frame's arrival to its ack, on the host's clock", async () => {
  let clock = 1000;
  const bytes = new TestByteStore();
  const rounds = [];
  const h = await new SyncHost({
    bytes,
    now: () => clock,
    policy: { synced: (conn, _doc, round) => rounds.push({ who: conn.senderId, ...round }) },
  }).load();
  const id = newId();
  const base = A.from({ n: 0 }, { actor: "00".repeat(16) });
  await h.seed(id, "page", base);
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  const viewer = raw(h, { principal: "account:v", role: "viewer", senderId: "v" });
  const one = A.change(A.clone(base, { actor: ACTOR }), (d) => (d.n = 1));
  const two = A.change(A.clone(one, { actor: ACTOR }), (d) => (d.n = 2));

  const release = bytes.hold();
  editor.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(one)]), r: 1 });
  await until(() => bytes.waiting === 1, { label: "first frame persisting" });
  clock = 1010;
  editor.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(two)]), r: 2 });
  // Neither a frame without changes nor a stripped one is a round.
  editor.link.client.send({ t: "sync", doc: id, m: null, r: 3 });
  viewer.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(two)]), r: 1 });
  await idle();
  clock = 1050;
  release();
  await until(() => editor.frames.length === 3 && viewer.frames.length === 1, { label: "acks" });
  assert.deepEqual(
    rounds.map(({ who, ms, waitMs, changes }) => ({ who, ms, waitMs, changes })),
    [
      { who: "e", ms: 50, waitMs: 0, changes: 1 },
      { who: "e", ms: 40, waitMs: 40, changes: 1 },
    ],
  );
  assert.ok(rounds.every((round) => round.bytes > 0));
});

test("a compaction failure after the ack is reported, not refused, and the next write compacts", async () => {
  const bytes = new TestByteStore();
  const failures = [];
  const h = new SyncHost({
    bytes,
    policy: { compactionFailed: (doc, error) => failures.push([doc.id, error.message]) },
  });
  // A floor of zero, so a write over half the snapshot compacts.
  h.store = new DocStore(bytes, { compactMinBytes: 0 });
  await h.load();
  const id = newId();
  const base = A.from({ n: 0 }, { actor: "00".repeat(16) });
  await h.seed(id, "page", base);
  const editor = raw(h, { principal: "account:e", role: "editor", senderId: "e" });
  const filler = () => Buffer.from(crypto.getRandomValues(new Uint8Array(512))).toString("hex");
  const one = A.change(A.clone(base, { actor: ACTOR }), (d) => (d.text = filler()));
  bytes.failSave(2); // the append succeeds, the compaction after it fails
  editor.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(one)]), r: 1 });
  await until(() => failures.length === 1, { label: "compaction failure" });
  assert.deepEqual(failures, [[id, "injected compaction failure"]]);
  await until(() => editor.frames.length === 1, { label: "ack" });
  assert.equal(editor.frames[0].t, "sync", "the stored frame is acked, never refused");
  assert.equal(h.stats.refused, 0);
  assert.equal(h.stats.compactionFailures, 1);
  assert.deepEqual(await h.durableHeads(id), A.getHeads(one));
  assert.ok(h.store.manifest(id).chunks.length, "the chunk is still stored");

  const two = A.change(A.clone(one, { actor: ACTOR }), (d) => (d.n = 2));
  editor.link.client.send({ t: "sync", doc: id, m: syncHello([A.getLastLocalChange(two)]), r: 2 });
  await until(() => h.stats.compactions === 1, { label: "next compaction" });
  assert.deepEqual(h.store.manifest(id).chunks, []);
  const stored = await new DocStore(bytes).read(id);
  const loaded = A.load(stored.snapshot);
  assert.equal(loaded.n, 2);
  assert.equal(loaded.text, one.text);
});

test("compaction waits for chunks over both half the snapshot and the floor", async () => {
  const kib = 1024;
  const heads = ["aa".repeat(32)];
  const cases = [
    // [snapshot bytes, chunk sizes, wants compaction]
    [0, [1 * kib], false],
    [0, [40 * kib, 25 * kib], true],
    [100 * kib, [51 * kib], false],
    [100 * kib, [65 * kib], true],
    [1024 * kib, [100 * kib], false],
    [1024 * kib, [300 * kib, 213 * kib], true],
  ];
  for (const [snapshot, chunks, wants] of cases) {
    const store = new DocStore(new MemoryByteStore());
    const id = newId();
    if (snapshot) await store.compact(id, new Uint8Array(snapshot), heads);
    for (const size of chunks) await store.append(id, new Uint8Array(size), heads);
    assert.equal(
      store.wantsCompaction(id),
      wants,
      `${snapshot / kib} KiB + ${chunks.map((c) => c / kib)}`,
    );
  }
});
