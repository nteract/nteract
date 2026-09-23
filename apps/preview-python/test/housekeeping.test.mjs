import test from "node:test";
import assert from "node:assert/strict";
import { ensureHousekeepingAlarm } from "../src/housekeeping.js";
import { SessionPool } from "../src/session-pool.js";
import { createProviderService } from "../src/provider-service.js";

test("continuous discovery preserves the sweep deadline and idle sessions expire", async () => {
  let now = 0;
  let alarm = null;
  let disposals = 0;
  const storage = {
    getAlarm: async () => alarm,
    setAlarm: async (deadline) => {
      alarm = deadline;
    },
  };
  const pool = new SessionPool({
    maxSessions: 1,
    warmCount: 0,
    idleMs: 50_000,
    clock: () => now,
    create: async () => ({
      info: {},
      dispose: async () => {
        disposals++;
      },
    }),
  });
  const service = createProviderService(pool);
  await pool.open("idle");
  for (now = 0; now <= 60_000; now += 5_000) {
    await ensureHousekeepingAlarm(storage, now);
    assert.equal((await service.fetch(new Request("https://provider/health"))).status, 200);
    assert.equal(alarm, 60_000);
  }
  await pool.expire();
  assert.equal(disposals, 1);
  // The alarm has fired; the next request can arm a new housekeeping cycle.
  alarm = null;
  await ensureHousekeepingAlarm(storage, now);
  assert.equal(alarm, now + 60_000);
  await pool.close();
});

test("provider retains idle compute through the room deadline and later reaps orphans", async () => {
  const { CLOUD_RUNTIME_IDLE_MS, PROVIDER_ORPHAN_IDLE_MS } =
    await import("../src/lifecycle-policy.js");
  let now = 0;
  let disposed = 0;
  const pool = new SessionPool({
    maxSessions: 1,
    warmCount: 0,
    idleMs: PROVIDER_ORPHAN_IDLE_MS,
    clock: () => now,
    create: async () => ({
      info: {},
      execute: async () => ({ success: true }),
      dispose: async () => {
        disposed++;
      },
    }),
  });
  await pool.open("session");
  now = CLOUD_RUNTIME_IDLE_MS + 1;
  await pool.expire();
  assert.equal(disposed, 0);
  assert.deepEqual(await pool.execute("session", { execution_id: "still-valid" }), {
    success: true,
  });
  now += PROVIDER_ORPHAN_IDLE_MS;
  await pool.expire();
  assert.equal(disposed, 1);
  await assert.rejects(pool.execute("session", { execution_id: "orphan" }), /expired/);
  await pool.close();
});
