import test, { after } from "node:test";
import { NotebookRoom } from "../src/notebook-room.ts";
import { createNotebookWithOwnerAcl } from "../src/storage.ts";
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

const sqlite = new DatabaseSync(":memory:");
after(() => sqlite.close());

function database(sqlite) {
  return {
    async batch(statements) {
      return Promise.all(statements.map((statement) => statement.run()));
    },
    prepare(sql) {
      let values = [];
      return {
        bind(...args) {
          values = args;
          return this;
        },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { success: true, meta: { changes: Number(result.changes) } };
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
});

for (const scope of ["owner", "editor", "viewer"])
  for (const selection of ["none", "notebook", "default"])
    test(`lazy Python selection: scope=${scope}, existing=${selection}`, async () => {
      const principal = `owner-${scope}-${selection}`;
      const calls = [];
      const env = {
        DB: database(sqlite),
        NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
        PREVIEW_PYTHON_SESSIONS: {
          idFromName: (n) => n,
          get: () => ({
            fetch: async (request) => {
              calls.push(new URL(request.url).pathname);
              return Response.json({ provider: "celld-pyodide", version: 1 });
            },
          }),
        },
      };
      await createNotebookWithOwnerAcl(env, principal, {
        principal: principal,
        actorLabel: "alice/browser",
        scope: "owner",
      });
      if (selection === "default") {
        await registerWorkstation(env, principal, {
          workstationId: "explicit",
          displayName: "Chosen compute",
        });
        await setDefaultWorkstation(env, principal, "explicit");
      }
      const room = new NotebookRoom(
        {
          id: { toString: () => principal },
          storage: { get: async () => undefined },
          waitUntil: () => {},
        },
        env,
      );
      let selected = selection === "notebook" ? { workstation_id: "explicit" } : null;
      room.materializers.set(principal, {
        getWorkstationAttachment: async () => selected,
        setWorkstationAttachment: async (value, options) => {
          assert.equal(options.onlyIfAbsent, true);
          selected = value;
          return { changed: true, outbound: [] };
        },
      });
      room.scheduleRoomHostCheckpoint = () => {};
      await room.selectManagedPythonForOwner(principal, {
        identity: { scope, principal: principal },
      });
      if (scope === "owner" && selection === "none") {
        assert.equal(selected.workstation_id, MANAGED_PYTHON_WORKSTATION);
        assert.equal(selected.status, "idle");
        assert.equal(selected.runtime_session_id, null);
      } else
        assert.equal(
          selected?.workstation_id ?? null,
          selection === "notebook" ? "explicit" : null,
        );
      assert.ok(
        calls.every((path) => path === "/health"),
        "selection must not allocate Python",
      );
      if (scope !== "owner") assert.equal(calls.length, 0);
    });
