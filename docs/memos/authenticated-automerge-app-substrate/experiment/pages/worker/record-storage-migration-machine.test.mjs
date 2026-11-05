import assert from "node:assert/strict";
import { test } from "node:test";
import { runTable } from "../shared/machine-test.mjs";
import {
  MAX_BACKOFF_MS,
  MAX_ATTEMPTS,
  SLOT_MAX_AGE_MS,
  backoffMs,
  migrationSlot,
  migrationStart,
  recordStorageMigration,
} from "./record-storage-migration.mjs";

const q = 1000;
const s = (name, extra = {}) => ({ name, attempts: 0, quietMs: q, ...extra });
const activity = (sockets, requests = 0) => ({
  type: "activity",
  sockets,
  requests,
});
const ok = (state, effects = []) => ({ state, effects });
const no = (state, rejected) => ({ state, effects: [], rejected });

test("record-storage-migration covers every state and event", () => {
  return runTable(recordStorageMigration, [
    {
      case: "disabled",
      state: { name: "off" },
      event: activity(1),
      expect: no({ name: "off" }, "this object never converts"),
    },
    {
      case: "no-socket",
      state: s("off", { attempts: MAX_ATTEMPTS, retryOnSocket: true }),
      event: activity(0, 1),
      expect: no(
        s("off", { attempts: MAX_ATTEMPTS, retryOnSocket: true }),
        "only a new browser session retries exhausted attempts",
      ),
    },
    {
      case: "socket",
      state: s("off", { attempts: MAX_ATTEMPTS, retryOnSocket: true }),
      event: activity(1),
      expect: ok(s("connected")),
    },
    {
      state: { name: "retired" },
      event: activity(0),
      expect: no({ name: "retired" }, "the record already says plain"),
    },
    {
      case: "socket",
      state: s("dormant"),
      event: activity(1),
      expect: ok(s("connected")),
    },
    {
      label: "a request alone, as a listing check, makes nothing eligible",
      case: "no-socket",
      state: s("dormant"),
      event: activity(0, 2),
      expect: no(s("dormant"), "only a browser session makes a Page eligible"),
    },
    {
      case: "idle",
      state: s("connected"),
      event: activity(0, 0),
      expect: ok(s("quiet"), [{ type: "arm", ms: q }]),
    },
    {
      case: "busy",
      state: s("connected"),
      event: activity(0, 1),
      expect: ok(s("connected")),
    },
    {
      state: s("connected"),
      event: { type: "elapsed" },
      expect: no(s("connected"), "a stale timer"),
    },
    {
      case: "idle",
      state: s("quiet"),
      event: activity(0, 0),
      expect: ok(s("quiet")),
    },
    {
      case: "busy",
      state: s("quiet"),
      event: activity(1, 0),
      expect: ok(s("connected"), [{ type: "disarm" }]),
    },
    {
      state: s("quiet"),
      event: { type: "elapsed" },
      expect: ok(s("converting"), [{ type: "convert" }]),
    },
    {
      state: s("converting"),
      event: activity(0, 1),
      expect: ok(s("converting", { busy: true })),
    },
    {
      state: s("converting"),
      event: { type: "elapsed" },
      expect: no(s("converting"), "a stale timer"),
    },
    {
      state: s("converting"),
      event: { type: "converted" },
      expect: ok({ name: "retired" }, [{ type: "retire" }]),
    },
    {
      case: "retry",
      state: s("converting", { attempts: 1 }),
      event: { type: "skipped", reason: "journal_pending" },
      expect: ok({ name: "backoff", attempts: 2, quietMs: q, busy: false }, [
        { type: "arm", ms: 2 * q },
      ]),
    },
    ...["skipped", "failed"].map((type) => ({
      case: "exhausted",
      state: s("converting", { attempts: MAX_ATTEMPTS - 1 }),
      event: { type, ...(type === "skipped" && { reason: "journal_pending" }) },
      expect: ok(s("off", { attempts: MAX_ATTEMPTS, retryOnSocket: true }), [{ type: "disarm" }]),
    })),
    {
      case: "retry",
      state: s("converting", { busy: true }),
      event: { type: "failed" },
      expect: ok({ name: "backoff", attempts: 1, quietMs: q, busy: true }, [
        { type: "arm", ms: q },
      ]),
    },
    {
      case: "socket",
      state: s("backoff", { busy: false, attempts: 1 }),
      event: activity(1),
      expect: ok(s("connected", { attempts: 1 }), [{ type: "disarm" }]),
    },
    {
      case: "no-socket",
      state: s("backoff", { busy: false }),
      event: activity(0, 1),
      expect: ok(s("backoff", { busy: true })),
    },
    {
      case: "idle",
      state: s("backoff", { busy: false }),
      event: { type: "elapsed" },
      expect: ok(s("quiet"), [{ type: "arm", ms: q }]),
    },
    {
      case: "busy",
      state: s("backoff", { busy: true }),
      event: { type: "elapsed" },
      expect: ok(s("connected")),
    },
  ]);
});

test("slot waiters time out without running later or blocking subsequent waiters", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release;
  const occupant = migrationSlot(() => new Promise((resolve) => (release = resolve)));
  let calls = 0;
  const waiting = migrationSlot(() => calls++, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  assert.deepEqual(await waiting, { type: "skipped", reason: "slot_timeout" });
  const later = migrationSlot(() => calls++, { timeoutMs: 10 });
  t.mock.timers.tick(10);
  assert.equal((await later).reason, "slot_timeout");
  release();
  await occupant;
  await migrationSlot(() => calls++);
  assert.equal(calls, 1, "expired work never runs after the occupant settles");
});

test("the isolate slot serializes work and recovers after rejection", async () => {
  let release;
  const order = [];
  const first = migrationSlot(() => new Promise((resolve) => (release = resolve)));
  const second = migrationSlot(async () => {
    order.push(2);
    throw Error("failed");
  });
  const rejected = assert.rejects(second, /failed/);
  const third = migrationSlot(() => order.push(3));
  assert.deepEqual(order, []);
  release();
  await Promise.all([first, rejected, third]);
  assert.deepEqual(order, [2, 3]);
});

test("an expired occupant is replaced without its late settlement clearing the replacement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let time = 0;
  const now = () => time;
  // A genuinely dropped occupant never releases; replacement must still run.
  void migrationSlot(() => new Promise(() => {}), { now });
  time += SLOT_MAX_AGE_MS + 1;
  let finishOld;
  const old = migrationSlot(() => new Promise((resolve) => (finishOld = resolve)), { now });
  assert.equal(typeof finishOld, "function");
  time += SLOT_MAX_AGE_MS + 1;
  let finishReplacement;
  const replacement = migrationSlot(() => new Promise((resolve) => (finishReplacement = resolve)), {
    now,
  });
  assert.equal(typeof finishReplacement, "function");
  finishOld();
  await old;
  const waiter = migrationSlot(() => assert.fail("replacement still owns the slot"), {
    now,
    timeoutMs: 10,
  });
  t.mock.timers.tick(10);
  assert.equal((await waiter).reason, "slot_timeout");
  finishReplacement();
  await replacement;
  assert.equal(await migrationSlot(() => "free", { now }), "free");
});

test("the backoff doubles from the quiet window and stops at six hours", () => {
  assert.equal(backoffMs(0, q), q);
  assert.equal(backoffMs(3, q), 8 * q);
  assert.equal(backoffMs(40, q), MAX_BACKOFF_MS);
});

test("only an allowlisted live Subduction Page with both switches on starts eligible", () => {
  const pageId = "55555555-5555-4555-8555-555555555555";
  const env = {
    PAGES_RECORD_STORAGE: "automerge",
    PAGES_MIGRATE_RECORD_STORAGE: "true",
    PAGES_MIGRATE_PAGE_IDS: JSON.stringify([pageId]),
  };
  const live = { pageId, documentId: "d", recordStorage: "buffered" };
  assert.equal(migrationStart(env, live).name, "dormant");
  assert.equal(migrationStart({ ...env, PAGES_MIGRATE_QUIET_MS: "250" }, live).quietMs, 250);
  assert.equal(migrationStart(env, { ...live, recordStorage: "automerge" }).name, "off");
  assert.equal(migrationStart(env, { ...live, deleted: true }).name, "off");
  assert.equal(
    migrationStart({ ...env, PAGES_MIGRATE_RECORD_STORAGE: undefined }, live).name,
    "off",
  );
  assert.equal(migrationStart({ ...env, PAGES_RECORD_STORAGE: undefined }, live).name, "off");
  assert.equal(migrationStart(env, { ...live, deleted: true, trash: {} }).name, "dormant");
  assert.equal(migrationStart(env, { ...live, pageId: crypto.randomUUID() }).name, "off");
  assert.equal(migrationStart(env, { ...live, pageId: undefined }).name, "off");
  for (const flag of [undefined, false, true, "false", "TRUE", "1"])
    assert.equal(migrationStart({ ...env, PAGES_MIGRATE_RECORD_STORAGE: flag }, live).name, "off");
  for (const ids of [
    undefined,
    null,
    "",
    "[",
    "null",
    "{}",
    "true",
    '"*"',
    "[]",
    JSON.stringify([pageId, "*"]),
    JSON.stringify([pageId, 1]),
    JSON.stringify([pageId, pageId]),
    JSON.stringify(["not-a-page"]),
    JSON.stringify(["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa".toUpperCase()]),
    JSON.stringify([` ${pageId}`]),
    [pageId],
  ]) {
    assert.equal(
      migrationStart({ ...env, PAGES_MIGRATE_PAGE_IDS: ids }, live).name,
      "off",
      `invalid allowlist: ${JSON.stringify(ids)}`,
    );
  }
});
