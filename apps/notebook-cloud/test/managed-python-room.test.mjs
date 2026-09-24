import { test } from "node:test";
import assert from "node:assert/strict";
import { ManagedPythonRoom } from "../src/managed-python-room.ts";
import { ComputeAllocation } from "../src/compute-allocation.ts";
import { initializeTestRuntimedWasm } from "./runtimed-wasm-test-loader.ts";
import { fixture, sync } from "./preview-python-helpers.mjs";
import { RuntimeStatePeerHandle } from "../src/runtimed-wasm.ts";
import { encodeTypedFrame } from "../src/protocol.ts";

for (const allocationEnabled of [false, true])
  for (const uncertainInspect of allocationEnabled ? [false, true] : [false])
    for (const staleQueue of [false, true])
      test(`managed room publishes execution and repairs stale queue: ${staleQueue}, allocation=${allocationEnabled}, uncertainInspect=${uncertainInspect}`, async (t) => {
        await initializeTestRuntimedWasm();
        const { host, peer, publish } = await fixture(t);
        if (staleQueue) {
          const id = Object.keys(peer.get_runtime_state().executions)[0];
          peer.set_execution_done(id, true);
          await publish();
        }
        host.set_workstation_attachment_json(
          JSON.stringify({
            workstation_id: "celld-preview-python",
            display_name: "Python (sandboxed)",
            provider: "celld-pyodide",
            default_environment_label: "Python",
            environment_policy: "curated",
            status: "connecting",
            runtime_session_id: "session",
          }),
        );
        const requests = [];
        let failInspection = uncertainInspect;
        const env = {
          NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
          PREVIEW_PYTHON_SESSIONS: {
            idFromName: (n) => n,
            get: () => ({
              fetch: async (request) => {
                const body = await request.json();
                requests.push({ path: new URL(request.url).pathname, ...body });
                if (new URL(request.url).pathname === "/inspect") {
                  if (failInspection) {
                    failInspection = false;
                    return Response.json(
                      { error: "temporary inspection failure" },
                      { status: 503 },
                    );
                  }
                  return Response.json({ phase: "ready", lastUsed: Date.now(), busy: false });
                }
                if (new URL(request.url).pathname === "/execute")
                  return Response.json({
                    execution_count: 1,
                    success: true,
                    outputs: [{ output_type: "stream", name: "stdout", text: "managed output\n" }],
                  });
                return Response.json({ ok: true });
              },
            }),
          },
        };
        const materializer = {
          getCloudPackageManifest: async () => null,
          setCloudPackageState: async (sessionId, value) =>
            host.set_cloud_package_state_json(sessionId, JSON.stringify(value)),
          syncPeer: async (peer) => host.sync_peer(peer.id, peer.identity.scope),
          receiveFrame: async (peer, frame) =>
            host.receive_peer_frame(
              peer.id,
              peer.identity.principal,
              peer.identity.actorLabel,
              peer.identity.scope,
              false,
              encodeTypedFrame(frame.type, frame.payload),
            ),
          checkpoint: async () => {},
          removePeer: async (id) => host.remove_peer(id),
        };
        if (allocationEnabled) {
          const records = new Map();
          const allocation = new ComputeAllocation(
            {
              storage: {
                get: async (key) => structuredClone(records.get(key)),
                put: async (key, value) => {
                  records.set(key, structuredClone(value));
                },
                setAlarm: async () => {},
              },
              waitUntil: (pending) => pending.catch(() => {}),
            },
            env,
          );
          if (uncertainInspect) {
            // Simulate reattaching a room to a previously confirmed interpreter.
            const ready = await allocation.fetch(
              new Request("https://allocation/ensure", {
                method: "POST",
                body: JSON.stringify({
                  ownerPrincipal: "user:dev:owner",
                  notebookId: "notebook",
                  sessionId: "session",
                }),
              }),
            );
            assert.equal(ready.status, 200);
            requests.length = 0;
          }
          env.COMPUTE_ALLOCATIONS = {
            idFromName: (name) => name,
            get: (name) => ({
              fetch: async (request) => {
                assert.deepEqual(JSON.parse(name), ["user:dev:owner", "notebook", "session"]);
                const path = new URL(request.url).pathname;
                assert.ok(["/ensure", "/release"].includes(path));
                requests.push({ path, ...(await request.clone().json()) });
                return allocation.fetch(request);
              },
            }),
          };
        }
        const runtime = new ManagedPythonRoom(
          env,
          materializer,
          "notebook",
          "user:dev:owner",
          "session",
          (result) => runtime.accept(result),
        );
        await runtime.start();
        if (uncertainInspect) {
          assert.ok(requests.some((r) => r.path === "/inspect"));
          assert.ok(!requests.some((r) => r.path === "/release" || r.path === "/close"));
        }
        await runtime.wake();
        assert.equal(requests[0].path, allocationEnabled ? "/ensure" : "/open");
        const executed = requests.find((r) => r.path === "/execute");
        if (!staleQueue) {
          assert.equal(executed.ownerPrincipal, "user:dev:owner");
          assert.equal(executed.notebookId, "notebook");
          assert.equal(executed.sessionId, "session");
          assert.equal(executed.execution.source, "print('accepted from notebook')");
        } else assert.equal(executed, undefined);
        const viewer = new RuntimeStatePeerHandle("user:dev:viewer/test");
        t.after(() => viewer.free());
        sync(host, viewer, "viewer", "viewer", true);
        const execution = Object.values(viewer.get_runtime_state().executions)[0];
        assert.equal(execution.status, "done");
        if (!staleQueue)
          assert.deepEqual(execution.outputs[0].text, { inline: "managed output\n" });
        assert.equal(viewer.get_runtime_state().queue.executing, null);
        assert.deepEqual(viewer.get_runtime_state().queue.queued, []);
        await runtime.close();
        assert.equal(requests.at(-1).path, "/close");
        if (allocationEnabled) assert.equal(requests.at(-2).path, "/release");
      });

for (const checkpointOutcome of ["complete", "close", "fail"])
  test(`managed room preserves a wake during its final execution checkpoint: ${checkpointOutcome}`, async (t) => {
    await initializeTestRuntimedWasm();
    const { host, owner, request } = await fixture(t);
    owner.add_cell(1, "next", "code");
    owner.update_source("next", "print('queued during checkpoint')");
    sync(host, owner, "owner", "owner");
    host.set_workstation_attachment_json(
      JSON.stringify({
        workstation_id: "celld-preview-python",
        display_name: "Python (sandboxed)",
        provider: "celld-pyodide",
        default_environment_label: "Python",
        environment_policy: "curated",
        status: "connecting",
        runtime_session_id: "session",
      }),
    );
    const executions = [];
    let releaseCheckpoint;
    const checkpointReleased = new Promise((resolve) => {
      releaseCheckpoint = resolve;
    });
    let enterCheckpoint;
    const checkpointEntered = new Promise((resolve) => {
      enterCheckpoint = resolve;
    });
    let checkpointHeld = false;
    const env = {
      NOTEBOOK_CLOUD_PYTHON_PROVIDER: "celld",
      PREVIEW_PYTHON_SESSIONS: {
        idFromName: (name) => name,
        get: () => ({
          fetch: async (request) => {
            if (new URL(request.url).pathname !== "/execute") return Response.json({ ok: true });
            executions.push((await request.json()).execution);
            return Response.json({
              execution_count: executions.length,
              success: true,
              outputs: [],
            });
          },
        }),
      },
    };
    const materializer = {
      getCloudPackageManifest: async () => null,
      setCloudPackageState: async (sessionId, value) =>
        host.set_cloud_package_state_json(sessionId, JSON.stringify(value)),
      syncPeer: async (peer) => host.sync_peer(peer.id, peer.identity.scope),
      receiveFrame: async (peer, frame) =>
        host.receive_peer_frame(
          peer.id,
          peer.identity.principal,
          peer.identity.actorLabel,
          peer.identity.scope,
          false,
          encodeTypedFrame(frame.type, frame.payload),
        ),
      checkpoint: async () => {
        if (executions.length === 1 && !checkpointHeld) {
          checkpointHeld = true;
          enterCheckpoint();
          await checkpointReleased;
          if (checkpointOutcome === "fail") throw new Error("checkpoint failed");
        }
      },
      removePeer: async (id) => host.remove_peer(id),
    };
    const runtime = new ManagedPythonRoom(
      env,
      materializer,
      "notebook",
      "user:dev:owner",
      "session",
      (result) => runtime.accept(result),
    );
    let closing;
    try {
      await runtime.start();
      const firstWake = runtime.wake();
      await checkpointEntered;
      // The first execution is already published as done, but its checkpoint is
      // still pending. The next accepted request only reaches the peer on sync.
      runtime.accept(request("owner", "next"));
      const nextWake = runtime.wake();
      if (checkpointOutcome === "close") closing = runtime.close();
      releaseCheckpoint();
      if (checkpointOutcome === "fail") {
        await assert.rejects(Promise.all([firstWake, nextWake]), /checkpoint failed/);
      } else {
        await Promise.all([firstWake, nextWake]);
      }

      assert.deepEqual(
        executions.map((execution) => execution.cell_id),
        checkpointOutcome === "complete" ? ["code", "next"] : ["code"],
      );
      if (checkpointOutcome !== "complete") return;
      assert.equal(executions[1].source, "print('queued during checkpoint')");
      const viewer = new RuntimeStatePeerHandle("user:dev:viewer/test");
      t.after(() => viewer.free());
      sync(host, viewer, "viewer", "viewer", true);
      assert.deepEqual(
        Object.values(viewer.get_runtime_state().executions).map((execution) => execution.status),
        ["done", "done"],
      );
    } finally {
      releaseCheckpoint();
      await (closing ?? runtime.close());
    }
  });

test("managed lifecycle updates cannot overwrite a replacement session", async () => {
  await initializeTestRuntimedWasm();
  const { RoomMaterializer } = await import("../src/room-materializer.ts");
  const materializer = new RoomMaterializer(
    "fencing",
    { storage: { get: async () => undefined } },
    {},
  );
  const attachment = {
    workstation_id: "celld-preview-python",
    display_name: "Python (sandboxed)",
    provider: "celld-pyodide",
    default_environment_label: "Python",
    environment_policy: "curated",
    status: "connecting",
    runtime_session_id: "old",
  };
  await materializer.setWorkstationAttachment(attachment);
  await materializer.setWorkstationAttachment({ ...attachment, runtime_session_id: "replacement" });
  assert.equal(
    (await materializer.transitionManagedPythonSession("old", "error", "old startup failed"))
      .ignored_stale,
    true,
  );
  assert.equal(
    (await materializer.transitionManagedPythonSession("old", "ready")).ignored_stale,
    true,
  );
  assert.equal((await materializer.getWorkstationAttachment()).status, "connecting");
  await materializer.transitionManagedPythonSession(
    "replacement",
    "error",
    "package initialization failed",
  );
  const failed = await materializer.getWorkstationAttachment();
  assert.equal(failed.status, "error");
  assert.equal(failed.status_message, "package initialization failed");
  assert.equal(
    (await materializer.transitionManagedPythonSession("replacement", "ready")).ignored_stale,
    true,
  );
});
