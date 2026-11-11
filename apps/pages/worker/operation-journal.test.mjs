import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HORIZON,
  inspectOperation,
  journalTime,
  JOURNAL_LIMITS,
  operationEntryBytes,
  RECEIPT_LIFETIME_MS,
  receiptHorizon,
  readRevision,
  receiptKey,
  reserveOperation,
  revisionClock,
  signCapability,
} from "./operation-journal.mjs";
import { fencedHeads, revisionFor } from "./revisions.mjs";

const start = Date.parse("2026-10-25T00:00:00Z");
const alice = "user:issuer:alice";
class Storage {
  values = new Map();
  durable = new Map();
  failSync = false;
  failDelete = false;
  deletes = 0;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === "object") {
      for (const [name, entry] of Object.entries(key)) await this.put(name, entry);
      return;
    }
    this.values.set(key, structuredClone(value));
  }
  async delete(key) {
    this.deletes++;
    if (this.failDelete) throw Error("injected delete failure");
    this.values.delete(key);
  }
  async list({ prefix = "", limit = Infinity, startAfter } = {}) {
    return new Map(
      [...this.values]
        .sort(([a], [b]) => a.localeCompare(b))
        .filter(([key]) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        .slice(0, limit),
    );
  }
  async sync() {
    if (this.failSync) throw Error("injected sync failure");
    this.durable = structuredClone(this.values);
  }
  restart() {
    this.values = structuredClone(this.durable);
  }
}
async function fixture() {
  const storage = new Storage();
  return {
    storage,
    args: {
      key: await receiptKey({ principal: alice, lane: "page", nonce: "request-1" }),
      digest: "same-payload",
    },
  };
}
async function record(f, { pending = false, now = start } = {}) {
  const entry = await reserveOperation(f.storage, {
    key: f.args.key,
    entry: { fingerprint: f.args.digest, pending: true, receipt: { result: "once" } },
    now,
  });
  entry.pending = pending;
  await f.storage.put(f.args.key, entry);
  await f.storage.sync();
  return entry;
}
const reserveNext = (f, now, nonce = "collection-next") =>
  receiptKey({ principal: alice, lane: "page", nonce }).then((key) =>
    reserveOperation(f.storage, { key, entry: { fingerprint: "new", pending: true }, now }),
  );

test("a receipt key is the account digest, the lane and the nonce", async () => {
  const key = await receiptKey({ principal: alice, lane: "comments", nonce: "abc_123" });
  // The first 16 bytes of SHA-256("user:issuer:alice"), as 32 hex characters
  // (shasum -a 256).
  assert.equal(key, "host/operation/n1_91a4f8f1f0a1a4066497cfe6d9841857_comments_abc_123");
  for (const nonce of [undefined, null, 7, "", "short", "x".repeat(65), "has space", "a:b"])
    await assert.rejects(receiptKey({ principal: alice, lane: "page", nonce }), {
      status: 400,
      code: "invalid_nonce",
    });
});

test("two accounts using one nonce get separate receipts", async () => {
  const storage = new Storage();
  const keys = await Promise.all(
    [alice, "user:issuer:bob"].map((principal) =>
      receiptKey({ principal, lane: "page", nonce: "shared-nonce" }),
    ),
  );
  assert.notEqual(keys[0], keys[1]);
  for (const [index, key] of keys.entries()) {
    const entry = await reserveOperation(storage, {
      key,
      entry: { fingerprint: `account-${index}`, pending: true },
      now: start,
    });
    await storage.put(key, { ...entry, pending: false, receipt: { index } });
  }
  for (const [index, key] of keys.entries())
    assert.equal(
      (await inspectOperation(storage, { key, digest: `account-${index}` })).entry.receipt.index,
      index,
    );
});

test("an exact retry finds the receipt; another request under the nonce is nonce_conflict", async () => {
  const f = await fixture();
  const entry = await record(f);
  f.storage.restart();
  assert.deepEqual((await inspectOperation(f.storage, f.args)).entry, entry);
  assert.equal(entry.recordedAt, start);
  await assert.rejects(inspectOperation(f.storage, { ...f.args, digest: "changed-payload" }), {
    status: 409,
    code: "nonce_conflict",
    message: "This nonce was used for a different request",
  });
});

test("collection deletes receipts past their lifetime and raises the horizon first", async () => {
  const f = await fixture();
  const entry = await record(f);
  assert.equal(await receiptHorizon(f.storage, start), start - RECEIPT_LIFETIME_MS);
  // One millisecond short of the lifetime keeps it.
  await reserveNext(f, start + RECEIPT_LIFETIME_MS - 1, "early-next");
  assert.deepEqual(await f.storage.get(f.args.key), entry);
  await reserveNext(f, start + RECEIPT_LIFETIME_MS);
  assert.equal(await f.storage.get(f.args.key), undefined);
  assert.equal(await f.storage.get(HORIZON), start);
  // The forgotten key is a new request to the journal; the horizon is what
  // tells its host it may be a retry.
  assert.equal((await inspectOperation(f.storage, f.args)).entry, undefined);
});

test("the horizon is never below the clock minus the receipt lifetime", async () => {
  const storage = new Storage();
  await storage.put(HORIZON, start);
  assert.equal(await receiptHorizon(storage, start + 10), start);
  assert.equal(
    await receiptHorizon(storage, start + RECEIPT_LIFETIME_MS + 10),
    start + 10,
    "the lifetime floor overtakes a stored horizon",
  );
});

test("pending operations are never collected by age", async () => {
  const f = await fixture();
  const entry = await record(f, { pending: true });
  await reserveNext(f, start + RECEIPT_LIFETIME_MS * 2);
  assert.deepEqual(await f.storage.get(f.args.key), entry);
  await assert.rejects(inspectOperation(f.storage, { ...f.args, digest: "wrong" }), {
    status: 409,
    code: "nonce_conflict",
  });
});

test("clock rollback after collection lowers neither the horizon nor journal time", async () => {
  const f = await fixture();
  await record(f);
  await reserveNext(f, start + RECEIPT_LIFETIME_MS);
  f.storage.restart();
  const later = await reserveNext(f, start - 1000, "after-rollback");
  // Journal time never runs back behind the horizon.
  assert.equal(later.recordedAt, start);
  assert.equal(await f.storage.get(HORIZON), start);
  // The restart undid the unsynced delete. The receipt is still an exact
  // answer to its retry, and it sits at the horizon, so a write against its
  // base revision without it is refused anyway.
  const restored = await f.storage.get(f.args.key);
  assert.ok(restored.recordedAt <= (await f.storage.get(HORIZON)));
});

test("clock rollback after a durable delete cannot apply a write again", async () => {
  const f = await fixture();
  const heads = ["a".repeat(64)];
  // The write named r1, read at the start, and its receipt recorded then.
  const handle = await revisionFor(f.storage, "page", heads, start);
  await record(f);
  await reserveNext(f, start + RECEIPT_LIFETIME_MS);
  await f.storage.sync();
  f.storage.restart();
  assert.equal(await f.storage.get(f.args.key), undefined, "the delete is durable");
  // The wall clock steps back behind the receipt. The retry finds no receipt,
  // and the fence refuses its revision, so it is not applied a second time.
  const rolledBack = start - 1000;
  assert.equal((await inspectOperation(f.storage, f.args)).entry, undefined);
  const { horizon } = await revisionClock(f.storage, rolledBack);
  assert.equal(horizon, start);
  await assert.rejects(fencedHeads(f.storage, "page", handle, horizon), {
    status: 409,
    code: "resync_required",
  });
  // A fresh read of the same heads names a new handle the fence accepts.
  const fresh = await readRevision(f.storage, "page", heads, rolledBack);
  assert.notEqual(fresh, handle);
  assert.deepEqual(await fencedHeads(f.storage, "page", fresh, horizon), heads);
});

test("journal time never runs back behind the latest revision handle", async () => {
  const storage = new Storage();
  assert.equal(await journalTime(storage, start), start);
  await revisionFor(storage, "page", ["a".repeat(64)], start + 5000);
  await revisionFor(storage, "comments", ["b".repeat(64)], start + 9000);
  // The wall clock stepped back: receipts and handles still record later.
  assert.equal(await journalTime(storage, start), start + 9000);
  assert.equal(await journalTime(storage, start + 20_000), start + 20_000);
  await assert.rejects(journalTime(storage, -1), TypeError);
});

test("a failed horizon barrier deletes nothing; a retry redoes it", async () => {
  const f = await fixture();
  await record(f);
  f.storage.failSync = true;
  await assert.rejects(reserveNext(f, start + RECEIPT_LIFETIME_MS), /injected sync failure/);
  assert.equal(f.storage.deletes, 0);
  f.storage.failSync = false;
  await reserveNext(f, start + RECEIPT_LIFETIME_MS);
  assert.equal(await f.storage.get(f.args.key), undefined);
  f.storage.restart();
  assert.equal(await f.storage.get(HORIZON), start, "the horizon is durable before the delete");
});

test("a delete that fails after the horizon landed leaves the receipt collectible", async () => {
  const f = await fixture();
  await record(f);
  f.storage.failDelete = true;
  const now = start + RECEIPT_LIFETIME_MS;
  await assert.rejects(reserveNext(f, now), /injected delete failure/);
  f.storage.restart();
  f.storage.failDelete = false;
  assert.equal(await f.storage.get(HORIZON), start, "the horizon covers the receipt first");
  await reserveNext(f, now);
  assert.equal(await f.storage.get(f.args.key), undefined);
});

test("a full journal evicts its oldest completed receipts and raises the horizon to them", async () => {
  const f = await fixture();
  for (let i = 0; i < JOURNAL_LIMITS.entries; i++)
    await f.storage.put(`host/operation/done-${String(i).padStart(5, "0")}`, {
      fingerprint: `done-${i}`,
      pending: false,
      receipt: { ok: true },
      // Later keys are older by stamp: eviction follows age, not key order.
      recordedAt: start - i,
    });
  const admitted = await reserveOperation(f.storage, {
    key: "host/operation/new-request",
    entry: { fingerprint: "new", pending: true },
    now: start,
  });
  assert.deepEqual(admitted, { fingerprint: "new", pending: true, recordedAt: start });
  const oldest = `host/operation/done-${String(JOURNAL_LIMITS.entries - 1).padStart(5, "0")}`;
  assert.equal(await f.storage.get(oldest), undefined, "the oldest receipt made room");
  assert.equal(
    (await f.storage.list({ prefix: "host/operation/" })).size,
    JOURNAL_LIMITS.entries - 1,
    "exactly one receipt was evicted for one new entry",
  );
  assert.equal(await f.storage.get(HORIZON), start - (JOURNAL_LIMITS.entries - 1));
  // The newest receipt still replays and still guards its payload.
  assert.equal(
    (await inspectOperation(f.storage, { key: "host/operation/done-00000", digest: "done-0" }))
      .entry.receipt.ok,
    true,
  );
  await assert.rejects(
    inspectOperation(f.storage, { key: "host/operation/done-00000", digest: "other" }),
    { status: 409, code: "nonce_conflict" },
  );
});

test("eviction frees bytes as well as entries and never evicts pending work", async () => {
  const f = await fixture();
  const big = "x".repeat(64 * 1024);
  // 130 receipts of 64 KiB overflow the 8 MiB journal by a few entries.
  for (let i = 0; i < 130; i++)
    await f.storage.put(`host/operation/done-${String(i).padStart(3, "0")}`, {
      fingerprint: `done-${i}`,
      pending: false,
      receipt: { body: big },
      recordedAt: start + i,
    });
  await f.storage.put("host/operation/still-pending", {
    fingerprint: "pending",
    pending: true,
    receipt: { body: big },
    recordedAt: 0,
  });
  await reserveOperation(f.storage, {
    key: "host/operation/new-request",
    entry: { fingerprint: "new", pending: true, receipt: { body: big } },
    now: start,
  });
  const keys = [...(await f.storage.list({ prefix: "host/operation/" })).keys()];
  assert.ok(keys.includes("host/operation/still-pending"), "pending entries are never evicted");
  assert.ok(!keys.includes("host/operation/done-000"), "the oldest completed receipt went first");
  assert.ok(keys.includes("host/operation/done-129"), "the newest completed receipt stays");
  const retained = keys.filter((key) => /done-\d/.test(key)).length;
  assert.ok(
    retained < 130 && retained > 120,
    `evicted only what the byte budget needed (${retained})`,
  );
});

test("a journal full of completed receipts never refuses a new request", async () => {
  const f = await fixture();
  // Same-age receipts: eviction falls back to key order.
  for (let i = 0; i < JOURNAL_LIMITS.entries; i++)
    await f.storage.put(`host/operation/done-${String(i).padStart(5, "0")}`, {
      fingerprint: `done-${i}`,
      pending: false,
      receipt: { ok: true },
      recordedAt: start,
    });
  await reserveNext(f, start);
  assert.equal(
    (await f.storage.list({ prefix: "host/operation/" })).size,
    JOURNAL_LIMITS.entries - 1,
  );
});

for (const budget of ["entries", "bytes"]) {
  test(`pending ${budget} are bounded and never retired by age`, async () => {
    const f = await fixture();
    const count = budget === "entries" ? JOURNAL_LIMITS.pendingEntries : 5;
    for (let i = 0; i < count; i++)
      await f.storage.put(`host/operation/pending-${i}`, {
        fingerprint: "pending",
        pending: true,
        changes: [new Uint8Array(budget === "bytes" ? 850_000 : 1)],
        receipt: {},
        recordedAt: start,
      });
    await assert.rejects(reserveNext(f, start + RECEIPT_LIFETIME_MS * 2), {
      status: 429,
      code: "pending_operation_capacity",
    });
    assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, count);
  });
}

test("binary intent sizing charges bytes rather than a JSON expansion", () => {
  const bytes = operationEntryBytes("host/operation/key", {
    pending: true,
    changes: [new Uint8Array(1000)],
  });
  assert.ok(bytes > 1000 && bytes < 2000);
});

test("failure to persist the signing secret prevents signing a capability", async () => {
  const storage = new Storage();
  storage.failSync = true;
  await assert.rejects(
    signCapability(storage, { purpose: "asset-upload", prefix: "up", payload: {} }),
    /injected sync failure/,
  );
  storage.restart();
  assert.equal(await storage.get("host/retry-secret-v1"), undefined);
});

test("trusted admission fallback resumes the same pending intent after a failed journal put", async () => {
  const f = await fixture();
  const pending = await record(f, { pending: true });
  await f.storage.delete(f.args.key);
  const result = await inspectOperation(f.storage, { ...f.args, pendingEntry: pending });
  assert.deepEqual(result.entry, pending);
  await assert.rejects(
    inspectOperation(f.storage, { ...f.args, digest: "wrong", pendingEntry: pending }),
    { status: 409, code: "nonce_conflict" },
  );
  await assert.rejects(
    inspectOperation(f.storage, { ...f.args, pendingEntry: { ...pending, pending: false } }),
    /Only a trusted pending admission/,
  );
});
