import test from "node:test";
import assert from "node:assert/strict";
import { SessionPool } from "../src/session-pool.js";

function fixture(options = {}) {
  const runtimes = [];
  const pool = new SessionPool({
    maxSessions: 2,
    warmCount: 1,
    create: async () => {
      const runtime = {
        info: { id: runtimes.length },
        disposed: false,
        execute: async (execution) => ({ execution_id: execution.execution_id }),
        dispose: async () => {
          runtime.disposed = true;
        },
      };
      runtimes.push(runtime);
      return runtime;
    },
    ...options,
  });
  return { pool, runtimes };
}

test("concurrent allocation is idempotent and used state never reenters warm pool", async () => {
  const { pool, runtimes } = fixture();
  pool.warm();
  const [a, b] = await Promise.all([pool.open("owner/notebook/1"), pool.open("owner/notebook/1")]);
  assert.equal(a.id, b.id);
  await pool.release("owner/notebook/1");
  const fresh = await pool.open("owner/notebook/2");
  assert.notEqual(fresh.id, a.id);
  assert.equal(runtimes[a.id].disposed, true);
  await pool.close();
  assert.ok(runtimes.every((r) => r.disposed));
});

test("capacity and execution replay are rejected without rerunning code", async () => {
  const { pool } = fixture();
  await pool.open("a");
  await pool.open("b");
  await assert.rejects(pool.open("c"), /capacity/);
  await pool.execute("a", { execution_id: "one", source: "1" });
  await assert.rejects(pool.execute("a", { execution_id: "one", source: "1" }), /already accepted/);
  await pool.close();
});

test("release fences late output and preserves a replacement generation", async () => {
  const { pool, runtimes } = fixture({ warmCount: 0 });
  await pool.open("a");
  let complete;
  runtimes[0].execute = () =>
    new Promise((resolve) => {
      complete = resolve;
    });
  const executing = pool.execute("a", { execution_id: "one" });
  await Promise.resolve();
  await pool.release("a");
  const next = await pool.open("a");
  complete({ value: "stale" });
  await assert.rejects(executing, /Discarded output/);
  assert.equal(runtimes[next.id].disposed, false);
  await pool.close();
});

test("idle expiry disposes sessions and close fences pending allocation", async () => {
  let now = 0;
  const { pool, runtimes } = fixture({ clock: () => now, idleMs: 10 });
  await pool.open("a");
  now = 11;
  await pool.expire();
  assert.equal(runtimes[0].disposed, true);
  await assert.rejects(pool.execute("a", { execution_id: "x" }), /expired/);
  await pool.close();
  let finish;
  let disposed = false;
  const pending = new SessionPool({
    create: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const allocation = pending.open("a");
  await Promise.resolve();
  await pending.close();
  finish({
    info: {},
    dispose: async () => {
      disposed = true;
    },
  });
  await assert.rejects(allocation, /expired/);
  assert.equal(disposed, true);
});

test("cancelled pending allocation retains capacity until its isolate is disposed", async () => {
  let finish;
  const pool = new SessionPool({
    maxSessions: 1,
    warmCount: 0,
    create: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  const allocation = pool.open("a");
  await Promise.resolve();
  await pool.release("a");
  await assert.rejects(pool.open("b"), /capacity/);
  finish({ info: {}, dispose: async () => {} });
  await assert.rejects(allocation, /expired/);
  await pool.close();
});

test("failed termination retains admission capacity", async () => {
  const pool = new SessionPool({
    maxSessions: 1,
    warmCount: 0,
    create: async () => ({
      info: {},
      execute: async () => ({}),
      dispose: async () => {
        throw new Error("host termination failed");
      },
    }),
  });
  await pool.open("a");
  await assert.rejects(pool.release("a"), /host termination failed/);
  await assert.rejects(pool.open("b"), /capacity/);
});
