import test, { after } from "node:test";
import { NotebookRoom } from "../src/notebook-room.ts";
import { createNotebookWithOwnerAcl } from "../src/storage.ts";
import {
  createWorkstationAttachJob,
  grantNotebookAclRow,
  revokeNotebookAclRow,
  getNotebookAclRowsForPrincipal,
} from "../src/storage.ts";
import { authenticateDevRequest } from "../src/identity.ts";
import { encodeJsonFrame, FrameType } from "../src/protocol.ts";
import { RoomMaterializer } from "../src/room-materializer.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureManagedPythonWorkstation,
  MANAGED_PYTHON_WORKSTATION,
  managedPythonSessionOwner,
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

test("managed startup, failure and resume charge the attach-job owner rather than notebook creator", async () => {
  await initializeTestRuntimedWasm();
  const storage = new Map();
  const tasks = new Set();
  const state = {
    id: { toString: () => "coowner" },
    storage: {
      get: async (key) => storage.get(key),
      put: async (key, value) => storage.set(key, value),
      delete: async (key) => storage.delete(key),
      list: async () => new Map(storage),
    },
    waitUntil(promise) {
      tasks.add(promise);
      promise.finally(() => tasks.delete(promise)).catch(() => {});
    },
  };
  const calls = [];
  const env = {
    DB: database(sqlite),
    NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
    PREVIEW_PYTHON_SESSIONS: {
      idFromName: (name) => name,
      get: () => ({
        fetch: async (request) => {
          const path = new URL(request.url).pathname;
          if (path === "/health") return Response.json({ provider: "celld-pyodide", version: 1 });
          calls.push({ path, ...(await request.json()) });
          return Response.json({ ok: true, info: {} });
        },
      }),
    },
  };
  await createNotebookWithOwnerAcl(env, "coowner", {
    principal: "user:dev:alice",
    actorLabel: "user:dev:alice/browser",
    scope: "owner",
  });
  await ensureManagedPythonWorkstation(env, "user:dev:bob");
  await grantNotebookAclRow(env, {
    notebookId: "coowner",
    subjectKind: "principal",
    subject: "user:dev:bob",
    scope: "owner",
    actorLabel: "user:dev:alice/browser",
  });
  const job = await createWorkstationAttachJob(env, {
    notebookId: "coowner",
    ownerPrincipal: "user:dev:bob",
    workstationId: MANAGED_PYTHON_WORKSTATION,
    actorLabel: "user:dev:bob/browser",
    replaceActive: true,
  });
  assert.ok(job);
  assert.equal(await managedPythonSessionOwner(env, "different-notebook", job.job.id), null);
  const room = new NotebookRoom(state, env);
  const materializer = new RoomMaterializer("coowner", state, env);
  room.materializers.set("coowner", materializer);
  await materializer.setWorkstationAttachment({
    workstation_id: MANAGED_PYTHON_WORKSTATION,
    display_name: "Python (sandboxed)",
    provider: "celld-pyodide",
    default_environment_label: "Python",
    environment_policy: "curated",
    status: "connecting",
    runtime_session_id: job.job.id,
    updated_at: new Date().toISOString(),
  });
  await room.startManagedPython("coowner", job.job.id);
  assert.equal(calls.find((call) => call.path === "/open").ownerPrincipal, "user:dev:bob");
  assert.equal(
    sqlite.prepare("SELECT status FROM workstation_attach_jobs WHERE id = ?").get(job.job.id)
      .status,
    "running",
  );
  const runtime = room.managedPython.get("coowner").runtime;
  await room.failManagedPython("coowner", runtime, new Error("test reset"));
  assert.equal(calls.find((call) => call.path === "/close").ownerPrincipal, "user:dev:bob");
  assert.equal(
    sqlite.prepare("SELECT status FROM workstation_attach_jobs WHERE id = ?").get(job.job.id)
      .status,
    "failed",
  );
  const selected = await materializer.getWorkstationAttachment();
  assert.equal(
    await room.requestRuntimeResumeForExecution(
      "coowner",
      { ...selected, status: "idle" },
      "execute_cell",
    ),
    true,
  );
  while (tasks.size) await Promise.all(tasks);
  const resumed = await materializer.getWorkstationAttachment();
  assert.equal(calls.filter((call) => call.path === "/open").length, 1);
  // Resume now selects a session without allocating compute. The room starts
  // it after accepting execution intent; exercise that startup boundary
  // explicitly here so this test keeps checking the stored billing owner.
  await room.startManagedPython("coowner", resumed.runtime_session_id);
  while (tasks.size) await Promise.all(tasks);
  assert.equal(calls.filter((call) => call.path === "/open").length, 2);
  await room.markSelectedRuntimeSessionCompletedForIdle("coowner");
  assert.equal(
    sqlite
      .prepare("SELECT status FROM workstation_attach_jobs WHERE id = ?")
      .get(resumed.runtime_session_id).status,
    "completed",
  );
  assert.equal(
    await room.requestRuntimeResumeForExecution(
      "coowner",
      { ...resumed, status: "idle" },
      "execute_cell",
    ),
    true,
  );
  while (tasks.size) await Promise.all(tasks);
  const afterIdle = await materializer.getWorkstationAttachment();
  assert.notEqual(afterIdle.runtime_session_id, resumed.runtime_session_id);
  assert.equal(calls.filter((call) => call.path === "/open").length, 2);
  await room.startManagedPython("coowner", afterIdle.runtime_session_id);
  while (tasks.size) await Promise.all(tasks);
  assert.equal(calls.filter((call) => call.path === "/open").length, 3);
  assert.ok(calls.every((call) => call.ownerPrincipal === "user:dev:bob"));
  for (const scope of ["owner", "runtime_peer"]) {
    await revokeNotebookAclRow(env, {
      notebookId: "coowner",
      subjectKind: "principal",
      subject: "user:dev:bob",
      scope,
    });
  }
  assert.equal(
    await room.requestRuntimeResumeForExecution(
      "coowner",
      { ...afterIdle, status: "idle" },
      "execute_cell",
    ),
    false,
  );
  const sent = [];
  const alice = {
    id: "alice",
    identity: authenticateDevRequest(
      new Request("https://cloud.test/n/coowner/sync?user=alice&operator=browser:test&scope=owner"),
    ),
    socket: { send: (frame) => sent.push(new Uint8Array(frame)), close: () => {} },
    connectedAt: new Date().toISOString(),
    consecutiveRejectedFrames: 0,
  };
  room.peers.set(alice.id, alice);
  await grantNotebookAclRow(env, {
    notebookId: "coowner",
    subjectKind: "principal",
    subject: "user:dev:bob",
    scope: "owner",
    actorLabel: "user:dev:alice/browser",
  });
  materializer.waitForNotebookHeads = async () => {
    await revokeNotebookAclRow(env, {
      notebookId: "coowner",
      subjectKind: "principal",
      subject: "user:dev:bob",
      scope: "owner",
    });
    return true;
  };
  await room.handleMessage(
    "coowner",
    alice,
    encodeJsonFrame(FrameType.REQUEST, {
      id: "after-revoke",
      action: "execute_cell",
      cell_id: "code",
      required_heads: [],
    }),
  );
  assert.equal(
    room.managedPython.size,
    0,
    "revoked owner's runtime is closed before accepting work",
  );
  assert.ok(
    sent.some(
      (frame) =>
        frame[0] === FrameType.SESSION_CONTROL &&
        new TextDecoder().decode(frame.slice(1)).includes("access was revoked"),
    ),
  );
  await assert.rejects(
    room.startManagedPython("coowner", afterIdle.runtime_session_id),
    /no longer has owner access/,
  );
  assert.equal(calls.filter((call) => call.path === "/open").length, 3);
  assert.deepEqual(await getNotebookAclRowsForPrincipal(env, "coowner", "user:dev:bob"), []);
  while (tasks.size) await Promise.all(tasks);
});
