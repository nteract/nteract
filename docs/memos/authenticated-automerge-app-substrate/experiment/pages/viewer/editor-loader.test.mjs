// The editor-load table through the pure machine, and EditorLoader's
// interpretation of it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { editorLoadMachine } from "./editor-load-machine.mjs";
import { EDITOR_UNAVAILABLE, EditorLoader } from "./editor-loader.mjs";

const TABLE = new URL("../test/fixtures/machines/editor-load.json", import.meta.url);

test("the editor-load table runs through the pure machine", async () => {
  assert.deepEqual(await runTable(editorLoadMachine, loadTable(TABLE)), {
    rows: 6,
    pairs: 6,
    unreachable: 0,
    cases: 0,
  });
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => ((resolve = yes), (reject = no)));
  return { promise, resolve, reject };
}

test("the loader starts the import at once and hands the module to every waiter", async () => {
  const module = { PageSession: class {} };
  const pending = deferred();
  let loads = 0,
    checks = 0;
  const loader = new EditorLoader({
    load: () => (loads++, pending.promise),
    checkBuild: () => checks++,
  });
  assert.equal(loads, 1, "the import starts when the loader is created");
  assert.equal(loader.store.snapshot().name, "loading");
  assert.equal(loader.module, null);
  const early = loader.ready();
  pending.resolve(module);
  assert.equal(await early, module);
  assert.equal(await loader.ready(), module, "a later waiter gets the same module");
  assert.equal(loader.module, module);
  assert.deepEqual(loader.store.snapshot(), { name: "ready" });
  assert.equal(checks, 0);
  assert.equal(loads, 1);
});

for (const [label, load] of [
  ["rejects", () => Promise.reject(new TypeError("Failed to fetch dynamically imported module"))],
  [
    "throws",
    () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    },
  ],
])
  test(`an import that ${label} fails once, checks the build, and asks for a reload`, async () => {
    let checks = 0;
    const loader = new EditorLoader({ load, checkBuild: () => checks++ });
    await assert.rejects(loader.ready(), {
      message: EDITOR_UNAVAILABLE,
      code: "EDITOR_UNAVAILABLE",
    });
    await assert.rejects(loader.ready(), { code: "EDITOR_UNAVAILABLE" });
    assert.deepEqual(loader.store.snapshot(), {
      name: "failed",
      message: "Failed to fetch dynamically imported module",
    });
    assert.equal(loader.module, null);
    assert.equal(checks, 1);
  });

test("a failing build check does not escape the loader", async () => {
  const loader = new EditorLoader({
    load: () => Promise.reject(new Error("404")),
    checkBuild: () => Promise.reject(new Error("offline")),
  });
  await assert.rejects(loader.ready(), { code: "EDITOR_UNAVAILABLE" });
  const throwing = new EditorLoader({
    load: () => Promise.reject(new Error("404")),
    checkBuild: () => {
      throw new Error("offline");
    },
  });
  await assert.rejects(throwing.ready(), { code: "EDITOR_UNAVAILABLE" });
});
