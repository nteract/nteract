import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordMaintenance, RECORD_MAINTENANCE_POLICY } from "./record-maintenance.mjs";
import { BufferedRecordStore } from "./record-persistence.mjs";
import { Page } from "./index.mjs";

const key = (n, kind = "commits") =>
  `subduction-v1/${"ab".repeat(32)}/${kind}/${n.toString(16).padStart(64, "0")}`;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
function fixture({ enabled = true, compact = async () => ({ removedRecords: 0 }), policy } = {}) {
  const work = [],
    errors = [];
  let time = 1000,
    calls = 0;
  const maintenance = new RecordMaintenance({
    enabled,
    compact: () => {
      calls++;
      return compact();
    },
    waitUntil: (promise) => work.push(promise),
    onError: (error) => errors.push(error),
    now: () => time,
    ...(policy && { policy }),
  });
  return {
    maintenance,
    work,
    errors,
    calls: () => calls,
    advance: (ms) => {
      time += ms;
    },
    write: (n = 1, byteLength = 4096) => maintenance.recordWrite({ key: key(n), byteLength }),
    settle: async () => {
      await Promise.all(work);
    },
  };
}
const smallPolicy = { minWrites: 2, minBytes: 8, minIntervalMs: 100 };

test("maintenance requires opt-in, accepted records, both thresholds, and a successful background flush", async () => {
  assert.deepEqual(RECORD_MAINTENANCE_POLICY, {
    minWrites: 64,
    minBytes: 262144,
    minIntervalMs: 60000,
  });
  for (const enabled of [false, undefined, "true"]) {
    const f = fixture({ enabled: enabled ?? false, policy: smallPolicy });
    f.write(1, 8);
    f.write(2, 8);
    f.maintenance.flushed();
    await f.settle();
    assert.equal(f.calls(), 0);
  }
  const f = fixture({ policy: smallPolicy });
  f.maintenance.recordWrite({ key: `subduction-v1/${"ab".repeat(32)}/id`, byteLength: 1 });
  f.maintenance.recordWrite({ key: key(1), byteLength: undefined }); // deletion
  assert.equal(f.maintenance.writes, 0);
  f.write(1, 7);
  f.maintenance.flushed();
  f.write(2, 0);
  f.maintenance.flushed();
  assert.equal(f.calls(), 0);
  f.write(2, 1);
  await Promise.resolve();
  assert.equal(f.calls(), 0, "record acceptance alone does not schedule maintenance");
  f.maintenance.flushed();
  await f.settle();
  assert.equal(f.calls(), 1);
  assert.equal(f.maintenance.writes, 0);
});

test("successful no-op consumes only its starting counters and obeys cooldown", async () => {
  const barrier = deferred();
  const f = fixture({
    policy: smallPolicy,
    compact: async () => {
      await barrier.promise;
      return { removedRecords: 0 };
    },
  });
  f.write(1, 4);
  f.write(2, 4);
  f.maintenance.flushed();
  await Promise.resolve();
  f.write(3, 5);
  f.write(4, 6);
  f.maintenance.flushed();
  assert.equal(f.calls(), 1, "single-flight even after another background flush");
  barrier.resolve();
  await f.settle();
  assert.equal(f.maintenance.writes, 2);
  assert.equal(f.maintenance.bytes, 11);
  f.maintenance.flushed();
  await f.settle();
  assert.equal(f.calls(), 1, "cooldown prevents a scan per flush");
  f.advance(100);
  assert.equal(f.calls(), 1, "no timer or idle retry");
  f.maintenance.flushed();
  await f.settle();
  assert.equal(f.calls(), 2);
  f.advance(100);
  f.maintenance.flushed();
  await f.settle();
  assert.equal(f.calls(), 2, "unchanged history is not repeatedly scanned after a no-op");
});

for (const skipped of [true, false])
  test(`${skipped ? "reservations" : "errors"} retain counters and retry only after cooldown plus activity`, async () => {
    let fail = true;
    const error = Error("temporary storage failure");
    const f = fixture({
      policy: smallPolicy,
      compact: async () => {
        if (fail) {
          if (skipped) return { skipped: "reservations" };
          throw error;
        }
        return { removedRecords: 1 };
      },
    });
    f.write(1, 4);
    f.write(2, 4);
    f.maintenance.flushed();
    await f.settle();
    assert.equal(f.maintenance.writes, 2);
    assert.equal(f.maintenance.bytes, 8);
    assert.deepEqual(f.errors, skipped ? [] : [error]);
    f.maintenance.flushed();
    await f.settle();
    assert.equal(f.calls(), 1);
    f.advance(100);
    await Promise.resolve();
    assert.equal(f.calls(), 1);
    fail = false;
    f.maintenance.flushed();
    await f.settle();
    assert.equal(f.calls(), 2);
    assert.equal(f.maintenance.writes, 0);
  });

test("native record acceptance stays live across both maintenance durability barriers", async () => {
  const barriers = [deferred(), deferred()];
  const entered = [deferred(), deferred()];
  const persisted = new Map();
  let commits = 0;
  const sink = {
    async *snapshot() {},
    async commit(batch) {
      const index = commits++;
      if (index > 0 && index < 3) {
        entered[index - 1].resolve();
        await barriers[index - 1].promise;
      }
      for (const [name, value] of batch) {
        if (value === undefined) persisted.delete(name);
        else persisted.set(name, value.slice());
      }
    },
  };
  const f = fixture({
    policy: { ...smallPolicy, minWrites: 1, minBytes: 1 },
    compact: async () => {
      await store.save(key(10, "fragments"), new Uint8Array([10]));
      await store.flush();
      await store.remove(key(1));
      await store.flush();
      return { removedRecords: 1 };
    },
  });
  const store = new BufferedRecordStore(sink, {
    onDirty: (value) => f.maintenance.recordWrite(value),
  });
  await store.save(key(1), new Uint8Array([1]));
  await store.flush();
  f.maintenance.flushed();
  await entered[0].promise;
  await store.save(key(2), new Uint8Array([2]));
  assert.deepEqual(await store.load(key(2)), new Uint8Array([2]));
  assert.equal(persisted.has(key(2)), false);
  barriers[0].resolve();
  await entered[1].promise;
  await store.save(key(3), new Uint8Array([3]));
  assert.deepEqual(await store.load(key(3)), new Uint8Array([3]));
  barriers[1].resolve();
  await f.settle();
  assert.equal(f.calls(), 1);
  assert.equal(f.maintenance.writes, 3, "fragment and both concurrent writes remain accounted");
  assert.equal(persisted.has(key(1)), false);
  assert.deepEqual(persisted.get(key(2)), new Uint8Array([2]));
  assert.equal(
    persisted.has(key(3)),
    false,
    "later native write remains pending, not falsely durable",
  );
  await store.flush();
  assert.deepEqual(persisted.get(key(3)), new Uint8Array([3]));
});

test("Page background hook does not await maintenance and foreground flush never schedules it", async () => {
  const held = deferred(),
    entered = deferred();
  const f = fixture({
    policy: { ...smallPolicy, minWrites: 1, minBytes: 1 },
    compact: async () => {
      entered.resolve();
      await held.promise;
    },
  });
  f.write(1, 1);
  const background = [];
  let recordFlushes = 0,
    storageSyncs = 0;
  const page = Object.assign(Object.create(Page.prototype), {
    persistenceDelay: 0,
    metadata: { documentId: "test" },
    ctx: {
      waitUntil: (promise) => background.push(promise),
      storage: {
        sync: async () => {
          storageSyncs++;
        },
      },
    },
    recordStore: {
      dirty: false,
      flush: async () => {
        recordFlushes++;
      },
    },
    recordMaintenance: f.maintenance,
    repo: { flush: async () => {} },
    backend: { flush: async () => {} },
  });
  page.schedulePersistence();
  await entered.promise;
  await Promise.all(background);
  assert.equal(
    page.persistenceScheduled,
    false,
    "background persistence does not await maintenance",
  );
  assert.equal(recordFlushes, 1);
  held.resolve();
  await f.settle();
  f.advance(100);
  f.write(2, 1);
  await page.flush();
  assert.equal(f.calls(), 1, "Saved/foreground flush does not schedule compaction");
  assert.equal(storageSyncs, 1);
  page.recordStore.flush = async () => {
    throw Error("record flush failed");
  };
  page.schedulePersistence();
  await Promise.all(background);
  assert.equal(f.calls(), 1, "failed background flush does not schedule compaction");
});

test("stopping prevents a queued or future maintenance run", async () => {
  const f = fixture({ policy: { ...smallPolicy, minWrites: 1, minBytes: 1 } });
  f.write(1, 1);
  f.maintenance.flushed();
  f.maintenance.stop();
  await f.settle();
  f.advance(100);
  f.write(2, 1);
  f.maintenance.flushed();
  await f.settle();
  assert.equal(f.calls(), 0);
});
