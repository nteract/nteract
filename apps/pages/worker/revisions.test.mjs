import assert from "node:assert/strict";
import { test } from "node:test";
import {
  fencedHeads,
  headsFor,
  latestRevision,
  parseRevision,
  REVISION_LIMIT,
  revisionFor,
  revisionKey,
  revisionPlan,
} from "./revisions.mjs";

const at = Date.parse("2026-11-11T00:00:00Z");
const heads = (label) => [label.repeat(64).slice(0, 64)];
class Storage {
  values = new Map();
  durable = new Map();
  failSync = false;
  failPut = false;
  syncs = 0;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (this.failPut) throw Error("injected put failure");
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    return this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
  async sync() {
    this.syncs++;
    if (this.failSync) throw Error("injected sync failure");
    this.durable = structuredClone(this.values);
  }
  restart() {
    this.values = structuredClone(this.durable);
  }
}

test("minting writes the counter, latest and record together and returns after a barrier", async () => {
  const storage = new Storage();
  assert.equal(await revisionFor(storage, "page", heads("a"), at), "r1");
  assert.equal(await revisionFor(storage, "comments", heads("a"), at), "c1");
  assert.equal(await revisionFor(storage, "page", heads("b"), at + 1), "r2");
  storage.restart();
  assert.deepEqual(await latestRevision(storage, "page"), { n: 2, heads: heads("b"), at: at + 1 });
  assert.equal(await storage.get("host/revision/page/counter"), 2);
  assert.deepEqual(await storage.get(revisionKey("page", 1)), { heads: heads("a"), at });
  assert.deepEqual(await headsFor(storage, "comments", "c1"), heads("a"));
});

test("the same heads reuse the latest handle and write nothing", async () => {
  const storage = new Storage();
  await revisionFor(storage, "page", heads("a"), at);
  const before = structuredClone(storage.values);
  const syncs = storage.syncs;
  storage.failPut = true;
  assert.equal(await revisionFor(storage, "page", [...heads("a")], at + 5), "r1");
  assert.deepEqual(storage.values, before);
  assert.equal(storage.syncs, syncs, "a handle known durable needs no barrier");
});

test("a handle is never reissued for other heads after a lost put or a failed barrier", async () => {
  const storage = new Storage();
  assert.equal(await revisionFor(storage, "page", heads("a"), at), "r1");
  // A put that never lands spends no number and hands out no handle.
  storage.failPut = true;
  await assert.rejects(revisionFor(storage, "page", heads("b"), at), /injected put failure/);
  storage.failPut = false;
  // A put that lands without its barrier hands out nothing either, but its
  // number stays spent while the process lives.
  storage.failSync = true;
  await assert.rejects(revisionFor(storage, "page", heads("b"), at), /injected sync failure/);
  storage.failSync = false;
  assert.equal(await revisionFor(storage, "page", heads("c"), at), "r3");
  assert.deepEqual(await headsFor(storage, "page", "r3"), heads("c"));
  // r2 named heads b in memory only; after a restart it is unknown.
  storage.restart();
  assert.equal(await revisionFor(storage, "page", heads("c"), at), "r3");
  assert.deepEqual(await headsFor(storage, "page", "r2"), heads("b"));
});

test("a reused handle from a put whose barrier failed is synced before it is returned", async () => {
  const storage = new Storage();
  storage.failSync = true;
  await assert.rejects(revisionFor(storage, "page", heads("a"), at), /injected sync failure/);
  storage.failSync = false;
  const syncs = storage.syncs;
  assert.equal(await revisionFor(storage, "page", heads("a"), at), "r1");
  assert.equal(storage.syncs, syncs + 1);
});

test("a plan mints several handles for one put and numbers them in order", async () => {
  const storage = new Storage();
  await revisionFor(storage, "page", heads("a"), at);
  const plan = revisionPlan(storage, at + 1);
  assert.equal(await plan.handle("page", heads("a")), "r1");
  assert.equal(await plan.handle("page", heads("b")), "r2");
  assert.equal(await plan.handle("page", heads("c")), "r3");
  assert.equal(await plan.handle("comments", heads("c")), "c1");
  assert.equal(await storage.get(revisionKey("page", 2)), undefined, "nothing written yet");
  await storage.put(plan.writes);
  assert.ok(plan.needsBarrier());
  await storage.sync();
  await plan.settle();
  assert.deepEqual(await latestRevision(storage, "page"), { n: 3, heads: heads("c"), at: at + 1 });
  assert.deepEqual(await headsFor(storage, "page", "r2"), heads("b"));
});

test("the table keeps the newest handles and always the latest", async () => {
  const storage = new Storage();
  const total = REVISION_LIMIT + 3;
  for (let n = 1; n <= total; n++)
    await revisionFor(storage, "page", [n.toString(16).padStart(64, "0")], at + n);
  const records = await storage.list({ prefix: "host/revision/page/h/" });
  assert.equal(records.size, REVISION_LIMIT);
  await assert.rejects(headsFor(storage, "page", "r3"), { status: 409, code: "resync_required" });
  assert.ok(await headsFor(storage, "page", "r4"));
  assert.ok(await headsFor(storage, "page", `r${total}`));
});

test("an unknown handle is resync_required and a malformed one invalid_revision", async () => {
  const storage = new Storage();
  await revisionFor(storage, "page", heads("a"), at);
  await assert.rejects(headsFor(storage, "page", "r9"), { status: 409, code: "resync_required" });
  for (const value of ["c1", "r0", "r01", "1", "rr1", "r1.5", "", 1, null, "r12345678901234567"])
    await assert.rejects(headsFor(storage, "page", value), {
      status: 400,
      code: "invalid_revision",
    });
  assert.throws(() => parseRevision("r1", "comments"), { code: "invalid_revision" });
  assert.equal(parseRevision("c42", "comments"), 42);
});

test("the fence passes the latest handle and one superseded after the horizon", async () => {
  const storage = new Storage();
  await revisionFor(storage, "page", heads("a"), at);
  assert.deepEqual(await fencedHeads(storage, "page", "r1", at + 100), heads("a"));
  await revisionFor(storage, "page", heads("b"), at + 10);
  // r2 superseded r1 at +10: after a horizon of +9, at or before one of +10.
  assert.deepEqual(await fencedHeads(storage, "page", "r1", at + 9), heads("a"));
  await assert.rejects(fencedHeads(storage, "page", "r1", at + 10), {
    status: 409,
    code: "resync_required",
  });
  assert.deepEqual(await fencedHeads(storage, "page", "r2", at + 1000), heads("b"));
});
