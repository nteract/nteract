import test from "node:test";
import assert from "node:assert/strict";
import { PackageResolver, PackageAcquisition } from "../src/package-resolver.js";
import {
  installPackageManifest,
  packageManifest,
  removeRequirement,
} from "../src/package-service.js";
import { SessionPool } from "../src/session-pool.js";

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
  assert.ok(disposals > 0);
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
  await assert.rejects(resolver.resolve([]), /Another package plan/);
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
