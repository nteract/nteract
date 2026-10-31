// The editor-load table through the pure machine, and EditorLoader's
// interpretation of it.
import test from "node:test";
import assert from "node:assert/strict";
import { loadTable, runTable } from "../shared/machine-test.mjs";
import { editorLoadMachine } from "./editor-load-machine.mjs";
import { EDITOR_UNAVAILABLE, EditorLoader } from "./editor-loader.mjs";
import { SessionHost } from "./session-host.mjs";

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

// main.jsx's create(): navigate, wait for the editor while the navigation and
// account still hold, then create. Anything that moves either during the
// download must stop creation before a draft is written.
async function createAfterEditor(host, loader, account) {
  const revision = host.navigate();
  const principal = account.principal;
  const loaded = await loader.readyWhile(
    () => host.isCurrent(revision) && account.principal === principal,
  );
  if (!loaded) return null;
  return loaded.PageSession.create({ title: "Untitled" });
}

for (const [label, interrupt] of [
  ["a navigation", ({ host }) => host.navigate()],
  [
    "an account change",
    ({ account }) => {
      account.principal = "someone-else";
    },
  ],
  [
    "a sign-in that also navigates",
    ({ host, account }) => {
      account.principal = "someone-else";
      host.navigate();
    },
  ],
])
  test(`${label} during the editor download cancels New Page before it writes`, async () => {
    const pending = deferred();
    let creates = 0;
    const module = { PageSession: { create: async () => (creates++, { pageId: "draft" }) } };
    const loader = new EditorLoader({ load: () => pending.promise });
    const host = new SessionHost();
    const account = { principal: "owner" };
    const creating = createAfterEditor(host, loader, account);
    interrupt({ host, account });
    pending.resolve(module);
    assert.equal(await creating, null);
    assert.equal(creates, 0);
    // With nothing in between, the same flow creates once.
    assert.deepEqual(await createAfterEditor(host, loader, account), { pageId: "draft" });
    assert.equal(creates, 1);
  });

test("readyWhile still reports an editor that failed to load", async () => {
  const loader = new EditorLoader({ load: () => Promise.reject(new Error("404")) });
  await assert.rejects(
    loader.readyWhile(() => false),
    { code: "EDITOR_UNAVAILABLE" },
  );
});
