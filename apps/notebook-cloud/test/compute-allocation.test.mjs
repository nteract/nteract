import test from "node:test";
import assert from "node:assert/strict";
import { ComputeAllocation } from "../src/compute-allocation.ts";
import { SessionPool } from "../../preview-python/src/session-pool.js";
import { createProviderService } from "../../preview-python/src/provider-service.js";
import { PROVIDER_ORPHAN_IDLE_MS } from "../../preview-python/src/lifecycle-policy.js";

const identity = { ownerPrincipal: "alice", notebookId: "notebook", sessionId: "generation-1" };
function storage() {
  const values = new Map();
  let alarm = null;
  return {
    get: async (key) => structuredClone(values.get(key)),
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    setAlarm: async (time) => {
      alarm = time;
    },
    getAlarm: async () => alarm,
  };
}
function fixture(options = {}) {
  const records = storage();
  const fences = storage();
  let created = 0,
    disposed = 0;
  const pool = new SessionPool({
    warmCount: 0,
    create: async () => ({
      info: { id: ++created },
      dispose: async () => {
        disposed++;
      },
      execute: async () => ({ success: true }),
    }),
    ...options,
  });
  let service = createProviderService(pool, fences);
  let fault;
  const paths = [];
  const env = {
    NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
    PREVIEW_PYTHON_SESSIONS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: (request) => {
          paths.push(new URL(request.url).pathname);
          if (fault) {
            const fail = fault;
            fault = undefined;
            return fail(request);
          }
          return service.fetch(request);
        },
      }),
    },
  };
  let object;
  const reload = () => {
    object = new ComputeAllocation({ storage: records, waitUntil: (p) => p.catch(() => {}) }, env);
  };
  reload();
  return {
    pool,
    records,
    paths,
    reload,
    counts: () => ({ created, disposed }),
    failNext: (fail) => {
      fault = fail;
    },
    loseProvider: () => {
      service = createProviderService(
        new SessionPool({
          warmCount: 0,
          create: () => {
            throw Error("must not reallocate");
          },
        }),
        fences,
      );
    },
    alarm: () => object.alarm(),
    call: (path, who = identity) =>
      object.fetch(
        new Request(`https://allocation.internal${path}`, {
          method: "POST",
          body: JSON.stringify(who),
        }),
      ),
  };
}
async function phase(f) {
  return (await (await f.call("/status")).json()).allocation?.phase;
}

test("concurrent ensure and object reactivation retain one allocation; execution is not a route", async () => {
  const f = fixture();
  const results = await Promise.all([f.call("/ensure"), f.call("/ensure")]);
  assert.ok(results.every((r) => r.ok));
  assert.equal(f.counts().created, 1);
  assert.equal(await phase(f), "ready");
  f.reload();
  assert.equal((await f.call("/ensure")).status, 200);
  assert.equal(f.counts().created, 1);
  assert.equal(f.paths.at(-1), "/inspect");
  assert.equal((await f.call("/execute")).status, 404);
  assert.equal((await f.call("/status", { ...identity, ownerPrincipal: "bob" })).status, 409);
  assert.equal((await f.call("/release")).status, 200);
  assert.equal(await phase(f), "released");
  f.reload();
  assert.equal((await f.call("/ensure")).status, 409);
  assert.deepEqual(f.counts(), { created: 1, disposed: 1 });
});

test("release during initialization waits for destruction and fences delayed open", async () => {
  let finish, entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  let disposed = false;
  const f = fixture({
    create: () => {
      entered();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const opening = f.call("/ensure");
  await started;
  const closing = f.call("/release");
  while ((await phase(f)) !== "releasing") await new Promise((resolve) => setImmediate(resolve));
  finish({
    info: {},
    dispose: async () => {
      disposed = true;
    },
  });
  assert.equal((await closing).status, 200);
  assert.equal((await opening).status, 409);
  assert.equal(disposed, true);
  assert.equal(await phase(f), "released");
});

test("a failed close remains durable and an alarm retries cleanup", async () => {
  let attempts = 0;
  const f = fixture({
    create: async () => ({
      info: {},
      dispose: async () => {
        if (++attempts === 1) throw Error("termination uncertain");
      },
    }),
  });
  assert.equal((await f.call("/ensure")).status, 200);
  assert.equal((await f.call("/release")).status, 409);
  assert.equal(await phase(f), "releasing");
  assert.ok(await f.records.getAlarm());
  f.reload();
  await f.alarm();
  assert.equal(await phase(f), "released");
  assert.equal(attempts, 2);
});

test("an interrupted allocating intent reconciles using the same provider identity", async () => {
  const f = fixture();
  await f.call("/ensure");
  const record = await f.records.get("allocation-v1");
  await f.records.put("allocation-v1", { ...record, phase: "allocating" });
  f.reload();
  await f.alarm();
  assert.equal(await phase(f), "ready");
  assert.equal(f.counts().created, 1);
  await f.call("/release");
});

test("a lost ready interpreter fails rather than silently replacing Python state", async () => {
  const f = fixture();
  await f.call("/ensure");
  await f.pool.close();
  f.loseProvider();
  f.reload();
  assert.equal((await f.call("/ensure")).status, 409);
  assert.equal(await phase(f), "failed");
  assert.equal(f.counts().created, 1);
});

for (const phaseName of ["allocating", "ready"]) {
  for (const failure of ["transport", "server"]) {
    test(`${failure} failure while ${phaseName} preserves intent and retries`, async () => {
      const f = fixture();
      if (phaseName === "ready") await f.call("/ensure");
      f.failNext(() => {
        if (failure === "transport") throw Error("connection interrupted");
        return Response.json({ error: "Provider temporarily unavailable" }, { status: 503 });
      });
      assert.equal((await f.call("/ensure")).status, phaseName === "ready" ? 200 : 409);
      assert.equal(await phase(f), phaseName);
      assert.ok(!f.paths.includes("/close"));
      assert.equal(f.counts().disposed, 0);
      f.reload();
      await f.alarm();
      assert.equal(await phase(f), "ready");
      assert.equal(f.counts().created, 1);
      await f.call("/release");
    });
  }
}

test("admission rejection is readable and terminal", async () => {
  const f = fixture();
  f.failNext(() =>
    Response.json({ error: "Error: Your Python session limit was reached" }, { status: 409 }),
  );
  const response = await f.call("/ensure");
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "Your Python session limit was reached");
  assert.equal(await phase(f), "failed");
  assert.equal(f.counts().created, 0);
});

test("orphan cleanup failure remains a retryable alarm failure", async () => {
  let attempts = 0;
  const f = fixture({
    clock: () => Date.now() - PROVIDER_ORPHAN_IDLE_MS - 1,
    create: async () => ({
      info: {},
      dispose: async () => {
        if (++attempts === 1) throw Error("close interrupted");
      },
    }),
  });
  await f.call("/ensure");
  await assert.rejects(f.alarm(), /close interrupted/);
  assert.equal(await phase(f), "releasing");
  await f.alarm();
  assert.equal(await phase(f), "released");
  assert.equal(attempts, 2);
});

test("orphan expiry does not stop a busy interpreter", async () => {
  let clock = Date.now(),
    finish;
  const f = fixture({
    clock: () => clock,
    create: async () => ({
      info: {},
      dispose: async () => {},
      execute: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    }),
  });
  await f.call("/ensure");
  const key = JSON.stringify(Object.values(identity));
  clock -= PROVIDER_ORPHAN_IDLE_MS + 1;
  const execution = f.pool.execute(key, { execution_id: "e", cell_id: "c" });
  await Promise.resolve();
  await f.alarm();
  assert.equal(await phase(f), "ready");
  finish({ success: true });
  await execution;
  await f.alarm();
  assert.equal(await phase(f), "released");
});
