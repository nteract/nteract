import test from "node:test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import {
  PackageResolver,
  PackageAcquisition,
  PackageOperationError,
  safePackageFailure,
} from "../src/package-resolver.js";
import {
  PACKAGE_RUNTIME_VERSION,
  installPackageManifest,
  packageManifest,
  removeRequirement,
  removeSavedRequirement,
} from "../src/package-service.js";
import { SessionPool } from "../src/session-pool.js";
import { PackageAdmission } from "../src/package-admission.js";
import {
  PACKAGE_ACQUISITION_MS,
  PACKAGE_INSTALL_MS,
  PACKAGE_MAX_WAITING,
  PACKAGE_QUEUE_WAIT_MS,
} from "../src/package-limits.js";

const wheel = (name, dependencies = []) => ({
  name,
  version: "1.0",
  filename: `${name}-1.0-py3-none-any.whl`,
  url: `https://files.pythonhosted.org/packages/aa/bb/cccc/${name}-1.0-py3-none-any.whl`,
  sha256: "0".repeat(64),
  size: 4,
  dependencies,
});
const empty = packageManifest(null);
const signal = () => new AbortController().signal;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("session inventory retains initial included packages when notebook installation adds dependencies", async () => {
  const pool = new SessionPool({
    warmCount: 0,
    create: async () => ({
      info: { installed: ["numpy==2.2.5"], included: ["numpy==2.2.5"] },
      dispose: async () => {},
    }),
  });
  await pool.open("tenant");
  await pool.packages("tenant", "add", async () => ({
    status: "ready",
    installed: ["numpy==2.2.5", "snowballstemmer==3.0.1"],
  }));
  assert.deepEqual(pool.packageInventory("tenant"), {
    included: ["numpy==2.2.5"],
    installed: ["numpy==2.2.5", "snowballstemmer==3.0.1"],
  });
  await pool.close();
});

test("removal prunes orphaned transitives without promoting installed observations", () => {
  const manifest = {
    ...empty,
    requirements: ["first>=1,<2", "second"],
    wheels: [
      wheel("first", ["shared", "orphan"]),
      wheel("second", ["shared"]),
      wheel("shared"),
      wheel("orphan"),
    ],
  };
  const next = removeRequirement(manifest, "first>=1,<2");
  assert.deepEqual(next.requirements, ["second"]);
  assert.deepEqual(
    next.wheels.map((w) => w.name),
    ["second", "shared"],
  );
});

test("failed version replacement preserves prior manifest and performs no tenant mutation", async () => {
  const previous = { ...empty, requirements: ["six==1.16.0"], wheels: [] };
  let installed = false;
  const result = await installPackageManifest(
    {
      runtime: {
        install() {
          installed = true;
        },
      },
      installed: ["six==1.16.0"],
      signal: signal(),
    },
    { operation: "add", requirement: "six==1.0", manifest: previous },
    { resolve: async () => ({ requirements: ["six==1.0"], wheels: [wheel("six")] }) },
  );
  assert.equal(result.status, "error");
  assert.equal(installed, false);
  assert.deepEqual(previous.requirements, ["six==1.16.0"]);
});

test("partial install failure never supplies a successful manifest", async () => {
  const result = await installPackageManifest(
    { runtime: { install: async () => ({ status: "error" }) }, installed: [], signal: signal() },
    { operation: "add", requirement: "six", manifest: null },
    { resolve: async () => ({ requirements: ["six"], wheels: [wheel("six")] }) },
  );
  assert.equal(result.status, "error");
  assert.equal(result.needs_restart, true);
  assert.equal(result.manifest, undefined);
});

test("adding another requirement cannot replace an unchanged version's pinned artifact", async () => {
  let mutations = 0;
  const previous = { ...empty, requirements: ["six"], wheels: [wheel("six")] };
  const result = await installPackageManifest(
    {
      runtime: {
        install: async () => {
          mutations++;
        },
      },
      installed: ["six==1.0"],
      signal: signal(),
    },
    { operation: "add", requirement: "requests", manifest: previous },
    {
      resolve: async () => ({
        requirements: ["six", "requests"],
        wheels: [{ ...wheel("six"), sha256: "1".repeat(64) }, wheel("requests")],
      }),
    },
  );
  assert.equal(result.status, "error");
  assert.equal(result.needs_restart, false);
  assert.equal(mutations, 0);
  assert.deepEqual(previous.wheels, [wheel("six")]);
});

test("provider admission bounds all package buffers and gives waiting owners a turn", async () => {
  const admission = new PackageAdmission();
  const first = deferred(),
    second = deferred(),
    firstStarted = deferred(),
    secondStarted = deferred();
  const order = [];
  const a = admission.run("alice", signal(), async () => {
    order.push("a");
    firstStarted.resolve();
    await first.promise;
  });
  await firstStarted.promise;
  assert.throws(() => admission.run("alice", signal(), async () => {}), { code: "planner_busy" });
  const b = admission.run(
    "bob",
    signal(),
    async () => {
      order.push("b");
      secondStarted.resolve();
      await second.promise;
    },
    { cooldown: false },
  );
  const cancelled = new AbortController();
  const c = admission.run("carol", cancelled.signal, async () => {
    order.push("unexpected");
  });
  cancelled.abort();
  await assert.rejects(c, /abort/i);
  assert.deepEqual(admission.status, { active: true, waiting: 1 });
  first.resolve();
  await a;
  await secondStarted.promise;
  assert.deepEqual(order, ["a", "b"], "a restore must share the add buffer reservation");
  assert.throws(() => admission.run("alice", signal(), async () => {}), { code: "add_cooldown" });
  second.resolve();
  await b;
  // Restoring the same owner's saved environment is not subject to add cooldown.
  await new Promise((resolve) => setImmediate(resolve));
  await admission.run("alice", signal(), async () => order.push("restore"), { cooldown: false });
  assert.deepEqual(order, ["a", "b", "restore"]);
});

test("planner abort disposes the interpreter and leaves no reusable busy reservation", async () => {
  const started = deferred(),
    ended = deferred();
  let disposals = 0;
  const resolver = new PackageResolver({
    create: async () => ({
      plan: async () => {
        started.resolve();
        await ended.promise;
        return { status: "ready", wheels: [] };
      },
      dispose: async () => {
        disposals++;
        ended.resolve();
      },
    }),
  });
  const abort = new AbortController();
  const pending = resolver.resolve(["six"], { signal: abort.signal });
  await started.promise;
  abort.abort();
  await assert.rejects(pending, /abort/i);
  assert.equal(disposals, 1, "abort and finally share one host cleanup");
  await resolver.resolve([]);
});

test("failed planner cleanup retains its sole reservation", async () => {
  const resolver = new PackageResolver({
    create: async () => ({
      plan: async () => ({ status: "ready", wheels: [] }),
      dispose: async () => {
        throw new Error("host termination unconfirmed");
      },
    }),
  });
  await resolver.resolve([]);
  await assert.rejects(resolver.resolve([]), { code: "planner_unavailable" });
});

test("stale locks retain intent until explicit removal or clearing", () => {
  const stale = {
    ...empty,
    pyodide: "old",
    requirements: ["six", "requests"],
    wheels: [{ malformed: true }],
  };
  const oneRemoved = removeSavedRequirement(stale, "six");
  assert.deepEqual(oneRemoved.requirements, ["requests"]);
  assert.equal(oneRemoved.pyodide, "old");
  assert.throws(() => packageManifest(oneRemoved), /Clear saved packages/);
  assert.deepEqual(removeSavedRequirement(oneRemoved, "requests"), empty);
  assert.deepEqual(stale.requirements, ["six", "requests"]);
});

test("safe package errors distinguish expected failures without exposing arbitrary metadata", () => {
  for (const code of [
    "invalid_requirement",
    "planner_busy",
    "planner_unavailable",
    "incompatible",
    "unavailable",
  ]) {
    assert.equal(safePackageFailure(new PackageOperationError(code)).code, code);
  }
  const failure = safePackageFailure(new Error("untrusted wheel metadata SECRET"));
  assert.equal(failure.code, "acquisition_failed");
  assert.ok(!failure.error.includes("SECRET"));
});

test("an acquisition deadline does not negate a confirmed install", async (t) => {
  const deadline = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => deadline.signal);
  const result = await installPackageManifest(
    {
      runtime: {
        install: async () => {
          deadline.abort();
          return { status: "ready", installed: ["six==1.0"] };
        },
      },
      installed: [],
      signal: signal(),
    },
    { operation: "add", requirement: "six", manifest: null },
    {
      resolve: async () => ({ requirements: ["six"], wheels: [wheel("six")] }),
    },
  );
  assert.equal(result.status, "ready");
  assert.deepEqual(result.manifest.requirements, ["six"]);
});

test("repeated metadata requests stop at the total step budget", async () => {
  let steps = 0;
  const resolver = new PackageResolver({
    create: async () => ({
      plan: async () => {
        steps++;
        return { status: "fetch", url: "https://pypi.org/pypi/six/json" };
      },
      dispose: async () => {},
    }),
    fetchImpl: async () => Response.json({ releases: {} }),
  });
  await assert.rejects(resolver.resolve(["six"]), /resolution limit/);
  assert.equal(steps, 64);
});

test("transitive and restore artifacts cannot bypass source or byte bounds", async () => {
  let fetched = 0;
  const acquisition = new PackageAcquisition({
    fetchImpl: async () => {
      fetched++;
      return new Response("oversized");
    },
  });
  await assert.rejects(
    acquisition.download({ ...wheel("six"), url: "https://localhost/six.whl" }),
    /source/,
  );
  assert.equal(fetched, 0);
  await assert.rejects(acquisition.download(wheel("six")), /size limit/);
  await assert.rejects(
    installPackageManifest(
      { runtime: {}, installed: [], signal: signal() },
      {
        operation: "restore",
        manifest: {
          ...empty,
          requirements: ["six"],
          wheels: [{ ...wheel("six"), url: "https://internal.invalid/six.whl" }],
        },
      },
      null,
    ),
    /source/,
  );
});

test("pool serializes packages with execution, deduplicates attempts and cancels on release", async () => {
  const started = deferred(),
    done = deferred();
  let observedSignal;
  const pool = new SessionPool({
    warmCount: 0,
    create: async () => ({
      info: { installed: [] },
      execute: async () => ({}),
      dispose: async () => {},
    }),
  });
  await pool.open("tenant");
  const installing = pool.packages("tenant", "op", async ({ signal }) => {
    observedSignal = signal;
    started.resolve();
    await done.promise;
    return { status: "ready", installed: [] };
  });
  await started.promise;
  await assert.rejects(pool.execute("tenant", { execution_id: "e" }), /executing/);
  await assert.rejects(
    pool.packages("tenant", "other", async () => ({})),
    /busy/,
  );
  await pool.release("tenant");
  assert.equal(observedSignal.aborted, true);
  done.resolve();
  await assert.rejects(installing, /expired session/);
  await pool.close();
});

test("partial mutation blocks later execution until a fresh session", async () => {
  const pool = new SessionPool({
    warmCount: 0,
    create: async () => ({
      info: { installed: [] },
      execute: async () => ({}),
      dispose: async () => {},
    }),
  });
  await pool.open("tenant");
  await pool.packages("tenant", "op", async () => ({ status: "error", needs_restart: true }));
  await assert.rejects(pool.execute("tenant", { execution_id: "e" }), /restart/);
  assert.throws(() => pool.packageInventory("tenant"), /restart/);
  await pool.close();
});

test("package lock runtime version follows the pinned interpreter", async () => {
  const lock = JSON.parse(
    await readFile(
      new URL("../../../packages/pyodide-runtime/runtime-lock.json", import.meta.url),
      "utf8",
    ),
  );
  assert.equal(PACKAGE_RUNTIME_VERSION, lock.pyodide);
});

test("a long add cannot make a restore lose its FIFO turn to a later owner", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const admission = new PackageAdmission();
  const first = deferred(),
    entered = deferred(),
    restore = deferred(),
    restoring = deferred();
  const order = [];
  let active = 0;
  const operation = (name, started, held) => async () => {
    assert.equal(++active, 1, "only one acquisition/install buffer set is owned");
    order.push(name);
    started?.resolve();
    if (held) await held.promise;
    active--;
  };
  const a = admission.run("alice", signal(), operation("add-a", entered, first));
  await entered.promise;
  const c = admission.run("carol", signal(), operation("restore", restoring, restore), {
    cooldown: false,
  });
  t.mock.timers.tick(88_000);
  const b = admission.run("bob", signal(), operation("add-b"));
  t.mock.timers.tick(2_000);
  first.resolve();
  await a;
  await restoring.promise;
  assert.deepEqual(order, ["add-a", "restore"], "restore kept its original turn through a90s add");
  restore.resolve();
  await Promise.all([b, c]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["add-a", "restore", "add-b"]);
  assert.deepEqual(admission.status, { active: false, waiting: 0 });
});

test("the last FIFO waiter survives acquisition, installation and cleanup ahead of it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const admission = new PackageAdmission();
  const entered = Array.from({ length: PACKAGE_MAX_WAITING + 1 }, deferred);
  const held = Array.from({ length: PACKAGE_MAX_WAITING }, deferred);
  let active = 0;
  const turns = entered.map((started, index) =>
    admission.run(`owner-${index}`, signal(), async () => {
      assert.equal(++active, 1);
      started.resolve();
      if (held[index]) await held[index].promise;
      active--;
    }),
  );
  for (let index = 0; index < held.length; index++) {
    await entered[index].promise;
    // Each legal turn uses both deadlines plus some confirmed cleanup time.
    t.mock.timers.tick(PACKAGE_ACQUISITION_MS + PACKAGE_INSTALL_MS + 15_000);
    held[index].resolve();
  }
  await entered.at(-1).promise;
  await Promise.all(turns);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(admission.status, { active: false, waiting: 0 });
});

test("queued timeout and cancellation release bounded owner reservations", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const admission = new PackageAdmission();
  const held = deferred(),
    entered = deferred();
  const active = admission.run("active", signal(), async () => {
    entered.resolve();
    await held.promise;
  });
  await entered.promise;
  const abort = new AbortController();
  const cancelled = admission.run("cancelled", abort.signal, async () =>
    assert.fail("cancelled operation ran"),
  );
  const cancellation = assert.rejects(cancelled, /abort/i);
  abort.abort();
  await cancellation;
  const expiry = assert.rejects(
    admission.run("waiting", signal(), async () => assert.fail("expired operation ran"), {
      cooldown: false,
    }),
    { code: "planner_busy" },
  );
  t.mock.timers.tick(PACKAGE_QUEUE_WAIT_MS);
  await expiry;
  assert.deepEqual(admission.status, { active: true, waiting: 0 });
  held.resolve();
  await active;
  await admission.run("waiting", signal(), async () => {}, { cooldown: false });
  await admission.run("cancelled", signal(), async () => {});
});

test("cooldown survives another owner's turn and retains bounded bookkeeping", async () => {
  let now = 0;
  const admission = new PackageAdmission({ clock: () => now });
  for (let i = 0; i < 32; i++) await admission.run(`owner-${i}`, signal(), async () => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.throws(() => admission.run("owner-0", signal(), async () => {}), { code: "add_cooldown" });
  assert.throws(() => admission.run("owner-32", signal(), async () => {}), {
    code: "planner_busy",
  });
  now = 5_000;
  await admission.run("owner-0", signal(), async () => {});
});

for (const cleanupFails of [false, true])
  test(`abort waits for one asynchronous planner cleanup, failure=${cleanupFails}`, async () => {
    const planning = deferred(),
      ended = deferred(),
      cleanup = deferred(),
      disposing = deferred();
    let disposals = 0;
    const resolver = new PackageResolver({
      create: async () => ({
        plan: async () => {
          planning.resolve();
          await ended.promise;
          return { status: "ready", wheels: [] };
        },
        dispose: async () => {
          disposals++;
          ended.resolve();
          disposing.resolve();
          await cleanup.promise;
          if (cleanupFails) throw new Error("unconfirmed termination");
        },
      }),
    });
    const abort = new AbortController();
    const pending = resolver.resolve(["six"], { signal: abort.signal });
    const rejected = assert.rejects(pending, /abort/i);
    await planning.promise;
    abort.abort();
    await disposing.promise;
    assert.equal(resolver.status, "busy");
    cleanup.resolve();
    await rejected;
    assert.equal(disposals, 1);
    assert.equal(resolver.status, cleanupFails ? "recovery_required" : "ready");
  });
