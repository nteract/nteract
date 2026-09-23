import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureManagedPythonWorkstation,
  MANAGED_PYTHON_WORKSTATION,
} from "../src/managed-python.ts";
import {
  registerWorkstation,
  setDefaultWorkstation,
  getDefaultWorkstationId,
  listWorkstationsForPrincipal,
} from "../src/storage.ts";

function database(sqlite) {
  return {
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async run() {
          sqlite.prepare(sql).run(...values);
          return { success: true, meta: {} };
        },
        async all() {
          return { results: sqlite.prepare(sql).all(...values), success: true, meta: {} };
        },
        async first() {
          return sqlite.prepare(sql).get(...values) ?? null;
        },
      };
    },
  };
}

test("managed discovery is opt-in, owner-scoped, idempotent and preserves defaults", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    let probes = 0;
    const env = {
      DB: database(sqlite),
      PREVIEW_PYTHON_SESSIONS: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async () => {
            probes++;
            return Response.json({ provider: "celld-pyodide", version: 1 });
          },
        }),
      },
    };
    assert.equal(await ensureManagedPythonWorkstation(env, "alice"), null);
    assert.equal(probes, 0);
    env.NOTEBOOK_CLOUD_PYTHON_PROVIDER = "celld";
    await registerWorkstation(env, "alice", {
      workstationId: "existing",
      displayName: "My machine",
    });
    await setDefaultWorkstation(env, "alice", "existing");
    await Promise.all([
      ensureManagedPythonWorkstation(env, "alice"),
      ensureManagedPythonWorkstation(env, "alice"),
    ]);
    assert.equal(await getDefaultWorkstationId(env, "alice"), "existing");
    assert.equal((await listWorkstationsForPrincipal(env, "alice")).length, 2);
    await ensureManagedPythonWorkstation(env, "bob");
    assert.equal(await getDefaultWorkstationId(env, "bob"), MANAGED_PYTHON_WORKSTATION);
    assert.equal((await listWorkstationsForPrincipal(env, "bob")).length, 1);
    assert.equal(
      (await listWorkstationsForPrincipal(env, "bob"))[0].working_directory,
      "/home/pyodide",
    );
  } finally {
    sqlite.close();
  }
});
