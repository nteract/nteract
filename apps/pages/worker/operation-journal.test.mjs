import assert from "node:assert/strict";
import { test } from "node:test";
import { retryKey, retryKeyPrefix } from "../model/retry-key.mjs";
import {
  inspectOperation,
  issueRetryToken,
  JOURNAL_LIMITS,
  operationEntryBytes,
  reserveOperation,
  RETRY_LIFETIME_MS,
} from "./operation-journal.mjs";

const start = Date.parse("2026-10-25T00:00:00Z");
const context = { scope: "page:shared-page", principal: "user:issuer:alice", now: start };
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
  const issued = await issueRetryToken(storage, context);
  return {
    storage,
    issued,
    args: {
      ...context,
      key: `host/operation/${await retryKey(issued.retry_token, "request-1")}`,
      digest: "same-payload",
      retryToken: issued.retry_token,
    },
  };
}
async function record(f, pending = false) {
  const { retry } = await inspectOperation(f.storage, f.args);
  const entry = await reserveOperation(f.storage, {
    key: f.args.key,
    entry: { fingerprint: f.args.digest, pending: true, receipt: { result: "once" } },
    retry,
    now: start,
  });
  entry.pending = pending;
  await f.storage.put(f.args.key, entry);
  await f.storage.sync();
  return entry;
}

async function collectExpired(f, now) {
  const issued = await issueRetryToken(f.storage, { ...context, now });
  const key = `host/operation/${await retryKey(issued.retry_token, "collection-next")}`;
  const { retry } = await inspectOperation(f.storage, {
    ...f.args,
    key,
    retryToken: issued.retry_token,
    now,
  });
  return reserveOperation(f.storage, {
    key,
    entry: { fingerprint: "new", pending: true },
    retry,
    now,
  });
}

test("a scoped token is durable before issue and returns the same receipt within its window", async () => {
  const f = await fixture();
  assert.equal(f.issued.retry_until, new Date(start + RETRY_LIFETIME_MS).toISOString());
  f.storage.restart();
  const entry = await record(f);
  const inspection = await inspectOperation(f.storage, { ...f.args, now: start + 1 });
  assert.deepEqual(inspection.entry, entry);
  assert.equal(inspection.retry.expiresAt, start + RETRY_LIFETIME_MS);
  await assert.rejects(inspectOperation(f.storage, { ...f.args, digest: "changed-payload" }), {
    status: 409,
    code: "idempotency_conflict",
  });
});

test("tampered tokens and tokens for another principal/resource cannot admit operations", async () => {
  const f = await fixture();
  const tampered = `${f.issued.retry_token.slice(0, -5)}abcde`;
  for (const args of [
    { ...f.args, retryToken: tampered },
    { ...f.args, principal: "user:issuer:bob" },
    { ...f.args, scope: "page:other-page" },
    { ...f.args, retryToken: "not-a-token" },
    { ...f.args, retryToken: null },
  ])
    await assert.rejects(inspectOperation(f.storage, args), {
      status: 400,
      code: "invalid_retry_token",
    });
  assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, 0);
});

test("expired completed or never-attempted requests never become new mutations", async () => {
  const f = await fixture();
  await record(f);
  const now = start + RETRY_LIFETIME_MS;
  await assert.rejects(inspectOperation(f.storage, { ...f.args, now }), {
    status: 410,
    code: "retry_expired",
  });
  await assert.rejects(
    inspectOperation(f.storage, {
      ...f.args,
      key: `host/operation/${await retryKey(f.issued.retry_token, "not-attempted")}`,
      now,
    }),
    { status: 410, code: "retry_expired" },
  );
  await collectExpired(f, now);
  assert.equal(await f.storage.get(f.args.key), undefined);
  await assert.rejects(inspectOperation(f.storage, { ...f.args, now }), {
    status: 410,
    code: "retry_expired",
  });
});

test("expired pending operations retain their exact intent and can still be resumed", async () => {
  const f = await fixture();
  const entry = await record(f, true);
  const now = start + RETRY_LIFETIME_MS * 2;
  await issueRetryToken(f.storage, { ...context, now });
  const inspected = await inspectOperation(f.storage, { ...f.args, now });
  assert.deepEqual(inspected.entry, entry);
  assert.equal(f.storage.deletes, 0);
  await assert.rejects(inspectOperation(f.storage, { ...f.args, digest: "wrong", now }), {
    status: 409,
  });
});

test("clock rollback after retirement cannot resurrect an evicted request", async () => {
  const f = await fixture();
  await record(f);
  await collectExpired(f, start + RETRY_LIFETIME_MS);
  await f.storage.sync();
  f.storage.restart();
  await assert.rejects(inspectOperation(f.storage, f.args), { status: 410, code: "retry_expired" });
  const fresh = await issueRetryToken(f.storage, context);
  assert.equal(fresh.retry_until, new Date(start + RETRY_LIFETIME_MS * 2).toISOString());
});

test("failed retirement barrier deletes nothing; retry redoes the barrier", async () => {
  const f = await fixture();
  await record(f);
  f.storage.failSync = true;
  await assert.rejects(collectExpired(f, start + RETRY_LIFETIME_MS), /injected sync failure/);
  assert.equal(f.storage.deletes, 0);
  f.storage.failSync = false;
  // Simulate the process surviving a failed sync: in-memory floor is already new.
  await collectExpired(f, start + RETRY_LIFETIME_MS);
  f.storage.restart();
  await assert.rejects(inspectOperation(f.storage, f.args), { status: 410 });
});

test("failure during GC leaves old requests expired and retained rows collectible", async () => {
  const f = await fixture();
  await record(f);
  f.storage.failDelete = true;
  const now = start + RETRY_LIFETIME_MS;
  await assert.rejects(collectExpired(f, now), /injected delete failure/);
  f.storage.restart();
  f.storage.failDelete = false;
  await assert.rejects(inspectOperation(f.storage, f.args), { status: 410 });
  await collectExpired(f, start);
  assert.equal(await f.storage.get(f.args.key), undefined);
});

test("a full tokenless lane evicts its oldest completed receipts and never touches the versioned lane", async () => {
  const f = await fixture();
  for (let i = 0; i < JOURNAL_LIMITS.entries; i++)
    await f.storage.put(`host/operation/legacy-${String(i).padStart(5, "0")}`, {
      fingerprint: `legacy-${i}`,
      pending: false,
      receipt: { ok: true },
      // Later keys are older by stamp: eviction follows age, not key order.
      recordedAt: start - i,
    });
  const legacy = await inspectOperation(f.storage, {
    key: "host/operation/legacy-00000",
    digest: "legacy-0",
  });
  assert.equal(legacy.entry.receipt.ok, true);
  const admitted = await reserveOperation(f.storage, {
    key: "host/operation/new-legacy",
    entry: { fingerprint: "new", pending: true },
    now: start,
  });
  assert.deepEqual(admitted, { fingerprint: "new", pending: true, recordedAt: start });
  const oldest = `host/operation/legacy-${String(JOURNAL_LIMITS.entries - 1).padStart(5, "0")}`;
  assert.equal(await f.storage.get(oldest), undefined, "the oldest receipt made room");
  assert.equal(
    (await f.storage.list({ prefix: "host/operation/" })).size,
    JOURNAL_LIMITS.entries - 1,
    "exactly one receipt was evicted for one new entry",
  );
  // The newest tokenless receipt still replays and still guards its payload.
  assert.equal(
    (await inspectOperation(f.storage, { key: "host/operation/legacy-00000", digest: "legacy-0" }))
      .entry.receipt.ok,
    true,
  );
  await assert.rejects(
    inspectOperation(f.storage, { key: "host/operation/legacy-00000", digest: "other" }),
    { status: 409, code: "idempotency_conflict" },
  );
  // An evicted key is a new request again.
  assert.equal(
    (await inspectOperation(f.storage, { key: oldest, digest: "anything" })).entry,
    undefined,
  );
  // The versioned lane's budget was never involved.
  const { retry } = await inspectOperation(f.storage, f.args);
  const versioned = await reserveOperation(f.storage, {
    key: f.args.key,
    entry: { fingerprint: "new", pending: true },
    retry,
    now: start,
  });
  assert.equal(versioned.retry.version, 1);
  assert.equal(versioned.recordedAt, undefined, "a token's window orders its receipt");
});

test("tokenless eviction frees bytes as well as entries and never evicts pending work", async () => {
  const f = await fixture();
  const big = "x".repeat(64 * 1024);
  // 130 receipts of 64 KiB overflow the 8 MiB lane by a few entries.
  for (let i = 0; i < 130; i++)
    await f.storage.put(`host/operation/legacy-${String(i).padStart(3, "0")}`, {
      fingerprint: `legacy-${i}`,
      pending: false,
      receipt: { body: big },
      recordedAt: start + i,
    });
  await f.storage.put("host/operation/legacy-pending", {
    fingerprint: "pending",
    pending: true,
    receipt: { body: big },
    recordedAt: 0,
  });
  await reserveOperation(f.storage, {
    key: "host/operation/new-legacy",
    entry: { fingerprint: "new", pending: true, receipt: { body: big } },
    now: start,
  });
  const keys = [...(await f.storage.list({ prefix: "host/operation/" })).keys()];
  assert.ok(keys.includes("host/operation/legacy-pending"), "pending entries are never evicted");
  assert.ok(!keys.includes("host/operation/legacy-000"), "the oldest completed receipt went first");
  assert.ok(keys.includes("host/operation/legacy-129"), "the newest completed receipt stays");
  const retained = keys.filter((key) => /legacy-\d/.test(key)).length;
  assert.ok(
    retained < 130 && retained > 120,
    `evicted only what the byte budget needed (${retained})`,
  );
});

test("active versioned receipt count is bounded, then reclaimed after the promised deadline", async () => {
  const f = await fixture();
  const { retry } = await inspectOperation(f.storage, f.args);
  for (let i = 0; i < JOURNAL_LIMITS.entries; i++)
    await f.storage.put(`host/operation/done-${String(i).padStart(5, "0")}`, {
      fingerprint: `done-${i}`,
      pending: false,
      retry,
      receipt: { ok: true },
    });
  const request = {
    key: f.args.key,
    entry: { fingerprint: "new", pending: true },
    retry,
    now: start,
  };
  await assert.rejects(reserveOperation(f.storage, request), {
    status: 429,
    code: "operation_receipt_capacity",
  });
  const now = start + RETRY_LIFETIME_MS;
  const next = await issueRetryToken(f.storage, { ...context, now });
  const inspected = await inspectOperation(f.storage, {
    ...f.args,
    retryToken: next.retry_token,
    key: `host/operation/${await retryKey(next.retry_token, "next-request")}`,
    now,
  });
  await reserveOperation(f.storage, {
    ...request,
    key: `host/operation/${await retryKey(next.retry_token, "next-request")}`,
    retry: inspected.retry,
    now,
  });
  assert.equal((await f.storage.list({ prefix: "host/operation/" })).size, 0);
});

test("terminal receipt byte budget is enforced before the count budget", async () => {
  const f = await fixture();
  const { retry } = await inspectOperation(f.storage, f.args);
  for (let i = 0; i < 10; i++)
    await f.storage.put(`host/operation/large-${i}`, {
      fingerprint: "large",
      pending: false,
      retry,
      receipt: { result: "x".repeat(850_000) },
    });
  await assert.rejects(
    reserveOperation(f.storage, {
      key: f.args.key,
      entry: { fingerprint: "new", pending: true },
      retry,
      now: start,
    }),
    { status: 429, code: "operation_receipt_capacity" },
  );
});

for (const budget of ["entries", "bytes"]) {
  test(`pending ${budget} are bounded independently and never retired by age`, async () => {
    const f = await fixture();
    const { retry } = await inspectOperation(f.storage, f.args);
    const count = budget === "entries" ? JOURNAL_LIMITS.pendingEntries : 5;
    for (let i = 0; i < count; i++)
      await f.storage.put(`host/operation/pending-${i}`, {
        fingerprint: "pending",
        pending: true,
        retry,
        changes: [new Uint8Array(budget === "bytes" ? 850_000 : 1)],
        receipt: {},
      });
    const now = start + RETRY_LIFETIME_MS * 2;
    const next = await issueRetryToken(f.storage, { ...context, now });
    const inspected = await inspectOperation(f.storage, {
      ...f.args,
      retryToken: next.retry_token,
      key: `host/operation/${await retryKey(next.retry_token, "next-request")}`,
      now,
    });
    await assert.rejects(
      reserveOperation(f.storage, {
        key: `host/operation/${await retryKey(next.retry_token, "next-request")}`,
        entry: { fingerprint: "new", pending: true },
        retry: inspected.retry,
        now,
      }),
      { status: 429, code: "pending_operation_capacity" },
    );
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

test("an expired token cannot acquire capacity after a long candidate preparation", async () => {
  const f = await fixture();
  const { retry } = await inspectOperation(f.storage, f.args);
  await assert.rejects(
    reserveOperation(f.storage, {
      key: f.args.key,
      entry: { fingerprint: f.args.digest, pending: true },
      retry,
      now: start + RETRY_LIFETIME_MS,
    }),
    { status: 410, code: "retry_expired" },
  );
});

test("stripping a token after receipt GC never admits the request as legacy", async () => {
  const f = await fixture();
  await record(f);
  await collectExpired(f, start + RETRY_LIFETIME_MS);
  await assert.rejects(inspectOperation(f.storage, { ...f.args, retryToken: undefined }), {
    status: 400,
    code: "invalid_retry_token",
  });
  await assert.rejects(inspectOperation(f.storage, { ...f.args, key: "host/operation/raw-key" }), {
    status: 400,
    code: "invalid_retry_token",
  });
  await assert.rejects(
    reserveOperation(f.storage, {
      key: f.args.key,
      entry: { fingerprint: "new", pending: true },
      now: start + RETRY_LIFETIME_MS,
    }),
    { status: 400, code: "invalid_retry_token" },
  );
});

test("known legacy receipts using the newly reserved prefix can still replay", async () => {
  const storage = new Storage();
  const key = "host/operation/v1_old-legacy-key";
  const entry = { fingerprint: "old", pending: false, receipt: { ok: true } };
  await storage.put(key, entry);
  assert.deepEqual((await inspectOperation(storage, { key, digest: "old" })).entry, entry);
});

test("signing-secret storage errors are service failures instead of invalid-token responses", async () => {
  const f = await fixture();
  const get = f.storage.get.bind(f.storage);
  f.storage.get = async (key) => {
    if (key === "host/retry-secret-v1") throw Error("storage unavailable");
    return get(key);
  };
  await assert.rejects(inspectOperation(f.storage, f.args), /storage unavailable/);
});

test("a legitimately signed token survives wall-clock rollback before retirement", async () => {
  const f = await fixture();
  const future = await issueRetryToken(f.storage, { ...context, now: start + 1000 });
  const copy = new Storage();
  await copy.put("host/retry-secret-v1", await f.storage.get("host/retry-secret-v1"));
  const inspected = await inspectOperation(copy, {
    ...f.args,
    retryToken: future.retry_token,
    key: `host/operation/${await retryKey(future.retry_token, "future-request")}`,
  });
  assert.equal(inspected.retry.issuedAt, start + 1000);
  assert.equal(inspected.entry, undefined);
});

test("failure to persist the token secret prevents token issuance", async () => {
  const storage = new Storage();
  storage.failSync = true;
  await assert.rejects(issueRetryToken(storage, context), /injected sync failure/);
  storage.restart();
  assert.equal(await storage.get("host/retry-secret-v1"), undefined);
});

test("trusted admission fallback resumes the same expired pending intent after a failed journal put", async () => {
  const f = await fixture();
  const pending = await record(f, true);
  await f.storage.delete(f.args.key);
  const now = start + RETRY_LIFETIME_MS;
  const result = await inspectOperation(f.storage, { ...f.args, now, pendingEntry: pending });
  assert.deepEqual(result.entry, pending);
  await assert.rejects(
    inspectOperation(f.storage, { ...f.args, digest: "wrong", now, pendingEntry: pending }),
    { status: 409, code: "idempotency_conflict" },
  );
  await assert.rejects(
    inspectOperation(f.storage, { ...f.args, now, pendingEntry: { ...pending, pending: false } }),
    /Only a trusted pending admission/,
  );
  await assert.rejects(inspectOperation(f.storage, { ...f.args, now }), {
    status: 410,
    code: "retry_expired",
  });
});

test("legacy-only admission adds no retry metadata writes or durability barrier", async () => {
  const storage = new Storage();
  storage.failSync = true;
  const entry = { fingerprint: "legacy", pending: true, receipt: { ok: true } };
  const result = await reserveOperation(storage, {
    key: "host/operation/legacy-request",
    entry,
    now: start,
  });
  assert.deepEqual(result, { ...entry, recordedAt: start });
  assert.equal(storage.values.size, 0);
});

test("legacy admission still retires versioned receipts behind the existing clock barrier", async () => {
  const f = await fixture();
  await record(f);
  const request = {
    key: "host/operation/legacy-request",
    entry: { fingerprint: "legacy", pending: true },
    now: start + RETRY_LIFETIME_MS,
  };
  f.storage.failSync = true;
  await assert.rejects(reserveOperation(f.storage, request), /injected sync failure/);
  assert.equal(f.storage.deletes, 0);
  f.storage.failSync = false;
  await reserveOperation(f.storage, request);
  assert.equal(await f.storage.get(f.args.key), undefined);
  f.storage.restart();
  await assert.rejects(inspectOperation(f.storage, f.args), { status: 410, code: "retry_expired" });
});

test("a missing clock never lets legacy admission GC anomalous versioned rows", async () => {
  const f = await fixture();
  const entry = await record(f);
  await f.storage.delete("host/retry-clock-v1");
  f.storage.failSync = true;
  await reserveOperation(f.storage, {
    key: "host/operation/legacy-request",
    entry: { fingerprint: "legacy", pending: true },
    now: start + RETRY_LIFETIME_MS,
  });
  assert.deepEqual(await f.storage.get(f.args.key), entry);
  assert.equal(await f.storage.get("host/retry-clock-v1"), undefined);
});

test("a replacement token cannot reuse a retired operation key after GC", async () => {
  const f = await fixture();
  await record(f);
  const now = start + RETRY_LIFETIME_MS;
  await collectExpired(f, now);
  assert.equal(await f.storage.get(f.args.key), undefined);
  const next = await issueRetryToken(f.storage, { ...context, now });
  await assert.rejects(
    inspectOperation(f.storage, { ...f.args, retryToken: next.retry_token, now }),
    { status: 400, code: "invalid_retry_token" },
  );
  const freshKey = `host/operation/${await retryKey(next.retry_token, "fresh-request")}`;
  const inspected = await inspectOperation(f.storage, {
    ...f.args,
    key: freshKey,
    retryToken: next.retry_token,
    now,
  });
  assert.equal(inspected.entry, undefined);
  await reserveOperation(f.storage, {
    key: freshKey,
    entry: { fingerprint: "new", pending: true },
    retry: inspected.retry,
    now,
  });
});

test("warm token issuance has no journal scan, GC, metadata write, or sync dependency", async () => {
  const f = await fixture();
  await f.storage.put("host/operation/corrupt", { retry: { malformed: true }, pending: false });
  const before = structuredClone(f.storage.values);
  f.storage.failSync = true;
  f.storage.failDelete = true;
  f.storage.list = async () => {
    throw Error("journal must not be read");
  };
  f.storage.put = async () => {
    throw Error("read must not write");
  };
  const next = await issueRetryToken(f.storage, { ...context, now: start + RETRY_LIFETIME_MS * 2 });
  assert.equal(typeof next.retry_token, "string");
  assert.deepEqual(f.storage.values, before);
  assert.equal(f.storage.deletes, 0);
});

test("retry key helper publishes a full token hash prefix and stays within128 characters", async () => {
  const f = await fixture();
  const prefix = await retryKeyPrefix(f.issued.retry_token);
  assert.equal(f.issued.retry_key_prefix, prefix);
  assert.match(prefix, /^v1_[a-f0-9]{64}_$/);
  assert.equal((await retryKey(f.issued.retry_token, "n".repeat(60))).length, 128);
  assert.ok((await retryKey(f.issued.retry_token)).startsWith(prefix));
  assert.notEqual(await retryKeyPrefix(f.issued.retry_token + "x"), prefix);
  await assert.rejects(retryKey(f.issued.retry_token, "short"), TypeError);
  await assert.rejects(retryKey(f.issued.retry_token, "n".repeat(61)), TypeError);
});

test("changing a signed token to a future window without the secret is rejected", async () => {
  const f = await fixture();
  const [body, signature] = f.issued.retry_token.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  payload.issuedAt += RETRY_LIFETIME_MS;
  payload.expiresAt += RETRY_LIFETIME_MS;
  const forged = `${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${signature}`;
  await assert.rejects(
    inspectOperation(f.storage, {
      ...f.args,
      retryToken: forged,
      key: `host/operation/${await retryKey(forged, "forged-request")}`,
    }),
    { status: 400, code: "invalid_retry_token" },
  );
});
